import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { PathClaimService } from "../../src/workspaces/path-claims.js";

const directories: string[] = [];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const viteNode = path.join(root, "node_modules/vite-node/dist/cli.mjs");
const fixture = path.join(root, "fixtures/path-claim-process.ts");

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("path claims across processes", () => {
  it("allows disjoint claims and admits only one overlapping claimant", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-claim-process-"));
    directories.push(directory);
    const database = path.join(directory, "journal.sqlite");
    new SqliteEventJournal(database).close();
    const revision = "a".repeat(40);
    const disjoint = await Promise.all([
      claim(database, "disjoint-a", "writer-a", revision, "src/a.ts"),
      claim(database, "disjoint-b", "writer-b", revision, "src/b.ts"),
    ]);
    expect(disjoint.map((result) => result.outcome)).toEqual(["acquired", "acquired"]);

    const overlapping = await Promise.all([
      claim(database, "overlap-a", "writer-c", revision, "docs/**"),
      claim(database, "overlap-b", "writer-d", revision, "DOCS/guide.md"),
    ]);
    expect(overlapping.map((result) => result.outcome).sort()).toEqual(["acquired", "denied"]);

    const journal = new SqliteEventJournal(database);
    expect(new PathClaimService(journal).inspect("multiprocess").active).toHaveLength(3);
    expect(journal.readStream("path-claims:multiprocess").filter((event) => event.type === "path_claim.denied"))
      .toHaveLength(1);
    journal.close();
  }, 20_000);
});

function claim(
  database: string,
  claimId: string,
  ownerId: string,
  revision: string,
  candidate: string,
): Promise<{ readonly outcome: "acquired" | "denied"; readonly claimId: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteNode, fixture, database, claimId, ownerId, revision, candidate], {
      cwd: root,
      shell: false,
      env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]
        .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`claim child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout) as { outcome: "acquired" | "denied"; claimId: string }); }
      catch (error) { reject(error); }
    });
  });
}
