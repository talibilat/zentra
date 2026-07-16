import type { StoredEvent } from "../contracts/event.js";
import { parseCapsuleEventPayload } from "../capsule/capsule-events.js";
import { parseOpenCodeMilestonePayload } from "../agents/opencode-agent-events.js";
import { MilestonePausedPayloadSchema } from "../contracts/authority-attention.js";
import { parseRoutingEventPayload } from "../routing/routing-events.js";
import { MilestoneAuthorityEnvelopePayloadSchema, PlanRevisionPayloadSchema, ReplanningPausedPayloadSchema, ReplanningPolicyBoundPayloadSchema, ReplanningResolutionPayloadSchema } from "../contracts/replanning.js";
import { digestCanonical } from "../contracts/authority-attention.js";

export const AGENT_TAIL_SCHEMA_VERSION = "1.0";
export const AGENT_TAIL_JOURNAL_EMITTER_ID = "zentra:event-journal";

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
  const payload = event.type === "milestone.paused"
    ? parseMilestonePausedPayload(event.payload)
    : event.type === "milestone.plan_revised"
      ? redactedRevisionPayload(event.payload)
    : event.type === "milestone.replanning_resolved"
      ? ReplanningResolutionPayloadSchema.parse(event.payload)
    : event.type === "milestone.replanning_policy_bound"
      ? redactedPolicyPayload(event.payload)
    : event.type === "milestone.authority_envelope_established"
      ? redactedEnvelopePayload(event.payload)
    : event.type.startsWith("capsule.")
    ? parseCapsuleEventPayload(event.type, event.payload)
    : event.type.startsWith("routing.")
      ? parseRoutingEventPayload(event.type, event.payload)
    : isPotentialOpenCodeRoleEvent(event)
      ? parseOpenCodeMilestonePayload(event.type, event.payload)
      : event.payload;
  return Object.freeze({
    schema_version: AGENT_TAIL_SCHEMA_VERSION,
    event_id: event.eventId,
    trace_id: event.correlationId,
    span_id: spanIdFor(event),
    parent_span_id: null,
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

export function agentTailEventToJsonLine(event: AgentTailEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function assertAgentTailCompatibleEvent(event: StoredEvent): void {
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

function spanIdFor(event: StoredEvent): string {
  if (event.type.startsWith("routing.")) return `routing:${event.streamId}`;
  if (event.type.startsWith("milestone.")) return `milestone:${event.streamId}`;
  if (event.type.startsWith("capsule.")) return `capsule:${event.streamId}`;
  return `task:${event.streamId}`;
}

function actorFor(event: StoredEvent): AgentTailActor {
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
    if (event.type.includes("task_")) return { id: "zentra-scheduler", role: "scheduler" };
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
  if (event.type === "milestone.plan_revised" || event.type === "milestone.replanning_resolved") return "milestone_replanning";
  if (event.type === "milestone.paused") {
    return ReplanningPausedPayloadSchema.safeParse(event.payload).success ? "milestone_replanning" : "authority_boundary";
  }
  if (event.type.startsWith("routing.")) return "model_routing";
  if (isOpenCodeRoleEvent(event)) return "opencode_agent";
  const type = event.type;
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
    return payloadString(event.payload, "stage") === "ownership" ? "ownership" : "review";
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
    (payloadString(event.payload, "harness") === "opencode" || payloadString(event.payload, "actorId") !== null);
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
