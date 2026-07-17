import { z } from "zod";

const Identity = z.string().min(1).max(256);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const Outcome = z.enum(["completed", "cancelled", "timed_out", "failed"]);
const Argv = z.tuple([z.string().min(1)]).rest(z.string());

export const ReleasePacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  releaseId: Identity,
  milestoneId: Identity,
  taskId: Identity,
  projectId: Identity,
  repositoryPath: z.string().min(1).max(4_096),
  worktreeRoot: z.string().min(1).max(4_096),
  worktreePath: z.string().min(1).max(4_096),
  resultCommit: Commit,
  integrationRef: z.string().min(1).max(4_096),
  securityDigest: Digest,
  authorityDigest: Digest,
  verifierAdmissionDigest: Digest,
  commands: z.strictObject({
    build: z.strictObject({ argv: Argv, timeoutMs: z.number().int().positive() }),
    package: z.strictObject({ argv: Argv, timeoutMs: z.number().int().positive() }),
    verify: z.strictObject({ argv: Argv, timeoutMs: z.number().int().positive() }),
  }),
  artifacts: z.array(z.string().min(1).max(4_096)).min(1).max(256),
});

export const ReleaseOperationBoundPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), releaseId: Identity, taskId: Identity,
  packetDigest: Digest, verifierAdmissionDigest: Digest,
});

export const ReleaseCreatedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), packet: ReleasePacketSchema, packetDigest: Digest,
});
export const ReleaseWorktreeIntentPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), path: z.string().min(1).max(4_096), resultCommit: Commit,
});
export const ReleaseEnvironmentIntentPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), home: z.string().min(1).max(4_096), temporary: z.string().min(1).max(4_096),
});
export const ReleaseRefsSnapshotPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), sha256: Digest, refsSha256: Digest,
});
export const ReleaseStepStartedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), name: z.enum(["build", "package", "verify"]), argvSha256: Digest,
});
export const ReleaseStepObservedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), name: z.enum(["build", "package", "verify"]),
  argvSha256: Digest, outcome: Outcome, exitCode: z.number().int().nullable(),
  stdout: z.string().max(1024 * 1024), stderr: z.string().max(1024 * 1024), outputSha256: Digest,
});
export const ReleaseArtifactPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), path: z.string().min(1).max(4_096), size: z.number().int().nonnegative(), sha256: Digest,
});
export const ReleasePreparedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), status: z.literal("prepared_local_only"),
  blockedOperations: z.tuple([
    z.literal("push"), z.literal("tag"), z.literal("publish"),
    z.literal("pull_request"), z.literal("remote_release"),
  ]),
  message: z.literal("Release artifacts are prepared locally only. Remote release operations remain blocked."),
  authorityModel: z.literal("trusted_project_config"),
  trustedProjectCodeNotice: z.literal("Configured release commands are trusted project code executed with the operating-system authority of the Zentra user; this runner is not a filesystem or network sandbox."),
});
export const ReleaseFailedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), stage: z.enum(["worktree", "artifact", "refs"]),
  reason: z.enum(["uncertain_worktree", "unsafe_artifact", "ref_mutation"]),
  beforeSha256: Digest.optional(), afterSha256: Digest.optional(),
});
export const ReleaseEventReferenceSchema = z.strictObject({
  streamId: Identity, eventId: Identity, eventType: z.string().min(1).max(256),
  streamVersion: z.number().int().positive(), payloadDigest: Digest,
});
export const ReleaseTaskCompletionEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1), releaseStreamId: Identity, packetDigest: Digest,
  resultCommit: Commit, status: z.enum(["prepared_local_only", "failed", "cancelled", "timed_out"]),
  releaseEvents: z.array(ReleaseEventReferenceSchema).length(2),
  artifacts: z.array(z.strictObject({ pathDigest: Digest, size: z.number().int().nonnegative(), sha256: Digest })).max(256),
});
export const ReleaseMilestoneTaskCompletedPayloadSchema = z.strictObject({
  taskId: Identity, actorId: Identity, role: z.literal("verifier"),
  outcome: z.enum(["completed", "cancelled", "timed_out", "failed"]),
  evidence: ReleaseTaskCompletionEvidenceSchema,
});

export function parseReleaseEventPayload(type: string, payload: unknown): unknown {
  if (type === "release.created") return ReleaseCreatedPayloadSchema.parse(payload);
  if (type === "release.worktree_intent") return ReleaseWorktreeIntentPayloadSchema.parse(payload);
  if (type === "release.environment_intent") return ReleaseEnvironmentIntentPayloadSchema.parse(payload);
  if (type === "release.refs_snapshot" || type === "release.refs_verified") return ReleaseRefsSnapshotPayloadSchema.parse(payload);
  if (type === "release.step_started") return ReleaseStepStartedPayloadSchema.parse(payload);
  if (type === "release.step_observed") return ReleaseStepObservedPayloadSchema.parse(payload);
  if (type === "release.artifact_hashed") return ReleaseArtifactPayloadSchema.parse(payload);
  if (type === "release.prepared_local_only") return ReleasePreparedPayloadSchema.parse(payload);
  if (type === "release.failed") return ReleaseFailedPayloadSchema.parse(payload);
  throw new Error(`unknown release event type: ${type}`);
}

export const RELEASE_BLOCKED_OPERATIONS = ["push", "tag", "publish", "pull_request", "remote_release"] as const;
export const RELEASE_PREPARED_MESSAGE = "Release artifacts are prepared locally only. Remote release operations remain blocked.";
export const RELEASE_TRUSTED_PROJECT_NOTICE = "Configured release commands are trusted project code executed with the operating-system authority of the Zentra user; this runner is not a filesystem or network sandbox.";
export type ReleasePacket = z.infer<typeof ReleasePacketSchema>;
export type ReleaseOperationBoundPayload = z.infer<typeof ReleaseOperationBoundPayloadSchema>;
export type ReleaseTaskCompletionEvidence = z.infer<typeof ReleaseTaskCompletionEvidenceSchema>;
