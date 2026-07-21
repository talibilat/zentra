import { randomUUID } from "node:crypto";
import type { NewEvent, StoredEvent } from "../contracts/event.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import { assertBoundedProjectionEntries, iterateAllEvents, readStreamEvents, type EventJournal } from "../journal/journal.js";
import {
  PodAssignmentSchema,
  PodAttentionSchema,
  PodCharterSchema,
  PodCheckpointSchema,
  PodEvidenceSchema,
  PodLeaseSchema,
  PodWorkspaceLeaseSchema,
  PodReconciliationResolutionSchema,
  PodOwnershipIntentSchema,
  PodParentGrantSchema,
  PodReconciliationSchema,
  PodRevisionSchema,
  PodTerminalProjectionSchema,
  type PodAssignment,
  type PodAttention,
  type PodCharter,
  type PodCheckpoint,
  type PodEvidence,
  type PodLease,
  type PodWorkspaceLease,
  type PodOwnershipIntent,
  type PodParentGrant,
  type PodReconciliation,
  type PodTerminalProjection,
} from "./pod-contracts.js";
import { projectPod, type PodView } from "./pod-projection.js";
import type { TerminalOutcome } from "../contracts/task.js";

export interface RegisterPodInput {
  readonly charter: PodCharter;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface RevisePodInput {
  readonly revisionId: string;
  readonly priorRevision: number;
  readonly charter: PodCharter;
  readonly cause: { readonly eventId: string; readonly streamVersion: number; readonly eventType: string; readonly payloadDigest: string };
}

export interface PodProposalRecord {
  readonly proposalId: string;
  readonly assignment: PodAssignment;
  readonly grantDigest: string;
  readonly leaseDigest: string;
  readonly assignmentDigest: string;
  readonly charterDigest: string;
}

export class PodRegistry {
  constructor(private readonly journal: EventJournal) {}

  register(input: RegisterPodInput): PodView {
    const charter = PodCharterSchema.parse(input.charter);
    if (this.inspect(charter.podId) !== null) throw new Error(`pod ${charter.podId} already exists`);
    const registeredEventId = randomUUID();
    const events: NewEvent<string, unknown>[] = [{
      eventId: registeredEventId, streamId: charter.podId, type: "pod.registered", payload: { charter },
      causationId: input.causationId ?? null, correlationId: input.correlationId,
    }, {
      eventId: randomUUID(),
      streamId: charter.podId,
      type: "pod.task_relationships_recorded",
      payload: {
        charterRevision: charter.revision,
        relationships: charter.tasks.map((task) => ({ taskId: task.taskId, dependencies: task.dependencies })),
      },
      causationId: registeredEventId,
      correlationId: input.correlationId,
    }];
    projectPod(events.map((event, index) => candidateEvent(event, index + 1)));
    return projectPod(this.journal.append(charter.podId, 0, events))!;
  }

  inspect(podId: string): PodView | null {
    return projectPod(readStreamEvents(this.journal, podId));
  }

  list(): readonly PodView[] {
    const ids = new Set<string>();
    for (const event of iterateAllEvents(this.journal)) {
      if (event.type === "pod.registered") {
        ids.add(event.streamId);
        assertBoundedProjectionEntries(ids.size, "pod list");
      }
    }
    return Object.freeze([...ids].sort().map((id) => this.inspect(id)!));
  }

  admit(podId: string, grant: PodParentGrant, admittedAt: string): PodView {
    PodParentGrantSchema.parse(grant);
    return this.append(podId, "pod.admitted", { grant, admittedAt });
  }

  receiveLease(podId: string, lease: PodLease): PodView {
    return this.append(podId, "pod.lease_received", { lease: PodLeaseSchema.parse(lease) });
  }

  receiveWorkspaceLease(podId: string, workspace: PodWorkspaceLease): PodView {
    return this.append(podId, "pod.workspace_lease_received", { workspace: PodWorkspaceLeaseSchema.parse(workspace) });
  }

  start(podId: string): PodView {
    return this.append(podId, "pod.started", { podId });
  }

  block(podId: string, reason: string): PodView {
    return this.append(podId, "pod.blocked", { reason });
  }

  raiseAttention(podId: string, attention: PodAttention): PodView {
    return this.append(podId, "pod.attention_raised", PodAttentionSchema.parse(attention));
  }

  resolveAttention(podId: string, attentionId: string, decidedBy: string): PodView {
    return this.append(podId, "pod.attention_resolved", { attentionId, decidedBy });
  }

  assign(podId: string, assignment: PodAssignment, proposal: Omit<PodProposalRecord, "assignment">): PodView {
    const parsed = PodAssignmentSchema.parse(assignment);
    return this.append(podId, "pod.assignment_recorded", {
      assignment: parsed,
      proposalId: proposal.proposalId, assignmentDigest: proposal.assignmentDigest,
      charterDigest: proposal.charterDigest, grantDigest: proposal.grantDigest, leaseDigest: proposal.leaseDigest,
    });
  }

  claimDispatch(podId: string, input: { readonly assignmentId: string; readonly proposalId: string; readonly dispatchId: string }): PodView {
    return this.append(podId, "pod.assignment_dispatched", input);
  }

  startReservedInvocation(podId: string, input: { readonly assignmentId: string; readonly dispatchId: string;
    readonly authorizedAt: string; readonly executionId: string; readonly charterRevision: number }): PodView {
    const events = readStreamEvents(this.journal, podId);
    if (events.length === 0) throw new Error(`pod ${podId} does not exist`);
    const current = projectPod(events)!;
    const invocationEventId = randomUUID();
    const next: NewEvent<string, unknown>[] = [{ eventId: invocationEventId, streamId: podId, type: "pod.assignment_invocation_started",
      payload: { assignmentId: input.assignmentId, dispatchId: input.dispatchId, authorizedAt: input.authorizedAt },
      causationId: events.at(-1)!.eventId, correlationId: events[0]!.correlationId },
    { eventId: randomUUID(), streamId: podId, type: "pod.execution_reserved", payload: { assignmentId: input.assignmentId,
      dispatchId: input.dispatchId, executionId: input.executionId, charterRevision: input.charterRevision },
      causationId: invocationEventId, correlationId: events[0]!.correlationId }];
    projectPod([...events, ...next.map((event, index) => candidateEvent(event, current.streamVersion + index + 1))]);
    this.journal.append(podId, current.streamVersion, next);
    return this.require(podId);
  }

  bindExecution(podId: string, input: { readonly assignmentId: string; readonly dispatchId: string; readonly executionId: string;
    readonly processId: string; readonly processIncarnation: string }): PodView {
    return this.append(podId, "pod.execution_bound", input);
  }

  observeDispatch(podId: string, input: {
    readonly assignmentId: string;
    readonly dispatchId: string;
    readonly outcome: "completed" | "cancelled" | "timed_out" | "failed" | "uncertain";
    readonly evidenceIds: readonly string[];
    readonly usage: { readonly elapsedMs: number; readonly retries: number; readonly costUsd: number;
      readonly inputTokens: number; readonly outputTokens: number; readonly externalEffects: 0 };
    readonly terminationAcknowledged?: boolean;
  }): PodView {
    return this.append(podId, "pod.assignment_observed", { ...input,
      terminationAcknowledged: input.terminationAcknowledged ?? false });
  }

  recordOwnershipIntent(podId: string, intent: PodOwnershipIntent): PodView {
    return this.append(podId, "pod.ownership_intent_observed", PodOwnershipIntentSchema.parse(intent));
  }

  checkpoint(podId: string, checkpoint: PodCheckpoint): PodView {
    return this.append(podId, "pod.checkpointed", PodCheckpointSchema.parse(checkpoint));
  }

  recordEvidence(podId: string, evidence: PodEvidence, causationId: string | null = null): StoredEvent {
    return this.appendReturningEvent(podId, "pod.evidence_recorded", PodEvidenceSchema.parse(evidence), causationId);
  }

  revise(podId: string, input: RevisePodInput): PodView {
    const revision = PodRevisionSchema.parse({ schemaVersion: 1, ...input });
    const existing = this.require(podId);
    const accepted = existing.revisions.find((candidate) => candidate.revisionId === revision.revisionId);
    if (accepted !== undefined) {
      if (accepted.revision !== revision.charter.revision || accepted.charterDigest !== digestCanonical(revision.charter)) throw new Error("pod revision identity is already bound");
      return existing;
    }
    const events = readStreamEvents(this.journal, podId);
    const first: NewEvent<string, unknown> = { streamId: podId, type: "pod.revised", payload: revision,
      causationId: revision.cause.eventId, correlationId: events[0]!.correlationId };
    const firstEventId = randomUUID();
    const firstWithId = { ...first, eventId: firstEventId };
    const second: NewEvent<string, unknown> = { eventId: randomUUID(), streamId: podId, type: "pod.task_relationships_recorded", payload: {
      charterRevision: revision.charter.revision,
      relationships: revision.charter.tasks.map((task) => ({ taskId: task.taskId, dependencies: task.dependencies })),
    }, causationId: firstEventId, correlationId: events[0]!.correlationId };
    const candidates = [firstWithId, second].map((event, index) => candidateEvent(event, existing.streamVersion + index + 1));
    projectPod([...events, ...candidates]);
    try {
      this.journal.append(podId, existing.streamVersion, [firstWithId, second]);
    } catch (error) {
      if (!(error instanceof Error) || !/^expected version \d+, actual \d+$/.test(error.message)) throw error;
      const raced = this.require(podId);
      const winner = raced.revisions.find((candidate) => candidate.revisionId === revision.revisionId);
      if (winner?.charterDigest !== digestCanonical(revision.charter)) throw error;
      return raced;
    }
    return this.require(podId);
  }

  requireReconciliation(podId: string, reconciliation: PodReconciliation): PodView {
    return this.append(podId, "pod.reconciliation_required", PodReconciliationSchema.parse(reconciliation));
  }

  reconcileInterruptedDispatch(podId: string, assignmentId: string): PodView {
    const current = this.require(podId);
    const assignment = current.assignments[assignmentId];
    if (current.reconciliation?.assignmentId === assignmentId) return current;
    if (assignment?.dispatchId === null || (assignment?.status !== "dispatched" && assignment?.status !== "invoking" && assignment?.status !== "uncertain")) {
      throw new Error("pod assignment has no uncertain dispatch to reconcile");
    }
    return this.requireReconciliation(podId, {
      reconciliationId: `reconcile-${assignment.dispatchId}`,
      assignmentId,
      dispatchId: assignment.dispatchId,
      operation: "subordinate dispatch",
      reason: "Durable dispatch intent lacks a conclusive observation after restart.",
      evidence: { dispatchId: assignment.dispatchId },
      requestedBy: "pod-recovery-controller",
    });
  }

  resolveReconciliation(podId: string, input: {
    readonly reconciliationId: string; readonly assignmentId: string; readonly dispatchId: string;
    readonly resolution: "completed" | "no_effect" | "failed"; readonly evidenceIds: readonly string[]; readonly decidedBy: string;
    readonly executionId?: string | null; readonly processId?: string | null; readonly processIncarnation?: string | null;
    readonly terminationEvidenceSha256?: string | null; readonly effectEvidenceSha256?: string | null;
  }): PodView {
    return this.append(podId, "pod.reconciliation_resolved", PodReconciliationResolutionSchema.parse(input));
  }

  requestCancellation(podId: string, cancellation: { readonly requestedBy: string; readonly reason: string }): PodView {
    return this.append(podId, "pod.cancel_requested", cancellation);
  }

  complete(podId: string): PodView {
    const current = this.require(podId);
    if (current.lifecycle === "terminal") throw new Error("pod is already terminal");
    const tasks = current.charter.tasks.map((task) => {
      const assignment = Object.values(current.assignments).find((candidate) => candidate.taskId === task.taskId && candidate.charterRevision === current.revision);
      if (assignment?.status !== "completed") throw new Error(`pod task ${task.taskId} lacks a completed durable assignment observation`);
      return { taskId: task.taskId, outcome: "completed" as const, evidenceIds: [...assignment.evidenceIds] };
    });
    for (const checkpoint of current.charter.checkpoints) {
      if (current.checkpoints[checkpoint.checkpointId]?.status !== "passed") throw new Error(`pod checkpoint ${checkpoint.checkpointId} has not passed`);
    }
    return this.terminalize(podId, "completed", { tasks, evidenceIds: [...new Set(tasks.flatMap((task) => task.evidenceIds))].sort() });
  }

  cancel(podId: string): PodView {
    return this.terminalizeDerived(podId, "cancelled");
  }

  deny(podId: string): PodView {
    return this.terminalizeDerived(podId, "denied");
  }

  timeOut(podId: string): PodView {
    return this.terminalizeDerived(podId, "timed_out");
  }

  fail(podId: string): PodView {
    return this.terminalizeDerived(podId, "failed");
  }

  private terminalizeDerived(podId: string, outcome: Exclude<TerminalOutcome, "completed">): PodView {
    const current = this.require(podId);
    if (current.reconciliation !== null) return current;
    const unresolved = Object.values(current.assignments).find((assignment) =>
      assignment.status === "dispatched" || assignment.status === "invoking" || assignment.status === "uncertain");
    if (unresolved !== undefined) return this.reconcileInterruptedDispatch(podId, unresolved.assignmentId);
    const tasks = current.charter.tasks.map((task) => {
      const assignment = Object.values(current.assignments).find((candidate) =>
        candidate.taskId === task.taskId && candidate.charterRevision === current.revision);
      return { taskId: task.taskId, outcome: assignment?.status === "completed" ? "completed" as const : outcome,
        evidenceIds: [...(assignment?.evidenceIds ?? [])] };
    });
    return this.terminalize(podId, outcome, { tasks, evidenceIds: [...new Set(tasks.flatMap((task) => task.evidenceIds))].sort() });
  }

  private terminalize(podId: string, outcome: TerminalOutcome, result: Pick<PodTerminalProjection, "tasks" | "evidenceIds">): PodView {
    const current = this.require(podId);
    const terminal = PodTerminalProjectionSchema.parse({
      schemaVersion: 1,
      podId,
      projectId: current.projectId,
      charterRevision: current.revision,
      outcome,
      ...result,
    });
    return this.append(podId, `pod.${outcome}`, terminal);
  }

  private append(podId: string, type: string, payload: unknown, causationId: string | null = null): PodView {
    this.appendReturningEvent(podId, type, payload, causationId);
    return this.require(podId);
  }

  private appendReturningEvent(podId: string, type: string, payload: unknown, causationId: string | null = null): StoredEvent {
    const events = readStreamEvents(this.journal, podId);
    if (events.length === 0) throw new Error(`pod ${podId} does not exist`);
    const current = projectPod(events)!;
    const event: NewEvent<string, unknown> = {
      streamId: podId,
      type,
      payload,
      causationId: causationId ?? events.at(-1)!.eventId,
      correlationId: events[0]!.correlationId,
    };
    projectPod([...events, candidateEvent(event, current.streamVersion + 1)]);
    return this.journal.append(podId, current.streamVersion, [event])[0]!;
  }

  private require(podId: string): PodView {
    const current = this.inspect(podId);
    if (current === null) throw new Error(`pod ${podId} does not exist`);
    return current;
  }
}

function candidateEvent(event: NewEvent<string, unknown>, streamVersion: number): StoredEvent {
  return { ...event, eventId: `candidate-${streamVersion}`, streamVersion, globalPosition: streamVersion, recordedAt: "2026-01-01T00:00:00.000Z" };
}
