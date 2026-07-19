import type { StoredEvent } from "../contracts/event.js";
import {
  ApprovalReservationConsumedPayloadSchema,
  ApprovalReservationPayloadSchema,
  approvalReservationStreamId,
} from "./attention-contracts.js";

export interface ApprovalReservationView {
  readonly runId: string;
  readonly approvalRequestEventId: string;
  readonly decisionId: string;
  readonly packetSha256: string;
  readonly status: "reserved" | "consumed";
  readonly outcome: "accepted" | "rejected" | "expired" | "stale" | null;
  readonly streamVersion: number;
}

export function projectApprovalReservation(events: readonly StoredEvent[]): ApprovalReservationView | null {
  if (events.length === 0) return null;
  const first = events[0]!;
  if (first.type !== "approval.reserved" || first.streamVersion !== 1) {
    throw new Error("approval reservation must begin with approval.reserved");
  }
  const reserved = ApprovalReservationPayloadSchema.parse(first.payload);
  const streamId = approvalReservationStreamId(reserved.runId, reserved.approvalRequestEventId);
  if (first.streamId !== streamId || first.correlationId !== reserved.runId) {
    throw new Error("approval reservation identity is contradictory");
  }
  let outcome: ApprovalReservationView["outcome"] = null;
  if (events.length > 2) throw new Error("approval reservation has duplicate consumption");
  if (events[1] !== undefined) {
    const consumed = events[1];
    if (consumed.type !== "approval.reservation_consumed" || consumed.streamId !== streamId ||
      consumed.streamVersion !== 2 || consumed.correlationId !== reserved.runId) {
      throw new Error("approval reservation consumption metadata is contradictory");
    }
    const payload = ApprovalReservationConsumedPayloadSchema.parse(consumed.payload);
    if (payload.runId !== reserved.runId || payload.approvalRequestEventId !== reserved.approvalRequestEventId ||
      payload.decisionId !== reserved.decisionId) {
      throw new Error("approval reservation consumption identity is contradictory");
    }
    outcome = payload.outcome;
  }
  return Object.freeze({
    runId: reserved.runId,
    approvalRequestEventId: reserved.approvalRequestEventId,
    decisionId: reserved.decisionId,
    packetSha256: reserved.packetSha256,
    status: outcome === null ? "reserved" : "consumed",
    outcome,
    streamVersion: events.length,
  });
}
