import type { StoredEvent } from "../contracts/event.js";
import { z } from "zod";
import { parseCapsuleEventPayload } from "../capsule/capsule-events.js";
import { parseOpenCodeMilestonePayload } from "../agents/opencode-agent-events.js";
import { MilestonePausedPayloadSchema } from "../contracts/authority-attention.js";
import { parseRoutingEventPayload } from "../routing/routing-events.js";
import { MilestoneAuthorityEnvelopePayloadSchema, PlanRevisionPayloadSchema, ReplanningPausedPayloadSchema, ReplanningPolicyBoundPayloadSchema, ReplanningResolutionPayloadSchema } from "../contracts/replanning.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import { parseReleaseEventPayload, ReleaseMilestoneTaskCompletedPayloadSchema } from "../release/release-events.js";
import { envelopeReadPaths, envelopeWritePaths, parseWorkerEventPayload, type WorkerBinding } from "../workers/worker-lifecycle.js";
import { parseRoleCapabilityEventPayload } from "../workers/role-capability-envelope.js";
import { CapabilityBoundaryPausedPayloadSchema, CapabilityBoundaryResolvedPayloadSchema } from "../contracts/capability-boundary.js";
import { parseWebResearchEventPayload } from "../research/web-research.js";
import { ArtifactRecordedEventSchema, isArtifactRecordedEventType } from "../contracts/artifact.js";
import {
  OpenCodeCleanupObservedPayloadSchema,
  OpenCodeMilestoneCompletedPayloadSchema,
  OpenCodeResourceIntentPayloadSchema,
  OpenCodeResourcesPreparedPayloadSchema,
  OpenCodeTraceObservedPayloadSchema,
} from "../agents/opencode-agent-events.js";
import {
  MilestoneCompletedPayloadSchema,
  WriterBatchStartedPayloadSchema,
  WriterIntegrationCompletedPayloadSchema,
  WriterTerminalReleasedPayloadSchema,
} from "../contracts/milestone.js";
import { LegacyMilestoneNonSuccessPayloadSchema, MilestoneTerminalPayloadSchema } from "../contracts/milestone-result.js";
import { PlanReplacementPayloadSchema, TaskReadyPayloadSchema } from "../contracts/authority-attention.js";
import { IntegrationBranchPreparationIntentSchema, IntegrationBranchPreparationObservedSchema } from "../contracts/integration-branch-preparation.js";
import { EffectReconciliationPayloadSchema, UncertainEffectPayloadSchema } from "../contracts/uncertain-effect.js";
import { ReleaseOperationBoundPayloadSchema } from "../release/release-events.js";
import {
  PreflightFailedPayloadSchema,
  PreflightPayloadSchema,
  RunAcceptedPayloadSchema,
  RunAnalysisCompletedPayloadSchema,
  RunApprovalRequestedPayloadSchema,
  RunCancelledPayloadSchema,
  RunIntakeCompletedPayloadSchema,
  RunPhasePayloadSchema,
  RunPlanRevisedPayloadSchema,
  RunReadyPayloadSchema,
  RunReopenedPayloadSchema,
  RunResumedPayloadSchema,
  RunSuspendedPayloadSchema,
  RunTerminalPayloadSchema,
  ServiceReadyPayloadSchema,
  ServiceStartingPayloadSchema,
} from "../runs/run-contracts.js";
import {
  IntakeSnapshotClosedPayloadSchema,
  SourceDiscoveredPayloadSchema,
  SourceRejectedPayloadSchema,
} from "../intake/intake-contracts.js";
import {
  ApprovalAcceptedPayloadSchema,
  ApprovalPacketSchema,
  ApprovalReservationConsumedPayloadSchema,
  ApprovalReservationPayloadSchema,
  ApprovalStalePayloadSchema,
  AttemptPayloadSchema,
  AttentionIdentityReservationPayloadSchema,
  AttentionIndexRaisedPayloadSchema,
  AttentionIndexResolvedPayloadSchema,
  AttentionRaisedPayloadSchema,
  AttentionResolvedPayloadSchema,
  DecisionAcceptedPayloadSchema,
  DecisionExpiredPayloadSchema,
  DecisionRejectedPayloadSchema,
  DecisionRequestedPayloadSchema,
  QuestionPacketSchema,
  ScopeAdmissionPayloadSchema,
} from "../attention/attention-contracts.js";

export const AGENT_TAIL_SCHEMA_VERSION = "1.0";
export const AGENT_TAIL_JOURNAL_EMITTER_ID = "zentra:event-journal";

export const AGENT_TAIL_EVENT_TYPES = [
  "task.created", "task.worktree_creation_started", "task.leased", "task.started",
  "task.writer_completed", "task.validation_started", "task.validation_completed",
  "task.review_requested", "task.review_dispatch_intent", "task.review_approved",
  "task.review_policy_blocked", "task.commit_observed", "task.integration_started",
  "task.integration_prepared", "task.integration_observed", "task.cleanup_started",
  "task.cleanup_completed", "task.cleanup_observed", "task.cleanup_reconciled",
  "task.artifact_recording", "task.effect_uncertain", "task.effect_reconciled",
  "task.capability_boundary_paused", "task.capability_boundary_resolved",
  "task.completed", "task.cancelled", "task.failed", "task.timed_out", "task.denied",
  "milestone.created", "milestone.plan_created", "milestone.authority_envelope_established",
  "milestone.replanning_policy_bound", "milestone.integration_branch_preparation_intent",
  "milestone.integration_branch_preparation_observed", "milestone.task_ready",
  "milestone.task_running", "milestone.task_blocked", "milestone.task_completed",
  "milestone.agent_execution_completed", "milestone.writer_batch_started",
  "milestone.writer_integration_completed", "milestone.writer_terminal_released",
  "milestone.release_operation_bound", "milestone.paused",
  "milestone.capability_boundary_paused", "milestone.capability_boundary_resolved",
  "milestone.plan_replaced", "milestone.plan_revised", "milestone.replanning_resolved",
  "milestone.agent_trace_observed", "milestone.agent_resource_intent",
  "milestone.agent_resources_prepared", "milestone.agent_cleanup_observed",
  "milestone.completed", "milestone.cancelled", "milestone.denied",
  "milestone.timed_out", "milestone.failed",
  "worker.bound", "worker.started", "worker.observed", "worker.uncertain",
  "worker.cleanup_observed", "worker.terminal",
  "release.created", "release.worktree_intent", "release.environment_intent",
  "release.refs_snapshot", "release.refs_verified", "release.step_started",
  "release.step_observed", "release.artifact_hashed", "release.prepared_local_only",
  "release.failed",
  "capsule.started", "capsule.runtime_attested", "capsule.image_attested",
  "capsule.resources_prepared", "capsule.worker_attested", "capsule.check_observed",
  "capsule.harness_attested", "capsule.proxy_interaction_observed",
  "capsule.github_grant_consumed", "capsule.github_broker_accepted",
  "capsule.github_broker_denied", "capsule.github_broker_observed",
  "capsule.github_broker_reconciled", "capsule.failure_observed",
  "capsule.cleanup_observed", "capsule.completed", "capsule.cancelled",
  "capsule.timed_out", "capsule.failed",
  "routing.model_selected", "routing.outcome_recorded",
  "capability_envelope.accepted", "capability_envelope.evaluated",
  "web_research.observed",
  "service.starting", "service.ready",
  "run.accepted", "preflight.started", "preflight.completed", "preflight.failed",
  "run.waiting", "run.blocked", "run.resumed", "run.reopened", "run.intake_completed",
  "run.analysis_completed", "run.approval_requested", "run.ready_for_execution",
  "run.plan_revised",
  "run.completed", "run.cancelled", "run.denied", "run.timed_out", "run.failed",
  "source.discovered", "source.rejected", "intake.snapshot_closed",
  "questionnaire.proposed", "decision.requested", "decision.accepted", "decision.rejected",
  "decision.expired", "decision.stale_attempted", "decision.duplicate_attempted",
  "approval.requested", "approval.accepted", "approval.rejected", "approval.expired",
  "approval.stale", "approval.stale_attempted", "approval.duplicate_attempted",
  "approval.reserved", "approval.reservation_consumed",
  "attention.raised", "attention.resolved", "attention.index_raised",
  "attention.index_resolved", "attention.scope_admitted", "attention.identity_reserved",
] as const;

type AgentTailEventType = typeof AGENT_TAIL_EVENT_TYPES[number];
interface PayloadParser { parse(payload: unknown): unknown }

const Id = z.string().min(1).max(4_096);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const Outcome = z.enum(["completed", "cancelled", "denied", "timed_out", "failed"]);
const mandatory = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const parseWith = (parse: (payload: unknown) => unknown): PayloadParser => ({ parse });
const taskTerminal = mandatory({ stage: Id });
const milestoneTerminal = z.union([
  MilestoneTerminalPayloadSchema,
  MilestoneCompletedPayloadSchema,
  LegacyMilestoneNonSuccessPayloadSchema,
]);
const validationCompleted = z.union([
  mandatory({ validation: mandatory({
    name: Id, outcome: Outcome.exclude(["denied"]), exitCode: z.number().int().nullable(),
    argvSha256: Digest, outputSha256: Digest, startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
  }) }),
  mandatory({
    name: Id, outcome: Outcome.exclude(["denied"]), exitCode: z.number().int().nullable(),
    argvSha256: Digest, outputSha256: Digest, startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
  }),
]);

export const AGENT_TAIL_PAYLOAD_SCHEMAS: Readonly<Record<AgentTailEventType, PayloadParser>> = {
  "task.created": mandatory({ projectId: Id, title: Id }),
  "task.worktree_creation_started": mandatory({ taskId: Id, branch: Id, path: Id, baseCommit: Commit }),
  "task.leased": mandatory({ leaseOwner: Id, workspace: Id }),
  "task.started": mandatory({ workerId: Id }),
  "task.writer_completed": mandatory({ workerId: Id, outcome: Outcome }),
  "task.validation_started": mandatory({ patch: z.object({ type: z.literal("artifact.ready"), path: Id, sha256: Digest }), diffSha256: Digest }),
  "task.validation_completed": validationCompleted,
  "task.review_requested": mandatory({ reviewerId: Id, validation: z.object({ name: Id, outcome: Outcome.exclude(["denied"]) }).passthrough() }),
  "task.review_dispatch_intent": mandatory({ schemaVersion: z.literal(1), reviewerId: Id, diffSha256: Digest, validationSha256: Digest, dispatchId: z.string().uuid() }),
  "task.review_approved": mandatory({ review: mandatory({ reviewerId: Id, approved: z.boolean(), diffSha256: Digest, validationSha256: Digest }) }),
  "task.review_policy_blocked": mandatory({ stage: Id, reason: Id, reviewPolicy: z.object({}).passthrough() }),
  "task.commit_observed": mandatory({ stage: z.literal("commit"), reason: Id }),
  "task.integration_started": mandatory({ sourceCommit: Commit, review: z.object({ reviewerId: Id }).passthrough() }),
  "task.integration_prepared": mandatory({ receipt: mandatory({ taskId: Id, projectId: Id, outcome: z.literal("completed") }) }),
  "task.integration_observed": z.union([
    mandatory({ receipt: mandatory({ taskId: Id, projectId: Id, outcome: z.literal("completed") }), verification: z.enum(["verified", "failed"]) }),
    mandatory({ reason: Id, evidence: z.object({}).passthrough() }),
    mandatory({ error: mandatory({ name: Id, message: z.string() }) }),
  ]),
  "task.cleanup_started": mandatory({ sourceCommit: Commit, resultCommit: Commit, workspace: Id, branch: Id }),
  "task.cleanup_completed": mandatory({ sourceCommit: Commit, resultCommit: Commit, workspace: Id, branch: Id }),
  "task.cleanup_observed": mandatory({ phase: Id, uncertain: z.boolean(), evidence: z.record(z.string(), z.unknown()), reason: Id }),
  "task.cleanup_reconciled": mandatory({ cleanup: z.object({ sourceCommit: Commit }).passthrough(), observation: z.object({ phase: Id, uncertain: z.boolean() }).passthrough() }),
  "task.artifact_recording": mandatory({ artifactProtocolVersion: z.literal(1), artifactId: Id, kind: z.enum(["patch", "validation_report", "review_report", "integration_receipt"]), sha256: Digest }),
  "task.effect_uncertain": UncertainEffectPayloadSchema,
  "task.effect_reconciled": EffectReconciliationPayloadSchema,
  "task.capability_boundary_paused": CapabilityBoundaryPausedPayloadSchema,
  "task.capability_boundary_resolved": CapabilityBoundaryResolvedPayloadSchema,
  "task.completed": z.union([mandatory({ receipt: z.object({ taskId: Id }).passthrough() }), mandatory({ stage: z.literal("validation"), validation: z.object({ name: Id }).passthrough(), diffSha256: Digest, changedPath: Id, workspace: Id })]),
  "task.cancelled": taskTerminal,
  "task.failed": taskTerminal,
  "task.timed_out": taskTerminal,
  "task.denied": taskTerminal,
  "milestone.created": mandatory({ projectId: Id, title: Id }),
  "milestone.plan_created": mandatory({ plan: z.object({ milestoneId: Id, projectId: Id, tasks: z.array(z.unknown()) }).passthrough() }),
  "milestone.authority_envelope_established": MilestoneAuthorityEnvelopePayloadSchema,
  "milestone.replanning_policy_bound": ReplanningPolicyBoundPayloadSchema,
  "milestone.integration_branch_preparation_intent": IntegrationBranchPreparationIntentSchema,
  "milestone.integration_branch_preparation_observed": IntegrationBranchPreparationObservedSchema,
  "milestone.task_ready": TaskReadyPayloadSchema,
  "milestone.task_running": parseWith((payload) => {
    if (typeof payload === "object" && payload !== null &&
      (payload as Readonly<Record<string, unknown>>)["harness"] === "opencode") {
      return parseOpenCodeMilestonePayload("milestone.task_running", payload);
    }
    return z.union([
      z.strictObject({ taskId: Id }),
      z.strictObject({ taskId: Id, actorId: Id, role: Id }),
    ]).parse(payload);
  }),
  "milestone.task_blocked": mandatory({ taskId: Id, reason: Id }),
  "milestone.task_completed": parseWith((payload) => {
    const record = typeof payload === "object" && payload !== null
      ? payload as Readonly<Record<string, unknown>> : null;
    if (record?.["harness"] === "opencode") {
      return parseOpenCodeMilestonePayload("milestone.task_completed", payload);
    }
    if (typeof record?.["evidence"] === "object" && record["evidence"] !== null &&
      "releaseStreamId" in record["evidence"]) {
      return ReleaseMilestoneTaskCompletedPayloadSchema.parse(payload);
    }
    return z.union([
      z.strictObject({ taskId: Id, outcome: Outcome }),
      z.strictObject({
        taskId: Id, actorId: Id, role: Id, outcome: Outcome,
        evidence: z.record(z.string(), z.unknown()),
      }),
    ]).parse(payload);
  }),
  "milestone.agent_execution_completed": OpenCodeMilestoneCompletedPayloadSchema,
  "milestone.writer_batch_started": WriterBatchStartedPayloadSchema,
  "milestone.writer_integration_completed": WriterIntegrationCompletedPayloadSchema,
  "milestone.writer_terminal_released": WriterTerminalReleasedPayloadSchema,
  "milestone.release_operation_bound": ReleaseOperationBoundPayloadSchema,
  "milestone.paused": parseWith(parseMilestonePausedPayload),
  "milestone.capability_boundary_paused": CapabilityBoundaryPausedPayloadSchema,
  "milestone.capability_boundary_resolved": CapabilityBoundaryResolvedPayloadSchema,
  "milestone.plan_replaced": PlanReplacementPayloadSchema,
  "milestone.plan_revised": PlanRevisionPayloadSchema,
  "milestone.replanning_resolved": ReplanningResolutionPayloadSchema,
  "milestone.agent_trace_observed": OpenCodeTraceObservedPayloadSchema,
  "milestone.agent_resource_intent": OpenCodeResourceIntentPayloadSchema,
  "milestone.agent_resources_prepared": OpenCodeResourcesPreparedPayloadSchema,
  "milestone.agent_cleanup_observed": OpenCodeCleanupObservedPayloadSchema,
  "milestone.completed": milestoneTerminal,
  "milestone.cancelled": milestoneTerminal,
  "milestone.denied": milestoneTerminal,
  "milestone.timed_out": milestoneTerminal,
  "milestone.failed": milestoneTerminal,
  "worker.bound": parseWith((payload) => parseWorkerEventPayload("worker.bound", payload)),
  "worker.started": parseWith((payload) => parseWorkerEventPayload("worker.started", payload)),
  "worker.observed": parseWith((payload) => parseWorkerEventPayload("worker.observed", payload)),
  "worker.uncertain": parseWith((payload) => parseWorkerEventPayload("worker.uncertain", payload)),
  "worker.cleanup_observed": parseWith((payload) => parseWorkerEventPayload("worker.cleanup_observed", payload)),
  "worker.terminal": parseWith((payload) => parseWorkerEventPayload("worker.terminal", payload)),
  "release.created": parseWith((payload) => parseReleaseEventPayload("release.created", payload)),
  "release.worktree_intent": parseWith((payload) => parseReleaseEventPayload("release.worktree_intent", payload)),
  "release.environment_intent": parseWith((payload) => parseReleaseEventPayload("release.environment_intent", payload)),
  "release.refs_snapshot": parseWith((payload) => parseReleaseEventPayload("release.refs_snapshot", payload)),
  "release.refs_verified": parseWith((payload) => parseReleaseEventPayload("release.refs_verified", payload)),
  "release.step_started": parseWith((payload) => parseReleaseEventPayload("release.step_started", payload)),
  "release.step_observed": parseWith((payload) => parseReleaseEventPayload("release.step_observed", payload)),
  "release.artifact_hashed": parseWith((payload) => parseReleaseEventPayload("release.artifact_hashed", payload)),
  "release.prepared_local_only": parseWith((payload) => parseReleaseEventPayload("release.prepared_local_only", payload)),
  "release.failed": parseWith((payload) => parseReleaseEventPayload("release.failed", payload)),
  "capsule.started": parseWith((payload) => parseCapsuleEventPayload("capsule.started", payload)),
  "capsule.runtime_attested": parseWith((payload) => parseCapsuleEventPayload("capsule.runtime_attested", payload)),
  "capsule.image_attested": parseWith((payload) => parseCapsuleEventPayload("capsule.image_attested", payload)),
  "capsule.resources_prepared": parseWith((payload) => parseCapsuleEventPayload("capsule.resources_prepared", payload)),
  "capsule.worker_attested": parseWith((payload) => parseCapsuleEventPayload("capsule.worker_attested", payload)),
  "capsule.check_observed": parseWith((payload) => parseCapsuleEventPayload("capsule.check_observed", payload)),
  "capsule.harness_attested": parseWith((payload) => parseCapsuleEventPayload("capsule.harness_attested", payload)),
  "capsule.proxy_interaction_observed": parseWith((payload) => parseCapsuleEventPayload("capsule.proxy_interaction_observed", payload)),
  "capsule.github_grant_consumed": parseWith((payload) => parseCapsuleEventPayload("capsule.github_grant_consumed", payload)),
  "capsule.github_broker_accepted": parseWith((payload) => parseCapsuleEventPayload("capsule.github_broker_accepted", payload)),
  "capsule.github_broker_denied": parseWith((payload) => parseCapsuleEventPayload("capsule.github_broker_denied", payload)),
  "capsule.github_broker_observed": parseWith((payload) => parseCapsuleEventPayload("capsule.github_broker_observed", payload)),
  "capsule.github_broker_reconciled": parseWith((payload) => parseCapsuleEventPayload("capsule.github_broker_reconciled", payload)),
  "capsule.failure_observed": parseWith((payload) => parseCapsuleEventPayload("capsule.failure_observed", payload)),
  "capsule.cleanup_observed": parseWith((payload) => parseCapsuleEventPayload("capsule.cleanup_observed", payload)),
  "capsule.completed": parseWith((payload) => parseCapsuleEventPayload("capsule.completed", payload)),
  "capsule.cancelled": parseWith((payload) => parseCapsuleEventPayload("capsule.cancelled", payload)),
  "capsule.timed_out": parseWith((payload) => parseCapsuleEventPayload("capsule.timed_out", payload)),
  "capsule.failed": parseWith((payload) => parseCapsuleEventPayload("capsule.failed", payload)),
  "routing.model_selected": parseWith((payload) => parseRoutingEventPayload("routing.model_selected", payload)),
  "routing.outcome_recorded": parseWith((payload) => parseRoutingEventPayload("routing.outcome_recorded", payload)),
  "capability_envelope.accepted": parseWith((payload) => parseRoleCapabilityEventPayload("capability_envelope.accepted", payload)),
  "capability_envelope.evaluated": parseWith((payload) => parseRoleCapabilityEventPayload("capability_envelope.evaluated", payload)),
  "web_research.observed": parseWith((payload) => parseWebResearchEventPayload("web_research.observed", payload)),
  "source.discovered": SourceDiscoveredPayloadSchema,
  "source.rejected": SourceRejectedPayloadSchema,
  "intake.snapshot_closed": IntakeSnapshotClosedPayloadSchema,
  "service.starting": ServiceStartingPayloadSchema,
  "service.ready": ServiceReadyPayloadSchema,
  "run.accepted": RunAcceptedPayloadSchema,
  "preflight.started": PreflightPayloadSchema,
  "preflight.completed": PreflightPayloadSchema,
  "preflight.failed": PreflightFailedPayloadSchema,
  "run.waiting": RunSuspendedPayloadSchema,
  "run.blocked": RunSuspendedPayloadSchema,
  "run.resumed": RunResumedPayloadSchema,
  "run.reopened": RunReopenedPayloadSchema,
  "run.intake_completed": RunIntakeCompletedPayloadSchema,
  "run.analysis_completed": RunAnalysisCompletedPayloadSchema,
  "run.approval_requested": RunApprovalRequestedPayloadSchema,
  "run.ready_for_execution": RunReadyPayloadSchema,
  "run.plan_revised": RunPlanRevisedPayloadSchema,
  "run.completed": RunTerminalPayloadSchema,
  "run.cancelled": RunCancelledPayloadSchema,
  "run.denied": RunTerminalPayloadSchema,
  "run.timed_out": RunTerminalPayloadSchema,
  "run.failed": RunTerminalPayloadSchema,
  "questionnaire.proposed": QuestionPacketSchema,
  "decision.requested": DecisionRequestedPayloadSchema,
  "decision.accepted": DecisionAcceptedPayloadSchema,
  "decision.rejected": DecisionRejectedPayloadSchema,
  "decision.expired": DecisionExpiredPayloadSchema,
  "decision.stale_attempted": AttemptPayloadSchema,
  "decision.duplicate_attempted": AttemptPayloadSchema,
  "approval.requested": ApprovalPacketSchema,
  "approval.accepted": ApprovalAcceptedPayloadSchema,
  "approval.rejected": DecisionRejectedPayloadSchema,
  "approval.expired": DecisionExpiredPayloadSchema,
  "approval.stale": ApprovalStalePayloadSchema,
  "approval.stale_attempted": AttemptPayloadSchema,
  "approval.duplicate_attempted": AttemptPayloadSchema,
  "approval.reserved": ApprovalReservationPayloadSchema,
  "approval.reservation_consumed": ApprovalReservationConsumedPayloadSchema,
  "attention.raised": AttentionRaisedPayloadSchema,
  "attention.resolved": AttentionResolvedPayloadSchema,
  "attention.index_raised": AttentionIndexRaisedPayloadSchema,
  "attention.index_resolved": AttentionIndexResolvedPayloadSchema,
  "attention.scope_admitted": ScopeAdmissionPayloadSchema,
  "attention.identity_reserved": AttentionIdentityReservationPayloadSchema,
};

export interface AgentTailActor {
  readonly id: string;
  readonly role?: string;
}

export interface AgentTailOperation {
  readonly name?: string;
  readonly status: string;
}

export interface AgentTailEvent {
  readonly schema_version: string;
  readonly event_id: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly emitter_id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: string;
  readonly actor: AgentTailActor;
  readonly operation: AgentTailOperation;
  readonly attributes: {
    readonly zentra: {
      readonly event_id: string;
      readonly stream_id: string;
      readonly stream_version: number;
      readonly global_position: number;
      readonly causation_id: string | null;
      readonly correlation_id: string;
      readonly native_type: string;
      readonly chosen_model?: {
        readonly capability_id: string;
        readonly harness: string;
        readonly transport_model_sha256: string;
        readonly role: string;
        readonly task_type: string;
        readonly basis: string;
        readonly model_sheet_sha256: string;
      };
    };
  };
  readonly payload: unknown;
}

export function storedEventsToAgentTailEvents(
  events: readonly StoredEvent[],
): readonly AgentTailEvent[] {
  return Object.freeze(events.map((event) => storedEventToAgentTailEvent(event)));
}

export function storedEventToAgentTailEvent(event: StoredEvent): AgentTailEvent {
  assertAgentTailCompatibleEvent(event);
  const payload = isArtifactRecordedEventType(event.type)
    ? redactedArtifactPayload(event.type, event.payload)
    : isAttentionEventType(event.type)
      ? redactedAttentionPayload(event.type, event.payload)
    : event.type === "task.validation_completed"
      ? redactedTaskValidationPayload(event.payload)
    : event.type === "task.writer_completed"
      ? redactedWriterCompletedPayload(event.payload)
    : event.type === "milestone.capability_boundary_resolved" || event.type === "task.capability_boundary_resolved"
    ? CapabilityBoundaryResolvedPayloadSchema.parse(event.payload)
    : event.type === "milestone.capability_boundary_paused" || event.type === "task.capability_boundary_paused"
    ? redactedCapabilityBoundaryPayload(event.payload)
    : event.type === "milestone.paused"
    ? parseMilestonePausedPayload(event.payload)
    : event.type === "milestone.plan_revised"
      ? redactedRevisionPayload(event.payload)
    : event.type === "milestone.replanning_resolved"
      ? ReplanningResolutionPayloadSchema.parse(event.payload)
    : event.type === "milestone.replanning_policy_bound"
      ? redactedPolicyPayload(event.payload)
    : event.type === "milestone.authority_envelope_established"
      ? redactedEnvelopePayload(event.payload)
    : isPotentialReleaseTaskCompletion(event)
      ? redactedReleaseTaskCompletionPayload(event.payload)
    : event.type.startsWith("release.")
      ? redactedReleasePayload(event.type, event.payload)
    : event.type.startsWith("run.") || event.type.startsWith("preflight.") || event.type.startsWith("service.")
      ? AGENT_TAIL_PAYLOAD_SCHEMAS[event.type as AgentTailEventType].parse(event.payload)
    : event.type.startsWith("capsule.")
    ? parseCapsuleEventPayload(event.type, event.payload)
    : event.type.startsWith("routing.")
      ? parseRoutingEventPayload(event.type, event.payload)
    : event.type.startsWith("capability_envelope.")
      ? redactedRoleCapabilityPayload(event.type, event.payload)
    : event.type.startsWith("web_research.")
      ? redactedWebResearchPayload(event.type, event.payload)
    : event.type.startsWith("worker.")
      ? redactedWorkerPayload(event.type, event.payload)
    : isPotentialOpenCodeRoleEvent(event)
      ? redactedOpenCodeMilestonePayload(event.type, event.payload)
      : projectExactSafeFields(event.type, event.payload);
  return Object.freeze({
    schema_version: AGENT_TAIL_SCHEMA_VERSION,
    event_id: event.eventId,
    trace_id: event.correlationId,
    span_id: spanIdFor(event),
    parent_span_id: parentSpanIdFor(event),
    emitter_id: AGENT_TAIL_JOURNAL_EMITTER_ID,
    sequence: event.globalPosition,
    timestamp: event.recordedAt,
    kind: event.type,
    actor: Object.freeze(actorFor(event)),
    operation: Object.freeze({
      name: operationName(event),
      status: operationStatus(event),
    }),
    attributes: Object.freeze({
      zentra: Object.freeze({
        event_id: event.eventId,
        stream_id: event.streamId,
        stream_version: event.streamVersion,
        global_position: event.globalPosition,
        causation_id: event.causationId,
        correlation_id: event.correlationId,
        native_type: event.type,
        ...chosenModelAttributes(event.type, payload),
      }),
    }),
    payload: cloneJson(payload),
  });
}

const ATTENTION_EVENT_TYPES = new Set<string>([
  "questionnaire.proposed", "decision.requested", "decision.accepted", "decision.rejected",
  "decision.expired", "decision.stale_attempted", "decision.duplicate_attempted",
  "approval.requested", "approval.accepted", "approval.rejected", "approval.expired",
  "approval.stale", "approval.stale_attempted", "approval.duplicate_attempted",
  "approval.reserved", "approval.reservation_consumed", "attention.raised",
  "attention.resolved", "attention.index_raised", "attention.index_resolved",
  "attention.scope_admitted", "attention.identity_reserved",
]);

function isAttentionEventType(type: string): boolean {
  return ATTENTION_EVENT_TYPES.has(type);
}

function redactedAttentionPayload(type: string, payload: unknown): unknown {
  const parsed = AGENT_TAIL_PAYLOAD_SCHEMAS[type as AgentTailEventType].parse(payload) as
    Readonly<Record<string, unknown>>;
  const safe: Record<string, unknown> = {};
  for (const key of [
    "schemaVersion", "decisionId", "attentionId", "runId", "runStreamVersion",
    "approvalRequestEventId", "planDigest", "envelopeDigest", "inputsSha256",
    "evidenceSha256", "commandId", "authority", "material", "source", "classification",
    "optionId", "expiredAt", "requestedPlanDigest", "requestedEnvelopeDigest",
    "currentPlanDigest", "currentEnvelopeDigest", "resolution", "admissionId", "scopeId",
    "attentionRevision", "packetSha256", "creationEventId", "kind", "outcome", "warningCode",
    "approvalPacketSha256", "approvalDecisionId", "approvalDecisionEventId",
  ] as const) {
    if (parsed[key] !== undefined) safe[key] = parsed[key];
  }
  const expiry = parsed["expiryPolicy"];
  if (typeof expiry === "object" && expiry !== null && !Array.isArray(expiry)) {
    const record = expiry as Readonly<Record<string, unknown>>;
    safe["expiryPolicy"] = record["kind"] === "wait_forever"
      ? { kind: "wait_forever" }
      : { kind: record["kind"], expiresAt: record["expiresAt"] };
  }
  const actor = parsed["actor"];
  if (typeof actor === "object" && actor !== null && !Array.isArray(actor)) {
    const record = actor as Readonly<Record<string, unknown>>;
    safe["actor"] = { actorId: record["actorId"], kind: record["kind"], channel: record["channel"] };
  }
  const revision = parsed["projectRevision"];
  if (typeof revision === "object" && revision !== null && !Array.isArray(revision)) {
    const record = revision as Readonly<Record<string, unknown>>;
    safe["projectRevision"] = { objectFormat: record["objectFormat"], commit: record["commit"] };
  }
  return safe;
}

function redactedTaskValidationPayload(payload: unknown): unknown {
  const record = payload as Readonly<Record<string, unknown>>;
  const validation = (record?.["validation"] ?? payload) as Readonly<Record<string, unknown>>;
  const name = validation["name"];
  const outcome = validation["outcome"];
  const exitCode = validation["exitCode"];
  const argvSha256 = validation["argvSha256"];
  const outputSha256 = validation["outputSha256"];
  const startedAt = validation["startedAt"];
  const finishedAt = validation["finishedAt"];
  const subjectSha256 = (validation["provenance"] as Readonly<Record<string, unknown>> | undefined)?.["subjectSha256"] ?? null;
  if (
    typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(name) ||
    typeof outcome !== "string" || !["completed", "cancelled", "timed_out", "failed"].includes(outcome) ||
    (exitCode !== null && (!Number.isSafeInteger(exitCode) || typeof exitCode !== "number")) ||
    typeof argvSha256 !== "string" || !/^[a-f0-9]{64}$/.test(argvSha256) ||
    typeof outputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(outputSha256) ||
    typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt)) ||
    typeof finishedAt !== "string" || !Number.isFinite(Date.parse(finishedAt)) ||
    (subjectSha256 !== null && (typeof subjectSha256 !== "string" || !/^[a-f0-9]{64}$/.test(subjectSha256)))
  ) throw new Error("Agent Tail validation projection is invalid");
  return {
    validation: {
      name, outcome, exitCode, argvSha256, outputSha256, startedAt, finishedAt, subjectSha256,
    },
  };
}

function redactedArtifactPayload(type: string, payload: unknown): unknown {
  const parsed = ArtifactRecordedEventSchema.parse({ type, payload }).payload as Readonly<Record<string, unknown>>;
  const artifact = parsed["artifact"] as Readonly<Record<string, unknown>>;
  const evidence = parsed["evidence"] as Readonly<Record<string, unknown>>;
  const safeArtifact = {
    artifactId: artifact["artifactId"],
    taskId: artifact["taskId"],
    kind: artifact["kind"],
    sha256: artifact["sha256"],
    createdAt: artifact["createdAt"],
  };
  if (type === "artifact.patch_recorded") {
    return { artifact: safeArtifact, evidence: {
      diffSha256: evidence["diffSha256"],
      changedContentSha256: evidence["changedContentSha256"],
    } };
  }
  if (type === "artifact.validation_report_recorded") {
    return { artifact: safeArtifact, ...redactedTaskValidationPayload(evidence) as object };
  }
  if (type === "artifact.review_report_recorded") {
    return { artifact: safeArtifact, evidence: {
      reviewerId: evidence["reviewerId"], approved: evidence["approved"],
      diffSha256: evidence["diffSha256"], validationSha256: evidence["validationSha256"],
      decidedAt: evidence["decidedAt"],
    } };
  }
  return { artifact: safeArtifact, evidence: {
    taskId: evidence["taskId"], projectId: evidence["projectId"],
    sourceCommit: evidence["sourceCommit"], resultCommit: evidence["resultCommit"],
    outcome: evidence["outcome"],
  }, phase: parsed["phase"] ?? null };
}

export function agentTailEventToJsonLine(event: AgentTailEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function assertAgentTailCompatibleEvent(event: StoredEvent): void {
  if (!isArtifactRecordedEventType(event.type) &&
    !AGENT_TAIL_EVENT_TYPES.includes(event.type as AgentTailEventType)) {
    throw new Error("Agent Tail projection policy does not recognize the event type");
  }
  if (!isArtifactRecordedEventType(event.type)) {
    AGENT_TAIL_PAYLOAD_SCHEMAS[event.type as AgentTailEventType].parse(event.payload);
  }
  for (const [field, value] of [
    ["eventId", event.eventId],
    ["streamId", event.streamId],
    ["correlationId", event.correlationId],
    ["type", event.type],
    ["recordedAt", event.recordedAt],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Agent Tail ${field} must be a nonempty string`);
    }
  }
  if (!Number.isInteger(event.globalPosition) || event.globalPosition < 0) {
    throw new Error("Agent Tail sequence must be a non-negative integer");
  }
  if (!Number.isInteger(event.streamVersion) || event.streamVersion < 1) {
    throw new Error("Agent Tail stream version must be a positive integer");
  }
  if (event.recordedAt.length < 11 || event.recordedAt[10] !== "T") {
    throw new Error("Agent Tail timestamp must be ISO-like");
  }
  const parsed = Date.parse(event.recordedAt);
  if (!Number.isFinite(parsed) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(event.recordedAt)) {
    throw new Error("Agent Tail timestamp must include a timezone");
  }
}

const SAFE_FIELDS_BY_EVENT = new Map<string, readonly string[]>([
  ["task.created", ["projectId"]],
  ["task.started", ["workerId"]],
  ["task.failed", ["outcome", "evidenceSha256"]],
  ["task.cancelled", ["outcome"]], ["task.timed_out", ["outcome"]],
  ["task.denied", ["outcome", "reviewerId", "diffSha256", "validationSha256"]],
  ["task.review_requested", ["reviewId", "diffSha256", "validationSha256"]],
  ["task.review_approved", ["reviewerId", "diffSha256", "validationSha256", "approved"]],
  ["task.integration_observed", ["outcome", "receiptSha256"]],
  ["task.integration_prepared", ["outcome", "receiptSha256"]],
  ["milestone.created", ["projectId"]],
  ["milestone.completed", ["outcome"]], ["milestone.failed", ["outcome"]],
  ["milestone.cancelled", ["outcome"]], ["milestone.denied", ["outcome"]],
  ["milestone.timed_out", ["outcome"]],
]);

function projectExactSafeFields(type: string, payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  const fields = SAFE_FIELDS_BY_EVENT.get(type) ?? [];
  const safe: Record<string, unknown> = {};
  const record = payload as Readonly<Record<string, unknown>>;
  for (const key of fields) {
    const value = record[key];
    if (value === undefined) continue;
    if (key.endsWith("Sha256") || key.endsWith("Digest")) {
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Agent Tail digest field is invalid");
    } else if (key.endsWith("Id")) {
      if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new Error("Agent Tail identity field is invalid");
    } else if (key.endsWith("At")) {
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("Agent Tail timestamp field is invalid");
    } else if (key === "outcome") {
      if (typeof value !== "string" || !["completed", "cancelled", "timed_out", "failed", "denied", "uncertain"].includes(value)) throw new Error("Agent Tail outcome field is invalid");
    } else if (typeof value !== "boolean" && (!Number.isSafeInteger(value) || typeof value !== "number")) {
      throw new Error("Agent Tail safe scalar field is invalid");
    }
    safe[key] = value;
  }
  return safe;
}

function redactedWriterCompletedPayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  const record = payload as Readonly<Record<string, unknown>>;
  const boundary = typeof record["networkBoundary"] === "object" && record["networkBoundary"] !== null
    ? record["networkBoundary"] as Readonly<Record<string, unknown>> : {};
  const networkBoundary: Record<string, unknown> = {};
  if (boundary["modelTools"] === "denied") networkBoundary["modelTools"] = "denied";
  if (boundary["harnessProviderTransport"] === "user_os_network_authority") {
    networkBoundary["harnessProviderTransport"] = "user_os_network_authority";
  }
  for (const key of ["networkDisabled", "nativeWebToolsDenied", "mcpDenied"] as const) {
    if (typeof boundary[key] === "boolean") networkBoundary[key] = boundary[key];
  }
  if (typeof boundary["mode"] === "string" && ["denied", "declared", "model_provider_only"].includes(boundary["mode"])) {
    networkBoundary["mode"] = boundary["mode"];
  }
  if (typeof boundary["configurationDigest"] === "string" && /^[a-f0-9]{64}$/.test(boundary["configurationDigest"])) {
    networkBoundary["configurationDigest"] = boundary["configurationDigest"];
  }
  return {
    ...projectExactSafeFields("task.failed", payload) as object,
    networkBoundary,
  };
}

function spanIdFor(event: StoredEvent): string {
  if (event.type.startsWith("source.") || event.type === "intake.snapshot_closed") return `intake:${event.streamId}`;
  if (isAttentionEventType(event.type)) return `attention:${event.streamId}`;
  if (event.type.startsWith("service.")) return `service:${event.streamId}`;
  if (event.type.startsWith("preflight.")) return `run:${event.streamId}:preflight`;
  if (event.type.startsWith("run.")) return `run:${event.streamId}`;
  if (event.type.startsWith("capability_envelope.")) return `capability-envelope:${event.streamId}`;
  if (event.type.startsWith("web_research.")) return `web-research:${payloadString(event.payload, "requestId")!}`;
  if (event.type.startsWith("worker.")) return `worker:${payloadString(event.payload, "workerId")!}`;
  if (event.type.startsWith("release.")) return `release:${event.streamId}`;
  if (event.type.startsWith("routing.")) return `routing:${event.streamId}`;
  if (event.type.startsWith("milestone.task_")) {
    const taskId = payloadString(event.payload, "taskId");
    if (taskId !== null) return `milestone:${event.streamId}:task:${taskId}`;
  }
  if (event.type.startsWith("milestone.")) return `milestone:${event.streamId}`;
  if (event.type.startsWith("capsule.")) return `capsule:${event.streamId}`;
  return `task:${event.streamId}`;
}

function parentSpanIdFor(event: StoredEvent): string | null {
  if (event.type.startsWith("preflight.")) return `run:${event.streamId}`;
  if (event.type.startsWith("worker.")) {
    const parent = payloadString(event.payload, "parentWorkerId");
    if (parent !== null) return `worker:${parent}`;
    const context = payloadRecord(event.payload, "taskContext");
    return payloadString(context, "kind") === "milestone"
      ? `milestone:${payloadString(context, "milestoneId")!}:task:${payloadString(event.payload, "taskId")!}`
      : `task:${payloadString(event.payload, "taskId")!}`;
  }
  if (event.type.startsWith("web_research.")) {
    const identity = payloadRecord(event.payload, "identity");
    return identity === null ? null : `worker:${payloadString(identity, "workerId")!}`;
  }
  return event.type.startsWith("milestone.task_") && payloadString(event.payload, "taskId") !== null
    ? `milestone:${event.streamId}`
    : null;
}

function actorFor(event: StoredEvent): AgentTailActor {
  if (event.type.startsWith("source.") || event.type === "intake.snapshot_closed") {
    return { id: "zentra-intake-service", role: "orchestrator" };
  }
  if (isAttentionEventType(event.type)) {
    const actor = payloadRecord(event.payload, "actor");
    return actor === null
      ? { id: "zentra-attention-service", role: "attention" }
      : { id: payloadString(actor, "actorId")!, role: payloadString(actor, "kind")! };
  }
  if (event.type.startsWith("service.")) return { id: "zentra-runtime", role: "service" };
  if (event.type === "run.accepted") {
    const actor = payloadRecord(event.payload, "actor");
    return { id: payloadString(actor, "actorId")!, role: payloadString(actor, "kind")! };
  }
  if (event.type === "run.cancelled") {
    const actor = payloadRecord(event.payload, "requestedBy");
    return { id: payloadString(actor, "actorId")!, role: payloadString(actor, "kind")! };
  }
  if (event.type.startsWith("run.") || event.type.startsWith("preflight.")) {
    return { id: "zentra-run-service", role: "orchestrator" };
  }
  if (event.type.includes("capability_boundary_")) return { id: "zentra-capability-boundary", role: "policy" };
  if (event.type.startsWith("capability_envelope.")) return { id: "zentra-capability-policy", role: "policy" };
  if (event.type.startsWith("web_research.")) {
    const identity = payloadRecord(event.payload, "identity");
    return { id: payloadString(identity, "workerId") ?? "zentra-research-broker", role: payloadString(identity, "role") ?? "researcher" };
  }
  if (event.type.startsWith("worker.")) {
    return { id: payloadString(event.payload, "workerId")!, role: payloadString(event.payload, "role")! };
  }
  if (event.type.startsWith("release.")) return { id: "zentra-local-release-runner", role: "verifier" };
  if (event.type === "milestone.paused") {
    const paused = parseMilestonePausedPayload(event.payload);
    return "revisionId" in paused.attention
      ? { id: paused.attention.requestedBy, role: "replanning_controller" }
      : { id: paused.attention.requestedBy, role: "authority_gate" };
  }
  if (event.type === "milestone.plan_revised") {
    return { id: PlanRevisionPayloadSchema.parse(event.payload).requestedBy, role: "replanning_controller" };
  }
  if (event.type === "milestone.replanning_resolved") {
    return { id: ReplanningResolutionPayloadSchema.parse(event.payload).decidedBy, role: "replanning_controller" };
  }
  if (event.type.startsWith("routing.")) {
    return { id: "zentra-model-router", role: "scheduler" };
  }
  if (isOpenCodeRoleEvent(event)) {
    return {
      id: payloadString(event.payload, "actorId")!,
      role: payloadString(event.payload, "role")!,
    };
  }
  if (event.type === "capsule.proxy_interaction_observed") {
    return { id: "zentra-policy-proxy", role: "policy_proxy" };
  }
  if (event.type.startsWith("capsule.github_broker_") || event.type === "capsule.github_grant_consumed") {
    return { id: "zentra-github-broker", role: "effect_broker" };
  }
  if (event.type.startsWith("capsule.")) {
    return { id: "zentra-capsule-controller", role: "worker_controller" };
  }
  if (event.type.startsWith("milestone.")) {
    if (event.type.includes("task_")) {
      return {
        id: payloadString(event.payload, "actorId") ?? "zentra-scheduler",
        role: payloadString(event.payload, "role") ?? "scheduler",
      };
    }
    if (event.type === "milestone.plan_created") return { id: "zentra-planner", role: "planner" };
    return { id: "zentra-orchestrator", role: "orchestrator" };
  }
  if (event.type === "task.effect_uncertain" || event.type === "task.effect_reconciled") {
    return { id: "zentra-recovery-controller", role: "recovery" };
  }
  if (event.type === "task.started" || event.type === "task.writer_completed") {
    return { id: payloadString(event.payload, "workerId") ?? "zentra-worker", role: "worker" };
  }
  if (event.type.startsWith("task.validation_")) {
    return { id: "zentra-validator", role: "validator" };
  }
  if (event.type.startsWith("task.review_")) {
    const review = payloadRecord(event.payload, "review");
    return {
      id: payloadString(event.payload, "reviewerId") ??
        payloadString(review, "reviewerId") ??
        "zentra-reviewer",
      role: "reviewer",
    };
  }
  if (event.type === "task.denied") {
    const review = payloadRecord(event.payload, "review");
    const reviewerId = payloadString(review, "reviewerId");
    if (reviewerId !== null) return { id: reviewerId, role: "reviewer" };
  }
  if (event.type.startsWith("artifact.review_")) {
    const evidence = payloadRecord(event.payload, "evidence");
    return { id: payloadString(evidence, "reviewerId") ?? "zentra-reviewer", role: "reviewer" };
  }
  if (event.type === "task.cleanup_reconciled") {
    return { id: "zentra-recovery-controller", role: "recovery" };
  }
  if (
    event.type.startsWith("task.integration_") ||
    event.type.startsWith("artifact.integration_") ||
    event.type.startsWith("task.cleanup_")
  ) {
    return { id: "zentra-integration-controller", role: "integrator" };
  }
  if (event.type.startsWith("artifact.validation_")) {
    return { id: "zentra-validator", role: "validator" };
  }
  if (event.type.startsWith("artifact.patch_")) {
    return { id: "zentra-artifact-store", role: "artifact_store" };
  }
  return { id: "zentra-orchestrator", role: "orchestrator" };
}

function operationName(event: StoredEvent): string {
  if (event.type.startsWith("source.") || event.type === "intake.snapshot_closed") return "source_intake";
  if (isAttentionEventType(event.type)) return "attention_decision";
  if (event.type.startsWith("service.")) return "service_startup";
  if (event.type.startsWith("preflight.")) return "run_preflight";
  if (event.type.startsWith("run.")) return "run";
  if (event.type.includes("capability_boundary_")) return "capability_boundary";
  if (event.type.startsWith("capability_envelope.")) return "capability_envelope";
  if (event.type.startsWith("web_research.")) return "web_research";
  if (event.type.startsWith("worker.")) return "worker";
  if (event.type === "milestone.plan_revised" || event.type === "milestone.replanning_resolved") return "milestone_replanning";
  if (event.type === "milestone.release_operation_bound") return "release_preparation";
  if (event.type === "milestone.paused") {
    if (ReplanningPausedPayloadSchema.safeParse(event.payload).success) return "milestone_replanning";
    const paused = MilestonePausedPayloadSchema.parse(event.payload);
    return paused.attention.reason === "release_boundary" ? "release_boundary" : "authority_boundary";
  }
  if (event.type === "release.prepared_local_only") return "release_boundary";
  if (event.type.startsWith("release.")) return "release_preparation";
  if (event.type.startsWith("routing.")) return "model_routing";
  if (isOpenCodeRoleEvent(event)) return "opencode_agent";
  const type = event.type;
  if (type === "milestone.capability_boundary_paused" || type === "task.capability_boundary_paused") return "waiting";
  if (type === "milestone.capability_boundary_resolved" || type === "task.capability_boundary_resolved") return "completed";
  if (type === "capsule.proxy_interaction_observed") return "network_policy";
  if (type.startsWith("capsule.github_broker_") || type === "capsule.github_grant_consumed") return "github_effect";
  if (type === "capsule.cleanup_observed") return "cleanup";
  if (type.startsWith("capsule.")) return "capsule";
  if (type.startsWith("milestone.")) return "milestone";
  if (type.startsWith("artifact.")) return "artifact";
  if (type === "task.effect_uncertain" || type === "task.effect_reconciled") {
    return payloadString(event.payload, "boundary") ?? "reconciliation";
  }
  if (
    type === "task.writer_completed" ||
    type === "task.started"
  ) return "writer";
  if (type === "task.denied") {
    const stage = payloadString(event.payload, "stage");
    return stage === "ownership" ? "ownership" : stage === "capability_envelope" ? "capability_envelope" : "review";
  }
  if (type.includes("validation")) return "validation";
  if (type.includes("review")) return "review";
  if (type.includes("integration")) return "integration";
  if (type.includes("cleanup")) return "cleanup";
  if (type.includes("worktree")) return "worktree";
  return "task";
}

function operationStatus(event: StoredEvent): string {
  const type = event.type;
  if (isAttentionEventType(type)) {
    if (type.endsWith(".requested") || type === "questionnaire.proposed" ||
      type === "attention.raised" || type.endsWith(".reserved") || type === "attention.index_raised") return "waiting";
    if (type.endsWith(".rejected")) return "denied";
    if (type.endsWith(".expired")) return "timed_out";
    if (type.includes("stale")) return "stale";
    if (type.includes("duplicate_attempted")) return "failed";
    return "completed";
  }
  if (type === "service.starting" || type === "preflight.started") return "running";
  if (type === "run.waiting" || type === "run.blocked" || type === "run.approval_requested") return "waiting";
  if (type === "preflight.failed" || type === "run.failed") return "failed";
  if (type === "run.cancelled") return "cancelled";
  if (type === "run.denied") return "denied";
  if (type === "run.timed_out") return "timed_out";
  if (type === "capability_envelope.accepted") return "completed";
  if (type === "web_research.observed") return payloadString(event.payload, "outcome") ?? "failed";
  if (type === "capability_envelope.evaluated") {
    return payloadString(payloadRecord(event.payload, "decision"), "status") === "allowed" ? "completed" : "waiting";
  }
  if (type === "worker.bound") return "waiting";
  if (type === "worker.started" || type === "worker.observed") return "running";
  if (type === "worker.cleanup_observed") {
    return payloadString(event.payload, "outcome") === "completed" ? "completed" : "waiting";
  }
  if (type === "worker.terminal") return payloadString(event.payload, "outcome") ?? "failed";
  if (type === "release.step_started" || type === "release.worktree_intent") return "running";
  if (type === "release.step_observed") return payloadString(event.payload, "outcome") ?? "failed";
  if (type === "release.failed") return "failed";
  if (type === "release.prepared_local_only") return "waiting";
  if (type.startsWith("release.")) return "completed";
  if (type === "routing.model_selected") return "completed";
  if (type === "routing.outcome_recorded") {
    return payloadString(event.payload, "outcome") ?? "failed";
  }
  if (isOpenCodeRoleEvent(event)) {
    return type === "milestone.task_running"
      ? "running"
      : payloadString(event.payload, "outcome") ?? "failed";
  }
  if (type === "capsule.started") return "running";
  if (type === "capsule.proxy_interaction_observed" && payloadBoolean(event.payload, "allowed") === false) return "denied";
  if (type === "capsule.check_observed" && payloadBoolean(event.payload, "passed") === false) return "failed";
  if (type === "capsule.cleanup_observed" && payloadString(event.payload, "outcome") === "uncertain") return "failed";
  if (type === "capsule.failure_observed") return payloadString(event.payload, "outcome") ?? "failed";
  if (type === "capsule.github_broker_accepted") return "running";
  if (type === "capsule.github_broker_denied") return "denied";
  if (type === "capsule.github_broker_observed") return payloadString(event.payload, "outcome") ?? "failed";
  if (type === "capsule.github_broker_reconciled") return payloadString(event.payload, "outcome") ?? "failed";
  if (type === "capsule.failed") return "failed";
  if (type === "capsule.cancelled") return "cancelled";
  if (type === "capsule.timed_out") return "timed_out";
  if (type === "milestone.task_running") return "running";
  if (type === "milestone.task_blocked" || type === "milestone.paused") return "waiting";
  if (type === "milestone.failed") return "failed";
  if (type === "milestone.cancelled") return "cancelled";
  if (type === "milestone.timed_out") return "timed_out";
  if (type === "milestone.denied") return "denied";
  if (type === "task.effect_uncertain" || type === "task.commit_observed") return "waiting";
  if (type === "task.effect_reconciled") return "completed";
  if (
    type === "task.integration_observed" &&
    payloadString(event.payload, "verification") !== "verified"
  ) return "waiting";
  if (type === "task.cleanup_observed") {
    return payloadBoolean(event.payload, "uncertain") ? "waiting" : "failed";
  }
  if (type === "task.writer_completed" || type === "task.validation_completed") {
    return payloadString(event.payload, "outcome") ?? "failed";
  }
  if (type.startsWith("milestone.") && type.endsWith("ed")) return "completed";
  if (type.endsWith("_started") || type === "task.started") return "running";
  if (type.endsWith("_requested")) return "waiting";
  if (type.endsWith("_observed") || type.endsWith("_reconciled") || type.endsWith("_approved")) {
    return "completed";
  }
  if (type.endsWith("_recorded") || type.endsWith("_prepared") || type.endsWith("_completed")) {
    return "completed";
  }
  if (type === "task.cancelled") return "cancelled";
  if (type === "task.timed_out") return "timed_out";
  if (type === "task.denied") return "denied";
  if (type === "task.failed") return "failed";
  return "completed";
}

function isOpenCodeRoleEvent(event: StoredEvent): boolean {
  return isPotentialOpenCodeRoleEvent(event) &&
    payloadString(event.payload, "harness") === "opencode" &&
    payloadString(event.payload, "actorId") !== null &&
    payloadString(event.payload, "role") !== null;
}

function isPotentialOpenCodeRoleEvent(event: StoredEvent): boolean {
  return (event.type === "milestone.task_running" || event.type === "milestone.task_completed") &&
    payloadString(event.payload, "harness") === "opencode";
}

function payloadBoolean(payload: unknown, key: string): boolean | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Readonly<Record<string, unknown>>)[key];
  return typeof value === "boolean" ? value : null;
}

function payloadString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Readonly<Record<string, unknown>>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function payloadRecord(payload: unknown, key: string): Readonly<Record<string, unknown>> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Readonly<Record<string, unknown>>)[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function cloneJson(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Agent Tail payload must be JSON-serializable");
  return JSON.parse(serialized) as unknown;
}

function redactedReleasePayload(type: string, payload: unknown): unknown {
  const parsed = parseReleaseEventPayload(type, payload);
  if (type === "release.created") {
    const created = parsed as { readonly schemaVersion: number; readonly packetDigest: string; readonly packet: Readonly<Record<string, unknown>> };
    const packet = created.packet;
    const commands = packet["commands"] as Readonly<Record<string, unknown>>;
    return Object.freeze({
      schemaVersion: created.schemaVersion,
      packetDigest: created.packetDigest,
      releaseId: packet["releaseId"], milestoneId: packet["milestoneId"], taskId: packet["taskId"],
      projectId: packet["projectId"], resultCommit: packet["resultCommit"], integrationRef: packet["integrationRef"],
      securityDigest: packet["securityDigest"], authorityDigest: packet["authorityDigest"],
      verifierAdmissionDigest: packet["verifierAdmissionDigest"],
      commandsDigest: digestCanonical(commands),
      artifactManifestDigest: digestCanonical(packet["artifacts"]),
      artifactCount: Array.isArray(packet["artifacts"]) ? packet["artifacts"].length : 0,
    });
  }
  if (type === "release.worktree_intent") {
    const intent = parsed as Readonly<Record<string, unknown>>;
    return Object.freeze({ schemaVersion: intent["schemaVersion"], resultCommit: intent["resultCommit"], pathDigest: digestCanonical(intent["path"]) });
  }
  if (type === "release.environment_intent") {
    const intent = parsed as Readonly<Record<string, unknown>>;
    return Object.freeze({ schemaVersion: intent["schemaVersion"], environmentPathsDigest: digestCanonical([intent["home"], intent["temporary"]]) });
  }
  if (type === "release.artifact_hashed") {
    const artifact = parsed as Readonly<Record<string, unknown>>;
    return Object.freeze({
      schemaVersion: artifact["schemaVersion"], pathDigest: digestCanonical(artifact["path"]),
      size: artifact["size"], sha256: artifact["sha256"],
    });
  }
  if (type !== "release.step_observed") return parsed;
  const report = parsed as Readonly<Record<string, unknown>>;
  return Object.freeze({
    schemaVersion: report["schemaVersion"],
    name: report["name"],
    argvSha256: report["argvSha256"],
    outcome: report["outcome"],
    exitCode: report["exitCode"],
    outputSha256: report["outputSha256"],
  });
}

function redactedReleaseTaskCompletionPayload(payload: unknown): unknown {
  const parsed = ReleaseMilestoneTaskCompletedPayloadSchema.parse(payload);
  return Object.freeze({
    taskId: parsed.taskId,
    actorId: parsed.actorId,
    role: parsed.role,
    outcome: parsed.outcome,
    evidence: Object.freeze({
      ...parsed.evidence,
      artifacts: parsed.evidence.artifacts.map((artifact) => Object.freeze({ ...artifact })),
    }),
  });
}

function isPotentialReleaseTaskCompletion(event: StoredEvent): boolean {
  if (event.type !== "milestone.task_completed") return false;
  const evidence = payloadRecord(event.payload, "evidence");
  return payloadString(evidence, "releaseStreamId") !== null;
}

function chosenModelAttributes(type: string, payload: unknown): object {
  if (type !== "routing.model_selected" || typeof payload !== "object" || payload === null) return {};
  const selection = payload as {
    readonly model: { capabilityId: string; harness: string; transportModelSha256: string };
    readonly role: string;
    readonly taskType: string;
    readonly basis: string;
    readonly modelSheetSha256: string;
  };
  return {
    chosen_model: Object.freeze({
      capability_id: selection.model.capabilityId,
      harness: selection.model.harness,
      transport_model_sha256: selection.model.transportModelSha256,
      role: selection.role,
      task_type: selection.taskType,
      basis: selection.basis,
      model_sheet_sha256: selection.modelSheetSha256,
    }),
  };
}

function parseMilestonePausedPayload(payload: unknown) {
  const authority = MilestonePausedPayloadSchema.safeParse(payload);
  if (authority.success) return authority.data;
  return ReplanningPausedPayloadSchema.parse(payload);
}

function redactedRevisionPayload(payload: unknown): unknown {
  const revision = PlanRevisionPayloadSchema.parse(payload);
  return Object.freeze({
    schemaVersion: revision.schemaVersion,
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    milestoneId: revision.milestoneId,
    projectId: revision.projectId,
    priorPlanDigest: revision.priorPlanDigest,
    revisedPlanDigest: revision.revisedPlanDigest,
    authorityEnvelopeDigest: revision.authorityEnvelopeDigest,
    securityDigest: revision.securityDigest,
    modelSheetDigest: revision.modelSheetDigest,
    requestedBy: revision.requestedBy,
    priorEvidence: revision.priorEvidence,
    supersessions: revision.supersessions,
  });
}

function redactedPolicyPayload(payload: unknown): unknown {
  const { policy } = ReplanningPolicyBoundPayloadSchema.parse(payload);
  return Object.freeze({
    schemaVersion: policy.schemaVersion,
    milestoneId: policy.milestoneId,
    projectId: policy.projectId,
    securityDigest: policy.securityDigest,
    networkDigest: policy.networkDigest,
    modelSheetDigest: policy.modelSheetDigest,
    releaseBoundary: policy.security.releaseBoundary,
    allowedRepositoryCount: policy.security.allowedRepositoryCount,
    allowedFileScopeCount: policy.security.allowedFileScopeCount,
    forbiddenPathCount: policy.security.forbiddenPathCount,
    allowedDestinationCount: policy.security.network.allowedDestinationCount,
    secretHandlingRuleCount: policy.security.secretHandlingRuleCount,
    approvalRequiredOperations: policy.security.approvalRequiredOperations,
    stopAndAskConditions: policy.security.stopAndAskConditions,
    modelCount: policy.modelSheet?.models.length ?? 0,
  });
}

function redactedEnvelopePayload(payload: unknown): unknown {
  const { envelope } = MilestoneAuthorityEnvelopePayloadSchema.parse(payload);
  return Object.freeze({
    schemaVersion: envelope.schemaVersion,
    milestoneId: envelope.milestoneId,
    projectId: envelope.projectId,
    envelopeDigest: digestCanonical(envelope),
    baselinePlanDigest: envelope.baselinePlanDigest,
    goalDigest: envelope.goalDigest,
    securityDigest: envelope.securityDigest,
    networkDigest: envelope.networkDigest,
    modelSheetDigest: envelope.modelSheetDigest,
    releaseBoundary: envelope.releaseBoundary,
    ownedScopeCount: envelope.aggregateOwnedPaths.length,
    forbiddenScopeCount: envelope.forbiddenPaths.length,
    authorityCategoryCount: envelope.authorityCategories.length,
    roleBoundaryCount: envelope.roleBoundaries.length,
    capabilityCount: envelope.capabilities.length,
  });
}

function redactedRoleCapabilityPayload(type: string, payload: unknown): unknown {
  const parsed = parseRoleCapabilityEventPayload(type, payload) as Readonly<Record<string, unknown>>;
  if (type === "capability_envelope.evaluated") {
    const decision = parsed["decision"] as Readonly<Record<string, unknown>>;
    return Object.freeze({
      bindingDigest: parsed["bindingDigest"],
      requestDigest: decision["requestDigest"],
      decisionId: decision["decisionId"],
      status: decision["status"],
      reason: decision["reason"],
      effectPerformed: decision["effectPerformed"],
    });
  }
  const binding = (parsed["binding"] as Readonly<Record<string, unknown>>);
  const access = binding["access"] as { readonly readPaths: readonly unknown[]; readonly writePaths: readonly unknown[]; readonly forbiddenPaths: readonly unknown[] };
  const envelope = binding["envelope"] as Readonly<Record<string, unknown>>;
  return Object.freeze({
    schemaVersion: binding["schemaVersion"],
    milestoneId: binding["milestoneId"],
    taskId: binding["taskId"],
    projectId: binding["projectId"],
    role: binding["role"],
    actorId: binding["actorId"],
    bindingDigest: binding["digest"],
    envelopeDigest: envelope["digest"],
    planDigest: binding["planDigest"],
    securityDigest: binding["securityDigest"],
    modelDigest: binding["modelDigest"],
    repositoryDigest: binding["repositoryDigest"],
    ownershipDigest: binding["ownershipDigest"],
    budgetDigest: binding["budgetDigest"],
    admissionDigest: binding["admissionDigest"],
    providerTransport: binding["providerTransport"],
    readScopeCount: access.readPaths.length,
    writeScopeCount: access.writePaths.length,
    forbiddenScopeCount: access.forbiddenPaths.length,
    reviewEvidenceBound: binding["review"] !== null,
    researchPolicyDigest: (binding["webResearch"] as Readonly<Record<string, unknown>> | null)?.["digest"] ?? null,
    researchDestinationCount: Array.isArray((binding["webResearch"] as Readonly<Record<string, unknown>> | null)?.["destinations"])
      ? ((binding["webResearch"] as Readonly<Record<string, unknown>>)["destinations"] as readonly unknown[]).length : 0,
  });
}

function redactedWebResearchPayload(type: string, payload: unknown): unknown {
  const parsed = parseWebResearchEventPayload(type, payload) as Readonly<Record<string, unknown>>;
  const evidence = parsed["evidence"] as Readonly<Record<string, unknown> | null>;
  if (evidence === null) return Object.freeze({
    requestId: parsed["requestId"], requestDigest: parsed["requestDigest"], eventDigest: parsed["eventDigest"],
    outcome: parsed["outcome"], reason: parsed["reason"], elapsedMs: parsed["elapsedMs"],
    identity: parsed["identity"], usage: parsed["usage"], evidence: null,
  });
  const source = new URL(evidence["sourceUrl"] as string);
  return Object.freeze({
    requestId: parsed["requestId"], requestDigest: parsed["requestDigest"], eventDigest: parsed["eventDigest"],
    outcome: parsed["outcome"], reason: parsed["reason"], elapsedMs: parsed["elapsedMs"],
    identity: parsed["identity"], usage: parsed["usage"],
    evidence: Object.freeze({
       evidenceId: evidence["evidenceId"], sourceHost: source.hostname,
       sourcePathDigest: digestCanonical(source.pathname), method: evidence["method"], status: evidence["status"], contentType: evidence["contentType"],
      contentSha256: evidence["contentSha256"], compressedBytes: evidence["compressedBytes"],
      decompressedBytes: evidence["decompressedBytes"], retrievedAt: evidence["retrievedAt"],
      parent: evidence["parent"], envelopeDigest: evidence["envelopeDigest"], policyDigest: evidence["policyDigest"],
      provenance: evidence["provenance"],
    }),
  });
}

function redactedWorkerPayload(type: string, payload: unknown): unknown {
  const parsed = parseWorkerEventPayload(type, payload);
  if (type !== "worker.bound") return parsed;
  const binding = parsed as WorkerBinding;
  return Object.freeze({
    ...binding,
    envelope: Object.freeze({
      digest: binding.envelope.digest,
      role: binding.envelope.role,
      authority: binding.envelope.authority,
      repository: binding.envelope.resources.repository,
      readScopeCount: envelopeReadPaths(binding.envelope).length,
      writeScopeCount: envelopeWritePaths(binding.envelope).length,
      forbiddenScopeCount: binding.envelope.resources.forbiddenPaths.length,
      capabilityDigest: digestCanonical(binding.envelope.capabilities),
      effectDigest: digestCanonical(binding.envelope.effects),
    }),
  });
}

function redactedOpenCodeMilestonePayload(type: string, payload: unknown): unknown {
  const parsed = parseOpenCodeMilestonePayload(type, payload) as Readonly<Record<string, unknown>>;
  if (type === "milestone.task_running") {
    const requestedModel = parsed["requestedModel"] as Readonly<Record<string, unknown>>;
    const budget = parsed["budget"] as Readonly<Record<string, unknown>>;
    const boundary = parsed["securityBoundary"] as Readonly<Record<string, unknown>>;
    const readableScopes = boundary["readableScopes"] as readonly unknown[];
    const forbiddenPaths = boundary["forbiddenPaths"] as readonly unknown[];
    return Object.freeze({
      taskId: parsed["taskId"],
      capsuleId: parsed["capsuleId"],
      actorId: parsed["actorId"],
      role: parsed["role"],
      harness: parsed["harness"],
      requestedModel: Object.freeze({
        capabilityId: requestedModel["capabilityId"],
        transportModelId: requestedModel["transportModelId"],
      }),
      budget: Object.freeze({
        maxSeconds: budget["maxSeconds"],
        maxCostUsd: budget["maxCostUsd"],
        maxInputTokens: budget["maxInputTokens"],
        maxOutputTokens: budget["maxOutputTokens"],
      }),
      timeoutMs: parsed["timeoutMs"],
      securityBoundary: Object.freeze({
        repository: boundary["repository"],
        scratch: boundary["scratch"],
        network: boundary["network"],
        home: boundary["home"],
        credentials: boundary["credentials"],
        shell: boundary["shell"],
        repositoryRevision: boundary["repositoryRevision"],
        readableScopeCount: readableScopes.length,
        readableScopesDigest: digestCanonical(readableScopes),
        forbiddenPathCount: forbiddenPaths.length,
        forbiddenPathsDigest: digestCanonical(forbiddenPaths),
      }),
    });
  }
  const measuredHarness = parsed["measuredHarness"] as Readonly<Record<string, unknown>> | null;
  const model = parsed["model"] as Readonly<Record<string, unknown>> | null;
  const evidence = parsed["evidence"] as readonly Readonly<Record<string, unknown>>[];
  return Object.freeze({
    taskId: parsed["taskId"],
    capsuleId: parsed["capsuleId"],
    outcome: parsed["outcome"],
    actorId: parsed["actorId"],
    role: parsed["role"],
    harness: parsed["harness"],
    capabilityId: parsed["capabilityId"],
    transportModelId: parsed["transportModelId"],
    measuredHarness: measuredHarness === null ? null : Object.freeze({
      version: measuredHarness["version"],
      executableSha256: measuredHarness["executableSha256"],
    }),
    model: model === null ? null : Object.freeze({
      id: model["id"],
      provider: model["provider"],
      configurationDigest: model["configurationDigest"] ?? null,
    }),
    evidenceCount: evidence.length,
    evidence: evidence.map((item) => {
      const provenance = item["provenance"] as Readonly<Record<string, unknown>>;
      const sourceEvidenceIds = (item["sourceEvidenceIds"] as readonly unknown[] | undefined) ?? [];
      return Object.freeze({
        kind: item["kind"],
        sha256: item["sha256"],
        sourceEvidenceCount: sourceEvidenceIds.length,
        sourceEvidenceIds,
        provenance: Object.freeze({
          harness: provenance["harness"],
          capabilityId: provenance["capabilityId"],
          transportModelId: provenance["transportModelId"],
          repositoryRevision: provenance["repositoryRevision"],
          providerConfigurationDigest: provenance["providerConfigurationDigest"] ?? null,
        }),
      });
    }),
    cleanup: parsed["cleanup"],
    brokerTransport: parsed["brokerTransport"],
    brokerFailureReason: parsed["brokerFailureReason"],
    brokerFailureTool: parsed["brokerFailureTool"] ?? null,
  });
}

function redactedCapabilityBoundaryPayload(payload: unknown): unknown {
  const parsed = CapabilityBoundaryPausedPayloadSchema.parse(payload);
  return Object.freeze({
    occurrence: parsed.occurrence,
    evidenceDigest: digestCanonical(parsed.evidence),
  });
}
