import type { StoredEvent } from "../contracts/event.js";
import {
  AttentionIndexRaisedPayloadSchema,
  AttentionIndexResolvedPayloadSchema,
  ScopeAdmissionPayloadSchema,
  attentionIndexStreamId,
} from "./attention-contracts.js";

export interface IndexedMaterialAttention {
  readonly attentionId: string;
  readonly decisionId: string;
  readonly affectedScopes: readonly string[];
  readonly dependentScopes: readonly string[];
}

export interface AttentionIndexView {
  readonly runId: string;
  readonly revision: number;
  readonly pending: Readonly<Record<string, IndexedMaterialAttention>>;
  readonly admissionIds: readonly string[];
  readonly knownAttentionIds: readonly string[];
}

export function projectAttentionIndex(runId: string, events: readonly StoredEvent[]): AttentionIndexView {
  const streamId = attentionIndexStreamId(runId);
  const pending: Record<string, IndexedMaterialAttention> = {};
  const admissionIds = new Set<string>();
  const knownAttentionIds = new Set<string>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.streamId !== streamId || event.streamVersion !== index + 1 || event.correlationId !== runId) {
      throw new Error("attention index event metadata is not contiguous or run-bound");
    }
    if (event.type === "attention.index_raised") {
      const payload = AttentionIndexRaisedPayloadSchema.parse(event.payload);
      if (payload.runId !== runId || knownAttentionIds.has(payload.attentionId)) {
        throw new Error("attention index raise identity is contradictory or duplicate");
      }
      knownAttentionIds.add(payload.attentionId);
      pending[payload.attentionId] = Object.freeze({
        attentionId: payload.attentionId,
        decisionId: payload.decisionId,
        affectedScopes: Object.freeze(payload.affectedScopes),
        dependentScopes: Object.freeze(payload.dependentScopes),
      });
      continue;
    }
    if (event.type === "attention.index_resolved") {
      const payload = AttentionIndexResolvedPayloadSchema.parse(event.payload);
      const current = pending[payload.attentionId];
      if (payload.runId !== runId || current?.decisionId !== payload.decisionId) {
        throw new Error("attention index resolution has no matching pending item");
      }
      delete pending[payload.attentionId];
      continue;
    }
    if (event.type === "attention.scope_admitted") {
      const payload = ScopeAdmissionPayloadSchema.parse(event.payload);
      if (payload.runId !== runId || payload.attentionRevision !== index) {
        throw new Error("scope admission is not bound to its prior attention revision");
      }
      if (admissionIds.has(payload.admissionId)) throw new Error("scope admission identity is already consumed");
      admissionIds.add(payload.admissionId);
      continue;
    }
    throw new Error(`unknown attention index event type ${event.type}`);
  }
  return Object.freeze({
    runId,
    revision: events.length,
    pending: Object.freeze(pending),
    admissionIds: Object.freeze([...admissionIds]),
    knownAttentionIds: Object.freeze([...knownAttentionIds]),
  });
}
