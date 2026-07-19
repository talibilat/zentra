import { z } from "zod";

export const RUN_SCHEMA_VERSION = 1;

const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const RunLifecycleSchema = z.enum([
  "accepted",
  "preflighting",
  "intake",
  "analyzing",
  "waiting",
  "blocked",
  "planning",
  "awaiting_approval",
  "approved_and_ready_for_execution",
  "terminal",
]);

export const RunSourceSchema = z.strictObject({
  kind: z.enum(["inline_goal", "ticket_directory"]),
  referenceSha256: DigestSchema,
  declaredBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
});

export const ProjectRevisionSchema = z.strictObject({
  objectFormat: z.enum(["sha1", "sha256"]),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
}).superRefine((revision, context) => {
  const expectedLength = revision.objectFormat === "sha1" ? 40 : 64;
  if (revision.commit.length !== expectedLength) {
    context.addIssue({ code: "custom", message: "project revision does not match its object format" });
  }
});

export const RunActorSchema = z.strictObject({
  actorId: IdSchema,
  kind: z.enum(["operator", "service"]),
});

export const RunProcessSchema = z.strictObject({
  pid: z.number().int().positive(),
  processIncarnation: z.string().regex(/^process-v2:[a-f0-9]{64}$/),
});

export const RunBudgetSchema = z.strictObject({
  maxDurationMs: z.number().int().positive().max(86_400_000),
  maxInputTokens: z.number().int().positive().max(2_000_000),
  maxOutputTokens: z.number().int().positive().max(2_000_000),
  maxCostUsdNano: z.number().int().nonnegative().max(10_000_000_000_000),
  maxRetries: z.number().int().nonnegative().max(32),
  maxSourceFiles: z.number().int().positive().max(10_000),
  maxSourceBytes: z.number().int().positive().max(1024 * 1024 * 1024),
});

export const RunAuthoritySchema = z.strictObject({
  approvalState: z.enum(["not_proposed", "approval_pending", "approved", "rejected"]),
  planDigest: DigestSchema.nullable(),
  envelopeDigest: DigestSchema.nullable(),
  approvalDecisionId: IdSchema.nullable(),
  executionAuthority: z.literal("none"),
});

export const AcceptedRunAuthoritySchema = z.strictObject({
  approvalState: z.literal("not_proposed"),
  planDigest: z.null(),
  envelopeDigest: z.null(),
  approvalDecisionId: z.null(),
  executionAuthority: z.literal("none"),
});

export const RunAcceptedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(RUN_SCHEMA_VERSION),
  runVersion: z.literal(1),
  runId: IdSchema,
  projectId: IdSchema,
  projectRevision: ProjectRevisionSchema,
  source: RunSourceSchema,
  actor: RunActorSchema,
  process: RunProcessSchema,
  budget: RunBudgetSchema,
  authority: AcceptedRunAuthoritySchema,
  commandId: IdSchema,
});

export const PreflightPayloadSchema = z.strictObject({
  schemaVersion: z.literal(RUN_SCHEMA_VERSION),
  runId: IdSchema,
  process: RunProcessSchema,
  commandId: IdSchema,
  executionAuthority: z.literal("none"),
});

export const PreflightFailedPayloadSchema = PreflightPayloadSchema.extend({
  reasonCode: z.enum([
    "project_revision_changed",
    "project_revision_unavailable",
    "trace_unavailable",
    "journal_unavailable",
    "runtime_ownership_lost",
    "projection_failed",
    "internal_failure",
  ]),
  diagnosticSha256: DigestSchema,
  disposition: z.enum(["blocked", "terminal"]),
});

export const ServiceStartingPayloadSchema = z.strictObject({
  schemaVersion: z.literal(RUN_SCHEMA_VERSION),
  serviceId: IdSchema,
  process: RunProcessSchema,
  address: z.strictObject({ host: z.literal("127.0.0.1"), port: z.number().int().min(1).max(65_535) }),
  tokenExpiresAt: z.iso.datetime({ offset: true }),
  observation: z.enum(["performed", "reconciled"]),
  commandId: IdSchema,
});

export const ServiceReadyPayloadSchema = z.strictObject({
  schemaVersion: z.literal(RUN_SCHEMA_VERSION),
  serviceId: IdSchema,
  process: RunProcessSchema,
  address: z.strictObject({ host: z.literal("127.0.0.1"), port: z.number().int().min(1).max(65_535) }),
  runtimeSchemaVersion: z.number().int().positive(),
  journalSchemaVersion: z.number().int().positive(),
  observation: z.enum(["performed", "reconciled"]),
  commandId: IdSchema,
});

export const RunPhasePayloadSchema = z.strictObject({
  schemaVersion: z.literal(RUN_SCHEMA_VERSION),
  commandId: IdSchema,
  executionAuthority: z.literal("none"),
});

export const IntakeClosureReferenceSchema = z.strictObject({
  sourceStreamId: IdSchema,
  closureEventId: IdSchema,
  snapshotSha256: DigestSchema,
  sourceCount: z.number().int().nonnegative().max(10_000),
  rejectedCount: z.number().int().nonnegative().max(100_000),
  totalBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
});

export const RunIntakeCompletedPayloadSchema = RunPhasePayloadSchema.extend({
  intake: IntakeClosureReferenceSchema,
});

export const RunAnalysisCompletedPayloadSchema = RunPhasePayloadSchema.extend({
  intake: IntakeClosureReferenceSchema,
});

export const RunApprovalRequestedPayloadSchema = RunPhasePayloadSchema.extend({
  planDigest: DigestSchema,
  envelopeDigest: DigestSchema,
});

export const RunReadyPayloadSchema = RunApprovalRequestedPayloadSchema.extend({
  approvalDecisionId: IdSchema,
  approvalDecisionEventId: IdSchema,
  approvalRequestEventId: IdSchema,
  approvalPacketSha256: DigestSchema,
});

export const RunPlanRevisedPayloadSchema = RunPhasePayloadSchema.extend({
  priorApprovalRequestEventId: IdSchema,
});

export const RunSuspendedPayloadSchema = RunPhasePayloadSchema.extend({
  reasonCode: IdSchema,
  resumeTo: RunLifecycleSchema.exclude(["waiting", "blocked", "terminal"]),
});

export const RunResumedPayloadSchema = RunPhasePayloadSchema.extend({
  suspensionEventId: IdSchema,
  resumeTo: RunLifecycleSchema.exclude(["waiting", "blocked", "terminal"]),
});

export const RunCancelledPayloadSchema = z.strictObject({
  schemaVersion: z.literal(RUN_SCHEMA_VERSION),
  commandId: IdSchema,
  cancellationId: IdSchema,
  requestedBy: RunActorSchema,
  reasonCode: z.enum(["operator_requested", "service_shutdown", "source_withdrawn", "superseded"]),
  observedLifecycle: RunLifecycleSchema.exclude(["terminal"]),
  process: RunProcessSchema,
  executionAuthority: z.literal("none"),
});

export const RunReopenedPayloadSchema = RunPhasePayloadSchema.extend({
  priorProcess: RunProcessSchema,
  process: RunProcessSchema,
  priorRunEventId: IdSchema,
  serviceReadyEventId: IdSchema,
});

export const RunTerminalPayloadSchema = RunPhasePayloadSchema.extend({
  evidenceSha256: DigestSchema,
  process: RunProcessSchema,
});

export type RunLifecycle = z.infer<typeof RunLifecycleSchema>;
export type RunSource = z.infer<typeof RunSourceSchema>;
export type ProjectRevision = z.infer<typeof ProjectRevisionSchema>;
export type RunActor = z.infer<typeof RunActorSchema>;
export type RunProcess = z.infer<typeof RunProcessSchema>;
export type RunBudget = z.infer<typeof RunBudgetSchema>;
export type RunAuthority = z.infer<typeof RunAuthoritySchema>;
export type IntakeClosureReference = z.infer<typeof IntakeClosureReferenceSchema>;

export function runStreamId(runId: string): string {
  return `run:${IdSchema.parse(runId)}`;
}

export function serviceStreamId(processIncarnation: string): string {
  return `service:${RunProcessSchema.shape.processIncarnation.parse(processIncarnation)}`;
}
