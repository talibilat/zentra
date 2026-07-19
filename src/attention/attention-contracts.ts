import { z } from "zod";

import { ProjectRevisionSchema } from "../runs/run-contracts.js";

export const ATTENTION_SCHEMA_VERSION = 1;

const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TextSchema = z.string().min(1).max(4_096);
const CanonicalScopesSchema = z.array(IdSchema).max(256).superRefine((values, context) => {
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    context.addIssue({ code: "custom", message: "scopes must be unique and canonically sorted" });
  }
});

export const DecisionActorSchema = z.strictObject({
  actorId: IdSchema,
  kind: z.enum(["operator", "service"]),
  channel: z.enum(["ui", "cli", "api"]),
});

export const ExpiryPolicySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("wait_forever") }),
  z.strictObject({ kind: z.literal("at"), expiresAt: z.iso.datetime({ offset: true }) }),
]);

export const DecisionOptionSchema = z.strictObject({
  optionId: IdSchema,
  label: TextSchema,
  impacts: z.array(TextSchema).max(64),
});

export const QuestionPacketSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  decisionId: IdSchema,
  attentionId: IdSchema,
  runId: IdSchema,
  question: TextSchema,
  options: z.array(DecisionOptionSchema).min(1).max(64),
  recommendation: z.strictObject({ optionId: IdSchema, rationale: TextSchema }).nullable(),
  impacts: z.array(TextSchema).max(64),
  affectedScopes: CanonicalScopesSchema,
  dependentScopes: CanonicalScopesSchema,
  material: z.boolean(),
  expiryPolicy: ExpiryPolicySchema,
  evidenceSha256: DigestSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
}).superRefine((packet, context) => {
  const optionIds = packet.options.map((option) => option.optionId);
  if (new Set(optionIds).size !== optionIds.length) {
    context.addIssue({ code: "custom", message: "question option identities must be unique" });
  }
  if (packet.recommendation !== null && !optionIds.includes(packet.recommendation.optionId)) {
    context.addIssue({ code: "custom", message: "recommendation must reference an immutable option" });
  }
});

export const ApprovalPacketSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  decisionId: IdSchema,
  attentionId: IdSchema,
  runId: IdSchema,
  projectRevision: ProjectRevisionSchema,
  runStreamVersion: z.number().int().positive(),
  approvalRequestEventId: IdSchema,
  summary: TextSchema,
  operation: IdSchema,
  target: TextSchema,
  inputsSha256: DigestSchema,
  expectedEffect: TextSchema,
  proposedStateChange: TextSchema,
  risk: TextSchema,
  mitigationOrRollback: TextSchema,
  planDigest: DigestSchema,
  envelopeDigest: DigestSchema,
  impacts: z.array(TextSchema).max(64),
  affectedScopes: CanonicalScopesSchema,
  dependentScopes: CanonicalScopesSchema,
  expiryPolicy: z.strictObject({ kind: z.literal("at"), expiresAt: z.iso.datetime({ offset: true }) }),
  evidenceSha256: DigestSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const DecisionRequestedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  decisionId: IdSchema,
  runId: IdSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AttentionRaisedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  attentionId: IdSchema,
  decisionId: IdSchema,
  runId: IdSchema,
  source: z.enum(["questionnaire", "approval", "agenttrail"]),
  classification: z.enum(["material", "advisory"]),
  affectedScopes: CanonicalScopesSchema,
  dependentScopes: CanonicalScopesSchema,
  evidenceSha256: DigestSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
  warningCode: IdSchema.nullable(),
  message: TextSchema.nullable(),
});

export const DecisionAcceptedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  decisionId: IdSchema,
  runId: IdSchema,
  optionId: IdSchema,
  actor: DecisionActorSchema,
  commandId: IdSchema,
  evidenceSha256: DigestSchema,
  authority: z.literal("none"),
});

export const ApprovalAcceptedPayloadSchema = DecisionAcceptedPayloadSchema.omit({ optionId: true }).extend({
  planDigest: DigestSchema,
  envelopeDigest: DigestSchema,
  approvalRequestEventId: IdSchema,
  approvalPacketSha256: DigestSchema,
});

export const DecisionRejectedPayloadSchema = DecisionAcceptedPayloadSchema.omit({ optionId: true }).extend({
  reason: TextSchema,
});

export const AttemptPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  decisionId: IdSchema,
  runId: IdSchema,
  commandId: IdSchema,
  actor: DecisionActorSchema,
  reason: z.enum(["already_consumed", "optimistic_version", "packet_digest", "cross_run", "run_revision"]),
  evidenceSha256: DigestSchema,
  authority: z.literal("none"),
});

export const AttentionResolvedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  attentionId: IdSchema,
  decisionId: IdSchema,
  runId: IdSchema,
  resolution: z.enum(["accepted", "rejected", "expired", "stale", "acknowledged"]),
  commandId: IdSchema,
  evidenceSha256: DigestSchema,
  actor: DecisionActorSchema.nullable(),
  authority: z.literal("none"),
});

export const DecisionExpiredPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  decisionId: IdSchema,
  runId: IdSchema,
  expiredAt: z.iso.datetime({ offset: true }),
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const ApprovalStalePayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  decisionId: IdSchema,
  runId: IdSchema,
  requestedPlanDigest: DigestSchema,
  requestedEnvelopeDigest: DigestSchema,
  currentPlanDigest: DigestSchema,
  currentEnvelopeDigest: DigestSchema,
  commandId: IdSchema,
  evidenceSha256: DigestSchema,
  authority: z.literal("none"),
});

export const AttentionIndexRaisedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  runId: IdSchema,
  attentionId: IdSchema,
  decisionId: IdSchema,
  affectedScopes: CanonicalScopesSchema,
  dependentScopes: CanonicalScopesSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AttentionIndexResolvedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  runId: IdSchema,
  attentionId: IdSchema,
  decisionId: IdSchema,
  resolution: z.enum(["accepted", "rejected", "expired", "stale"]),
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const ScopeAdmissionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  runId: IdSchema,
  admissionId: IdSchema,
  scopeId: IdSchema,
  dependencies: CanonicalScopesSchema,
  attentionRevision: z.number().int().nonnegative(),
  evidenceSha256: DigestSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const ApprovalReservationPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  runId: IdSchema,
  approvalRequestEventId: IdSchema,
  decisionId: IdSchema,
  packetSha256: DigestSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const ApprovalReservationConsumedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  runId: IdSchema,
  approvalRequestEventId: IdSchema,
  decisionId: IdSchema,
  outcome: z.enum(["accepted", "rejected", "expired", "stale"]),
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AttentionIdentityReservationPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ATTENTION_SCHEMA_VERSION),
  attentionId: IdSchema,
  runId: IdSchema,
  kind: z.enum(["question", "approval", "advisory"]),
  source: z.enum(["questionnaire", "approval", "agenttrail"]),
  decisionId: IdSchema.nullable(),
  creationEventId: IdSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export type DecisionActor = z.infer<typeof DecisionActorSchema>;
export type ExpiryPolicy = z.infer<typeof ExpiryPolicySchema>;
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;
export type QuestionPacket = z.infer<typeof QuestionPacketSchema>;
export type ApprovalPacket = z.infer<typeof ApprovalPacketSchema>;
export type DecisionRequestedPayload = z.infer<typeof DecisionRequestedPayloadSchema>;
export type AttentionRaisedPayload = z.infer<typeof AttentionRaisedPayloadSchema>;
export type DecisionAcceptedPayload = z.infer<typeof DecisionAcceptedPayloadSchema>;
export type ApprovalAcceptedPayload = z.infer<typeof ApprovalAcceptedPayloadSchema>;
export type DecisionRejectedPayload = z.infer<typeof DecisionRejectedPayloadSchema>;
export type AttemptPayload = z.infer<typeof AttemptPayloadSchema>;
export type AttentionResolvedPayload = z.infer<typeof AttentionResolvedPayloadSchema>;
export type DecisionExpiredPayload = z.infer<typeof DecisionExpiredPayloadSchema>;
export type ApprovalStalePayload = z.infer<typeof ApprovalStalePayloadSchema>;
export type AttentionIndexRaisedPayload = z.infer<typeof AttentionIndexRaisedPayloadSchema>;
export type AttentionIndexResolvedPayload = z.infer<typeof AttentionIndexResolvedPayloadSchema>;
export type ScopeAdmissionPayload = z.infer<typeof ScopeAdmissionPayloadSchema>;
export type ApprovalReservationPayload = z.infer<typeof ApprovalReservationPayloadSchema>;
export type ApprovalReservationConsumedPayload = z.infer<typeof ApprovalReservationConsumedPayloadSchema>;
export type AttentionIdentityReservationPayload = z.infer<typeof AttentionIdentityReservationPayloadSchema>;

export function decisionStreamId(decisionId: string): string {
  return `decision:${IdSchema.parse(decisionId)}`;
}

export function advisoryAttentionStreamId(attentionId: string): string {
  return `attention:${IdSchema.parse(attentionId)}`;
}

export function decisionAttemptStreamId(decisionId: string, commandId: string): string {
  return `decision-attempt:${encodeComponent(IdSchema.parse(decisionId))}.${encodeComponent(IdSchema.parse(commandId))}`;
}

export function parseDecisionAttemptStreamId(streamId: string): {
  readonly decisionId: string;
  readonly commandId: string;
} {
  const match = /^decision-attempt:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(streamId);
  if (match === null) throw new Error("decision attempt stream identity is invalid");
  const decisionId = decodeComponent(match[1]!);
  const commandId = decodeComponent(match[2]!);
  if (decisionAttemptStreamId(decisionId, commandId) !== streamId) {
    throw new Error("decision attempt stream identity is not canonical");
  }
  return { decisionId, commandId };
}

export function attentionIndexStreamId(runId: string): string {
  return `attention-index:${IdSchema.parse(runId)}`;
}

export function approvalReservationStreamId(runId: string, approvalRequestEventId: string): string {
  return `approval-reservation:${encodeComponent(IdSchema.parse(runId))}.${encodeComponent(IdSchema.parse(approvalRequestEventId))}`;
}

export function attentionIdentityReservationStreamId(attentionId: string): string {
  return `attention-identity:${encodeComponent(IdSchema.parse(attentionId))}`;
}

function encodeComponent(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeComponent(value: string): string {
  return IdSchema.parse(Buffer.from(value, "base64url").toString("utf8"));
}
