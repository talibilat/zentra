import { z } from "zod";

import { MilestoneRoleSchema } from "./milestone.js";
import { TerminalOutcomeSchema } from "./task.js";
import { UncertainEffectBoundarySchema } from "./uncertain-effect.js";

const Identity = z.string().min(1).max(256);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^[a-f0-9]{40,64}$/);

export const MilestoneEvidenceReferenceSchema = z.strictObject({
  streamId: Identity,
  eventId: Identity,
  eventType: z.string().min(1).max(256),
  streamVersion: z.number().int().positive(),
  payloadDigest: Digest,
});

export const MilestoneTaskResultSchema = z.strictObject({
  taskId: Identity,
  role: MilestoneRoleSchema,
  status: z.enum(["planned", "ready", "running", "blocked", "completed"]),
  outcome: TerminalOutcomeSchema.nullable(),
  evidence: z.array(MilestoneEvidenceReferenceSchema).max(32),
});

export const MilestoneTerminalResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  milestoneId: Identity,
  projectId: Identity,
  outcome: TerminalOutcomeSchema,
  tasks: z.array(MilestoneTaskResultSchema).max(512),
  integratedCommits: z.array(z.strictObject({
    taskId: Identity,
    sourceCommit: Commit,
    resultCommit: Commit,
    evidence: MilestoneEvidenceReferenceSchema,
  })).max(512),
  validations: z.array(z.strictObject({
    taskId: Identity,
    name: z.enum(["focused", "full"]),
    outcome: z.enum(["completed", "cancelled", "timed_out", "failed"]),
    exitCode: z.number().int().nullable(),
    argvDigest: Digest,
    outputDigest: Digest,
    subjectDigest: z.string().min(1).max(64).nullable(),
    evidence: MilestoneEvidenceReferenceSchema,
  })).max(1_024),
  reviews: z.array(z.strictObject({
    taskId: Identity,
    reviewerId: Identity,
    approved: z.boolean(),
    diffDigest: Digest,
    validationDigest: Digest,
    evidence: MilestoneEvidenceReferenceSchema,
  })).max(512),
  trace: z.strictObject({
    traceId: Identity,
    path: z.string().min(1).max(4_096).nullable(),
    outcome: z.enum(["emitted", "failed", "not_observed"]),
  }),
  pauses: z.array(z.strictObject({
    reason: Identity,
    evidence: MilestoneEvidenceReferenceSchema,
  })).max(256),
  uncertainties: z.array(z.strictObject({
    taskId: Identity,
    boundary: UncertainEffectBoundarySchema,
    resolved: z.boolean(),
    evidence: MilestoneEvidenceReferenceSchema,
    resolution: MilestoneEvidenceReferenceSchema.nullable(),
  })).max(512),
  decisions: z.array(z.strictObject({
    kind: z.string().min(1).max(256),
    evidence: MilestoneEvidenceReferenceSchema,
  })).max(1_024),
}).superRefine((result, context) => {
  const taskIds = result.tasks.map((task) => task.taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    context.addIssue({ code: "custom", message: "terminal result task identities must be unique" });
  }
  if (result.outcome === "completed" && result.tasks.some((task) => task.outcome !== "completed")) {
    context.addIssue({ code: "custom", message: "completed terminal result requires every task completed" });
  }
});

export const MilestoneTerminalPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  outcome: TerminalOutcomeSchema,
  result: MilestoneTerminalResultSchema,
}).superRefine((payload, context) => {
  if (payload.outcome !== payload.result.outcome) {
    context.addIssue({ code: "custom", message: "terminal event outcome must match its result" });
  }
});

export const LegacyMilestoneNonSuccessPayloadSchema = z.union([
  z.strictObject({
    outcome: z.enum(["cancelled", "denied", "timed_out", "failed"]),
    evidence: z.record(z.string().min(1).max(128), z.unknown()),
  }),
  z.strictObject({ reason: z.string().min(1).max(4_096) }),
]);

export type MilestoneEvidenceReference = z.infer<typeof MilestoneEvidenceReferenceSchema>;
export type MilestoneTerminalResult = z.infer<typeof MilestoneTerminalResultSchema>;
