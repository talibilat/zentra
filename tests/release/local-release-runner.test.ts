import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { createLocalReleasePacket, LocalReleaseRunner } from "../../src/release/local-release-runner.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import type { ProjectConfig } from "../../src/projects/project-config.js";

const roots: string[] = [];
const GIT_HEAVY_TEST_TIMEOUT_MS = 15_000;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalReleaseRunner", () => {
  it("builds, packages, verifies, hashes artifacts, and leaves every ref unchanged", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-release-"));
    roots.push(root);
    const repository = path.join(root, "repository");
    const worktrees = path.join(root, "worktrees");
    execFileSync("mkdir", [repository, worktrees]);
    git(repository, "init", "-b", "main");
    git(repository, "config", "user.email", "fixture@example.test");
    git(repository, "config", "user.name", "Fixture");
    writeFileSync(path.join(repository, "input.txt"), "release input\n");
    writeFileSync(path.join(repository, "build.mjs"), script("build", "dist/build.txt"));
    writeFileSync(path.join(repository, "package.mjs"), script("package", "dist/package.tgz"));
    writeFileSync(path.join(repository, "verify.mjs"), `
      import { readFileSync, writeFileSync } from "node:fs";
      if (["PARENT_SECRET", "NPM_TOKEN", "SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN"].some((name) => process.env[name])) process.exit(9);
      if (!process.env.HOME?.includes(".release-release-1-environment/home")) process.exit(7);
      if (readFileSync("dist/package.tgz", "utf8") !== "package") process.exit(8);
      writeFileSync("verification.json", JSON.stringify({ verified: true }));
    `);
    git(repository, "add", ".");
    git(repository, "commit", "-m", "fixture");
    git(repository, "branch", "zentra/integration");
    git(repository, "tag", "existing");
    const commit = git(repository, "rev-parse", "HEAD").trim();
    const refsBefore = git(repository, "show-ref");
    process.env.PARENT_SECRET = "must-not-leak";
    process.env.NPM_TOKEN = "must-not-leak";
    process.env.SSH_AUTH_SOCK = "/must/not/leak";
    process.env.GH_TOKEN = "must-not-leak";
    process.env.GITHUB_TOKEN = "must-not-leak";
    const journal = new SqliteEventJournal(":memory:");
    const project = config(repository, worktrees);
    project.releasePreparation!.artifacts = ["dist/build.txt", "dist/package.tgz", "verification.json"];
    const releasePacket = await packet(project, commit, "release-1");

    const result = await new LocalReleaseRunner(journal).run({
      packet: releasePacket, project, signal: new AbortController().signal,
    });

    expect(result.status).toBe("prepared_local_only");
    expect(result.artifacts.map((item) => item.path)).toEqual(["dist/build.txt", "dist/package.tgz", "verification.json"]);
    expect(result.artifacts.every((item) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
    expect(result.steps.map((item) => item.name)).toEqual(["build", "package", "verify"]);
    expect(git(repository, "show-ref")).toBe(refsBefore);
    expect(journal.readStream("release:release-1").map((event) => event.type)).toContain("release.prepared_local_only");
    expect(journal.readAll().every((event) => event.type.startsWith("release."))).toBe(true);
    expect(result.authorityModel).toBe("trusted_project_config");
    expect(result.trustedProjectCodeNotice).toContain("not a filesystem or network sandbox");
    expect(readFileSync(path.join(result.worktreePath, "verification.json"), "utf8")).toContain("true");
    journal.close();
  }, GIT_HEAVY_TEST_TIMEOUT_MS);

  it("does not retry a started but unobserved command after restart", async () => {
    const fixture = releaseFixture();
    const journal = new SqliteEventJournal(":memory:");
    const releasePacket = await packet(fixture.project, fixture.commit, "release-uncertain");
    const packetDigest = digestCanonical(releasePacket);
    journal.append("release:release-uncertain", 0, [{
      streamId: "release:release-uncertain", type: "release.created",
      payload: { schemaVersion: 1, packet: releasePacket, packetDigest },
      causationId: null, correlationId: "m",
    }, {
      streamId: "release:release-uncertain", type: "release.step_started",
      payload: { schemaVersion: 1, name: "build", argvSha256: "b".repeat(64) },
      causationId: null, correlationId: "m",
    }]);

    const result = await new LocalReleaseRunner(journal).run({
      packet: releasePacket, project: fixture.project,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("uncertain");
    expect(journal.readStream("release:release-uncertain").filter((event) => event.type === "release.step_started")).toHaveLength(1);
    journal.close();
  }, GIT_HEAVY_TEST_TIMEOUT_MS);

  it("rejects changed release configuration after local success without new effects", async () => {
    const fixture = releaseFixture();
    const journal = new SqliteEventJournal(":memory:");
    const runner = new LocalReleaseRunner(journal);
    const releasePacket = await packet(fixture.project, fixture.commit, "immutable-release");
    const request = {
      packet: releasePacket, project: fixture.project, signal: new AbortController().signal,
    };
    expect((await runner.run(request)).status).toBe("prepared_local_only");
    const before = journal.readStream("release:immutable-release");
    const changed = {
      ...fixture.project,
      releasePreparation: { ...fixture.project.releasePreparation!, verify: [process.execPath, "changed.mjs"] as [string, ...string[]] },
    };

    await expect(runner.run({ ...request, project: changed })).rejects.toThrow(/packet|configuration/i);
    expect(journal.readStream("release:immutable-release")).toEqual(before);
    journal.close();
  }, GIT_HEAVY_TEST_TIMEOUT_MS);

  it.each(["symlink", "oversize"] as const)("rejects an unsafe %s artifact and preserves the worktree", async (kind) => {
    const fixture = unsafeArtifactFixture(kind);
    const journal = new SqliteEventJournal(":memory:");
    const releasePacket = await packet(fixture.project, fixture.commit, `unsafe-${kind}`);

    const result = await new LocalReleaseRunner(journal).run({
      packet: releasePacket, project: fixture.project, signal: new AbortController().signal,
    });

    expect(result.status).toBe("failed");
    expect(readFileSync(path.join(result.worktreePath, "build.mjs"), "utf8")).toContain("writeFileSync");
    expect(journal.readStream(`release:unsafe-${kind}`).at(-1)?.type).toBe("release.failed");
    journal.close();
  }, GIT_HEAVY_TEST_TIMEOUT_MS);

  it("rejects replacement refs and configured checkout filters before worktree creation", async () => {
    for (const unsafe of ["replace", "filter"] as const) {
      const fixture = releaseFixture();
      if (unsafe === "replace") git(fixture.project.repositoryPath, "replace", fixture.commit, fixture.commit);
      else git(fixture.project.repositoryPath, "config", "filter.evil.smudge", "/bin/false");
      const journal = new SqliteEventJournal(":memory:");
      const releasePacket = await packet(fixture.project, fixture.commit, `unsafe-${unsafe}`);

      await expect(new LocalReleaseRunner(journal).run({
        packet: releasePacket, project: fixture.project, signal: new AbortController().signal,
      })).rejects.toThrow(/replacement|external Git programs/);
      expect(journal.readStream(`release:unsafe-${unsafe}`).some((event) => event.type === "release.worktree_intent")).toBe(false);
      journal.close();
    }
  }, GIT_HEAVY_TEST_TIMEOUT_MS);
});

function releaseFixture(): { project: ProjectConfig; commit: string } {
  const root = mkdtempSync(path.join(tmpdir(), "zentra-release-replay-"));
  roots.push(root);
  const repository = path.join(root, "repository");
  const worktrees = path.join(root, "worktrees");
  execFileSync("mkdir", [repository, worktrees]);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "fixture@example.test");
  git(repository, "config", "user.name", "Fixture");
  writeFileSync(path.join(repository, "build.mjs"), script("build", "dist/build.txt"));
  writeFileSync(path.join(repository, "package.mjs"), script("package", "dist/package.tgz"));
  writeFileSync(path.join(repository, "verify.mjs"), script("verify", "verification.json"));
  git(repository, "add", ".");
  git(repository, "commit", "-m", "fixture");
  git(repository, "branch", "zentra/integration");
  const project = config(repository, worktrees);
  project.releasePreparation!.artifacts = ["dist/build.txt", "dist/package.tgz", "verification.json"];
  return { project, commit: git(repository, "rev-parse", "HEAD").trim() };
}

function unsafeArtifactFixture(kind: "symlink" | "oversize"): { project: ProjectConfig; commit: string } {
  const fixture = releaseFixture();
  const repository = fixture.project.repositoryPath;
  writeFileSync(path.join(repository, "package.mjs"), kind === "symlink"
    ? `import { mkdirSync, symlinkSync } from "node:fs"; mkdirSync("dist", { recursive: true }); symlinkSync("../build.mjs", "dist/package.tgz");`
    : `import { mkdirSync, openSync, closeSync, ftruncateSync } from "node:fs"; mkdirSync("dist", { recursive: true }); const fd = openSync("dist/package.tgz", "w"); ftruncateSync(fd, ${64 * 1024 * 1024 + 1}); closeSync(fd);`);
  git(repository, "add", "package.mjs");
  git(repository, "commit", "-m", `unsafe ${kind}`);
  git(repository, "branch", "-f", "zentra/integration", "HEAD");
  return { project: fixture.project, commit: git(repository, "rev-parse", "HEAD").trim() };
}

async function packet(project: ProjectConfig, resultCommit: string, releaseId: string) {
  return createLocalReleasePacket({
    releaseId, milestoneId: "milestone-1", taskId: "verify-release", project, resultCommit,
    securityDigest: "a".repeat(64), authorityDigest: "b".repeat(64), verifierAdmissionDigest: "c".repeat(64),
  });
}

function config(repositoryPath: string, worktreeRoot: string): ProjectConfig {
  return {
    projectId: "p", repositoryPath, worktreeRoot, integrationBranch: "zentra/integration",
    validations: { focused: [process.execPath], full: [process.execPath], focusedTimeoutMs: 1_000, fullTimeoutMs: 1_000 },
    releasePreparation: {
      build: [process.execPath, "build.mjs"], package: [process.execPath, "package.mjs"], verify: [process.execPath, "verify.mjs"],
      buildTimeoutMs: 5_000, packageTimeoutMs: 5_000, verifyTimeoutMs: 5_000,
      artifacts: ["dist/package.tgz", "verification.json"],
    },
  };
}

function script(content: string, output: string): string {
  return `import { mkdirSync, writeFileSync } from "node:fs"; import path from "node:path"; mkdirSync(path.dirname(${JSON.stringify(output)}), { recursive: true }); writeFileSync(${JSON.stringify(output)}, ${JSON.stringify(content)});`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
