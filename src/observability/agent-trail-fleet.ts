import { createHash } from "node:crypto";

import type { StoredEvent } from "../contracts/event.js";
import {
  SchedulerBudgetSchema,
  SchedulerLimitsSchema,
  SchedulerResourceSchema,
  SchedulerTaskSchema,
  type SchedulerBudget,
  type SchedulerResources,
} from "../scheduling/scheduler-contracts.js";

const ACTIVE = new Set(["dispatched", "running", "cancelling", "reconciling"]);
const TERMINAL = new Set(["completed", "cancelled", "denied", "timed_out", "failed"]);

export interface AgentTrailAdvisoryWarningInput {
  readonly code: string;
  readonly summary: string;
  readonly eventId: string;
  readonly actorId: string;
  readonly evidenceEventIds: readonly string[];
}

export interface RankedAgentTrailWarning extends AgentTrailAdvisoryWarningInput {
  readonly rank: number;
  readonly classification: "advisory";
  readonly authority: "none";
  readonly evidence: { readonly eventIds: readonly string[] };
}

interface TaskState {
  taskId: string;
  projectId: string;
  workerId: string;
  state: string;
  backpressure: "resources" | "budget" | null;
  resources: SchedulerResources;
  budget: SchedulerBudget;
  usedBudget: SchedulerBudget;
  integration: boolean;
  position: number;
  daemonIncarnation: string | null;
  workerIncarnation: string | null;
  heartbeatAtMs: number | null;
  acquiredResources: SchedulerResources;
  acquiredBudget: SchedulerBudget;
}

export interface AgentTrailFleetProjection {
  readonly schemaVersion: 1;
  readonly pods: readonly {
    readonly podId: string;
    readonly projectId: string | null;
    readonly state: string;
    readonly tasks: readonly { readonly taskId: string; readonly dependencies: readonly string[] }[];
    readonly ownershipClaimDigests: readonly string[];
  }[];
  readonly workers: {
    readonly registered: number;
    readonly active: number;
    readonly items: readonly {
      readonly workerId: string;
      readonly taskIds: readonly string[];
      readonly projectId: string;
      readonly registered: true;
      readonly active: boolean;
      readonly processIncarnation: string | null;
      readonly daemonIncarnation: string | null;
      readonly daemonState: "active" | "stale" | "unknown";
      readonly health: "healthy" | "stale" | "inactive" | "unknown";
      readonly lastHeartbeatAtMs: number | null;
    }[];
  };
  readonly processIncarnations: readonly { readonly id: string; readonly state: "active" | "stale" }[];
  readonly leases: readonly {
    readonly leaseId: string;
    readonly taskId: string;
    readonly workerId: string;
    readonly state: "active" | "expired" | "released" | "reconciled";
    readonly expiresAtMs: number;
    readonly lastHeartbeatAtMs: number | null;
    readonly authority: false;
  }[];
  readonly queue: {
    readonly queued: number;
    readonly active: number;
    readonly backpressured: number;
    readonly projects: readonly {
      readonly projectId: string;
      readonly queued: number;
      readonly active: number;
      readonly backpressured: number;
      readonly dispatches: number;
    }[];
  };
  readonly resources: { readonly capacity: SchedulerResources; readonly used: SchedulerResources };
  readonly budgets: { readonly capacity: SchedulerBudget; readonly reserved: SchedulerBudget; readonly used: SchedulerBudget };
  readonly integrationUnits: readonly {
    readonly taskId: string;
    readonly projectId: string;
    readonly state: "queued" | "active" | "terminal";
    readonly placeholder: true;
  }[];
  readonly observability: {
    readonly state: "healthy" | "degraded" | "backfilling";
    readonly projectionPosition: number;
    readonly journalHighWaterPosition: number;
    readonly projectionLag: number;
    readonly historyComplete: boolean;
    readonly retentionIndependent: true;
    readonly droppedProjectionEntries: number;
    readonly ingestionGapCount: number;
  };
  readonly attention: readonly RankedAgentTrailWarning[];
}

export function projectAgentTrailFleet(events: readonly StoredEvent[], options: {
  readonly nowMs?: number;
  readonly projectionPosition?: number;
  readonly journalHighWaterPosition?: number;
  readonly warnings?: readonly AgentTrailAdvisoryWarningInput[];
  readonly historyComplete?: boolean;
  readonly droppedProjectionEntries?: number;
  readonly ingestionGapCount?: number;
} = {}): AgentTrailFleetProjection {
  const ordered = [...events].sort((left, right) => left.globalPosition - right.globalPosition);
  assertOrdered(ordered);
  const tasks = new Map<string, TaskState>();
  const incarnations = new Map<string, "active" | "stale">();
  const pods = new Map<string, { podId: string; projectId: string | null; state: string;
    tasks: { taskId: string; dependencies: string[] }[]; claims: Set<string> }>();
  const leases = new Map<string, { leaseId: string; taskId: string; workerId: string;
    state: "active" | "expired" | "released" | "reconciled"; expiresAtMs: number;
    lastHeartbeatAtMs: number | null; authority: false }>();
  let capacity = zeroResources();
  let budgetCapacity = zeroBudget();
  let observability: "healthy" | "degraded" | "backfilling" = "healthy";

  for (const event of ordered) {
    const payload = object(event.payload, event.type);
    switch (event.type) {
      case "scheduler.daemon_started": {
        const limits = SchedulerLimitsSchema.parse(payload["limits"]);
        incarnations.set(id(payload["processIncarnation"]), "active");
        capacity = { ...limits.resources };
        budgetCapacity = { ...limits.budget };
        break;
      }
      case "scheduler.daemon_stale":
        incarnations.set(id(payload["staleProcessIncarnation"]), "stale");
        incarnations.set(id(payload["replacementProcessIncarnation"]), "active");
        break;
      case "scheduler.task_submitted": {
        const input = SchedulerTaskSchema.parse(payload["task"]);
        if (tasks.has(input.taskId)) throw new Error("duplicate AgentTrail scheduler task identity");
        tasks.set(input.taskId, { taskId: input.taskId, projectId: input.projectId, workerId: input.workerId,
          state: "queued", backpressure: null, resources: { ...input.resources }, budget: { ...input.budget },
          usedBudget: zeroBudget(), integration: input.resources.integration > 0, position: event.globalPosition,
          daemonIncarnation: null, workerIncarnation: null, heartbeatAtMs: null,
          acquiredResources: zeroResources(), acquiredBudget: zeroBudget() });
        break;
      }
      case "scheduler.task_ready": schedulerTask(tasks, payload).state = "ready"; break;
      case "scheduler.task_blocked": schedulerTask(tasks, payload).state = "blocked"; break;
      case "scheduler.backpressure": {
        const kind = payload["kind"];
        if (kind !== "resources" && kind !== "budget") throw new Error("invalid AgentTrail backpressure kind");
        schedulerTask(tasks, payload).backpressure = kind;
        break;
      }
      case "scheduler.dispatch_intended": {
        const task = schedulerTask(tasks, payload);
        task.state = "dispatched";
        task.daemonIncarnation = id(payload["processIncarnation"]);
        task.backpressure = null;
        break;
      }
      case "scheduler.dispatch_started": {
        const task = schedulerTask(tasks, payload);
        task.state = "running";
        task.daemonIncarnation = id(payload["processIncarnation"]);
        task.workerIncarnation = id(payload["workerIncarnation"]);
        break;
      }
      case "scheduler.worker_heartbeat": {
        const task = schedulerTask(tasks, payload);
        const daemonIncarnation = id(payload["processIncarnation"]);
        const workerIncarnation = id(payload["workerIncarnation"]);
        if (task.daemonIncarnation !== daemonIncarnation || task.workerIncarnation !== workerIncarnation ||
          incarnations.get(daemonIncarnation) === "stale") {
          throw new Error("AgentTrail heartbeat process or worker incarnation mismatch");
        }
        task.heartbeatAtMs = integer(payload["observedAtMs"]);
        break;
      }
      case "scheduler.resources_acquired": {
        const task = schedulerTask(tasks, payload);
        if (!isZeroResources(task.acquiredResources)) throw new Error("AgentTrail resources were acquired twice");
        task.acquiredResources = { ...SchedulerResourceSchema.parse(payload["resources"]) };
        break;
      }
      case "scheduler.budget_acquired": {
        const task = schedulerTask(tasks, payload);
        if (!isZeroBudget(task.acquiredBudget)) throw new Error("AgentTrail budget was acquired twice");
        task.acquiredBudget = { ...SchedulerBudgetSchema.parse(payload["budget"]) };
        break;
      }
      case "scheduler.resources_released": {
        const task = schedulerTask(tasks, payload);
        const released = SchedulerResourceSchema.parse(payload["resources"]);
        if (JSON.stringify(released) !== JSON.stringify(task.acquiredResources)) throw new Error("AgentTrail resource release mismatch");
        task.acquiredResources = zeroResources();
        task.backpressure = null;
        break;
      }
      case "scheduler.budget_released": {
        const task = schedulerTask(tasks, payload);
        const reserved = SchedulerBudgetSchema.parse(payload["reservedBudget"]);
        if (JSON.stringify(reserved) !== JSON.stringify(task.acquiredBudget)) throw new Error("AgentTrail budget release mismatch");
        task.usedBudget = { ...SchedulerBudgetSchema.parse(payload["usedBudget"]) };
        task.acquiredBudget = zeroBudget();
        task.backpressure = null;
        break;
      }
      case "scheduler.cancellation_requested": {
        const task = schedulerTask(tasks, payload);
        task.state = ACTIVE.has(task.state) ? "cancelling" : "cancelled";
        break;
      }
      case "scheduler.dispatch_reconciliation_required": schedulerTask(tasks, payload).state = "reconciling"; break;
      case "scheduler.worker_outcome": {
        const task = schedulerTask(tasks, payload);
        task.state = outcome(payload["outcome"]);
        task.backpressure = null;
        break;
      }
      case "scheduler.usage_recorded": {
        const task = schedulerTask(tasks, payload);
        task.usedBudget = addBudget(task.usedBudget, SchedulerBudgetSchema.parse(payload["delta"]));
        break;
      }
      case "gateway.degraded": observability = "degraded"; break;
      case "gateway.backfill_target": observability = "backfilling"; break;
      case "gateway.recovered": observability = "healthy"; break;
      case "lease.granted": {
        const leaseId = id(payload["leaseId"]);
        leases.set(leaseId, { leaseId, taskId: id(payload["taskId"]), workerId: id(payload["workerId"]),
          state: "active", expiresAtMs: integer(payload["expiresAtMs"]), lastHeartbeatAtMs: null, authority: false });
        break;
      }
      case "lease.heartbeat":
      case "lease.renewed": {
        const lease = leases.get(id(payload["leaseId"]));
        if (lease === undefined) throw new Error("AgentTrail lease observation has no grant");
        lease.expiresAtMs = integer(payload["expiresAtMs"]);
        lease.lastHeartbeatAtMs = integer(payload[event.type === "lease.heartbeat" ? "observedAtMs" : "renewedAtMs"]);
        break;
      }
      case "lease.expired":
      case "lease.released":
      case "lease.reconciled": {
        const lease = leases.get(id(payload["leaseId"]));
        if (lease === undefined) throw new Error("AgentTrail lease terminal event has no grant");
        lease.state = event.type.slice("lease.".length) as typeof lease.state;
        break;
      }
      case "pod.registered": {
        const charter = object(payload["charter"], "pod charter");
        const charterTasks = Array.isArray(charter["tasks"]) ? charter["tasks"] : [];
        pods.set(event.streamId, { podId: event.streamId, projectId: optionalId(charter["projectId"]),
          state: "registered", claims: new Set(), tasks: charterTasks.map((candidate) => {
            const task = object(candidate, "pod task");
            const dependencies = Array.isArray(task["dependencies"]) ? task["dependencies"] : [];
            return { taskId: id(task["taskId"]), dependencies: dependencies.map((dependency) =>
              id(object(dependency, "pod dependency")["taskId"])) };
          }) });
        break;
      }
      default:
        if (event.type.startsWith("pod.")) {
          const pod = pods.get(event.streamId);
          if (pod === undefined) throw new Error("AgentTrail pod event has no registration");
          pod.state = podState(event.type, pod.state);
          if (event.type === "pod.ownership_intent_observed") {
            const paths = payload["ownedPaths"];
            if (!Array.isArray(paths) || paths.some((value) => typeof value !== "string")) throw new Error("invalid AgentTrail ownership intent");
            for (const path of paths as string[]) pod.claims.add(sha256(path));
          }
        }
    }
  }

  const taskList = [...tasks.values()].sort((left, right) => left.position - right.position);
  const nowMs = options.nowMs ?? Date.now();
  const workers = [...new Set(taskList.map((task) => task.workerId))].sort().map((workerId) => {
    const workerTasks = taskList.filter((task) => task.workerId === workerId);
    const activeTasks = workerTasks.filter((task) => ACTIVE.has(task.state));
    const active = activeTasks.length > 0;
    const current = activeTasks.at(-1) ?? workerTasks.at(-1)!;
    const daemonState = current.daemonIncarnation === null ? "unknown" as const
      : incarnations.get(current.daemonIncarnation) ?? "unknown" as const;
    const heartbeatAtMs = activeTasks.map((task) => task.heartbeatAtMs).filter((value): value is number => value !== null)
      .sort((left, right) => right - left)[0] ?? null;
    const health = daemonState === "stale" ? "stale" as const : !active ? "inactive" as const
      : heartbeatAtMs === null ? "unknown" as const
      : nowMs - heartbeatAtMs > 120_000 ? "stale" as const : "healthy" as const;
    return Object.freeze({ workerId, taskIds: Object.freeze(workerTasks.map((task) => task.taskId)),
      projectId: current.projectId, registered: true as const, active,
      processIncarnation: current.workerIncarnation, daemonIncarnation: current.daemonIncarnation,
      daemonState, health, lastHeartbeatAtMs: heartbeatAtMs });
  });
  const projects = [...new Set(taskList.map((task) => task.projectId))].sort().map((projectId) => {
    const items = taskList.filter((task) => task.projectId === projectId);
    return Object.freeze({ projectId, queued: items.filter((task) => !ACTIVE.has(task.state) && !TERMINAL.has(task.state)).length,
      active: items.filter((task) => ACTIVE.has(task.state)).length,
      backpressured: items.filter((task) => task.backpressure !== null).length,
      dispatches: items.filter((task) => task.daemonIncarnation !== null).length });
  });
  const position = options.projectionPosition ?? ordered.at(-1)?.globalPosition ?? 0;
  const highWater = options.journalHighWaterPosition ?? position;
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(highWater) || position < 0 || highWater < position) {
    throw new Error("invalid AgentTrail projection position");
  }
  const historyComplete = options.historyComplete ?? true;
  const droppedProjectionEntries = options.droppedProjectionEntries ?? 0;
  const ingestionGapCount = options.ingestionGapCount ?? 0;
  if (!Number.isSafeInteger(droppedProjectionEntries) || droppedProjectionEntries < 0 ||
    !Number.isSafeInteger(ingestionGapCount) || ingestionGapCount < 0) {
    throw new Error("invalid AgentTrail projection gap metadata");
  }
  if ((highWater > position || !historyComplete) && observability === "healthy") observability = "degraded";
  const staleWarnings = workers.filter((worker) => worker.health === "stale").map((worker) => ({
    code: "STALE_HEARTBEAT", summary: `Worker ${worker.workerId} heartbeat is stale.`, actorId: worker.workerId,
    eventId: ordered.findLast((event) => event.type === "scheduler.worker_heartbeat" &&
      optionalId(object(event.payload, event.type)["workerIncarnation"]) === worker.processIncarnation)?.eventId ?? "projection",
    evidenceEventIds: ordered.filter((event) => ["scheduler.dispatch_started", "scheduler.worker_heartbeat"].includes(event.type) &&
      schedulerWorker(events, event) === worker.workerId).map((event) => event.eventId),
  }));

  return Object.freeze({ schemaVersion: 1,
    pods: Object.freeze([...pods.values()].sort((a, b) => a.podId.localeCompare(b.podId)).map((pod) => Object.freeze({
      podId: pod.podId, projectId: pod.projectId, state: pod.state,
      tasks: Object.freeze(pod.tasks.map((task) => Object.freeze({ ...task, dependencies: Object.freeze(task.dependencies) }))),
      ownershipClaimDigests: Object.freeze([...pod.claims].sort()),
    }))),
    workers: Object.freeze({ registered: workers.length, active: workers.filter((worker) => worker.active).length,
      items: Object.freeze(workers) }),
    processIncarnations: Object.freeze([...incarnations].map(([id, state]) => Object.freeze({ id, state }))
      .sort((a, b) => a.state.localeCompare(b.state) || a.id.localeCompare(b.id))),
    leases: Object.freeze([...leases.values()].sort((a, b) => a.leaseId.localeCompare(b.leaseId)).map((lease) =>
      Object.freeze({ ...lease, state: lease.state === "active" && lease.expiresAtMs < nowMs ? "expired" as const : lease.state }))),
    queue: Object.freeze({ queued: projects.reduce((sum, project) => sum + project.queued, 0),
      active: projects.reduce((sum, project) => sum + project.active, 0),
      backpressured: projects.reduce((sum, project) => sum + project.backpressured, 0), projects: Object.freeze(projects) }),
    resources: Object.freeze({ capacity: Object.freeze(capacity),
      used: Object.freeze(sumResources(taskList.map((task) => task.acquiredResources))) }),
    budgets: Object.freeze({ capacity: Object.freeze(budgetCapacity),
      reserved: Object.freeze(sumBudgets(taskList.map((task) => task.acquiredBudget))),
      used: Object.freeze(sumBudgets(taskList.map((task) => task.usedBudget))) }),
    integrationUnits: Object.freeze(taskList.filter((task) => task.integration).map((task) => Object.freeze({
      taskId: task.taskId, projectId: task.projectId,
      state: TERMINAL.has(task.state) ? "terminal" as const : ACTIVE.has(task.state) ? "active" as const : "queued" as const,
      placeholder: true as const,
    }))),
    observability: Object.freeze({ state: observability, projectionPosition: position,
      journalHighWaterPosition: highWater, projectionLag: highWater - position,
      historyComplete, retentionIndependent: true as const, droppedProjectionEntries, ingestionGapCount }),
    attention: rankAgentTrailWarnings([...(options.warnings ?? []), ...staleWarnings]),
  });
}

export function coalesceAgentTrailHeartbeats(events: readonly StoredEvent[]): readonly {
  readonly event: StoredEvent; readonly coalescedCount: number;
}[] {
  const result: Array<{ event: StoredEvent; coalescedCount: number }> = [];
  const groups = new Map<string, number>();
  for (const event of events) {
    if (!["worker.heartbeat", "scheduler.worker_heartbeat"].includes(event.type)) {
      result.push({ event, coalescedCount: 1 });
      continue;
    }
    const payload = object(event.payload, event.type);
    const worker = optionalId(payload["workerId"]) ?? optionalId(payload["workerIncarnation"]) ?? optionalId(payload["taskId"]);
    if (worker === null) throw new Error("AgentTrail heartbeat lacks worker identity");
    const observed = typeof payload["observedAtMs"] === "number" ? integer(payload["observedAtMs"])
      : Date.parse(String(payload["observedAt"] ?? event.recordedAt));
    if (!Number.isFinite(observed)) throw new Error("invalid AgentTrail heartbeat time");
    const key = `${worker}:${Math.floor(observed / 60_000)}`;
    const prior = groups.get(key);
    if (prior === undefined) { groups.set(key, result.length); result.push({ event, coalescedCount: 1 }); }
    else result[prior] = { event, coalescedCount: result[prior]!.coalescedCount + 1 };
  }
  return Object.freeze(result.map((item) => Object.freeze(item)));
}

export function rankAgentTrailWarnings(warnings: readonly AgentTrailAdvisoryWarningInput[]): readonly RankedAgentTrailWarning[] {
  const priority: Readonly<Record<string, number>> = { UNCERTAIN_EFFECT: 0, DEGRADED_OBSERVABILITY: 1,
    STALE_HEARTBEAT: 2, OWNERSHIP_CONFLICT: 3, BUDGET_PRESSURE: 4, BACKPRESSURE: 5 };
  return Object.freeze([...warnings].sort((a, b) => (priority[a.code] ?? 100) - (priority[b.code] ?? 100) ||
    a.eventId.localeCompare(b.eventId)).map((warning, index) => Object.freeze({ ...warning,
    evidenceEventIds: Object.freeze([...warning.evidenceEventIds]), rank: index + 1,
    classification: "advisory" as const, authority: "none" as const,
    evidence: Object.freeze({ eventIds: Object.freeze([...warning.evidenceEventIds]) }),
  })));
}

function schedulerTask(tasks: ReadonlyMap<string, TaskState>, payload: Readonly<Record<string, unknown>>): TaskState {
  const taskId = id(payload["taskId"]);
  const task = tasks.get(taskId);
  if (task === undefined) throw new Error(`unknown AgentTrail scheduler task ${taskId}`);
  return task;
}
function schedulerWorker(events: readonly StoredEvent[], event: StoredEvent): string | null {
  const taskId = optionalId(object(event.payload, event.type)["taskId"]);
  const submitted = events.find((candidate) => candidate.type === "scheduler.task_submitted" &&
    optionalId(object(object(candidate.payload, candidate.type)["task"], "scheduler task")["taskId"]) === taskId);
  return submitted === undefined ? null : optionalId(object(object(submitted.payload, submitted.type)["task"], "scheduler task")["workerId"]);
}
function podState(type: string, current: string): string {
  if (type === "pod.admitted") return "admitted";
  if (type === "pod.started") return "running";
  if (["pod.blocked", "pod.attention_raised", "pod.reconciliation_required"].includes(type)) return "blocked";
  if (type === "pod.cancel_requested") return "cancel_requested";
  return /^pod\.(completed|cancelled|denied|timed_out|failed)$/.exec(type)?.[1] ?? current;
}
function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`AgentTrail ${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}
function optionalId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) ? value : null;
}
function id(value: unknown): string { const parsed = optionalId(value); if (parsed === null) throw new Error("invalid AgentTrail identity"); return parsed; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid AgentTrail integer"); return value; }
function outcome(value: unknown): string { if (typeof value !== "string" || !TERMINAL.has(value)) throw new Error("invalid AgentTrail outcome"); return value; }
function zeroResources(): SchedulerResources { return { reasoning: 0, writers: 0, heavyValidation: 0, review: 0, integration: 0 }; }
function zeroBudget(): SchedulerBudget { return { seconds: 0, inputTokens: 0, outputTokens: 0, costUsdNano: 0 }; }
function isZeroResources(value: SchedulerResources): boolean { return Object.values(value).every((item) => item === 0); }
function isZeroBudget(value: SchedulerBudget): boolean { return Object.values(value).every((item) => item === 0); }
function sumResources(values: readonly SchedulerResources[]): SchedulerResources { return values.reduce((sum, value) => ({
  reasoning: sum.reasoning + value.reasoning, writers: sum.writers + value.writers,
  heavyValidation: sum.heavyValidation + value.heavyValidation, review: sum.review + value.review,
  integration: sum.integration + value.integration,
}), zeroResources()); }
function addBudget(a: SchedulerBudget, b: SchedulerBudget): SchedulerBudget { return { seconds: a.seconds + b.seconds,
  inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  costUsdNano: a.costUsdNano + b.costUsdNano }; }
function sumBudgets(values: readonly SchedulerBudget[]): SchedulerBudget { return values.reduce(addBudget, zeroBudget()); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function assertOrdered(events: readonly StoredEvent[]): void {
  const ids = new Set<string>(); let prior = -1;
  for (const event of events) {
    if (!Number.isSafeInteger(event.globalPosition) || event.globalPosition < 0 || event.globalPosition <= prior || ids.has(event.eventId)) {
      throw new Error("invalid AgentTrail fleet event order or identity");
    }
    ids.add(event.eventId); prior = event.globalPosition;
  }
}
