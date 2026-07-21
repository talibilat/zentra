import { randomUUID } from "node:crypto";

import type { NewEvent, StoredEvent } from "../contracts/event.js";
import { DaemonLeaseService, type DaemonOwnerLiveness } from "../leases/daemon-lease.js";
import { leaseStreamId, projectLease, type LeaseView, MAX_LEASE_DURATION_MS,
  MIN_HEARTBEAT_INTERVAL_MS } from "../leases/lease-projection.js";
import {
  isAtomicEventJournal,
  readStreamEvents,
  type AtomicAppend,
  type EventJournal,
} from "../journal/journal.js";
import {
  BlockedReasonSchema,
  SchedulerLimitsSchema,
  SchedulerTaskSchema,
  dispatchIntentSha256,
  schedulerStreamId,
  type BlockedReason,
  type DispatchIntent,
  type SchedulerBudget,
  type SchedulerLimits,
  type SchedulerResources,
  type SchedulerTaskInput,
  type SchedulerTerminalOutcome,
  type SchedulerControlIdentity,
  schedulerControlStreamId,
} from "./scheduler-contracts.js";
import { projectScheduler, type ScheduledTaskView, type SchedulerView } from "./scheduler-projection.js";
import { DispatchGrantService, projectDispatchGrant } from "./dispatch-grant-service.js";
import { fits, projectGlobalControl, subtract, zeroBudget, type GlobalControlView } from "./global-control.js";

export { dispatchIntentSha256 } from "./scheduler-contracts.js";
export type { SchedulerTaskInput } from "./scheduler-contracts.js";

export interface JournalSchedulerOptions {
  readonly schedulerId: string;
  readonly processIncarnation: string;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly platform: "darwin-arm64";
  readonly capabilities: readonly string[];
  readonly limits: SchedulerLimits;
  readonly controlIdentity: SchedulerControlIdentity;
  readonly grants: DispatchGrantService;
  readonly daemonOwnerLiveness?: DaemonOwnerLiveness;
  readonly now?: () => number;
}

export interface SchedulerReconciliationCandidate {
  readonly taskId: string;
  readonly dispatchId: string;
  readonly effect: "computation" | "potentially_effectful";
  readonly workspacePath: string;
  readonly workerPid: number | null;
  readonly staleProcessIncarnation: string;
  readonly workerIncarnation: string | null;
  readonly workerProcessStartIdentity: string | null;
}
export interface SchedulerReconciliationObservation {
  readonly taskId: string;
  readonly workerAlive: boolean;
  readonly workspace: "valid" | "missing" | "dirty";
  readonly effect: "none" | "completed" | "uncertain";
  readonly reason: string;
}
export type SchedulerReconciler = (
  candidate: SchedulerReconciliationCandidate,
) => Promise<SchedulerReconciliationObservation>;

export class JournalScheduler {
  private readonly now: () => number;
  private readonly options: JournalSchedulerOptions;
  private readonly daemonLease: DaemonLeaseService;

  constructor(private readonly journal: EventJournal, options: JournalSchedulerOptions) {
    if (!isAtomicEventJournal(journal)) throw new Error("durable scheduler requires an atomic event journal");
    this.options = { ...options, limits: SchedulerLimitsSchema.parse(options.limits),
      capabilities: Object.freeze([...new Set(options.capabilities)].sort()) };
    if (!Number.isSafeInteger(options.pid) || options.pid <= 0) throw new Error("scheduler pid must be positive");
    if (this.options.capabilities.length === 0) throw new Error("scheduler capabilities must not be empty");
    if (JSON.stringify(options.grants.identity) !== JSON.stringify(options.controlIdentity)) {
      throw new Error("dispatch grant authority belongs to another scheduler control identity");
    }
    this.now = options.now ?? Date.now;
    this.daemonLease = new DaemonLeaseService(journal, options.controlIdentity, this.now,
      options.daemonOwnerLiveness ?? (() => "unknown"));
  }

  start(): SchedulerView {
    this.daemonLease.acquire(this.daemonOwner);
    this.ensureControlInitialized();
    const current = this.inspect();
    if (current.activeIncarnations.includes(this.options.processIncarnation)) return current;
    if (current.activeIncarnations.length > 0) throw new Error("active scheduler incarnation requires recovery");
    this.append([this.daemonStartedEvent()]);
    return this.inspect();
  }

  submit(raw: SchedulerTaskInput): ScheduledTaskView {
    const input = SchedulerTaskSchema.parse(raw);
    const view = this.inspect();
    this.assertCurrent(view);
    this.append([this.event("scheduler.task_submitted", { task: input, submittedAtMs: this.now() }, input.taskId)]);
    const submitted = this.inspect();
    const task = submitted.tasks[input.taskId]!;
    const reasons = this.blockedReasons(task, submitted);
    this.append([reasons.length === 0
      ? this.event("scheduler.task_ready", { taskId: input.taskId }, input.taskId)
      : this.event("scheduler.task_blocked", { taskId: input.taskId, reasons }, input.taskId)]);
    return this.inspect().tasks[input.taskId]!;
  }

  inspect(): SchedulerView {
    return projectScheduler(readStreamEvents(this.journal, this.streamId));
  }
  currentTimeMs(): number { return this.now(); }

  tick(): readonly DispatchIntent[] {
    let view = this.inspect();
    this.assertCurrent(view);
    const readiness: NewEvent<string, unknown>[] = [];
    for (const task of Object.values(view.tasks)) {
      if (!["queued", "ready", "blocked"].includes(task.status)) continue;
      const reasons = this.blockedReasons(task, view);
      if (reasons.length === 0 && task.status !== "ready") {
        readiness.push(this.event("scheduler.task_ready", { taskId: task.input.taskId }, task.input.taskId));
      } else if (reasons.length > 0 && (task.status !== "blocked" ||
        JSON.stringify(task.blockedReasons) !== JSON.stringify(reasons))) {
        readiness.push(this.event("scheduler.task_blocked", { taskId: task.input.taskId, reasons }, task.input.taskId));
      }
    }
    if (readiness.length > 0) {
      this.append(readiness);
      view = this.inspect();
    }

    const cancellations = Object.values(view.tasks).filter((task) =>
      task.status === "cancelling" && !task.cancellationSignalled);
    if (cancellations.length > 0) {
      this.append(cancellations.map((task) => this.event("scheduler.cancellation_signalled", {
        taskId: task.input.taskId, dispatchId: task.dispatch!.dispatchId,
        processIncarnation: this.options.processIncarnation, signalledAtMs: this.now(),
      }, task.input.taskId)));
      return [];
    }

    const selected: ScheduledTaskView[] = [];
    let control = this.inspectControl();
    const temporaryResources = { ...control.resources };
    const temporaryBudget = combinedBudget(control);
    const dispatchCounts = { ...view.projectDispatchCounts };
    const resourceDispatchCounts = priorResourceDispatchCounts(view);
    const remaining = Object.values(view.tasks).filter((task) => task.status === "ready");
    while (true) {
      const chosen = remaining.filter((task) =>
        fits(temporaryResources, task.input.resources, this.options.limits.resources) &&
        fits(temporaryBudget, task.input.budget, this.options.limits.budget))
        .sort((left, right) =>
          resourceFairness(resourceDispatchCounts, left) - resourceFairness(resourceDispatchCounts, right) ||
          (dispatchCounts[left.input.projectId] ?? 0) - (dispatchCounts[right.input.projectId] ?? 0) ||
          left.submittedPosition - right.submittedPosition ||
          left.input.taskId.localeCompare(right.input.taskId))[0];
      if (chosen === undefined) break;
      selected.push(chosen);
      add(temporaryResources, chosen.input.resources);
      add(temporaryBudget, chosen.input.budget);
      dispatchCounts[chosen.input.projectId] = (dispatchCounts[chosen.input.projectId] ?? 0) + 1;
      incrementResourceDispatchCounts(resourceDispatchCounts, chosen);
      remaining.splice(remaining.indexOf(chosen), 1);
    }

    const intents: DispatchIntent[] = [];
    for (const task of selected) {
      const dispatchId = randomUUID();
      const taskLeaseId = `task-${dispatchId}`;
      const workerLeaseId = `worker-${dispatchId}`;
      const intent: DispatchIntent = Object.freeze({
        dispatchId, taskId: task.input.taskId, projectId: task.input.projectId,
        workerId: task.input.workerId, processIncarnation: this.options.processIncarnation,
        taskLeaseId, workerLeaseId, grantId: task.input.grantId,
        intentSha256: dispatchIntentSha256(task.input), effect: task.input.effect,
        workspace: task.input.workspace, resources: task.input.resources, budget: task.input.budget,
        intendedAtMs: this.now(), deadlineAtMs: this.now() + task.input.budget.seconds * 1_000,
      });
      const grant = this.options.grants.inspect(task.input.grantId)!;
      const schedulerEvents = [
        this.event("scheduler.grant_consumed", { taskId: task.input.taskId,
          grantId: grant.grantId, intentSha256: grant.dispatchIntentSha256,
          audience: grant.audience, expiresAtMs: grant.expiresAtMs }, task.input.taskId),
        this.event("scheduler.resources_acquired", { taskId: task.input.taskId,
          resources: task.input.resources }, task.input.taskId),
        this.event("scheduler.budget_acquired", { taskId: task.input.taskId,
          budget: task.input.budget }, task.input.taskId),
        this.event("scheduler.dispatch_intended", intent, task.input.taskId),
      ];
      const leaseWrites = [
        this.leaseGrant(taskLeaseId, task, "task"),
        this.leaseGrant(workerLeaseId, task, "worker"),
      ];
      control = this.inspectControl();
      const controlWrite: AtomicAppend = { streamId: this.controlStreamId, expectedVersion: control.streamVersion,
        events: [this.controlEvent("scheduler_control.dispatch_reserved", { schemaVersion: 1,
          dispatchId, taskId: task.input.taskId, schedulerId: this.options.schedulerId,
          resources: task.input.resources, budget: task.input.budget, reservedAtMs: this.now() }, task.input.taskId)] };
      const grantWrite = this.options.grants.consumptionWrite(task.input.grantId, {
        grantId: task.input.grantId, dispatchId, schedulerId: this.options.schedulerId,
        processIncarnation: this.options.processIncarnation,
        dispatchIntentSha256: intent.intentSha256 });
      this.append(schedulerEvents, [...leaseWrites, controlWrite, grantWrite]);
      intents.push(intent);
    }

    view = this.inspect();
    const pressure: NewEvent<string, unknown>[] = [];
    for (const task of Object.values(view.tasks)) {
      if (task.status !== "ready") continue;
      const global = this.inspectControl();
      const resourceFits = fits(global.resources, task.input.resources, this.options.limits.resources);
      const budgetFits = fits(combinedBudget(global), task.input.budget, this.options.limits.budget);
      const kind = resourceFits && !budgetFits ? "budget" : "resources";
      if (task.backpressure !== kind) pressure.push(this.event("scheduler.backpressure", {
        taskId: task.input.taskId, kind, observedAtMs: this.now(),
      }, task.input.taskId));
    }
    if (pressure.length > 0) this.append(pressure);
    return Object.freeze(intents);
  }

  started(dispatchId: string, workerPid: number, workerIncarnation: string,
    workerProcessStartIdentity: string): ScheduledTaskView {
    const { task, view } = this.taskForDispatch(dispatchId);
    this.assertCurrent(view);
    if (task.dispatch!.processIncarnation !== this.options.processIncarnation) {
      throw new Error("stale process incarnation cannot start a dispatch");
    }
    this.append([this.event("scheduler.dispatch_started", { taskId: task.input.taskId, dispatchId,
      processIncarnation: this.options.processIncarnation, workerPid, workerIncarnation,
      workerProcessStartIdentity,
      startedAtMs: this.now() }, task.input.taskId)]);
    return this.inspect().tasks[task.input.taskId]!;
  }

  heartbeat(dispatchId: string, workerIncarnation: string): boolean {
    const { task, view } = this.taskForDispatch(dispatchId);
    this.assertCurrent(view);
    if (task.status !== "running" || task.workerIncarnation !== workerIncarnation ||
      task.dispatch!.processIncarnation !== this.options.processIncarnation) {
      throw new Error("stale process incarnation heartbeat");
    }
    const leases = [this.requireLease(task.dispatch!.taskLeaseId), this.requireLease(task.dispatch!.workerLeaseId)];
    const now = this.now();
    if (leases.some((lease) => now > lease.expiresAtMs)) throw new Error("dispatch lease expired");
    const previous = leases[0]!.lastHeartbeatAtMs;
    if (previous !== null && now - previous < MIN_HEARTBEAT_INTERVAL_MS) return false;
    const leaseWrites = leases.map((lease): AtomicAppend => ({
      streamId: leaseStreamId(lease.leaseId), expectedVersion: lease.streamVersion,
      events: [this.leaseEvent(lease.leaseId, "lease.heartbeat", { schemaVersion: 1,
        leaseId: lease.leaseId, processIncarnation: this.options.processIncarnation,
        workerIncarnation, observedAtMs: now, expiresAtMs: now + MAX_LEASE_DURATION_MS }, task.input.taskId),
      this.leaseEvent(lease.leaseId, "lease.renewed", { schemaVersion: 1,
        leaseId: lease.leaseId, processIncarnation: this.options.processIncarnation,
        workerIncarnation, renewedAtMs: now, expiresAtMs: now + MAX_LEASE_DURATION_MS }, task.input.taskId)],
    }));
    this.append([this.event("scheduler.worker_heartbeat", { taskId: task.input.taskId, dispatchId,
      processIncarnation: this.options.processIncarnation, workerIncarnation, observedAtMs: now }, task.input.taskId)], leaseWrites);
    return true;
  }

  recordUsage(dispatchId: string, delta: SchedulerBudget): ScheduledTaskView {
    const { task, view } = this.taskForDispatch(dispatchId); this.assertCurrent(view);
    const control = this.inspectControl();
    const schedulerEvent = this.event("scheduler.usage_recorded", { taskId: task.input.taskId,
      dispatchId, delta, observedAtMs: this.now() }, task.input.taskId);
    const controlWrite: AtomicAppend = { streamId: this.controlStreamId, expectedVersion: control.streamVersion,
      events: [this.controlEvent("scheduler_control.usage_recorded", { schemaVersion: 1, dispatchId,
        taskId: task.input.taskId, delta, observedAtMs: this.now() }, task.input.taskId)] };
    this.append([schedulerEvent], [controlWrite]);
    return this.inspect().tasks[task.input.taskId]!;
  }

  complete(dispatchId: string, outcome: SchedulerTerminalOutcome, usage: SchedulerBudget = zeroBudget()): ScheduledTaskView {
    const { task, view } = this.taskForDispatch(dispatchId);
    this.assertCurrent(view);
    if (Object.values(usage).some((value) => value !== 0)) this.recordUsage(dispatchId, usage);
    const refreshed = this.inspect().tasks[task.input.taskId]!;
    const unused = subtract(task.input.budget, refreshed.usedBudget);
    const schedulerEvents = [
      this.event("scheduler.worker_outcome", { taskId: task.input.taskId, dispatchId, outcome,
        observedAtMs: this.now() }, task.input.taskId),
      this.event("scheduler.resources_released", { taskId: task.input.taskId,
        resources: task.input.resources, releasedAtMs: this.now() }, task.input.taskId),
      this.event("scheduler.budget_released", { taskId: task.input.taskId,
        reservedBudget: task.input.budget, usedBudget: refreshed.usedBudget, unusedBudget: unused,
        releasedAtMs: this.now() }, task.input.taskId),
    ];
    const control = this.inspectControl();
    const controlWrite: AtomicAppend = { streamId: this.controlStreamId, expectedVersion: control.streamVersion,
      events: [this.controlEvent("scheduler_control.dispatch_released", { schemaVersion: 1,
        dispatchId, taskId: task.input.taskId, resources: task.input.resources,
        reservedBudget: task.input.budget, usedBudget: refreshed.usedBudget, unusedBudget: unused,
        releasedAtMs: this.now() }, task.input.taskId)] };
    this.append(schedulerEvents, [...this.endLeaseWrites(task, "lease.released", "worker outcome recorded"), controlWrite]);
    return this.inspect().tasks[task.input.taskId]!;
  }

  reconcileUncertainDispatch(
    dispatchId: string,
    reason: string,
    workspace: "valid" | "missing" | "dirty",
  ): ScheduledTaskView {
    const { task, view } = this.taskForDispatch(dispatchId);
    this.assertCurrent(view);
    this.reconciliationRequired(task, reason, workspace, "lease.reconciled", false);
    return this.inspect().tasks[task.input.taskId]!;
  }

  resolveReconciliation(
    dispatchId: string,
    outcome: SchedulerTerminalOutcome,
    reason: string,
  ): ScheduledTaskView {
    const { task, view } = this.taskForDispatch(dispatchId);
    this.assertCurrent(view);
    if (task.status !== "reconciling") throw new Error("dispatch is not awaiting reconciliation");
    if (reason.length === 0) throw new Error("reconciliation reason must not be empty");
    this.finishReconciliation(task, outcome, "lease.reconciled", reason);
    return this.inspect().tasks[task.input.taskId]!;
  }

  cancel(taskId: string, reason: string): ScheduledTaskView {
    const view = this.inspect();
    this.assertCurrent(view);
    const task = view.tasks[taskId];
    if (task === undefined) throw new Error(`scheduled task ${taskId} not found`);
    if (task.status === "terminal") return task;
    this.append([this.event("scheduler.cancellation_requested", { taskId, reason,
      requestedAtMs: this.now() }, taskId)]);
    return this.inspect().tasks[taskId]!;
  }

  expire(): readonly string[] {
    const view = this.inspect();
    this.assertCurrent(view);
    const expired: string[] = [];
    for (const task of Object.values(view.tasks)) {
      if (task.dispatch === null || !["dispatched", "running", "cancelling"].includes(task.status)) continue;
      const lease = this.requireLease(task.dispatch.workerLeaseId);
      if (this.now() < lease.expiresAtMs) continue;
      expired.push(task.input.taskId);
      this.reconciliationRequired(task,
        task.input.effect === "potentially_effectful"
          ? "worker lease expired after a potentially effectful dispatch"
          : "worker lease expired before process absence was confirmed",
        task.input.effect === "potentially_effectful" ? "dirty" : "valid", "lease.expired", false);
    }
    return expired;
  }

  async recover(reconcile: SchedulerReconciler): Promise<SchedulerView> {
    this.daemonLease.acquire(this.daemonOwner);
    this.ensureControlInitialized();
    let view = this.inspect();
    if (!view.activeIncarnations.includes(this.options.processIncarnation)) {
      const stale = view.activeIncarnations;
      const takeover: NewEvent<string, unknown>[] = stale.map((incarnation) => this.event("scheduler.daemon_stale", {
        schemaVersion: 1, staleProcessIncarnation: incarnation,
        replacementProcessIncarnation: this.options.processIncarnation, detectedAtMs: this.now(),
      }, this.options.schedulerId));
      takeover.push(this.daemonStartedEvent());
      this.append(takeover);
      view = this.inspect();
    }
    this.assertCurrent(view);
    const staleTasks = Object.values(view.tasks).filter((task) => task.dispatch !== null &&
      task.dispatch.processIncarnation !== this.options.processIncarnation &&
      ["dispatched", "running", "cancelling"].includes(task.status));
    for (const task of staleTasks) {
      const observation = await reconcile({ taskId: task.input.taskId, dispatchId: task.dispatch!.dispatchId,
        effect: task.input.effect, workspacePath: task.input.workspace.path, workerPid: task.workerPid,
        staleProcessIncarnation: task.dispatch!.processIncarnation, workerIncarnation: task.workerIncarnation,
        workerProcessStartIdentity: task.workerProcessStartIdentity });
      if (observation.taskId !== task.input.taskId) throw new Error("reconciliation task identity mismatch");
      if (observation.reason.length === 0) throw new Error("reconciliation reason must not be empty");
      if (observation.workerAlive || observation.effect === "uncertain") {
        this.reconciliationRequired(task, observation.reason, observation.workspace, "lease.reconciled",
          !observation.workerAlive);
      } else {
        this.finishReconciliation(task, observation.effect === "completed" ? "completed" : "failed",
          "lease.reconciled", observation.reason);
      }
    }
    return this.inspect();
  }

  private blockedReasons(task: ScheduledTaskView, view: SchedulerView): BlockedReason[] {
    const input = task.input;
    const reasons: BlockedReason[] = [];
    if (input.admission.dependencies.some((dependency) => dependency.state === "blocked" ||
      (dependency.state === "completed" && view.tasks[dependency.taskId]?.terminalOutcome !== "completed"))) {
      reasons.push("dependencies");
    }
    if (!input.admission.decisionsApproved) reasons.push("decisions");
    if (!input.admission.pathsAvailable) reasons.push("paths");
    if (!input.admission.capabilitySupported ||
      input.requiredCapabilities.some((capability) => !view.capabilities.includes(capability))) reasons.push("capability");
    if (!input.admission.platformSupported || input.platform !== view.platform) reasons.push("platform");
    if (!input.admission.policyPermits) reasons.push("policy");
    if (!input.admission.budgetAvailable || !fits(zeroBudget(), input.budget, this.options.limits.budget)) reasons.push("budget");
    if (!input.admission.workspaceValid || !input.workspace.available) reasons.push("workspace");
    if (input.admission.acceptanceCriteria.length === 0) reasons.push("acceptance");
    if (input.admission.evidenceRequirements.length === 0) reasons.push("evidence");
    const grant = this.options.grants.inspect(input.grantId);
    if (grant === null || grant.audience !== input.workerId || grant.dispatchIntentSha256 !== dispatchIntentSha256(input) ||
      grant.expiresAtMs <= this.now() || grant.consumed) reasons.push("grant");
    return BlockedReasonSchema.array().parse(reasons);
  }

  private reconciliationRequired(task: ScheduledTaskView, reason: string,
    workspace: "valid" | "missing" | "dirty", leaseType: "lease.expired" | "lease.reconciled",
    releaseCapacity = true): void {
    const schedulerEvents = [this.event("scheduler.dispatch_reconciliation_required", {
      taskId: task.input.taskId, dispatchId: task.dispatch!.dispatchId, reason, workspace,
      detectedAtMs: this.now(),
    }, task.input.taskId)];
    const release = releaseCapacity ? this.releaseEvidence(task) : null;
    if (release !== null) schedulerEvents.push(...release.events);
    this.append(schedulerEvents, [...this.endLeaseWrites(task, leaseType, reason), ...(release?.writes ?? [])]);
  }

  private finishReconciliation(task: ScheduledTaskView, outcome: SchedulerTerminalOutcome,
    leaseType: "lease.expired" | "lease.reconciled", reason: string): void {
    const schedulerEvents = [
      this.event("scheduler.worker_outcome", { taskId: task.input.taskId,
        dispatchId: task.dispatch!.dispatchId, outcome, observedAtMs: this.now(), reconciliation: reason }, task.input.taskId),
    ];
    const release = this.releaseEvidence(task);
    schedulerEvents.push(...release.events);
    this.append(schedulerEvents, [...this.endLeaseWrites(task, leaseType, reason), ...release.writes]);
  }

  private releaseEvidence(task: ScheduledTaskView): {
    readonly events: NewEvent<string, unknown>[];
    readonly writes: AtomicAppend[];
  } {
    const unused = subtract(task.input.budget, task.usedBudget);
    const events = [
      this.event("scheduler.resources_released", { taskId: task.input.taskId,
        resources: task.input.resources, releasedAtMs: this.now() }, task.input.taskId),
      this.event("scheduler.budget_released", { taskId: task.input.taskId,
        reservedBudget: task.input.budget, usedBudget: task.usedBudget, unusedBudget: unused,
        releasedAtMs: this.now() }, task.input.taskId),
    ];
    const control = this.inspectControl();
    const writes: AtomicAppend[] = [{ streamId: this.controlStreamId, expectedVersion: control.streamVersion,
      events: [this.controlEvent("scheduler_control.dispatch_released", { schemaVersion: 1,
        dispatchId: task.dispatch!.dispatchId, taskId: task.input.taskId, resources: task.input.resources,
        reservedBudget: task.input.budget, usedBudget: task.usedBudget, unusedBudget: unused,
        releasedAtMs: this.now() }, task.input.taskId)] }];
    return { events, writes };
  }

  private endLeaseWrites(task: ScheduledTaskView, type: "lease.released" | "lease.expired" | "lease.reconciled",
    reason: string): AtomicAppend[] {
    return [task.dispatch!.taskLeaseId, task.dispatch!.workerLeaseId].flatMap((leaseId) => {
      const lease = this.requireLease(leaseId);
      return lease.status !== "active" ? [] : [{ streamId: leaseStreamId(leaseId), expectedVersion: lease.streamVersion,
        events: [this.leaseEvent(leaseId, type, { schemaVersion: 1, leaseId,
          occurredAtMs: this.now(), reason }, task.input.taskId)] }];
    });
  }

  private taskForDispatch(dispatchId: string): { task: ScheduledTaskView; view: SchedulerView } {
    const view = this.inspect();
    const task = Object.values(view.tasks).find((candidate) => candidate.dispatch?.dispatchId === dispatchId);
    if (task === undefined) throw new Error(`dispatch ${dispatchId} not found`);
    return { task, view };
  }

  private requireLease(leaseId: string): LeaseView {
    const lease = projectLease(readStreamEvents(this.journal, leaseStreamId(leaseId)));
    if (lease === null) throw new Error(`lease ${leaseId} not found`);
    return lease;
  }

  private leaseGrant(leaseId: string, task: ScheduledTaskView, scope: "task" | "worker"): AtomicAppend {
    const now = this.now();
    return { streamId: leaseStreamId(leaseId), expectedVersion: 0,
      events: [this.leaseEvent(leaseId, "lease.granted", { schemaVersion: 1, leaseId,
        taskId: task.input.taskId, workerId: task.input.workerId, schedulerId: this.options.schedulerId,
        processIncarnation: this.options.processIncarnation, scope, grantedAtMs: now,
        expiresAtMs: now + MAX_LEASE_DURATION_MS }, task.input.taskId)] };
  }

  private append(events: readonly NewEvent<string, unknown>[], extraWrites: readonly AtomicAppend[] = []): void {
    this.daemonLease.assertActive(this.daemonOwner);
    const existing = readStreamEvents(this.journal, this.streamId);
    const prospective = prospectiveEvents(existing, events, this.now());
    projectScheduler([...existing, ...prospective]);
    for (const write of extraWrites) {
      const leaseEvents = readStreamEvents(this.journal, write.streamId);
      const prospectiveWrite = prospectiveEvents(leaseEvents, write.events, this.now());
      if (write.streamId === this.controlStreamId) projectGlobalControl([...leaseEvents, ...prospectiveWrite]);
      else if (write.streamId.startsWith("dispatch-grant:")) projectDispatchGrant([...leaseEvents, ...prospectiveWrite]);
      else projectLease([...leaseEvents, ...prospectiveWrite]);
    }
    if (!isAtomicEventJournal(this.journal)) throw new Error("durable scheduler requires atomic append");
    this.journal.appendAtomically([{ streamId: this.streamId, expectedVersion: existing.length, events }, ...extraWrites]);
  }

  private assertCurrent(view: SchedulerView): void {
    this.daemonLease.assertActive(this.daemonOwner);
    if (view.processIncarnation !== this.options.processIncarnation ||
      !view.activeIncarnations.includes(this.options.processIncarnation)) {
      throw new Error("stale process incarnation");
    }
  }

  private daemonStartedEvent(): NewEvent<string, unknown> {
    return this.event("scheduler.daemon_started", { schemaVersion: 1,
      schedulerId: this.options.schedulerId, processIncarnation: this.options.processIncarnation,
      pid: this.options.pid, platform: this.options.platform, capabilities: this.options.capabilities,
      limits: this.options.limits, startedAtMs: this.now() }, this.options.schedulerId);
  }
  private event(type: string, payload: unknown, correlationId: string): NewEvent<string, unknown> {
    return { streamId: this.streamId, type, payload, causationId: null, correlationId };
  }
  private leaseEvent(leaseId: string, type: string, payload: unknown,
    correlationId: string): NewEvent<string, unknown> {
    return { streamId: leaseStreamId(leaseId), type, payload, causationId: null, correlationId };
  }
  private get streamId(): string { return schedulerStreamId(this.options.schedulerId); }
  private get controlStreamId(): string { return schedulerControlStreamId(this.options.controlIdentity); }
  private get daemonOwner() { return { schedulerId: this.options.schedulerId,
    processIncarnation: this.options.processIncarnation, pid: this.options.pid,
    processStartIdentity: this.options.processStartIdentity }; }
  private inspectControl(): GlobalControlView { return projectGlobalControl(readStreamEvents(this.journal, this.controlStreamId)); }
  private ensureControlInitialized(): void {
    const current = this.inspectControl();
    if (current.identity !== null) {
      if (JSON.stringify(current.identity) !== JSON.stringify(this.options.controlIdentity) ||
        JSON.stringify(current.limits) !== JSON.stringify(this.options.limits)) throw new Error("global scheduler control identity or limits changed");
      return;
    }
    const event = this.controlEvent("scheduler_control.initialized", { schemaVersion: 1,
      identity: this.options.controlIdentity, limits: this.options.limits }, this.options.schedulerId);
    this.journal.append(this.controlStreamId, 0, [event]);
  }
  renewDaemonLease(): void { this.daemonLease.renew(this.daemonOwner); }
  stop(): void { this.daemonLease.release(this.daemonOwner, "scheduler shutdown completed"); }
  private controlEvent(type: string, payload: unknown, correlationId: string): NewEvent<string, unknown> {
    return { streamId: this.controlStreamId, type, payload, causationId: null, correlationId };
  }
}

function prospectiveEvents(existing: readonly StoredEvent[], events: readonly NewEvent<string, unknown>[], now: number): StoredEvent[] {
  const lastPosition = existing.at(-1)?.globalPosition ?? 0;
  return events.map((event, index) => ({ ...event, eventId: event.eventId ?? randomUUID(),
    streamVersion: existing.length + index + 1, globalPosition: lastPosition + index + 1,
    recordedAt: new Date(now).toISOString() }));
}
function add<T extends Record<string, number>>(target: T, value: T): void {
  const mutable = target as Record<string, number>;
  for (const key of Object.keys(target)) mutable[key] = mutable[key]! + value[key]!;
}
function combinedBudget(control: GlobalControlView): SchedulerBudget {
  return { seconds: control.reservedBudget.seconds + control.spentBudget.seconds,
    inputTokens: control.reservedBudget.inputTokens + control.spentBudget.inputTokens,
    outputTokens: control.reservedBudget.outputTokens + control.spentBudget.outputTokens,
    costUsdNano: control.reservedBudget.costUsdNano + control.spentBudget.costUsdNano };
}

type ResourceDispatchCounts = Record<string, SchedulerResources>;
function priorResourceDispatchCounts(view: SchedulerView): ResourceDispatchCounts {
  const counts: ResourceDispatchCounts = {};
  for (const task of Object.values(view.tasks)) {
    if (task.dispatch !== null) incrementResourceDispatchCounts(counts, task);
  }
  return counts;
}
function incrementResourceDispatchCounts(counts: ResourceDispatchCounts, task: ScheduledTaskView): void {
  const project = counts[task.input.projectId] ??= {
    reasoning: 0, writers: 0, heavyValidation: 0, review: 0, integration: 0,
  };
  for (const key of Object.keys(project) as (keyof SchedulerResources)[]) {
    if (task.input.resources[key] > 0) project[key] += 1;
  }
}
function resourceFairness(counts: ResourceDispatchCounts, task: ScheduledTaskView): number {
  const project = counts[task.input.projectId];
  if (project === undefined) return 0;
  return (Object.keys(project) as (keyof SchedulerResources)[]).reduce((total, key) =>
    total + (task.input.resources[key] > 0 ? project[key] : 0), 0);
}
