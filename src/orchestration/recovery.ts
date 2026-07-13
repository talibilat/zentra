import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { ValidationReportSchema } from "../capabilities/validation-runner.js";
import type { StoredEvent } from "../contracts/event.js";
import type { EventJournal } from "../journal/journal.js";
import type { ProjectConfig } from "../projects/project-config.js";
import type { ProjectRegistry } from "../projects/project-registry.js";
import {
  canonicalValidationDigest,
  ReviewDecisionSchema,
} from "../reviews/reviewer-adapter.js";
import type { TaskService } from "../tasks/task-service.js";
import type { TaskView } from "../tasks/task-projection.js";
import {
  assertNoGitObjectSubstitution,
  type CommandResult,
  type GitClient,
} from "../workspaces/git-client.js";
import type { WorktreeManager } from "../workspaces/worktree-manager.js";

const GIT_READ_TIMEOUT_MS = 30_000;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const EXTERNAL_PROGRAM_CONFIG =
  "^(merge\\..*\\.driver|diff\\.external|diff\\..*\\.(command|textconv)|filter\\..*\\.(clean|smudge|process))$";
const SAFE_READ_CONFIG = [
  "--no-optional-locks",
  "--no-replace-objects",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
] as const;

const LeasePayloadSchema = z.strictObject({
  leaseOwner: z.string().min(1),
  workspace: z.string().min(1),
});
const WorktreeCreationStartedPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  branch: z.string().min(1),
  path: z.string().min(1),
  baseCommit: z.string().regex(COMMIT_ID),
});
const StartedPayloadSchema = z.strictObject({
  workerId: z.string().min(1),
});
const SafePatchPathSchema = z.string().min(1).refine((candidate) =>
  !candidate.includes("\0") &&
  !candidate.includes("\n") &&
  !candidate.includes("\r") &&
  !candidate.includes("/") &&
  !candidate.includes("\\") &&
  candidate !== "." &&
  candidate !== ".."
);
const ArtifactReadySchema = z.strictObject({
  type: z.literal("artifact.ready"),
  path: SafePatchPathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const ValidationStartedPayloadSchema = z.strictObject({
  patch: ArtifactReadySchema,
  diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const ReviewRequestedPayloadSchema = z.strictObject({
  reviewerId: z.string().min(1),
  validation: ValidationReportSchema,
});
const ReviewApprovedPayloadSchema = z.strictObject({
  review: ReviewDecisionSchema,
});
const IntegrationStartedPayloadSchema = z.strictObject({
  sourceCommit: z.string().regex(COMMIT_ID),
  review: ReviewDecisionSchema,
});
const IntegrationReceiptSchema = z.strictObject({
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  sourceCommit: z.string().regex(COMMIT_ID),
  originalIntegrationCommit: z.string().regex(COMMIT_ID),
  resultCommit: z.string().regex(COMMIT_ID),
  review: ReviewDecisionSchema,
  validation: ValidationReportSchema,
  outcome: z.literal("completed"),
});
const CleanupFailureSchema = z.strictObject({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  candidatePath: z.string().min(1),
  reason: z.string().min(1),
  timestamp: z.string().datetime(),
});
const CleanupFailuresSchema = z.array(CleanupFailureSchema).optional();
const IntegrationPreparedPayloadSchema = z.strictObject({
  receipt: IntegrationReceiptSchema,
});
const IntegrationObservedPayloadSchema = z.strictObject({
  receipt: IntegrationReceiptSchema,
  verification: z.literal("verified"),
  cleanupFailures: CleanupFailuresSchema,
});
const CommitObservedPayloadSchema = z.strictObject({
  stage: z.literal("commit"),
  reason: z.string().min(1),
});
const IntegrationUncertainPayloadSchema = z.strictObject({
  reason: z.string().min(1),
  evidence: z.strictObject({
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    sourceCommit: z.string().regex(COMMIT_ID),
    resultCommit: z.string().regex(COMMIT_ID),
    reconciledHead: z.string().regex(COMMIT_ID).nullable(),
    reconciliationIssue: z.string().nullable(),
    candidatePath: z.string().min(1),
  }),
  cleanupFailures: CleanupFailuresSchema,
});
const IntegrationErrorPayloadSchema = z.strictObject({
  error: z.strictObject({
    name: z.string().min(1),
    message: z.string(),
  }),
  cleanupFailures: CleanupFailuresSchema,
});
const IntegrationVerificationFailedPayloadSchema = z.strictObject({
  receipt: IntegrationReceiptSchema,
  verification: z.literal("failed"),
  reason: z.string().min(1),
  cleanupFailures: CleanupFailuresSchema,
});
const CleanupStartedPayloadSchema = z.strictObject({
  sourceCommit: z.string().regex(COMMIT_ID),
  resultCommit: z.string().regex(COMMIT_ID),
  workspace: z.string().min(1),
  branch: z.string().min(1),
});
const CleanupCompletedPayloadSchema = CleanupStartedPayloadSchema;
const CleanupObservedPayloadSchema = z.strictObject({
  phase: z.string().min(1),
  uncertain: z.boolean(),
  evidence: z.record(z.string(), z.unknown()),
  reason: z.string().min(1),
});
const CleanupReconciledPayloadSchema = z.strictObject({
  cleanup: CleanupStartedPayloadSchema,
  observation: CleanupObservedPayloadSchema,
});
const CompletedPayloadSchema = z.strictObject({
  receipt: IntegrationReceiptSchema,
});
const CreatedPayloadSchema = z.strictObject({
  projectId: z.string().min(1),
  title: z.string().min(1),
});

interface RecoveryChain {
  readonly created: z.infer<typeof CreatedPayloadSchema>;
  readonly worktreeCreationStarted: z.infer<typeof WorktreeCreationStartedPayloadSchema> | null;
  readonly lease: z.infer<typeof LeasePayloadSchema> | null;
  readonly started: z.infer<typeof StartedPayloadSchema> | null;
  readonly validationStarted: z.infer<typeof ValidationStartedPayloadSchema> | null;
  readonly reviewRequested: z.infer<typeof ReviewRequestedPayloadSchema> | null;
  readonly reviewApproved: z.infer<typeof ReviewApprovedPayloadSchema> | null;
  readonly integrationStarted: z.infer<typeof IntegrationStartedPayloadSchema> | null;
  readonly integrationPrepared: z.infer<typeof IntegrationPreparedPayloadSchema> | null;
  readonly integrationObserved: z.infer<typeof IntegrationObservedPayloadSchema> | null;
  readonly cleanupStarted: z.infer<typeof CleanupStartedPayloadSchema> | null;
  readonly cleanupCompleted: z.infer<typeof CleanupCompletedPayloadSchema> | null;
  readonly cleanupObserved: z.infer<typeof CleanupObservedPayloadSchema> | null;
  readonly cleanupReconciled: z.infer<typeof CleanupReconciledPayloadSchema> | null;
}

export interface RecoveryDecision {
  readonly taskId: string;
  readonly action: "resume_preparation" | "await_reconciliation" | "record_completion" | "record_failure";
  readonly reason: string;
}

// Actions are recovery classifications, not imperative commands.
// In particular, record_failure diagnoses missing/corrupt state and does not
// itself authorize an event append; terminal await_reconciliation is a no-op.

interface WorkspaceInspection {
  readonly path: string;
  readonly registered: boolean;
  readonly branchExists: boolean;
  readonly pathExists: boolean;
  readonly head: string | null;
  readonly dirty: boolean | null;
  readonly diff: string | null;
}

export class RecoveryService {
  constructor(
    private readonly journal: EventJournal,
    private readonly tasks: TaskService,
    private readonly projects: ProjectRegistry,
    private readonly worktrees: WorktreeManager,
    private readonly git: GitClient,
  ) {}

  async inspect(taskId: string): Promise<RecoveryDecision> {
    if (!isSafeTaskId(taskId)) {
      return decision(taskId, "record_failure", "task id must be one safe path and ref component");
    }
    let events: readonly StoredEvent[];
    try {
      events = this.journal.readStream(taskId);
    } catch (error) {
      return decision(taskId, "record_failure", `journal read failed closed: ${errorMessage(error)}`);
    }
    if (events.length === 0) {
      return decision(
        taskId,
        "record_failure",
        `diagnostic only: task ${taskId} was not found in the journal; no event append is implied`,
      );
    }

    const hasUncertainEffect = events.some((event) =>
      event.type === "task.worktree_creation_started" ||
      event.type === "task.started" ||
      event.type === "task.commit_observed" ||
      event.type === "task.integration_started" ||
      event.type === "task.integration_prepared" ||
      event.type === "task.integration_observed" ||
      event.type.startsWith("task.cleanup_")
    );
    const hasCommitOrIntegrationEffect = events.some((event) =>
      event.type === "task.commit_observed" ||
      event.type === "task.integration_started" ||
      event.type === "task.integration_prepared" ||
      event.type === "task.integration_observed" ||
      event.type.startsWith("task.cleanup_")
    );

    let chain: RecoveryChain;
    try {
      chain = reconstructChain(taskId, events);
    } catch (error) {
      return decision(
        taskId,
        hasCommitOrIntegrationEffect ? "await_reconciliation" : "record_failure",
        `durable event chain is invalid: ${errorMessage(error)}`,
      );
    }

    try {
      // Rebuild through the public projection before trusting individual payloads.
      const task = this.tasks.get(taskId);
      if (task === null) {
        return decision(taskId, "record_failure", `task ${taskId} could not be projected`);
      }
      const project = this.projects.get(task.projectId);
      if (chain.created.projectId !== project.projectId) {
        return decision(taskId, "record_failure", "task project evidence contradicts project configuration");
      }

      // Keep the constructor boundary exact without invoking mutation-capable manager methods.
      void this.worktrees;
      await this.assertSafeGitConfiguration(project.repositoryPath);
      const workspace = await this.inspectWorkspace(project, taskId, chain);

      if (task.lifecycle === "terminal") {
        // The fixed plan vocabulary has no no_op action. For terminal tasks,
        // await_reconciliation explicitly means the caller must perform no effect.
        return decision(
          taskId,
          "await_reconciliation",
          `task is already terminal with outcome ${task.terminalOutcome}; await_reconciliation is a no-op and no recovery effect is required`,
        );
      }

      const last = events.at(-1)!;
      if (last.type === "task.created") {
        if (workspace.registered || workspace.branchExists) {
          return decision(
            taskId,
            "await_reconciliation",
            "workspace preparation has durable Git effects that are not recorded by a lease",
          );
        }
        if (workspace.pathExists) {
          return decision(
            taskId,
            "record_failure",
            "configured ticket path exists but is not an exact registered worktree",
          );
        }
        return decision(taskId, "resume_preparation", "task creation is durable and workspace preparation has not started");
      }

      if (last.type === "task.worktree_creation_started") {
        const intent = chain.worktreeCreationStarted!;
        // Compare against the raw (non-canonicalized) configured path, the
        // same identity WorktreeManager.create() recorded and the same
        // comparison used for the durable task.leased workspace path above.
        const rawExpectedPath = path.resolve(project.worktreeRoot, taskId);
        if (
          intent.path !== rawExpectedPath ||
          intent.branch !== `ticket/${taskId}` ||
          !COMMIT_ID.test(intent.baseCommit)
        ) {
          return decision(
            taskId,
            "await_reconciliation",
            "prepared worktree creation intent does not match the current project configuration; preserved for operator review",
          );
        }

        if (!workspace.registered && !workspace.branchExists && !workspace.pathExists) {
          const preparedBase = await this.readCommit(project.repositoryPath, intent.baseCommit);
          if (preparedBase !== intent.baseCommit) {
            return decision(
              taskId,
              "await_reconciliation",
              "prepared integration base commit is unavailable; creation must not be retried",
            );
          }
          // No durable Git effect occurred at all: safe to resume/retry creation.
          return decision(
            taskId,
            "resume_preparation",
            "prepared worktree creation intent is durable but no Git effect occurred; creation may be resumed",
          );
        }

        if (workspace.registered && workspace.branchExists && workspace.pathExists) {
          // Fully created: verify the branch base is exactly the intended
          // base before adopting it as if task.leased had been recorded.
          if (workspace.head !== intent.baseCommit) {
            // Competing identity: a worktree/branch with the intended name
            // exists but does not point at the intended base. Never delete
            // or retry automatically; preserve for an operator.
            return decision(
              taskId,
              "await_reconciliation",
              "ticket branch exists but does not point at the exact intended base commit; preserved for operator review",
            );
          }
          if (workspace.dirty) {
            return decision(
              taskId,
              "await_reconciliation",
              "fully created ticket worktree is unexpectedly dirty before any worker has started",
            );
          }
          // Exact intended state: adopt it as if task.leased had already
          // been recorded, so the caller can resume from the leased stage.
          return decision(
            taskId,
            "resume_preparation",
            "worktree creation reached the exact intended branch, path, and base; safe to adopt and resume from the leased stage",
          );
        }

        // Partial or competing state: some but not all of registration,
        // branch, and path exist, or they exist without matching the
        // intended identity. Never auto-clean or auto-retry; preserve for
        // an operator to reconcile.
        return decision(
          taskId,
          "await_reconciliation",
          "worktree creation left partial or competing Git state that must not be automatically retried or cleaned up",
        );
      }

      if (last.type === "task.cleanup_started") {
        if (workspace.registered || workspace.pathExists || workspace.branchExists) {
          return decision(
            taskId,
            "await_reconciliation",
            "cleanup started but exact ticket worktree or ref state remains; cleanup must not be retried automatically",
          );
        }
        const observed = chain.integrationObserved;
        if (observed === null) {
          return decision(taskId, "await_reconciliation", "verified integration evidence is missing before cleanup");
        }
        const issue = await this.completionEvidenceIssue(
          project,
          taskId,
          chain,
          {
            ...workspace,
            head: observed.receipt.sourceCommit,
            dirty: false,
            diff: "",
          },
          observed.receipt,
        );
        return issue === null
          ? decision(taskId, "record_completion", "cleanup effects are absent and durable completion may be recorded")
          : decision(taskId, "await_reconciliation", issue);
      }

      if (
        last.type === "task.cleanup_observed" ||
        last.type === "task.cleanup_reconciled"
      ) {
        if (workspace.registered || workspace.pathExists || workspace.branchExists) {
          return decision(
            taskId,
            "await_reconciliation",
            "cleanup uncertainty remains while exact ticket worktree or ref state is present",
          );
        }
        const observed = chain.integrationObserved;
        if (observed === null) {
          return decision(taskId, "await_reconciliation", "verified integration evidence is missing before cleanup reconciliation");
        }
        const issue = await this.completionEvidenceIssue(
          project,
          taskId,
          chain,
          {
            ...workspace,
            head: observed.receipt.sourceCommit,
            dirty: false,
            diff: "",
          },
          observed.receipt,
        );
        return issue === null
          ? decision(taskId, "record_completion", "cleanup uncertainty was reconciled from exact absent ticket state")
          : decision(taskId, "await_reconciliation", issue);
      }

      if (last.type === "task.cleanup_completed") {
        if (workspace.registered || workspace.pathExists || workspace.branchExists) {
          return decision(
            taskId,
            "await_reconciliation",
            "durable cleanup completion contradicts remaining ticket worktree or ref state",
          );
        }
        const observed = chain.integrationObserved;
        if (observed === null) {
          return decision(taskId, "await_reconciliation", "verified integration evidence is missing before cleanup");
        }
        const virtualWorkspace: WorkspaceInspection = {
          ...workspace,
          head: observed.receipt.sourceCommit,
          dirty: false,
          diff: "",
        };
        const issue = await this.completionEvidenceIssue(
          project,
          taskId,
          chain,
          virtualWorkspace,
          observed.receipt,
        );
        return issue === null
          ? decision(taskId, "record_completion", "durable cleanup and integration evidence were strictly verified")
          : decision(taskId, "await_reconciliation", issue);
      }

      if (!workspace.registered) {
        return decision(
          taskId,
          hasUncertainEffect ? "await_reconciliation" : "record_failure",
          "the durable lease does not have an exact registered worktree",
        );
      }

      if (last.type === "task.leased") {
        if (workspace.dirty) {
          return decision(taskId, "await_reconciliation", "leased worktree is dirty from an unrecorded effect");
        }
        return decision(taskId, "resume_preparation", "exact clean leased worktree is ready to start the worker");
      }

      if (last.type === "task.started") {
        return decision(
          taskId,
          "await_reconciliation",
          workspace.dirty
            ? "worker effect is visible in the dirty worktree but no result was recorded"
            : "worker start is durable but its process result is uncertain",
        );
      }

      if (last.type === "task.validation_started") {
        const started = chain.validationStarted!;
        if (workspace.diff === null || sha256(workspace.diff) !== started.diffSha256) {
          return decision(taskId, "record_failure", "validation-start evidence does not match the exact worktree diff");
        }
        return decision(taskId, "resume_preparation", "validation is non-effectful and may be run again from the recorded diff");
      }

      if (last.type === "task.review_requested") {
        const requested = chain.reviewRequested!;
        const started = chain.validationStarted!;
        if (
          workspace.diff === null ||
          sha256(workspace.diff) !== started.diffSha256 ||
          !validFocusedValidation(project, requested.validation, workspace, started.diffSha256)
        ) {
          return decision(taskId, "record_failure", "durable focused validation evidence is invalid");
        }
        return decision(taskId, "resume_preparation", "focused validation is durable and review has not been recorded");
      }

      if (last.type === "task.review_approved") {
        const approved = chain.reviewApproved!;
        const requested = chain.reviewRequested!;
        let validationSha256: string | null = null;
        try {
          validationSha256 = canonicalValidationDigest(requested.validation);
        } catch {
          validationSha256 = null;
        }
        if (
          workspace.diff === null ||
          !validFocusedValidation(
            project,
            requested.validation,
            workspace,
            chain.validationStarted!.diffSha256,
          ) ||
          approved.review.validationSha256 !== validationSha256 ||
          approved.review.diffSha256 !== chain.validationStarted!.diffSha256
        ) {
          return decision(taskId, "record_failure", "durable review evidence is invalid");
        }
        if (workspace.dirty && sha256(workspace.diff) === approved.review.diffSha256) {
          return decision(taskId, "resume_preparation", "approved reviewed diff remains uncommitted and may proceed to commit");
        }
        return decision(taskId, "await_reconciliation", "worktree no longer matches the approved uncommitted diff; commit effect is uncertain");
      }

      if (last.type === "task.commit_observed") {
        return decision(taskId, "await_reconciliation", "Task 8 recorded an uncertain commit result that must not be retried");
      }

      if (last.type === "task.integration_started") {
        await this.inspectIntegrationStart(project, chain, workspace);
        return decision(taskId, "await_reconciliation", "integration or merge effect started without a durable result and must not be retried");
      }


      if (last.type === "task.integration_prepared") {
        await assertNoGitObjectSubstitution(this.git, project.repositoryPath, GIT_READ_TIMEOUT_MS);
        await this.inspectIntegrationStart(project, chain, workspace);
        const prepared = chain.integrationPrepared;
        if (prepared === null) {
          return decision(taskId, "await_reconciliation", "prepared integration evidence is invalid or missing");
        }
        const verified = await this.completionEvidenceIssue(
          project,
          taskId,
          chain,
          workspace,
          prepared.receipt,
        );
        return verified === null
          ? decision(
              taskId,
              "record_completion",
              "prepared receipt and exact post-CAS integration ref were strictly verified",
            )
          : decision(taskId, "await_reconciliation", verified);
      }

      if (last.type === "task.integration_observed") {
        await assertNoGitObjectSubstitution(this.git, project.repositoryPath, GIT_READ_TIMEOUT_MS);
        await this.inspectIntegrationStart(project, chain, workspace);
        const observed = IntegrationObservedPayloadSchema.safeParse(last.payload);
        if (!observed.success) {
          return decision(taskId, "await_reconciliation", "integration evidence is uncertain, invalid, missing, or truncated");
        }
        const verified = await this.completionEvidenceIssue(
          project,
          taskId,
          chain,
          workspace,
          observed.data.receipt,
        );
        if (verified !== null) {
          return decision(taskId, "await_reconciliation", verified);
        }
        return decision(
          taskId,
          "record_completion",
          "durable integration evidence and current Git state were strictly verified after restart",
        );
      }

      return decision(taskId, "record_failure", `unsupported recovery event ${last.type}`);
    } catch (error) {
      return decision(
        taskId,
        hasUncertainEffect ? "await_reconciliation" : "record_failure",
        `recovery inspection failed closed: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Explicit, human-authorized action to abandon a task that is stuck at
   * the `task.worktree_creation_started` stage: the worktree/branch were
   * created exactly as intended, but no worker ever started
   * (`task.leased` was never recorded) and an operator has decided not to
   * resume it. This never runs automatically; it requires this distinct
   * method call, is never reachable from `inspect()` alone, and -- like
   * `recordCompletion` -- re-authorizes immediately before performing any
   * effect to avoid a TOCTOU gap between inspection and action.
   *
   * Scope is intentionally narrow: it only ever removes worktree/branch
   * state that exactly matches the durably recorded creation intent (same
   * branch, path, and base as `WorktreeManager.adopt()` requires) and is
   * clean/unmodified. Any competing, partial, dirty, or already-leased
   * state is refused with no effect, preserving it for manual operator
   * inspection.
   */
  async authorizeBoundedCleanup(taskId: string): Promise<TaskView> {
    await this.assertBoundedCleanupAuthorized(taskId);

    const events = this.journal.readStream(taskId);
    const chain = reconstructChain(taskId, events);
    const intent = chain.worktreeCreationStarted;
    if (intent === null) throw new Error("durable worktree creation intent is missing");
    const task = this.tasks.get(taskId);
    if (task === null) throw new Error(`task ${taskId} could not be projected`);
    const project = this.projects.get(task.projectId);

    // Re-authorize immediately before the effect: never trust the first
    // inspection alone (TOCTOU avoidance), the same pattern recordCompletion
    // uses before its cleanup effect.
    await this.assertBoundedCleanupAuthorized(taskId);
    const refreshedEvents = this.journal.readStream(taskId);
    if (refreshedEvents.at(-1)?.type !== "task.worktree_creation_started") {
      throw new Error("bounded cleanup state changed after reinspection");
    }

    await this.worktrees.removeUnleased(project, intent, { timeoutMs: GIT_READ_TIMEOUT_MS });

    return this.tasks.append(
      taskId,
      "task.cancelled",
      {
        stage: "setup",
        reason: "operator authorized bounded cleanup of an unleased, exactly-matched worktree",
      },
      null,
    );
  }

  private async assertBoundedCleanupAuthorized(taskId: string): Promise<void> {
    const authorization = await this.inspect(taskId);
    if (authorization.action !== "resume_preparation") {
      throw new Error(
        `bounded cleanup is not authorized: ${authorization.action}`,
      );
    }
    const events = this.journal.readStream(taskId);
    const last = events.at(-1);
    if (last === undefined || last.type !== "task.worktree_creation_started") {
      throw new Error(
        "bounded cleanup is only authorized for a task stuck at task.worktree_creation_started",
      );
    }
  }

  async recordCompletion(taskId: string): Promise<TaskView> {
    const authorization = await this.inspect(taskId);
    if (authorization.action !== "record_completion") {
      throw new Error(
        `recovery completion is not authorized: ${authorization.action}`,
      );
    }

    const events = this.journal.readStream(taskId);
    const chain = reconstructChain(taskId, events);
    const last = events.at(-1);
    if (last === undefined) throw new Error(`task ${taskId} not found`);
    const observedReceipt = chain.integrationObserved?.receipt ?? null;
    const preparedReceipt = chain.integrationPrepared?.receipt ?? null;
    const receipt = observedReceipt ?? preparedReceipt;
    if (receipt === null) throw new Error("durable completed integration receipt is missing");

    if (last.type === "task.cleanup_completed") {
      return this.tasks.append(taskId, "task.completed", { receipt }, null);
    }
    if (last.type === "task.cleanup_started") {
      const reauthorization = await this.inspect(taskId);
      if (reauthorization.action !== "record_completion") {
        throw new Error(
          `cleanup completion is not authorized after reinspection: ${reauthorization.action}`,
        );
      }
      const refreshedEvents = this.journal.readStream(taskId);
      const refreshedChain = reconstructChain(taskId, refreshedEvents);
      if (refreshedEvents.at(-1)?.type !== "task.cleanup_started") {
        throw new Error("cleanup completion state changed after reinspection");
      }
      this.tasks.append(
        taskId,
        "task.cleanup_completed",
        refreshedChain.cleanupStarted,
        null,
      );
      return this.tasks.append(taskId, "task.completed", { receipt }, null);
    }
    if (last.type === "task.cleanup_observed") {
      this.tasks.append(taskId, "task.cleanup_reconciled", {
        cleanup: chain.cleanupStarted,
        observation: chain.cleanupObserved,
      }, null);
      return this.tasks.append(taskId, "task.completed", { receipt }, null);
    }
    if (last.type === "task.cleanup_reconciled") {
      return this.tasks.append(taskId, "task.completed", { receipt }, null);
    }

    if (last.type === "task.integration_prepared") {
      this.tasks.append(
        taskId,
        "task.integration_observed",
        { receipt, verification: "verified", cleanupFailures: [] },
        null,
      );
    } else if (last.type !== "task.integration_observed") {
      throw new Error(`unsupported record_completion state ${last.type}`);
    }

    const lease = chain.lease;
    if (lease === null) throw new Error("durable workspace lease is missing");
    const cleanupPayload = {
      sourceCommit: receipt.sourceCommit,
      resultCommit: receipt.resultCommit,
      workspace: lease.workspace,
      branch: `ticket/${taskId}`,
    };
    this.tasks.append(taskId, "task.cleanup_started", cleanupPayload, null);
    try {
      await this.worktrees.cleanupCompleted(
        this.projects.get(chain.created.projectId),
        { taskId, branch: cleanupPayload.branch, path: lease.workspace },
        receipt.sourceCommit,
        { timeoutMs: GIT_READ_TIMEOUT_MS },
      );
    } catch (error) {
      const cleanupError = error as {
        readonly phase?: unknown;
        readonly uncertain?: unknown;
        readonly evidence?: unknown;
      };
      return this.tasks.append(taskId, "task.cleanup_observed", {
        phase: typeof cleanupError.phase === "string" ? cleanupError.phase : "unknown",
        uncertain: cleanupError.uncertain === true,
        evidence: isRecord(cleanupError.evidence) ? cleanupError.evidence : {},
        reason: errorMessage(error),
      }, null);
    }
    this.tasks.append(taskId, "task.cleanup_completed", cleanupPayload, null);
    return this.tasks.append(taskId, "task.completed", { receipt }, null);
  }

  private async inspectWorkspace(
    project: ProjectConfig,
    taskId: string,
    chain: RecoveryChain,
  ): Promise<WorkspaceInspection> {
    const rawExpectedPath = path.resolve(project.worktreeRoot, taskId);
    if (chain.lease !== null) {
      const durableWorkspace = chain.lease.workspace;
      if (
        !path.isAbsolute(durableWorkspace) ||
        path.normalize(durableWorkspace) !== durableWorkspace ||
        durableWorkspace !== rawExpectedPath
      ) {
        throw new Error("durable workspace path does not equal the normalized configured ticket path");
      }
    }
    const canonicalWorktreeRoot = await realpath(project.worktreeRoot);
    const expectedPath = path.join(canonicalWorktreeRoot, taskId);
    if (path.dirname(expectedPath) !== canonicalWorktreeRoot) {
      throw new Error("configured ticket path is not a strict child of the canonical worktree root");
    }
    let canonicalExpectedPath: string | null = null;
    let pathExists = false;
    try {
      const stat = await lstat(expectedPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("configured ticket path is not a real directory");
      }
      pathExists = true;
      canonicalExpectedPath = await realpath(expectedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A not-yet-created worktree has no canonical filesystem identity.
    }
    const expectedBranch = `refs/heads/ticket/${taskId}`;
    const listed = await this.read(project.repositoryPath, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const entries = parseWorktrees(listed.stdout);
    const matchingPath = entries.filter((entry) =>
      entry.path === expectedPath ||
      (canonicalExpectedPath !== null && entry.path === canonicalExpectedPath)
    );
    const matchingBranch = entries.filter((entry) => entry.branch === expectedBranch);
    if (matchingPath.length > 1 || matchingBranch.length > 1) {
      throw new Error("worktree registration is duplicated");
    }
    const registered = matchingPath.length === 1 && matchingBranch.length === 1 && matchingPath[0] === matchingBranch[0];
    if ((matchingPath.length === 1 || matchingBranch.length === 1) && !registered) {
      throw new Error("worktree path and ticket branch registration contradict each other");
    }

    const branch = await this.readRef(project.repositoryPath, expectedBranch);
    if (!registered) {
      return {
        path: expectedPath,
        registered: false,
        branchExists: branch !== null,
        pathExists,
        head: branch,
        dirty: null,
        diff: null,
      };
    }

    await this.assertSafeGitConfiguration(expectedPath);
    const status = await this.read(expectedPath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const staged = await this.read(expectedPath, [
      "-c",
      "core.quotepath=off",
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
    ]);
    if (staged.stdout !== "") throw new Error("worktree contains staged changes");
    const diff = await this.read(expectedPath, [
      "-c",
      "core.quotepath=off",
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
    ]);
    const head = await this.readCommit(expectedPath, "HEAD");
    if (branch === null || branch !== head) {
      throw new Error("ticket branch and registered worktree HEAD differ");
    }
    return {
      path: expectedPath,
      registered: true,
      branchExists: true,
      pathExists: true,
      head,
      dirty: status.stdout !== "",
      diff: diff.stdout,
    };
  }

  private async inspectIntegrationStart(
    project: ProjectConfig,
    chain: RecoveryChain,
    workspace: WorkspaceInspection,
  ): Promise<void> {
    const started = chain.integrationStarted!;
    if (workspace.head !== started.sourceCommit) {
      throw new Error("integration source does not equal the exact ticket branch commit");
    }
    if (workspace.dirty) {
      throw new Error("integration source worktree is not clean");
    }
    const sourceIssue = await this.verifyCommittedSource(chain, workspace, project.repositoryPath);
    if (sourceIssue !== null) throw new Error(sourceIssue);
    await this.readExactIntegrationRef(project);
  }

  private async verifyCompletedIntegration(
    project: ProjectConfig,
    taskId: string,
    chain: RecoveryChain,
    workspace: WorkspaceInspection,
    receipt: z.infer<typeof IntegrationReceiptSchema>,
  ): Promise<string | null> {
    await assertNoGitObjectSubstitution(this.git, project.repositoryPath, GIT_READ_TIMEOUT_MS);
    if (
      receipt.taskId !== taskId ||
      receipt.projectId !== project.projectId ||
      receipt.outcome !== "completed"
    ) {
      return "completed receipt identity or outcome does not match the task and project";
    }
    if (workspace.head !== receipt.sourceCommit || workspace.dirty || workspace.diff !== "") {
      return "ticket branch, source commit, cleanliness, or diff changed after integration";
    }

    const started = chain.integrationStarted;
    const approved = chain.reviewApproved;
    const requested = chain.reviewRequested;
    if (started === null || approved === null || requested === null) {
      return "required durable source, review, or validation evidence is missing";
    }
    if (
      started.sourceCommit !== receipt.sourceCommit ||
      canonicalJson(started.review) !== canonicalJson(receipt.review) ||
      canonicalJson(approved.review) !== canonicalJson(receipt.review)
    ) {
      return "receipt source or review contradicts earlier durable events";
    }
    if (
      !receipt.review.approved ||
      !validFocusedValidation(
        project,
        requested.validation,
        workspace,
        chain.validationStarted!.diffSha256,
      )
    ) {
      return "focused validation or approved review evidence is invalid";
    }
    let focusedDigest: string;
    try {
      focusedDigest = canonicalValidationDigest(requested.validation);
    } catch {
      return "focused validation digests are inconsistent";
    }
    if (receipt.review.validationSha256 !== focusedDigest) {
      return "review validation digest does not match durable focused validation";
    }
    if (!(await validFullValidation(project, receipt.validation, receipt.resultCommit))) {
      return "full validation command, outcome, or digests are invalid";
    }

    const sourceIssue = await this.verifyCommittedSource(chain, workspace, project.repositoryPath);
    if (sourceIssue !== null) return sourceIssue;

    const integrationHead = await this.readExactIntegrationRef(project);
    if (integrationHead !== receipt.resultCommit) {
      return "exact integration ref no longer equals the receipt result commit";
    }
    const resultParents = await this.read(project.repositoryPath, [
      "rev-list",
      "--parents",
      "--max-count=1",
      receipt.resultCommit,
    ]);
    const resultShape = resultParents.stdout.trim().split(/\s+/);
    if (
      resultShape.length !== 3 ||
      resultShape[0] !== receipt.resultCommit ||
      resultShape[1] !== receipt.originalIntegrationCommit ||
      resultShape[2] !== receipt.sourceCommit
    ) {
      return "integration result is not the exact Task 7 no-ff merge shape";
    }
    return null;
  }

  private async completionEvidenceIssue(
    project: ProjectConfig,
    taskId: string,
    chain: RecoveryChain,
    workspace: WorkspaceInspection,
    receipt: z.infer<typeof IntegrationReceiptSchema>,
  ): Promise<string | null> {
    const integrationIssue = await this.verifyCompletedIntegration(
      project,
      taskId,
      chain,
      workspace,
      receipt,
    );
    if (integrationIssue !== null) return integrationIssue;
    return this.candidateCleanupIssue(project, receipt);
  }

  private async candidateCleanupIssue(
    project: ProjectConfig,
    receipt: z.infer<typeof IntegrationReceiptSchema>,
  ): Promise<string | null> {
    const candidatePath = receipt.validation.provenance.canonicalCwd;
    let pathPresent = false;
    try {
      await lstat(candidatePath);
      pathPresent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return `candidate cleanup state could not be inspected at ${candidatePath}`;
      }
    }
    const listed = await this.read(project.repositoryPath, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const registered = parseWorktrees(listed.stdout).some(
      (entry) => entry.path === candidatePath,
    );
    if (pathPresent || registered) {
      return `candidate remains ${pathPresent ? "present" : "absent"} and ${registered ? "registered" : "unregistered"} at ${candidatePath}`;
    }
    return null;
  }

  private async verifyCommittedSource(
    chain: RecoveryChain,
    workspace: WorkspaceInspection,
    repositoryPath: string,
  ): Promise<string | null> {
    const integration = chain.integrationStarted;
    const validation = chain.validationStarted;
    const approved = chain.reviewApproved;
    if (integration === null || validation === null || approved === null) {
      return "committed source is missing patch, review, or integration evidence";
    }
    if (
      integration.review.diffSha256 !== validation.diffSha256 ||
      approved.review.diffSha256 !== validation.diffSha256
    ) {
      return "validation-start diff does not equal the approved review diff";
    }
    if (workspace.head !== integration.sourceCommit) {
      return "ticket branch no longer equals the durable source commit";
    }
    const parents = await this.read(repositoryPath, [
      "rev-list",
      "--parents",
      "--max-count=1",
      integration.sourceCommit,
    ]);
    const sourceShape = parents.stdout.trim().split(/\s+/);
    if (
      sourceShape.length !== 2 ||
      sourceShape[0] !== integration.sourceCommit ||
      !COMMIT_ID.test(sourceShape[1] ?? "")
    ) {
      return "source commit does not have exactly one parent";
    }
    const committedDiff = await this.read(repositoryPath, [
      "-c",
      "core.quotepath=off",
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      sourceShape[1]!,
      integration.sourceCommit,
    ]);
    if (sha256(committedDiff.stdout) !== approved.review.diffSha256) {
      return "review digest does not match the committed source diff";
    }
    const changed = await this.read(repositoryPath, [
      "-c",
      "core.quotepath=off",
      "diff",
      "--name-only",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      sourceShape[1]!,
      integration.sourceCommit,
    ]);
    const changedPaths = changed.stdout.split("\0").filter(Boolean);
    if (changedPaths.length !== 1 || changedPaths[0] !== validation.patch.path) {
      return "committed source changed paths do not exactly equal the patch path";
    }
    const blob = await this.read(repositoryPath, [
      "cat-file",
      "blob",
      `${integration.sourceCommit}:${validation.patch.path}`,
    ]);
    if (sha256(blob.stdout) !== validation.patch.sha256) {
      return "committed source blob digest does not equal artifact evidence";
    }
    return null;
  }

  private async readExactIntegrationRef(project: ProjectConfig): Promise<string> {
    const integrationRef = `refs/heads/${project.integrationBranch}`;
    const result = await this.read(project.repositoryPath, [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(symref)",
      "--count=2",
      "--",
      integrationRef,
    ]);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1) throw new Error("integration ref lookup did not return exactly one ref");
    const fields = lines[0]!.split("\t");
    if (
      fields.length !== 3 ||
      fields[0] !== integrationRef ||
      !COMMIT_ID.test(fields[1] ?? "") ||
      fields[2] !== ""
    ) {
      throw new Error("integration ref is malformed, inexact, or symbolic");
    }
    return fields[1]!;
  }

  private async readRef(cwd: string, ref: string): Promise<string | null> {
    const result = await this.read(cwd, [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(symref)",
      "--count=2",
      "--",
      ref,
    ]);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return null;
    if (lines.length !== 1) throw new Error(`ref ${ref} lookup was not exact`);
    const fields = lines[0]!.split("\t");
    if (
      fields.length !== 3 ||
      fields[0] !== ref ||
      !COMMIT_ID.test(fields[1] ?? "") ||
      fields[2] !== ""
    ) {
      throw new Error(`ref ${ref} returned malformed identity evidence`);
    }
    return fields[1]!;
  }

  private async readCommit(cwd: string, revision: string): Promise<string> {
    const result = await this.read(cwd, ["rev-parse", "--verify", `${revision}^{commit}`]);
    const value = result.stdout.trim();
    if (!COMMIT_ID.test(value) || result.stdout.split(/\r?\n/).filter(Boolean).length !== 1) {
      throw new Error(`revision ${revision} returned malformed identity evidence`);
    }
    return value;
  }

  private async assertSafeGitConfiguration(cwd: string): Promise<void> {
    const result = await this.readAllowingExitOne(cwd, [
      "config",
      "--get-regexp",
      EXTERNAL_PROGRAM_CONFIG,
    ]);
    if (result.exitCode === 0 && result.stdout.trim() !== "") {
      throw new Error("configured external Git programs are not allowed during recovery");
    }
  }

  private read(cwd: string, args: readonly string[]): Promise<CommandResult> {
    return this.readResult(cwd, args, false);
  }

  private readAllowingExitOne(cwd: string, args: readonly string[]): Promise<CommandResult> {
    return this.readResult(cwd, args, true);
  }

  private async readResult(
    cwd: string,
    args: readonly string[],
    allowExitOne: boolean,
  ): Promise<CommandResult> {
    const result = await this.git.run(cwd, [...SAFE_READ_CONFIG, ...args], {
      timeoutMs: GIT_READ_TIMEOUT_MS,
    });
    if (
      result.termination !== null ||
      result.truncated ||
      (result.exitCode !== 0 && !(allowExitOne && result.exitCode === 1))
    ) {
      throw new Error(
        `bounded Git read failed for ${args[0] ?? "unknown"}: exit=${result.exitCode}, termination=${result.termination}, truncated=${result.truncated}`,
      );
    }
    return result;
  }
}

function validValidation(
  project: ProjectConfig,
  report: z.infer<typeof ValidationReportSchema>,
  name: "focused" | "full",
): boolean {
  if (
    report.name !== name ||
    report.outcome !== "completed" ||
    report.exitCode !== 0 ||
    canonicalJson(report.command) !== canonicalJson(project.validations[name])
  ) {
    return false;
  }
  try {
    canonicalValidationDigest(report);
    return true;
  } catch {
    return false;
  }
}

function validFocusedValidation(
  project: ProjectConfig,
  report: z.infer<typeof ValidationReportSchema>,
  workspace: WorkspaceInspection,
  diffSha256: string,
): boolean {
  return (
    validValidation(project, report, "focused") &&
    report.provenance.canonicalCwd === workspace.path &&
    report.provenance.subjectSha256 === diffSha256
  );
}

async function validFullValidation(
  project: ProjectConfig,
  report: z.infer<typeof ValidationReportSchema>,
  resultCommit: string,
): Promise<boolean> {
  if (!validValidation(project, report, "full")) return false;
  if (report.provenance.subjectSha256 !== resultCommit) return false;
  const root = await realpath(project.worktreeRoot);
  const candidate = report.provenance.canonicalCwd;
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) return false;
  const candidateRoot = path.dirname(candidate);
  return (
    path.dirname(candidateRoot) === root &&
    /^\.zentra-integration-[A-Za-z0-9_-]{6}$/.test(path.basename(candidateRoot)) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      path.basename(candidate),
    )
  );
}

function reconstructChain(taskId: string, events: readonly StoredEvent[]): RecoveryChain {
  const correlationId = events[0]?.correlationId;
  if (typeof correlationId !== "string" || correlationId === "") {
    throw new Error("first event correlationId is missing");
  }
  for (const [index, event] of events.entries()) {
    if (event.streamId !== taskId) throw new Error(`event ${index + 1} has a cross-stream identity`);
    if (event.streamVersion !== index + 1) throw new Error("event stream versions are not contiguous from 1");
    if (event.correlationId !== correlationId) throw new Error("event correlationId changed within the stream");
  }
  for (const type of [
    "task.commit_observed",
    "task.integration_prepared",
    "task.integration_observed",
    "task.cleanup_started",
    "task.cleanup_completed",
    "task.cleanup_observed",
    "task.cleanup_reconciled",
    "task.completed",
  ]) {
    if (events.filter((event) => event.type === type).length > 1) {
      throw new Error(`duplicate ${type} events are not allowed`);
    }
  }
  const first = events[0]!;
  if (first.type !== "task.created") throw new Error("first event is not task.created");
  const created = parseEvent(CreatedPayloadSchema, first);
  const worktreeCreationStarted = parseLastOccurrence(
    WorktreeCreationStartedPayloadSchema,
    events,
    "task.worktree_creation_started",
  );
  if (
    worktreeCreationStarted !== null &&
    (worktreeCreationStarted.taskId !== taskId ||
      worktreeCreationStarted.branch !== `ticket/${taskId}`)
  ) {
    throw new Error("worktree creation intent identity does not match the task");
  }
  const lease = parseOptionalEvent(LeasePayloadSchema, events, "task.leased");
  const started = parseOptionalEvent(StartedPayloadSchema, events, "task.started");
  const validationStarted = parseOptionalEvent(
    ValidationStartedPayloadSchema,
    events,
    "task.validation_started",
  );
  const reviewRequested = parseOptionalEvent(
    ReviewRequestedPayloadSchema,
    events,
    "task.review_requested",
  );
  const reviewApproved = parseOptionalEvent(
    ReviewApprovedPayloadSchema,
    events,
    "task.review_approved",
  );
  const integrationStarted = parseOptionalEvent(
    IntegrationStartedPayloadSchema,
    events,
    "task.integration_started",
  );
  const integrationPrepared = parseOptionalEvent(
    IntegrationPreparedPayloadSchema,
    events,
    "task.integration_prepared",
  );

  const commitObserved = events.find((event) => event.type === "task.commit_observed");
  if (commitObserved !== undefined) parseEvent(CommitObservedPayloadSchema, commitObserved);
  const integrationObserved = events.find((event) => event.type === "task.integration_observed");
  const successfulIntegrationObserved = integrationObserved === undefined
    ? null
    : IntegrationObservedPayloadSchema.safeParse(integrationObserved.payload);
  if (integrationObserved !== undefined) {
    const parsed = z.union([
      IntegrationObservedPayloadSchema,
      IntegrationUncertainPayloadSchema,
      IntegrationErrorPayloadSchema,
      IntegrationVerificationFailedPayloadSchema,
    ]).safeParse(integrationObserved.payload);
    if (!parsed.success) throw new Error("task.integration_observed payload is invalid");
  }
  const cleanupStarted = parseOptionalEvent(
    CleanupStartedPayloadSchema,
    events,
    "task.cleanup_started",
  );
  const cleanupCompleted = parseOptionalEvent(
    CleanupCompletedPayloadSchema,
    events,
    "task.cleanup_completed",
  );
  const cleanupObserved = parseOptionalEvent(
    CleanupObservedPayloadSchema,
    events,
    "task.cleanup_observed",
  );
  const cleanupReconciled = parseOptionalEvent(
    CleanupReconciledPayloadSchema,
    events,
    "task.cleanup_reconciled",
  );
  const completed = events.find((event) => event.type === "task.completed");
  const completedPayload = completed === undefined
    ? null
    : parseEvent(CompletedPayloadSchema, completed);

  if (started !== null && (lease === null || started.workerId !== lease.leaseOwner)) {
    throw new Error("started worker identity does not equal the lease owner");
  }
  if (reviewRequested !== null) {
    if (started === null) throw new Error("review request has no started worker identity");
    if (reviewRequested.reviewerId === started.workerId) {
      throw new Error("reviewer identity must differ from worker identity");
    }
  }
  if (
    reviewApproved !== null &&
    (reviewRequested === null || reviewApproved.review.reviewerId !== reviewRequested.reviewerId)
  ) {
    throw new Error("approved reviewer identity does not equal the requested reviewer");
  }
  if (
    integrationStarted !== null &&
    (reviewApproved === null ||
      integrationStarted.review.reviewerId !== reviewApproved.review.reviewerId ||
      canonicalJson(integrationStarted.review) !== canonicalJson(reviewApproved.review))
  ) {
    throw new Error("integration review identity or evidence contradicts approval");
  }
  if (
    validationStarted !== null &&
    reviewApproved !== null &&
    validationStarted.diffSha256 !== reviewApproved.review.diffSha256
  ) {
    throw new Error("validation-start diff does not equal approved review diff");
  }
  const successfulObservation = integrationObserved === undefined
    ? null
    : IntegrationObservedPayloadSchema.safeParse(integrationObserved.payload);
  if (successfulObservation?.success) {
    if (
      integrationStarted === null ||
      successfulObservation.data.receipt.review.reviewerId !== integrationStarted.review.reviewerId ||
      canonicalJson(successfulObservation.data.receipt.review) !== canonicalJson(integrationStarted.review)
    ) {
      throw new Error("receipt reviewer identity or evidence contradicts integration start");
    }
  }
  if (integrationPrepared !== null) {
    if (
      integrationStarted === null ||
      integrationPrepared.receipt.taskId !== taskId ||
      integrationPrepared.receipt.projectId !== created.projectId ||
      integrationPrepared.receipt.sourceCommit !== integrationStarted.sourceCommit ||
      canonicalJson(integrationPrepared.receipt.review) !== canonicalJson(integrationStarted.review)
    ) {
      throw new Error("prepared receipt identities contradict the durable integration start");
    }
  }
  if (
    successfulObservation?.success &&
    integrationPrepared !== null &&
    canonicalJson(successfulObservation.data.receipt) !== canonicalJson(integrationPrepared.receipt)
  ) {
    throw new Error("verified integration observation contradicts the prepared receipt");
  }
  const indexOf = (type: string): number => events.findIndex((event) => event.type === type);
  if (
    integrationPrepared !== null &&
    indexOf("task.integration_prepared") < indexOf("task.integration_started")
  ) {
    throw new Error("integration preparation precedes integration start");
  }
  if (cleanupStarted !== null) {
    if (
      !successfulIntegrationObserved?.success ||
      indexOf("task.cleanup_started") < indexOf("task.integration_observed") ||
      cleanupStarted.sourceCommit !== successfulIntegrationObserved.data.receipt.sourceCommit ||
      cleanupStarted.resultCommit !== successfulIntegrationObserved.data.receipt.resultCommit ||
      cleanupStarted.branch !== `ticket/${taskId}`
    ) {
      throw new Error("cleanup start contradicts verified integration evidence");
    }
  }
  if (cleanupCompleted !== null || cleanupObserved !== null) {
    const cleanupEnd = cleanupCompleted ?? cleanupObserved;
    if (
      cleanupStarted === null ||
      indexOf(cleanupCompleted !== null ? "task.cleanup_completed" : "task.cleanup_observed") <
        indexOf("task.cleanup_started")
    ) {
      throw new Error("cleanup result has no prior cleanup start");
    }
    if (
      cleanupCompleted !== null &&
      canonicalJson(cleanupCompleted) !== canonicalJson(cleanupStarted)
    ) {
      throw new Error("cleanup completion contradicts cleanup start");
    }
    void cleanupEnd;
  }
  if (cleanupCompleted !== null && cleanupObserved !== null) {
    throw new Error("cleanup cannot be both completed and observed as uncertain");
  }
  if (cleanupReconciled !== null) {
    if (
      cleanupStarted === null ||
      cleanupObserved === null ||
      cleanupCompleted !== null ||
      indexOf("task.cleanup_reconciled") < indexOf("task.cleanup_observed") ||
      canonicalJson(cleanupReconciled.cleanup) !== canonicalJson(cleanupStarted) ||
      canonicalJson(cleanupReconciled.observation) !== canonicalJson(cleanupObserved)
    ) {
      throw new Error("cleanup reconciliation contradicts cleanup start or observation");
    }
  }
  if (
    completedPayload !== null &&
    cleanupCompleted === null &&
    cleanupReconciled === null
  ) {
    throw new Error("completed task has no cleanup completion or reconciliation");
  }
  if (
    completedPayload !== null &&
    (!successfulObservation?.success ||
      canonicalJson(completedPayload.receipt) !==
        canonicalJson(successfulObservation.data.receipt))
  ) {
    throw new Error("completed receipt does not exactly equal the verified integration observation");
  }
  const uncertainObservation = integrationObserved === undefined
    ? null
    : IntegrationUncertainPayloadSchema.safeParse(integrationObserved.payload);
  if (uncertainObservation?.success) {
    if (
      integrationStarted === null ||
      uncertainObservation.data.evidence.taskId !== taskId ||
      uncertainObservation.data.evidence.projectId !== created.projectId ||
      uncertainObservation.data.evidence.sourceCommit !== integrationStarted.sourceCommit
    ) {
      throw new Error("uncertain integration evidence identities contradict the durable chain");
    }
  }
  const failedVerification = integrationObserved === undefined
    ? null
    : IntegrationVerificationFailedPayloadSchema.safeParse(integrationObserved.payload);
  if (failedVerification?.success) {
    if (
      integrationStarted === null ||
      failedVerification.data.receipt.taskId !== taskId ||
      failedVerification.data.receipt.projectId !== created.projectId ||
      failedVerification.data.receipt.sourceCommit !== integrationStarted.sourceCommit ||
      canonicalJson(failedVerification.data.receipt.review) !==
        canonicalJson(integrationStarted.review)
    ) {
      throw new Error("failed receipt verification identities contradict the durable chain");
    }
  }
  return {
    created,
    worktreeCreationStarted,
    lease,
    started,
    validationStarted,
    reviewRequested,
    reviewApproved,
    integrationStarted,
    integrationPrepared,
    integrationObserved: successfulObservation?.success ? successfulObservation.data : null,
    cleanupStarted,
    cleanupCompleted,
    cleanupObserved,
    cleanupReconciled,
  };
}

function parseOptionalEvent<T extends z.ZodType>(
  schema: T,
  events: readonly StoredEvent[],
  type: string,
): z.infer<T> | null {
  const matching = events.filter((event) => event.type === type);
  if (matching.length > 1) throw new Error(`${type} appears more than once`);
  return matching.length === 0 ? null : parseEvent(schema, matching[0]!);
}

// Some preparation events (e.g. task.worktree_creation_started) may
// legitimately repeat across a resumed preparation attempt; only the most
// recent occurrence reflects the current intended state.
function parseLastOccurrence<T extends z.ZodType>(
  schema: T,
  events: readonly StoredEvent[],
  type: string,
): z.infer<T> | null {
  const matching = events.filter((event) => event.type === type);
  return matching.length === 0 ? null : parseEvent(schema, matching.at(-1)!);
}

function parseEvent<T extends z.ZodType>(schema: T, event: StoredEvent): z.infer<T> {
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) throw new Error(`${event.type} payload is invalid`);
  return parsed.data;
}

function isSafeTaskId(taskId: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId) &&
    !taskId.includes("..") &&
    !taskId.includes("@{") &&
    !taskId.endsWith(".") &&
    !taskId.toLowerCase().endsWith(".lock")
  );
}

function parseWorktrees(output: string): Array<{ path: string; branch: string | null }> {
  const records = output.split("\0\0").filter(Boolean);
  return records.map((record) => {
    const fields = record.split("\0");
    const worktree = fields.find((field) => field.startsWith("worktree "));
    const branch = fields.find((field) => field.startsWith("branch "));
    if (worktree === undefined) throw new Error("worktree list returned malformed metadata");
    return {
      path: worktree.slice("worktree ".length),
      branch: branch?.slice("branch ".length) ?? null,
    };
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function decision(
  taskId: string,
  action: RecoveryDecision["action"],
  reason: string,
): RecoveryDecision {
  const diagnosticReason = action === "record_failure" && !reason.startsWith("diagnostic only:")
    ? `diagnostic only: ${reason}; no event append is implied`
    : reason;
  return { taskId, action, reason: diagnosticReason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
