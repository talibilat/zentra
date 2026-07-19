import type { StoredEvent } from "../contracts/event.js";
import {
  AttentionIdentityReservationPayloadSchema,
  attentionIdentityReservationStreamId,
  type AttentionIdentityReservationPayload,
} from "./attention-contracts.js";

export type AttentionIdentityReservationView = AttentionIdentityReservationPayload & {
  readonly streamVersion: 1;
};

export function projectAttentionIdentityReservation(
  events: readonly StoredEvent[],
): AttentionIdentityReservationView | null {
  if (events.length === 0) return null;
  if (events.length !== 1) throw new Error("attention identity reservation is immutable and single-use");
  const event = events[0]!;
  if (event.type !== "attention.identity_reserved" || event.streamVersion !== 1) {
    throw new Error("attention identity reservation event is invalid");
  }
  const payload = AttentionIdentityReservationPayloadSchema.parse(event.payload);
  if (event.streamId !== attentionIdentityReservationStreamId(payload.attentionId) ||
    event.correlationId !== payload.runId || event.causationId !== payload.creationEventId) {
    throw new Error("attention identity reservation metadata is contradictory");
  }
  return Object.freeze({ ...payload, streamVersion: 1 });
}
