import type { StoredEvent } from "../contracts/event.js";
import { parseCapsuleEventPayload } from "../capsule/capsule-events.js";

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
  const payload = event.type.startsWith("capsule.")
    ? parseCapsuleEventPayload(event.type, event.payload)
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
      name: operationName(event.type),
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
  if (event.type.startsWith("milestone.")) return `milestone:${event.streamId}`;
  if (event.type.startsWith("capsule.")) return `capsule:${event.streamId}`;
  return `task:${event.streamId}`;
}

function actorFor(event: StoredEvent): AgentTailActor {
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
  if (event.type === "task.started") {
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

function operationName(type: string): string {
  if (type === "capsule.proxy_interaction_observed") return "network_policy";
  if (type.startsWith("capsule.github_broker_") || type === "capsule.github_grant_consumed") return "github_effect";
  if (type === "capsule.cleanup_observed") return "cleanup";
  if (type.startsWith("capsule.")) return "capsule";
  if (type.startsWith("milestone.")) return "milestone";
  if (type.startsWith("artifact.")) return "artifact";
  if (type === "task.denied") return "review";
  if (type.includes("validation")) return "validation";
  if (type.includes("review")) return "review";
  if (type.includes("integration")) return "integration";
  if (type.includes("cleanup")) return "cleanup";
  if (type.includes("worktree")) return "worktree";
  return "task";
}

function operationStatus(event: StoredEvent): string {
  const type = event.type;
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
