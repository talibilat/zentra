import { z } from "zod";

import { MilestoneRoleSchema } from "../contracts/milestone.js";
import { TerminalOutcomeSchema } from "../contracts/task.js";

const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const TaskTypeSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ModelIdentitySchema = z.strictObject({
  capabilityId: IdSchema,
  harness: z.literal("opencode"),
  transportModelSha256: DigestSchema,
});

export const RoutingSelectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  executionId: IdSchema,
  taskId: IdSchema,
  taskType: TaskTypeSchema,
  role: MilestoneRoleSchema,
  model: ModelIdentitySchema,
  candidateCapabilityIds: z.array(IdSchema).min(1).max(128),
  modelSheetSha256: DigestSchema,
  algorithmVersion: z.literal("approved-history-v1"),
  basis: z.enum(["sheet_order", "outcome_history"]),
}).superRefine((selection, context) => {
  if (new Set(selection.candidateCapabilityIds).size !== selection.candidateCapabilityIds.length) {
    context.addIssue({ code: "custom", message: "routing candidates must be unique" });
  }
  if (!selection.candidateCapabilityIds.includes(selection.model.capabilityId)) {
    context.addIssue({ code: "custom", message: "selected model must be an approved candidate" });
  }
});

const ValidationHistorySchema = z.strictObject({
  status: z.enum(["completed", "failed", "cancelled", "timed_out", "not_required", "not_observed"]),
  evidenceSha256: DigestSchema.nullable(),
});
const ReviewHistorySchema = z.strictObject({
  status: z.enum(["approved", "denied", "failed", "cancelled", "timed_out", "not_required", "not_observed"]),
  evidenceSha256: DigestSchema.nullable(),
});
const TerminalEvidenceSchema = z.strictObject({
  eventId: IdSchema,
  streamId: IdSchema,
  sha256: DigestSchema.nullable(),
});

export const OutcomeHistoryRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  executionId: IdSchema,
  taskId: IdSchema,
  taskType: TaskTypeSchema,
  role: MilestoneRoleSchema,
  model: ModelIdentitySchema,
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().nonnegative().safe(),
  outcome: TerminalOutcomeSchema,
  validation: ValidationHistorySchema,
  review: ReviewHistorySchema,
  terminalEvidence: z.array(TerminalEvidenceSchema).min(1).max(32),
  selection: z.strictObject({
    eventId: IdSchema,
    modelSheetSha256: DigestSchema,
  }),
}).superRefine((record, context) => {
  const elapsed = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
  if (elapsed < 0 || elapsed !== record.durationMs) {
    context.addIssue({ code: "custom", message: "routing outcome duration contradicts timestamps" });
  }
  if (
    (!["not_required", "not_observed"].includes(record.validation.status)) !==
      (record.validation.evidenceSha256 !== null)
  ) {
    context.addIssue({ code: "custom", message: "validation status contradicts evidence" });
  }
  if (
    (["approved", "denied"].includes(record.review.status)) !==
      (record.review.evidenceSha256 !== null)
  ) {
    context.addIssue({ code: "custom", message: "review status contradicts evidence" });
  }
});

export type RoutingSelection = z.infer<typeof RoutingSelectionSchema>;
export type OutcomeHistoryRecord = z.infer<typeof OutcomeHistoryRecordSchema>;

export function parseRoutingEventPayload(type: string, payload: unknown): unknown {
  if (type === "routing.model_selected") return RoutingSelectionSchema.parse(payload);
  if (type === "routing.outcome_recorded") return OutcomeHistoryRecordSchema.parse(payload);
  throw new Error("unsupported routing event type");
}
