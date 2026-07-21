import {
  MultiFileWriterRequestSchema,
  type MultiFileWriterRequest,
} from "../contracts/writer-request.js";
import type {
  WriterCapsuleRequest,
  WriterCapsuleResult,
  WriterWorktreeCapsule,
} from "./writer-worktree-capsule.js";
import type { PathClaimService } from "../workspaces/path-claims.js";
import { pathClaimContains } from "../workspaces/path-claims.js";
import type { WorkspaceLease } from "../workspaces/worktree-manager.js";
import {
  isVerifiedOpenCodeProbeReport,
  type OpenCodeProbeReport,
} from "../harnesses/opencode-probe.js";
import { RoleCapabilityBindingSchema } from "../workers/role-capability-envelope.js";
import { digestCanonical } from "../contracts/authority-attention.js";

export interface OpenCodeMultiFileWriterRequest
  extends Omit<WriterCapsuleRequest, "writeClaim" | "executable" | "executableSha256"> {
  readonly probe: OpenCodeProbeReport;
  readonly writer: MultiFileWriterRequest;
  readonly claims: PathClaimService;
  readonly claimId: string;
  readonly correlationId: string;
}

export class OpenCodeMultiFileWriter {
  constructor(private readonly capsule: WriterWorktreeCapsule) {}

  async run(raw: OpenCodeMultiFileWriterRequest): Promise<WriterCapsuleResult> {
    const writer = validateRequest(raw);
    return this.capsule.run({
      ...raw,
      executable: raw.probe.executable!,
      executableSha256: raw.probe.executableSha256!,
      writeClaim: {
        service: raw.claims,
        claimId: raw.claimId,
        ownerId: raw.model.id,
        paths: writer.claimedWritePaths,
        leaseMs: Math.min(writer.checkpoint.maxDurationMs + 30_000, 24 * 60 * 60 * 1_000),
        correlationId: raw.correlationId,
        expectedRevision: writer.baseRevision,
        readPaths: writer.readPaths,
        maxToolCalls: writer.checkpoint.maxToolCalls,
        timeoutMs: writer.checkpoint.maxDurationMs,
      },
    });
  }

  async runCorrection(
    raw: OpenCodeMultiFileWriterRequest,
    correction: {
      readonly correctionId: string;
      readonly paths: readonly string[];
      readonly reason: string;
      readonly lease: WorkspaceLease;
      readonly leaseToken: string;
    },
  ): Promise<WriterCapsuleResult> {
    validateRequest(raw);
    if (correction.paths.length === 0 || correction.paths.some((candidate) => candidate.includes("**"))) {
      throw new Error("writer correction requires exact concrete paths");
    }
    raw.claims.proposeCorrection({
      projectId: raw.project.projectId, claimId: raw.claimId, ownerId: raw.model.id,
      revision: raw.writer.baseRevision, leaseToken: correction.leaseToken,
      correctionId: correction.correctionId, paths: correction.paths, reason: correction.reason,
      correlationId: raw.correlationId,
    });
    return this.run({
      ...raw,
      claimId: `correction:${digestCanonical({ sourceClaimId: raw.claimId, correctionId: correction.correctionId })}`,
      writer: { ...raw.writer, claimedWritePaths: [...correction.paths] },
      retainedLease: correction.lease,
    });
  }
}

function validateRequest(raw: OpenCodeMultiFileWriterRequest): MultiFileWriterRequest {
  const writer = MultiFileWriterRequestSchema.parse(raw.writer);
  if (writer.checkpoint.maxToolCalls !== 1) {
    throw new Error("multi-file OpenCode writer supports only one-effect maxToolCalls mode");
  }
  if (raw.capabilityBinding === undefined) {
    throw new Error("multi-file writer requires a durable capability binding");
  }
  const binding = RoleCapabilityBindingSchema.parse(raw.capabilityBinding);
  if (!isVerifiedOpenCodeProbeReport(raw.probe, {
    modelId: raw.model.id,
    model: raw.model.model,
    provider: raw.model.model.replace(/\/.*/, ""),
    cwd: raw.project.repositoryPath,
  })) {
    throw new Error("multi-file writer requires a verified OpenCode capability probe");
  }
  if (writer.taskId !== raw.task.taskId || writer.projectId !== raw.project.projectId) {
    throw new Error("multi-file writer identity does not match its task and project");
  }
  if (binding.taskId !== writer.taskId || binding.projectId !== writer.projectId ||
    binding.role !== "implementer" || binding.actorId !== raw.model.id) {
    throw new Error("multi-file writer capability binding identity does not match");
  }
  if (!samePaths(writer.readPaths, binding.access.readPaths) ||
    !samePaths(writer.readPaths, raw.security.allowedFileScopes)) {
    throw new Error("multi-file writer read paths do not exactly match security and capability binding");
  }
  if (!samePaths(writer.potentialWritePaths, binding.access.writePaths)) {
    throw new Error("multi-file writer potential paths do not exactly match capability binding");
  }
  const forbidden = [...new Set([...raw.task.forbiddenPaths, ...raw.security.forbiddenPaths])];
  if (!samePaths(writer.forbiddenPaths, binding.access.forbiddenPaths) ||
    !samePaths(writer.forbiddenPaths, forbidden)) {
    throw new Error("multi-file writer forbidden paths do not exactly match durable authority");
  }
  if (writer.claimedWritePaths.some((candidate) =>
    !writer.potentialWritePaths.some((scope) => pathClaimContains(scope, candidate)))) {
    throw new Error("claimed write path is outside the potential write envelope");
  }
  if (writer.potentialWritePaths.some((scope) =>
    !raw.task.ownedPaths.some((owned) => pathClaimContains(owned, scope)))) {
    throw new Error("potential write path is outside durable task ownership");
  }
  return writer;
}

function samePaths(first: readonly string[], second: readonly string[]): boolean {
  return JSON.stringify([...new Set(first)].sort()) === JSON.stringify([...new Set(second)].sort());
}
