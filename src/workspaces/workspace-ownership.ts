import { lstatSync } from "node:fs";
import path from "node:path";

import { GitClient, type GitRunOptions } from "./git-client.js";
import type { WorkspaceLease } from "./worktree-manager.js";

const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;

export interface OwnershipViolation {
  readonly path: string;
  readonly reason:
    | "outside_owned_scope"
    | "forbidden_scope"
    | "symbolic_link"
    | "git_state_changed";
}

export interface WorkspaceOwnershipReport {
  readonly outcome: "accepted" | "rejected";
  readonly changedPaths: readonly string[];
  readonly violations: readonly OwnershipViolation[];
  readonly inspectedAt: string;
}

export class WorkspaceOwnershipGate {
  constructor(private readonly git = new GitClient()) {}

  async inspect(
    lease: WorkspaceLease,
    baseCommit: string,
    ownedPaths: readonly string[],
    forbiddenPaths: readonly string[],
    options: GitRunOptions = {},
  ): Promise<WorkspaceOwnershipReport> {
    const status = await this.run(lease.path, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ], options);
    const ignored = await this.run(lease.path, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
    ], options);
    const tracked = await this.run(lease.path, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      baseCommit,
      "--",
    ], options);
    const changedPaths = [...new Set([
      ...parseStatusPaths(status),
      ...nulFields(ignored.stdout),
      ...nulFields(tracked.stdout),
    ])].sort();
    const violations: OwnershipViolation[] = [];
    for (const changedPath of changedPaths) {
      if (forbiddenPaths.some((scope) => pathMatchesScope(changedPath, scope))) {
        violations.push({ path: changedPath, reason: "forbidden_scope" });
        continue;
      }
      if (!ownedPaths.some((scope) => pathMatchesScope(changedPath, scope))) {
        violations.push({ path: changedPath, reason: "outside_owned_scope" });
        continue;
      }
      if (isSymbolicLink(lease.path, changedPath)) {
        violations.push({ path: changedPath, reason: "symbolic_link" });
      }
    }
    const head = (await this.run(lease.path, ["rev-parse", "--verify", "HEAD^{commit}"], options)).stdout.trim();
    const branch = (await this.run(
      lease.path,
      ["rev-parse", "--verify", `refs/heads/${lease.branch}^{commit}`],
      options,
    )).stdout.trim();
    const symbolicHead = await this.git.run(
      lease.path,
      [...SAFE_GIT_ARGS, "symbolic-ref", "--quiet", "HEAD"],
      options,
    );
    if (
      symbolicHead.termination !== null ||
      symbolicHead.truncated ||
      (symbolicHead.exitCode !== 0 && symbolicHead.exitCode !== 1)
    ) {
      throw new Error("workspace ownership inspection failed for symbolic HEAD");
    }
    const registrations = await this.run(lease.path, ["worktree", "list", "--porcelain", "-z"], options);
    const exactRegistration = registrations.stdout.split("\0\0").filter(Boolean).filter((record) => {
      const fields = record.split("\0");
      return fields.includes(`worktree ${lease.path}`) &&
        fields.includes(`HEAD ${baseCommit}`) &&
        fields.includes(`branch refs/heads/${lease.branch}`);
    });
    if (
      head !== baseCommit ||
      branch !== baseCommit ||
      symbolicHead.exitCode !== 0 ||
      symbolicHead.stdout.trim() !== `refs/heads/${lease.branch}` ||
      exactRegistration.length !== 1
    ) {
      violations.push({ path: ".git", reason: "git_state_changed" });
    }
    return Object.freeze({
      outcome: violations.length === 0 ? "accepted" : "rejected",
      changedPaths: Object.freeze(changedPaths),
      violations: Object.freeze(violations),
      inspectedAt: new Date().toISOString(),
    });
  }

  async assertSafeBaseline(
    lease: WorkspaceLease,
    ownedPaths: readonly string[],
    options: GitRunOptions = {},
  ): Promise<void> {
    const entries = await this.run(lease.path, ["ls-files", "--stage", "-z", "--"], options);
    for (const entry of nulRawFields(entries.stdout)) {
      const match = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/.exec(entry);
      if (match === null) throw new Error("malformed Git index evidence");
      const mode = match[1]!;
      const entryPath = safePath(match[2]!);
      if (
        (mode === "120000" || mode === "160000") &&
        ownedPaths.some((scope) => scopeTraversesPath(scope, entryPath))
      ) {
        throw new Error(`writer owned scope contains an unsupported link or submodule: ${entryPath}`);
      }
    }
  }

  private async run(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions,
  ): Promise<Awaited<ReturnType<GitClient["run"]>>> {
    const result = await this.git.run(cwd, [...SAFE_GIT_ARGS, ...args], options);
    if (result.termination !== null || result.exitCode !== 0 || result.truncated) {
      throw new Error(`workspace ownership inspection failed for git ${args[0] ?? "read"}`);
    }
    return result;
  }
}

function parseStatusPaths(result: Awaited<ReturnType<GitClient["run"]>>): string[] {
  const fields = nulFields(result.stdout);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4 || field[2] !== " ") throw new Error("malformed Git status evidence");
    paths.push(safePath(field.slice(3)));
    if (field[0] === "R" || field[1] === "R" || field[0] === "C" || field[1] === "C") {
      const source = fields[index + 1];
      if (source === undefined) throw new Error("malformed Git rename evidence");
      paths.push(safePath(source));
      index += 1;
    }
  }
  return paths;
}

function nulFields(output: string): string[] {
  return nulRawFields(output).map(safePath);
}

function nulRawFields(output: string): string[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new Error("malformed NUL-delimited Git evidence");
  return output.slice(0, -1).split("\0");
}

function safePath(candidate: string): string {
  if (
    path.posix.isAbsolute(candidate) ||
    candidate.includes("\\") ||
    candidate.includes("\n") ||
    candidate.includes("\r") ||
    candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("unsafe repository-relative path in Git evidence");
  }
  return candidate;
}

function pathMatchesScope(candidate: string, scope: string): boolean {
  if (scope.endsWith("/**")) {
    const base = scope.slice(0, -3);
    return candidate === base || candidate.startsWith(`${base}/`);
  }
  return candidate === scope;
}

function scopeTraversesPath(scope: string, candidate: string): boolean {
  const recursive = scope.endsWith("/**");
  const base = recursive ? scope.slice(0, -3) : scope;
  return candidate === base ||
    base.startsWith(`${candidate}/`) ||
    (recursive && candidate.startsWith(`${base}/`));
}

function isSymbolicLink(workspace: string, candidate: string): boolean {
  let current = workspace;
  for (const segment of candidate.split("/")) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}
