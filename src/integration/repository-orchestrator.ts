import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import { z } from "zod";

import type { StoredEvent } from "../contracts/event.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import type { EventJournal } from "../journal/journal.js";
import { assertDedicatedIntegrationBranch, type ProjectConfig } from "../projects/project-config.js";
import { projectPod } from "../pods/pod-projection.js";
import { isVerifiedReviewDecision } from "../reviews/review-gate.js";
import { canonicalValidationDigest, ReviewDecisionSchema, type ReviewDecision } from "../reviews/reviewer-adapter.js";
import { isVerifiedCompletedValidationProcess, isVerifiedValidationReport, isVerifiedValidationSubject,
  ValidationReportSchema, type ValidationReport } from "../capabilities/validation-runner.js";
import { projectScheduler } from "../scheduling/scheduler-projection.js";
import { schedulerStreamId } from "../scheduling/scheduler-contracts.js";
import type { GitClient } from "../workspaces/git-client.js";
import {
  PathClaimConflictError,
  pathClaimStreamId,
  pathClaimContains,
  type PathClaim,
  type PathClaimService,
} from "../workspaces/path-claims.js";
import type { WorkspaceLease } from "../workspaces/worktree-manager.js";
import type { ConflictAnalysis, ReadOnlyGitConflictAnalyzer } from "./conflict-analyzer.js";
import {
  type IntegrationReceipt,
  type IntegrationQueue,
  type IntegrationUnitSource,
  IntegrationUncertainError,
} from "./integration-queue.js";

const Id = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const Commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Text = z.string().min(1).max(4_096);
const Timestamp = z.string().datetime({ offset: true });
const SafePath = z.string().min(1).max(4_096).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"path must be repository-relative and traversal-free");
const CanonicalIds = z.array(Id).min(1).max(256).superRefine(canonicalSet);
const CanonicalPaths = z.array(SafePath).max(1_024).superRefine(canonicalSet);

export const IntegrationSubmissionSchema = z.strictObject({
  schemaVersion: z.literal(1), receiptId: Id, projectId: Id,
  repositoryPath: z.string().min(1).max(4_096), projectRevision: Commit, projectConfigDigest: Digest,
  podId: Id, taskId: Id, podStreamVersion: z.number().int().positive(), charterRevision: z.number().int().positive(),
  assignmentId: Id, assignmentDigest: Digest, proposalId: Digest, podGrantDigest: Digest,
  podLeaseDigest: Digest, workspaceLeaseId: Id,
  schedulerId: Id, schedulerStreamVersion: z.number().int().positive(), schedulerTaskId: Id,
  schedulerWorkerId: Id, schedulerGrantId: Id, schedulerDispatchId: z.string().uuid(),
  claimId: Id, claimLeaseToken: z.string().uuid(), claimOwnerId: Id,
  writerAuthorityDigest: Digest,
  correctionBinding: z.strictObject({ unitId: Id, acceptanceRejectionSha256: Digest,
    attempt: z.number().int().positive(), maxAttempts: z.number().int().positive().max(16),
    paths: CanonicalPaths.min(1) }).nullable(),
  branch: z.string().min(1).max(1_024), workspacePath: z.string().min(1).max(4_096),
  baseCommit: Commit, sourceCommit: Commit, changedPaths: CanonicalPaths.min(1), diffSha256: Digest,
  review: ReviewDecisionSchema, focusedValidation: ValidationReportSchema,
  contract: z.strictObject({ contractDigest: Digest, scopeDigest: Digest, behaviorDigest: Digest,
    authorityDigest: Digest, batchKeyDigest: Digest.nullable(), candidateValidation: ValidationReportSchema,
    candidateOutcome: z.enum(["green", "non_green"]) }),
  admittedAt: Timestamp, digest: Digest,
}).superRefine((receipt, context) => {
  const { digest, ...body } = receipt;
  if (digest !== digestCanonical(body)) context.addIssue({ code: "custom", message: "admission receipt digest mismatch" });
  if (receipt.review.diffSha256 !== receipt.diffSha256 ||
    receipt.review.validationSha256 !== canonicalValidationDigest(receipt.focusedValidation)) {
    context.addIssue({ code: "custom", message: "admission review does not bind exact diff and validation" });
  }
  if ((receipt.contract.candidateOutcome === "green") !==
    (receipt.contract.candidateValidation.outcome === "completed" && receipt.contract.candidateValidation.exitCode === 0)) {
    context.addIssue({ code: "custom", message: "contract candidate outcome contradicts validation" });
  }
  if (receipt.contract.candidateOutcome === "non_green" &&
    (receipt.contract.candidateValidation.outcome !== "failed" ||
      receipt.contract.candidateValidation.exitCode === null ||
      receipt.contract.candidateValidation.exitCode === 0)) {
    context.addIssue({ code: "custom",
      message: "non-green candidate requires an exact observed nonzero process exit" });
  }
  if (receipt.writerAuthorityDigest !== digestCanonical({ schedulerWorkerId: receipt.schedulerWorkerId,
    schedulerGrantId: receipt.schedulerGrantId, schedulerDispatchId: receipt.schedulerDispatchId,
    claimId: receipt.claimId, claimLeaseToken: receipt.claimLeaseToken,
    claimOwnerId: receipt.claimOwnerId, projectRevision: receipt.projectRevision })) {
    context.addIssue({ code: "custom", message: "writer grant and claim authority binding is invalid" });
  }
});

export const IntegrationUnitSchema = z.strictObject({
  unitId: Id,
  contractId: Id,
  podIds: CanonicalIds,
  taskIds: CanonicalIds,
  sourceCommits: z.array(Commit).min(1).max(256),
  paths: CanonicalPaths.min(1),
  tightlyCoupled: z.boolean(),
  admissionReceipts: z.array(IntegrationSubmissionSchema).min(1).max(256),
}).superRefine((unit, context) => {
  if (unit.podIds.length !== unit.taskIds.length || unit.taskIds.length !== unit.sourceCommits.length) {
    context.addIssue({ code: "custom", message: "unit member identities must have equal cardinality" });
  }
  if (unit.admissionReceipts.length !== unit.taskIds.length ||
    unit.admissionReceipts.some((receipt, index) => receipt.taskId !== unit.taskIds[index] ||
      receipt.sourceCommit !== unit.sourceCommits[index])) {
    context.addIssue({ code: "custom", message: "unit admissions do not bind exact members" });
  }
  if (unit.tightlyCoupled !== (unit.taskIds.length > 1)) {
    context.addIssue({ code: "custom", message: "only multi-member units may be tightly coupled" });
  }
});

export type IntegrationSubmission = z.infer<typeof IntegrationSubmissionSchema>;
export type IntegrationUnit = z.infer<typeof IntegrationUnitSchema>;

export interface ReplanProposal {
  readonly projectId: string;
  readonly unitId: string;
  readonly conflictId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly changedPaths: readonly string[];
  readonly behaviorChanges: readonly string[];
  readonly authorityChanges: readonly string[];
  readonly rationale: string;
  readonly requiresApproval: boolean;
  readonly approvalDigest: string;
  readonly replacementAdmissionReceipts: readonly IntegrationSubmission[];
}

const ReplanInputSchema = z.strictObject({
  projectId: Id,
  unitId: Id,
  conflictId: Id,
  attempt: z.number().int().positive().max(16),
  maxAttempts: z.number().int().positive().max(16),
  changedPaths: CanonicalPaths,
  behaviorChanges: z.array(Text).max(128),
  authorityChanges: z.array(Text).max(128),
  rationale: Text,
  replacementAdmissionReceipts: z.array(IntegrationSubmissionSchema).min(1).max(256),
});

export function buildReplanProposal(input: z.input<typeof ReplanInputSchema>): ReplanProposal {
  const proposal = ReplanInputSchema.parse(input);
  if (proposal.attempt > proposal.maxAttempts) throw new Error("replan budget is exhausted");
  const approvalPacket = {
    projectId: proposal.projectId,
    unitId: proposal.unitId,
    conflictId: proposal.conflictId,
    attempt: proposal.attempt,
    maxAttempts: proposal.maxAttempts,
    changedPaths: proposal.changedPaths,
    behaviorChanges: proposal.behaviorChanges,
    authorityChanges: proposal.authorityChanges,
    rationale: proposal.rationale,
    replacementAdmissionReceipts: proposal.replacementAdmissionReceipts,
  };
  return Object.freeze({
    ...proposal,
    changedPaths: Object.freeze([...proposal.changedPaths]),
    behaviorChanges: Object.freeze([...proposal.behaviorChanges]),
    authorityChanges: Object.freeze([...proposal.authorityChanges]),
    replacementAdmissionReceipts: Object.freeze([...proposal.replacementAdmissionReceipts]),
    requiresApproval: true,
    approvalDigest: sha256(JSON.stringify(approvalPacket)),
  });
}

export function formIntegrationUnits(inputs: readonly IntegrationSubmission[]): readonly IntegrationUnit[] {
  const submissions = inputs.map((input) => IntegrationSubmissionSchema.parse(input))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (new Set(submissions.map((item) => item.taskId)).size !== submissions.length) {
    throw new Error("integration submission task identities must be unique");
  }
  const grouped = new Map<string, IntegrationSubmission[]>();
  const units: IntegrationUnit[] = [];
  for (const submission of submissions) {
    if (submission.contract.candidateOutcome === "green") {
      units.push(unitFrom([submission], false));
    } else {
      if (submission.contract.batchKeyDigest === null) {
        throw new Error("non-green contract candidate lacks durable coupling evidence");
      }
      const group = grouped.get(submission.contract.batchKeyDigest) ?? [];
      group.push(submission);
      grouped.set(submission.contract.batchKeyDigest, group);
    }
  }
  for (const [contractId, members] of grouped) {
    if (members.length < 2) {
      throw new Error(`tightly coupled contract ${contractId} requires at least two members`);
    }
    if (members.some((member) => member.contract.contractDigest !== members[0]!.contract.contractDigest)) {
      throw new Error("coupled candidate evidence does not bind one exact contract");
    }
    units.push(unitFrom(members, true));
  }
  return Object.freeze(units.sort((left, right) => left.taskIds[0]!.localeCompare(right.taskIds[0]!)));
}

export interface RepositoryUnitView {
  readonly unitId: string;
  readonly contractId: string;
  readonly taskIds: readonly string[];
  readonly podIds: readonly string[];
  readonly paths: readonly string[];
  readonly admissionReceipts: readonly IntegrationSubmission[];
  readonly sourceCommits: readonly string[];
  readonly status: "formed" | "candidate" | "validated" | "conflicted" | "awaiting_approval" |
    "rejected" | "integrated" | "acceptance_pending" | "accepted" | "correction_pending" |
    "correction_awaiting_approval";
  readonly expectedCommit: string | null;
  readonly resultCommit: string | null;
  readonly conflictId: string | null;
  readonly replanDigest: string | null;
  readonly acceptanceRejectionSha256: string | null;
  readonly correctionCount: number;
  readonly replanAttempt: number;
  readonly replanMaxAttempts: number | null;
  readonly pendingReplanReceipts: readonly IntegrationSubmission[];
  readonly correctionDigest: string | null;
  readonly correctionMaxAttempts: number | null;
  readonly pendingCorrectionReceipts: readonly IntegrationSubmission[];
}

export interface RepositoryIntegrationSource extends IntegrationUnitSource {
  readonly baseCommit: string;
}

export type RepositoryIntegrationResult =
  | { readonly kind: "integrated"; readonly receipt: IntegrationReceipt }
  | { readonly kind: "rejected"; readonly receipt: IntegrationReceipt }
  | { readonly kind: "conflict"; readonly analyses: readonly ConflictAnalysis[] };

/** Central repository authority. Pods can submit evidence, but cannot mutate the integration ref. */
export class RepositoryOrchestrator {
  private readonly activeIntegrations = new Map<string, AbortController>();
  constructor(
    private readonly journal: EventJournal,
    private readonly claims: PathClaimService,
    private readonly queue: IntegrationQueue,
    private readonly conflicts: ReadOnlyGitConflictAnalyzer,
    private readonly git: GitClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.queue.bindAdmissionVerifier((projectId, digest) => {
      const receipt = Object.values(this.inspect(projectId).admissions)
        .find((candidate) => candidate.digest === digest);
      return receipt === undefined ? null : receipt;
    });
    this.queue.bindCancellationVerifier((projectId) => this.inspect(projectId).cancelled);
  }

  arbitrateOwnership(input: {
    readonly projectId: string;
    readonly podId: string;
    readonly taskId: string;
    readonly claimId: string;
    readonly revision: string;
    readonly paths: readonly string[];
    readonly leaseMs: number;
    readonly correlationId: string;
  }): PathClaim {
    try {
      return this.claims.acquire({
        projectId: input.projectId,
        claimId: input.claimId,
        ownerId: input.podId,
        revision: input.revision,
        paths: input.paths,
        leaseMs: input.leaseMs,
        correlationId: input.correlationId,
      });
    } catch (error) {
      if (error instanceof PathClaimConflictError) {
        const claimCause = this.journal.readStream(pathClaimStreamId(input.projectId)).at(-1)?.eventId ?? null;
        this.append(input.projectId, "ownership.conflict_observed", {
          schemaVersion: 1,
          podId: input.podId,
          taskId: input.taskId,
          conflictingClaimIds: [...error.conflictingClaimIds].sort(),
          observedAt: this.timestamp(),
        }, input.correlationId, claimCause);
      }
      throw error;
    }
  }

  async admitSubmission(input: {
    readonly project: ProjectConfig; readonly projectRevision: string;
    readonly podId: string; readonly assignmentId: string;
    readonly schedulerId: string; readonly schedulerTaskId: string;
    readonly claimId: string; readonly claimLeaseToken: string;
    readonly baseCommit: string; readonly branch: string; readonly workspacePath: string;
    readonly focusedValidation: ValidationReport; readonly review: ReviewDecision;
    readonly contract: { readonly scope: unknown; readonly behavior: unknown; readonly authority: unknown;
      readonly batchKey: unknown | null; readonly candidateValidation: ValidationReport };
    readonly correction?: { readonly unitId: string; readonly acceptanceRejectionSha256: string;
      readonly attempt: number; readonly maxAttempts: number; readonly paths: readonly string[] };
    readonly correlationId: string;
  }): Promise<IntegrationSubmission> {
    assertDedicatedIntegrationBranch(input.project);
    if (this.inspect(input.project.projectId).cancelled) throw new Error("repository orchestration is cancelled");
    const correctionBinding = input.correction === undefined ? null : (() => {
      const unit = this.inspect(input.project.projectId).units[input.correction!.unitId];
      const paths = [...new Set(input.correction!.paths)].sort();
      if (unit?.status !== "correction_pending" ||
        unit.acceptanceRejectionSha256 !== input.correction!.acceptanceRejectionSha256 ||
        input.correction!.attempt !== unit.correctionCount + 1 ||
        input.correction!.attempt > input.correction!.maxAttempts ||
        (unit.correctionMaxAttempts !== null && input.correction!.maxAttempts !== unit.correctionMaxAttempts) ||
        paths.length === 0 || paths.some((candidate) =>
          !unit.paths.some((owned) => pathClaimContains(owned, candidate)))) {
        throw new Error("correction admission is outside its exact monotonic envelope");
      }
      return { unitId: input.correction!.unitId,
        acceptanceRejectionSha256: input.correction!.acceptanceRejectionSha256,
        attempt: input.correction!.attempt, maxAttempts: input.correction!.maxAttempts, paths };
    })();
    const pod = projectPod(this.journal.readStream(input.podId));
    const schedulerEvents = this.journal.readStream(schedulerStreamId(input.schedulerId));
    const scheduler = projectScheduler(schedulerEvents);
    const assignment = pod?.assignments[input.assignmentId];
    const scheduled = scheduler.tasks[input.schedulerTaskId];
    if (pod === null || pod.projectId !== input.project.projectId || assignment === undefined ||
      assignment.status !== "completed" || assignment.observedOutcome !== "completed" ||
      scheduled === undefined || scheduled.terminalOutcome !== "completed" || scheduled.dispatch === null ||
      scheduled.input.projectId !== input.project.projectId || scheduled.input.workerId !== assignment.agentId ||
      scheduled.input.taskId !== assignment.taskId || scheduled.input.workspace.path !== input.workspacePath ||
      !assignment.capabilities.includes("write_worktree") ||
      scheduled.input.effect !== "potentially_effectful" ||
      !scheduled.input.requiredCapabilities.includes("write_worktree") || scheduled.input.resources.writers <= 0 ||
      scheduled.input.grantId !== scheduled.dispatch.grantId ||
      !scheduler.consumedGrantIds.includes(scheduled.input.grantId)) {
      throw new Error("repository admission requires exact completed pod assignment and scheduler grant consumption");
    }
    const workspace = Object.values(pod.workspaceLeases).find((candidate) =>
      candidate.workspaceLeaseId === Object.values(pod.leases).find((lease) =>
        lease.assignmentId === assignment.assignmentId)?.workspaceLeaseId);
    if (workspace === undefined || workspace.taskId !== assignment.taskId ||
      workspace.repositoryPath !== input.project.repositoryPath || workspace.path !== input.workspacePath ||
      normalizeBranch(workspace.branch) !== normalizeBranch(input.branch) ||
      workspace.baseCommit !== input.projectRevision || input.baseCommit !== input.projectRevision) {
      throw new Error("repository admission workspace does not match the exact pod assignment");
    }
    const claim = this.claims.inspect(input.project.projectId).active.find((candidate) => candidate.claimId === input.claimId);
    if (claim === undefined || claim.ownerId !== assignment.agentId || claim.leaseToken !== input.claimLeaseToken ||
      claim.revision !== input.projectRevision) {
      throw new Error("repository admission lacks the exact active revision-bound path claim");
    }
    const sourceCommit = await this.readCommit(input.project.repositoryPath, `refs/heads/${normalizeBranch(input.branch)}`);
    const diff = await this.readSourceDiff(input.project.repositoryPath, input.baseCommit, sourceCommit);
    const canonicalWorkspace = await realpath(input.workspacePath);
    if (diff.paths.length === 0 || diff.paths.some((candidate) =>
      !claim.paths.some((owned) => pathClaimContains(owned, candidate)) ||
      !assignment.ownedPaths.some((owned) => pathClaimContains(owned, candidate)) ||
      (correctionBinding !== null && !correctionBinding.paths.some((allowed) => pathClaimContains(allowed, candidate))))) {
      throw new Error("repository admission changed paths exceed assignment or claim authority");
    }
    if (!isVerifiedValidationReport(input.focusedValidation, {
      invocationId: input.focusedValidation.provenance.invocationId,
      canonicalCwd: canonicalWorkspace, subjectSha256: diff.sha256,
    }) || !isVerifiedValidationSubject(input.focusedValidation, diff.sha256) ||
      input.focusedValidation.name !== "focused" ||
      JSON.stringify(input.focusedValidation.command) !== JSON.stringify(input.project.validations.focused) ||
      input.focusedValidation.outcome !== "completed" || input.focusedValidation.exitCode !== 0 ||
      !isVerifiedReviewDecision(input.review) || !input.review.approved || input.review.diffSha256 !== diff.sha256 ||
      input.review.validationSha256 !== canonicalValidationDigest(input.focusedValidation)) {
      throw new Error("repository admission requires exact verified review and focused validation evidence");
    }
    const candidate = input.contract.candidateValidation;
    if (!isVerifiedValidationReport(candidate, { invocationId: candidate.provenance.invocationId,
      canonicalCwd: canonicalWorkspace, subjectSha256: sourceCommit }) ||
      !isVerifiedValidationSubject(candidate, sourceCommit) ||
      (candidate.name !== "focused" && candidate.name !== "full") ||
      JSON.stringify(candidate.command) !== JSON.stringify(input.project.validations[candidate.name as "focused" | "full"])) {
      throw new Error("contract stability requires a verified source-bound candidate test");
    }
    const candidateGreen = candidate.outcome === "completed" && candidate.exitCode === 0;
    const candidateNonGreen = isVerifiedCompletedValidationProcess(candidate) &&
      candidate.outcome === "failed" &&
      candidate.exitCode !== null && candidate.exitCode !== 0;
    if (!candidateGreen && !candidateNonGreen) {
      throw new Error("contract stability candidate result is inconclusive and cannot be admitted");
    }
    const writerReceipt = claim.workerReceipt;
    const binding = claim.dispatchBinding;
    const proposal = claim.patchProposal;
    const checkpoint = claim.checkpoint;
    if (writerReceipt === null || writerReceipt.outcome !== "completed" || binding === null || claim.dispatchId === null ||
      claim.dispatchId !== scheduled.dispatch.dispatchId || writerReceipt.dispatchId !== scheduled.dispatch.dispatchId ||
      writerReceipt.dispatchId !== claim.dispatchId || writerReceipt.dispatchBindingDigest !== binding.digest ||
      binding.dispatchId !== claim.dispatchId || binding.projectId !== input.project.projectId ||
      binding.claimId !== claim.claimId || binding.ownerId !== claim.ownerId || binding.revision !== claim.revision ||
      binding.leaseToken !== claim.leaseToken || proposal === null || writerReceipt.patchProposalDigest !== proposal.digest ||
      proposal.baseRevision !== input.projectRevision || !claim.patchApplicationCompleted || checkpoint === null ||
      checkpoint.claimId !== claim.claimId || checkpoint.revision !== claim.revision ||
      checkpoint.diffSha256 !== diff.sha256 || checkpoint.toolEvidenceSha256 !== writerReceipt.eventChain.chainSha256 ||
      digestCanonical(checkpoint.usage) !== digestCanonical(writerReceipt.usage) ||
      JSON.stringify([...claim.patchAppliedPaths].sort()) !== JSON.stringify(diff.paths) ||
      JSON.stringify(proposal.operations.map((operation) => operation.path).sort()) !== JSON.stringify(diff.paths)) {
      throw new Error("repository admission requires the exact completed writer receipt, trusted patch, checkpoint, and source binding");
    }
    const contract = {
      contractDigest: digestCanonical({ scope: input.contract.scope, behavior: input.contract.behavior,
        authority: input.contract.authority }),
      scopeDigest: digestCanonical(input.contract.scope), behaviorDigest: digestCanonical(input.contract.behavior),
      authorityDigest: digestCanonical(input.contract.authority),
      batchKeyDigest: input.contract.batchKey === null ? null : digestCanonical(input.contract.batchKey),
      candidateValidation: candidate,
      candidateOutcome: candidateGreen ? "green" as const : "non_green" as const,
    };
    const body = { schemaVersion: 1 as const,
      receiptId: `admission:${sha256(JSON.stringify({ podId: pod.podId, assignmentId: assignment.assignmentId,
        sourceCommit, schedulerTaskId: input.schedulerTaskId })).slice(0, 32)}`,
      projectId: input.project.projectId, repositoryPath: input.project.repositoryPath,
      projectRevision: input.projectRevision, projectConfigDigest: digestCanonical(input.project),
      podId: pod.podId, taskId: assignment.taskId,
      podStreamVersion: pod.streamVersion, charterRevision: assignment.charterRevision,
      assignmentId: assignment.assignmentId, assignmentDigest: assignment.assignmentDigest,
      proposalId: assignment.proposalId!, podGrantDigest: assignment.grantDigest,
      podLeaseDigest: assignment.leaseDigest, workspaceLeaseId: workspace.workspaceLeaseId,
      schedulerId: scheduler.schedulerId!, schedulerStreamVersion: scheduler.streamVersion,
      schedulerTaskId: input.schedulerTaskId, schedulerWorkerId: scheduled.input.workerId,
      schedulerGrantId: scheduled.input.grantId, schedulerDispatchId: scheduled.dispatch.dispatchId,
      claimId: claim.claimId, claimLeaseToken: claim.leaseToken, claimOwnerId: claim.ownerId,
      writerAuthorityDigest: digestCanonical({ schedulerWorkerId: scheduled.input.workerId,
        schedulerGrantId: scheduled.input.grantId, schedulerDispatchId: scheduled.dispatch.dispatchId,
        claimId: claim.claimId, claimLeaseToken: claim.leaseToken,
        claimOwnerId: claim.ownerId, projectRevision: input.projectRevision }),
      correctionBinding,
      branch: normalizeBranch(input.branch), workspacePath: workspace.path,
      baseCommit: Commit.parse(input.baseCommit), sourceCommit, changedPaths: diff.paths, diffSha256: diff.sha256,
      review: input.review, focusedValidation: input.focusedValidation, contract,
      admittedAt: this.timestamp() };
    const receipt = IntegrationSubmissionSchema.parse({ ...body, digest: digestCanonical(body) });
    const schedulerOutcome = schedulerEvents.findLast((event) => event.type === "scheduler.worker_outcome" &&
      (event.payload as { taskId?: string }).taskId === input.schedulerTaskId);
    if (schedulerOutcome === undefined) throw new Error("repository admission lacks scheduler outcome causation");
    this.appendMany(input.project.projectId, [{ type: "repository.submission_admitted",
      payload: { schemaVersion: 1, receipt } }], input.correlationId, true, schedulerOutcome.eventId);
    return receipt;
  }

  formUnits(projectId: string, admissionReceiptIds: readonly string[], correlationId: string): readonly IntegrationUnit[] {
    const state = this.inspect(projectId);
    if (state.cancelled) throw new Error("repository orchestration is cancelled");
    const submissions = admissionReceiptIds.map((id) => state.admissions[id] ??
      (() => { throw new Error(`durable admission receipt ${id} was not found`); })());
    const units = formIntegrationUnits(submissions);
    this.appendMany(projectId, units.map((unit) => ({ type: "integration.unit_formed", payload: {
        schemaVersion: 1,
        unitId: unit.unitId,
        contractId: unit.contractId,
        taskIds: unit.taskIds,
        podIds: unit.podIds,
        paths: unit.paths,
        sourceCommits: unit.sourceCommits,
        admissionReceipts: unit.admissionReceipts,
        tightlyCoupled: unit.tightlyCoupled,
        formedAt: this.timestamp(),
      } })), correlationId, true);
    return units;
  }

  async integrate(input: {
    readonly project: ProjectConfig;
    readonly unitId: string;
    readonly signal: AbortSignal;
    readonly correlationId: string;
  }): Promise<RepositoryIntegrationResult> {
    assertDedicatedIntegrationBranch(input.project);
    const state = this.inspect(input.project.projectId);
    const current = state.units[input.unitId];
    if (state.cancelled) throw new Error("repository orchestration is cancelled");
    if (current?.status !== "formed") throw new Error("integration unit is not ready");
    const receipts = current.admissionReceipts;
    for (const receipt of receipts) {
      if (receipt.projectId !== input.project.projectId || receipt.repositoryPath !== input.project.repositoryPath) {
        throw new Error("durable admission receipt targets another project");
      }
      if (receipt.projectConfigDigest !== digestCanonical(input.project)) {
        throw new Error("durable admission project configuration is stale");
      }
      const claim = this.claims.inspect(receipt.projectId).active.find((candidate) => candidate.claimId === receipt.claimId);
      if (claim === undefined || claim.leaseToken !== receipt.claimLeaseToken || claim.ownerId !== receipt.claimOwnerId ||
        claim.revision !== receipt.projectRevision) {
        throw new Error("durable admission claim is no longer active and exact");
      }
      const pod = projectPod(this.journal.readStream(receipt.podId));
      const assignment = pod?.assignments[receipt.assignmentId];
      const scheduler = projectScheduler(this.journal.readStream(schedulerStreamId(receipt.schedulerId)));
      const scheduled = scheduler.tasks[receipt.schedulerTaskId];
      if (pod === null || pod.revision !== receipt.charterRevision || assignment?.status !== "completed" ||
        assignment.assignmentDigest !== receipt.assignmentDigest || assignment.proposalId !== receipt.proposalId ||
        assignment.grantDigest !== receipt.podGrantDigest || assignment.leaseDigest !== receipt.podLeaseDigest ||
        scheduled?.terminalOutcome !== "completed" || scheduled.dispatch?.dispatchId !== receipt.schedulerDispatchId ||
        scheduled.input.workerId !== receipt.schedulerWorkerId || scheduled.input.grantId !== receipt.schedulerGrantId ||
        !scheduler.consumedGrantIds.includes(receipt.schedulerGrantId)) {
        throw new Error("durable admission pod or scheduler authority is stale");
      }
    }
    const sources: RepositoryIntegrationSource[] = receipts.map((receipt) => ({
      lease: { taskId: receipt.taskId, branch: receipt.branch, path: receipt.workspacePath },
      review: receipt.review, baseCommit: receipt.baseCommit, durableAdmissionDigest: receipt.digest,
    }));
    const integrationRef = `refs/heads/${input.project.integrationBranch}`;
    const integrationCommit = await this.readCommit(input.project.repositoryPath, integrationRef);
    const analyses: ConflictAnalysis[] = [];
    const sourceCommits: string[] = [];
    for (const [index, source] of sources.entries()) {
      const sourceCommit = await this.readCommit(input.project.repositoryPath,
        `refs/heads/${source.lease.branch}`);
      if (sourceCommit !== current.sourceCommits[index]) {
        throw new Error("integration source branch moved after unit formation");
      }
      sourceCommits.push(sourceCommit);
      const analysis = await this.conflicts.analyze({
        repositoryPath: input.project.repositoryPath,
        baseCommit: source.baseCommit,
        integrationCommit,
        sourceCommit,
      });
      analyses.push(analysis);
    }
    for (let left = 0; left < sourceCommits.length; left += 1) {
      for (let right = left + 1; right < sourceCommits.length; right += 1) {
        const baseCommit = await this.readMergeBase(input.project.repositoryPath,
          sourceCommits[left]!, sourceCommits[right]!);
        analyses.push(await this.conflicts.analyze({
          repositoryPath: input.project.repositoryPath,
          baseCommit,
          integrationCommit: sourceCommits[left]!,
          sourceCommit: sourceCommits[right]!,
        }));
      }
    }
    const realConflicts = analyses.filter((analysis) => analysis.classification === "real_conflict");
    if (realConflicts.length > 0) {
      const paths = [...new Set(realConflicts.flatMap((analysis) => analysis.conflictPaths))].sort();
      const conflictId = `conflict:${sha256(JSON.stringify({ unitId: current.unitId, integrationCommit, paths })).slice(0, 32)}`;
      this.append(input.project.projectId, "conflict.observed", {
        schemaVersion: 1,
        unitId: current.unitId,
        conflictId,
        paths,
        analysisSha256: sha256(JSON.stringify(realConflicts.map((analysis) => analysis.analysisSha256))),
        observedAt: this.timestamp(),
      }, input.correlationId);
      return Object.freeze({ kind: "conflict", analyses: Object.freeze(analyses) });
    }
    const stale = sources.some((source) => source.baseCommit !== integrationCommit);
    if (stale) {
      this.append(input.project.projectId, "rebase.started", {
        schemaVersion: 1, unitId: current.unitId,
        fromCommit: sources[0]!.baseCommit, ontoCommit: integrationCommit,
        resultCommit: null, observedAt: this.timestamp(),
      }, input.correlationId);
    }
    if (input.signal.aborted || this.inspect(input.project.projectId).cancelled) {
      throw new Error("repository orchestration was cancelled before candidate creation");
    }
    const active = new AbortController();
    if (this.activeIntegrations.has(input.project.projectId)) throw new Error("repository integration is already active");
    this.activeIntegrations.set(input.project.projectId, active);
    try {
      const receipt = await this.queue.integrateUnit({
        project: input.project,
        unitId: current.unitId,
        sources: sources.map(({ lease, review, durableAdmissionDigest }) =>
          ({ lease, review, durableAdmissionDigest: durableAdmissionDigest! })),
        historyMode: "rebase",
        signal: AbortSignal.any([input.signal, active.signal]),
        onPrepared: (prepared) => {
          this.appendMany(input.project.projectId, [{
            type: "integration.candidate_created",
            payload: { schemaVersion: 1, unitId: current.unitId,
              candidateId: `candidate:${prepared.resultCommit!.slice(0, 32)}`,
              expectedCommit: prepared.originalIntegrationCommit!, createdAt: this.timestamp() },
          }, {
            type: "integration.candidate_validated",
            payload: { schemaVersion: 1, unitId: current.unitId,
              candidateCommit: prepared.resultCommit!, validationSha256: prepared.validation.outputSha256,
              validatedAt: this.timestamp() },
          }, ...(stale ? [{
            type: "rebase.completed",
            payload: { schemaVersion: 1, unitId: current.unitId,
              fromCommit: sources[0]!.baseCommit, ontoCommit: prepared.originalIntegrationCommit!,
              resultCommit: prepared.resultCommit!, observedAt: this.timestamp() },
          }] : [])], input.correlationId);
        },
        onCommitted: (committed) => {
          this.append(input.project.projectId, "integration.committed", {
            schemaVersion: 1, unitId: current.unitId,
            expectedCommit: committed.originalIntegrationCommit!,
            resultCommit: committed.resultCommit!, committedAt: this.timestamp(),
          }, input.correlationId);
        },
      });
      if (receipt.outcome !== "completed" || receipt.resultCommit === null || receipt.originalIntegrationCommit === null) {
        this.append(input.project.projectId, "integration.candidate_rejected", {
          schemaVersion: 1, unitId: current.unitId,
          reason: `candidate outcome ${receipt.outcome}`, rejectedAt: this.timestamp(),
        }, input.correlationId);
        return Object.freeze({ kind: "rejected", receipt });
      }
      return Object.freeze({ kind: "integrated", receipt });
    } catch (error) {
      if (error instanceof IntegrationUncertainError) throw error;
      const latest = this.inspect(input.project.projectId).units[current.unitId];
      if (latest?.status === "validated") throw error;
      this.append(input.project.projectId, "integration.candidate_rejected", {
        schemaVersion: 1, unitId: current.unitId,
        reason: "candidate preparation failed", rejectedAt: this.timestamp(),
      }, input.correlationId);
      throw error;
    } finally {
      if (this.activeIntegrations.get(input.project.projectId) === active) {
        this.activeIntegrations.delete(input.project.projectId);
      }
    }
  }

  async reconcileIntegration(input: {
    readonly project: ProjectConfig;
    readonly unitId: string;
    readonly correlationId: string;
  }): Promise<RepositoryUnitView> {
    const unit = this.inspect(input.project.projectId).units[input.unitId];
    if (unit?.status !== "validated" || unit.expectedCommit === null || unit.resultCommit === null) {
      throw new Error("integration reconciliation requires a durably validated candidate");
    }
    await this.queue.reconcileIntegrationRef({ project: input.project, signal: AbortSignal.timeout(30_000),
      observeUnderLease: (actual) => {
        if (actual === unit.resultCommit) {
          this.append(input.project.projectId, "integration.committed", {
            schemaVersion: 1, unitId: unit.unitId, expectedCommit: unit.expectedCommit,
            resultCommit: unit.resultCommit, committedAt: this.timestamp(),
          }, input.correlationId);
        } else if (actual === unit.expectedCommit) {
          this.append(input.project.projectId, "integration.candidate_rejected", {
            schemaVersion: 1, unitId: unit.unitId,
            reason: "reconciliation proved the integration CAS had no effect", rejectedAt: this.timestamp(),
          }, input.correlationId);
        } else {
          throw new IntegrationUncertainError("integration ref reconciliation found a competing commit",
            Object.freeze({ unitId: unit.unitId, expectedCommit: unit.expectedCommit,
              candidateCommit: unit.resultCommit, actualCommit: actual }));
        }
      } });
    return this.inspect(input.project.projectId).units[input.unitId]!;
  }

  proposeReplan(projectId: string, input: Omit<Parameters<typeof buildReplanProposal>[0],
    "replacementAdmissionReceipts"> & { readonly replacementAdmissionReceiptIds: readonly string[] },
  correlationId: string): ReplanProposal {
    const state = this.inspect(projectId);
    if (state.cancelled) throw new Error("repository orchestration is cancelled");
    const unit = state.units[input.unitId];
    if (unit?.status !== "conflicted") throw new Error("replan requires an observed conflict");
    if (input.attempt !== unit.replanAttempt + 1 || input.attempt > input.maxAttempts ||
      (unit.replanMaxAttempts !== null && input.maxAttempts !== unit.replanMaxAttempts)) {
      throw new Error("replan attempt or maximum is not monotonic and exact");
    }
    const replacementAdmissionReceipts = input.replacementAdmissionReceiptIds.map((id) =>
      state.admissions[id] ?? (() => { throw new Error(`replacement admission ${id} is not durable`); })());
    if (replacementAdmissionReceipts.some((receipt) => receipt.projectId !== projectId ||
      receipt.changedPaths.some((candidate) => !unit.paths.some((owned) => pathClaimContains(owned, candidate)) &&
        !input.changedPaths.includes(candidate)))) {
      throw new Error("replan replacement expands scope without exact declared approval");
    }
    const behaviorChanged = replacementAdmissionReceipts.some((receipt, index) =>
      receipt.contract.behaviorDigest !== unit.admissionReceipts[index]?.contract.behaviorDigest);
    const authorityChanged = replacementAdmissionReceipts.some((receipt, index) =>
      receipt.contract.authorityDigest !== unit.admissionReceipts[index]?.contract.authorityDigest);
    const scopeChanged = replacementAdmissionReceipts.some((receipt, index) =>
      receipt.contract.scopeDigest !== unit.admissionReceipts[index]?.contract.scopeDigest);
    if (behaviorChanged !== (input.behaviorChanges.length > 0) ||
      authorityChanged !== (input.authorityChanges.length > 0) || (scopeChanged && input.changedPaths.length === 0)) {
      throw new Error("replan scope, behavior, or authority declaration is not exact");
    }
    const { replacementAdmissionReceiptIds: _replacementIds, ...proposalInput } = input;
    const proposal = buildReplanProposal({ ...proposalInput, replacementAdmissionReceipts });
    this.appendMany(projectId, [{ type: "replan.proposed", payload: {
      schemaVersion: 1, unitId: proposal.unitId, approvalDigest: proposal.approvalDigest,
      conflictId: proposal.conflictId, requiresApproval: proposal.requiresApproval,
      attempt: proposal.attempt, maxAttempts: proposal.maxAttempts,
      changedPaths: proposal.changedPaths, behaviorChanges: proposal.behaviorChanges,
      authorityChanges: proposal.authorityChanges, rationale: proposal.rationale,
      replacementAdmissionReceipts: proposal.replacementAdmissionReceipts,
      proposedAt: this.timestamp(),
    } }], correlationId, true);
    return proposal;
  }

  decideReplan(projectId: string, input: {
    readonly unitId: string; readonly approvalDigest: string; readonly approved: boolean; readonly decidedBy: string;
  }, correlationId: string): RepositoryUnitView {
    const unit = this.inspect(projectId).units[input.unitId];
    if (this.inspect(projectId).cancelled) throw new Error("repository orchestration is cancelled");
    if (unit?.status !== "awaiting_approval" || unit.replanDigest !== input.approvalDigest) {
      throw new Error("decision is not bound to the exact pending replan");
    }
    this.appendMany(projectId, [{ type: input.approved ? "replan.approved" : "replan.rejected", payload: {
      schemaVersion: 1, unitId: input.unitId, approvalDigest: input.approvalDigest,
      decidedBy: input.decidedBy, decidedAt: this.timestamp(),
    } }], correlationId, true);
    return this.inspect(projectId).units[input.unitId]!;
  }

  requestFinalAcceptance(projectId: string, unitId: string, evidenceSha256: string,
    correlationId: string): RepositoryUnitView {
    const unit = this.inspect(projectId).units[unitId];
    if (unit?.status !== "integrated" || unit.resultCommit === null) throw new Error("final acceptance requires integration");
    this.append(projectId, "final_acceptance.requested", { schemaVersion: 1, unitId,
      resultCommit: unit.resultCommit, evidenceSha256, requestedAt: this.timestamp() }, correlationId);
    return this.inspect(projectId).units[unitId]!;
  }

  decideFinalAcceptance(projectId: string, input: { readonly unitId: string; readonly accepted: boolean;
    readonly decidedBy: string; readonly reason: string }, correlationId: string): RepositoryUnitView {
    const unit = this.inspect(projectId).units[input.unitId];
    if (unit?.status !== "acceptance_pending" || unit.resultCommit === null) throw new Error("final acceptance is not pending");
    this.append(projectId, input.accepted ? "final_acceptance.accepted" : "final_acceptance.rejected", {
      schemaVersion: 1, unitId: unit.unitId, resultCommit: unit.resultCommit,
      decidedBy: input.decidedBy, reason: input.reason, decidedAt: this.timestamp(),
    }, correlationId);
    return this.inspect(projectId).units[input.unitId]!;
  }

  planCorrection(projectId: string, input: { readonly unitId: string; readonly attempt: number;
    readonly maxAttempts: number; readonly paths: readonly string[]; readonly acceptanceRejectionSha256: string;
    readonly replacementAdmissionReceiptIds: readonly string[]; readonly behaviorChanges: readonly string[];
    readonly authorityChanges: readonly string[]; readonly rationale: string },
  correlationId: string): { readonly view: RepositoryUnitView; readonly approvalDigest: string;
    readonly requiresApproval: boolean } {
    const state = this.inspect(projectId);
    if (state.cancelled) throw new Error("repository orchestration is cancelled");
    const unit = state.units[input.unitId];
    if (unit?.status !== "correction_pending" || unit.acceptanceRejectionSha256 !== input.acceptanceRejectionSha256) {
      throw new Error("correction requires the exact final acceptance rejection");
    }
    if (input.attempt !== unit.correctionCount + 1 || input.attempt > input.maxAttempts ||
      (unit.correctionMaxAttempts !== null && input.maxAttempts !== unit.correctionMaxAttempts)) {
      throw new Error("correction attempt or maximum is not monotonic and exact");
    }
    const paths = [...new Set(input.paths)].sort();
    if (paths.length === 0 || paths.some((candidate) =>
      !unit.paths.some((owned) => pathClaimContains(owned, candidate)))) {
      throw new Error("correction envelope expands original integration scope");
    }
    const replacements = input.replacementAdmissionReceiptIds.map((id) => state.admissions[id] ??
      (() => { throw new Error(`correction replacement admission ${id} is not durable`); })());
    if (replacements.some((receipt) => receipt.projectId !== projectId ||
      receipt.correctionBinding?.unitId !== input.unitId ||
      receipt.correctionBinding.acceptanceRejectionSha256 !== input.acceptanceRejectionSha256 ||
      receipt.correctionBinding.attempt !== input.attempt ||
      receipt.correctionBinding.maxAttempts !== input.maxAttempts ||
      JSON.stringify(receipt.correctionBinding.paths) !== JSON.stringify(paths) ||
      receipt.changedPaths.some((candidate) => !paths.some((allowed) => pathClaimContains(allowed, candidate))))) {
      throw new Error("correction replacement exceeds its exact path envelope");
    }
    const behaviorChanged = replacements.some((receipt, index) =>
      receipt.contract.behaviorDigest !== unit.admissionReceipts[index]?.contract.behaviorDigest);
    const authorityChanged = replacements.some((receipt, index) =>
      receipt.contract.authorityDigest !== unit.admissionReceipts[index]?.contract.authorityDigest);
    if (behaviorChanged !== (input.behaviorChanges.length > 0) ||
      authorityChanged !== (input.authorityChanges.length > 0)) {
      throw new Error("correction behavior or authority declaration is not exact");
    }
    const requiresApproval = replacements.some((receipt, index) =>
      receipt.digest !== unit.admissionReceipts[index]?.digest);
    const packet = { projectId, unitId: input.unitId, attempt: input.attempt,
      maxAttempts: input.maxAttempts, acceptanceRejectionSha256: input.acceptanceRejectionSha256,
      paths, behaviorChanges: [...input.behaviorChanges], authorityChanges: [...input.authorityChanges],
      rationale: input.rationale, replacementAdmissionReceipts: replacements };
    const approvalDigest = sha256(JSON.stringify(packet));
    const payload = CorrectionPayload.parse({ schemaVersion: 1, ...packet,
      approvalDigest, requiresApproval, plannedAt: this.timestamp() });
    this.appendMany(projectId, [{ type: "correction.planned", payload }], correlationId, true);
    return Object.freeze({ view: this.inspect(projectId).units[input.unitId]!, approvalDigest, requiresApproval });
  }

  decideCorrection(projectId: string, input: { readonly unitId: string; readonly approvalDigest: string;
    readonly approved: boolean; readonly decidedBy: string }, correlationId: string): RepositoryUnitView {
    const unit = this.inspect(projectId).units[input.unitId];
    if (unit?.status !== "correction_awaiting_approval" || unit.correctionDigest !== input.approvalDigest) {
      throw new Error("correction decision is not bound to the exact pending replacement");
    }
    this.appendMany(projectId, [{ type: input.approved ? "correction.approved" : "correction.rejected",
      payload: { schemaVersion: 1, unitId: input.unitId, approvalDigest: input.approvalDigest,
        decidedBy: input.decidedBy, decidedAt: this.timestamp() } }], correlationId, true);
    return this.inspect(projectId).units[input.unitId]!;
  }

  async cancel(project: ProjectConfig, requestedBy: string, reason: string, correlationId: string,
    signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<RepositoryOrchestrationView> {
    assertDedicatedIntegrationBranch(project);
    return this.queue.serializeRepositoryCancellation({ project, signal, appendUnderLease: () => {
      this.append(project.projectId, "repository.cancellation_requested", {
        schemaVersion: 1, requestedBy, reason, requestedAt: this.timestamp(),
      }, correlationId);
      return this.inspect(project.projectId);
    } });
  }

  inspect(projectId: string): RepositoryOrchestrationView {
    return projectRepositoryOrchestration(this.journal.readStream(repositoryOrchestrationStreamId(projectId)));
  }

  private append(projectId: string, type: string, payload: unknown, correlationId: string,
    causationId: string | null = null): void {
    this.appendMany(projectId, [{ type, payload }], correlationId, false, causationId);
  }

  private appendMany(projectId: string, events: readonly { readonly type: string; readonly payload: unknown }[],
    correlationId: string, requireActive = false, initialCausationId: string | null = null): void {
    const streamId = repositoryOrchestrationStreamId(projectId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const expectedVersion = this.journal.readStream(streamId).at(-1)?.streamVersion ?? 0;
      if (requireActive && projectRepositoryOrchestration(this.journal.readStream(streamId)).cancelled) {
        throw new Error("repository orchestration is cancelled");
      }
      try {
        let causationId = this.journal.readStream(streamId).at(-1)?.eventId ?? initialCausationId;
        const chained = events.map((event) => {
          const eventId = randomUUID();
          const next = { streamId, eventId, type: event.type, payload: event.payload, causationId, correlationId };
          causationId = eventId;
          return next;
        });
        this.journal.append(streamId, expectedVersion, chained);
        return;
      } catch (error) {
        if (!(error instanceof Error) || !/^expected version \d+, actual \d+$/.test(error.message)) throw error;
      }
    }
    throw new Error("repository orchestration append did not converge");
  }

  private async readCommit(repositoryPath: string, ref: string): Promise<string> {
    const result = await this.git.run(repositoryPath, ["rev-parse", "--verify", `${ref}^{commit}`],
      { timeoutMs: 30_000 });
    if (result.termination !== null || result.exitCode !== 0 || result.truncated || !Commit.safeParse(result.stdout.trim()).success) {
      throw new Error("repository commit identity could not be read exactly");
    }
    return result.stdout.trim();
  }

  private async readMergeBase(repositoryPath: string, left: string, right: string): Promise<string> {
    const result = await this.git.run(repositoryPath, ["merge-base", left, right], { timeoutMs: 30_000 });
    if (result.termination !== null || result.exitCode !== 0 || result.truncated ||
      !Commit.safeParse(result.stdout.trim()).success) {
      throw new Error("unit member merge base could not be read exactly");
    }
    return result.stdout.trim();
  }

  private async readSourceDiff(repositoryPath: string, baseCommit: string, sourceCommit: string): Promise<{
    readonly paths: readonly string[]; readonly sha256: string } > {
    Commit.parse(baseCommit);
    const diff = await this.git.run(repositoryPath, ["-c", "core.quotepath=off", "diff", "--binary",
      "--no-ext-diff", "--no-textconv", baseCommit, sourceCommit], { timeoutMs: 30_000 });
    const names = await this.git.run(repositoryPath, ["-c", "core.quotepath=off", "diff", "--name-only", "-z",
      "--no-ext-diff", baseCommit, sourceCommit], { timeoutMs: 30_000 });
    if (diff.termination !== null || names.termination !== null || diff.exitCode !== 0 || names.exitCode !== 0 ||
      diff.truncated || names.truncated) throw new Error("repository admission diff could not be read exactly");
    const paths = names.stdout.split("\0").filter(Boolean).sort();
    CanonicalPaths.min(1).parse(paths);
    return Object.freeze({ paths: Object.freeze(paths), sha256: sha256(diff.stdout) });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function normalizeBranch(branch: string): string {
  if (branch.startsWith("refs/heads/")) return branch.slice("refs/heads/".length);
  if (branch.startsWith("refs/")) throw new Error("only local branch refs are supported");
  return branch;
}

export interface RepositoryOrchestrationView {
  readonly projectId: string | null;
  readonly streamVersion: number;
  readonly cancelled: boolean;
  readonly units: Readonly<Record<string, RepositoryUnitView>>;
  readonly integratedCommits: readonly string[];
  readonly ownershipConflicts: number;
  readonly admissions: Readonly<Record<string, IntegrationSubmission>>;
}

export function repositoryOrchestrationStreamId(projectId: string): string {
  return `repository-orchestration:${Id.parse(projectId)}`;
}

export function projectRepositoryOrchestration(events: readonly StoredEvent[]): RepositoryOrchestrationView {
  let projectId: string | null = null;
  let streamVersion = 0;
  let cancelled = false;
  let ownershipConflicts = 0;
  const units: Record<string, RepositoryUnitView> = Object.create(null) as Record<string, RepositoryUnitView>;
  const integratedCommits: string[] = [];
  const admissions: Record<string, IntegrationSubmission> = Object.create(null) as Record<string, IntegrationSubmission>;
  for (const event of events) {
    const parsedProject = event.streamId.startsWith("repository-orchestration:")
      ? event.streamId.slice("repository-orchestration:".length) : "";
    Id.parse(parsedProject);
    if (projectId !== null && projectId !== parsedProject) throw new Error("repository stream project changed");
    if (event.streamVersion !== streamVersion + 1) throw new Error("repository stream version is not contiguous");
    projectId = parsedProject;
    streamVersion = event.streamVersion;
    if (event.type === "repository.submission_admitted") {
      const receipt = z.strictObject({ schemaVersion: z.literal(1), receipt: IntegrationSubmissionSchema })
        .parse(event.payload).receipt;
      if (receipt.projectId !== parsedProject || admissions[receipt.receiptId] !== undefined) {
        throw new Error("durable admission receipt project or identity is invalid");
      }
      admissions[receipt.receiptId] = receipt;
      continue;
    }
    if (event.type === "ownership.conflict_observed") {
      OwnershipConflictPayload.parse(event.payload);
      ownershipConflicts += 1;
      continue;
    }
    if (event.type === "integration.unit_formed") {
      const payload = UnitFormedPayload.parse(event.payload);
      IntegrationUnitSchema.parse({ unitId: payload.unitId, contractId: payload.contractId,
        taskIds: payload.taskIds, podIds: payload.podIds, paths: payload.paths,
        sourceCommits: payload.sourceCommits, admissionReceipts: payload.admissionReceipts,
        tightlyCoupled: payload.tightlyCoupled });
      if (units[payload.unitId] !== undefined) throw new Error("integration unit already exists");
      if (payload.admissionReceipts.some((receipt) =>
        admissions[receipt.receiptId]?.digest !== receipt.digest)) {
        throw new Error("integration unit lacks exact prior durable admission receipts");
      }
      units[payload.unitId] = freezeUnit({ ...payload, status: "formed", expectedCommit: null,
        resultCommit: null, conflictId: null, replanDigest: null,
        acceptanceRejectionSha256: null, correctionCount: 0, replanAttempt: 0,
        replanMaxAttempts: null, pendingReplanReceipts: Object.freeze([]), correctionDigest: null,
        correctionMaxAttempts: null, pendingCorrectionReceipts: Object.freeze([]) });
      continue;
    }
    if (event.type === "repository.cancellation_requested") {
      CancellationPayload.parse(event.payload);
      cancelled = true;
      continue;
    }
    const unitId = z.object({ unitId: Id }).parse(event.payload).unitId;
    const unit = units[unitId];
    if (unit === undefined) throw new Error("repository event references an unknown integration unit");
    if (event.type === "integration.candidate_created") {
      const payload = CandidatePayload.parse(event.payload);
      assertStatus(unit, ["formed"]);
      units[unitId] = freezeUnit({ ...unit, status: "candidate", expectedCommit: payload.expectedCommit });
    } else if (event.type === "integration.candidate_validated" || event.type === "rebase.validated") {
      const payload = CandidateValidatedPayload.parse(event.payload);
      assertStatus(unit, ["candidate"]);
      units[unitId] = freezeUnit({ ...unit, status: "validated", resultCommit: payload.candidateCommit });
    } else if (event.type === "integration.candidate_rejected") {
      RejectedPayload.parse(event.payload);
      assertStatus(unit, ["formed", "candidate", "validated"]);
      units[unitId] = freezeUnit({ ...unit, status: "rejected" });
    } else if (event.type === "conflict.observed") {
      const payload = ConflictPayload.parse(event.payload);
      assertStatus(unit, ["formed", "candidate"]);
      units[unitId] = freezeUnit({ ...unit, status: "conflicted", conflictId: payload.conflictId });
    } else if (event.type === "replan.proposed") {
      const payload = ReplanPayload.parse(event.payload);
      assertStatus(unit, ["conflicted", "correction_pending"]);
      if (unit.conflictId !== null && payload.conflictId !== unit.conflictId) {
        throw new Error("replan does not bind the observed conflict");
      }
      if (payload.attempt !== unit.replanAttempt + 1 ||
        (unit.replanMaxAttempts !== null && payload.maxAttempts !== unit.replanMaxAttempts)) {
        throw new Error("replan attempt or maximum is not monotonic and exact");
      }
      if (payload.replacementAdmissionReceipts.some((receipt) =>
        admissions[receipt.receiptId]?.digest !== receipt.digest)) {
        throw new Error("replan replacement admission is not durable");
      }
      const approvalDigest = sha256(JSON.stringify({ projectId: parsedProject, unitId: payload.unitId,
        conflictId: payload.conflictId, attempt: payload.attempt, maxAttempts: payload.maxAttempts,
        changedPaths: payload.changedPaths,
        behaviorChanges: payload.behaviorChanges, authorityChanges: payload.authorityChanges,
        rationale: payload.rationale, replacementAdmissionReceipts: payload.replacementAdmissionReceipts }));
      if (approvalDigest !== payload.approvalDigest) throw new Error("replan approval digest is not exact");
      units[unitId] = freezeUnit({ ...unit, status: "awaiting_approval",
        replanDigest: payload.approvalDigest, replanAttempt: payload.attempt,
        replanMaxAttempts: payload.maxAttempts,
        pendingReplanReceipts: Object.freeze(payload.replacementAdmissionReceipts) });
    } else if (event.type === "replan.approved") {
      const payload = ReplanDecisionPayload.parse(event.payload);
      if (unit.status !== "awaiting_approval" || payload.approvalDigest !== unit.replanDigest) {
        throw new Error("replan approval does not match the exact pending proposal");
      }
      const replacementUnits = formIntegrationUnits(unit.pendingReplanReceipts);
      if (replacementUnits.length !== 1) throw new Error("approved replan does not form one valid integration unit");
      const replacement = replacementUnits[0]!;
      units[unitId] = freezeUnit({ ...unit, status: "formed", contractId: replacement.contractId,
        taskIds: replacement.taskIds, podIds: replacement.podIds, paths: replacement.paths,
        sourceCommits: replacement.sourceCommits, admissionReceipts: replacement.admissionReceipts,
        pendingReplanReceipts: Object.freeze([]) });
    } else if (event.type === "replan.rejected") {
      ReplanDecisionPayload.parse(event.payload);
      assertStatus(unit, ["awaiting_approval"]);
      units[unitId] = freezeUnit({ ...unit, status: "rejected" });
    } else if (event.type === "integration.committed") {
      const payload = CommittedPayload.parse(event.payload);
      assertStatus(unit, ["validated"]);
      units[unitId] = freezeUnit({ ...unit, status: "integrated", expectedCommit: payload.expectedCommit,
        resultCommit: payload.resultCommit });
      integratedCommits.push(payload.resultCommit);
    } else if (event.type === "final_acceptance.requested") {
      AcceptanceRequestedPayload.parse(event.payload);
      assertStatus(unit, ["integrated"]);
      units[unitId] = freezeUnit({ ...unit, status: "acceptance_pending" });
    } else if (event.type === "final_acceptance.accepted") {
      AcceptanceDecisionPayload.parse(event.payload);
      assertStatus(unit, ["acceptance_pending"]);
      units[unitId] = freezeUnit({ ...unit, status: "accepted" });
    } else if (event.type === "final_acceptance.rejected") {
      const payload = AcceptanceDecisionPayload.parse(event.payload);
      assertStatus(unit, ["acceptance_pending"]);
      units[unitId] = freezeUnit({ ...unit, status: "correction_pending",
        acceptanceRejectionSha256: sha256(JSON.stringify(payload)) });
    } else if (event.type === "correction.planned") {
      const payload = CorrectionPayload.parse(event.payload);
      assertStatus(unit, ["correction_pending"]);
      if (payload.projectId !== parsedProject) throw new Error("correction project identity is invalid");
      if (payload.attempt !== unit.correctionCount + 1 || payload.attempt > payload.maxAttempts ||
        (unit.correctionMaxAttempts !== null && payload.maxAttempts !== unit.correctionMaxAttempts)) {
        throw new Error("correction exceeds its exact bounded sequence");
      }
      if (payload.acceptanceRejectionSha256 !== unit.acceptanceRejectionSha256) {
        throw new Error("correction does not bind the exact final acceptance rejection");
      }
      if (payload.paths.some((candidate) => !unit.paths.some((owned) => pathClaimContains(owned, candidate)))) {
        throw new Error("correction expands the original integration unit path scope");
      }
      if (payload.replacementAdmissionReceipts.some((receipt) =>
        admissions[receipt.receiptId]?.digest !== receipt.digest ||
        receipt.changedPaths.some((candidate) => !payload.paths.some((allowed) => pathClaimContains(allowed, candidate))))) {
        throw new Error("correction replacement admission is not durable or exceeds its envelope");
      }
      const expectedDigest = sha256(JSON.stringify({ projectId: parsedProject, unitId: payload.unitId,
        attempt: payload.attempt, maxAttempts: payload.maxAttempts,
        acceptanceRejectionSha256: payload.acceptanceRejectionSha256, paths: payload.paths,
        behaviorChanges: payload.behaviorChanges, authorityChanges: payload.authorityChanges,
        rationale: payload.rationale, replacementAdmissionReceipts: payload.replacementAdmissionReceipts }));
      if (expectedDigest !== payload.approvalDigest) throw new Error("correction approval digest is not exact");
      const changed = payload.replacementAdmissionReceipts.some((receipt, index) =>
        receipt.digest !== unit.admissionReceipts[index]?.digest);
      if (changed !== payload.requiresApproval) throw new Error("correction approval requirement contradicts replacement");
      const next = { ...unit, correctionCount: payload.attempt, correctionMaxAttempts: payload.maxAttempts,
        correctionDigest: payload.approvalDigest,
        pendingCorrectionReceipts: Object.freeze(payload.replacementAdmissionReceipts) };
      units[unitId] = payload.requiresApproval
        ? freezeUnit({ ...next, status: "correction_awaiting_approval" })
        : applyReplacementUnit(next, payload.replacementAdmissionReceipts);
    } else if (event.type === "correction.approved") {
      const payload = CorrectionDecisionPayload.parse(event.payload);
      if (unit.status !== "correction_awaiting_approval" || payload.approvalDigest !== unit.correctionDigest) {
        throw new Error("correction approval does not match exact pending replacement");
      }
      units[unitId] = applyReplacementUnit(unit, unit.pendingCorrectionReceipts);
    } else if (event.type === "correction.rejected") {
      const payload = CorrectionDecisionPayload.parse(event.payload);
      if (unit.status !== "correction_awaiting_approval" || payload.approvalDigest !== unit.correctionDigest) {
        throw new Error("correction rejection does not match exact pending replacement");
      }
      units[unitId] = freezeUnit({ ...unit, status: "rejected", pendingCorrectionReceipts: Object.freeze([]) });
    } else if (event.type === "rebase.started" || event.type === "rebase.completed") {
      RebasePayload.parse(event.payload);
    } else {
      throw new Error(`unknown repository orchestration event: ${event.type}`);
    }
  }
  return Object.freeze({ projectId, streamVersion, cancelled, units: Object.freeze(units),
    integratedCommits: Object.freeze(integratedCommits), ownershipConflicts,
    admissions: Object.freeze(admissions) });
}

const UnitFormedPayload = z.strictObject({ schemaVersion: z.literal(1), unitId: Id, contractId: Id,
  taskIds: CanonicalIds, podIds: CanonicalIds, paths: CanonicalPaths.min(1),
  sourceCommits: z.array(Commit).min(1).max(256), admissionReceipts: z.array(IntegrationSubmissionSchema).min(1).max(256),
  tightlyCoupled: z.boolean(), formedAt: Timestamp });
const OwnershipConflictPayload = z.strictObject({ schemaVersion: z.literal(1), podId: Id, taskId: Id,
  conflictingClaimIds: CanonicalIds, observedAt: Timestamp });
const CandidatePayload = z.strictObject({ schemaVersion: z.literal(1), unitId: Id, candidateId: Id,
  expectedCommit: Commit, createdAt: Timestamp });
const CandidateValidatedPayload = z.strictObject({ schemaVersion: z.literal(1), unitId: Id,
  candidateCommit: Commit, validationSha256: Digest, validatedAt: Timestamp });
const RejectedPayload = z.strictObject({ schemaVersion: z.literal(1), unitId: Id, reason: Text,
  rejectedAt: Timestamp });
const ConflictPayload = z.strictObject({ schemaVersion: z.literal(1), unitId: Id, conflictId: Id,
  paths: CanonicalPaths, analysisSha256: Digest, observedAt: Timestamp });
const ReplanPayload = z.strictObject({ schemaVersion: z.literal(1), unitId: Id, conflictId: Id,
  approvalDigest: Digest, requiresApproval: z.literal(true), attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive().max(16), changedPaths: CanonicalPaths,
  behaviorChanges: z.array(Text).max(128), authorityChanges: z.array(Text).max(128),
  rationale: Text, replacementAdmissionReceipts: z.array(IntegrationSubmissionSchema).min(1).max(256),
  proposedAt: Timestamp }).refine((payload) => payload.attempt <= payload.maxAttempts,
    "replan budget is exhausted");
const ReplanDecisionPayload = z.strictObject({ schemaVersion: z.literal(1), unitId: Id,
  approvalDigest: Digest, decidedBy: Id, decidedAt: Timestamp });
const RebasePayload = z.strictObject({ schemaVersion: z.literal(1), unitId: Id, fromCommit: Commit,
  ontoCommit: Commit, resultCommit: Commit.nullable(), observedAt: Timestamp });
const CommittedPayload = z.strictObject({ schemaVersion: z.literal(1), unitId: Id,
  expectedCommit: Commit, resultCommit: Commit, committedAt: Timestamp });
const AcceptanceRequestedPayload = z.strictObject({ schemaVersion: z.literal(1), unitId: Id,
  resultCommit: Commit, evidenceSha256: Digest, requestedAt: Timestamp });
const AcceptanceDecisionPayload = z.strictObject({ schemaVersion: z.literal(1), unitId: Id,
  resultCommit: Commit, decidedBy: Id, reason: Text, decidedAt: Timestamp });
const CorrectionPayload = z.strictObject({ schemaVersion: z.literal(1), projectId: Id, unitId: Id,
  attempt: z.number().int().positive(), maxAttempts: z.number().int().positive().max(16),
  paths: CanonicalPaths.min(1), acceptanceRejectionSha256: Digest, approvalDigest: Digest,
  requiresApproval: z.boolean(), behaviorChanges: z.array(Text).max(128),
  authorityChanges: z.array(Text).max(128), rationale: Text,
  replacementAdmissionReceipts: z.array(IntegrationSubmissionSchema).min(1).max(256),
  plannedAt: Timestamp });
const CorrectionDecisionPayload = z.strictObject({ schemaVersion: z.literal(1), unitId: Id,
  approvalDigest: Digest, decidedBy: Id, decidedAt: Timestamp });
const CancellationPayload = z.strictObject({ schemaVersion: z.literal(1), requestedBy: Id,
  reason: Text, requestedAt: Timestamp });

function unitFrom(members: readonly IntegrationSubmission[], tightlyCoupled: boolean): IntegrationUnit {
  const sorted = [...members].sort((left, right) => left.taskId.localeCompare(right.taskId));
  const contractId = sorted[0]!.contract.contractDigest;
  if (sorted.some((item) => item.contract.contractDigest !== contractId)) throw new Error("unit contract identities differ");
  return IntegrationUnitSchema.parse({
    unitId: `unit:${sha256(JSON.stringify(sorted.map((item) => item.taskId))).slice(0, 32)}`,
    contractId,
    podIds: sorted.map((item) => item.podId).sort(),
    taskIds: sorted.map((item) => item.taskId),
    sourceCommits: sorted.map((item) => item.sourceCommit),
    paths: [...new Set(sorted.flatMap((item) => item.changedPaths))].sort(),
    tightlyCoupled,
    admissionReceipts: sorted,
  });
}

function canonicalSet(values: readonly string[], context: z.RefinementCtx): void {
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    context.addIssue({ code: "custom", message: "set values must be unique and canonically sorted" });
  }
}

function assertStatus(unit: RepositoryUnitView, allowed: readonly RepositoryUnitView["status"][]): void {
  if (!allowed.includes(unit.status)) throw new Error(`unit ${unit.unitId} cannot transition from ${unit.status}`);
}

function freezeUnit<T extends RepositoryUnitView>(unit: T): T {
  return Object.freeze({ ...unit, taskIds: Object.freeze([...unit.taskIds]),
    podIds: Object.freeze([...unit.podIds]), paths: Object.freeze([...unit.paths]),
    sourceCommits: Object.freeze([...unit.sourceCommits]),
    admissionReceipts: Object.freeze([...unit.admissionReceipts]),
    pendingReplanReceipts: Object.freeze([...unit.pendingReplanReceipts]),
    pendingCorrectionReceipts: Object.freeze([...unit.pendingCorrectionReceipts]) });
}

function applyReplacementUnit(unit: RepositoryUnitView,
  receipts: readonly IntegrationSubmission[]): RepositoryUnitView {
  const replacements = formIntegrationUnits(receipts);
  if (replacements.length !== 1) throw new Error("correction replacement does not form one valid integration unit");
  const replacement = replacements[0]!;
  return freezeUnit({ ...unit, status: "formed", contractId: replacement.contractId,
    taskIds: replacement.taskIds, podIds: replacement.podIds, paths: replacement.paths,
    sourceCommits: replacement.sourceCommits, admissionReceipts: replacement.admissionReceipts,
    pendingCorrectionReceipts: Object.freeze([]) });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
