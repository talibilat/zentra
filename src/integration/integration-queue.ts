import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import type {
  ValidationReport,
  ValidationRunner,
} from "../capabilities/validation-runner.js";
import {
  isVerifiedValidationReport,
  ValidationReportSchema,
} from "../capabilities/validation-runner.js";
import type { ProjectConfig } from "../projects/project-config.js";
import type { ReviewDecision } from "../reviews/reviewer-adapter.js";
import {
  canonicalValidationDigest,
  ReviewDecisionSchema,
} from "../reviews/reviewer-adapter.js";
import { isVerifiedReviewDecision } from "../reviews/review-gate.js";
import {
  assertNoGitObjectSubstitution,
  type CommandResult,
  type GitClient,
} from "../workspaces/git-client.js";
import type { WorkspaceLease } from "../workspaces/worktree-manager.js";
import {
  IntegrationLeaseStore,
  type IntegrationLease,
  type IntegrationLeaseKey,
} from "./integration-lease.js";

const GIT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_INTEGRATION_LEASE_MS = 10_000;
const DEFAULT_INTEGRATION_LEASE_RENEWAL_MS = 3_000;
const DEFAULT_INTEGRATION_LEASE_RETRY_MS = 50;
const INTEGRATION_LEASE_DATABASE = ".zentra-integration-leases.sqlite";
const verifiedIntegrationReceipts = new WeakSet<IntegrationReceipt>();

export interface IntegrationReceipt {
  readonly taskId: string;
  readonly projectId: string;
  readonly sourceCommit: string;
  readonly originalIntegrationCommit: string | null;
  readonly resultCommit: string | null;
  readonly review: ReviewDecision;
  readonly validation: ValidationReport;
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
}

export function isVerifiedIntegrationReceipt(
  receipt: IntegrationReceipt,
): boolean {
  return verifiedIntegrationReceipts.has(receipt);
}

export class IntegrationExecutionError extends Error {
  override readonly name = "IntegrationExecutionError";

  constructor(
    readonly outcome: "cancelled" | "timed_out" | "failed",
    operation: string,
  ) {
    super(`integration ${operation} was ${outcome}`);
  }
}

export class IntegrationUncertainError extends Error {
  override readonly name = "IntegrationUncertainError";

  constructor(
    reason: string,
    readonly evidence: Readonly<Record<string, unknown>>,
  ) {
    super(reason);
  }
}

export class IntegrationLeaseLostError extends Error {
  override readonly name = "IntegrationLeaseLostError";

  constructor() {
    super("integration lease ownership was lost");
  }
}

class IntegrationPreparationError extends Error {
  override readonly name = "IntegrationPreparationError";
}

export interface CleanupFailure {
  readonly projectId: string;
  readonly taskId: string;
  readonly candidatePath: string;
  readonly reason: string;
  readonly timestamp: string;
}

export interface LeaseAnomaly {
  readonly commonDirectory: string;
  readonly integrationRef: string;
  readonly reason: string;
  readonly timestamp: string;
}

export interface IntegrationQueueOptions {
  /** Test-only seam: overrides the lease acquisition/renewal duration in milliseconds. */
  readonly integrationLeaseMs?: number;
  /** Test-only seam: overrides the lease renewal interval in milliseconds. */
  readonly integrationLeaseRenewalMs?: number;
  /** Test-only seam: overrides the lease acquisition retry interval in milliseconds. */
  readonly integrationLeaseRetryMs?: number;
}

export class IntegrationQueue {
  private readonly cleanupFailures: CleanupFailure[] = [];
  private readonly leaseAnomalies: LeaseAnomaly[] = [];
  private readonly integrationLeaseMs: number;
  private readonly integrationLeaseRenewalMs: number;
  private readonly integrationLeaseRetryMs: number;

  constructor(
    private readonly git: GitClient,
    private readonly validations: ValidationRunner,
    options: IntegrationQueueOptions = {},
  ) {
    this.integrationLeaseMs = options.integrationLeaseMs ?? DEFAULT_INTEGRATION_LEASE_MS;
    this.integrationLeaseRenewalMs =
      options.integrationLeaseRenewalMs ?? DEFAULT_INTEGRATION_LEASE_RENEWAL_MS;
    this.integrationLeaseRetryMs =
      options.integrationLeaseRetryMs ?? DEFAULT_INTEGRATION_LEASE_RETRY_MS;
  }

  getCleanupFailures(): readonly CleanupFailure[] {
    return [...this.cleanupFailures];
  }

  getLeaseAnomalies(): readonly LeaseAnomaly[] {
    return [...this.leaseAnomalies];
  }

  async integrate(input: {
    project: ProjectConfig;
    lease: WorkspaceLease;
    review: ReviewDecision;
    signal: AbortSignal;
    onPrepared?: (receipt: IntegrationReceipt) => void | Promise<void>;
  }): Promise<IntegrationReceipt> {
    const integrationRef = `refs/heads/${input.project.integrationBranch}`;
    const commonDirectory = await canonicalGitCommonDirectory(
      this.git,
      input.project.repositoryPath,
    );
    const key = { commonDirectory, integrationRef };
    return withIntegrationLease(
      key,
      input.signal,
      (assertLease, leaseSignal) =>
        this.integrateUnderLock(
          { ...input, signal: AbortSignal.any([input.signal, leaseSignal]) },
          assertLease,
        ),
      (reason) => {
        this.leaseAnomalies.push({
          commonDirectory: key.commonDirectory,
          integrationRef: key.integrationRef,
          reason,
          timestamp: new Date().toISOString(),
        });
      },
      {
        leaseMs: this.integrationLeaseMs,
        renewalMs: this.integrationLeaseRenewalMs,
        retryMs: this.integrationLeaseRetryMs,
      },
    );
  }

  private async integrateUnderLock(input: {
    project: ProjectConfig;
    lease: WorkspaceLease;
    review: ReviewDecision;
    signal: AbortSignal;
    onPrepared?: (receipt: IntegrationReceipt) => void | Promise<void>;
  }, assertLease: () => void): Promise<IntegrationReceipt> {
    const { project, lease, review, signal } = input;
    const integrationRef = `refs/heads/${project.integrationBranch}`;
    let candidatePath: string | null = null;
    let candidateOwned = false;
    let candidateRoot: string | null = null;
    let candidateRootCreated = false;
    let preserveCandidate = false;
    let originalIntegrationCommit: string | null = null;

    let source: CommandResult;
    try {
      assertLease();
      await assertNoGitObjectSubstitution(
        this.git,
        project.repositoryPath,
        GIT_OPERATION_TIMEOUT_MS,
      );
      source = await this.git.run(
        project.repositoryPath,
        ["rev-parse", "--verify", `refs/heads/${lease.branch}^{commit}`],
        { timeoutMs: GIT_OPERATION_TIMEOUT_MS },
      );
    } catch (error) {
      throw new IntegrationExecutionError("failed", `source identity read: ${errorMessage(error)}`);
    }
    if (source.termination !== null) {
      throw new IntegrationExecutionError(source.termination, "source identity read");
    }
    if (source.exitCode !== 0 || source.truncated) {
      throw new IntegrationExecutionError("failed", gitFailure("read source commit", source));
    }
    const sourceCommit = source.stdout.trim();
    if (sourceCommit === "") {
      throw new IntegrationExecutionError("failed", "source identity read returned empty identity");
    }

    const receipt = (
      outcome: IntegrationReceipt["outcome"],
      validation: ValidationReport,
      resultCommit: string | null = null,
    ): IntegrationReceipt => ({
      taskId: lease.taskId,
      projectId: project.projectId,
      sourceCommit,
      originalIntegrationCommit,
      resultCommit,
      review,
      validation,
      outcome,
    });
    const terminationReceipt = (
      operation: string,
      result: CommandResult,
    ): IntegrationReceipt | null => {
      if (result.termination === null) return null;
      return receipt(
        result.termination,
        unavailableValidation(
          project,
          result.termination,
          `${operation} was ${result.termination}`,
        ),
      );
    };

    try {
      if (!isVerifiedReviewDecision(review)) {
        return receipt(
          "failed",
          unavailableValidation(project, "failed", "integration requires a verified review decision"),
        );
      }
      if (signal.aborted) {
        return receipt(
          "cancelled",
          unavailableValidation(project, "cancelled", "integration was cancelled before validation"),
        );
      }

      const symbolicIntegrationRef = await this.git.run(
        project.repositoryPath,
        ["symbolic-ref", "--quiet", integrationRef],
        { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS },
      );
      const symbolicTermination = terminationReceipt(
        "integration ref inspection",
        symbolicIntegrationRef,
      );
      if (symbolicTermination !== null) return symbolicTermination;
      if (symbolicIntegrationRef.exitCode === 0) {
        return receipt(
          "failed",
          unavailableValidation(project, "failed", "integration ref must not be symbolic"),
        );
      }
      if (symbolicIntegrationRef.exitCode !== 1 || symbolicIntegrationRef.truncated) {
        return receipt(
          "failed",
          unavailableValidation(
            project,
            "failed",
            gitFailure("inspect integration ref", symbolicIntegrationRef),
          ),
        );
      }

      const original = await this.git.run(
        project.repositoryPath,
        ["rev-parse", "--verify", `${integrationRef}^{commit}`],
        { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS },
      );
      const originalTermination = terminationReceipt("integration head read", original);
      if (originalTermination !== null) return originalTermination;
      if (original.exitCode !== 0 || original.truncated) {
        return receipt(
          "failed",
          unavailableValidation(
            project,
            "failed",
            gitFailure("read integration commit", original),
          ),
        );
      }
      originalIntegrationCommit = original.stdout.trim();

      const mergeBase = await this.git.run(
        project.repositoryPath,
        ["merge-base", originalIntegrationCommit, sourceCommit],
        { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS },
      );
      const mergeBaseTermination = terminationReceipt("merge-base read", mergeBase);
      if (mergeBaseTermination !== null) return mergeBaseTermination;
      if (mergeBase.exitCode !== 0 || mergeBase.truncated) {
        return receipt(
          "failed",
          unavailableValidation(project, "failed", gitFailure("find merge base", mergeBase)),
        );
      }

      const committedDiff = await this.git.run(project.repositoryPath, [
        "-c",
        "core.quotepath=off",
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        mergeBase.stdout.trim(),
        sourceCommit,
      ], { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS });
      const diffTermination = terminationReceipt("committed diff read", committedDiff);
      if (diffTermination !== null) return diffTermination;
      if (committedDiff.exitCode !== 0 || committedDiff.truncated) {
        const reason = committedDiff.truncated
          ? "committed branch diff exceeded the Git output capture limit"
          : gitFailure("read committed branch diff", committedDiff);
        return receipt("failed", unavailableValidation(project, "failed", reason));
      }

      const diffSha256 = sha256(committedDiff.stdout);
      if (!review.approved || review.diffSha256 !== diffSha256) {
        const reason = !review.approved
          ? `review was not approved: ${review.reason}`
          : `review digest mismatch: reviewed ${review.diffSha256}, committed ${diffSha256}`;
        return receipt("failed", unavailableValidation(project, "failed", reason));
      }

      const externalPrograms = await this.git.run(project.repositoryPath, [
        "config",
        "--get-regexp",
        "^(merge\\..*\\.driver|diff\\.external|diff\\..*\\.(command|textconv)|filter\\..*\\.(clean|smudge|process))$",
      ], { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS });
      const configTermination = terminationReceipt(
        "external Git configuration inspection",
        externalPrograms,
      );
      if (configTermination !== null) return configTermination;
      if (externalPrograms.exitCode === 0 && externalPrograms.stdout.trim() !== "") {
        return receipt(
          "failed",
          unavailableValidation(
            project,
            "failed",
            "configured external Git programs are not allowed",
          ),
        );
      }
      if (externalPrograms.exitCode !== 1 || externalPrograms.truncated) {
        return receipt(
          "failed",
          unavailableValidation(
            project,
            "failed",
            gitFailure("inspect external Git configuration", externalPrograms),
          ),
        );
      }

      assertLease();
      const canonicalWorktreeRoot = await realpath(project.worktreeRoot);
      candidateRoot = await mkdtemp(
        path.join(canonicalWorktreeRoot, ".zentra-integration-"),
      );
      candidateRootCreated = true;
      await chmod(candidateRoot, 0o700);
      if (path.dirname(candidateRoot) !== canonicalWorktreeRoot) {
        return receipt(
          "failed",
          unavailableValidation(project, "failed", "private candidate root escaped worktree root"),
        );
      }
      candidatePath = path.resolve(candidateRoot, randomUUID());
      const relativeCandidate = path.relative(candidateRoot, candidatePath);
      if (
        relativeCandidate === "" ||
        relativeCandidate.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeCandidate) ||
        path.dirname(candidatePath) !== candidateRoot
      ) {
        return receipt(
          "failed",
          unavailableValidation(project, "failed", "candidate path escaped its owned root"),
        );
      }
      const candidateRootStat = await lstat(candidateRoot);
      if (
        !candidateRootStat.isDirectory() ||
        candidateRootStat.isSymbolicLink() ||
        (candidateRootStat.mode & 0o777) !== 0o700
      ) {
        return receipt(
          "failed",
          unavailableValidation(project, "failed", "candidate root must be a real directory"),
        );
      }
      if ((await realpath(candidateRoot)) !== candidateRoot) {
        return receipt(
          "failed",
          unavailableValidation(project, "failed", "candidate root must be canonical"),
        );
      }
      let candidate: CommandResult;
      try {
        candidate = await this.git.run(project.repositoryPath, [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "worktree",
          "add",
          "--detach",
          candidatePath,
          originalIntegrationCommit,
        ], { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS });
      } catch (error) {
        preserveCandidate = true;
        this.recordCleanupFailure(
          project,
          lease,
          candidatePath,
          `candidate creation result is uncertain: ${errorMessage(error)}`,
        );
        return receipt(
          "failed",
          unavailableValidation(
            project,
            "failed",
            `candidate creation result is uncertain: ${errorMessage(error)}`,
          ),
        );
      }
      if (candidate.termination !== null) {
        preserveCandidate = true;
        this.recordCleanupFailure(
          project,
          lease,
          candidatePath,
          `candidate creation was ${candidate.termination}`,
        );
        return terminationReceipt("candidate creation", candidate)!;
      }
      if (candidate.exitCode !== 0) {
        preserveCandidate = true;
        this.recordCleanupFailure(
          project,
          lease,
          candidatePath,
          gitFailure("create candidate", candidate),
        );
        return receipt(
          "failed",
          unavailableValidation(project, "failed", gitFailure("create candidate", candidate)),
        );
      }
      candidateOwned = true;
      if (candidate.truncated) {
        return receipt(
          "failed",
          unavailableValidation(project, "failed", "candidate creation output was truncated"),
        );
      }

      const merge = await this.git.run(candidatePath, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "merge.gpgSign=false",
        "-c",
        "core.fsmonitor=false",
        "merge",
        "--no-ff",
        "--no-edit",
        "--no-verify",
        sourceCommit,
      ], { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS });
      const mergeTermination = terminationReceipt("candidate merge", merge);
      if (mergeTermination !== null) return mergeTermination;
      if (merge.exitCode !== 0 || merge.truncated) {
        return receipt(
          "failed",
          unavailableValidation(project, "failed", gitFailure("merge conflict", merge)),
        );
      }

      const candidateHead = await this.git.run(candidatePath, ["rev-parse", "HEAD"], {
        signal,
        timeoutMs: GIT_OPERATION_TIMEOUT_MS,
      });
      const headTermination = terminationReceipt("candidate HEAD read", candidateHead);
      if (headTermination !== null) return headTermination;
      if (candidateHead.exitCode !== 0) {
        return receipt(
          "failed",
          unavailableValidation(
            project,
            "failed",
            gitFailure("read candidate result commit", candidateHead),
          ),
        );
      }
      const resultCommit = candidateHead.stdout.trim();

      let validation: ValidationReport;
      const validationInvocationId = randomUUID();
      const canonicalCandidatePath = await realpath(candidatePath);
      assertLease();
      try {
        validation = await this.validations.run(
          project,
          "full",
          candidatePath,
          signal,
          { invocationId: validationInvocationId, subjectSha256: resultCommit },
        );
      } catch (error) {
        return receipt(
          signal.aborted ? "cancelled" : "failed",
          unavailableValidation(
            project,
            signal.aborted ? "cancelled" : "failed",
            `full validation could not run: ${errorMessage(error)}`,
          ),
        );
      }

      if (validation.outcome !== "completed" || validation.exitCode !== 0) {
        return receipt(validation.outcome === "completed" ? "failed" : validation.outcome, validation);
      }
      const validatedHead = await this.git.run(candidatePath, ["rev-parse", "HEAD"], {
        signal,
        timeoutMs: GIT_OPERATION_TIMEOUT_MS,
      });
      const validatedHeadTermination = terminationReceipt(
        "post-validation HEAD read",
        validatedHead,
      );
      if (validatedHeadTermination !== null) {
        return receipt(validatedHead.termination!, validation);
      }
      if (
        validatedHead.exitCode !== 0 ||
        validatedHead.truncated ||
        validatedHead.stdout.trim() !== resultCommit
      ) {
        return receipt("failed", validation);
      }
      const validatedStatus = await this.git.run(candidatePath, [
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ], { signal, timeoutMs: GIT_OPERATION_TIMEOUT_MS });
      const statusTermination = terminationReceipt(
        "post-validation status read",
        validatedStatus,
      );
      if (statusTermination !== null) {
        return receipt(validatedStatus.termination!, validation);
      }
      if (
        validatedStatus.exitCode !== 0 ||
        validatedStatus.truncated ||
        validatedStatus.stdout !== ""
      ) {
        return receipt("failed", validation);
      }
      if (signal.aborted) {
        return receipt("cancelled", validation);
      }

      if (!validCompletedFullValidation(project, validation, {
        invocationId: validationInvocationId,
        canonicalCwd: canonicalCandidatePath,
        subjectSha256: resultCommit,
      })) {
        return receipt(
          "failed",
          unavailableValidation(project, "failed", "full validation lacks verified provenance"),
        );
      }
      assertLease();
      const preparedReceipt = prepareCompletedReceipt({
        taskId: lease.taskId,
        projectId: project.projectId,
        sourceCommit,
        originalIntegrationCommit,
        resultCommit,
        review,
        validation,
      });
      if (input.onPrepared !== undefined) {
        try {
          await input.onPrepared(preparedReceipt);
        } catch (error) {
          throw new IntegrationPreparationError(errorMessage(error));
        }
      }

      let update: CommandResult;
      let uncertainUpdateReason: string | null = null;
      assertLease();
      try {
        await assertNoGitObjectSubstitution(
          this.git,
          project.repositoryPath,
          GIT_OPERATION_TIMEOUT_MS,
        );
      } catch (error) {
        throw new IntegrationPreparationError(errorMessage(error));
      }
      try {
        update = await this.git.run(
          project.repositoryPath,
          [
            "-c",
            "core.hooksPath=/dev/null",
            "update-ref",
            "--no-deref",
            integrationRef,
            resultCommit,
            originalIntegrationCommit,
          ],
          { timeoutMs: GIT_OPERATION_TIMEOUT_MS },
        );
        if (update.termination !== null) {
          uncertainUpdateReason = `update-ref was ${update.termination}`;
        }
      } catch (error) {
        update = {
          stdout: "",
          stderr: errorMessage(error),
          exitCode: -1,
          truncated: false,
          termination: null,
        };
        uncertainUpdateReason = `update-ref result is uncertain: ${errorMessage(error)}`;
      }
      if (uncertainUpdateReason !== null) {
        let reconciled: CommandResult;
        try {
          assertLease();
          reconciled = await this.git.run(
            project.repositoryPath,
            [
              "for-each-ref",
              "--format=%(refname)%09%(objectname)%09%(symref)",
              "--count=2",
              integrationRef,
            ],
            { timeoutMs: GIT_OPERATION_TIMEOUT_MS },
          );
        } catch (error) {
          reconciled = {
            stdout: "",
            stderr: errorMessage(error),
            exitCode: -1,
            truncated: false,
            termination: null,
          };
        }
        let reconciledHead: string | null = null;
        let reconciliationIssue: string | null = null;
        if (
          reconciled.exitCode === 0 &&
          reconciled.termination === null &&
          !reconciled.truncated
        ) {
          const lines = reconciled.stdout.split(/\r?\n/).filter((line) => line !== "");
          if (lines.length === 1) {
            const fields = lines[0]!.split("\t");
            const refName = fields[0] ?? "";
            const objectName = fields[1] ?? "";
            const symbolicTarget = fields[2] ?? "";
            if (
              fields.length === 3 &&
              refName === integrationRef &&
              /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectName)
            ) {
              if (symbolicTarget === "") reconciledHead = objectName;
              else reconciliationIssue = `integration ref became symbolic: ${symbolicTarget}`;
            } else {
              reconciliationIssue =
                "integration ref inspection returned malformed or non-exact metadata";
            }
          } else {
            reconciliationIssue = "integration ref inspection did not return exactly one ref";
          }
        } else {
          reconciliationIssue = gitFailure("read integration ref metadata", reconciled);
        }
        if (reconciledHead === resultCommit) {
          return registerCompletedReceipt(preparedReceipt);
        }
        const uncertainOutcome = update.termination ?? "failed";
        if (reconciledHead === originalIntegrationCommit) {
          return receipt(
            uncertainOutcome,
            validation,
          );
        }
        preserveCandidate = true;
        this.recordCleanupFailure(
          project,
          lease,
          candidatePath,
          `${uncertainUpdateReason}; update-ref reconciliation ${
            reconciledHead === null
              ? `failed: ${reconciliationIssue ?? "unknown ref metadata"}`
              : `found competing commit ${reconciledHead}`
          }`,
        );
        throw new IntegrationUncertainError(
          `${uncertainUpdateReason}; update-ref reconciliation unresolved`,
          Object.freeze({
            taskId: lease.taskId,
            projectId: project.projectId,
            sourceCommit,
            resultCommit,
            reconciledHead,
            reconciliationIssue,
            candidatePath,
          }),
        );
      }
      if (update.exitCode !== 0) {
        return receipt("failed", validation);
      }

      return registerCompletedReceipt(preparedReceipt);
    } catch (error) {
      if (
        error instanceof IntegrationExecutionError ||
        error instanceof IntegrationUncertainError ||
        error instanceof IntegrationPreparationError ||
        error instanceof IntegrationLeaseLostError
      ) {
        throw error;
      }
      return receipt(
        signal.aborted ? "cancelled" : "failed",
        unavailableValidation(
          project,
          signal.aborted ? "cancelled" : "failed",
          `integration could not continue: ${errorMessage(error)}`,
        ),
      );
    } finally {
      if (candidatePath !== null && candidateOwned && !preserveCandidate) {
        try {
          const cleanup = await this.git.run(project.repositoryPath, [
            "worktree",
            "remove",
            "--force",
            candidatePath,
          ], { timeoutMs: GIT_OPERATION_TIMEOUT_MS });
          if (cleanup.termination !== null) {
            this.recordCleanupFailure(
              project,
              lease,
              candidatePath,
              `candidate cleanup was ${cleanup.termination}`,
            );
          } else if (cleanup.exitCode !== 0 || cleanup.truncated) {
            this.recordCleanupFailure(
              project,
              lease,
              candidatePath,
              cleanup.truncated
                ? "candidate cleanup output was truncated"
                : gitFailure("candidate cleanup", cleanup),
            );
          }
        } catch (error) {
          this.recordCleanupFailure(project, lease, candidatePath, errorMessage(error));
        }
      }
      if (candidateRoot !== null && candidateRootCreated && !preserveCandidate) {
        await removeEmptyDirectory(candidateRoot);
      }
    }
  }

  private recordCleanupFailure(
    project: ProjectConfig,
    lease: WorkspaceLease,
    candidatePath: string,
    reason: string,
  ): void {
    this.cleanupFailures.push({
      projectId: project.projectId,
      taskId: lease.taskId,
      candidatePath,
      reason,
      timestamp: new Date().toISOString(),
    });
  }
}

function prepareCompletedReceipt(input: {
  readonly taskId: string;
  readonly projectId: string;
  readonly sourceCommit: string;
  readonly originalIntegrationCommit: string;
  readonly resultCommit: string;
  readonly review: ReviewDecision;
  readonly validation: ValidationReport;
}): IntegrationReceipt {
  if (input.taskId === "" || input.projectId === "") {
    throw new Error("completed receipt identities must be nonempty");
  }
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.sourceCommit) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.originalIntegrationCommit) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.resultCommit)
  ) {
    throw new Error("completed receipt commit identities are invalid");
  }
  ReviewDecisionSchema.parse(input.review);
  if (!isVerifiedReviewDecision(input.review)) {
    throw new Error("completed receipt review lacks provenance");
  }
  ValidationReportSchema.parse(input.validation);
  const command = Object.freeze([...input.validation.command]);
  const provenance = Object.freeze({ ...input.validation.provenance });
  const validation = Object.freeze({ ...input.validation, command, provenance });
  const receipt: IntegrationReceipt = Object.freeze({
    taskId: input.taskId,
    projectId: input.projectId,
    sourceCommit: input.sourceCommit,
    originalIntegrationCommit: input.originalIntegrationCommit,
    resultCommit: input.resultCommit,
    review: input.review,
    validation,
    outcome: "completed",
  });
  return receipt;
}

function registerCompletedReceipt(receipt: IntegrationReceipt): IntegrationReceipt {
  verifiedIntegrationReceipts.add(receipt);
  return receipt;
}

function validCompletedFullValidation(
  project: ProjectConfig,
  validation: ValidationReport,
  expected: {
    readonly invocationId: string;
    readonly canonicalCwd: string;
    readonly subjectSha256: string;
  },
): boolean {
  if (!isVerifiedValidationReport(validation, expected)) return false;
  if (!ValidationReportSchema.safeParse(validation).success) return false;
  if (
    validation.name !== "full" ||
    validation.outcome !== "completed" ||
    validation.exitCode !== 0 ||
    JSON.stringify(validation.command) !== JSON.stringify(project.validations.full)
  ) {
    return false;
  }
  try {
    canonicalValidationDigest(validation);
    return true;
  } catch {
    return false;
  }
}

interface IntegrationLeaseTimings {
  readonly leaseMs: number;
  readonly renewalMs: number;
  readonly retryMs: number;
}

async function withIntegrationLease<T>(
  key: IntegrationLeaseKey,
  signal: AbortSignal,
  action: (assertLease: () => void, leaseSignal: AbortSignal) => Promise<T>,
  onLeaseAnomaly?: (reason: string) => void,
  timings: IntegrationLeaseTimings = {
    leaseMs: DEFAULT_INTEGRATION_LEASE_MS,
    renewalMs: DEFAULT_INTEGRATION_LEASE_RENEWAL_MS,
    retryMs: DEFAULT_INTEGRATION_LEASE_RETRY_MS,
  },
): Promise<T> {
  const store = new IntegrationLeaseStore(
    path.join(key.commonDirectory, INTEGRATION_LEASE_DATABASE),
  );
  const recordAnomaly = (reason: string): void => {
    try {
      onLeaseAnomaly?.(reason);
    } catch {
      // Diagnostics recording must never mask the real outcome of the critical section.
    }
  };
  let lease: IntegrationLease | null = null;
  try {
    lease = store.acquire(key, timings.leaseMs);
    while (lease === null) {
      if (signal.aborted) {
        throw new IntegrationExecutionError("cancelled", "lease acquisition");
      }
      await new Promise((resolve) => setTimeout(resolve, timings.retryMs));
      if (signal.aborted) {
        throw new IntegrationExecutionError("cancelled", "lease acquisition");
      }
      lease = store.acquire(key, timings.leaseMs);
    }

    let currentLease = lease;
    let lost = false;
    const leaseController = new AbortController();
    const renew = (): void => {
      if (lost) throw new IntegrationLeaseLostError();
      const renewed = store.renew(currentLease, timings.leaseMs);
      if (renewed === null) {
        lost = true;
        leaseController.abort();
        throw new IntegrationLeaseLostError();
      }
      currentLease = renewed;
    };
    const renewal = setInterval(() => {
      try {
        renew();
      } catch {
        lost = true;
        leaseController.abort();
      }
    }, timings.renewalMs);
    renewal.unref();

    // Settle the try-block outcome (success value or thrown error) before doing
    // any lease-release bookkeeping. A real completed result, or a real thrown
    // error with its evidence, must survive whatever happens while releasing
    // the lease: a `finally` throw would otherwise silently replace it.
    let outcome:
      | { readonly kind: "value"; readonly value: T }
      | { readonly kind: "error"; readonly error: unknown };
    try {
      const result = await action(renew, leaseController.signal);
      outcome = { kind: "value", value: result };
    } catch (error) {
      outcome = { kind: "error", error };
    } finally {
      clearInterval(renewal);
    }

    if (outcome.kind === "value" && lost) {
      // action() already returned its real, durable result (the update-ref CAS
      // already reflects reality by the time action() resolves). Losing the
      // lease afterward, while wrapping up, is evidence to record - it is not
      // grounds to synthesize a false failed/cancelled terminal outcome for a
      // completed integration.
      recordAnomaly("integration lease was lost after action() already completed successfully");
    }

    const released = store.release(currentLease);
    if (!released && !lost) {
      recordAnomaly("integration lease release failed for a reason other than prior loss");
    }

    if (outcome.kind === "error") throw outcome.error;
    return outcome.value;
  } finally {
    store.close();
  }
}

async function canonicalGitCommonDirectory(
  git: GitClient,
  repositoryPath: string,
): Promise<string> {
  const result = await git.run(repositoryPath, [
    "--no-optional-locks",
    "--no-replace-objects",
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ], { timeoutMs: GIT_OPERATION_TIMEOUT_MS });
  if (result.termination !== null) {
    throw new IntegrationExecutionError(result.termination, "Git common directory inspection");
  }
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  if (
    result.exitCode !== 0 ||
    result.truncated ||
    lines.length !== 1 ||
    !path.isAbsolute(lines[0]!)
  ) {
    throw new IntegrationExecutionError("failed", "Git common directory inspection");
  }
  return realpath(lines[0]!);
}

function unavailableValidation(
  project: ProjectConfig,
  outcome: "cancelled" | "timed_out" | "failed",
  reason: string,
): ValidationReport {
  const command = [...project.validations.full] as readonly [string, ...string[]];
  const timestamp = new Date().toISOString();
  return {
    name: "full",
    outcome,
    exitCode: null,
    stdout: "",
    stderr: reason,
    startedAt: timestamp,
    finishedAt: timestamp,
    command,
    argvSha256: sha256(JSON.stringify(command)),
    outputSha256: sha256(JSON.stringify({ stdout: "", stderr: reason })),
    provenance: Object.freeze({
      invocationId: `unavailable-${safeEvidenceName(project.projectId)}-${outcome}`,
      canonicalCwd: project.repositoryPath,
      subjectSha256: null,
    }),
  };
}

function safeEvidenceName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function gitFailure(
  operation: string,
  result: {
    readonly exitCode: number;
    readonly stderr: string;
    readonly truncated?: boolean;
  },
): string {
  if (result.truncated === true) {
    return `${operation} failed because Git output was truncated`;
  }
  const stderr = result.stderr.trim();
  return `${operation} failed with exit code ${result.exitCode}${stderr === "" ? "" : `: ${stderr}`}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch {
    // Another project may share the root, or cleanup may need later reconciliation.
  }
}
