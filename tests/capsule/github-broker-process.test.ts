import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const fixture = path.join(import.meta.dirname, "fixtures/github-broker-process.mjs");
let root: string;

beforeAll(async () => {
  await execFileAsync("pnpm", ["build"], {
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH ?? "" },
  });
  root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-github-broker-process-")));
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface ProcessEvent {
  readonly pid: number;
  readonly repository: string;
  readonly event: "begin" | "end" | "receipt";
  readonly at: number;
}

function events(resultsPath: string): readonly ProcessEvent[] {
  if (!existsSync(resultsPath)) return [];
  return readFileSync(resultsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function runBroker(
  journalPath: string,
  repository: string,
  resultsPath: string,
  startAt: number,
): Promise<unknown> {
  return execFileAsync(process.execPath, [
    fixture,
    journalPath,
    repository,
    resultsPath,
    String(startAt),
    "400",
  ], {
    cwd: repositoryRoot,
    shell: false,
    env: { PATH: process.env.PATH ?? "" },
  });
}

describe("GitHub broker cross-process repository serialization", () => {
  it("converges different journal aliases and allows different repositories concurrently", async () => {
    const sameResults = path.join(root, "same.ndjson");
    const sameJournal = path.join(root, "same-journal.sqlite");
    new SqliteEventJournal(sameJournal).close();
    const sameAliasA = path.join(root, "same-alias-a.sqlite");
    const sameAliasB = path.join(root, "same-alias-b.sqlite");
    symlinkSync(sameJournal, sameAliasA);
    symlinkSync(sameJournal, sameAliasB);
    const sameStart = Date.now() + 300;
    await Promise.all([
      runBroker(sameAliasA, "talibilat/zentra", sameResults, sameStart),
      runBroker(sameAliasB, "TALIBILAT/ZENTRA", sameResults, sameStart),
    ]);

    const sameBegins = events(sameResults).filter((event) => event.event === "begin");
    expect(sameBegins).toHaveLength(1);
    expect(new Set(events(sameResults).filter((event) => event.event === "receipt").map((event) => event.pid)).size).toBe(2);

    const differentResults = path.join(root, "different.ndjson");
    const differentJournal = path.join(root, "different-journal.sqlite");
    new SqliteEventJournal(differentJournal).close();
    const differentAliasA = path.join(root, "different-alias-a.sqlite");
    const differentAliasB = path.join(root, "different-alias-b.sqlite");
    symlinkSync(differentJournal, differentAliasA);
    symlinkSync(differentJournal, differentAliasB);
    const differentStart = Date.now() + 300;
    await Promise.all([
      runBroker(differentAliasA, "talibilat/zentra", differentResults, differentStart),
      runBroker(differentAliasB, "talibilat/other", differentResults, differentStart),
    ]);

    const differentEvents = events(differentResults);
    const intervals = differentEvents.filter((event) => event.event === "begin").map((begin) => ({
      start: begin.at,
      end: differentEvents.find((event) => event.event === "end" && event.pid === begin.pid)!.at,
    }));
    expect(intervals).toHaveLength(2);
    expect(Math.max(intervals[0]!.start, intervals[1]!.start)).toBeLessThan(
      Math.min(intervals[0]!.end, intervals[1]!.end),
    );
  }, 20_000);
});
