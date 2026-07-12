import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../src/projects/project-config.js";
import { GitClient } from "../../src/workspaces/git-client.js";
import { WorktreeManager } from "../../src/workspaces/worktree-manager.js";

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
});
