import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "../../src/workspaces/git-client.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readyChildAlias(ready: string, forbidden: string): readonly string[] {
  const script = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(ready)},"ready");setTimeout(()=>fs.writeFileSync(${JSON.stringify(forbidden)},"ran"),10000)`;
  return ["-c", `alias.wait=!${process.execPath} -e '${script}'`, "wait"];
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("GitClient bounded execution", () => {
  it("ignores ambient global Git configuration while retaining repository-local config", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-git-config-"));
    const repository = path.join(directory, "repository");
    cleanup.push(directory);
    writeFileSync(path.join(directory, ".gitconfig"), "[zentra]\n\tcanary = inherited\n", "utf8");
    mkdirSync(path.join(directory, ".config", "git"), { recursive: true });
    writeFileSync(
      path.join(directory, ".config", "git", "attributes"),
      "*.txt diff=ambient\n",
      "utf8",
    );
    const originalHome = process.env["HOME"];
    process.env["HOME"] = directory;
    try {
      const git = new GitClient();
      expect(await git.run(directory, ["config", "--global", "--get", "zentra.canary"])).toMatchObject({
        exitCode: 1,
        stdout: "",
      });
      expect((await git.run(directory, ["init", repository])).exitCode).toBe(0);
      expect((await git.run(repository, ["config", "zentra.local", "visible"])).exitCode).toBe(0);
      writeFileSync(path.join(repository, ".gitattributes"), "local.txt diff=local\n", "utf8");
      writeFileSync(path.join(repository, "local.txt"), "local\n", "utf8");
      writeFileSync(path.join(repository, "ambient.txt"), "ambient\n", "utf8");
      expect(await git.run(repository, ["config", "--local", "--get", "zentra.local"])).toMatchObject({
        exitCode: 0,
        stdout: "visible\n",
      });
      expect(await git.run(repository, ["check-attr", "diff", "--", "ambient.txt"])).toMatchObject({
        exitCode: 0,
        stdout: "ambient.txt: diff: unspecified\n",
      });
      expect(await git.run(repository, ["check-attr", "diff", "--", "local.txt"])).toMatchObject({
        exitCode: 0,
        stdout: "local.txt: diff: local\n",
      });
    } finally {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
    }
  });

  it("times out and terminates the Git process group", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-git-timeout-"));
    cleanup.push(directory);
    const ready = path.join(directory, "ready");
    const forbidden = path.join(directory, "forbidden");

    const running = new GitClient().run(directory, readyChildAlias(ready, forbidden), {
      timeoutMs: 500,
    });
    await waitForFile(ready);
    const result = await running;

    expect(result.termination).toBe("timed_out");
    expect(result.exitCode).toBe(-1);
    expect(existsSync(forbidden)).toBe(false);
  });

  it("cancels and terminates the Git process group", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-git-cancel-"));
    cleanup.push(directory);
    const ready = path.join(directory, "ready");
    const forbidden = path.join(directory, "forbidden");
    const controller = new AbortController();

    const running = new GitClient().run(directory, readyChildAlias(ready, forbidden), {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    await waitForFile(ready);
    controller.abort();
    const result = await running;

    expect(result.termination).toBe("cancelled");
    expect(result.exitCode).toBe(-1);
    expect(existsSync(forbidden)).toBe(false);
  });
});
