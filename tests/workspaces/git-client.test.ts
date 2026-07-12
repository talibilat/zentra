import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
