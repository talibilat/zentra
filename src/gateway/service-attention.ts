import { z } from "zod";

import type { EventJournal } from "../journal/journal.js";
import {
  requireAgentTrailReference,
  type GatewayLifecycleIdentity,
} from "./gateway-events.js";

export const SERVICE_ATTENTION_SCHEMA_VERSION = 1;

const IdSchema = z.string().min(1).max(256).refine((value) => !/[\u0000\r\n]/.test(value));
const ProcessIncarnationSchema = z.string().regex(/^process-v2:[a-f0-9]{64}$/);
const AgentTrailIncarnationSchema = z.string().regex(
  /^agenttrail-v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

export const ServiceCriticalAttentionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(SERVICE_ATTENTION_SCHEMA_VERSION),
  attentionId: IdSchema,
  serviceId: IdSchema,
  processIncarnation: ProcessIncarnationSchema,
  source: z.literal("agenttrail"),
  classification: z.literal("critical"),
  agentTrailStreamId: IdSchema,
  agentTrailIncarnation: AgentTrailIncarnationSchema,
  agentTrailFailureEventId: IdSchema,
  authority: z.literal("none"),
  occurredAt: z.iso.datetime({ offset: true }),
});

export type ServiceAttentionEvidence = {
  readonly type: "service.critical_attention";
} & z.infer<typeof ServiceCriticalAttentionPayloadSchema>;

export function replayServiceAttention(
  journal: EventJournal,
  streamId: string,
  identity: GatewayLifecycleIdentity,
): readonly ServiceAttentionEvidence[] {
  const incarnations = new Set<string>();
  return journal.readStream(streamId).filter(({ type }) => type === "service.critical_attention").map((event) => {
    if (event.correlationId !== identity.correlationId) {
      throw new Error("service critical attention correlation identity changed");
    }
    const payload = ServiceCriticalAttentionPayloadSchema.parse(event.payload);
    if (payload.serviceId !== identity.serviceId || payload.processIncarnation !== identity.processIncarnation ||
      payload.agentTrailStreamId !== identity.agentTrailStreamId) {
      throw new Error("service critical attention identity changed");
    }
    if (incarnations.has(payload.agentTrailIncarnation)) {
      throw new Error("duplicate critical attention for one failed AgentTrail incarnation");
    }
    requireAgentTrailReference(journal, identity, payload.agentTrailFailureEventId, "agenttrail.failed",
      payload.agentTrailIncarnation, (evidence) => evidence.phase === "runtime", "runtime failure event");
    if (event.causationId !== payload.agentTrailFailureEventId) {
      throw new Error("service critical attention causation does not reference its AgentTrail failure");
    }
    incarnations.add(payload.agentTrailIncarnation);
    return { type: "service.critical_attention", ...payload };
  });
}
