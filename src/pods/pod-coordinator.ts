import { randomUUID } from "node:crypto";

import { z } from "zod";

import { digestCanonical } from "../contracts/authority-attention.js";
import {
  PodAssignmentSchema,
  PodLeaseSchema,
  PodParentGrantSchema,
  normalizeHeadRef,
  type PodAssignment,
  type PodLease,
  type PodParentGrant,
} from "./pod-contracts.js";
import { exceedsBudget, scopeContains } from "./pod-projection.js";
import type { PodRegistry } from "./pod-registry.js";

export interface PodProposal {
  readonly proposalId: string;
  readonly podId: string;
  readonly assignment: PodAssignment;
  readonly grantDigest: string;
  readonly leaseDigest: string;
  readonly assignmentDigest: string;
  readonly charterDigest: string;
  readonly charterRevision: number;
  readonly workspaceLeaseId: string;
}

export interface PodDispatchPacket {
  readonly dispatchId: string;
  readonly podId: string;
  readonly assignment: PodAssignment;
  readonly workspace: { readonly workspaceLeaseId: string; readonly repositoryPath: string; readonly path: string;
    readonly branch: string; readonly baseCommit: string };
  readonly executionMode: "local_process";
  readonly nativeSubagents: false;
  readonly distributed: false;
}

export const PodDispatchResultSchema = z.strictObject({
  outcome: z.enum(["completed", "cancelled", "timed_out", "failed", "uncertain"]),
  evidence: z.array(z.strictObject({
    evidenceId: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    kind: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).max(512),
});

export type PodDispatchResult = z.infer<typeof PodDispatchResultSchema>;

export interface PodExecutionReservation {
  readonly dispatchId: string;
  readonly executionId: string;
  readonly assignmentId: string;
  readonly charterRevision: number;
}

export interface PodExecutionIdentity extends PodExecutionReservation {
  readonly processId: string;
  readonly processIncarnation: string;
}

export interface PodExecutionHandle {
  readonly identity: PodExecutionIdentity;
  readonly started: Promise<{ readonly executionId: string; readonly processId: string; readonly acknowledgedAt: string }>;
  readonly completion: Promise<PodDispatchResult>;
  requestCancellation(reason: "deadline" | "external_abort" | "budget_exceeded"): Promise<{
    readonly executionId: string; readonly processId: string; readonly terminated: true; readonly acknowledgedAt: string;
  }>;
}

export interface PodDispatchAdapter {
  start(packet: PodDispatchPacket & { readonly executionId: string }): Promise<PodExecutionHandle>;
  lookup(identity: PodExecutionReservation): Promise<{ readonly identity: PodExecutionReservation & {
      readonly processId: string | null; readonly processIncarnation: string | null };
    readonly status: "running" | "terminated"; readonly effect: "completed" | "no_effect" | "failed" | "uncertain";
    readonly terminationEvidenceSha256: string | null; readonly effectEvidenceSha256: string;
    readonly evidence: readonly { readonly evidenceId: string; readonly kind: string; readonly sha256: string }[] }>;
}

export interface PodUsageMeterSession {
  snapshot(): Readonly<{ elapsedMs: number; inputTokens: number; outputTokens: number; costUsd: number; retries: number; externalEffects: 0 }>;
  close(): void;
}

export interface PodUsageMeter {
  readonly capability: { readonly elapsed: true; readonly tokens: boolean; readonly cost: boolean;
    readonly retries: boolean; readonly externalEffects: boolean };
  open(identity: PodExecutionIdentity, onUpdate: (usage: ReturnType<PodUsageMeterSession["snapshot"]>) => void): PodUsageMeterSession;
  verify(session: PodUsageMeterSession): boolean;
}

const AUTHORITATIVE_METERS = new WeakSet<object>();
export function authorizePodUsageMeter<T extends PodUsageMeter>(meter: T): T {
  AUTHORITATIVE_METERS.add(meter);
  return meter;
}

export interface PodCoordinatorTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_TIMERS: PodCoordinatorTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PodCoordinator {
  constructor(
    private readonly registry: PodRegistry,
    private readonly adapter: PodDispatchAdapter,
    private readonly clock: () => Date = () => new Date(),
    private readonly timers: PodCoordinatorTimers = SYSTEM_TIMERS,
    private readonly usageMeter?: PodUsageMeter,
    private readonly terminationGraceMs = 5_000,
  ) {}

  propose(input: {
    readonly podId: string;
    readonly grant: PodParentGrant | null;
    readonly lease: PodLease;
    readonly assignment: PodAssignment;
  }): PodProposal {
    const grant = PodParentGrantSchema.parse(input.grant);
    const lease = PodLeaseSchema.parse(input.lease);
    const assignment = PodAssignmentSchema.parse(input.assignment);
    this.assertCurrentAuthority(input.podId, grant, lease, assignment);
    const current = this.registry.inspect(input.podId)!;
    const workspace = current.workspaceLeases[lease.workspaceLeaseId];
    if (workspace === undefined) throw new Error("pod proposal requires a durable task workspace lease");
    const bindings = {
      assignmentDigest: digestCanonical(assignment), charterDigest: digestCanonical(current.charter),
      grantDigest: digestCanonical(grant), leaseDigest: digestCanonical(lease),
    };
    const proposalId = digestCanonical({ podId: input.podId, charterRevision: current.revision,
      workspaceLeaseId: workspace.workspaceLeaseId, ...bindings });
    const proposal = deepFreeze({
      proposalId,
      podId: input.podId,
      assignment,
      ...bindings,
      charterRevision: current.revision,
      workspaceLeaseId: workspace.workspaceLeaseId,
    });
    this.registry.assign(input.podId, assignment, proposal);
    return proposal;
  }

  async dispatch(input: {
    readonly proposal: PodProposal;
    readonly signal: AbortSignal;
  }): Promise<PodDispatchResult> {
    const current = this.registry.inspect(input.proposal.podId);
    if (current?.grant === null || current === null) throw new Error("pod dispatch lacks durable authority");
    const assignmentView = current.assignments[input.proposal.assignment.assignmentId];
    const lease = Object.values(current.leases).find((candidate) => candidate.assignmentId === input.proposal.assignment.assignmentId);
    const workspace = current.workspaceLeases[input.proposal.workspaceLeaseId];
    if (assignmentView === undefined || lease === undefined || workspace === undefined) throw new Error("pod dispatch durable bindings are incomplete");
    const assignment = assignmentFromView(assignmentView);
    const expected = deepFreeze({
      proposalId: digestCanonical({ podId: current.podId, charterRevision: current.revision, workspaceLeaseId: workspace.workspaceLeaseId,
        assignmentDigest: digestCanonical(assignment), charterDigest: digestCanonical(current.charter),
        grantDigest: digestCanonical(current.grant), leaseDigest: digestCanonical(lease) }),
      podId: current.podId, assignment, assignmentDigest: digestCanonical(assignment), charterDigest: digestCanonical(current.charter),
      grantDigest: digestCanonical(current.grant), leaseDigest: digestCanonical(lease), charterRevision: current.revision,
      workspaceLeaseId: workspace.workspaceLeaseId,
    });
    if (digestCanonical(expected) !== digestCanonical(input.proposal)) throw new Error("pod dispatch proposal is stale or mutated");
    this.assertCurrentAuthority(current.podId, current.grant, lease, assignment);
    if (current.grant.sharedIntegrationRefs.includes(normalizeHeadRef(workspace.branch))) throw new Error("pod dispatch targets a protected ref");
    if (input.signal.aborted) throw new Error("pod dispatch is cancelled before invocation");
    const usageMeter = this.requireUsageMeter(assignment);
    const dispatchId = randomUUID();
    this.registry.claimDispatch(input.proposal.podId, {
      assignmentId: input.proposal.assignment.assignmentId,
      proposalId: input.proposal.proposalId,
      dispatchId,
    });
    const executionId = randomUUID();
    try {
      this.assertImmediatelyInvocable(input.proposal.podId, current.grant, lease, assignment);
      this.registry.startReservedInvocation(input.proposal.podId, { assignmentId: assignment.assignmentId, dispatchId,
        authorizedAt: this.clock().toISOString(), executionId, charterRevision: assignment.charterRevision });
      this.assertImmediatelyInvocable(input.proposal.podId, current.grant, lease, assignment);
    } catch (error) {
      this.recordNoEffect(input.proposal.podId, assignment.assignmentId, dispatchId);
      throw error;
    }
    const packet: PodDispatchPacket = Object.freeze({
      dispatchId,
      podId: input.proposal.podId,
      assignment,
      workspace: deepFreeze({ workspaceLeaseId: workspace.workspaceLeaseId, repositoryPath: workspace.repositoryPath,
        path: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit }),
      executionMode: "local_process",
      nativeSubagents: false,
      distributed: false,
    });
    const startedAt = this.clock().getTime();
    const deadlineAt = Math.min(
      startedAt + assignment.budget.maxSeconds * 1_000,
      Date.parse(current.grant.expiresAt),
      Date.parse(lease.expiresAt),
    );
    let externalAbort!: () => void;
    const externalAbortResult = new Promise<{ readonly control: "external_abort" }>((resolve) => {
      externalAbort = () => resolve({ control: "external_abort" });
    });
    input.signal.addEventListener("abort", externalAbort, { once: true });
    if (input.signal.aborted) {
      input.signal.removeEventListener("abort", externalAbort);
      this.recordNoEffect(input.proposal.podId, assignment.assignmentId, dispatchId);
      throw new Error("pod dispatch is cancelled before adapter invocation");
    }
    let timerHandle: unknown;
    const timeoutResult = new Promise<{ readonly control: "deadline" }>((resolve) => {
      timerHandle = this.timers.setTimeout(() => resolve({ control: "deadline" }), Math.max(0, deadlineAt - startedAt));
    });
    let budgetExceeded!: () => void;
    const budgetResult = new Promise<{ readonly control: "budget_exceeded" }>((resolve) => {
      budgetExceeded = () => resolve({ control: "budget_exceeded" });
    });
    let handle: PodExecutionHandle;
    let meter: PodUsageMeterSession;
    try {
      if (input.signal.aborted) throw new Error("pod dispatch is cancelled before adapter start");
      this.assertImmediatelyInvocable(input.proposal.podId, current.grant, lease, assignment);
    } catch (error) {
      if (timerHandle !== undefined) this.timers.clearTimeout(timerHandle);
      input.signal.removeEventListener("abort", externalAbort);
      this.recordNoEffect(input.proposal.podId, assignment.assignmentId, dispatchId);
      throw error;
    }
    try {
      const startPromise = this.adapter.start(deepFreeze({ ...packet, executionId }));
      const startedHandle = await Promise.race([
        startPromise, timeoutResult, externalAbortResult,
      ]);
      if ("control" in startedHandle) {
        this.recordUncertain(input.proposal.podId, assignment.assignmentId, dispatchId,
          "The supervisor did not return an execution handle before cancellation or deadline; resource state is uncertain.");
        void startPromise.then(async (lateHandle) => {
          assertExecutionIdentity(lateHandle.identity, { dispatchId, executionId, assignmentId: assignment.assignmentId,
            charterRevision: assignment.charterRevision });
          this.bindExecutionDurably(input.proposal.podId, assignment.assignmentId, dispatchId, lateHandle.identity);
          await this.cancelStartedHandleUncertain(input.proposal.podId, assignment.assignmentId, dispatchId, lateHandle);
        }).catch(() => {
          // The reservation and reconciliation remain authoritative for restart lookup.
        });
        return { outcome: "uncertain", evidence: [] };
      }
      handle = startedHandle;
      try {
        assertExecutionIdentity(handle.identity, { dispatchId, executionId, assignmentId: assignment.assignmentId,
          charterRevision: assignment.charterRevision });
        this.bindExecutionDurably(input.proposal.podId, assignment.assignmentId, dispatchId, handle.identity);
        if (input.signal.aborted) throw new Error("pod external cancellation raced supervised start");
        this.assertImmediatelyInvocable(input.proposal.podId, current.grant, lease, assignment);
      } catch (error) {
        await this.cancelStartedHandleUncertain(input.proposal.podId, assignment.assignmentId, dispatchId, handle);
        return { outcome: "uncertain", evidence: [] };
      }
      meter = usageMeter.open(handle.identity, (usage) => {
        if (usageExceedsAuthority(usage, assignment.budget, this.registry.inspect(input.proposal.podId)!.budgetUsage,
          current.charter.budget)) budgetExceeded();
      });
      if (!usageMeter.verify(meter)) throw new Error("pod usage meter session is not coordinator-authentic");
      const started = await Promise.race([handle.started, timeoutResult, externalAbortResult, budgetResult]);
      if ("control" in started) return await this.cancelExecution(input.proposal.podId, assignment, handle, meter, started.control, dispatchId);
      if (started.executionId !== executionId || started.processId !== handle.identity.processId) throw new Error("pod start acknowledgement identity mismatch");
      const raced = await Promise.race([handle.completion, timeoutResult, externalAbortResult, budgetResult]);
      if ("control" in raced) return await this.cancelExecution(input.proposal.podId, assignment, handle, meter, raced.control, dispatchId);
      const result = PodDispatchResultSchema.parse(raced);
      const usage = meter.snapshot();
      if (!usageMeter.verify(meter)) throw new Error("pod usage receipt lost coordinator authenticity");
      if (usageExceedsAuthority(usage, assignment.budget, this.registry.inspect(input.proposal.podId)!.budgetUsage,
        current.charter.budget)) return await this.cancelExecution(input.proposal.podId, assignment, handle, meter, "budget_exceeded", dispatchId);
      meter.close();
      return this.recordObservedResult(input.proposal.podId, assignment, dispatchId, result, usage);
    } catch (error) {
      this.recordUncertain(input.proposal.podId, assignment.assignmentId, dispatchId,
      "The dispatch adapter threw after durable invocation; the effect is uncertain.");
      throw error;
    } finally {
      if (timerHandle !== undefined) this.timers.clearTimeout(timerHandle);
      input.signal.removeEventListener("abort", externalAbort);
    }
  }

  async reconcile(podId: string, assignmentId: string, decidedBy: string) {
    const current = this.registry.inspect(podId);
    const assignment = current?.assignments[assignmentId];
    const reconciliation = current?.reconciliation;
    if (current === null || current === undefined || assignment === undefined || reconciliation === null || reconciliation === undefined ||
      assignment.executionId === null ||
      assignment.dispatchId !== reconciliation.dispatchId) throw new Error("pod reconciliation lacks durable execution identity");
    const reservation: PodExecutionReservation = { dispatchId: assignment.dispatchId, executionId: assignment.executionId,
      assignmentId, charterRevision: assignment.charterRevision };
    const observed = await this.adapter.lookup(reservation);
    assertExactReservation(observed.identity, reservation);
    if ((observed.identity.processId === null) !== (observed.identity.processIncarnation === null)) {
      throw new Error("pod reconciliation lookup returned an incomplete process binding");
    }
    if (assignment.processId === null && observed.identity.processId !== null) {
      this.bindExecutionDurably(podId, assignmentId, assignment.dispatchId, { ...reservation,
        processId: observed.identity.processId, processIncarnation: observed.identity.processIncarnation! });
    } else if (assignment.processId !== observed.identity.processId || assignment.processIncarnation !== observed.identity.processIncarnation) {
      throw new Error("pod reconciliation lookup contradicts durable process binding");
    }
    if (observed.status !== "terminated" || observed.effect === "uncertain" || observed.terminationEvidenceSha256 === null ||
      !/^[a-f0-9]{64}$/.test(observed.terminationEvidenceSha256) || !/^[a-f0-9]{64}$/.test(observed.effectEvidenceSha256)) return current;
    for (const evidence of observed.evidence) {
      if (current.evidence[evidence.evidenceId] === undefined) this.registry.recordEvidence(podId, {
        ...evidence, taskId: assignment.taskId, sourceEventId: null,
      });
    }
    if (observed.effect !== "no_effect") {
      if (assignment.observedOutcome === null) {
        if (observed.identity.processId === null) throw new Error("pod completed effect lacks a process binding");
        const identity: PodExecutionIdentity = { ...reservation, processId: observed.identity.processId,
          processIncarnation: observed.identity.processIncarnation! };
        const meterCapability = this.requireUsageMeter(assignmentFromView(assignment));
        const meterSession = meterCapability.open(identity, () => {});
        if (!meterCapability.verify(meterSession)) throw new Error("pod reconciliation usage receipt is not coordinator-authentic");
        const usage = meterSession.snapshot();
        meterSession.close();
        this.registry.observeDispatch(podId, { assignmentId, dispatchId: assignment.dispatchId,
          outcome: observed.effect, evidenceIds: observed.evidence.map((item) => item.evidenceId).sort(), usage,
          terminationAcknowledged: true });
      } else if (assignment.observedOutcome !== "uncertain" && assignment.observedOutcome !== observed.effect) {
        throw new Error("pod reconciliation effect contradicts its durable observation");
      }
    }
    return this.registry.resolveReconciliation(podId, { reconciliationId: reconciliation.reconciliationId,
      assignmentId, dispatchId: assignment.dispatchId, resolution: observed.effect,
      evidenceIds: observed.evidence.map((item) => item.evidenceId).sort(), decidedBy,
      executionId: reservation.executionId, processId: observed.identity.processId,
      processIncarnation: observed.identity.processIncarnation,
      terminationEvidenceSha256: observed.terminationEvidenceSha256, effectEvidenceSha256: observed.effectEvidenceSha256 });
  }

  private assertCurrentAuthority(podId: string, grant: PodParentGrant, lease: PodLease, assignment: PodAssignment): void {
    const current = this.registry.inspect(podId);
    if (current === null || current.grant === null) throw new Error("pod dispatch requires a durable parent grant");
    if (current.lifecycle !== "admitted" && current.lifecycle !== "running") throw new Error("pod dispatch requires an active pod without cancellation or reconciliation");
    const now = this.clock().getTime();
    if (digestCanonical(current.leases[lease.leaseId]) !== digestCanonical(lease)) throw new Error("pod dispatch requires the exact durable parent lease");
    if (Date.parse(grant.expiresAt) <= now || Date.parse(lease.expiresAt) <= now || lease.status !== "active") throw new Error("pod dispatch requires an active grant and lease");
    if (digestCanonical(current.grant) !== digestCanonical(grant) || grant.podId !== podId || lease.podId !== podId ||
      lease.grantId !== grant.grantId || lease.assignmentId !== assignment.assignmentId || lease.taskId !== assignment.taskId ||
      lease.agentId !== assignment.agentId || lease.charterRevision !== assignment.charterRevision ||
      grant.charterRevision !== assignment.charterRevision || assignment.charterRevision !== current.revision) {
      throw new Error("pod assignment is not exactly bound to the current parent grant and lease");
    }
    if (Date.parse(lease.issuedAt) < Date.parse(grant.issuedAt) || Date.parse(lease.expiresAt) > Date.parse(grant.expiresAt) ||
      !grant.agentIds.includes(lease.agentId) || lease.capabilities.some((capability) => !grant.capabilities.includes(capability)) ||
      lease.ownedPaths.some((owned) => !grant.ownedPaths.some((allowed) => scopeContains(allowed, owned))) ||
      exceedsBudget(lease.budget, grant.budget) ||
      !grant.agentIds.includes(assignment.agentId) || assignment.capabilities.some((capability) =>
      !grant.capabilities.includes(capability) || !lease.capabilities.includes(capability)) ||
      assignment.ownedPaths.some((owned) => !grant.ownedPaths.some((allowed) => scopeContains(allowed, owned)) ||
        !lease.ownedPaths.some((allowed) => scopeContains(allowed, owned))) ||
      exceedsBudget(assignment.budget, grant.budget) || exceedsBudget(assignment.budget, lease.budget)) {
      throw new Error("pod assignment expands parent capability, ownership, or budget authority");
    }
  }

  private requireUsageMeter(assignment: PodAssignment): PodUsageMeter {
    const meter = this.usageMeter;
    if (meter === undefined || !AUTHORITATIVE_METERS.has(meter)) throw new Error("pod invocation requires an authoritative usage meter capability");
    const capability = meter.capability;
    if ((assignment.budget.maxInputTokens > 0 || assignment.budget.maxOutputTokens > 0) && !capability.tokens ||
      assignment.budget.maxCostUsd > 0 && !capability.cost || assignment.budget.maxRetries > 0 && !capability.retries ||
      assignment.budget.maxExternalEffects > 0 && !capability.externalEffects) {
      throw new Error("pod usage meter capability does not cover every nonzero budget dimension");
    }
    return meter;
  }

  private bindExecutionDurably(podId: string, assignmentId: string, dispatchId: string, identity: PodExecutionIdentity): void {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = this.registry.inspect(podId)?.assignments[assignmentId];
      if (current?.executionId !== null && current?.executionId !== undefined) {
        if (current.executionId !== identity.executionId) throw new Error("pod execution identity raced another process");
        if (current.processId !== null) {
          if (current.processId !== identity.processId || current.processIncarnation !== identity.processIncarnation) {
            throw new Error("pod execution identity raced another process");
          }
          return;
        }
      }
      try {
        this.registry.bindExecution(podId, { assignmentId, dispatchId, executionId: identity.executionId,
          processId: identity.processId, processIncarnation: identity.processIncarnation });
        return;
      } catch (error) {
        if (!(error instanceof Error) || !/^expected version \d+, actual \d+$/.test(error.message)) throw error;
      }
    }
    throw new Error("pod execution identity did not converge durably");
  }

  private async cancelExecution(
    podId: string,
    assignment: PodAssignment,
    handle: PodExecutionHandle,
    meter: PodUsageMeterSession,
    reason: "deadline" | "external_abort" | "budget_exceeded",
    dispatchId: string,
  ): Promise<PodDispatchResult> {
    const usage = meter.snapshot();
    let terminationTimer: unknown;
    const unacknowledged = Symbol("termination-unacknowledged");
    const bounded = new Promise<typeof unacknowledged>((resolve) => {
      terminationTimer = this.timers.setTimeout(() => resolve(unacknowledged), this.terminationGraceMs);
    });
    let acknowledgement: Awaited<ReturnType<PodExecutionHandle["requestCancellation"]>> | typeof unacknowledged;
    try {
      acknowledgement = await Promise.race([handle.requestCancellation(reason), bounded]);
    } catch {
      acknowledgement = unacknowledged;
    } finally {
      if (terminationTimer !== undefined) this.timers.clearTimeout(terminationTimer);
    }
    if (acknowledgement === unacknowledged || acknowledgement.executionId !== handle.identity.executionId ||
      acknowledgement.processId !== handle.identity.processId || acknowledgement.terminated !== true) {
      this.recordUncertain(podId, assignment.assignmentId, dispatchId,
        "Cancellation was not acknowledged within the bounded termination window; resource authority remains retained.");
      return { outcome: "uncertain", evidence: [] };
    }
    meter.close();
    if (reason === "budget_exceeded") {
      this.recordUncertain(podId, assignment.assignmentId, dispatchId,
        "Coordinator-owned metering exceeded authority before completion; termination was acknowledged but usage requires reconciliation.");
      return { outcome: "uncertain", evidence: [] };
    }
    const outcome = reason === "deadline" ? "timed_out" as const : "cancelled" as const;
    const evidence = [{ evidenceId: `${outcome}-${dispatchId}`, kind: "termination",
      sha256: digestCanonical({ identity: handle.identity, outcome, acknowledgedAt: acknowledgement.acknowledgedAt }) }];
    return this.recordObservedResult(podId, assignment, dispatchId, { outcome, evidence }, usage, true);
  }

  private async cancelStartedHandleUncertain(
    podId: string,
    assignmentId: string,
    dispatchId: string,
    handle: PodExecutionHandle,
  ): Promise<void> {
    let timer: unknown;
    const expired = Symbol("termination-unacknowledged");
    const timeout = new Promise<typeof expired>((resolve) => {
      timer = this.timers.setTimeout(() => resolve(expired), this.terminationGraceMs);
    });
    try {
      await Promise.race([handle.requestCancellation("external_abort"), timeout]);
    } catch {
      // The exact process binding remains available for central lookup below.
    } finally {
      if (timer !== undefined) this.timers.clearTimeout(timer);
    }
    this.recordUncertain(podId, assignmentId, dispatchId,
      "Authority or cancellation changed during supervised start; completion is ignored pending central lookup.");
  }

  private recordObservedResult(
    podId: string,
    assignment: PodAssignment,
    dispatchId: string,
    result: PodDispatchResult,
    usage: ReturnType<PodUsageMeterSession["snapshot"]>,
    terminationAcknowledged = false,
  ): PodDispatchResult {
    try {
      for (const item of result.evidence) {
        this.registry.recordEvidence(podId, { ...item, taskId: assignment.taskId, sourceEventId: null });
      }
      this.registry.observeDispatch(podId, { assignmentId: assignment.assignmentId, dispatchId,
        outcome: result.outcome, evidenceIds: result.evidence.map((item) => item.evidenceId).sort(), usage,
        terminationAcknowledged });
      if (result.outcome === "uncertain" || (result.outcome === "timed_out" && !terminationAcknowledged)) this.recordUncertain(podId, assignment.assignmentId, dispatchId,
        "The supervised execution result remains uncertain and requires central reconciliation.");
      return result;
    } catch (error) {
      this.recordUncertain(podId, assignment.assignmentId, dispatchId,
        "Post-execution evidence or metering validation failed; central reconciliation is required.");
      throw error;
    }
  }

  private assertImmediatelyInvocable(podId: string, grant: PodParentGrant, lease: PodLease, assignment: PodAssignment): void {
    this.assertCurrentAuthority(podId, grant, lease, assignment);
    const current = this.registry.inspect(podId)!;
    if (current.lifecycle !== "running" || current.cancellation !== null || current.reconciliation !== null ||
      current.revision !== assignment.charterRevision) throw new Error("pod invocation authority became stale");
  }

  private recordNoEffect(podId: string, assignmentId: string, dispatchId: string): void {
    const current = this.registry.inspect(podId);
    const assignment = current?.assignments[assignmentId];
    if (assignment?.dispatchId !== dispatchId || (assignment.status !== "dispatched" && assignment.status !== "invoking")) return;
    const blocked = this.registry.reconcileInterruptedDispatch(podId, assignmentId);
    const reconciliation = blocked.reconciliation!;
    const bound = blocked.assignments[assignmentId]!;
    this.registry.resolveReconciliation(podId, { reconciliationId: reconciliation.reconciliationId,
      assignmentId, dispatchId, resolution: "no_effect", evidenceIds: [], decidedBy: "pod-coordinator",
      executionId: bound.executionId, processId: bound.processId, processIncarnation: bound.processIncarnation,
      terminationEvidenceSha256: bound.executionId === null ? null : digestCanonical({ dispatchId, executionId: bound.executionId, noStart: true }),
      effectEvidenceSha256: bound.executionId === null ? null : digestCanonical({ dispatchId, effect: "no_effect" }) });
  }

  private recordUncertain(podId: string, assignmentId: string, dispatchId: string, reason: string): void {
    const current = this.registry.inspect(podId);
    if (current?.reconciliation?.dispatchId === dispatchId) return;
    this.registry.requireReconciliation(podId, { reconciliationId: `reconcile-${dispatchId}`, assignmentId, dispatchId,
      operation: "subordinate dispatch", reason, evidence: { dispatchId }, requestedBy: "pod-coordinator" });
  }
}

function assignmentFromView(value: PodAssignment): PodAssignment {
  return PodAssignmentSchema.parse({ assignmentId: value.assignmentId, taskId: value.taskId, roleId: value.roleId,
    agentId: value.agentId, charterRevision: value.charterRevision, capabilities: value.capabilities,
    ownedPaths: value.ownedPaths, budget: value.budget });
}

function assertExecutionIdentity(
  actual: PodExecutionIdentity,
  expected: PodExecutionReservation,
): void {
  if (actual.dispatchId !== expected.dispatchId || actual.executionId !== expected.executionId ||
    actual.assignmentId !== expected.assignmentId || actual.charterRevision !== expected.charterRevision ||
    actual.processId.length === 0 || actual.processIncarnation.length === 0) {
    throw new Error("pod execution handle identity does not match dispatch authority");
  }
}

function assertExactReservation(actual: PodExecutionReservation, expected: PodExecutionReservation): void {
  const reserved = { dispatchId: actual.dispatchId, executionId: actual.executionId,
    assignmentId: actual.assignmentId, charterRevision: actual.charterRevision };
  if (digestCanonical(reserved) !== digestCanonical(expected)) throw new Error("pod reconciliation lookup returned another execution reservation");
}

function usageExceedsAuthority(
  usage: ReturnType<PodUsageMeterSession["snapshot"]>,
  assignment: PodAssignment["budget"],
  prior: ReturnType<PodUsageMeterSession["snapshot"]>,
  charter: PodAssignment["budget"],
): boolean {
  const exceeds = (candidate: ReturnType<PodUsageMeterSession["snapshot"]>, budget: PodAssignment["budget"]) =>
    candidate.elapsedMs > budget.maxSeconds * 1_000 || candidate.inputTokens > budget.maxInputTokens ||
    candidate.outputTokens > budget.maxOutputTokens || candidate.costUsd > budget.maxCostUsd ||
    candidate.retries > budget.maxRetries || candidate.externalEffects > budget.maxExternalEffects;
  const aggregate = { elapsedMs: prior.elapsedMs + usage.elapsedMs, inputTokens: prior.inputTokens + usage.inputTokens,
    outputTokens: prior.outputTokens + usage.outputTokens, costUsd: prior.costUsd + usage.costUsd,
    retries: prior.retries + usage.retries, externalEffects: 0 as const };
  return exceeds(usage, assignment) || exceeds(aggregate, charter);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
