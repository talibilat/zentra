import { z } from "zod";

import {
  AgentTrailEvidenceSchema,
  replayAgentTrailEvidence,
  type AgentTrailEvidence,
} from "../agenttrail/agenttrail-events.js";
import type { StoredEvent } from "../contracts/event.js";
import type { EventJournal } from "../journal/journal.js";
import {
  SERVICE_ATTENTION_SCHEMA_VERSION,
  ServiceCriticalAttentionPayloadSchema,
  type ServiceAttentionEvidence,
} from "./service-attention.js";

export const GATEWAY_EVENT_SCHEMA_VERSION = 1;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ProcessIncarnationSchema = z.string().regex(/^process-v2:[a-f0-9]{64}$/);
const AgentTrailIncarnationSchema = z.string().regex(
  /^agenttrail-v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const IdSchema = z.string().min(1).max(256).refine((value) => !/[\u0000\r\n]/.test(value));
const TargetSchema = z.strictObject({
  strategy: z.literal("journal_projection_high_water"),
  throughPosition: z.number().int().positive(),
});

const BaseSchema = z.strictObject({
  schemaVersion: z.literal(GATEWAY_EVENT_SCHEMA_VERSION),
  serviceId: IdSchema,
  processIncarnation: ProcessIncarnationSchema,
  tracePathSha256: Sha256Schema,
  occurredAt: z.iso.datetime({ offset: true }),
});

export const GatewayDegradedPayloadSchema = BaseSchema.extend({
  agentTrailIncarnation: AgentTrailIncarnationSchema,
  agentTrailFailureEventId: IdSchema,
  reason: z.literal("agenttrail_unavailable"),
}).strict();

export const GatewayBackfillTargetPayloadSchema = BaseSchema.extend({
  failedAgentTrailIncarnation: AgentTrailIncarnationSchema,
  replacementAgentTrailIncarnation: AgentTrailIncarnationSchema,
  agentTrailStartingEventId: IdSchema,
  target: TargetSchema,
}).strict();

export const GatewayRecoveredPayloadSchema = BaseSchema.extend({
  failedAgentTrailIncarnation: AgentTrailIncarnationSchema,
  readyAgentTrailIncarnation: AgentTrailIncarnationSchema,
  agentTrailReadyEventId: IdSchema,
  target: TargetSchema,
}).strict();

export interface GatewayLifecycleIdentity {
  readonly serviceId: string;
  readonly processIncarnation: string;
  readonly correlationId: string;
  readonly agentTrailStreamId: string;
  readonly serviceStartingEventId: string;
}

export type GatewayLifecycleEvidence =
  | ({ readonly type: "gateway.degraded" } & z.infer<typeof GatewayDegradedPayloadSchema>)
  | ({ readonly type: "gateway.backfill_target" } & z.infer<typeof GatewayBackfillTargetPayloadSchema>)
  | ({ readonly type: "gateway.recovered" } & z.infer<typeof GatewayRecoveredPayloadSchema>)
  | ServiceAttentionEvidence;

export class GatewayLifecycleService {
  readonly streamId: string;

  constructor(
    private readonly journal: EventJournal,
    private readonly identity: GatewayLifecycleIdentity,
  ) {
    this.streamId = `gateway:${ProcessIncarnationSchema.parse(identity.processIncarnation)}`;
    validateIdentity(identity);
    replayGatewayLifecycle(journal, this.streamId, identity);
  }

  degradeAndRaiseCritical(input: Omit<z.input<typeof GatewayDegradedPayloadSchema>, "schemaVersion" | "serviceId" | "processIncarnation" | "reason"> & {
    readonly attentionId: string;
  }): readonly [StoredEvent, StoredEvent] {
    replayGatewayLifecycle(this.journal, this.streamId, this.identity);
    requireAgentTrailReference(
      this.journal,
      this.identity,
      input.agentTrailFailureEventId,
      "agenttrail.failed",
      input.agentTrailIncarnation,
      (evidence) => evidence.phase === "runtime",
      "runtime failure event",
    );
    const payload = GatewayDegradedPayloadSchema.parse({
      schemaVersion: GATEWAY_EVENT_SCHEMA_VERSION,
      serviceId: this.identity.serviceId,
      processIncarnation: this.identity.processIncarnation,
      reason: "agenttrail_unavailable",
      agentTrailIncarnation: input.agentTrailIncarnation,
      agentTrailFailureEventId: input.agentTrailFailureEventId,
      tracePathSha256: input.tracePathSha256,
      occurredAt: input.occurredAt,
    });
    const attention = ServiceCriticalAttentionPayloadSchema.parse({
      schemaVersion: SERVICE_ATTENTION_SCHEMA_VERSION,
      attentionId: input.attentionId,
      serviceId: this.identity.serviceId,
      processIncarnation: this.identity.processIncarnation,
      source: "agenttrail",
      classification: "critical",
      agentTrailStreamId: this.identity.agentTrailStreamId,
      agentTrailIncarnation: input.agentTrailIncarnation,
      agentTrailFailureEventId: input.agentTrailFailureEventId,
      authority: "none",
      occurredAt: input.occurredAt,
    });
    const stored = this.journal.readStream(this.streamId);
    const existingAttentionIndex = stored.findIndex((event) => event.type === "service.critical_attention" &&
      ServiceCriticalAttentionPayloadSchema.parse(event.payload).agentTrailIncarnation === input.agentTrailIncarnation);
    if (existingAttentionIndex >= 1) {
      const existing = [stored[existingAttentionIndex - 1]!, stored[existingAttentionIndex]!] as const;
      if (existing[0].type === "gateway.degraded" && JSON.stringify(existing[0].payload) === JSON.stringify(payload) &&
        JSON.stringify(existing[1].payload) === JSON.stringify(attention) &&
        existing.every((event) => event.causationId === input.agentTrailFailureEventId)) return existing;
      throw new Error("critical AgentTrail degradation already exists with different evidence");
    }
    const appended = this.journal.append(this.streamId, stored.at(-1)?.streamVersion ?? 0, [{
      streamId: this.streamId,
      type: "gateway.degraded",
      payload,
      causationId: input.agentTrailFailureEventId,
      correlationId: this.identity.correlationId,
    }, {
      streamId: this.streamId,
      type: "service.critical_attention",
      payload: attention,
      causationId: input.agentTrailFailureEventId,
      correlationId: this.identity.correlationId,
    }]);
    return [appended[0]!, appended[1]!];
  }

  targetBackfill(input: Omit<z.input<typeof GatewayBackfillTargetPayloadSchema>, "schemaVersion" | "serviceId" | "processIncarnation">): StoredEvent {
    const history = replayGatewayLifecycle(this.journal, this.streamId, this.identity);
    const critical = history.at(-1);
    const degraded = history.at(-2);
    if (critical?.type !== "service.critical_attention" || degraded?.type !== "gateway.degraded") {
      throw new Error("gateway backfill target requires durable degraded evidence");
    }
    if (degraded.agentTrailIncarnation !== input.failedAgentTrailIncarnation ||
      input.failedAgentTrailIncarnation === input.replacementAgentTrailIncarnation) {
      throw new Error("gateway backfill target references the wrong AgentTrail incarnation");
    }
    const starting = requireAgentTrailReference(
      this.journal,
      this.identity,
      input.agentTrailStartingEventId,
      "agenttrail.starting",
      input.replacementAgentTrailIncarnation,
      undefined,
      "replacement starting event",
    );
    const failed = requireStoredEvent(this.journal, this.identity.agentTrailStreamId, degraded.agentTrailFailureEventId);
    if (starting.stored.globalPosition <= failed.globalPosition) {
      throw new Error("replacement AgentTrail starting intent does not follow its failure");
    }
    if (input.target.throughPosition !== starting.stored.globalPosition) {
      throw new Error("gateway backfill target does not equal its AgentTrail starting global position");
    }
    const payload = GatewayBackfillTargetPayloadSchema.parse({
      schemaVersion: GATEWAY_EVENT_SCHEMA_VERSION,
      serviceId: this.identity.serviceId,
      processIncarnation: this.identity.processIncarnation,
      ...input,
    });
    const degradation = this.journal.readStream(this.streamId).findLast((event) =>
      event.type === "gateway.degraded" &&
      GatewayDegradedPayloadSchema.parse(event.payload).agentTrailIncarnation === degraded.agentTrailIncarnation);
    if (degradation === undefined) throw new Error("durable gateway degradation event is missing");
    return this.append("gateway.backfill_target", payload, degradation.eventId);
  }

  recovered(input: Omit<z.input<typeof GatewayRecoveredPayloadSchema>, "schemaVersion" | "serviceId" | "processIncarnation">): StoredEvent {
    const history = replayGatewayLifecycle(this.journal, this.streamId, this.identity);
    const target = history.at(-1);
    if (target?.type !== "gateway.backfill_target") {
      throw new Error("gateway recovery requires a durable exact backfill target");
    }
    if (
      target.failedAgentTrailIncarnation !== input.failedAgentTrailIncarnation ||
      target.replacementAgentTrailIncarnation !== input.readyAgentTrailIncarnation ||
      target.tracePathSha256 !== input.tracePathSha256 ||
      JSON.stringify(target.target) !== JSON.stringify(input.target)
    ) {
      throw new Error("gateway recovery does not match its exact backfill target");
    }
    const ready = requireAgentTrailReference(
      this.journal,
      this.identity,
      input.agentTrailReadyEventId,
      "agenttrail.ready",
      input.readyAgentTrailIncarnation,
      undefined,
      "replacement ready event",
    );
    const starting = requireStoredEvent(this.journal, this.identity.agentTrailStreamId, target.agentTrailStartingEventId);
    if (ready.stored.globalPosition <= starting.globalPosition) {
      throw new Error("replacement AgentTrail ready evidence does not follow its starting intent");
    }
    const payload = GatewayRecoveredPayloadSchema.parse({
      schemaVersion: GATEWAY_EVENT_SCHEMA_VERSION,
      serviceId: this.identity.serviceId,
      processIncarnation: this.identity.processIncarnation,
      ...input,
    });
    return this.append("gateway.recovered", payload, this.lastGatewayEvent().eventId);
  }

  private append(type: GatewayLifecycleEvidence["type"], payload: object, causationId: string): StoredEvent {
    const history = this.journal.readStream(this.streamId);
    return this.journal.append(this.streamId, history.at(-1)?.streamVersion ?? 0, [{
      streamId: this.streamId,
      type,
      payload,
      causationId,
      correlationId: this.identity.correlationId,
    }])[0]!;
  }

  private lastGatewayEvent(): StoredEvent {
    const event = this.journal.readStream(this.streamId).at(-1);
    if (event === undefined) throw new Error("gateway lifecycle has no durable event");
    return event;
  }
}

export function replayGatewayLifecycle(
  journal: EventJournal,
  streamId: string,
  identity: GatewayLifecycleIdentity,
): readonly GatewayLifecycleEvidence[] {
  validateIdentity(identity);
  replayAgentTrailEvidence(journal, identity.agentTrailStreamId, {
    correlationId: identity.correlationId,
    causationId: identity.serviceStartingEventId,
  });
  const stored = journal.readStream(streamId);
  const result: GatewayLifecycleEvidence[] = [];
  let state: "ready" | "degraded_pending_attention" | "degraded" | "targeted" = "ready";
  for (const [index, event] of stored.entries()) {
    if (event.correlationId !== identity.correlationId) throw new Error("gateway lifecycle correlation identity changed");
    if (event.type === "gateway.degraded") {
      const payload = GatewayDegradedPayloadSchema.parse(event.payload);
      assertExpectedIdentity(payload, identity);
      const prior = result.at(-1);
      if (state !== "ready" && !(state === "targeted" && prior?.type === "gateway.backfill_target" &&
        prior.replacementAgentTrailIncarnation === payload.agentTrailIncarnation)) {
        throw new Error("gateway has duplicate degraded evidence");
      }
      requireAgentTrailReference(journal, identity, payload.agentTrailFailureEventId, "agenttrail.failed",
        payload.agentTrailIncarnation, (evidence) => evidence.phase === "runtime", "runtime failure event");
      if (event.causationId !== payload.agentTrailFailureEventId) throw new Error("gateway degradation causation is invalid");
      state = "degraded_pending_attention";
      result.push({ type: "gateway.degraded", ...payload });
      continue;
    }
    if (event.type === "service.critical_attention") {
      const payload = ServiceCriticalAttentionPayloadSchema.parse(event.payload);
      const degraded = result.at(-1);
      if (state !== "degraded_pending_attention" || degraded?.type !== "gateway.degraded" ||
        payload.serviceId !== identity.serviceId || payload.processIncarnation !== identity.processIncarnation ||
        payload.agentTrailStreamId !== identity.agentTrailStreamId ||
        payload.agentTrailIncarnation !== degraded.agentTrailIncarnation ||
        payload.agentTrailFailureEventId !== degraded.agentTrailFailureEventId) {
        throw new Error("service critical attention does not match its atomic gateway degradation");
      }
      requireAgentTrailReference(journal, identity, payload.agentTrailFailureEventId, "agenttrail.failed",
        payload.agentTrailIncarnation, (evidence) => evidence.phase === "runtime", "runtime failure event");
      if (event.causationId !== payload.agentTrailFailureEventId) {
        throw new Error("service critical attention causation is invalid");
      }
      state = "degraded";
      result.push({ type: "service.critical_attention", ...payload });
      continue;
    }
    if (event.type === "gateway.backfill_target") {
      const payload = GatewayBackfillTargetPayloadSchema.parse(event.payload);
      assertExpectedIdentity(payload, identity);
      const critical = result.at(-1);
      const prior = result.at(-2);
      if (state !== "degraded" || critical?.type !== "service.critical_attention" ||
        prior?.type !== "gateway.degraded" || prior.agentTrailIncarnation !== payload.failedAgentTrailIncarnation) {
        throw new Error("gateway backfill target is not preceded by its degradation");
      }
      const starting = requireAgentTrailReference(journal, identity, payload.agentTrailStartingEventId, "agenttrail.starting",
        payload.replacementAgentTrailIncarnation, undefined, "replacement starting event");
      if (payload.target.throughPosition !== starting.stored.globalPosition) {
        throw new Error("gateway replay target does not match starting global position");
      }
      if (event.causationId !== stored[index - 2]!.eventId) throw new Error("gateway target causation chain is broken");
      state = "targeted";
      result.push({ type: "gateway.backfill_target", ...payload });
      continue;
    }
    if (event.type === "gateway.recovered") {
      const payload = GatewayRecoveredPayloadSchema.parse(event.payload);
      assertExpectedIdentity(payload, identity);
      const target = result.at(-1);
      if (state !== "targeted" || target?.type !== "gateway.backfill_target" ||
        target.failedAgentTrailIncarnation !== payload.failedAgentTrailIncarnation ||
        target.replacementAgentTrailIncarnation !== payload.readyAgentTrailIncarnation ||
        target.tracePathSha256 !== payload.tracePathSha256 ||
        JSON.stringify(target.target) !== JSON.stringify(payload.target)) {
        throw new Error("gateway recovery does not match its durable target");
      }
      requireAgentTrailReference(journal, identity, payload.agentTrailReadyEventId, "agenttrail.ready",
        payload.readyAgentTrailIncarnation, undefined, "replacement ready event");
      if (event.causationId !== stored[index - 1]!.eventId) throw new Error("gateway recovery causation chain is broken");
      state = "ready";
      result.push({ type: "gateway.recovered", ...payload });
      continue;
    }
    throw new Error("unknown gateway lifecycle event");
  }
  if (state === "degraded_pending_attention") {
    throw new Error("gateway degradation is missing its atomic critical attention");
  }
  return result;
}

export function requireAgentTrailReference<T extends AgentTrailEvidence["type"]>(
  journal: EventJournal,
  identity: Pick<GatewayLifecycleIdentity, "agentTrailStreamId" | "correlationId" | "serviceStartingEventId">,
  eventId: string,
  type: T,
  incarnation: string,
  predicate: ((evidence: Extract<AgentTrailEvidence, { type: T }>) => boolean) | undefined,
  label: string,
): { readonly stored: StoredEvent; readonly evidence: Extract<AgentTrailEvidence, { type: T }> } {
  replayAgentTrailEvidence(journal, identity.agentTrailStreamId, {
    correlationId: identity.correlationId,
    causationId: identity.serviceStartingEventId,
  });
  const stored = requireStoredEvent(journal, identity.agentTrailStreamId, eventId);
  if (stored.correlationId !== identity.correlationId || stored.type !== type) {
    throw new Error(`AgentTrail ${label} has the wrong type or correlation`);
  }
  const evidence = AgentTrailEvidenceSchema.parse({ type: stored.type, ...payloadRecord(stored.payload) });
  if (evidence.type !== type || evidence.incarnation !== incarnation ||
    (predicate !== undefined && !predicate(evidence as Extract<AgentTrailEvidence, { type: T }>))) {
    throw new Error(`AgentTrail ${label} has the wrong incarnation or lifecycle phase`);
  }
  return { stored, evidence: evidence as Extract<AgentTrailEvidence, { type: T }> };
}

function requireStoredEvent(journal: EventJournal, streamId: string, eventId: string): StoredEvent {
  const event = journal.readStream(streamId).find((candidate) => candidate.eventId === eventId);
  if (event === undefined) throw new Error("referenced AgentTrail event does not exist in the required stream");
  return event;
}

function validateIdentity(identity: GatewayLifecycleIdentity): void {
  IdSchema.parse(identity.serviceId);
  ProcessIncarnationSchema.parse(identity.processIncarnation);
  IdSchema.parse(identity.correlationId);
  IdSchema.parse(identity.agentTrailStreamId);
  IdSchema.parse(identity.serviceStartingEventId);
}

function assertExpectedIdentity(
  payload: { readonly serviceId: string; readonly processIncarnation: string },
  identity: GatewayLifecycleIdentity,
): void {
  if (payload.serviceId !== identity.serviceId || payload.processIncarnation !== identity.processIncarnation) {
    throw new Error("gateway lifecycle service identity changed");
  }
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("AgentTrail referenced event payload must be an object");
  }
  return payload as Record<string, unknown>;
}
