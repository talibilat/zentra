import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { runCli } from "../../src/cli/main.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { JournalRetentionService } from "../../src/journal/retention.js";
import { TaskService } from "../../src/tasks/task-service.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function invoke(args: readonly string[]) {
  let output = "";
  const code = await runCli(args, {
    stdout: (value) => { output += value; },
    stderr: (value) => { output += value; },
  });
  return { code, value: JSON.parse(output) as Record<string, unknown> };
}

describe("journal maintenance CLI", () => {
  it("migrates a schema-v4 journal before running retention commands", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-retention-migration-"));
    directories.push(directory);
    const database = path.join(directory, "journal.sqlite");
    const journal = new SqliteEventJournal(database);
    journal.append("events", 0, [{
      streamId: "events", type: "test.event", payload: {}, causationId: null,
      correlationId: "migration",
    }]);
    journal.close();
    const legacy = new Database(database);
    legacy.exec(`
      DROP INDEX retention_one_active_operation;
      DROP INDEX retention_operations_request;
      DROP INDEX retention_operations_state;
      ALTER TABLE retention_operations RENAME TO retention_operations_current;
      CREATE TABLE retention_operations (
        operation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('archive', 'prune_request', 'prune', 'maintenance')),
        state TEXT NOT NULL CHECK (state IN (
          'publishing', 'authorized', 'effect_applied', 'consumed', 'completed', 'failed'
        )),
        from_position INTEGER,
        through_position INTEGER NOT NULL CHECK (through_position >= 0),
        segment_id TEXT,
        segment_sha256 TEXT,
        manifest_sha256 TEXT,
        request_id TEXT,
        operator_id TEXT,
        created_at TEXT NOT NULL
      );
      DROP TABLE retention_operations_current;
    `);
    legacy.pragma("user_version = 4");
    legacy.close();

    expect(await invoke(["journal", "restore", "--database", database,
      "--name", "restored.sqlite"])).toMatchObject({
      code: 0,
      value: { command: "journal.restore", throughPosition: 1 },
    });
    const migrated = new Database(database, { readonly: true });
    expect(migrated.pragma("user_version", { simple: true })).toBe(6);
    expect((migrated.pragma("table_info(retention_operations)") as Array<{ name: string }>)
      .some((column) => column.name === "maintenance_evidence")).toBe(true);
    migrated.close();
  });

  it("composes archive, verification, explicit prune, and replay-safe export", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-retention-cli-"));
    directories.push(directory);
    const database = path.join(directory, "journal.sqlite");
    const journal = new SqliteEventJournal(database);
    for (let index = 0; index < 8; index += 1) {
      journal.append("events", index, [{
        streamId: "events", type: "test.event", payload: { index },
        causationId: null, correlationId: "cli-retention",
      }]);
    }
    journal.close();

    expect(await invoke(["journal", "archive", "--database", database,
      "--through-position", "4", "--max-events", "4"])).toMatchObject({
      code: 0, value: { command: "journal.archive", throughPosition: 4 },
    });
    expect(await invoke(["journal", "verify", "--database", database])).toMatchObject({
      code: 0, value: { command: "journal.verify", verified: true, throughPosition: 4 },
    });
    const requested = await invoke(["journal", "prune-request", "--database", database,
      "--through-position", "4", "--operator", "operator-1"]);
    expect(requested.code).toBe(0);
    const requestId = String(requested.value.requestId);
    const confirmation = String(requested.value.confirmation);
    expect(await invoke(["journal", "prune", "--database", database,
      "--through-position", "4", "--operator", "operator-1", "--request-id", requestId,
      "--confirm", confirmation])).toMatchObject({
      code: 0, value: { command: "journal.prune", deletedEvents: 4 },
    });
    expect(await invoke(["journal", "export", "--database", database,
      "--name", "journal.jsonl"])).toMatchObject({
      code: 0, value: { command: "journal.export", eventCount: expect.any(Number) },
    });
    expect(await invoke(["journal", "maintain", "--database", database,
      "--vacuum-pages", "4"])).toMatchObject({
      code: 0,
      value: {
        command: "journal.maintain",
        vacuum: { status: "not_supported", requestedPages: 4 },
      },
    });
    expect(await invoke(["journal", "maintain", "--database", database,
      "--vacuum-pages", "1001"])).toMatchObject({ code: 1 });
  });

  it("uses active plus archived history for normal task status after prune", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-retention-status-"));
    directories.push(directory);
    const database = path.join(directory, "journal.sqlite");
    const journal = new SqliteEventJournal(database);
    new TaskService(journal).create({
      taskId: "archived-task",
      projectId: "project-1",
      title: "Archived task",
      correlationId: "archived-task",
    });
    journal.append("filler", 0, Array.from({ length: 4 }, (_, index) => ({
      streamId: "filler",
      type: "test.event",
      payload: { index },
      causationId: null,
      correlationId: "filler",
    })));
    journal.close();
    const retention = new JournalRetentionService(database);
    retention.archive({ throughPosition: 5, maxEvents: 5 });
    const request = retention.requestPrune({ throughPosition: 5, operatorId: "operator-1" });
    retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation });

    expect(await invoke(["task", "status", "--database", database, "--task-id", "archived-task"]))
      .toMatchObject({
        code: 0,
        value: {
          command: "task.status",
          task: { taskId: "archived-task", lifecycle: "queued" },
        },
      });
  });

  it("inspects and exactly reconciles an incomplete retention operation", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-retention-reconcile-"));
    directories.push(directory);
    const database = path.join(directory, "journal.sqlite");
    const journal = new SqliteEventJournal(database);
    journal.append("events", 0, Array.from({ length: 4 }, (_, index) => ({
      streamId: "events",
      type: "test.event",
      payload: { index },
      causationId: null,
      correlationId: "reconcile",
    })));
    journal.close();
    const retention = new JournalRetentionService(database);
    expect(() => retention.archive({ throughPosition: 4, maxEvents: 4, crashPoint: "after_manifest" }))
      .toThrow();

    const inspected = await invoke(["journal", "inspect-recovery", "--database", database]);
    expect(inspected).toMatchObject({
      code: 1,
      value: { command: "journal.inspect-recovery", state: "fully_published_missing_completion" },
    });
    const operationId = String(inspected.value.operationId);
    const confirmation = String(inspected.value.confirmation);
    expect(await invoke(["journal", "reconcile", "--database", database,
      "--operation-id", operationId, "--confirm", confirmation])).toMatchObject({
      code: 0,
      value: { command: "journal.reconcile", outcome: "completed", repeated: false },
    });
  });
});
