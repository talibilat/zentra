import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/main.js";
import { SqliteEventJournal, SQLITE_JOURNAL_SCHEMA_VERSION } from "../../src/journal/sqlite-journal.js";
import {
  RUNTIME_SCHEMA_VERSION,
  RuntimeStateManager,
  discoverProject,
  initializeProjectRuntime,
} from "../../src/runtime/repository-runtime.js";
import { ServiceLifecycleService } from "../../src/runs/service-lifecycle.js";
import { seedAgentTrailReady } from "../fixtures/service-ready.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("production workflow CLI composition", () => {
  it("rejects forged ready metadata without a live authenticated control channel and never mutates the journal", async () => {
    const fixture = await productionFixture("ready");
    const before = fixture.journal.readAll();

    const result = await invoke(["run", "Inspect the parser"], fixture.projectRoot);

    expect(result).toMatchObject({ code: 1, stdout: "", json: {
      command: "run", error: { code: "unavailable", message: "Workflow service is unavailable." },
    } });
    expect(fixture.journal.readAll()).toEqual(before);
    expect(fixture.journal.readAll().some((event) => event.type === "run.accepted")).toBe(false);
    fixture.journal.close();
  });

  it.each(["missing", "stopped"] as const)("rejects %s durable service authority as unavailable", async (state) => {
    const fixture = await productionFixture(state);

    const result = await invoke(["list"], fixture.projectRoot);

    expect(result).toMatchObject({ code: 1, stdout: "", json: {
      command: "list", error: { code: "unavailable", message: "Workflow service is unavailable." },
    } });
    fixture.journal.close();
  });
});

async function productionFixture(state: "ready" | "missing" | "stopped") {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "zentra-production-cli-"));
  directories.push(projectRoot);
  await execFileAsync("/usr/bin/git", ["init", "-b", "main", projectRoot]);
  await execFileAsync("/usr/bin/git", ["config", "user.name", "Zentra CLI Fixture"], { cwd: projectRoot });
  await execFileAsync("/usr/bin/git", ["config", "user.email", "fixture@zentra.local"], { cwd: projectRoot });
  writeFileSync(path.join(projectRoot, "README.md"), "fixture\n", "utf8");
  await execFileAsync("/usr/bin/git", ["add", "--", "README.md"], { cwd: projectRoot });
  await execFileAsync("/usr/bin/git", ["commit", "-m", "fixture"], { cwd: projectRoot });

  const layout = await initializeProjectRuntime(await discoverProject(projectRoot));
  const runtime = new RuntimeStateManager(layout);
  const address = { host: "127.0.0.1" as const, port: 45_678 };
  const tokenExpiresAt = "2030-01-01T00:00:00.000Z";
  const ownership = await runtime.start({ address, tokenExpiresAt, startupStatus: "starting" });
  await runtime.publish(ownership.claim, { address, tokenExpiresAt, startupStatus: "ready" });

  const journal = new SqliteEventJournal(layout.databasePath);
  chmodSync(layout.databasePath, 0o600);
  if (state !== "missing") {
    const lifecycle = new ServiceLifecycleService(journal);
    const serviceId = `service-${state}`;
    const starting = lifecycle.start({
      serviceId, process: ownership.claim, address, tokenExpiresAt,
      observation: "performed", commandId: `start-${state}`,
    });
    const agentTrail = seedAgentTrailReady(journal, { serviceId, serviceStartingEventId: starting.eventId });
    lifecycle.ready({
      serviceId, process: ownership.claim, address, tokenExpiresAt,
      runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
      journalSchemaVersion: SQLITE_JOURNAL_SCHEMA_VERSION,
      observation: "performed", commandId: `ready-${state}`,
      causationId: agentTrail.agentTrailReadyEventId,
      ...agentTrail,
    });
    if (state === "stopped") {
      lifecycle.beginShutdown({
        serviceId, process: ownership.claim, occurredAt: "2026-07-20T12:00:00.000Z",
        commandId: "stop-service", observation: "performed",
      });
      lifecycle.shutdown({
        serviceId, process: ownership.claim, outcome: "completed", reasonCode: "test_requested",
        occurredAt: "2026-07-20T12:00:01.000Z", commandId: "shutdown-service", observation: "performed",
      });
    }
  }
  return { projectRoot, journal };
}

async function invoke(argv: readonly string[], cwd: string) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd,
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  });
  return {
    code, stdout, stderr,
    json: JSON.parse(`${stdout}${stderr}`.trim()) as Record<string, unknown>,
  };
}
