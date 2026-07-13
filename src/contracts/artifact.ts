import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import type { StoredEvent } from "./event.js";

const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;
const MAX_TEXT_LENGTH = 4_096;
const MAX_COMMAND_ARGUMENTS = 256;
const MAX_RETAINED_BYTES = 1_024 * 1_024;

const IdentitySchema = z.string().min(1).max(MAX_ID_LENGTH);
const BoundedTextSchema = z.string().max(MAX_TEXT_LENGTH);
const Sha256Schema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.string().max(64).datetime({ offset: true });
const SafeLogicalPathSchema = z.string().min(1).max(MAX_PATH_LENGTH).refine(isSafeLogicalPath, {
  message: "artifact path must be a safe logical relative path",
});

export const ArtifactKindSchema = z.enum([
  "patch",
  "validation_report",
  "review_report",
  "integration_receipt",
]);

export const ArtifactSchema = z.strictObject({
  artifactId: IdentitySchema,
  taskId: IdentitySchema,
  kind: ArtifactKindSchema,
  path: SafeLogicalPathSchema,
  sha256: Sha256Schema,
  createdAt: TimestampSchema,
});

const PatchEvidenceSchema = z.strictObject({
  diff: z.string().min(1).max(MAX_RETAINED_BYTES),
  diffSha256: Sha256Schema,
  changedPath: SafeLogicalPathSchema,
  changedContentSha256: Sha256Schema,
});

const ValidationEvidenceSchema = z.strictObject({
  name: IdentitySchema,
  outcome: z.enum(["completed", "cancelled", "timed_out", "failed"]),
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(MAX_RETAINED_BYTES),
  stderr: z.string().max(MAX_RETAINED_BYTES),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  command: z.array(BoundedTextSchema).min(1).max(MAX_COMMAND_ARGUMENTS),
  argvSha256: Sha256Schema,
  outputSha256: Sha256Schema,
  provenance: z.strictObject({
    invocationId: IdentitySchema,
    canonicalCwd: z.string().min(1).max(MAX_PATH_LENGTH),
    subjectSha256: z.string().min(1).max(64).nullable(),
  }),
});

const ReviewEvidenceSchema = z.strictObject({
  reviewerId: IdentitySchema,
  approved: z.boolean(),
  diffSha256: Sha256Schema,
  validationSha256: Sha256Schema,
  decidedAt: TimestampSchema,
  reason: z.string().min(1).max(MAX_TEXT_LENGTH),
});

const IntegrationReceiptEvidenceSchema = z.strictObject({
  taskId: IdentitySchema,
  projectId: IdentitySchema,
  sourceCommit: z.string().max(64).regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  originalIntegrationCommit: z.string().max(64).regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
  resultCommit: z.string().max(64).regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
  review: ReviewEvidenceSchema,
  validation: ValidationEvidenceSchema,
  outcome: z.enum(["completed", "cancelled", "timed_out", "failed"]),
});

function artifactFor<TKind extends z.infer<typeof ArtifactKindSchema>>(kind: TKind) {
  return ArtifactSchema.extend({ kind: z.literal(kind) });
}

export const PatchArtifactRecordedEventSchema = z.strictObject({
  artifact: artifactFor("patch"),
  evidence: PatchEvidenceSchema,
});
export const ValidationReportArtifactRecordedEventSchema = z.strictObject({
  artifact: artifactFor("validation_report"),
  evidence: ValidationEvidenceSchema,
});
export const ReviewReportArtifactRecordedEventSchema = z.strictObject({
  artifact: artifactFor("review_report"),
  evidence: ReviewEvidenceSchema,
});
export const IntegrationReceiptArtifactRecordedEventSchema = z.strictObject({
  artifact: artifactFor("integration_receipt"),
  evidence: IntegrationReceiptEvidenceSchema,
});

export const ArtifactRecordedEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("artifact.patch_recorded"),
    payload: PatchArtifactRecordedEventSchema,
  }),
  z.strictObject({
    type: z.literal("artifact.validation_report_recorded"),
    payload: ValidationReportArtifactRecordedEventSchema,
  }),
  z.strictObject({
    type: z.literal("artifact.review_report_recorded"),
    payload: ReviewReportArtifactRecordedEventSchema,
  }),
  z.strictObject({
    type: z.literal("artifact.integration_receipt_recorded"),
    payload: IntegrationReceiptArtifactRecordedEventSchema,
  }),
]);

export type Artifact = z.infer<typeof ArtifactSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type ArtifactRecordedEvent = z.infer<typeof ArtifactRecordedEventSchema>;
export type PatchArtifactEvidence = z.infer<typeof PatchEvidenceSchema>;

export interface ArtifactView {
  readonly artifacts: readonly Artifact[];
  readonly evidenceByArtifactId: Readonly<Record<string, unknown>>;
}

const ARTIFACT_EVENT_TYPES = new Set([
  "artifact.patch_recorded",
  "artifact.validation_report_recorded",
  "artifact.review_report_recorded",
  "artifact.integration_receipt_recorded",
]);

export function isArtifactRecordedEventType(type: string): boolean {
  return ARTIFACT_EVENT_TYPES.has(type);
}

export function artifactEvidenceSha256(
  kind: ArtifactKind,
  evidence: unknown,
): string {
  if (kind === "patch") {
    const patch = parseEvidence(PatchEvidenceSchema, evidence, "patch");
    const diffSha256 = sha256(patch.diff);
    if (diffSha256 !== patch.diffSha256) {
      throw new Error("patch artifact contains a contradictory diff digest");
    }
    return diffSha256;
  }
  if (kind === "validation_report") {
    const report = parseEvidence(ValidationEvidenceSchema, evidence, "validation_report");
    const argvSha256 = sha256(JSON.stringify(report.command));
    const outputSha256 = sha256(JSON.stringify({ stdout: report.stdout, stderr: report.stderr }));
    if (argvSha256 !== report.argvSha256 || outputSha256 !== report.outputSha256) {
      throw new Error("validation artifact contains contradictory command or output digests");
    }
    return sha256(JSON.stringify({
      name: report.name,
      outcome: report.outcome,
      exitCode: report.exitCode,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      command: report.command,
      stdout: report.stdout,
      stderr: report.stderr,
      argvSha256,
      outputSha256,
      provenance: report.provenance,
    }));
  }
  if (kind === "review_report") {
    return sha256(JSON.stringify(parseEvidence(ReviewEvidenceSchema, evidence, kind)));
  }
  return sha256(JSON.stringify(parseEvidence(IntegrationReceiptEvidenceSchema, evidence, kind)));
}

export function projectArtifacts(events: readonly StoredEvent[]): ArtifactView {
  const artifacts: Artifact[] = [];
  const evidenceByArtifactId: Record<string, unknown> = {};
  const byKind = new Map<ArtifactKind, { artifact: Artifact; evidence: unknown }>();
  const ids = new Set<string>();
  let artifactMode = false;
  let terminal = false;

  for (const event of events) {
    if (terminal && (artifactMode || isArtifactRecordedEventType(event.type))) {
      throw new Error("artifact replay encountered an event after task terminalization");
    }
    if (event.type.startsWith("task.") && isTerminalEvent(event.type)) terminal = true;

    if (isArtifactRecordedEventType(event.type)) {
      artifactMode = true;
      const parsed = ArtifactRecordedEventSchema.safeParse({
        type: event.type,
        payload: event.payload,
      });
      if (!parsed.success) {
        throw new Error(`invalid ${event.type} payload`);
      }
      const { artifact, evidence } = parsed.data.payload;
      if (artifact.taskId !== event.streamId) {
        throw new Error(`${event.type} artifact taskId does not match its stream`);
      }
      if (ids.has(artifact.artifactId)) {
        throw new Error("duplicate artifact identity");
      }
      if (byKind.has(artifact.kind)) {
        throw new Error(`duplicate artifact kind: ${artifact.kind}`);
      }
      const expectedDigest = artifactEvidenceSha256(artifact.kind, evidence);
      if (artifact.sha256 !== expectedDigest) {
        throw new Error(`${artifact.kind} artifact digest contradicts its evidence`);
      }
      assertArtifactOrder(event.type, events, event.streamVersion);
      validateArtifactChain(artifact.kind, evidence, byKind);
      ids.add(artifact.artifactId);
      byKind.set(artifact.kind, { artifact, evidence });
      artifacts.push(artifact);
      evidenceByArtifactId[artifact.artifactId] = evidence;
      continue;
    }

    if (artifactMode) validateLifecycleArtifactReference(event, byKind);
  }

  return Object.freeze({
    artifacts: Object.freeze([...artifacts]),
    evidenceByArtifactId: Object.freeze({ ...evidenceByArtifactId }),
  });
}

function validateLifecycleArtifactReference(
  event: StoredEvent,
  byKind: ReadonlyMap<ArtifactKind, { artifact: Artifact; evidence: unknown }>,
): void {
  const payload = objectPayload(event);
  if (event.type === "task.validation_started") {
    const patch = requireArtifact(byKind, "patch", event.type);
    const patchEvidence = PatchEvidenceSchema.parse(patch.evidence);
    const workerPatch = typeof payload.patch === "object" && payload.patch !== null
      ? payload.patch as Record<string, unknown>
      : {};
    if (payload.diffSha256 !== patch.artifact.sha256) {
      throw new Error("task.validation_started references a contradictory patch digest");
    }
    if (
      workerPatch.path !== patchEvidence.changedPath ||
      workerPatch.sha256 !== patchEvidence.changedContentSha256
    ) {
      throw new Error("task.validation_started references contradictory changed-file evidence");
    }
  }
  if (event.type === "task.review_requested" || "validation" in payload) {
    if ("validation" in payload) {
      const validation = requireArtifact(byKind, "validation_report", "lifecycle event");
      if (artifactEvidenceSha256("validation_report", payload.validation) !== validation.artifact.sha256) {
        throw new Error("lifecycle event references contradictory validation evidence");
      }
    }
  }
  if (event.type === "task.review_approved" || event.type === "task.integration_started" || "review" in payload) {
    if ("review" in payload) {
      const review = requireArtifact(byKind, "review_report", "lifecycle event");
      if (sha256(JSON.stringify(payload.review)) !== review.artifact.sha256) {
        throw new Error("lifecycle event references contradictory review evidence");
      }
    }
  }
  if (
    event.type === "task.integration_prepared" ||
    event.type === "task.completed" ||
    "receipt" in payload
  ) {
    if ("receipt" in payload) {
      const receipt = requireArtifact(byKind, "integration_receipt", "lifecycle event");
      if (sha256(JSON.stringify(payload.receipt)) !== receipt.artifact.sha256) {
        throw new Error("lifecycle event references contradictory integration receipt evidence");
      }
    }
  }
}

function validateArtifactChain(
  kind: ArtifactKind,
  evidence: unknown,
  byKind: ReadonlyMap<ArtifactKind, { artifact: Artifact; evidence: unknown }>,
): void {
  if (kind === "validation_report") {
    const report = ValidationEvidenceSchema.parse(evidence);
    const patch = requireArtifact(byKind, "patch", "validation_report artifact");
    if (
      report.provenance.subjectSha256 !== null &&
      report.provenance.subjectSha256 !== patch.artifact.sha256
    ) {
      throw new Error("validation report artifact contradicts the patch artifact");
    }
  }
  if (kind === "review_report") {
    const decision = ReviewEvidenceSchema.parse(evidence);
    const patch = requireArtifact(byKind, "patch", "review_report artifact");
    const validation = requireArtifact(byKind, "validation_report", "review_report artifact");
    if (
      decision.diffSha256 !== patch.artifact.sha256 ||
      decision.validationSha256 !== validation.artifact.sha256
    ) {
      throw new Error("review report artifact contradicts its patch or validation artifacts");
    }
  }
  if (kind === "integration_receipt") {
    const receipt = IntegrationReceiptEvidenceSchema.parse(evidence);
    const review = requireArtifact(byKind, "review_report", "integration_receipt artifact");
    if (JSON.stringify(receipt.review) !== JSON.stringify(review.evidence)) {
      throw new Error("integration receipt artifact contradicts the review artifact");
    }
  }
}

function requireArtifact(
  byKind: ReadonlyMap<ArtifactKind, { artifact: Artifact; evidence: unknown }>,
  kind: ArtifactKind,
  eventType: string,
): { artifact: Artifact; evidence: unknown } {
  const artifact = byKind.get(kind);
  if (artifact === undefined) {
    throw new Error(`${eventType} references missing ${kind} artifact`);
  }
  return artifact;
}

function assertArtifactOrder(type: string, events: readonly StoredEvent[], version: number): void {
  const priorTypes = new Set(events.filter((event) => event.streamVersion < version).map((event) => event.type));
  const forbiddenPrior: Record<string, string> = {
    "artifact.patch_recorded": "task.validation_started",
    "artifact.validation_report_recorded": "task.review_requested",
    "artifact.review_report_recorded": "task.review_approved",
    "artifact.integration_receipt_recorded": "task.integration_prepared",
  };
  const requiredPrior: Record<string, string> = {
    "artifact.patch_recorded": "task.started",
    "artifact.validation_report_recorded": "task.validation_started",
    "artifact.review_report_recorded": "task.review_requested",
    "artifact.integration_receipt_recorded": "task.integration_started",
  };
  if (!priorTypes.has(requiredPrior[type]!)) throw new Error(`${type} is out of order`);
  if (priorTypes.has(forbiddenPrior[type]!)) throw new Error(`${type} is out of order`);
}

function objectPayload(event: StoredEvent): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null
    ? event.payload as Record<string, unknown>
    : {};
}

function isTerminalEvent(type: string): boolean {
  return new Set([
    "task.completed",
    "task.cancelled",
    "task.denied",
    "task.timed_out",
    "task.failed",
  ]).has(type);
}

function isSafeLogicalPath(candidate: string): boolean {
  if (
    candidate.includes("\0") ||
    candidate.includes("\n") ||
    candidate.includes("\r") ||
    candidate.includes("\\") ||
    path.posix.isAbsolute(candidate)
  ) return false;
  const segments = candidate.split("/");
  return (
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    path.posix.normalize(candidate) === candidate
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseEvidence<TSchema extends z.ZodType>(
  schema: TSchema,
  evidence: unknown,
  kind: ArtifactKind,
): z.infer<TSchema> {
  const parsed = schema.safeParse(evidence);
  if (!parsed.success) {
    throw new Error(`invalid ${kind} artifact evidence`);
  }
  return parsed.data;
}
