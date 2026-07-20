import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { GitAnalysisRepositorySnapshotProvider } from "../../src/analysis/analysis-repository-snapshot.js";
import { openCodeResourceIdentity } from "../../src/agents/opencode-resource-identity.js";
import { requestFixture } from "./test-fixtures.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("GitAnalysisRepositorySnapshotProvider", () => {
  it("mounts only a measured commit snapshot and a content-addressed source bundle", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-analysis-repo-")));
    roots.push(repository);
    mkdirSync(path.join(repository, "src"));
    writeFileSync(path.join(repository, "src", "index.ts"), "export const safe = true;\n");
    writeFileSync(path.join(repository, "secret.env"), "SECRET=forbidden\n");
    execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repository });
    execFileSync("/usr/bin/git", ["config", "user.name", "Fixture"], { cwd: repository });
    execFileSync("/usr/bin/git", ["config", "user.email", "fixture@example.test"], { cwd: repository });
    execFileSync("/usr/bin/git", ["add", "src/index.ts", "secret.env"], { cwd: repository });
    execFileSync("/usr/bin/git", ["commit", "-qm", "fixture"], { cwd: repository });
    mkdirSync(path.join(repository, ".zentra"));
    writeFileSync(path.join(repository, ".zentra", "runtime-secret"), "hidden");
    const commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const text = "x".repeat(70 * 1024);
    const sha256 = createHash("sha256").update(text).digest("hex");
    const request = {
      ...requestFixture(), runId: `run-${randomUUID()}`, projectRevision: { objectFormat: "sha1" as const, commit },
      sources: [
        { ...requestFixture().sources[0]!, sourceId: `source-v1:${"a".repeat(64)}`, artifactId: `intake-text-v1:${sha256}`, sha256, normalizedContentSha256: sha256, quotedText: text, sizeBytes: Buffer.byteLength(text) },
        { ...requestFixture().sources[0]!, sourceId: `source-v1:${"b".repeat(64)}`, relativePath: "duplicate.txt", artifactId: `intake-text-v1:${sha256}`, sha256, normalizedContentSha256: sha256, quotedText: text, sizeBytes: Buffer.byteLength(text) },
      ],
    };
    const prepared = await new GitAnalysisRepositorySnapshotProvider(repository, ["src/**", "secret.env"], ["secret.env"])
      .prepare(request, new AbortController().signal, { remainingDurationMs: () => 5_000 });
    expect(prepared.view.path).not.toBe(repository);
    expect(prepared.view.revision).toBe(createHash("sha256").update(commit).digest("hex"));
    expect(existsSync(path.join(prepared.view.path, ".git"))).toBe(false);
    expect(existsSync(path.join(prepared.view.path, ".zentra"))).toBe(false);
    expect(existsSync(path.join(prepared.view.path, "secret.env"))).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(prepared.view.path, ".analysis-sources/manifest.json"), "utf8"));
    expect(manifest).toHaveLength(2);
    expect(manifest[0].path).not.toBe(manifest[1].path);
    expect(readFileSync(path.join(prepared.view.path, manifest[0].path), "utf8")).toBe(text);
    expect(readFileSync(path.join(prepared.view.path, manifest[1].path), "utf8")).toBe(text);
    expect(prepared.sourceBundleSha256).toMatch(/^[a-f0-9]{64}$/);
    prepared.release();
  });

  it("removes the snapshot and partial bundle when a source write fails", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-analysis-failure-")));
    roots.push(repository);
    mkdirSync(path.join(repository, "src"));
    writeFileSync(path.join(repository, "src", "index.ts"), "safe\n");
    execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repository });
    execFileSync("/usr/bin/git", ["config", "user.name", "Fixture"], { cwd: repository });
    execFileSync("/usr/bin/git", ["config", "user.email", "fixture@example.test"], { cwd: repository });
    execFileSync("/usr/bin/git", ["add", "src/index.ts"], { cwd: repository });
    execFileSync("/usr/bin/git", ["commit", "-qm", "fixture"], { cwd: repository });
    const commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const request = { ...requestFixture(), runId: `run-${randomUUID()}`, projectRevision: { objectFormat: "sha1" as const, commit },
      sources: [requestFixture().sources[0]!, { ...requestFixture().sources[0]!, sourceId: `source-v1:${"c".repeat(64)}`, relativePath: "second.txt" }] };
    const expectedPath = openCodeResourceIdentity("analysis", `${request.runId}-${request.round}`, 1).repositoryViewPath;
    const provider = new GitAnalysisRepositorySnapshotProvider(repository, ["src/**"], [], {
      beforeSourceWrite: (_sourceId, index) => { if (index === 1) throw new Error("injected source write failure"); },
    });
    await expect(provider.prepare(request, new AbortController().signal, { remainingDurationMs: () => 5_000 }))
      .rejects.toThrow("injected source write failure");
    expect(existsSync(expectedPath)).toBe(false);
  });

  it("times out a large streamed source in bounded time and removes the partial snapshot", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-analysis-timeout-")));
    roots.push(repository);
    mkdirSync(path.join(repository, "src"));
    writeFileSync(path.join(repository, "src", "index.ts"), "safe\n");
    execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repository });
    execFileSync("/usr/bin/git", ["config", "user.name", "Fixture"], { cwd: repository });
    execFileSync("/usr/bin/git", ["config", "user.email", "fixture@example.test"], { cwd: repository });
    execFileSync("/usr/bin/git", ["add", "src/index.ts"], { cwd: repository });
    execFileSync("/usr/bin/git", ["commit", "-qm", "fixture"], { cwd: repository });
    const commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const text = "y".repeat(8 * 1024 * 1024);
    const sha256 = createHash("sha256").update(text).digest("hex");
    const request = { ...requestFixture(), runId: `run-${randomUUID()}`, projectRevision: { objectFormat: "sha1" as const, commit },
      sourceByteBudget: 16 * 1024 * 1024,
      sources: [{ ...requestFixture().sources[0]!, artifactId: `intake-text-v1:${sha256}`, sha256,
        normalizedContentSha256: sha256, quotedText: text, sizeBytes: Buffer.byteLength(text) }] };
    const expectedPath = openCodeResourceIdentity("analysis", `${request.runId}-${request.round}`, 1).repositoryViewPath;
    let deadline = process.hrtime.bigint() + 5_000_000_000n;
    let bundleStarted = false;
    const provider = new GitAnalysisRepositorySnapshotProvider(repository, ["src/**"], [], {
      beforeSourceWrite: () => {
        bundleStarted = true;
        deadline = process.hrtime.bigint() + 5_000_000n;
      },
    });
    const started = performance.now();
    await expect(provider.prepare(request, new AbortController().signal, {
      remainingDurationMs: () => Number((deadline - process.hrtime.bigint()) / 1_000_000n),
    })).rejects.toThrow(/deadline exhausted/);
    expect(bundleStarted).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(existsSync(expectedPath)).toBe(false);
  });
});
