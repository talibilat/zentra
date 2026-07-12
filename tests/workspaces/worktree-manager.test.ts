import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../src/projects/project-config.js";
import {
  GitClient,
  type CommandResult,
  type GitRunOptions,
} from "../../src/workspaces/git-client.js";
import {
  WorkspaceCommitUncertainError,
  WorkspaceGitTerminationError,
  WorktreeManager,
} from "../../src/workspaces/worktree-manager.js";

const git = new GitClient();

async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function terminatedGitResult(
  termination: "cancelled" | "timed_out",
): CommandResult {
  return {
    stdout: "",
    stderr: `Git ${termination}`,
    exitCode: -1,
    truncated: false,
    termination,
  };
}

describe("WorktreeManager", () => {
  let baseDir: string;
  let repoPath: string;
  let worktreeRoot: string;
  let project: ProjectConfig;
  const manager = new WorktreeManager();

  beforeEach(async () => {
    baseDir = mkdtempSync(path.join(tmpdir(), "zentra-worktree-"));
    repoPath = path.join(baseDir, "repository");
    worktreeRoot = path.join(baseDir, "worktrees");

    await gitOk(baseDir, ["init", "-b", "main", repoPath]);
    // Repo-local identity so commits never depend on global configuration.
    await gitOk(repoPath, ["config", "user.name", "Zentra Fixture"]);
    await gitOk(repoPath, ["config", "user.email", "fixture@zentra.local"]);
    writeFileSync(path.join(repoPath, "README.md"), "# fixture\n", "utf8");
    await gitOk(repoPath, ["add", "--", "README.md"]);
    await gitOk(repoPath, ["commit", "-m", "initial commit"]);

    project = {
      projectId: "fixture-project",
      repositoryPath: repoPath,
      integrationBranch: "zentra/integration",
      worktreeRoot,
      validations: {
        focused: ["node", "--test", "test/greeting.test.mjs"],
        full: ["node", "--test"],
      },
    };
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("configures a repo-local git identity in the fixture repository", async () => {
    const name = await gitOk(repoPath, ["config", "--local", "user.name"]);
    const email = await gitOk(repoPath, ["config", "--local", "user.email"]);
    expect(name.trim()).toBe("Zentra Fixture");
    expect(email.trim()).toBe("fixture@zentra.local");
  });

  it("creates the integration branch and is idempotent", async () => {
    await manager.ensureIntegrationBranch(project);
    await manager.ensureIntegrationBranch(project);

    const output = await gitOk(repoPath, [
      "rev-parse",
      "--verify",
      "zentra/integration",
    ]);
    expect(output.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("creates ticket/<taskId> as a worktree from the integration branch", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-001");

    expect(lease.taskId).toBe("task-001");
    expect(lease.branch).toBe("ticket/task-001");
    expect(lease.path.startsWith(worktreeRoot)).toBe(true);
    expect(existsSync(lease.path)).toBe(true);

    const branch = await gitOk(lease.path, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    expect(branch.trim()).toBe("ticket/task-001");

    const head = await gitOk(lease.path, ["rev-parse", "HEAD"]);
    const integrationHead = await gitOk(repoPath, [
      "rev-parse",
      "zentra/integration",
    ]);
    expect(head.trim()).toBe(integrationHead.trim());
  });

  it("rejects an existing dirty worktree path", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-002");
    writeFileSync(path.join(lease.path, "scratch.txt"), "dirty\n", "utf8");

    await expect(manager.create(project, "task-002")).rejects.toThrow(/dirty/i);
  });

  it("inspects a workspace for dirtiness and produces a diff", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-003");

    const clean = await manager.inspect(lease);
    expect(clean.dirty).toBe(false);
    expect(clean.diff).toBe("");

    writeFileSync(path.join(lease.path, "feature.txt"), "feature\n", "utf8");
    const dirty = await manager.inspect(lease);
    expect(dirty.dirty).toBe(true);
    expect(dirty.diff).toContain("feature.txt");
  });

  it("fails closed for a configured external diff program", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-no-external-diff");
    const marker = path.join(baseDir, "external-diff-ran");
    const executable = path.join(baseDir, "external-diff.js");
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")\n`,
    );
    chmodSync(executable, 0o755);
    await gitOk(repoPath, ["config", "diff.external", executable]);
    writeFileSync(path.join(lease.path, "README.md"), "changed\n", "utf8");

    await expect(manager.inspect(lease)).rejects.toThrow(/external|program|config/i);
    expect(existsSync(marker)).toBe(false);
  });

  it("disables post-checkout hooks during worktree creation", async () => {
    const marker = path.join(baseDir, "post-checkout-ran");
    const hook = path.join(repoPath, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, "utf8");
    chmodSync(hook, 0o755);
    await manager.ensureIntegrationBranch(project);

    await manager.create(project, "task-no-checkout-hook");

    expect(existsSync(marker)).toBe(false);
  });

  it.each(["clean", "smudge", "process"])(
    "fails closed for a configured %s filter before worktree creation",
    async (operation) => {
      const marker = path.join(baseDir, `filter-${operation}-ran`);
      const executable = path.join(baseDir, `filter-${operation}.js`);
      writeFileSync(
        executable,
        `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")\n`,
      );
      chmodSync(executable, 0o755);
      await gitOk(repoPath, ["config", `filter.evil.${operation}`, executable]);

      await expect(manager.create(project, `task-filter-${operation}`)).rejects.toThrow(
        /external|program|config/i,
      );
      expect(existsSync(worktreeRoot)).toBe(false);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("disables configured fsmonitor on setup, status, diff, and add", async () => {
    const marker = path.join(baseDir, "fsmonitor-ran");
    const executable = path.join(baseDir, "fsmonitor.js");
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")\n`,
    );
    chmodSync(executable, 0o755);
    await gitOk(repoPath, ["config", "core.fsmonitor", executable]);

    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-no-fsmonitor");
    writeFileSync(path.join(lease.path, "README.md"), "changed\n");
    await manager.inspect(lease);

    expect(existsSync(marker)).toBe(false);
  });

  it("commits only explicitly reviewed relative paths", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-004");
    writeFileSync(path.join(lease.path, "approved.txt"), "approved\n", "utf8");
    writeFileSync(path.join(lease.path, "rejected.txt"), "rejected\n", "utf8");

    const { diff } = await manager.inspect(lease);
    const commitHash = await manager.commit(
      lease,
      ["approved.txt"],
      "feat: approved change",
      sha256(diff),
    );
    expect(commitHash).toMatch(/^[0-9a-f]{40}$/);

    const committed = await gitOk(lease.path, [
      "show",
      "--name-only",
      "--pretty=format:",
      commitHash,
    ]);
    expect(committed).toContain("approved.txt");
    expect(committed).not.toContain("rejected.txt");

    const status = await gitOk(lease.path, ["status", "--porcelain"]);
    expect(status).toContain("rejected.txt");
    expect(status).not.toContain("approved.txt");
  });

  it("rejects a pre-existing staged diff before inspection", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-staged-inspect");
    writeFileSync(path.join(lease.path, "staged.txt"), "staged\n", "utf8");
    await gitOk(lease.path, ["add", "--", "staged.txt"]);

    await expect(manager.inspect(lease)).rejects.toThrow(/staged/i);
  });

  it("cannot include an unrelated staged path in a reviewed commit", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-staged-commit");
    const originalHead = (await gitOk(lease.path, ["rev-parse", "HEAD"])).trim();
    writeFileSync(path.join(lease.path, "approved.txt"), "approved\n", "utf8");
    const { diff } = await manager.inspect(lease);
    writeFileSync(path.join(lease.path, "unreviewed.txt"), "unreviewed\n", "utf8");
    await gitOk(lease.path, ["add", "--", "unreviewed.txt"]);

    await expect(
      manager.commit(lease, ["approved.txt"], "feat: approved", sha256(diff)),
    ).rejects.toThrow(/staged/i);
    expect((await gitOk(lease.path, ["rev-parse", "HEAD"])).trim()).toBe(originalHead);
  });

  it("disables commit hooks while committing reviewed paths", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-no-commit-hook");
    const hookPath = path.join(lease.path, ".git-hooks", "pre-commit");
    const marker = path.join(baseDir, "commit-hook-ran");
    mkdirSync(path.dirname(hookPath), { recursive: true });
    writeFileSync(hookPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, "utf8");
    chmodSync(hookPath, 0o755);
    await gitOk(lease.path, ["config", "core.hooksPath", ".git-hooks"]);
    writeFileSync(path.join(lease.path, "approved.txt"), "approved\n", "utf8");
    const { diff } = await manager.inspect(lease);

    await expect(
      manager.commit(lease, ["approved.txt"], "feat: approved", sha256(diff)),
    ).resolves.toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(marker)).toBe(false);
  });

  it("maps a pre-aborted bounded commit to a typed cancellation without committing", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-aborted-commit");
    const originalHead = (await gitOk(lease.path, ["rev-parse", "HEAD"])).trim();
    writeFileSync(path.join(lease.path, "approved.txt"), "approved\n", "utf8");
    const { diff } = await manager.inspect(lease);
    const controller = new AbortController();
    controller.abort();

    await expect(
      manager.commit(
        lease,
        ["approved.txt"],
        "feat: approved",
        sha256(diff),
        { signal: controller.signal, timeoutMs: 5_000 },
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<WorkspaceGitTerminationError>>({
      name: "WorkspaceGitTerminationError",
      outcome: "cancelled",
    }));
    expect((await gitOk(lease.path, ["rev-parse", "HEAD"])).trim()).toBe(originalHead);
  });

  it("maps a bounded Git timeout to a typed timeout without retrying", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-timeout-commit");
    writeFileSync(path.join(lease.path, "approved.txt"), "approved\n", "utf8");
    const { diff } = await manager.inspect(lease);
    let calls = 0;
    let receivedTimeout: number | undefined;
    class TimingOutGitClient extends GitClient {
      override run(
        _cwd: string,
        _args: readonly string[],
        options: GitRunOptions = {},
      ): Promise<CommandResult> {
        calls += 1;
        receivedTimeout = options.timeoutMs;
        return Promise.resolve({
          stdout: "",
          stderr: "timed out",
          exitCode: -1,
          truncated: false,
          termination: "timed_out",
        });
      }
    }

    await expect(
      new WorktreeManager(new TimingOutGitClient()).commit(
        lease,
        ["approved.txt"],
        "feat: approved",
        sha256(diff),
        { timeoutMs: 25 },
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<WorkspaceGitTerminationError>>({
      outcome: "timed_out",
    }));
    expect(calls).toBe(1);
    expect(receivedTimeout).toBe(25);
  });

  it.each(["before", "after", "post-revparse"] as const)(
    "reconciles a final commit timeout %s the acknowledgement",
    async (timing) => {
      await manager.ensureIntegrationBranch(project);
      const lease = await manager.create(project, `task-commit-${timing}`);
      writeFileSync(path.join(lease.path, "approved.txt"), "approved\n", "utf8");
      const { diff } = await manager.inspect(lease);
      let commitSeen = false;
      let timedPostRead = false;
      let commitSignal: AbortSignal | undefined;
      class AmbiguousGitClient extends GitClient {
        override async run(
          cwd: string,
          args: readonly string[],
          options: GitRunOptions = {},
        ): Promise<CommandResult> {
          if (args.includes("commit")) {
            commitSignal = options.signal;
            commitSeen = true;
            if (timing === "before") return terminatedGitResult("timed_out");
            const completed = await super.run(cwd, args, options);
            if (timing === "after") {
              return { ...completed, exitCode: -1, termination: "timed_out" };
            }
            return completed;
          }
          if (
            timing === "post-revparse" &&
            commitSeen &&
            !timedPostRead &&
            args[0] === "rev-parse" &&
            args[1] === "HEAD"
          ) {
            timedPostRead = true;
            return terminatedGitResult("timed_out");
          }
          return super.run(cwd, args, options);
        }
      }
      const bounded = new WorktreeManager(new AmbiguousGitClient());

      const pending = bounded.commit(
        lease,
        ["approved.txt"],
        "feat: approved",
        sha256(diff),
        { signal: new AbortController().signal, timeoutMs: 5_000 },
      );

      if (timing === "before") {
        await expect(pending).rejects.toEqual(
          expect.objectContaining<Partial<WorkspaceGitTerminationError>>({
            outcome: "timed_out",
          }),
        );
      } else {
        await expect(pending).resolves.toMatch(/^[0-9a-f]{40}$/);
      }
      expect(commitSignal).toBeUndefined();
    },
  );

  it("reports an uncertain commit when reconciliation finds an unexpected tree", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-commit-uncertain");
    writeFileSync(path.join(lease.path, "approved.txt"), "approved\n", "utf8");
    const { diff } = await manager.inspect(lease);
    class UnexpectedCommitGitClient extends GitClient {
      override async run(
        cwd: string,
        args: readonly string[],
        options: GitRunOptions = {},
      ): Promise<CommandResult> {
        if (args.includes("commit")) {
          const completed = await super.run(cwd, args, options);
          writeFileSync(path.join(cwd, "unexpected.txt"), "unexpected\n");
          await super.run(cwd, ["add", "--", "unexpected.txt"]);
          await super.run(cwd, ["-c", "core.hooksPath=/dev/null", "commit", "-m", "unexpected"]);
          return { ...completed, exitCode: -1, termination: "timed_out" };
        }
        return super.run(cwd, args, options);
      }
    }

    await expect(
      new WorktreeManager(new UnexpectedCommitGitClient()).commit(
        lease,
        ["approved.txt"],
        "feat: approved",
        sha256(diff),
        { timeoutMs: 5_000 },
      ),
    ).rejects.toBeInstanceOf(WorkspaceCommitUncertainError);
  });

  it("rejects truncated changed-path evidence before commit", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-truncated-paths");
    writeFileSync(path.join(lease.path, "approved.txt"), "approved\n", "utf8");
    const { diff } = await manager.inspect(lease);
    class TruncatedPathsGitClient extends GitClient {
      override async run(
        cwd: string,
        args: readonly string[],
        options: GitRunOptions = {},
      ): Promise<CommandResult> {
        const result = await super.run(cwd, args, options);
        return args.includes("--name-only") ? { ...result, truncated: true } : result;
      }
    }

    await expect(
      new WorktreeManager(new TruncatedPathsGitClient()).commit(
        lease,
        ["approved.txt"],
        "feat: approved",
        sha256(diff),
      ),
    ).rejects.toThrow(/truncat/i);
  });

  it("rejects an empty path list", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-005");
    writeFileSync(path.join(lease.path, "a.txt"), "a\n", "utf8");
    const { diff } = await manager.inspect(lease);

    await expect(
      manager.commit(lease, [], "feat: nothing", sha256(diff)),
    ).rejects.toThrow(/empty/i);
  });

  it("rejects absolute paths and path traversal", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-006");
    writeFileSync(path.join(lease.path, "a.txt"), "a\n", "utf8");
    const { diff } = await manager.inspect(lease);
    const digest = sha256(diff);

    await expect(
      manager.commit(lease, ["/etc/passwd"], "feat: bad", digest),
    ).rejects.toThrow(/absolute/i);
    await expect(
      manager.commit(lease, ["../outside.txt"], "feat: bad", digest),
    ).rejects.toThrow(/traversal/i);
    await expect(
      manager.commit(lease, ["nested/../../outside.txt"], "feat: bad", digest),
    ).rejects.toThrow(/traversal/i);
  });

  it("rejects a path that is not present in the current diff", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-007");
    writeFileSync(path.join(lease.path, "a.txt"), "a\n", "utf8");
    const { diff } = await manager.inspect(lease);

    await expect(
      manager.commit(lease, ["absent.txt"], "feat: bad", sha256(diff)),
    ).rejects.toThrow(/absent\.txt/);
  });

  it("rejects a diff digest mismatch", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-008");
    writeFileSync(path.join(lease.path, "a.txt"), "a\n", "utf8");

    await expect(
      manager.commit(lease, ["a.txt"], "feat: stale", sha256("stale diff")),
    ).rejects.toThrow(/sha-?256|digest/i);
  });

  it("preserves a failed dirty worktree on remove", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-009");
    writeFileSync(path.join(lease.path, "failed.txt"), "failure\n", "utf8");

    await manager.remove(project, lease);

    expect(existsSync(lease.path)).toBe(true);
    expect(existsSync(path.join(lease.path, "failed.txt"))).toBe(true);
  });

  it("digests binary file contents, not just a binary marker", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-011");
    const binaryPath = path.join(lease.path, "blob.bin");

    writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const first = await manager.inspect(lease);
    expect(first.diff).toContain("GIT binary patch");

    writeFileSync(binaryPath, Buffer.from([0xff, 0xfe, 0xfd, 0xfc]));
    const second = await manager.inspect(lease);

    // Two different binary payloads must never hash to the same digest.
    expect(sha256(first.diff)).not.toBe(sha256(second.diff));

    // inspect() and commit() must agree on the diff command.
    const commitHash = await manager.commit(
      lease,
      ["blob.bin"],
      "feat: binary blob",
      sha256(second.diff),
    );
    expect(commitHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses to digest a truncated diff", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-012");
    // 2 MiB of new content exceeds the 1 MiB capture limit for diff output.
    const line = "x".repeat(1023) + "\n";
    writeFileSync(path.join(lease.path, "big.txt"), line.repeat(2048), "utf8");

    await expect(manager.inspect(lease)).rejects.toThrow(/truncat/i);
  });

  it("reports truncation on CommandResult and false for small output", async () => {
    const small = await git.run(repoPath, ["status", "--porcelain"]);
    expect(small.truncated).toBe(false);
  });

  it("commits files with non-ASCII names and ./-prefixed paths", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-013");
    writeFileSync(path.join(lease.path, "héllo.txt"), "bonjour\n", "utf8");
    writeFileSync(path.join(lease.path, "a.txt"), "a\n", "utf8");

    const { diff } = await manager.inspect(lease);
    const commitHash = await manager.commit(
      lease,
      ["héllo.txt", "./a.txt"],
      "feat: unicode and dot-relative paths",
      sha256(diff),
    );
    expect(commitHash).toMatch(/^[0-9a-f]{40}$/);

    const committed = await gitOk(lease.path, [
      "-c",
      "core.quotepath=off",
      "show",
      "--name-only",
      "--pretty=format:",
      commitHash,
    ]);
    expect(committed).toContain("héllo.txt");
    expect(committed).toContain("a.txt");
  });

  it("does not mutate the index of a preserved dirty worktree on remove", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-014");
    writeFileSync(path.join(lease.path, "failed.txt"), "failure\n", "utf8");

    await manager.remove(project, lease);

    expect(existsSync(lease.path)).toBe(true);
    // remove() must decide dirtiness from status alone; the untracked file
    // must not have been registered as intent-to-add in the index.
    const indexed = await gitOk(lease.path, ["ls-files"]);
    expect(indexed).not.toContain("failed.txt");
  });

  it("removes a completed clean worktree", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-010");
    writeFileSync(path.join(lease.path, "done.txt"), "done\n", "utf8");
    const { diff } = await manager.inspect(lease);
    await manager.commit(lease, ["done.txt"], "feat: done", sha256(diff));

    await manager.remove(project, lease);

    expect(existsSync(lease.path)).toBe(false);
  });

  it("cleans an exact completed ticket worktree and deletes its branch with CAS", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-cleanup-completed");
    writeFileSync(path.join(lease.path, "done.txt"), "done\n", "utf8");
    const { diff } = await manager.inspect(lease);
    const sourceCommit = await manager.commit(
      lease,
      ["done.txt"],
      "feat: done",
      sha256(diff),
    );

    await manager.cleanupCompleted(project, lease, sourceCommit, { timeoutMs: 10_000 });

    expect(existsSync(lease.path)).toBe(false);
    const listed = await git.run(repoPath, ["worktree", "list", "--porcelain"]);
    expect(listed.stdout).not.toContain(lease.path);
    const branch = await git.run(repoPath, ["show-ref", "--verify", `refs/heads/${lease.branch}`]);
    expect(branch.exitCode).not.toBe(0);
  });

  it("types cleanup configuration preflight failures with phase evidence", async () => {
    await manager.ensureIntegrationBranch(project);
    const lease = await manager.create(project, "task-cleanup-preflight");
    const sourceCommit = (await gitOk(lease.path, ["rev-parse", "HEAD"])).trim();
    await gitOk(repoPath, ["config", "diff.external", "/untrusted/program"]);

    await expect(
      manager.cleanupCompleted(project, lease, sourceCommit, { timeoutMs: 10_000 }),
    ).rejects.toMatchObject({
      name: "WorkspaceCleanupError",
      phase: "verification",
      uncertain: false,
      evidence: { taskId: lease.taskId, sourceCommit },
    });
    expect(existsSync(lease.path)).toBe(true);
  });

  it.each(["worktree_removal", "ref_deletion"] as const)(
    "types a nonzero %s result as uncertain without retry",
    async (failedPhase) => {
      await manager.ensureIntegrationBranch(project);
      const lease = await manager.create(project, `task-cleanup-${failedPhase}`);
      const sourceCommit = (await gitOk(lease.path, ["rev-parse", "HEAD"])).trim();
      let effectCalls = 0;
      class NonzeroCleanupGitClient extends GitClient {
        override run(
          cwd: string,
          args: readonly string[],
          options: GitRunOptions = {},
        ): Promise<CommandResult> {
          const phase = args.includes("worktree") && args.includes("remove")
            ? "worktree_removal"
            : args.includes("update-ref") && args.includes("-d")
              ? "ref_deletion"
              : null;
          if (phase === failedPhase) {
            effectCalls += 1;
            return Promise.resolve({
              stdout: "",
              stderr: "result unavailable",
              exitCode: 1,
              truncated: false,
              termination: null,
            });
          }
          return super.run(cwd, args, options);
        }
      }

      await expect(
        new WorktreeManager(new NonzeroCleanupGitClient()).cleanupCompleted(
          project,
          lease,
          sourceCommit,
          { timeoutMs: 10_000 },
        ),
      ).rejects.toMatchObject({
        name: "WorkspaceCleanupError",
        phase: failedPhase,
        uncertain: true,
        evidence: { taskId: lease.taskId, sourceCommit },
      });
      expect(effectCalls).toBe(1);
    },
  );
});
