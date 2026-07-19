import { createHash } from "node:crypto";

import { z } from "zod";

import { ProjectRevisionSchema } from "../runs/run-contracts.js";

const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const DecimalSchema = z.string().regex(/^\d+$/).max(32);
const SafePathSchema = z.string().min(1).max(1024).refine((value) => {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  return !value.split("/").some((component) => component === "" || component === "." || component === "..");
});

export const IntakeLimitsSchema = z.strictObject({
  maxFileBytes: z.number().int().positive().max(1024 * 1024 * 1024),
  maxFiles: z.number().int().positive().max(10_000),
  maxTotalBytes: z.number().int().positive().max(1024 * 1024 * 1024),
  maxDepth: z.number().int().nonnegative().max(64),
  maxEntries: z.number().int().positive().max(100_000),
  maxDirectoryEntries: z.number().int().positive().max(10_000),
});

export const IntakeArtifactReferenceSchema = z.strictObject({
  artifactId: z.string().regex(/^intake-text-v1:[a-f0-9]{64}$/),
  sha256: DigestSchema,
  sizeBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
}).superRefine((artifact, context) => {
  if (artifact.artifactId !== `intake-text-v1:${artifact.sha256}`) {
    context.addIssue({ code: "custom", message: "intake artifact identity does not match its digest" });
  }
});

export const SourceRejectionReasonSchema = z.enum([
  "aggregate_size_exceeded",
  "binary",
  "changed_during_read",
  "directory_too_many_entries",
  "depth_exceeded",
  "entry_limit_exceeded",
  "file_too_large",
  "invalid_encoding",
  "path_escape",
  "path_too_long",
  "reserved_runtime_state",
  "source_count_exceeded",
  "special_file",
  "symlink",
]);

export const SourceProvenanceSchema = z.strictObject({
  runId: IdSchema,
  projectId: IdSchema,
  projectRevision: ProjectRevisionSchema,
  sourceKind: z.enum(["inline_goal", "ticket_directory"]),
  rootIdentitySha256: DigestSchema,
  device: DecimalSchema.nullable(),
  inode: DecimalSchema.nullable(),
  modifiedNanoseconds: DecimalSchema.nullable(),
  changedNanoseconds: DecimalSchema.nullable(),
}).superRefine((provenance, context) => {
  const identity = [provenance.device, provenance.inode, provenance.modifiedNanoseconds, provenance.changedNanoseconds];
  if (identity.some((value) => value === null) && identity.some((value) => value !== null)) {
    context.addIssue({ code: "custom", message: "source provenance filesystem identity must be complete or absent" });
  }
});

const EvidenceBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: IdSchema,
  projectId: IdSchema,
  commandId: IdSchema,
  requestSha256: DigestSchema,
  eventIndex: z.number().int().nonnegative().max(100_000),
  evidenceCount: z.number().int().positive().max(100_000),
  sourceKind: z.enum(["inline_goal", "ticket_directory"]),
  limits: IntakeLimitsSchema,
  snapshotTotalBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
  path: SafePathSchema,
  provenance: SourceProvenanceSchema,
});

export const SourceDiscoveredPayloadSchema = EvidenceBaseSchema.extend({
  sourceId: z.string().regex(/^source-v1:[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
  digest: DigestSchema,
  trust: z.literal("untrusted_planning_data"),
  mediaType: z.literal("text/plain; charset=utf-8"),
  artifact: IntakeArtifactReferenceSchema,
}).superRefine((payload, context) => {
  const expectedSourceId = `source-v1:${sha256(`${payload.runId}\0${payload.path}\0${payload.digest}`)}`;
  if (payload.sourceId !== expectedSourceId) {
    context.addIssue({ code: "custom", message: "source identity does not match run, path, and digest" });
  }
});

export const SourceRejectedPayloadSchema = EvidenceBaseSchema.extend({
  reason: SourceRejectionReasonSchema,
  sizeBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024).nullable(),
  bytesRead: z.number().int().nonnegative().max(1024 * 1024 * 1024),
  digest: DigestSchema.nullable(),
}).superRefine((payload, context) => {
  if (payload.sizeBytes !== null && payload.bytesRead > payload.sizeBytes) {
    context.addIssue({ code: "custom", message: "rejected source bytes read exceed source size" });
  }
  if (["binary", "invalid_encoding"].includes(payload.reason)
    && (payload.digest === null || payload.sizeBytes === null || payload.bytesRead !== payload.sizeBytes)) {
    context.addIssue({ code: "custom", message: "decoded rejection requires complete digest evidence" });
  }
  const fullyExaminedDigest = ["binary", "invalid_encoding", "aggregate_size_exceeded"].includes(payload.reason)
    && payload.digest !== null
    && payload.sizeBytes !== null
    && payload.bytesRead === payload.sizeBytes;
  if (!["binary", "invalid_encoding"].includes(payload.reason) && payload.digest !== null && !fullyExaminedDigest) {
    context.addIssue({ code: "custom", message: "rejection digest is retained only for completely read decoded input" });
  }
  if (!["binary", "invalid_encoding", "changed_during_read", "aggregate_size_exceeded"].includes(payload.reason)
    && payload.bytesRead !== 0) {
    context.addIssue({ code: "custom", message: "unread rejection cannot claim consumed bytes" });
  }
});

export const IntakeSnapshotClosedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: IdSchema,
  projectId: IdSchema,
  projectRevision: ProjectRevisionSchema,
  commandId: IdSchema,
  requestSha256: DigestSchema,
  sourceKind: z.enum(["inline_goal", "ticket_directory"]),
  limits: IntakeLimitsSchema,
  snapshotSha256: DigestSchema,
  sourceCount: z.number().int().nonnegative().max(10_000),
  rejectedCount: z.number().int().nonnegative().max(100_000),
  totalBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
  evidenceCount: z.number().int().nonnegative().max(100_000),
});

export const IntakeTextArtifactEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mediaType: z.literal("text/plain; charset=utf-8"),
  trust: z.literal("untrusted_planning_data"),
  sha256: DigestSchema,
  sizeBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
  quotedText: z.string(),
});

export type IntakeArtifactReference = z.infer<typeof IntakeArtifactReferenceSchema>;
export type SourceDiscoveredPayload = z.infer<typeof SourceDiscoveredPayloadSchema>;
export type SourceRejectedPayload = z.infer<typeof SourceRejectedPayloadSchema>;
export type IntakeSnapshotClosedPayload = z.infer<typeof IntakeSnapshotClosedPayloadSchema>;
export type IntakeLimits = z.infer<typeof IntakeLimitsSchema>;

export function computeIntakeSnapshotSha256(input: {
  readonly closure: Omit<IntakeSnapshotClosedPayload, "snapshotSha256" | "sourceCount" | "rejectedCount" | "evidenceCount">;
  readonly discovered: readonly SourceDiscoveredPayload[];
  readonly rejected: readonly SourceRejectedPayload[];
}): string {
  const canonical = {
    schemaVersion: 1,
    runId: input.closure.runId,
    projectId: input.closure.projectId,
    projectRevision: input.closure.projectRevision,
    sourceKind: input.closure.sourceKind,
    limits: input.closure.limits,
    sources: input.discovered.map((source) => ({
      sourceId: source.sourceId,
      relativePath: source.path,
      sizeBytes: source.sizeBytes,
      digest: source.digest,
      artifact: source.artifact,
      provenance: source.provenance,
    })),
    rejected: input.rejected.map((source) => ({
      relativePath: source.path,
      reason: source.reason,
      sizeBytes: source.sizeBytes,
      bytesRead: source.bytesRead,
      digest: source.digest,
      provenance: source.provenance,
    })),
    totalBytes: input.closure.totalBytes,
  };
  return sha256(JSON.stringify(canonical));
}

export function computeIntakeArtifactAggregateSha256(sources: readonly {
  readonly sourceId: string;
  readonly relativePath: string;
  readonly artifact: IntakeArtifactReference;
}[]): string {
  return sha256(JSON.stringify(sources.map((source) => ({
    sourceId: source.sourceId,
    relativePath: source.relativePath,
    artifact: source.artifact,
  }))));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
