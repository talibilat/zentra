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

function delayedMarkerAlias(marker: string): readonly string[] {
  const script = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), 150)`;
  return ["-c", `alias.wait=!${process.execPath} -e '${script}'`, "wait"];
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
    const marker = path.join(directory, "marker");

    const result = await new GitClient().run(directory, delayedMarkerAlias(marker), {
      timeoutMs: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(result.termination).toBe("timed_out");
    expect(result.exitCode).toBe(-1);
    expect(existsSync(marker)).toBe(false);
  });

  it("cancels and terminates the Git process group", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-git-cancel-"));
    cleanup.push(directory);
    const marker = path.join(directory, "marker");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    const result = await new GitClient().run(directory, delayedMarkerAlias(marker), {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(result.termination).toBe("cancelled");
    expect(result.exitCode).toBe(-1);
    expect(existsSync(marker)).toBe(false);
  });
});
