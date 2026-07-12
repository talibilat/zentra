import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../projects/project-config.js";
import { GitClient, type CommandResult } from "./git-client.js";

export interface WorkspaceLease {
  readonly taskId: string;
  readonly branch: string;
  readonly path: string;
}

export class WorktreeManager {
  private readonly git = new GitClient();

  async ensureIntegrationBranch(project: ProjectConfig): Promise<void> {
    const existing = await this.git.run(project.repositoryPath, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${project.integrationBranch}`,
    ]);
    if (existing.exitCode === 0) {
      return;
    }
    await this.runOrThrow(project.repositoryPath, [
      "branch",
      project.integrationBranch,
    ]);
  }

  async create(project: ProjectConfig, taskId: string): Promise<WorkspaceLease> {
    const branch = `ticket/${taskId}`;
    const worktreePath = path.join(project.worktreeRoot, taskId);

    if (existsSync(worktreePath)) {
      const status = await this.git.run(worktreePath, ["status", "--porcelain"]);
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
    ]);

    return { taskId, branch, path: worktreePath };
  }

  async inspect(lease: WorkspaceLease): Promise<{ dirty: boolean; diff: string }> {
    return this.inspectPath(lease.path);
  }

  async commit(
    lease: WorkspaceLease,
    paths: readonly string[],
    message: string,
    expectedDiffSha256: string,
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

    const { diff } = await this.inspectPath(lease.path);
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
    ]);
    const changedPaths = new Set(
      changedOutput.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
    );
    for (const candidate of normalizedPaths) {
      if (!changedPaths.has(candidate)) {
        throw new Error(`Path is not present in the current diff: ${candidate}`);
      }
    }

    await this.runOrThrow(lease.path, ["add", "--", ...normalizedPaths]);
    await this.runOrThrow(lease.path, ["commit", "-m", message]);
    const head = await this.runOrThrow(lease.path, ["rev-parse", "HEAD"]);
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
  ): Promise<{ dirty: boolean; diff: string }> {
    const status = await this.runOrThrow(worktreePath, ["status", "--porcelain"]);
    const dirty = status.stdout.trim() !== "";
    if (dirty) {
      // Register untracked files as intent-to-add so they appear in the diff
      // without staging their content.
      await this.runOrThrow(worktreePath, ["add", "--intent-to-add", "--all"]);
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
    ]);
    if (diff.truncated) {
      throw new Error(
        `Refusing to digest truncated diff output for ${worktreePath}: diff exceeds the capture limit`,
      );
    }
    return { dirty, diff: diff.stdout };
  }

  private async runOrThrow(
    cwd: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    const result = await this.git.run(cwd, args);
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
      );
    }
    return result;
  }
}
