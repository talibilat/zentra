import { closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { WriterPatchProposal } from "../contracts/writer-patch.js";
import type { RoleCapabilityBinding } from "../workers/role-capability-envelope.js";
import { pathClaimContains, type PathClaim, type PathClaimService } from "./path-claims.js";
import type { WorkspaceLease } from "./worktree-manager.js";
import { logicalPathScopesOverlap } from "../milestones/path-ownership.js";

export interface TrustedPatchApplyResult {
  readonly proposalDigest: string;
  readonly paths: readonly string[];
  readonly appliedAt: string;
}

export interface PreparedTrustedPatchApplication {
  readonly proposalDigest: string;
}

interface InternalPreparedPatch extends PreparedTrustedPatchApplication {
  readonly input: PatchApplyInput;
  readonly intentId: string;
  readonly expectedStreamVersion: number;
}

interface PatchApplyInput {
  readonly projectId: string;
  readonly correlationId: string;
  readonly lease: WorkspaceLease;
  readonly claim: PathClaim;
  readonly binding: RoleCapabilityBinding;
  readonly proposal: WriterPatchProposal;
}

export class TrustedPatchApplier {
  private readonly prepared = new WeakSet<object>();
  constructor(
    private readonly claims: PathClaimService,
    private readonly afterFileApplied?: (path: string) => void,
  ) {}

  prepare(input: PatchApplyInput): PreparedTrustedPatchApplication {
    this.validate(input);
    const identity = claimIdentity(input);
    const reservation = this.claims.recordPatchProposalAndIntent({ ...identity, proposal: input.proposal });
    const prepared: InternalPreparedPatch = Object.freeze({ proposalDigest: input.proposal.digest, input,
      intentId: reservation.intentId, expectedStreamVersion: reservation.streamVersion });
    this.prepared.add(prepared);
    return prepared;
  }

  recover(input: Omit<PatchApplyInput, "proposal">): TrustedPatchApplyResult {
    const aggregate = this.claims.inspect(input.projectId);
    const claim = aggregate.active.find((candidate) => candidate.claimId === input.claim.claimId);
    if (claim === undefined || claim.patchProposal === null || claim.patchApplicationPending !== claim.patchProposal.digest ||
      claim.patchIntentId === null || claim.patchApplicationStarted || claim.patchAppliedPaths.length !== 0 ||
      claim.patchApplicationCompleted) {
      throw new Error("durable patch intent is not safely recoverable as a proven no-effect application");
    }
    const recovered: PatchApplyInput = { ...input, claim, proposal: claim.patchProposal };
    this.validate(recovered);
    const prepared: InternalPreparedPatch = Object.freeze({ proposalDigest: claim.patchProposal.digest, input: recovered,
      intentId: claim.patchIntentId, expectedStreamVersion: aggregate.streamVersion });
    this.prepared.add(prepared);
    return this.applyPrepared(prepared);
  }

  applyPrepared(rawPrepared: PreparedTrustedPatchApplication): TrustedPatchApplyResult {
    if (!this.prepared.has(rawPrepared)) throw new Error("patch application was not prepared by this trusted applier");
    this.prepared.delete(rawPrepared);
    const preparedCapability = rawPrepared as InternalPreparedPatch;
    const { input } = preparedCapability;
    const { claim, proposal } = input;
    const identity = claimIdentity(input);
    this.claims.recordPatchApplicationStarted({ ...identity, proposalDigest: proposal.digest,
      intentId: preparedCapability.intentId, applicationId: randomUUID(),
      expectedStreamVersion: preparedCapability.expectedStreamVersion });
    const prepared: Array<{ operation: WriterPatchProposal["operations"][number]; temporaryPath: string }> = [];
    const applied: string[] = [];
    try {
      for (const operation of proposal.operations) {
        prepared.push({ operation, temporaryPath: stageContent(input.lease.path, operation.path, operation.content) });
      }
      for (const { operation, temporaryPath } of prepared) {
        assertNoSymlinkTraversal(input.lease.path, operation.path);
        assertPreimage(input.lease.path, operation.path, operation.expectedSha256);
        renameSync(temporaryPath, path.join(input.lease.path, operation.path));
        fsyncDirectory(path.dirname(path.join(input.lease.path, operation.path)));
        applied.push(operation.path);
        this.claims.recordPatchFileApplied({ ...identity, proposalDigest: proposal.digest,
          path: operation.path, expectedSha256: operation.expectedSha256,
          contentSha256: operation.contentSha256 });
        this.afterFileApplied?.(operation.path);
      }
      this.claims.recordPatchApplyCompleted({ ...identity, proposalDigest: proposal.digest, paths: applied });
      return Object.freeze({ proposalDigest: proposal.digest, paths: Object.freeze(applied), appliedAt: new Date().toISOString() });
    } catch (error) {
      this.claims.recordUncertain({ ...identity,
        reason: `trusted patch application requires reconciliation: ${error instanceof Error ? error.message : String(error)}` });
      throw error;
    } finally {
      for (const item of prepared) {
        if (existsSync(item.temporaryPath)) rmSync(item.temporaryPath, { force: true });
      }
    }
  }

  private validate(input: PatchApplyInput): void {
    const { claim, proposal } = input;
    if (proposal.baseRevision !== claim.revision || input.binding.taskId !== input.lease.taskId ||
      input.binding.actorId !== claim.ownerId || claim.workerReceipt === null ||
      claim.workerReceipt.patchProposalDigest !== proposal.digest) {
      throw new Error("patch proposal is not bound to the active supervised claim");
    }
    for (const operation of proposal.operations) {
      if (!claim.paths.some((scope) => pathClaimContains(scope, operation.path)) ||
        !input.binding.access.writePaths.some((scope) => pathClaimContains(scope, operation.path)) ||
        input.binding.access.forbiddenPaths.some((scope) => logicalPathScopesOverlap(scope, operation.path))) {
        throw new Error(`patch operation is outside exact authority: ${operation.path}`);
      }
      assertNoSymlinkTraversal(input.lease.path, operation.path);
      assertPreimage(input.lease.path, operation.path, operation.expectedSha256);
    }
  }
}

function claimIdentity(input: PatchApplyInput) {
  return { projectId: input.projectId, claimId: input.claim.claimId, ownerId: input.claim.ownerId,
    revision: input.claim.revision, leaseToken: input.claim.leaseToken, correlationId: input.correlationId };
}

function stageContent(workspace: string, candidate: string, content: string): string {
  const target = path.join(workspace, candidate);
  mkdirSync(path.dirname(target), { recursive: true });
  const targetMode = existsSync(target) ? existingRegularFileMode(target) : 0o644;
  const temporaryPath = path.join(path.dirname(target), `.zentra-patch-${randomUUID()}.tmp`);
  const descriptor = openSync(temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, targetMode);
  try {
    fchmodSync(descriptor, targetMode);
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return temporaryPath;
}

function existingRegularFileMode(target: string): number {
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("patch target must be a regular file");
  return metadata.mode & 0o777;
}

function assertNoSymlinkTraversal(workspace: string, candidate: string): void {
  let current = workspace;
  for (const segment of candidate.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`patch parent is not a real directory: ${candidate}`);
  }
  const target = path.join(workspace, candidate);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`patch target is a symbolic link: ${candidate}`);
}

function assertPreimage(workspace: string, candidate: string, expectedSha256: string | null): void {
  const target = path.join(workspace, candidate);
  if (expectedSha256 === null) {
    if (existsSync(target)) throw new Error(`patch expected a new file: ${candidate}`);
    return;
  }
  if (!existsSync(target) || !lstatSync(target).isFile()) throw new Error(`patch preimage is unavailable: ${candidate}`);
  const actual = createHash("sha256").update(readFileSync(target)).digest("hex");
  if (actual !== expectedSha256) throw new Error(`patch preimage digest changed: ${candidate}`);
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
