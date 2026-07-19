import type { StoredEvent } from "../contracts/event.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import {
  ApprovalAcceptedPayloadSchema,
  ApprovalPacketSchema,
  ApprovalStalePayloadSchema,
  AttentionRaisedPayloadSchema,
  AttentionResolvedPayloadSchema,
  DecisionAcceptedPayloadSchema,
  DecisionExpiredPayloadSchema,
  DecisionRejectedPayloadSchema,
  DecisionRequestedPayloadSchema,
  QuestionPacketSchema,
  advisoryAttentionStreamId,
  decisionStreamId,
  type ApprovalPacket,
  type DecisionActor,
  type ExpiryPolicy,
  type QuestionPacket,
} from "./attention-contracts.js";

export type AttentionStatus = "pending" | "accepted" | "rejected" | "expired" | "stale" | "resolved";
export type AttentionResolution =
  | { readonly optionId: string; readonly actor: DecisionActor; readonly evidenceSha256: string }
  | { readonly reason: string; readonly actor: DecisionActor; readonly evidenceSha256: string }
  | { readonly planDigest: string; readonly envelopeDigest: string; readonly actor: DecisionActor; readonly evidenceSha256: string }
  | null;

export interface AttentionView {
  readonly schemaVersion: 1;
  readonly kind: "question" | "approval" | "advisory";
  readonly decisionId: string;
  readonly attentionId: string;
  readonly runId: string;
  readonly status: AttentionStatus;
  readonly streamVersion: number;
  readonly expiryPolicy: ExpiryPolicy;
  readonly affectedScopes: readonly string[];
  readonly dependentScopes: readonly string[];
  readonly material: boolean;
  readonly options: readonly QuestionPacket["options"][number][];
  readonly recommendation: QuestionPacket["recommendation"];
  readonly impacts: readonly string[];
  readonly packet: QuestionPacket | ApprovalPacket | null;
  readonly resolution: AttentionResolution;
  readonly warningCode: string | null;
  readonly message: string | null;
  readonly authority: "none";
}

export function projectAttention(events: readonly StoredEvent[]): AttentionView | null {
  if (events.length === 0) return null;
  const first = events[0]!;
  let kind: AttentionView["kind"];
  let packet: QuestionPacket | ApprovalPacket | null = null;
  let raised;
  let index: number;

  if (first.type === "questionnaire.proposed") {
    kind = "question";
    packet = QuestionPacketSchema.parse(first.payload);
    const requested = events[1];
    const raisedEvent = events[2];
    if (requested?.type !== "decision.requested" || raisedEvent?.type !== "attention.raised") {
      throw new Error("question proposal requires decision.requested and attention.raised");
    }
    const request = DecisionRequestedPayloadSchema.parse(requested.payload);
    if (request.decisionId !== packet.decisionId || request.runId !== packet.runId || request.commandId !== packet.commandId) {
      throw new Error("decision request identity contradicts its questionnaire");
    }
    raised = AttentionRaisedPayloadSchema.parse(raisedEvent.payload);
    index = 3;
  } else if (first.type === "approval.requested") {
    kind = "approval";
    packet = ApprovalPacketSchema.parse(first.payload);
    const raisedEvent = events[1];
    if (raisedEvent?.type !== "attention.raised") throw new Error("approval request requires attention.raised");
    raised = AttentionRaisedPayloadSchema.parse(raisedEvent.payload);
    index = 2;
  } else if (first.type === "attention.raised") {
    kind = "advisory";
    raised = AttentionRaisedPayloadSchema.parse(first.payload);
    index = 1;
  } else {
    throw new Error("attention stream has an invalid first event");
  }

  const decisionId = packet?.decisionId ?? raised.decisionId;
  const streamId = kind === "advisory" ? advisoryAttentionStreamId(raised.attentionId) : decisionStreamId(decisionId);
  if (raised.decisionId !== decisionId || raised.attentionId !== (packet?.attentionId ?? raised.attentionId) ||
    raised.runId !== (packet?.runId ?? raised.runId)) {
    throw new Error("attention identity contradicts its packet");
  }
  if (kind === "advisory" && (raised.source !== "agenttrail" || raised.classification !== "advisory")) {
    throw new Error("standalone attention must be advisory AgentTrail evidence");
  }
  const expectedSource = kind === "question" ? "questionnaire" : kind === "advisory" ? "agenttrail" : kind;
  if (raised.source !== expectedSource) throw new Error("attention source contradicts its packet");
  if (packet !== null && (JSON.stringify(raised.affectedScopes) !== JSON.stringify(packet.affectedScopes) ||
    JSON.stringify(raised.dependentScopes) !== JSON.stringify(packet.dependentScopes) ||
    raised.evidenceSha256 !== packet.evidenceSha256 || raised.commandId !== packet.commandId)) {
    throw new Error("attention scope or evidence contradicts its packet");
  }
  if (kind === "approval" && raised.classification !== "material") {
    throw new Error("approval attention must be material");
  }
  if (kind === "question" && raised.classification !== ((packet as QuestionPacket).material ? "material" : "advisory")) {
    throw new Error("question attention classification contradicts its packet");
  }

  let status: AttentionStatus = "pending";
  let resolution: AttentionResolution = null;
  for (let eventIndex = index; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex]!;
    assertMetadata(event, streamId, eventIndex + 1, raised.runId);
    switch (event.type) {
      case "decision.accepted": {
        if (kind !== "question" || status !== "pending") throw new Error("decision is already consumed");
        const payload = DecisionAcceptedPayloadSchema.parse(event.payload);
        assertDecisionIdentity(payload, decisionId, raised.runId);
        if (!(packet as QuestionPacket).options.some((option) => option.optionId === payload.optionId)) {
          throw new Error("answer is not one of the immutable options");
        }
        status = "accepted";
        resolution = { optionId: payload.optionId, actor: payload.actor, evidenceSha256: payload.evidenceSha256 };
        break;
      }
      case "approval.accepted": {
        if (kind !== "approval" || status !== "pending") throw new Error("decision is already consumed");
        const payload = ApprovalAcceptedPayloadSchema.parse(event.payload);
        assertDecisionIdentity(payload, decisionId, raised.runId);
        const approval = packet as ApprovalPacket;
        if (payload.planDigest !== approval.planDigest || payload.envelopeDigest !== approval.envelopeDigest) {
          throw new Error("accepted approval contradicts the exact packet");
        }
        if (payload.approvalRequestEventId !== approval.approvalRequestEventId ||
          payload.approvalPacketSha256 !== digestCanonical(approval)) {
          throw new Error("accepted approval does not bind the request event and packet digest");
        }
        status = "accepted";
        resolution = { planDigest: payload.planDigest, envelopeDigest: payload.envelopeDigest, actor: payload.actor, evidenceSha256: payload.evidenceSha256 };
        break;
      }
      case "decision.rejected":
      case "approval.rejected": {
        if (status !== "pending" || kind === "advisory") throw new Error("decision is already consumed");
        if ((kind === "approval") !== (event.type === "approval.rejected")) {
          throw new Error("rejection event type contradicts the decision kind");
        }
        const payload = DecisionRejectedPayloadSchema.parse(event.payload);
        assertDecisionIdentity(payload, decisionId, raised.runId);
        status = "rejected";
        resolution = { reason: payload.reason, actor: payload.actor, evidenceSha256: payload.evidenceSha256 };
        break;
      }
      case "decision.expired":
      case "approval.expired":
        if (status !== "pending" || kind === "advisory") throw new Error("decision is already consumed");
        if ((kind === "approval") !== (event.type === "approval.expired")) {
          throw new Error("expiry event type contradicts the decision kind");
        }
        assertDecisionIdentity(DecisionExpiredPayloadSchema.parse(event.payload), decisionId, raised.runId);
        status = "expired";
        break;
      case "approval.stale":
        if (status !== "pending" || kind !== "approval") throw new Error("decision is already consumed");
        assertDecisionIdentity(ApprovalStalePayloadSchema.parse(event.payload), decisionId, raised.runId);
        status = "stale";
        break;
      case "attention.resolved": {
        const payload = AttentionResolvedPayloadSchema.parse(event.payload);
        if (kind === "advisory") status = "resolved";
        else if (status === "pending") throw new Error("attention resolved before its decision");
        if (payload.attentionId !== raised.attentionId || payload.decisionId !== decisionId || payload.runId !== raised.runId) {
          throw new Error("attention resolution identity is contradictory");
        }
        const expectedResolution = kind === "advisory" ? "acknowledged" : status;
        if (payload.resolution !== expectedResolution) throw new Error("attention resolution contradicts its decision");
        break;
      }
      default:
        throw new Error(`unknown attention event type ${event.type}`);
    }
  }

  for (let eventIndex = 0; eventIndex < Math.min(index, events.length); eventIndex++) {
    assertMetadata(events[eventIndex]!, streamId, eventIndex + 1, raised.runId);
  }
  const question = kind === "question" ? packet as QuestionPacket : null;
  return deepFreeze({
    schemaVersion: 1,
    kind,
    decisionId,
    attentionId: raised.attentionId,
    runId: raised.runId,
    status,
    streamVersion: events.at(-1)!.streamVersion,
    expiryPolicy: packet?.expiryPolicy ?? { kind: "wait_forever" },
    affectedScopes: raised.affectedScopes,
    dependentScopes: raised.dependentScopes,
    material: raised.classification === "material",
    options: question?.options ?? [],
    recommendation: question?.recommendation ?? null,
    impacts: packet?.impacts ?? [],
    packet,
    resolution,
    warningCode: raised.warningCode,
    message: raised.message,
    authority: "none",
  });
}

function assertMetadata(event: StoredEvent, streamId: string, version: number, runId: string): void {
  if (event.streamId !== streamId || event.streamVersion !== version || event.correlationId !== runId) {
    throw new Error("attention event metadata is not contiguous or bound to its run");
  }
}

function assertDecisionIdentity(
  payload: { readonly decisionId: string; readonly runId: string },
  decisionId: string,
  runId: string,
): void {
  if (payload.decisionId !== decisionId || payload.runId !== runId) {
    throw new Error("decision event identity is contradictory");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
