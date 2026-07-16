import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { ValidationRunner } from "../capabilities/validation-runner.js";
import { isVerifiedValidationReport } from "../capabilities/validation-runner.js";
import {
  ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE,
  artifactEvidenceSha256,
  type ArtifactKind,
  type PatchArtifactEvidence,
} from "../contracts/artifact.js";
import {
  PlannedTaskSchema,
  type PlannedTask,
} from "../contracts/milestone.js";
import type { TerminalOutcome } from "../contracts/task.js";
import {
  IntegrationExecutionError,
  IntegrationUncertainError,
  isVerifiedIntegrationReceipt,
  type IntegrationQueue,
  type IntegrationReceipt,
} from "../integration/integration-queue.js";
import type { ProjectRegistry } from "../projects/project-registry.js";
import {
  isVerifiedReviewDecision,
  type ReviewGate,
} from "../reviews/review-gate.js";
import { assessReviewPolicy } from "../reviews/review-policy.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import {
  canonicalValidationDigest,
  ReviewerExecutionError,
  type ReviewDecision,
  type ReviewerAdapter,
  type ReviewInput,
} from "../reviews/reviewer-adapter.js";
import type { TaskView } from "../tasks/task-projection.js";
import type { TaskService } from "../tasks/task-service.js";
import type {
  WorkerAdapter,
  WorkerRequest,
  WorkerResult,
} from "../workers/worker-adapter.js";
import {
  assertNoGitObjectSubstitution,
  GitClient,
  type GitRunOptions,
} from "../workspaces/git-client.js";
import type {
  WorkspaceCreationIntent,
  WorkspaceLease,
  WorktreeManager,
} from "../workspaces/worktree-manager.js";
import {
  WorkspaceCommitUncertainError,
  WorkspaceCreationUncertainError,
  WorkspaceGitTerminationError,
} from "../workspaces/worktree-manager.js";

const GIT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_WORKER_TIMEOUT_MS = 300_000;
const ArtifactReadySchema = z.strictObject({
  type: z.literal("artifact.ready"),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

type PatchArtifact = z.infer<typeof ArtifactReadySchema>;
interface DeterministicWorkerInput {
  readonly fixture: string;
  readonly file: string;
  readonly content: string;
}
type Stage =
  | "setup"
  | "worker"
  | "artifact"
  | "validation"
  | "review"
  | "commit"
  | "integration"
  | "cleanup"
  | "completion";

export class TracerBulletOrchestrator {
  private readonly git = new GitClient();

  constructor(
    private readonly tasks: TaskService,
    private readonly projects: ProjectRegistry,
    private readonly worktrees: WorktreeManager,
    private readonly worker: WorkerAdapter,
    private readonly validations: ValidationRunner,
    private readonly reviewer: ReviewerAdapter,
    private readonly reviews: ReviewGate,
    private readonly integrations: IntegrationQueue,
    private readonly workerFixture: string,
  ) {}

  async run(input: {
    taskId: string;
    projectId: string;
    title: string;
    workerId: string;
    reviewerId: string;
    workerRequest: Omit<WorkerRequest, "taskId" | "cwd">;
    reviewPolicySecurity: SecuritySheet;
    reviewPolicyTask: PlannedTask;
    signal: AbortSignal;
  }): Promise<TaskView> {
    const workerTimeoutMs = assertValidWorkerTimeout(input.workerRequest.timeoutMs);
    this.tasks.create({
      taskId: input.taskId,
      projectId: input.projectId,
      title: input.title,
      correlationId: input.taskId,
    });

    const stage: Stage = "setup";
    let project: ReturnType<ProjectRegistry["get"]>;
    let lease: WorkspaceLease;
    let gitOptions: GitRunOptions;
    try {
      if (input.workerId === input.reviewerId) {
        return this.terminate(
          input.taskId,
          "denied",
          stage,
          "reviewer identity must differ from worker identity",
        );
      }
      if (
        input.workerRequest.args.length === 0 ||
        input.workerRequest.args.includes("--workspace")
      ) {
        throw new Error(
          "worker args must contain a fixture entry point and omit --workspace",
        );
      }
      await validateWorkerAuthority(input.workerRequest, this.workerFixture);
      gitOptions = {
        signal: input.signal,
        timeoutMs: workerTimeoutMs,
      };

      project = this.projects.get(input.projectId);
      await this.worktrees.ensureIntegrationBranch(project, gitOptions);
      lease = await this.worktrees.create(project, input.taskId, gitOptions, (intent) => {
        this.tasks.append(
          input.taskId,
          "task.worktree_creation_started",
          intent,
          null,
        );
      });
      this.tasks.append(
        input.taskId,
        "task.leased",
        { leaseOwner: input.workerId, workspace: lease.path },
        null,
      );
    } catch (error) {
      if (
        error instanceof WorkspaceGitTerminationError ||
        error instanceof WorkspaceCreationUncertainError
      ) {
        // Worktree creation is effectful: Git may have created the branch
        // or worktree before an interruption even though create() never
        // returned a lease. If durable "prepared" evidence exists
        // (task.worktree_creation_started), leave the task nonterminal so
        // recovery can inspect real Git state and reconcile instead of
        // hiding an uncertain effect behind a terminal outcome.
        return this.current(input.taskId);
      }
      return this.terminate(
        input.taskId,
        signalOutcome(input.signal) ?? "failed",
        stage,
        errorMessage(error),
      );
    }
    // Anything runFromLease() throws propagates untouched: its own internal
    // try/catch is the sole authority over post-lease error handling (e.g.
    // the stage === "completion" rethrow), so it must never be caught again
    // here.
    return this.runFromLease(input, project, lease, gitOptions);
  }

  /**
   * Resumes a task that has durable `task.worktree_creation_started`
   * evidence but was interrupted before `task.leased` was ever recorded.
   * This is a distinct, explicit entry point (parallel to how
   * `RecoveryService.recordCompletion` is a distinct authorized action
   * beyond plain `inspect()`): it never re-runs `TaskService.create()`
   * (which would throw "already exists"), and it never blindly calls
   * `WorktreeManager.create()` again. Instead it:
   *
   *  1. Requires the durable chain to already be exactly "prepared, not
   *     yet leased" (last event is `task.worktree_creation_started`, no
   *     `task.leased`); it does not itself decide whether the underlying
   *     Git state is adoptable.
   *  2. Calls `WorktreeManager.adopt()`, which independently re-verifies
   *     the exact branch/registration/path/base facts immediately before
   *     treating the state as leased -- it never trusts a possibly-stale
   *     recovery decision label, and it throws (never deletes or
   *     overwrites) on any mismatch.
   *  3. Appends `task.leased` as durable evidence only once adoption is
   *     confirmed, then continues through the normal shared pipeline
   *     (worker execution onward) exactly as `run()` would have, reusing
   *     the same `runFromLease` machinery.
   */
  async resume(input: {
    taskId: string;
    projectId: string;
    title: string;
    workerId: string;
    reviewerId: string;
    workerRequest: Omit<WorkerRequest, "taskId" | "cwd">;
    reviewPolicySecurity: SecuritySheet;
    reviewPolicyTask: PlannedTask;
    signal: AbortSignal;
  }): Promise<TaskView> {
    const workerTimeoutMs = assertValidWorkerTimeout(input.workerRequest.timeoutMs);
    const current = this.tasks.get(input.taskId);
    if (current === null) {
      throw new Error(`task ${input.taskId} not found; resume requires an existing durable task`);
    }
    if (current.lifecycle !== "queued") {
      throw new Error(
        `task ${input.taskId} is not in a resumable queued/prepared state (lifecycle: ${current.lifecycle})`,
      );
    }
    const events = this.tasks.readStream(input.taskId);
    const last = events.at(-1);
    if (last === undefined || last.type !== "task.worktree_creation_started") {
      throw new Error(
        `task ${input.taskId} has no durable worktree_creation_started evidence to resume from`,
      );
    }
    const intent = last.payload as WorkspaceCreationIntent;
    if (intent.taskId !== input.taskId) {
      throw new Error("durable worktree creation intent identity does not match the resumed task");
    }

    const stage: Stage = "setup";
    let project: ReturnType<ProjectRegistry["get"]>;
    let lease: WorkspaceLease;
    let gitOptions: GitRunOptions;
    try {
      if (input.workerId === input.reviewerId) {
        return this.terminate(
          input.taskId,
          "denied",
          stage,
          "reviewer identity must differ from worker identity",
        );
      }
      if (
        input.workerRequest.args.length === 0 ||
        input.workerRequest.args.includes("--workspace")
      ) {
        throw new Error(
          "worker args must contain a fixture entry point and omit --workspace",
        );
      }
      await validateWorkerAuthority(input.workerRequest, this.workerFixture);
      gitOptions = {
        signal: input.signal,
        timeoutMs: workerTimeoutMs,
      };

      project = this.projects.get(input.projectId);
      // Never trust a possibly-stale recovery decision label: re-verify the
      // exact branch/registration/path/base facts immediately before
      // treating this task as leased.
      lease = await this.worktrees.resume(project, intent, gitOptions);
      this.tasks.append(
        input.taskId,
        "task.leased",
        { leaseOwner: input.workerId, workspace: lease.path },
        null,
      );
    } catch (error) {
      if (
        error instanceof WorkspaceGitTerminationError ||
        error instanceof WorkspaceCreationUncertainError
      ) {
        return this.current(input.taskId);
      }
      return this.terminate(
        input.taskId,
        signalOutcome(input.signal) ?? "failed",
        stage,
        errorMessage(error),
      );
    }
    // Anything runFromLease() throws propagates untouched: see run()'s
    // matching comment above.
    return this.runFromLease(input, project, lease, gitOptions);
  }

  // Shared post-lease pipeline: worker execution through completion. Both
  // run() (fresh worktree creation) and resume() (adoption of an
  // already-created worktree) call this once a durable task.leased fact
  // exists, so there is exactly one implementation of the worker-onward
  // machinery.
  private async runFromLease(
    input: {
      taskId: string;
      title: string;
      workerId: string;
      reviewerId: string;
      workerRequest: Omit<WorkerRequest, "taskId" | "cwd">;
      reviewPolicySecurity: SecuritySheet;
      reviewPolicyTask: PlannedTask;
      signal: AbortSignal;
    },
    project: ReturnType<ProjectRegistry["get"]>,
    lease: WorkspaceLease,
    gitOptions: GitRunOptions,
  ): Promise<TaskView> {
    let stage: Stage = "setup";
    try {
      const workerInput = parseWorkerInput(input.workerRequest.args);
      this.tasks.append(
        input.taskId,
        "task.started",
        { workerId: input.workerId },
        null,
      );

      stage = "worker";
      await validateWorkerTarget(lease.path, workerInput.file);
      const workerResult = await this.worker.execute(
        workerRequest(input.taskId, lease, input.workerRequest, workerInput),
        input.signal,
        "worker",
      );
      if (workerResult.outcome !== "completed") {
        const stderr = workerResult.stderr.trim();
        return this.terminate(
          input.taskId,
          workerResult.outcome,
          stage,
          `worker outcome was ${workerResult.outcome}${stderr === "" ? "" : `: ${stderr}`}`,
        );
      }
      if (workerResult.exitCode !== 0) {
        throw new Error("completed worker result must have exit code 0");
      }

      stage = "artifact";
      const patch = parseArtifact(workerResult);
      const inspected = await this.worktrees.inspect(lease, gitOptions);
      if (!inspected.dirty || inspected.diff === "") {
        throw new Error("worker completed without a nonempty diff");
      }
      await validateArtifact(lease, patch, this.git, gitOptions);
      const diffSha256 = sha256(inspected.diff);

      this.recordArtifact(input.taskId, "patch", {
        diff: inspected.diff,
        diffSha256,
        changedPath: patch.path,
        changedContentSha256: patch.sha256,
      } satisfies PatchArtifactEvidence, {
        type: "task.validation_started",
        payload: { patch, diffSha256 },
      });
      stage = "validation";
      const validationInvocationId = randomUUID();
      const canonicalLeasePath = await realpath(lease.path);
      const validation = await this.validations.run(
        project,
        "focused",
        lease.path,
        input.signal,
        { invocationId: validationInvocationId, subjectSha256: diffSha256 },
      );
      if (validation.provenance.subjectSha256 !== diffSha256) {
        this.recordArtifact(
          input.taskId,
          "validation_report",
          validation,
          {
            type: "task.failed",
            payload: {
              stage,
              reason: "focused validation report subject does not match the patch digest",
              validation,
            },
          },
        );
        return this.current(input.taskId);
      }
      if (validation.outcome !== "completed" || validation.exitCode !== 0) {
        const validationOutcome = validation.outcome === "completed" ? "failed" : validation.outcome;
        this.recordArtifact(input.taskId, "validation_report", validation, {
          type: `task.${validationOutcome}`,
          payload: {
            stage,
            reason: "focused validation did not complete successfully",
            validation,
          },
        });
        return this.current(input.taskId);
      }
      if (!isVerifiedValidationReport(validation, {
        invocationId: validationInvocationId,
        canonicalCwd: canonicalLeasePath,
        subjectSha256: diffSha256,
      })) {
        this.recordArtifact(input.taskId, "validation_report", validation, {
          type: "task.failed",
          payload: { stage, reason: "focused validation report provenance mismatch", validation },
        });
        return this.current(input.taskId);
      }
      if (
        JSON.stringify(validation.command) !==
        JSON.stringify(project.validations.focused)
      ) {
        this.recordArtifact(input.taskId, "validation_report", validation, {
          type: "task.failed",
          payload: {
            stage,
            reason: "focused validation command does not match project configuration",
            validation,
          },
        });
        return this.current(input.taskId);
      }

      this.recordArtifact(input.taskId, "validation_report", validation, {
        type: "task.review_requested",
        payload: { reviewerId: input.reviewerId, validation },
      });
      stage = "review";
      const reviewInput: ReviewInput = {
        workerId: input.workerId,
        reviewerId: input.reviewerId,
        diff: inspected.diff,
        validation,
      };
      const decision = await this.reviewer.review(reviewInput, input.signal);
      const verifiedEvidence = this.reviews.verifyEvidence(reviewInput, decision);
      if (!verifiedEvidence.approved) {
        this.recordArtifact(input.taskId, "review_report", verifiedEvidence, {
          type: "task.denied",
          payload: { stage, reason: verifiedEvidence.reason, review: verifiedEvidence },
        });
        return this.current(input.taskId);
      }
      const verifiedReview = this.reviews.verify(reviewInput, verifiedEvidence);
      if (verifiedReview.diffSha256 !== diffSha256) {
        throw new Error("verified review digest differs from inspected diff digest");
      }
      this.recordArtifact(input.taskId, "review_report", verifiedReview, {
        type: "task.review_approved",
        payload: { review: verifiedReview },
      });
      const reviewPolicyTask = PlannedTaskSchema.parse({
        ...input.reviewPolicyTask,
        taskId: input.taskId,
        title: input.title,
        ownedPaths: [patch.path],
      });
      const reviewPolicy = assessReviewPolicy({
        task: reviewPolicyTask,
        security: input.reviewPolicySecurity,
        workerId: input.workerId,
        reviewerIds: [verifiedReview.reviewerId],
      });
      if (reviewPolicy.status !== "ready_for_review") {
        this.tasks.append(input.taskId, "task.review_policy_blocked", {
          stage,
          reason: reviewPolicy.reason,
          reviewPolicy,
        }, null);
        return this.current(input.taskId);
      }

      stage = "commit";
      const sourceCommit = await this.worktrees.commit(
        lease,
        [patch.path],
        input.title,
        verifiedReview.diffSha256,
        { signal: input.signal, timeoutMs: input.workerRequest.timeoutMs },
      );
      const postCommitOutcome = signalOutcome(input.signal);
      if (postCommitOutcome !== null) {
        return this.terminate(
          input.taskId,
          postCommitOutcome,
          stage,
          "task signal ended after commit acknowledgement",
          { sourceCommit },
        );
      }
      this.tasks.append(
        input.taskId,
        "task.integration_started",
        { sourceCommit, review: verifiedReview },
        null,
      );

      stage = "integration";
      let receipt: IntegrationReceipt;
      const prepared = { receipt: null as IntegrationReceipt | null };
      try {
        receipt = await this.integrations.integrate({
          project,
          lease,
          review: verifiedReview,
          signal: input.signal,
          onPrepared: (preparedReceipt) => {
            prepared.receipt = preparedReceipt;
            this.recordArtifact(
              input.taskId,
              "integration_receipt",
              preparedReceipt,
              {
                type: "task.integration_prepared",
                payload: { receipt: preparedReceipt },
              },
              "prepared",
            );
          },
        });
      } catch (error) {
        if (error instanceof IntegrationUncertainError) {
          return this.observeIntegration(input.taskId, {
            reason: error.message,
            evidence: error.evidence,
          });
        }
        if (error instanceof IntegrationExecutionError) throw error;
        return this.observeIntegration(input.taskId, {
          error: { name: errorName(error), message: errorMessage(error) },
        });
      }
      if (receipt.outcome !== "completed") {
        const finalReceipt = prepared.receipt === null
          ? receipt
          : { ...prepared.receipt, outcome: receipt.outcome };
        this.recordArtifact(
          input.taskId,
          "integration_receipt",
          finalReceipt,
          {
            type: `task.${receipt.outcome}`,
            payload: {
              stage,
              reason: "integration did not complete successfully",
              receipt: finalReceipt,
              candidateCleanupFailures: this.integrationCleanupFailures(input.taskId),
            },
          },
          "final",
        );
        return this.current(input.taskId);
      }
      try {
        await validateIntegrationReceipt({
          project,
          taskId: input.taskId,
          sourceCommit,
          review: verifiedReview,
          receipt,
          git: this.git,
        });
      } catch (error) {
        return this.observeIntegration(input.taskId, {
          receipt,
          verification: "failed",
          reason: errorMessage(error),
        });
      }
      this.tasks.append(
        input.taskId,
        "task.integration_observed",
        {
          receipt,
          verification: "verified",
          cleanupFailures: this.integrationCleanupFailures(input.taskId),
        },
        null,
      );
      stage = "cleanup";
      this.tasks.append(
        input.taskId,
        "task.cleanup_started",
        {
          sourceCommit,
          resultCommit: receipt.resultCommit,
          workspace: lease.path,
          branch: lease.branch,
        },
        null,
      );
      try {
        await this.worktrees.cleanupCompleted(project, lease, sourceCommit, {
          timeoutMs: GIT_OPERATION_TIMEOUT_MS,
        });
      } catch (error) {
        const cleanupError = error as {
          readonly phase?: unknown;
          readonly uncertain?: unknown;
          readonly evidence?: unknown;
        };
        return this.tasks.append(
          input.taskId,
          "task.cleanup_observed",
          {
            phase: typeof cleanupError.phase === "string" ? cleanupError.phase : "unknown",
            uncertain: cleanupError.uncertain === true,
            evidence: cleanupError.evidence ?? {},
            reason: errorMessage(error),
          },
          null,
        );
      }
      this.tasks.append(
        input.taskId,
        "task.cleanup_completed",
        {
          sourceCommit,
          resultCommit: receipt.resultCommit,
          workspace: lease.path,
          branch: lease.branch,
        },
        null,
      );
      stage = "completion";
      return this.tasks.append(
        input.taskId,
        "task.completed",
        { receipt },
        null,
      );
    } catch (error) {
      if (stage === "completion") throw error;
      if (error instanceof WorkspaceCommitUncertainError) {
        return this.tasks.append(
          input.taskId,
          "task.commit_observed",
          { stage: "commit", reason: error.message },
          null,
        );
      }
      const dependencyOutcome =
        error instanceof ReviewerExecutionError ||
        error instanceof WorkspaceGitTerminationError ||
        error instanceof IntegrationExecutionError
          ? error.outcome
          : null;
      if (stage === "integration" && dependencyOutcome === null) {
        return this.observeIntegration(input.taskId, {
          error: { name: errorName(error), message: errorMessage(error) },
        });
      }
      // Unlike run()/resume()'s own setup stage, runFromLease() is only ever
      // invoked after a durable task.leased fact already exists, so a
      // "setup"-stage error here (e.g. worker authority validation) can
      // never be an uncertain worktree-creation effect: the lease is always
      // present by construction.
      return this.terminate(
        input.taskId,
        dependencyOutcome ?? signalOutcome(input.signal) ?? "failed",
        stage,
        errorMessage(error),
      );
    }
  }

  private terminate(
    taskId: string,
    outcome: TerminalOutcome,
    stage: Stage,
    reason: string,
    evidence: Record<string, unknown> = {},
  ): TaskView {
    const current = this.tasks.get(taskId);
    if (current === null) throw new Error(`task ${taskId} not found`);
    if (current.lifecycle === "terminal") return current;
    return this.tasks.append(
      taskId,
      `task.${outcome}`,
      { stage, reason, ...evidence },
      null,
    );
  }

  private observeIntegration(taskId: string, payload: unknown): TaskView {
    const durablePayload = typeof payload === "object" && payload !== null
      ? { ...payload, cleanupFailures: this.integrationCleanupFailures(taskId) }
      : { evidence: payload, cleanupFailures: this.integrationCleanupFailures(taskId) };
    return this.tasks.append(
      taskId,
      "task.integration_observed",
      durablePayload,
      null,
    );
  }

  private integrationCleanupFailures(taskId: string): readonly unknown[] {
    return this.integrations.getCleanupFailures().filter((failure) => failure.taskId === taskId);
  }

  private recordArtifact(
    taskId: string,
    kind: ArtifactKind,
    evidence: unknown,
    following: { readonly type: string; readonly payload: unknown },
    phase?: "prepared" | "final",
  ): void {
    const digest = artifactEvidenceSha256(kind, evidence);
    const payload = this.artifactPayload(taskId, kind, evidence, digest, phase) as {
      readonly artifact: {
        readonly artifactId: string;
        readonly kind: ArtifactKind;
        readonly sha256: string;
      };
    };
    this.tasks.appendBatch(taskId, [
      {
        type: ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE,
        payload: {
          artifactProtocolVersion: 1,
          artifactId: payload.artifact.artifactId,
          kind: payload.artifact.kind,
          sha256: payload.artifact.sha256,
        },
        causationId: null,
      },
      { type: `artifact.${kind}_recorded`, payload, causationId: null },
      { ...following, causationId: null },
    ]);
  }

  private artifactPayload(
    taskId: string,
    kind: ArtifactKind,
    evidence: unknown,
    digest: string,
    phase?: "prepared" | "final",
  ): unknown {
    const logicalPaths: Record<ArtifactKind, string> = {
      patch: "artifacts/patch.diff",
      validation_report: "artifacts/focused-validation.json",
      review_report: "artifacts/review-decision.json",
      integration_receipt: "artifacts/integration-receipt.json",
    };
    return {
      artifact: {
        artifactId: randomUUID(),
        taskId,
        kind,
        path: logicalPaths[kind],
        sha256: digest,
        createdAt: new Date().toISOString(),
      },
      evidence,
      ...(phase === undefined ? {} : { phase }),
    };
  }

  private current(taskId: string): TaskView {
    const current = this.tasks.get(taskId);
    if (current === null) throw new Error(`task ${taskId} not found`);
    return current;
  }
}

async function validateWorkerAuthority(
  request: Omit<WorkerRequest, "taskId" | "cwd">,
  expectedFixture: string,
): Promise<DeterministicWorkerInput> {
  const executable = await realpath(request.executable);
  const nodeExecutable = await realpath(process.execPath);
  if (executable !== nodeExecutable) {
    throw new Error("tracer worker executable must be the current Node.js executable");
  }

  const parsedInput = parseWorkerInput(request.args);
  const fixturePath = await realpath(parsedInput.fixture);
  const bundledFixture = await realpath(expectedFixture);
  if (fixturePath !== bundledFixture) {
    throw new Error("tracer worker script must be Zentra's bundled deterministic fixture");
  }
  return parsedInput;
}

function parseWorkerInput(args: readonly string[]): DeterministicWorkerInput {
  const fixture = args[0];
  if (fixture === undefined) throw new Error("worker fixture entry point is required");
  const values = new Map<string, string>();
  const allowed = new Set(["--file", "--content"]);
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !allowed.has(flag)) {
      throw new Error(`worker args contain an unknown flag: ${String(flag)}`);
    }
    if (values.has(flag)) throw new Error(`worker args duplicate ${flag}`);
    if (value === undefined) throw new Error(`worker args missing value for ${flag}`);
    values.set(flag, value);
  }
  const file = values.get("--file");
  const content = values.get("--content");
  if (file === undefined || content === undefined) {
    throw new Error("worker args require exactly --file and --content");
  }
  // MVP fixture scope is deliberately one root-level file, currently greeting.txt.
  if (file.includes("/") || file.includes("\\")) {
    throw new Error("worker --file must be one root-level filename without slashes");
  }
  validateRelativePath(file);
  return { fixture, file, content };
}

async function validateWorkerTarget(workspace: string, file: string): Promise<void> {
  const canonicalWorkspace = await realpath(workspace);
  const segments = file.split("/");
  let current = canonicalWorkspace;
  for (const segment of segments.slice(0, -1)) {
    const candidate = path.join(current, segment);
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`worker target parent is not a real directory: ${segment}`);
      }
      current = await realpath(candidate);
      if (!current.startsWith(`${canonicalWorkspace}${path.sep}`)) {
        throw new Error("worker target parent escapes workspace");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  const target = path.resolve(canonicalWorkspace, file);
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error("worker target must not be a symbolic link");
    const canonicalTarget = await realpath(target);
    if (!canonicalTarget.startsWith(`${canonicalWorkspace}${path.sep}`)) {
      throw new Error("worker target escapes workspace");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// The deterministic fixture script is argv[0]. The orchestrator owns workspace
// selection and injects it before the caller's fixture-specific arguments.
function workerRequest(
  taskId: string,
  lease: WorkspaceLease,
  request: Omit<WorkerRequest, "taskId" | "cwd">,
  input: DeterministicWorkerInput,
): WorkerRequest {
  return {
    taskId,
    executable: request.executable,
    args: [
      input.fixture,
      "--workspace",
      lease.path,
      "--file",
      input.file,
      "--content",
      input.content,
    ],
    cwd: lease.path,
    timeoutMs: request.timeoutMs,
  };
}

function parseArtifact(
  result: WorkerResult,
): PatchArtifact {
  if (result.events.length !== 1) {
    throw new Error(
      `worker protocol requires exactly one artifact.ready event, received ${result.events.length}`,
    );
  }
  const parsed = ArtifactReadySchema.safeParse(result.events[0]);
  if (!parsed.success) {
    throw new Error(`worker protocol returned an invalid artifact.ready event: ${parsed.error.message}`);
  }
  const artifact = parsed.data;
  validateRelativePath(artifact.path);
  return artifact;
}

async function validateArtifact(
  lease: WorkspaceLease,
  artifact: PatchArtifact,
  git: GitClient,
  options: GitRunOptions,
): Promise<void> {
  const workspacePath = await realpath(lease.path);
  const artifactPath = path.resolve(workspacePath, artifact.path);
  const canonicalArtifactPath = await realpath(artifactPath);
  if (!canonicalArtifactPath.startsWith(`${workspacePath}${path.sep}`)) {
    throw new Error(`artifact path escapes workspace: ${artifact.path}`);
  }
  const stat = await lstat(canonicalArtifactPath);
  if (!stat.isFile()) throw new Error(`artifact path is not a regular file: ${artifact.path}`);
  const actualSha256 = createHash("sha256")
    .update(await readFile(canonicalArtifactPath))
    .digest("hex");
  if (actualSha256 !== artifact.sha256) {
    throw new Error(
      `artifact digest mismatch: event ${artifact.sha256}, file ${actualSha256}`,
    );
  }

  const changed = await git.run(lease.path, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotepath=off",
    "diff",
    "--name-only",
    "--no-ext-diff",
    "--no-textconv",
  ], options);
  if (changed.termination !== null) {
    throw new WorkspaceGitTerminationError(
      changed.termination,
      "artifact changed-path read",
    );
  }
  if (changed.exitCode !== 0 || changed.truncated) {
    throw new Error("could not obtain the complete worker diff path list");
  }
  const changedPaths = changed.stdout.split("\n").filter(Boolean);
  if (changedPaths.length !== 1 || changedPaths[0] !== artifact.path) {
    throw new Error("artifact.ready path does not exactly match the worker diff");
  }
}

function validateRelativePath(candidate: string): void {
  if (
    candidate.includes("\0") ||
    candidate.includes("\n") ||
    candidate.includes("\r") ||
    path.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate)
  ) {
    throw new Error(`artifact path must be a safe relative path: ${candidate}`);
  }
  const segments = candidate.split(/[\\/]/);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`artifact path must not contain traversal: ${candidate}`);
  }
}

async function validateIntegrationReceipt(input: {
  readonly project: {
    readonly projectId: string;
    readonly repositoryPath: string;
    readonly integrationBranch: string;
    readonly validations: { readonly full: readonly string[] };
  };
  readonly taskId: string;
  readonly sourceCommit: string;
  readonly review: ReviewDecision;
  readonly receipt: IntegrationReceipt;
  readonly git: GitClient;
}): Promise<void> {
  const { project, taskId, sourceCommit, review, receipt, git } = input;
  await assertNoGitObjectSubstitution(git, project.repositoryPath, GIT_OPERATION_TIMEOUT_MS);
  if (!isVerifiedIntegrationReceipt(receipt)) {
    throw new Error("completed integration receipt lacks queue provenance");
  }
  if (
    receipt.outcome !== "completed" ||
    receipt.taskId !== taskId ||
    receipt.projectId !== project.projectId ||
    receipt.sourceCommit !== sourceCommit
  ) {
    throw new Error("completed integration receipt identity does not match the task");
  }
  if (
    receipt.review !== review ||
    !isVerifiedReviewDecision(receipt.review)
  ) {
    throw new Error("completed integration receipt does not retain verified review provenance");
  }
  if (
    receipt.originalIntegrationCommit === null ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt.originalIntegrationCommit) ||
    receipt.resultCommit === null ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt.resultCommit)
  ) {
    throw new Error("completed integration receipt has no valid integration base or result commit");
  }
  if (
    receipt.validation.name !== "full" ||
    receipt.validation.outcome !== "completed" ||
    receipt.validation.exitCode !== 0 ||
    JSON.stringify(receipt.validation.command) !==
      JSON.stringify(project.validations.full)
  ) {
    throw new Error("completed integration receipt has invalid full validation evidence");
  }
  canonicalValidationDigest(receipt.validation);

  const integrationRef = `refs/heads/${project.integrationBranch}`;
  const symbolic = await git.run(
    project.repositoryPath,
    ["--no-replace-objects", "symbolic-ref", "--quiet", integrationRef],
    { timeoutMs: GIT_OPERATION_TIMEOUT_MS },
  );
  if (
    symbolic.termination !== null ||
    symbolic.truncated ||
    symbolic.exitCode !== 1
  ) {
    throw new Error("integration ref must be an exact nonsymbolic ref");
  }
  const head = await git.run(project.repositoryPath, [
    "--no-replace-objects",
    "rev-parse",
    "--verify",
    `${integrationRef}^{commit}`,
  ], { timeoutMs: GIT_OPERATION_TIMEOUT_MS });
  if (
    head.termination !== null ||
    head.exitCode !== 0 ||
    head.truncated ||
    head.stdout.trim() !== receipt.resultCommit
  ) {
    throw new Error("integration ref does not match the completed receipt");
  }
  const parents = await git.run(
    project.repositoryPath,
    ["--no-replace-objects", "rev-list", "--parents", "--max-count=1", receipt.resultCommit],
    { timeoutMs: GIT_OPERATION_TIMEOUT_MS },
  );
  if (
    parents.termination !== null ||
    parents.truncated ||
    parents.exitCode !== 0
  ) {
    throw new Error("receipt result merge parents could not be inspected");
  }
  const resultShape = parents.stdout.trim().split(/\s+/);
  if (
    resultShape.length !== 3 ||
    resultShape[0] !== receipt.resultCommit ||
    resultShape[1] !== receipt.originalIntegrationCommit ||
    resultShape[2] !== sourceCommit
  ) {
    throw new Error("receipt result does not have the exact integration-base/source merge shape");
  }
}

function assertValidWorkerTimeout(workerTimeoutMs: number): number {
  if (
    !Number.isInteger(workerTimeoutMs) ||
    workerTimeoutMs <= 0 ||
    workerTimeoutMs > MAX_WORKER_TIMEOUT_MS
  ) {
    throw new Error(
      `worker timeout must be a finite positive integer at most ${MAX_WORKER_TIMEOUT_MS}ms`,
    );
  }
  return workerTimeoutMs;
}

function signalOutcome(
  signal: AbortSignal,
): "cancelled" | "timed_out" | null {
  if (!signal.aborted) return null;
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? "timed_out"
    : "cancelled";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
