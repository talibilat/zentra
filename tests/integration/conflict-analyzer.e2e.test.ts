import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ReadOnlyGitConflictAnalyzer } from "../../src/integration/conflict-analyzer.js";
import { GitClient } from "../../src/workspaces/git-client.js";

const git = new GitClient();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ReadOnlyGitConflictAnalyzer", () => {
  it("classifies conflict-free stale work and a real conflict without changing refs or worktrees", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-conflict-analyzer-"));
    roots.push(root);
    const repositoryInput = path.join(root, "repository");
    await ok(root, ["init", "-b", "main", repositoryInput]);
    const repository = realpathSync(repositoryInput);
    await ok(repository, ["config", "user.name", "Zentra Fixture"]);
    await ok(repository, ["config", "user.email", "fixture@zentra.local"]);
    writeFileSync(path.join(repository, "shared.txt"), "base\n");
    writeFileSync(path.join(repository, "binary.dat"), Buffer.from([0, 1, 2]));
    await ok(repository, ["add", "--", "shared.txt", "binary.dat"]);
    await ok(repository, ["commit", "-m", "base"]);
    const base = await ok(repository, ["rev-parse", "HEAD"]);

    await ok(repository, ["switch", "-c", "clean", base]);
    writeFileSync(path.join(repository, "clean.txt"), "clean\n");
    await ok(repository, ["add", "--", "clean.txt"]);
    await ok(repository, ["commit", "-m", "clean"]);
    const clean = await ok(repository, ["rev-parse", "HEAD"]);

    await ok(repository, ["switch", "-c", "conflict", base]);
    writeFileSync(path.join(repository, "shared.txt"), "source\n");
    writeFileSync(path.join(repository, "binary.dat"), Buffer.from([0, 3, 2]));
    await ok(repository, ["commit", "-am", "source"]);
    const conflict = await ok(repository, ["rev-parse", "HEAD"]);

    await ok(repository, ["switch", "main"]);
    writeFileSync(path.join(repository, "shared.txt"), "integration\n");
    writeFileSync(path.join(repository, "binary.dat"), Buffer.from([0, 4, 2]));
    await ok(repository, ["commit", "-am", "integration"]);
    const integration = await ok(repository, ["rev-parse", "HEAD"]);
    const refsBefore = await ok(repository, ["show-ref"]);
    const statusBefore = await ok(repository, ["status", "--porcelain=v1"]);

    const analyzer = new ReadOnlyGitConflictAnalyzer(git);
    await expect(analyzer.analyze({ repositoryPath: repository, baseCommit: base,
      integrationCommit: integration, sourceCommit: clean })).resolves.toMatchObject({
      classification: "conflict_free", conflictPaths: [],
    });
    await expect(analyzer.analyze({ repositoryPath: repository, baseCommit: base,
      integrationCommit: integration, sourceCommit: conflict })).resolves.toMatchObject({
      classification: "real_conflict", conflictPaths: ["binary.dat", "shared.txt"],
    });
    expect(await ok(repository, ["show-ref"])).toBe(refsBefore);
    expect(await ok(repository, ["status", "--porcelain=v1"])).toBe(statusBefore);
  });
});

async function ok(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
