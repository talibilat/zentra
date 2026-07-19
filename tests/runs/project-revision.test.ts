import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { projectRevisionMatches, resolveProjectRevision } from "../../src/runs/project-revision.js";

describe("project revision preflight", () => {
  it("resolves and verifies the exact committed project revision", async () => {
    const repository = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-run-revision-")));
    try {
      git(repository, ["init"]);
      git(repository, ["config", "user.name", "Zentra Test"]);
      git(repository, ["config", "user.email", "zentra@example.invalid"]);
      writeFileSync(path.join(repository, "source.txt"), "first\n");
      git(repository, ["add", "source.txt"]);
      git(repository, ["commit", "-m", "initial"]);
      const revision = await resolveProjectRevision(repository);

      expect(revision.objectFormat).toBe("sha1");
      expect(revision.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(await projectRevisionMatches(repository, revision)).toBe(true);

      writeFileSync(path.join(repository, "source.txt"), "second\n");
      git(repository, ["commit", "-am", "advance"]);
      expect(await projectRevisionMatches(repository, revision)).toBe(false);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("/usr/bin/git", args, {
    cwd,
    shell: false,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
}
