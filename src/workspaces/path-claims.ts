import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { StoredEvent } from "../contracts/event.js";
import { assertCorrectionWithinWriterEnvelope, WriterCheckpointSchema } from "../contracts/writer-request.js";
import { readStreamEvents, type EventJournal } from "../journal/journal.js";
import type { WorkspaceOwnershipGate, WorkspaceOwnershipReport } from "./workspace-ownership.js";
import type { WorkspaceLease, WorktreeManager } from "./worktree-manager.js";
import { canonicalDarwinPathIdentity } from "../milestones/path-ownership.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import { OpenCodeWriterEventChainSchema, type OpenCodeWriterEventChain } from "../agents/opencode-writer-events.js";
import {
  isSupervisedOpenCodeWriterReport,
  type OpenCodeWriterDispatchBinding,
  type OpenCodeWriterReport,
  type OpenCodeWriterUsage,
} from "../harnesses/opencode-writer.js";
import { WriterPatchProposalSchema, type WriterPatchProposal } from "../contracts/writer-patch.js";

const MAX_APPEND_ATTEMPTS = 32;
const RevisionSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const IdentitySchema = z.string().min(1).max(256);
const LeaseTokenSchema = z.string().uuid();
const ClaimPathSchema = z.string().min(1).max(4_096);
const ClaimBodySchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: IdentitySchema, claimId: IdentitySchema,
  ownerId: IdentitySchema, revision: RevisionSchema, paths: z.array(ClaimPathSchema).min(1).max(256),
  canonicalPaths: z.array(ClaimPathSchema).min(1).max(256), leaseToken: LeaseTokenSchema,
  acquiredAt: z.string().datetime(), expiresAt: z.string().datetime(),
});
const ClaimRequestedSchema = ClaimBodySchema.omit({ acquiredAt: true, expiresAt: true });
const ClaimRenewedSchema = z.strictObject({
  claimId: IdentitySchema, ownerId: IdentitySchema, revision: RevisionSchema,
  previousLeaseToken: LeaseTokenSchema, leaseToken: LeaseTokenSchema, expiresAt: z.string().datetime(),
});
const ClaimReleasedSchema = z.strictObject({
  claimId: IdentitySchema, ownerId: IdentitySchema, revision: RevisionSchema,
  leaseToken: LeaseTokenSchema, releasedAt: z.string().datetime(),
});
const ClaimDeniedSchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: IdentitySchema, claimId: IdentitySchema,
  ownerId: IdentitySchema, revision: RevisionSchema, paths: z.array(ClaimPathSchema).min(1).max(256),
  conflictingClaimIds: z.array(IdentitySchema).min(1).max(256), deniedAt: z.string().datetime(),
});
const UncertainSchema = z.strictObject({
  schemaVersion: z.literal(1), claimId: IdentitySchema, revision: RevisionSchema,
  reason: z.string().min(1).max(4_096), observedAt: z.string().datetime(),
});
const CorrectionSchema = z.strictObject({
  schemaVersion: z.literal(1), claimId: IdentitySchema, correctionId: IdentitySchema,
  revision: RevisionSchema, paths: z.array(ClaimPathSchema).min(1).max(256),
  reason: z.string().min(1).max(4_096), proposedAt: z.string().datetime(),
});
const DiffObservedSchema = z.strictObject({
  schemaVersion: z.literal(1), claimId: IdentitySchema, ownerId: IdentitySchema,
  revision: RevisionSchema, leaseToken: LeaseTokenSchema,
  changedPaths: z.array(ClaimPathSchema).max(256), ownershipOutcome: z.enum(["accepted", "rejected"]),
  violations: z.array(z.strictObject({ path: ClaimPathSchema, reason: z.enum([
    "outside_owned_scope", "forbidden_scope", "symbolic_link", "git_state_changed",
  ]) })).max(256),
  diffSha256: z.string().regex(/^[a-f0-9]{64}$/), reconciledAt: z.string().datetime(),
});
const DispatchBindingSchema = z.strictObject({
  schemaVersion: z.literal(1), processIncarnation: z.string().uuid(),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
  argvSha256: z.string().regex(/^[a-f0-9]{64}$/), packetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cwdSha256: z.string().regex(/^[a-f0-9]{64}$/), digest: z.string().regex(/^[a-f0-9]{64}$/),
  dispatchId: IdentitySchema.nullable(), projectId: IdentitySchema.nullable(),
  claimId: IdentitySchema.nullable(), ownerId: IdentitySchema.nullable(),
  revision: RevisionSchema.nullable(), leaseToken: LeaseTokenSchema.nullable(),
}).superRefine((binding, context) => {
  const { digest, ...body } = binding;
  if (digest !== createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex")) {
    context.addIssue({ code: "custom", message: "writer dispatch binding digest mismatch" });
  }
});
const DispatchStartedSchema = z.strictObject({
  schemaVersion: z.literal(1), claimId: IdentitySchema, ownerId: IdentitySchema,
  revision: RevisionSchema, leaseToken: LeaseTokenSchema, dispatchId: IdentitySchema,
  binding: DispatchBindingSchema, startedAt: z.string().datetime(),
});
const WriterUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().max(2_000_000),
  outputTokens: z.number().int().nonnegative().max(2_000_000),
  reasoningTokens: z.number().int().nonnegative().max(2_000_000),
  cacheReadTokens: z.number().int().nonnegative().max(2_000_000),
  cacheWriteTokens: z.number().int().nonnegative().max(2_000_000),
  toolCalls: z.number().int().nonnegative().max(100_000),
});
const WriterReceiptBodySchema = z.strictObject({
  schemaVersion: z.literal(1), receiptId: IdentitySchema, claimId: IdentitySchema,
  ownerId: IdentitySchema, revision: RevisionSchema, leaseToken: LeaseTokenSchema,
  dispatchId: IdentitySchema, outcome: z.enum(["completed", "cancelled", "timed_out", "failed"]),
  dispatchBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  eventChain: OpenCodeWriterEventChainSchema, usage: WriterUsageSchema,
  stdoutSha256: z.string().regex(/^[a-f0-9]{64}$/), stderrSha256: z.string().regex(/^[a-f0-9]{64}$/),
  protocolFailure: z.literal("invalid_native_event_stream").nullable(),
  usageEvidence: z.enum(["native_tokens", "legacy_usage", "none"]),
  patchProposalDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
});
export const WriterReceiptSchema = WriterReceiptBodySchema.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((receipt, context) => {
  const { digest, ...body } = receipt;
  if (digest !== digestCanonical(body)) context.addIssue({ code: "custom", message: "writer receipt digest mismatch" });
  const observedToolCalls = receipt.eventChain.events.filter((event) =>
    event.type === "tool_use" && event.status !== "denied" && event.tool !== null).length;
  if (observedToolCalls !== receipt.usage.toolCalls) {
    context.addIssue({ code: "custom", message: "writer receipt tool usage does not match retained event chain" });
  }
  if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) {
    context.addIssue({ code: "custom", message: "writer receipt finished before it started" });
  }
});
const EvidenceMissingSchema = z.strictObject({
  schemaVersion: z.literal(1), claimId: IdentitySchema, revision: RevisionSchema,
  dispatchId: IdentitySchema, missing: z.enum(["worker_event_usage_receipt", "patch_proposal_or_intent"]),
  observedAt: z.string().datetime(),
});
const PatchProposalRecordedSchema = z.strictObject({
  schemaVersion: z.literal(1), claimId: IdentitySchema, proposal: WriterPatchProposalSchema,
  recordedAt: z.string().datetime(),
});
const PatchApplicationIntendedSchema = z.strictObject({
  schemaVersion: z.literal(1), intentId: z.string().uuid(), claimId: IdentitySchema, ownerId: IdentitySchema,
  revision: RevisionSchema, leaseToken: LeaseTokenSchema, proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operations: z.array(z.strictObject({ path: ClaimPathSchema, expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(256),
  startedAt: z.string().datetime(),
});
const PatchApplicationStartedSchema = z.strictObject({
  schemaVersion: z.literal(1), claimId: IdentitySchema,
  intentId: z.string().uuid(), proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  applicationId: z.string().uuid(), expectedStreamVersion: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
});
const PatchFileAppliedSchema = z.strictObject({
  schemaVersion: z.literal(1), claimId: IdentitySchema, proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  path: ClaimPathSchema, expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/), appliedAt: z.string().datetime(),
});
const PatchApplyCompletedSchema = z.strictObject({
  schemaVersion: z.literal(1), claimId: IdentitySchema, proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  paths: z.array(ClaimPathSchema).min(1).max(256), completedAt: z.string().datetime(),
});

export type WriterReceipt = z.infer<typeof WriterReceiptSchema>;
const APPEND_SUPERVISED_RECEIPT = Symbol("append-supervised-writer-receipt");

export interface SupervisedWriterReceiptContext {
  readonly projectId: string;
  readonly claimId: string;
  readonly ownerId: string;
  readonly revision: string;
  readonly correlationId: string;
  readonly leaseToken: string;
  readonly dispatchId: string;
}

export interface PatchIntentReservation {
  readonly intentId: string;
  readonly streamVersion: number;
}

export interface PathClaim {
  readonly projectId: string;
  readonly claimId: string;
  readonly ownerId: string;
  readonly revision: string;
  readonly paths: readonly string[];
  readonly canonicalPaths: readonly string[];
  readonly leaseToken: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly status: "active";
  readonly requiresReconciliation: boolean;
  readonly dispatchAuthorized: boolean;
  readonly dispatchId: string | null;
  readonly dispatchBinding: OpenCodeWriterDispatchBinding | null;
  readonly workerReceipt: WriterReceipt | null;
  readonly patchApplicationPending: string | null;
  readonly patchIntentId: string | null;
  readonly patchProposal: WriterPatchProposal | null;
  readonly patchApplicationStarted: boolean;
  readonly patchAppliedPaths: readonly string[];
  readonly patchApplicationCompleted: boolean;
}

export interface PathClaimAggregate {
  readonly projectId: string;
  readonly streamVersion: number;
  readonly active: readonly PathClaim[];
  readonly acquiredClaimIds: readonly string[];
}

export type PathClaimReconciliation =
  | { readonly classification: "effect_observed"; readonly claim: PathClaim;
      readonly ownership: WorkspaceOwnershipReport; readonly diffSha256: string;
      readonly checkpointId: string; readonly reconciledAt: string }
  | { readonly classification: "effect_observed_pending_evidence"; readonly claim: PathClaim;
      readonly ownership: WorkspaceOwnershipReport; readonly diffSha256: string;
      readonly missing: "worker_event_usage_receipt" | "patch_proposal_or_intent"; readonly reconciledAt: string }
  | { readonly classification: "no_effect"; readonly claim: PathClaim;
      readonly ownership: WorkspaceOwnershipReport; readonly diffSha256: string;
      readonly reconciledAt: string }
  | { readonly classification: "patch_application_prepared"; readonly claim: PathClaim;
      readonly ownership: WorkspaceOwnershipReport; readonly diffSha256: string;
      readonly reconciledAt: string }
  | { readonly classification: "uncertain"; readonly claim: PathClaim;
      readonly ownership: WorkspaceOwnershipReport | null; readonly reason: string;
      readonly reconciledAt: string };

interface ClaimCommandIdentity {
  readonly projectId: string;
  readonly claimId: string;
  readonly ownerId: string;
  readonly revision: string;
  readonly correlationId: string;
}

export class PathClaimConflictError extends Error {
  override readonly name = "PathClaimConflictError";
  constructor(readonly conflictingClaimIds: readonly string[]) {
    super(`path claim overlaps active claim: ${conflictingClaimIds.join(", ")}`);
  }
}

export class PathClaimService {
  constructor(
    private readonly journal: EventJournal,
    private readonly now: () => Date = () => new Date(),
  ) {}

  acquire(input: ClaimCommandIdentity & {
    readonly paths: readonly string[];
    readonly leaseMs: number;
  }): PathClaim {
    validateLease(input.leaseMs);
    const paths = canonicalInputSet(input.paths);
    const canonicalPaths = paths.map(canonicalDarwinClaimPath);
    if (new Set(canonicalPaths).size !== canonicalPaths.length) {
      throw new Error("path claim contains Darwin-equivalent duplicate paths");
    }
    const leaseToken = randomUUID();
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const aggregate = this.inspect(input.projectId);
      const existing = aggregate.active.find((claim) => claim.claimId === input.claimId);
      if (existing !== undefined) {
        if (sameAcquisition(existing, input, paths)) return existing;
        throw new Error("path claim identity was already used with different authority");
      }
      if (aggregate.acquiredClaimIds.includes(input.claimId)) {
        throw new Error("path claim identity is immutable after release or expiry");
      }
      const conflicts = aggregate.active.filter((claim) =>
        pathSetsOverlap(claim.canonicalPaths, canonicalPaths));
      const streamId = pathClaimStreamId(input.projectId);
      const requested = {
        schemaVersion: 1 as const, projectId: input.projectId, claimId: input.claimId,
        ownerId: input.ownerId, revision: RevisionSchema.parse(input.revision), paths,
        canonicalPaths, leaseToken,
      };
      const at = this.now().toISOString();
      const events = conflicts.length === 0
        ? [event(streamId, "path_claim.requested", ClaimRequestedSchema.parse(requested), input.correlationId),
          event(streamId, "path_claim.acquired", ClaimBodySchema.parse({
            ...requested, acquiredAt: at, expiresAt: new Date(Date.parse(at) + input.leaseMs).toISOString(),
          }), input.correlationId)]
        : [event(streamId, "path_claim.requested", ClaimRequestedSchema.parse(requested), input.correlationId),
          event(streamId, "path_claim.denied", ClaimDeniedSchema.parse({
            schemaVersion: 1, projectId: input.projectId, claimId: input.claimId,
            ownerId: input.ownerId, revision: input.revision, paths,
            conflictingClaimIds: conflicts.map((claim) => claim.claimId), deniedAt: at,
          }), input.correlationId)];
      try {
        this.journal.append(streamId, aggregate.streamVersion, events);
        if (conflicts.length > 0) throw new PathClaimConflictError(conflicts.map((claim) => claim.claimId));
        return this.requiredActive(input.projectId, input.claimId);
      } catch (error) {
        if (error instanceof PathClaimConflictError) throw error;
        if (!isVersionConflict(error)) throw error;
      }
    }
    throw new Error("path claim arbitration did not converge");
  }

  renew(input: ClaimCommandIdentity & { readonly leaseToken: string; readonly leaseMs: number }): PathClaim {
    validateLease(input.leaseMs);
    return this.mutateActive(input, (claim, streamId, aggregate) => {
      const at = this.now().toISOString();
      const leaseToken = randomUUID();
      const expiresAt = new Date(Date.parse(at) + input.leaseMs).toISOString();
      if (Date.parse(expiresAt) <= Date.parse(claim.expiresAt)) {
        throw new Error("path claim renewal must extend the active lease");
      }
      this.journal.append(streamId, aggregate.streamVersion, [event(streamId, "path_claim.renewed", ClaimRenewedSchema.parse({
        claimId: claim.claimId, ownerId: claim.ownerId, revision: claim.revision,
        previousLeaseToken: claim.leaseToken, leaseToken,
        expiresAt,
      }), input.correlationId)]);
      return this.requiredActive(input.projectId, input.claimId);
    });
  }

  release(input: ClaimCommandIdentity & { readonly leaseToken: string }): void {
    this.mutateActive(input, (claim, streamId, aggregate) => {
      this.journal.append(streamId, aggregate.streamVersion, [event(streamId, "path_claim.released", ClaimReleasedSchema.parse({
        claimId: claim.claimId, ownerId: claim.ownerId, revision: claim.revision,
        leaseToken: claim.leaseToken, releasedAt: this.now().toISOString(),
      }), input.correlationId)]);
    });
  }

  checkpoint(input: ClaimCommandIdentity & {
    readonly leaseToken: string; readonly checkpointId: string; readonly diffSha256: string;
    readonly toolEvidenceSha256: string;
    readonly usage: OpenCodeWriterUsage;
  }): void {
    const claim = this.assertActiveIdentity(this.inspect(input.projectId), input);
    if (claim.workerReceipt === null ||
      input.toolEvidenceSha256 !== claim.workerReceipt.eventChain.chainSha256 ||
      digestCanonical(input.usage) !== digestCanonical(claim.workerReceipt.usage)) {
      throw new Error("writer checkpoint requires the exact retained event and usage receipt");
    }
    this.appendClaimEvidence(input, "writer.checkpointed", WriterCheckpointSchema.parse({
      schemaVersion: 1, checkpointId: input.checkpointId, claimId: input.claimId,
      revision: input.revision, diffSha256: input.diffSha256,
      toolEvidenceSha256: input.toolEvidenceSha256, usage: input.usage,
      recordedAt: this.now().toISOString(),
    }));
  }

  recordUncertain(input: ClaimCommandIdentity & { readonly leaseToken: string; readonly reason: string }): void {
    this.appendClaimEvidence(input, "writer.effect_uncertain", UncertainSchema.parse({
      schemaVersion: 1, claimId: input.claimId, revision: input.revision,
      reason: z.string().min(1).max(4_096).parse(input.reason), observedAt: this.now().toISOString(),
    }));
  }

  beginDispatch(input: ClaimCommandIdentity & {
    readonly leaseToken: string;
    readonly dispatchId: string;
    readonly binding: OpenCodeWriterDispatchBinding;
  }): void {
    const aggregate = this.inspect(input.projectId);
    const claim = this.assertActiveIdentity(aggregate, input);
    if (claim.requiresReconciliation) {
      throw new Error("path claim requires workspace reconciliation before restart dispatch");
    }
    if (!claim.dispatchAuthorized) {
      throw new Error("path claim requires accepted reconciliation or correction before another dispatch");
    }
    if (input.binding.dispatchId !== input.dispatchId || input.binding.projectId !== input.projectId ||
      input.binding.claimId !== input.claimId || input.binding.ownerId !== input.ownerId ||
      input.binding.revision !== input.revision || input.binding.leaseToken !== input.leaseToken) {
      throw new Error("writer dispatch binding does not match exact claim authority");
    }
    const streamId = pathClaimStreamId(input.projectId);
    this.journal.append(streamId, aggregate.streamVersion, [event(streamId, "writer.dispatch_started", DispatchStartedSchema.parse({
      schemaVersion: 1, claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, leaseToken: claim.leaseToken,
      dispatchId: input.dispatchId, binding: input.binding, startedAt: this.now().toISOString(),
    }), input.correlationId)]);
  }

  [APPEND_SUPERVISED_RECEIPT](
    input: SupervisedWriterReceiptContext,
    report: OpenCodeWriterReport,
    binding: OpenCodeWriterDispatchBinding,
  ): WriterReceipt {
    if (!isSupervisedOpenCodeWriterReport(report, binding)) {
      throw new Error("writer receipt report was not issued by the supervised writer execution path");
    }
    const aggregate = this.inspect(input.projectId);
    const claim = this.assertActiveIdentity(aggregate, input);
    if (binding.dispatchId !== input.dispatchId || binding.projectId !== input.projectId ||
      binding.claimId !== input.claimId || binding.ownerId !== input.ownerId ||
      binding.revision !== input.revision || binding.leaseToken !== input.leaseToken) {
      throw new Error("supervised writer report is bound to a different durable dispatch authority");
    }
    if (claim.dispatchId !== input.dispatchId || claim.dispatchBinding?.digest !== binding.digest ||
      !claim.requiresReconciliation || claim.workerReceipt !== null) {
      throw new Error("writer receipt does not match the active unsettled dispatch");
    }
    const body = WriterReceiptBodySchema.parse({
      schemaVersion: 1, receiptId: binding.processIncarnation, claimId: claim.claimId,
      ownerId: claim.ownerId, revision: claim.revision, leaseToken: claim.leaseToken,
      dispatchId: input.dispatchId, dispatchBindingDigest: binding.digest,
      outcome: report.outcome, eventChain: report.eventChain,
      usage: report.usage, stdoutSha256: report.stdoutSha256, stderrSha256: report.stderrSha256,
      protocolFailure: report.protocolFailure, usageEvidence: report.usageEvidence,
      patchProposalDigest: report.patchProposal?.digest ?? null,
      startedAt: report.startedAt, finishedAt: report.finishedAt,
    });
    const receipt = WriterReceiptSchema.parse({ ...body, digest: digestCanonical(body) });
    const streamId = pathClaimStreamId(input.projectId);
    this.journal.append(streamId, aggregate.streamVersion, [event(
      streamId, "writer.receipt_observed", receipt, input.correlationId,
    )]);
    return receipt;
  }

  recordPatchProposalAndIntent(input: ClaimCommandIdentity & { readonly leaseToken: string;
    readonly proposal: WriterPatchProposal }): PatchIntentReservation {
    const aggregate = this.inspect(input.projectId);
    const claim = this.assertActiveIdentity(aggregate, input);
    if (claim.workerReceipt === null || claim.workerReceipt.patchProposalDigest !== input.proposal.digest) {
      throw new Error("patch application requires its exact supervised proposal receipt");
    }
    const streamId = pathClaimStreamId(input.projectId);
    const now = this.now().toISOString();
    const intentId = randomUUID();
    const stored = this.journal.append(streamId, aggregate.streamVersion, [
      event(streamId, "writer.patch_proposal_recorded", PatchProposalRecordedSchema.parse({
        schemaVersion: 1, claimId: claim.claimId, proposal: input.proposal, recordedAt: now,
      }), input.correlationId),
      event(streamId, "writer.patch_application_intended", PatchApplicationIntendedSchema.parse({
        schemaVersion: 1, intentId, claimId: claim.claimId, ownerId: claim.ownerId,
        revision: claim.revision, leaseToken: claim.leaseToken, proposalDigest: input.proposal.digest,
        operations: input.proposal.operations.map(({ path: operationPath, expectedSha256, contentSha256 }) =>
          ({ path: operationPath, expectedSha256, contentSha256 })), startedAt: now,
      }), input.correlationId),
    ]);
    return Object.freeze({ intentId, streamVersion: stored.at(-1)!.streamVersion });
  }

  recordPatchApplicationStarted(input: ClaimCommandIdentity & { readonly leaseToken: string;
    readonly intentId: string; readonly proposalDigest: string; readonly applicationId: string;
    readonly expectedStreamVersion: number }): void {
    const aggregate = this.inspect(input.projectId);
    const claim = this.assertActiveIdentity(aggregate, input);
    if (aggregate.streamVersion !== input.expectedStreamVersion || claim.patchIntentId !== input.intentId ||
      claim.patchApplicationPending !== input.proposalDigest || claim.patchApplicationStarted) {
      throw new Error("patch application start lost optimistic intent CAS");
    }
    const streamId = pathClaimStreamId(input.projectId);
    this.journal.append(streamId, input.expectedStreamVersion, [event(
      streamId, "writer.patch_application_started", PatchApplicationStartedSchema.parse({
        schemaVersion: 1, claimId: input.claimId, intentId: input.intentId,
        proposalDigest: input.proposalDigest, applicationId: input.applicationId,
        expectedStreamVersion: input.expectedStreamVersion, startedAt: this.now().toISOString(),
      }), input.correlationId,
    )]);
  }

  recordPatchFileApplied(input: ClaimCommandIdentity & { readonly leaseToken: string;
    readonly proposalDigest: string; readonly path: string; readonly expectedSha256: string | null;
    readonly contentSha256: string }): void {
    this.appendClaimEvidence(input, "writer.patch_file_applied", PatchFileAppliedSchema.parse({
      schemaVersion: 1, claimId: input.claimId, proposalDigest: input.proposalDigest,
      path: input.path, expectedSha256: input.expectedSha256, contentSha256: input.contentSha256,
      appliedAt: this.now().toISOString(),
    }));
  }

  recordPatchApplyCompleted(input: ClaimCommandIdentity & { readonly leaseToken: string;
    readonly proposalDigest: string; readonly paths: readonly string[] }): void {
    this.appendClaimEvidence(input, "writer.patch_apply_completed", PatchApplyCompletedSchema.parse({
      schemaVersion: 1, claimId: input.claimId, proposalDigest: input.proposalDigest,
      paths: [...input.paths], completedAt: this.now().toISOString(),
    }));
  }

  proposeCorrection(input: ClaimCommandIdentity & {
    readonly leaseToken: string; readonly correctionId: string; readonly paths: readonly string[];
    readonly reason: string;
  }): void {
    const claim = this.historicalClaim(input.projectId, input.claimId);
    if (claim.ownerId !== input.ownerId || claim.revision !== input.revision ||
      claim.leaseToken !== input.leaseToken) throw new Error("writer correction source claim identity does not match");
    const paths = canonicalInputSet(input.paths);
    assertCorrectionWithinWriterEnvelope(claim.paths, paths);
    const aggregate = this.inspect(input.projectId);
    const streamId = pathClaimStreamId(input.projectId);
    this.journal.append(streamId, aggregate.streamVersion, [event(streamId, "writer.correction_proposed", CorrectionSchema.parse({
      schemaVersion: 1, claimId: input.claimId, correctionId: IdentitySchema.parse(input.correctionId),
      revision: input.revision, paths, reason: z.string().min(1).max(4_096).parse(input.reason),
      proposedAt: this.now().toISOString(),
    }), input.correlationId)]);
  }

  async reconcileWorkspace(input: ClaimCommandIdentity & {
    readonly leaseToken: string;
    readonly lease: WorkspaceLease;
    readonly forbiddenPaths: readonly string[];
  }, dependencies: {
    readonly ownership: WorkspaceOwnershipGate;
    readonly worktrees: WorktreeManager;
  }): Promise<PathClaimReconciliation> {
    const aggregate = this.inspect(input.projectId);
    const claim = this.assertActiveIdentity(aggregate, input);
    try {
      const ownership = await dependencies.ownership.inspect(
        input.lease, claim.revision, claim.paths, input.forbiddenPaths,
      );
      const inspected = await dependencies.worktrees.inspect(input.lease);
      const diffSha256 = createHash("sha256").update(inspected.diff, "utf8").digest("hex");
      const reconciledAt = this.now().toISOString();
      const streamId = pathClaimStreamId(input.projectId);
      const observed = event(streamId, "path_claim.diff_observed", DiffObservedSchema.parse({
        schemaVersion: 1, claimId: claim.claimId, ownerId: claim.ownerId,
        revision: claim.revision, leaseToken: claim.leaseToken,
        changedPaths: ownership.changedPaths, ownershipOutcome: ownership.outcome,
        violations: ownership.violations, diffSha256, reconciledAt,
      }), input.correlationId);
      if (ownership.outcome !== "accepted") {
        const reason = "retained writer diff is outside its active path claim";
        this.journal.append(streamId, aggregate.streamVersion, [observed, event(
          streamId, "writer.effect_uncertain", UncertainSchema.parse({
            schemaVersion: 1, claimId: claim.claimId, revision: claim.revision,
            reason, observedAt: reconciledAt,
          }), input.correlationId,
        )]);
        return Object.freeze({ classification: "uncertain", claim, ownership, reason, reconciledAt });
      }
      if (claim.workerReceipt !== null &&
        (claim.patchProposal === null || claim.patchApplicationPending === null) &&
        !claim.patchApplicationCompleted) {
        if (claim.dispatchId === null) throw new Error("proposal receipt has no dispatch identity");
        this.journal.append(streamId, aggregate.streamVersion, [observed, event(
          streamId, "writer.evidence_missing", EvidenceMissingSchema.parse({
            schemaVersion: 1, claimId: claim.claimId, revision: claim.revision,
            dispatchId: claim.dispatchId, missing: "patch_proposal_or_intent", observedAt: reconciledAt,
          }), input.correlationId,
        )]);
        return Object.freeze({ classification: "effect_observed_pending_evidence", claim, ownership,
          diffSha256, missing: "patch_proposal_or_intent", reconciledAt });
      }
      if (claim.patchApplicationPending !== null && !claim.patchApplicationStarted &&
        claim.patchAppliedPaths.length === 0 && claim.patchProposal !== null &&
        proposalPreimagesMatch(input.lease.path, claim.patchProposal)) {
        this.journal.append(streamId, aggregate.streamVersion, [observed, event(
          streamId, "writer.effect_uncertain", UncertainSchema.parse({
            schemaVersion: 1, claimId: claim.claimId, revision: claim.revision,
            reason: "durable patch intent is recoverable only through the trusted single-use applier",
            observedAt: reconciledAt,
          }), input.correlationId,
        )]);
        return Object.freeze({ classification: "patch_application_prepared", claim, ownership,
          diffSha256, reconciledAt });
      }
      if (claim.patchApplicationPending !== null) {
        const reason = "trusted patch application has started or partial per-file evidence";
        this.journal.append(streamId, aggregate.streamVersion, [observed, event(
          streamId, "writer.effect_uncertain", UncertainSchema.parse({
            schemaVersion: 1, claimId: claim.claimId, revision: claim.revision,
            reason, observedAt: reconciledAt,
          }), input.correlationId,
        )]);
        return Object.freeze({ classification: "uncertain", claim, ownership, reason, reconciledAt });
      }
      if (ownership.changedPaths.length === 0 && inspected.diff === "" && claim.workerReceipt === null) {
        this.journal.append(streamId, aggregate.streamVersion, [observed]);
        return Object.freeze({ classification: "no_effect", claim, ownership, diffSha256, reconciledAt });
      }
      if (claim.workerReceipt === null) {
        if (claim.dispatchId === null) throw new Error("retained effect has no dispatch identity");
        this.journal.append(streamId, aggregate.streamVersion, [
          observed,
          event(streamId, "writer.evidence_missing", EvidenceMissingSchema.parse({
            schemaVersion: 1, claimId: claim.claimId, revision: claim.revision,
            dispatchId: claim.dispatchId, missing: "worker_event_usage_receipt", observedAt: reconciledAt,
          }), input.correlationId),
        ]);
        return Object.freeze({
          classification: "effect_observed_pending_evidence", claim, ownership, diffSha256,
          missing: "worker_event_usage_receipt", reconciledAt,
        });
      }
      const checkpointId = `${claim.claimId}:reconciled:${randomUUID()}`;
      this.journal.append(streamId, aggregate.streamVersion, [
        observed,
        event(streamId, "writer.checkpointed", WriterCheckpointSchema.parse({
          schemaVersion: 1, checkpointId, claimId: claim.claimId, revision: claim.revision,
          diffSha256, toolEvidenceSha256: claim.workerReceipt.eventChain.chainSha256,
          usage: claim.workerReceipt.usage, recordedAt: reconciledAt,
        }), input.correlationId),
        event(streamId, "path_claim.released", ClaimReleasedSchema.parse({
          claimId: claim.claimId, ownerId: claim.ownerId, revision: claim.revision,
          leaseToken: claim.leaseToken, releasedAt: reconciledAt,
        }), input.correlationId),
      ]);
      return Object.freeze({
        classification: "effect_observed", claim, ownership, diffSha256, checkpointId, reconciledAt,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        this.recordUncertain({
          ...input,
          reason,
        });
      } catch (uncertaintyError) {
        throw new AggregateError([error, uncertaintyError], "workspace reconciliation failed and uncertainty could not be recorded");
      }
      return Object.freeze({
        classification: "uncertain", claim, ownership: null, reason, reconciledAt: this.now().toISOString(),
      });
    }
  }

  inspect(projectId: string): PathClaimAggregate {
    IdentitySchema.parse(projectId);
    const events = readStreamEvents(this.journal, pathClaimStreamId(projectId));
    const active = new Map<string, PathClaim>();
    const history = new Map<string, PathClaim>();
    const acquiredClaimIds = new Set<string>();
    for (const [index, stored] of events.entries()) {
      projectClaimEvent(projectId, stored, events[index - 1], active, history);
    }
    for (const stored of events) {
      if (stored.type === "path_claim.acquired") acquiredClaimIds.add(ClaimBodySchema.parse(stored.payload).claimId);
    }
    const now = this.now().getTime();
    return Object.freeze({
      projectId,
      streamVersion: events.at(-1)?.streamVersion ?? 0,
      active: Object.freeze([...active.values()].filter((claim) => Date.parse(claim.expiresAt) > now)
        .sort((left, right) => left.claimId.localeCompare(right.claimId))),
      acquiredClaimIds: Object.freeze([...acquiredClaimIds].sort()),
    });
  }

  private appendClaimEvidence(input: ClaimCommandIdentity & { readonly leaseToken: string }, type: string, payload: unknown): void {
    this.mutateActive(input, (_claim, streamId, aggregate) => {
      this.journal.append(streamId, aggregate.streamVersion, [event(streamId, type, payload, input.correlationId)]);
    });
  }

  private mutateActive<T>(
    input: ClaimCommandIdentity & { readonly leaseToken: string },
    mutation: (claim: PathClaim, streamId: string, aggregate: PathClaimAggregate) => T,
  ): T {
    const aggregate = this.inspect(input.projectId);
    const claim = this.assertActiveIdentity(aggregate, input);
    return mutation(claim, pathClaimStreamId(input.projectId), aggregate);
  }

  private assertActiveIdentity(
    aggregate: PathClaimAggregate,
    input: ClaimCommandIdentity & { readonly leaseToken: string },
  ): PathClaim {
    const claim = aggregate.active.find((candidate) => candidate.claimId === input.claimId);
    if (claim === undefined) throw new Error("path claim is not active");
    if (claim.ownerId !== input.ownerId) throw new Error("path claim owner does not match");
    if (claim.revision !== input.revision) throw new Error("path claim revision does not match");
    if (claim.leaseToken !== input.leaseToken) throw new Error("path claim lease token does not match");
    return claim;
  }

  private requiredActive(projectId: string, claimId: string): PathClaim {
    const claim = this.inspect(projectId).active.find((candidate) => candidate.claimId === claimId);
    if (claim === undefined) throw new Error("acquired path claim is not active");
    return claim;
  }

  private historicalClaim(projectId: string, claimId: string): PathClaim {
    let found: PathClaim | null = null;
    for (const stored of readStreamEvents(this.journal, pathClaimStreamId(projectId))) {
      if (stored.type === "path_claim.acquired") {
        const payload = ClaimBodySchema.parse(stored.payload);
        if (payload.claimId === claimId) {
          found = { ...payload, status: "active", requiresReconciliation: false,
            dispatchAuthorized: false, dispatchId: null, dispatchBinding: null, workerReceipt: null,
            patchApplicationPending: null, patchIntentId: null, patchProposal: null, patchApplicationStarted: false,
            patchAppliedPaths: Object.freeze([]), patchApplicationCompleted: false };
        }
      } else if (stored.type === "path_claim.renewed" && found !== null) {
        const payload = ClaimRenewedSchema.parse(stored.payload);
        if (payload.claimId === claimId) {
          const current: PathClaim = found;
          found = { ...current, leaseToken: payload.leaseToken, expiresAt: payload.expiresAt };
        }
      }
    }
    if (found === null) throw new Error("writer correction source claim does not exist");
    return found;
  }
}

/** Internal orchestration seam. Structural reports are rejected by the supervised-report brand. */
export function appendSupervisedWriterReceipt(
  service: PathClaimService,
  context: SupervisedWriterReceiptContext,
  report: OpenCodeWriterReport,
  binding: OpenCodeWriterDispatchBinding,
): WriterReceipt {
  return service[APPEND_SUPERVISED_RECEIPT](context, report, binding);
}

export function pathClaimStreamId(projectId: string): string {
  return `path-claims:${IdentitySchema.parse(projectId)}`;
}

export function canonicalDarwinClaimPath(candidate: string): string {
  if (candidate !== candidate.normalize("NFC")) throw new Error("path claim must use NFC Unicode normalization");
  if (candidate !== "**" && candidate.includes("*")) {
    if (!candidate.endsWith("/**") || candidate.slice(0, -3).includes("*")) {
      throw new Error("path claim supports only a terminal recursive scope");
    }
  }
  const base = candidate === "**" ? "" : candidate.replace(/\/\*\*$/, "");
  if (candidate.startsWith("/") || candidate.includes("\\") || candidate.includes("\0") ||
      candidate.includes("\n") || candidate.includes("\r")) throw new Error("path claim must be repository-relative");
  const segments = base.split("/");
  if (base !== "" && segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("path claim contains traversal or an empty segment");
  }
  const canonical = canonicalDarwinPathIdentity(base);
  if (canonical === ".git" || canonical.startsWith(".git/") || canonical === ".env" || canonical.startsWith(".env.")) {
    throw new Error("path claim targets a protected path");
  }
  return canonical;
}

export function pathClaimContains(claimPath: string, candidatePath: string): boolean {
  const claim = canonicalDarwinClaimPath(claimPath);
  const candidate = canonicalDarwinClaimPath(candidatePath);
  return claimPath === "**" || claimPath.endsWith("/**")
    ? candidate === claim || candidate.startsWith(`${claim}/`)
    : candidate === claim;
}

function projectClaimEvent(
  projectId: string,
  event: StoredEvent,
  previous: StoredEvent | undefined,
  active: Map<string, PathClaim>,
  history: Map<string, PathClaim>,
): void {
  if (event.streamId !== pathClaimStreamId(projectId)) throw new Error("path claim stream identity mismatch");
  if (event.type === "path_claim.requested") {
    assertClaimRequest(projectId, ClaimRequestedSchema.parse(event.payload));
    return;
  }
  if (event.type === "path_claim.denied") {
    const payload = ClaimDeniedSchema.parse(event.payload);
    const requested = previous?.type === "path_claim.requested"
      ? ClaimRequestedSchema.parse(previous.payload) : null;
    if (payload.projectId !== projectId || requested === null ||
      !sameRequestFields(requested, payload)) throw new Error("path claim denial has no matching request");
    return;
  }
  if (event.type === "writer.checkpointed") {
    const payload = WriterCheckpointSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim?.revision !== payload.revision) throw new Error("writer checkpoint has no active revision-bound claim");
    if (claim.workerReceipt === null ||
      payload.toolEvidenceSha256 !== claim.workerReceipt.eventChain.chainSha256 ||
      digestCanonical(payload.usage) !== digestCanonical(claim.workerReceipt.usage)) {
      throw new Error("writer checkpoint lacks an exact retained worker receipt");
    }
    active.set(payload.claimId, Object.freeze({
      ...claim, requiresReconciliation: false, dispatchAuthorized: false,
    }));
    return;
  }
  if (event.type === "writer.dispatch_started") {
    const payload = DispatchStartedSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim === undefined || claim.ownerId !== payload.ownerId || claim.revision !== payload.revision ||
      claim.leaseToken !== payload.leaseToken || claim.requiresReconciliation ||
      payload.binding.dispatchId !== payload.dispatchId || payload.binding.projectId !== projectId ||
      payload.binding.claimId !== payload.claimId || payload.binding.ownerId !== payload.ownerId ||
      payload.binding.revision !== payload.revision || payload.binding.leaseToken !== payload.leaseToken) {
      throw new Error("writer dispatch has no reconciled active claim");
    }
    active.set(payload.claimId, Object.freeze({
      ...claim, requiresReconciliation: true, dispatchAuthorized: false,
      dispatchId: payload.dispatchId, dispatchBinding: payload.binding, workerReceipt: null,
    }));
    return;
  }
  if (event.type === "writer.receipt_observed") {
    const payload = WriterReceiptSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim === undefined || claim.ownerId !== payload.ownerId || claim.revision !== payload.revision ||
      claim.leaseToken !== payload.leaseToken || claim.dispatchId !== payload.dispatchId ||
      claim.dispatchBinding?.digest !== payload.dispatchBindingDigest ||
      !claim.requiresReconciliation || claim.workerReceipt !== null) {
      throw new Error("writer receipt has no matching active unsettled dispatch");
    }
    active.set(payload.claimId, Object.freeze({ ...claim, workerReceipt: payload }));
    return;
  }
  if (event.type === "writer.evidence_missing") {
    const payload = EvidenceMissingSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim === undefined || claim.revision !== payload.revision || claim.dispatchId !== payload.dispatchId ||
      (payload.missing === "worker_event_usage_receipt" && claim.workerReceipt !== null) ||
      (payload.missing === "patch_proposal_or_intent" && claim.workerReceipt === null)) {
      throw new Error("missing writer evidence marker contradicts claim state");
    }
    active.set(payload.claimId, Object.freeze({
      ...claim, requiresReconciliation: true, dispatchAuthorized: false,
    }));
    return;
  }
  if (event.type === "writer.patch_proposal_recorded") {
    const payload = PatchProposalRecordedSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim === undefined || claim.workerReceipt?.patchProposalDigest !== payload.proposal.digest ||
      claim.patchProposal !== null) throw new Error("durable patch proposal does not match supervised receipt");
    active.set(payload.claimId, Object.freeze({ ...claim, patchProposal: payload.proposal }));
    return;
  }
  if (event.type === "writer.patch_application_intended") {
    const payload = PatchApplicationIntendedSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim === undefined || claim.ownerId !== payload.ownerId || claim.revision !== payload.revision ||
      claim.leaseToken !== payload.leaseToken || claim.patchProposal?.digest !== payload.proposalDigest) {
      throw new Error("patch apply intent has no active supervised claim");
    }
    if (claim.patchApplicationPending !== null) throw new Error("patch application is already pending");
    active.set(payload.claimId, Object.freeze({
      ...claim, patchApplicationPending: payload.proposalDigest, patchIntentId: payload.intentId,
    }));
    return;
  }
  if (event.type === "writer.patch_application_started") {
    const payload = PatchApplicationStartedSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim?.patchApplicationPending !== payload.proposalDigest || claim.patchIntentId !== payload.intentId ||
      claim.patchApplicationStarted || payload.expectedStreamVersion !== event.streamVersion - 1) {
      throw new Error("patch application start has no unstarted durable intent");
    }
    active.set(payload.claimId, Object.freeze({ ...claim, patchApplicationStarted: true }));
    return;
  }
  if (event.type === "writer.patch_file_applied") {
    const payload = PatchFileAppliedSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim?.patchApplicationPending !== payload.proposalDigest) throw new Error("patch file evidence has no pending application");
    if (!claim.patchApplicationStarted || claim.patchAppliedPaths.includes(payload.path)) {
      throw new Error("patch file evidence is duplicate or precedes application start");
    }
    active.set(payload.claimId, Object.freeze({
      ...claim, patchAppliedPaths: Object.freeze([...claim.patchAppliedPaths, payload.path]),
    }));
    return;
  }
  if (event.type === "writer.patch_apply_completed") {
    const payload = PatchApplyCompletedSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim?.patchApplicationPending !== payload.proposalDigest) throw new Error("patch completion has no pending application");
    if (!claim.patchApplicationStarted || payload.paths.length !== claim.patchAppliedPaths.length ||
      payload.paths.some((candidate, index) => candidate !== claim.patchAppliedPaths[index])) {
      throw new Error("patch completion does not match per-file evidence");
    }
    active.set(payload.claimId, Object.freeze({
      ...claim, patchApplicationPending: null, patchIntentId: null, patchApplicationCompleted: true,
    }));
    return;
  }
  if (event.type === "writer.effect_uncertain") {
    const payload = UncertainSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim?.revision !== payload.revision) throw new Error("writer uncertainty has no active revision-bound claim");
    active.set(payload.claimId, Object.freeze({
      ...claim, requiresReconciliation: true, dispatchAuthorized: false,
    }));
    return;
  }
  if (event.type === "writer.correction_proposed") {
    const payload = CorrectionSchema.parse(event.payload);
    const claim = history.get(payload.claimId);
    if (claim?.revision !== payload.revision) throw new Error("writer correction has no active revision-bound claim");
    assertCorrectionWithinWriterEnvelope(claim.paths, payload.paths);
    return;
  }
  if (event.type === "path_claim.diff_observed") {
    const payload = DiffObservedSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim === undefined || claim.ownerId !== payload.ownerId || claim.revision !== payload.revision ||
      claim.leaseToken !== payload.leaseToken) throw new Error("diff observation has no active revision-bound claim");
    active.set(payload.claimId, Object.freeze({
      ...claim,
      requiresReconciliation: payload.ownershipOutcome !== "accepted",
      dispatchAuthorized: payload.ownershipOutcome === "accepted",
    }));
    return;
  }
  if (event.type === "path_claim.acquired") {
    const payload = ClaimBodySchema.parse(event.payload);
    const requested = previous?.type === "path_claim.requested"
      ? ClaimRequestedSchema.parse(previous.payload) : null;
    assertClaimRequest(projectId, payload);
    if (requested === null || !sameRequestFields(requested, payload) ||
      requested.leaseToken !== payload.leaseToken) throw new Error("path claim acquisition has no matching request");
    for (const [claimId, claim] of active) {
      if (Date.parse(claim.expiresAt) <= Date.parse(payload.acquiredAt)) active.delete(claimId);
    }
    if (payload.projectId !== projectId || active.has(payload.claimId)) throw new Error("invalid path claim acquisition");
    if ([...active.values()].some((claim) =>
      pathSetsOverlap(claim.canonicalPaths, payload.canonicalPaths))) throw new Error("journal contains overlapping active path claims");
    const acquired = Object.freeze({ ...payload, paths: Object.freeze(payload.paths),
      canonicalPaths: Object.freeze(payload.canonicalPaths), status: "active" as const,
      requiresReconciliation: false, dispatchAuthorized: true,
      dispatchId: null, dispatchBinding: null, workerReceipt: null, patchApplicationPending: null,
      patchIntentId: null, patchProposal: null, patchApplicationStarted: false, patchAppliedPaths: Object.freeze([]),
      patchApplicationCompleted: false });
    active.set(payload.claimId, acquired);
    history.set(payload.claimId, acquired);
    return;
  }
  if (event.type === "path_claim.renewed") {
    const payload = ClaimRenewedSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim === undefined || claim.ownerId !== payload.ownerId || claim.revision !== payload.revision ||
      claim.leaseToken !== payload.previousLeaseToken) throw new Error("invalid path claim renewal");
    if (Date.parse(payload.expiresAt) <= Date.parse(claim.expiresAt)) {
      throw new Error("path claim renewal does not extend its lease");
    }
    active.set(payload.claimId, Object.freeze({ ...claim, leaseToken: payload.leaseToken, expiresAt: payload.expiresAt }));
    const historical = history.get(payload.claimId);
    if (historical !== undefined) history.set(payload.claimId, Object.freeze({
      ...historical, leaseToken: payload.leaseToken, expiresAt: payload.expiresAt,
    }));
    return;
  }
  if (event.type === "path_claim.released") {
    const payload = ClaimReleasedSchema.parse(event.payload);
    const claim = active.get(payload.claimId);
    if (claim === undefined || claim.ownerId !== payload.ownerId || claim.revision !== payload.revision ||
      claim.leaseToken !== payload.leaseToken) throw new Error("invalid path claim release");
    active.delete(payload.claimId);
    return;
  }
  throw new Error(`unknown path claim event: ${event.type}`);
}

function assertClaimRequest(
  projectId: string,
  payload: z.infer<typeof ClaimRequestedSchema> | z.infer<typeof ClaimBodySchema>,
): void {
  if (payload.projectId !== projectId || JSON.stringify(payload.paths) !== JSON.stringify([...payload.paths].sort()) ||
    JSON.stringify(payload.canonicalPaths) !== JSON.stringify(payload.paths.map(canonicalDarwinClaimPath))) {
    throw new Error("path claim request is not canonical for its project stream");
  }
}

function sameRequestFields(
  requested: z.infer<typeof ClaimRequestedSchema>,
  observed: { readonly projectId: string; readonly claimId: string; readonly ownerId: string;
    readonly revision: string; readonly paths: readonly string[] },
): boolean {
  return requested.projectId === observed.projectId && requested.claimId === observed.claimId &&
    requested.ownerId === observed.ownerId && requested.revision === observed.revision &&
    JSON.stringify(requested.paths) === JSON.stringify(observed.paths);
}

function canonicalInputSet(paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.length > 256) throw new Error("path claim requires a bounded nonempty path set");
  const values = [...paths];
  for (const candidate of values) canonicalDarwinClaimPath(candidate);
  if (new Set(values).size !== values.length) throw new Error("path claim paths must be unique");
  return values.sort();
}

function pathSetsOverlap(first: readonly string[], second: readonly string[]): boolean {
  return first.some((left) => second.some((right) => left === "" || right === "" || left === right ||
    left.startsWith(`${right}/`) || right.startsWith(`${left}/`)));
}

function proposalPreimagesMatch(workspace: string, proposal: WriterPatchProposal): boolean {
  return proposal.operations.every((operation) => {
    const target = path.join(workspace, operation.path);
    if (operation.expectedSha256 === null) return !existsSync(target);
    if (!existsSync(target)) return false;
    const stat = lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink() &&
      createHash("sha256").update(readFileSync(target)).digest("hex") === operation.expectedSha256;
  });
}

function sameAcquisition(claim: PathClaim, input: ClaimCommandIdentity, paths: readonly string[]): boolean {
  return claim.ownerId === input.ownerId && claim.revision === input.revision &&
    JSON.stringify(claim.paths) === JSON.stringify(paths);
}

function validateLease(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 24 * 60 * 60 * 1_000) {
    throw new Error("path claim lease must be between 1ms and 24 hours");
  }
}

function event(streamId: string, type: string, payload: unknown, correlationId: string) {
  return { streamId, type, payload, causationId: null, correlationId: IdentitySchema.parse(correlationId) };
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && /^expected version \d+, actual \d+$/.test(error.message);
}
