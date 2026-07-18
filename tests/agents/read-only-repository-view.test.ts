import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createReadOnlyRepositoryView, createReadOnlyRepositoryViewAtCommit } from "../../src/agents/read-only-repository-view.js";
import { openCodeResourceIdentity } from "../../src/agents/opencode-resource-identity.js";
import { GitClient } from "../../src/workspaces/git-client.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createReadOnlyRepositoryView", () => {
  it("copies only planned readable paths and excludes forbidden and unrelated files", () => {
    const root = fixture();
    const view = createReadOnlyRepositoryView(root, ["src/**", "README.md"], ["src/private/**"], viewPath(root, 1));
    roots.push(view.path);

    expect(readFileSync(path.join(view.path, "src/public.ts"), "utf8")).toBe("public evidence\n");
    expect(readFileSync(path.join(view.path, "README.md"), "utf8")).toBe("read me\n");
    expect(existsSync(path.join(view.path, "src/private/secret.ts"))).toBe(false);
    expect(existsSync(path.join(view.path, ".env"))).toBe(false);
    expect(existsSync(path.join(view.path, "other.txt"))).toBe(false);
    expect(view).toMatchObject({
      readableScopes: ["src/**", "README.md"],
      forbiddenPaths: ["src/private/**"],
    });
    expect(view.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a selected symlink without reading or copying its external target", () => {
    const root = fixture();
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.txt`);
    writeFileSync(outside, "external secret\n");
    roots.push(outside);
    symlinkSync(outside, path.join(root, "src/escape.ts"));

    expect(() => createReadOnlyRepositoryView(root, ["src/**"], [], viewPath(root, 2))).toThrow("symbolic links");

    const outsideDirectory = path.join(path.dirname(root), `outside-${path.basename(root)}`);
    mkdirSync(outsideDirectory);
    writeFileSync(path.join(outsideDirectory, "nested.ts"), "nested external secret\n");
    roots.push(outsideDirectory);
    symlinkSync(outsideDirectory, path.join(root, "linked"));
    expect(() => createReadOnlyRepositoryView(root, ["linked/nested.ts"], [], viewPath(root, 3))).toThrow("symbolic links");
  });

  it("rejects unsafe, overlapping, and missing exact scopes", () => {
    const root = fixture();
    expect(() => createReadOnlyRepositoryView(root, ["../secret"], [], viewPath(root, 4))).toThrow();
    expect(() => createReadOnlyRepositoryView(root, ["src/**"], ["src/**"], viewPath(root, 5))).toThrow("overlaps");
    expect(() => createReadOnlyRepositoryView(root, ["missing.txt"], [], viewPath(root, 6))).toThrow("does not exist");
  });

  it("materializes immutable committed blobs despite checkout mutation and ref races", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-exact-read-view-")));
    roots.push(root);
    const git = new GitClient();
    await gitOk(git, root, ["init", "-b", "main"]);
    await gitOk(git, root, ["config", "user.name", "Zentra Test"]);
    await gitOk(git, root, ["config", "user.email", "test@zentra.local"]);
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/value.txt"), "committed bytes\n");
    await gitOk(git, root, ["add", "--", "."]);
    await gitOk(git, root, ["commit", "-m", "snapshot"]);
    const commit = (await git.run(root, ["rev-parse", "HEAD"])).stdout.trim();
    let raced = false;
    const racingGit = {
      run: async (cwd: string, args: readonly string[], options?: Parameters<GitClient["run"]>[2]) => {
        if (!raced && args[0] === "cat-file") {
          raced = true;
          writeFileSync(path.join(root, "src/value.txt"), "mutable checkout bytes\n");
          await gitOk(git, root, ["commit", "--allow-empty", "-m", "advanced ref"]);
        }
        return git.run(cwd, args, options);
      },
    } as GitClient;
    const view = await createReadOnlyRepositoryViewAtCommit(
      racingGit, root, commit, ["src/**"], [], viewPath(root, 7), AbortSignal.timeout(10_000),
    );
    roots.push(view.path);
    expect(readFileSync(path.join(view.path, "src/value.txt"), "utf8")).toBe("committed bytes\n");
    expect(view.revision).toBe(createHash("sha256").update(commit, "utf8").digest("hex"));
  });
});

async function gitOk(git: GitClient, cwd: string, args: readonly string[]): Promise<void> {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

function fixture(): string {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-read-view-source-")));
  roots.push(root);
  mkdirSync(path.join(root, "src/private"), { recursive: true });
  writeFileSync(path.join(root, "src/public.ts"), "public evidence\n");
  writeFileSync(path.join(root, "src/private/secret.ts"), "private\n");
  writeFileSync(path.join(root, "README.md"), "read me\n");
  writeFileSync(path.join(root, ".env"), "credential\n");
  writeFileSync(path.join(root, "other.txt"), "unrelated\n");
  return root;
}

function viewPath(root: string, attempt: number): string {
  return openCodeResourceIdentity(root, "view-test", attempt).repositoryViewPath;
}
