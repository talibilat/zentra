import { z } from "zod";

import type { StoredEvent } from "../contracts/event.js";
import {
  BlockedReasonSchema,
  SchedulerBudgetSchema,
  SchedulerLimitsSchema,
  SchedulerOutcomeSchema,
  SchedulerResourceSchema,
  SchedulerTaskSchema,
  type BlockedReason,
  type DispatchIntent,
  type SchedulerBudget,
  type SchedulerLimits,
  type SchedulerResources,
  type SchedulerTaskInput,
  type SchedulerTerminalOutcome,
} from "./scheduler-contracts.js";

const Id = z.string().min(1).max(256);
const DispatchIntentSchema: z.ZodType<DispatchIntent> = z.strictObject({
  dispatchId: z.string().uuid(), taskId: Id, projectId: Id, workerId: Id,
  processIncarnation: Id, taskLeaseId: Id, workerLeaseId: Id, grantId: Id,
  intentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  effect: z.enum(["computation", "potentially_effectful"]),
  workspace: z.strictObject({ path: z.string().min(1).max(4_096).startsWith("/"), available: z.boolean() }),
  resources: SchedulerResourceSchema, budget: SchedulerBudgetSchema,
  intendedAtMs: z.number().int().nonnegative(),
  deadlineAtMs: z.number().int().positive(),
});
const StartedSchema = z.strictObject({
  schemaVersion: z.literal(1), schedulerId: Id, processIncarnation: Id,
  pid: z.number().int().positive(), platform: z.literal("darwin-arm64"),
  capabilities: z.array(z.string().min(1)).min(1), limits: SchedulerLimitsSchema,
  startedAtMs: z.number().int().nonnegative(),
});

export interface ScheduledTaskView {
  readonly input: SchedulerTaskInput;
  readonly status: "queued" | "blocked" | "ready" | "dispatched" | "running" |
    "cancelling" | "reconciling" | "terminal";
  readonly blockedReasons: readonly BlockedReason[];
  readonly backpressure: "resources" | "budget" | null;
  readonly submittedPosition: number;
  readonly submittedAtMs: number;
  readonly dispatch: DispatchIntent | null;
  readonly workerPid: number | null;
  readonly workerIncarnation: string | null;
  readonly workerProcessStartIdentity: string | null;
  readonly cancellationSignalled: boolean;
  readonly cancellationRequestedAtMs: number | null;
  readonly cancellationReason: string | null;
  readonly reconciliationReason: string | null;
  readonly terminalOutcome: SchedulerTerminalOutcome | null;
  readonly usedBudget: SchedulerBudget;
}

export interface SchedulerView {
  readonly schedulerId: string | null;
  readonly processIncarnation: string | null;
  readonly activeIncarnations: readonly string[];
  readonly capabilities: readonly string[];
  readonly platform: "darwin-arm64" | null;
  readonly limits: SchedulerLimits | null;
  readonly tasks: Readonly<Record<string, ScheduledTaskView>>;
  readonly consumedGrantIds: readonly string[];
  readonly usage: { readonly resources: SchedulerResources; readonly budget: SchedulerBudget };
  readonly projectDispatchCounts: Readonly<Record<string, number>>;
  readonly streamVersion: number;
}

interface MutableTask {
  input: SchedulerTaskInput;
  status: ScheduledTaskView["status"];
  blockedReasons: BlockedReason[];
  backpressure: ScheduledTaskView["backpressure"];
  submittedPosition: number;
  submittedAtMs: number;
  dispatch: DispatchIntent | null;
  workerPid: number | null;
  workerIncarnation: string | null;
  workerProcessStartIdentity: string | null;
  cancellationSignalled: boolean;
  cancellationRequestedAtMs: number | null;
  cancellationReason: string | null;
  reconciliationReason: string | null;
  terminalOutcome: SchedulerTerminalOutcome | null;
  usedBudget: SchedulerBudget;
}

export function projectScheduler(events: readonly StoredEvent[]): SchedulerView {
  let schedulerId: string | null = null;
  let processIncarnation: string | null = null;
  let capabilities: string[] = [];
  let platform: "darwin-arm64" | null = null;
  let limits: SchedulerLimits | null = null;
  const activeIncarnations = new Set<string>();
  const tasks: Record<string, MutableTask> = {};
  const consumed = new Map<string, string>();
  const allocations = new Map<string, { resources: SchedulerResources; budget: SchedulerBudget }>();
  const usage = { resources: zeroResources(), budget: zeroBudget() };
  const projectDispatchCounts: Record<string, number> = {};
  let streamVersion = 0;

  for (const event of events) {
    streamVersion = event.streamVersion;
    if (event.type === "scheduler.daemon_started") {
      const payload = StartedSchema.parse(event.payload);
      if (schedulerId !== null && schedulerId !== payload.schedulerId) throw new Error("scheduler identity changed");
      if (limits !== null && JSON.stringify(limits) !== JSON.stringify(payload.limits)) {
        throw new Error("durable scheduler limits changed");
      }
      schedulerId = payload.schedulerId;
      processIncarnation = payload.processIncarnation;
      capabilities = [...payload.capabilities];
      platform = payload.platform;
      limits = payload.limits;
      activeIncarnations.add(payload.processIncarnation);
      continue;
    }
    if (event.type === "scheduler.daemon_stale") {
      const payload = z.strictObject({ schemaVersion: z.literal(1), staleProcessIncarnation: Id,
        replacementProcessIncarnation: Id, detectedAtMs: z.number().int().nonnegative() }).parse(event.payload);
      if (!activeIncarnations.delete(payload.staleProcessIncarnation)) throw new Error("unknown stale daemon incarnation");
      continue;
    }
    if (schedulerId === null || limits === null) throw new Error("scheduler event requires a daemon start");
    if (event.type === "scheduler.task_submitted") {
      const submitted = z.strictObject({ task: SchedulerTaskSchema,
        submittedAtMs: z.number().int().nonnegative() }).parse(event.payload);
      const input = submitted.task;
      if (tasks[input.taskId] !== undefined) throw new Error("duplicate scheduled task identity");
      tasks[input.taskId] = { input, status: "queued", blockedReasons: [], backpressure: null,
        submittedPosition: event.globalPosition, submittedAtMs: submitted.submittedAtMs,
        dispatch: null, workerPid: null,
        workerIncarnation: null, workerProcessStartIdentity: null, cancellationSignalled: false,
        cancellationRequestedAtMs: null, cancellationReason: null, reconciliationReason: null,
        terminalOutcome: null, usedBudget: zeroBudget() };
      continue;
    }
    const payloadTaskId = taskIdFromPayload(event.payload);
    const task = tasks[payloadTaskId];
    if (task === undefined) throw new Error(`scheduler event references unknown task ${payloadTaskId}`);
    if (event.type === "scheduler.task_ready") {
      z.strictObject({ taskId: Id }).parse(event.payload);
      assertPreDispatch(task);
      task.status = "ready";
      task.blockedReasons = [];
      task.backpressure = null;
    } else if (event.type === "scheduler.task_blocked") {
      assertPreDispatch(task);
      const payload = z.strictObject({ taskId: Id, reasons: z.array(BlockedReasonSchema).min(1) }).parse(event.payload);
      task.status = "blocked";
      task.blockedReasons = [...payload.reasons];
      task.backpressure = null;
    } else if (event.type === "scheduler.backpressure") {
      if (task.status !== "ready") throw new Error("backpressure requires a ready task");
      const payload = z.strictObject({ taskId: Id, kind: z.enum(["resources", "budget"]),
        observedAtMs: z.number().int().nonnegative() }).parse(event.payload);
      task.backpressure = payload.kind;
    } else if (event.type === "scheduler.grant_consumed") {
      const payload = z.strictObject({ taskId: Id, grantId: Id, intentSha256: z.string().regex(/^[a-f0-9]{64}$/),
        audience: Id, expiresAtMs: z.number().int().positive() }).parse(event.payload);
      if (task.status !== "ready" || consumed.has(payload.grantId) ||
        payload.grantId !== task.input.grantId ||
        payload.audience !== task.input.workerId) throw new Error("dispatch grant was not consumed exactly");
      consumed.set(payload.grantId, payload.intentSha256);
    } else if (event.type === "scheduler.resources_acquired") {
      const payload = z.strictObject({ taskId: Id, resources: SchedulerResourceSchema }).parse(event.payload);
      if (allocations.has(task.input.taskId)) throw new Error("task already has a resource allocation");
      if (JSON.stringify(payload.resources) !== JSON.stringify(task.input.resources)) {
        throw new Error("resource acquisition does not match the exact dispatch request");
      }
      allocations.set(task.input.taskId, { resources: payload.resources, budget: zeroBudget() });
      addResources(usage.resources, payload.resources, 1);
      assertWithin(usage.resources, limits.resources, "resource capacity");
    } else if (event.type === "scheduler.budget_acquired") {
      const payload = z.strictObject({ taskId: Id, budget: SchedulerBudgetSchema }).parse(event.payload);
      const allocation = allocations.get(task.input.taskId);
      if (allocation === undefined || !isZeroBudget(allocation.budget)) throw new Error("budget acquisition is out of order");
      if (JSON.stringify(payload.budget) !== JSON.stringify(task.input.budget)) {
        throw new Error("budget acquisition does not match the exact dispatch request");
      }
      allocations.set(task.input.taskId, { ...allocation, budget: payload.budget });
      addBudget(usage.budget, payload.budget, 1);
      assertWithin(usage.budget, limits.budget, "global budget");
    } else if (event.type === "scheduler.dispatch_intended") {
      const intent = DispatchIntentSchema.parse(event.payload);
      if (task.status !== "ready" || !consumed.has(intent.grantId) ||
        intent.taskId !== task.input.taskId || intent.projectId !== task.input.projectId ||
        intent.workerId !== task.input.workerId || intent.processIncarnation !== processIncarnation ||
        intent.grantId !== task.input.grantId || intent.intentSha256 !== consumed.get(intent.grantId) ||
        intent.effect !== task.input.effect || JSON.stringify(intent.workspace) !== JSON.stringify(task.input.workspace) ||
        JSON.stringify(intent.resources) !== JSON.stringify(task.input.resources) ||
        JSON.stringify(intent.budget) !== JSON.stringify(task.input.budget)) {
        throw new Error("dispatch intent does not consume the exact task grant and resources");
      }
      task.status = "dispatched";
      task.dispatch = intent;
      task.backpressure = null;
      projectDispatchCounts[task.input.projectId] = (projectDispatchCounts[task.input.projectId] ?? 0) + 1;
    } else if (event.type === "scheduler.dispatch_started") {
      const payload = z.strictObject({ taskId: Id, dispatchId: z.string().uuid(), processIncarnation: Id,
        workerPid: z.number().int().positive(), workerIncarnation: Id,
        workerProcessStartIdentity: z.string().min(1), startedAtMs: z.number().int().nonnegative() }).parse(event.payload);
      if ((task.status !== "dispatched" && task.status !== "cancelling") || task.dispatch?.dispatchId !== payload.dispatchId ||
        task.dispatch.processIncarnation !== payload.processIncarnation) throw new Error("dispatch start contradicts its intent");
      if (task.status === "dispatched") task.status = "running";
      task.workerPid = payload.workerPid;
      task.workerIncarnation = payload.workerIncarnation;
      task.workerProcessStartIdentity = payload.workerProcessStartIdentity;
    } else if (event.type === "scheduler.worker_heartbeat") {
      const payload = z.strictObject({ taskId: Id, dispatchId: z.string().uuid(), processIncarnation: Id,
        workerIncarnation: Id, observedAtMs: z.number().int().nonnegative() }).parse(event.payload);
      if (task.status !== "running" || task.dispatch?.dispatchId !== payload.dispatchId ||
        task.dispatch.processIncarnation !== payload.processIncarnation ||
        task.workerIncarnation !== payload.workerIncarnation) throw new Error("stale process incarnation heartbeat");
    } else if (event.type === "scheduler.cancellation_requested") {
      const payload = z.strictObject({ taskId: Id, reason: z.string().min(1).max(1_024),
        requestedAtMs: z.number().int().nonnegative() }).parse(event.payload);
      task.cancellationRequestedAtMs = payload.requestedAtMs;
      task.cancellationReason = payload.reason;
      if (task.status === "terminal" || task.status === "reconciling") continue;
      task.status = task.dispatch === null ? "terminal" : "cancelling";
      if (task.dispatch === null) task.terminalOutcome = "cancelled";
    } else if (event.type === "scheduler.cancellation_signalled") {
      const payload = z.strictObject({ taskId: Id, dispatchId: z.string().uuid(), processIncarnation: Id,
        signalledAtMs: z.number().int().nonnegative() }).parse(event.payload);
      if (task.status !== "cancelling") throw new Error("cancellation signal requires an active dispatch");
      if (task.dispatch?.dispatchId !== payload.dispatchId ||
        task.dispatch.processIncarnation !== payload.processIncarnation) {
        throw new Error("cancellation signal contradicts the exact dispatch");
      }
      task.cancellationSignalled = true;
    } else if (event.type === "scheduler.worker_outcome") {
      const payload = z.strictObject({ taskId: Id, dispatchId: z.string().uuid(), outcome: SchedulerOutcomeSchema,
        observedAtMs: z.number().int().nonnegative(), reconciliation: z.string().min(1).optional() }).parse(event.payload);
      if (!task.dispatch || task.dispatch.dispatchId !== payload.dispatchId || task.status === "terminal") {
        throw new Error("worker outcome has no active dispatch");
      }
      task.status = "terminal";
      task.terminalOutcome = payload.outcome;
    } else if (event.type === "scheduler.usage_recorded") {
      const payload = z.strictObject({ taskId: Id, dispatchId: z.string().uuid(), delta: SchedulerBudgetSchema,
        observedAtMs: z.number().int().nonnegative() }).parse(event.payload);
      if (task.dispatch?.dispatchId !== payload.dispatchId || task.status === "terminal") throw new Error("usage has no active dispatch");
      addBudget(task.usedBudget, payload.delta, 1);
      assertWithin(task.usedBudget, task.input.budget, "dispatch budget");
    } else if (event.type === "scheduler.dispatch_reconciliation_required") {
      const payload = z.strictObject({ taskId: Id, dispatchId: z.string().uuid(), reason: z.string().min(1),
        workspace: z.enum(["valid", "missing", "dirty"]), detectedAtMs: z.number().int().nonnegative() }).parse(event.payload);
      if (task.dispatch?.dispatchId !== payload.dispatchId || task.status === "terminal") throw new Error("invalid dispatch reconciliation");
      task.status = "reconciling";
      task.blockedReasons = ["uncertain_effect"];
      task.reconciliationReason = payload.reason;
    } else if (event.type === "scheduler.resources_released") {
      const payload = z.strictObject({ taskId: Id, resources: SchedulerResourceSchema,
        releasedAtMs: z.number().int().nonnegative() }).parse(event.payload);
      const allocation = allocations.get(task.input.taskId);
      if (allocation === undefined) throw new Error("resource release has no allocation");
      if (JSON.stringify(payload.resources) !== JSON.stringify(allocation.resources)) {
        throw new Error("resource release does not match the exact allocation");
      }
      addResources(usage.resources, allocation.resources, -1);
      allocations.set(task.input.taskId, { ...allocation, resources: zeroResources() });
    } else if (event.type === "scheduler.budget_released") {
      const payload = z.strictObject({ taskId: Id, reservedBudget: SchedulerBudgetSchema,
        usedBudget: SchedulerBudgetSchema, unusedBudget: SchedulerBudgetSchema,
        releasedAtMs: z.number().int().nonnegative() }).parse(event.payload);
      const allocation = allocations.get(task.input.taskId);
      if (allocation === undefined) throw new Error("budget release has no allocation");
      if (JSON.stringify(payload.reservedBudget) !== JSON.stringify(allocation.budget) ||
        JSON.stringify(payload.usedBudget) !== JSON.stringify(task.usedBudget) ||
        JSON.stringify(payload.unusedBudget) !== JSON.stringify(subtractBudget(allocation.budget, task.usedBudget))) {
        throw new Error("budget release does not match the exact allocation");
      }
      addBudget(usage.budget, allocation.budget, -1);
      allocations.delete(task.input.taskId);
    } else {
      throw new Error(`unknown scheduler event type ${event.type}`);
    }
  }

  return Object.freeze({ schedulerId, processIncarnation,
    activeIncarnations: Object.freeze([...activeIncarnations]), capabilities: Object.freeze(capabilities), platform,
    limits, tasks: freezeTasks(tasks), consumedGrantIds: Object.freeze([...consumed.keys()]),
    usage: Object.freeze({ resources: Object.freeze({ ...usage.resources }), budget: Object.freeze({ ...usage.budget }) }),
    projectDispatchCounts: Object.freeze({ ...projectDispatchCounts }), streamVersion });
}

function taskIdFromPayload(payload: unknown): string {
  return z.object({ taskId: Id }).parse(payload).taskId;
}
function assertPreDispatch(task: MutableTask): void {
  if (task.dispatch !== null || task.status === "terminal" || task.status === "reconciling" || task.status === "cancelling") {
    throw new Error("task readiness cannot change after dispatch");
  }
}
function zeroResources(): SchedulerResources { return { reasoning: 0, writers: 0, heavyValidation: 0, review: 0, integration: 0 }; }
function zeroBudget(): SchedulerBudget { return { seconds: 0, inputTokens: 0, outputTokens: 0, costUsdNano: 0 }; }
function addResources(target: SchedulerResources, value: SchedulerResources, direction: 1 | -1): void {
  const mutable = target as Record<string, number>;
  for (const key of Object.keys(target) as (keyof SchedulerResources)[]) mutable[key] = mutable[key]! + direction * value[key];
}
function addBudget(target: SchedulerBudget, value: SchedulerBudget, direction: 1 | -1): void {
  const mutable = target as Record<string, number>;
  for (const key of Object.keys(target) as (keyof SchedulerBudget)[]) mutable[key] = mutable[key]! + direction * value[key];
}
function assertWithin<T extends Record<string, number>>(usage: T, limit: T, label: string): void {
  if (Object.keys(usage).some((key) => usage[key]! < 0 || usage[key]! > limit[key]!)) throw new Error(`${label} exceeded`);
}
function isZeroBudget(value: SchedulerBudget): boolean { return Object.values(value).every((item) => item === 0); }
function freezeTasks(tasks: Record<string, MutableTask>): Readonly<Record<string, ScheduledTaskView>> {
  return Object.freeze(Object.fromEntries(Object.entries(tasks).map(([key, task]) => [key, Object.freeze({
    ...task, blockedReasons: Object.freeze([...task.blockedReasons]),
  })])));
}
function subtractBudget(total: SchedulerBudget, used: SchedulerBudget): SchedulerBudget {
  return { seconds: total.seconds - used.seconds, inputTokens: total.inputTokens - used.inputTokens,
    outputTokens: total.outputTokens - used.outputTokens, costUsdNano: total.costUsdNano - used.costUsdNano };
}
