import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type {
  ValidationReport,
  ValidationRunner,
} from "../capabilities/validation-runner.js";
import { isVerifiedValidationReport } from "../capabilities/validation-runner.js";
import type { TerminalOutcome } from "../contracts/task.js";
import { resolveBundledFixture } from "../fixtures/bundled-fixtures.js";
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
  WorkspaceLease,
  WorktreeManager,
} from "../workspaces/worktree-manager.js";
import {
  WorkspaceCommitUncertainError,
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
  ) {}

  async run(input: {
    taskId: string;
    projectId: string;
    title: string;
    workerId: string;
    reviewerId: string;
    workerRequest: Omit<WorkerRequest, "taskId" | "cwd">;
    signal: AbortSignal;
  }): Promise<TaskView> {
    const workerTimeoutMs = input.workerRequest.timeoutMs;
    if (
      !Number.isFinite(workerTimeoutMs) ||
      !Number.isInteger(workerTimeoutMs) ||
      workerTimeoutMs <= 0 ||
      workerTimeoutMs > MAX_WORKER_TIMEOUT_MS
    ) {
      throw new Error(
        `worker timeout must be a finite positive integer at most ${MAX_WORKER_TIMEOUT_MS}ms`,
      );
    }
    this.tasks.create({
      taskId: input.taskId,
      projectId: input.projectId,
      title: input.title,
      correlationId: input.taskId,
    });

    let lease: WorkspaceLease | null = null;
    let stage: Stage = "setup";
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
      const workerInput = await validateWorkerAuthority(input.workerRequest);
      const gitOptions: GitRunOptions = {
        signal: input.signal,
        timeoutMs: workerTimeoutMs,
      };

      const project = this.projects.get(input.projectId);
      await this.worktrees.ensureIntegrationBranch(project, gitOptions);
      lease = await this.worktrees.create(project, input.taskId, gitOptions);
      this.tasks.append(
        input.taskId,
        "task.leased",
        { leaseOwner: input.workerId, workspace: lease.path },
        null,
      );
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
        return this.terminate(
          input.taskId,
          workerResult.outcome,
          stage,
          workerFailure(workerResult),
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

      this.tasks.append(
        input.taskId,
        "task.validation_started",
        { patch, diffSha256 },
        null,
      );
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
      const validationOutcome = failedValidationOutcome(validation);
      if (validationOutcome !== null) {
        return this.terminate(
          input.taskId,
          validationOutcome,
          stage,
          "focused validation did not complete successfully",
          { validation },
        );
      }
      if (!isVerifiedValidationReport(validation, {
        invocationId: validationInvocationId,
        canonicalCwd: canonicalLeasePath,
        subjectSha256: diffSha256,
      })) {
        return this.terminate(
          input.taskId,
          "failed",
          stage,
          "focused validation report provenance mismatch",
          { validation },
        );
      }
      if (
        JSON.stringify(validation.command) !==
        JSON.stringify(project.validations.focused)
      ) {
        return this.terminate(
          input.taskId,
          "failed",
          stage,
          "focused validation command does not match project configuration",
          { validation },
        );
      }

      this.tasks.append(
        input.taskId,
        "task.review_requested",
        { reviewerId: input.reviewerId, validation },
        null,
      );
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
        return this.terminate(
          input.taskId,
          "denied",
          stage,
          verifiedEvidence.reason,
          { review: verifiedEvidence },
        );
      }
      const verifiedReview = this.reviews.verify(reviewInput, verifiedEvidence);
      if (verifiedReview.diffSha256 !== diffSha256) {
        throw new Error("verified review digest differs from inspected diff digest");
      }
      this.tasks.append(
        input.taskId,
        "task.review_approved",
        { review: verifiedReview },
        null,
      );

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
      try {
        receipt = await this.integrations.integrate({
          project,
          lease,
          review: verifiedReview,
          signal: input.signal,
          onPrepared: (preparedReceipt) => {
            this.tasks.append(
              input.taskId,
              "task.integration_prepared",
              { receipt: preparedReceipt },
              null,
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
        return this.terminate(
          input.taskId,
          receipt.outcome,
          stage,
          "integration did not complete successfully",
          {
            receipt,
            candidateCleanupFailures: this.integrationCleanupFailures(input.taskId),
          },
        );
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

  private current(taskId: string): TaskView {
    const current = this.tasks.get(taskId);
    if (current === null) throw new Error(`task ${taskId} not found`);
    return current;
  }
}

async function validateWorkerAuthority(
  request: Omit<WorkerRequest, "taskId" | "cwd">,
): Promise<DeterministicWorkerInput> {
  const executable = await realpath(request.executable);
  const nodeExecutable = await realpath(process.execPath);
  if (executable !== nodeExecutable) {
    throw new Error("tracer worker executable must be the current Node.js executable");
  }

  const parsedInput = parseWorkerInput(request.args);
  const fixture = parsedInput.fixture;
  const fixturePath = await realpath(fixture);
  const bundledFixture = resolveBundledFixture("deterministic-worker.mjs");
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
  if (file === undefined || content === undefined || values.size !== 2) {
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
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    path.posix.normalize(candidate) !== candidate
  ) {
    throw new Error(`artifact path must not contain traversal: ${candidate}`);
  }
}

function failedValidationOutcome(
  validation: ValidationReport,
): Exclude<TerminalOutcome, "completed" | "denied"> | null {
  if (validation.outcome !== "completed") return validation.outcome;
  return validation.exitCode === 0 ? null : "failed";
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

function signalOutcome(
  signal: AbortSignal,
): "cancelled" | "timed_out" | null {
  if (!signal.aborted) return null;
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? "timed_out"
    : "cancelled";
}

function workerFailure(result: WorkerResult): string {
  const stderr = result.stderr.trim();
  return `worker outcome was ${result.outcome}${stderr === "" ? "" : `: ${stderr}`}`;
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
