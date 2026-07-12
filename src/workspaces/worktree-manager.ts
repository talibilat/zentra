import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../projects/project-config.js";
import {
  GitClient,
  type CommandResult,
  type GitRunOptions,
} from "./git-client.js";

const SAFE_GIT_ARGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
] as const;
const EXTERNAL_PROGRAM_CONFIG =
  "^(merge\\..*\\.driver|diff\\.external|diff\\..*\\.(command|textconv)|filter\\..*\\.(clean|smudge|process))$";

export interface WorkspaceLease {
  readonly taskId: string;
  readonly branch: string;
  readonly path: string;
}

export class WorkspaceGitTerminationError extends Error {
  override readonly name = "WorkspaceGitTerminationError";

  constructor(
    readonly outcome: "cancelled" | "timed_out",
    operation: string,
  ) {
    super(`workspace Git operation ${operation} was ${outcome}`);
  }
}

export class WorkspaceCommitUncertainError extends Error {
  override readonly name = "WorkspaceCommitUncertainError";

  constructor(reason: string) {
    super(`workspace commit result is uncertain: ${reason}`);
  }
}

export class WorktreeManager {
  constructor(private readonly git = new GitClient()) {}

  async ensureIntegrationBranch(
    project: ProjectConfig,
    options: GitRunOptions = {},
  ): Promise<void> {
    await this.assertSafeGitConfiguration(project.repositoryPath, options);
    const existing = await this.run(project.repositoryPath, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${project.integrationBranch}`,
    ], options);
    if (existing.termination !== null) {
      throw new WorkspaceGitTerminationError(existing.termination, "read integration branch");
    }
    if (existing.truncated) throw new Error("integration branch lookup output was truncated");
    if (existing.exitCode === 0) {
      return;
    }
    await this.runOrThrow(project.repositoryPath, [
      "branch",
      project.integrationBranch,
    ], options);
  }

  async create(
    project: ProjectConfig,
    taskId: string,
    options: GitRunOptions = {},
  ): Promise<WorkspaceLease> {
    await this.assertSafeGitConfiguration(project.repositoryPath, options);
    const branch = `ticket/${taskId}`;
    const worktreePath = path.join(project.worktreeRoot, taskId);

    if (existsSync(worktreePath)) {
      const status = await this.run(worktreePath, ["status", "--porcelain"], options);
      if (status.exitCode === 0 && status.stdout.trim() !== "") {
        throw new Error(
          `Refusing to reuse dirty worktree path: ${worktreePath}`,
        );
      }
      throw new Error(`Worktree path already exists: ${worktreePath}`);
    }

    mkdirSync(project.worktreeRoot, { recursive: true });
    await this.runOrThrow(project.repositoryPath, [
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      project.integrationBranch,
    ], options);

    return { taskId, branch, path: worktreePath };
  }

  async inspect(
    lease: WorkspaceLease,
    options: GitRunOptions = {},
  ): Promise<{ dirty: boolean; diff: string }> {
    await this.assertSafeGitConfiguration(lease.path, options);
    return this.inspectPath(lease.path, options);
  }

  async commit(
    lease: WorkspaceLease,
    paths: readonly string[],
    message: string,
    expectedDiffSha256: string,
    options: GitRunOptions = {},
  ): Promise<string> {
    if (paths.length === 0) {
      throw new Error("Refusing to commit an empty path list");
    }
    // Normalize to the posix form git reports (so "./a.txt" matches "a.txt").
    const normalizedPaths = paths.map((candidate) => {
      if (path.isAbsolute(candidate)) {
        throw new Error(`Refusing to commit absolute path: ${candidate}`);
      }
      const normalized = path.posix.normalize(candidate);
      if (
        normalized === ".." ||
        normalized.startsWith("../") ||
        normalized.split("/").includes("..")
      ) {
        throw new Error(`Refusing path traversal outside worktree: ${candidate}`);
      }
      return normalized;
    });

    await this.assertSafeGitConfiguration(lease.path, options);
    const { diff } = await this.inspectPath(lease.path, options);
    const actualDigest = createHash("sha256").update(diff, "utf8").digest("hex");
    if (actualDigest !== expectedDiffSha256) {
      throw new Error(
        `Diff SHA-256 mismatch: expected ${expectedDiffSha256}, actual ${actualDigest}`,
      );
    }

    const changedOutput = await this.runOrThrow(lease.path, [
      "-c",
      "core.quotepath=off",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
    ], options);
    if (changedOutput.truncated) {
      throw new Error("Refusing to commit with truncated changed-path evidence");
    }
    const changedPaths = new Set(
      changedOutput.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
    );
    for (const candidate of normalizedPaths) {
      if (!changedPaths.has(candidate)) {
        throw new Error(`Path is not present in the current diff: ${candidate}`);
      }
    }

    const preCommitHead = (
      await this.runOrThrow(lease.path, ["rev-parse", "HEAD"], options)
    ).stdout.trim();
    await this.runOrThrow(lease.path, ["add", "--", ...normalizedPaths], options);
    if (options.signal?.aborted) {
      throw new WorkspaceGitTerminationError(signalOutcome(options.signal), "before final commit");
    }
    const commitResult = await this.run(lease.path, [
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "--only",
      "-m",
      message,
      "--",
      ...normalizedPaths,
    ], timeoutOnly(options));
    if (commitResult.termination !== null) {
      return this.reconcileCommit(
        lease.path,
        preCommitHead,
        normalizedPaths,
        expectedDiffSha256,
        commitResult.termination,
        options,
      );
    }
    if (commitResult.exitCode !== 0) {
      throw new Error(`git commit failed with exit code ${commitResult.exitCode}: ${commitResult.stderr.trim()}`);
    }
    const head = await this.run(lease.path, ["rev-parse", "HEAD"], options);
    if (head.termination !== null) {
      return this.reconcileCommit(
        lease.path,
        preCommitHead,
        normalizedPaths,
        expectedDiffSha256,
        head.termination,
        options,
      );
    }
    if (head.exitCode !== 0 || head.truncated || head.stdout.trim() === "") {
      throw new WorkspaceCommitUncertainError("post-commit identity read failed");
    }
    return head.stdout.trim();
  }

  async remove(project: ProjectConfig, lease: WorkspaceLease): Promise<void> {
    if (!existsSync(lease.path)) {
      return;
    }
    // Decide dirtiness from status alone: a worktree that is about to be
    // preserved as evidence must not be mutated (no intent-to-add pass).
    const status = await this.runOrThrow(lease.path, ["status", "--porcelain"]);
    if (status.stdout.trim() !== "") {
      // Preserve failed work for inspection instead of destroying evidence.
      return;
    }
    await this.runOrThrow(project.repositoryPath, [
      "worktree",
      "remove",
      lease.path,
    ]);
  }

  private async inspectPath(
    worktreePath: string,
    options: GitRunOptions = {},
  ): Promise<{ dirty: boolean; diff: string }> {
    const staged = await this.runOrThrow(worktreePath, [
      "-c",
      "core.quotepath=off",
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
    ], options);
    if (staged.truncated) {
      throw new Error(`Refusing staged diff with truncated output for ${worktreePath}`);
    }
    if (staged.stdout !== "") {
      throw new Error(`Refusing pre-existing staged changes in worktree: ${worktreePath}`);
    }
    const status = await this.runOrThrow(worktreePath, ["status", "--porcelain"], options);
    const dirty = status.stdout.trim() !== "";
    if (dirty) {
      // Register untracked files as intent-to-add so they appear in the diff
      // without staging their content.
      await this.runOrThrow(
        worktreePath,
        ["add", "--intent-to-add", "--all"],
        options,
      );
    }
    // --binary makes the diff (and thus its digest) cover actual binary file
    // contents instead of a constant "Binary files differ" marker.
    // core.quotepath=off keeps non-ASCII paths unescaped so they match the
    // caller-supplied path form. commit() digests the same command's output.
    const diff = await this.runOrThrow(worktreePath, [
      "-c",
      "core.quotepath=off",
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
    ], options);
    if (diff.truncated) {
      throw new Error(
        `Refusing to digest truncated diff output for ${worktreePath}: diff exceeds the capture limit`,
      );
    }
    return { dirty, diff: diff.stdout };
  }

  private async reconcileCommit(
    cwd: string,
    preCommitHead: string,
    paths: readonly string[],
    expectedDiffSha256: string,
    outcome: "cancelled" | "timed_out",
    options: GitRunOptions,
  ): Promise<string> {
    const reconciliationOptions = timeoutOnly(options);
    const head = await this.run(cwd, ["rev-parse", "HEAD"], reconciliationOptions);
    if (
      head.termination !== null ||
      head.exitCode !== 0 ||
      head.truncated ||
      head.stdout.trim() === ""
    ) {
      throw new WorkspaceCommitUncertainError("HEAD could not be reconciled");
    }
    const currentHead = head.stdout.trim();
    if (currentHead === preCommitHead) {
      throw new WorkspaceGitTerminationError(outcome, "final commit before effect");
    }
    const diff = await this.run(cwd, [
      "-c",
      "core.quotepath=off",
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      preCommitHead,
      currentHead,
    ], reconciliationOptions);
    const changed = await this.run(cwd, [
      "-c",
      "core.quotepath=off",
      "diff",
      "--name-only",
      "--no-ext-diff",
      "--no-textconv",
      preCommitHead,
      currentHead,
    ], reconciliationOptions);
    const changedPaths = changed.stdout.split("\n").filter(Boolean).sort();
    if (
      diff.termination !== null ||
      changed.termination !== null ||
      diff.exitCode !== 0 ||
      changed.exitCode !== 0 ||
      diff.truncated ||
      changed.truncated ||
      createHash("sha256").update(diff.stdout, "utf8").digest("hex") !== expectedDiffSha256 ||
      JSON.stringify(changedPaths) !== JSON.stringify([...paths].sort())
    ) {
      throw new WorkspaceCommitUncertainError("committed tree does not match reviewed diff and paths");
    }
    return currentHead;
  }

  private async assertSafeGitConfiguration(
    cwd: string,
    options: GitRunOptions,
  ): Promise<void> {
    const result = await this.run(
      cwd,
      ["config", "--get-regexp", EXTERNAL_PROGRAM_CONFIG],
      options,
    );
    if (result.termination !== null) {
      throw new WorkspaceGitTerminationError(result.termination, "Git configuration preflight");
    }
    if (result.truncated || (result.exitCode !== 0 && result.exitCode !== 1)) {
      throw new Error("Git external program configuration preflight failed closed");
    }
    if (result.exitCode === 0 && result.stdout.trim() !== "") {
      throw new Error("configured external Git programs are not allowed");
    }
  }

  private run(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<CommandResult> {
    return this.git.run(cwd, [...SAFE_GIT_ARGS, ...args], options);
  }

  private async runOrThrow(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<CommandResult> {
    const result = await this.run(cwd, args, options);
    if (result.termination !== null) {
      throw new WorkspaceGitTerminationError(
        result.termination,
        `git ${args.join(" ")}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
      );
    }
    return result;
  }
}

function timeoutOnly(options: GitRunOptions): GitRunOptions {
  return options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
}

function signalOutcome(signal: AbortSignal): "cancelled" | "timed_out" {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? "timed_out"
    : "cancelled";
}
