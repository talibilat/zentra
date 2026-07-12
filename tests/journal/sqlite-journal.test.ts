import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  MAX_JOURNAL_EVENT_BYTES,
  MAX_JOURNAL_READ_EVENTS,
  MAX_JOURNAL_READ_TOTAL_BYTES,
  SqliteEventJournal,
} from "../../src/journal/sqlite-journal.js";

const journals: SqliteEventJournal[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const journal of journals) journal.close();
  journals.length = 0;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabase(): { readonly directory: string; readonly databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "zentra-journal-"));
  temporaryDirectories.push(directory);
  return { directory, databasePath: join(directory, "journal.db") };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function schema(journal: SqliteEventJournal): unknown[] {
  const database = (journal as unknown as {
    db: { prepare(sql: string): { all(): unknown[] } };
  }).db;
  return database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
  ).all();
}

function rawDatabase(journal: SqliteEventJournal): Database.Database {
  return (journal as unknown as { db: Database.Database }).db;
}

function injectEvents(
  journal: SqliteEventJournal,
  streamId: string,
  payloads: readonly string[],
): void {
  const database = rawDatabase(journal);
  database.prepare("INSERT INTO streams (stream_id, current_version) VALUES (?, ?)")
    .run(streamId, payloads.length);
  const insert = database.prepare(`
    INSERT INTO events (
      event_id, stream_id, stream_version, type, payload,
      causation_id, correlation_id, recorded_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `);
  database.transaction(() => {
    for (const [index, payload] of payloads.entries()) {
      insert.run(
        `event-${index}`,
        streamId,
        index + 1,
        "task.created",
        payload,
        streamId,
        "2026-07-12T00:00:00.000Z",
      );
    }
  })();
}

describe("SqliteEventJournal", () => {
  it("appends and reads an ordered stream", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);

    const stored = journal.append("task-1", 0, [
      {
        streamId: "task-1",
        type: "task.created",
        payload: { title: "Update greeting" },
        causationId: null,
        correlationId: "goal-1",
      },
    ]);

    expect(stored[0]?.streamVersion).toBe(1);
    expect(journal.readStream("task-1")).toEqual(stored);
  });

  it("rejects stale expected versions", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);

    journal.append("task-1", 0, [
      {
        streamId: "task-1",
        type: "task.created",
        payload: {},
        causationId: null,
        correlationId: "goal-1",
      },
    ]);

    expect(() => journal.append("task-1", 0, [])).toThrow("expected version 0, actual 1");
  });

  it("persists events across close and reopen", () => {
    const { databasePath } = temporaryDatabase();

    const first = new SqliteEventJournal(databasePath);
    const stored = first.append("task-1", 0, [
      {
        streamId: "task-1",
        type: "task.created",
        payload: { title: "Survive restart" },
        causationId: null,
        correlationId: "goal-1",
      },
    ]);
    first.close();

    const reopened = new SqliteEventJournal(databasePath);
    journals.push(reopened);

    const replayed = reopened.readStream("task-1");
    expect(replayed).toEqual(stored);
    expect(replayed[0]?.eventId).toBe(stored[0]?.eventId);
    expect(replayed[0]?.streamVersion).toBe(stored[0]?.streamVersion);
    expect(replayed[0]?.globalPosition).toBe(stored[0]?.globalPosition);
    expect(replayed[0]?.recordedAt).toBe(stored[0]?.recordedAt);
  });

  it("opens an existing journal read-only without changing bytes, mtime, or schema", () => {
    const { databasePath } = temporaryDatabase();
    const writer = new SqliteEventJournal(databasePath);
    const stored = writer.append("task-readonly", 0, [{
      streamId: "task-readonly",
      type: "task.created",
      payload: { title: "Read only" },
      causationId: null,
      correlationId: "task-readonly",
    }]);
    const expectedSchema = schema(writer);
    writer.close();
    const before = {
      bytes: sha256(databasePath),
      mtimeMs: statSync(databasePath).mtimeMs,
    };

    const reader = SqliteEventJournal.openReadOnly(databasePath);
    expect(reader.readStream("task-readonly")).toEqual(stored);
    expect(schema(reader)).toEqual(expectedSchema);
    expect(() => reader.append("task-readonly", 1, [])).toThrow(/read.?only/i);
    reader.close();

    expect(sha256(databasePath)).toBe(before.bytes);
    expect(statSync(databasePath).mtimeMs).toBe(before.mtimeMs);
  });

  it("fails a read-only open when the database is missing without creating any files", () => {
    const { directory, databasePath } = temporaryDatabase();
    expect(() => SqliteEventJournal.openReadOnly(databasePath)).toThrow();
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("fails before materializing an oversized individual payload", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    injectEvents(journal, "oversized", [JSON.stringify("x".repeat(MAX_JOURNAL_EVENT_BYTES))]);

    expect(() => journal.readStream("oversized")).toThrow(/journal read limit/i);
  });

  it("fails before materializing excessive total payload bytes", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const payload = JSON.stringify("x".repeat(7_500_000));
    injectEvents(journal, "total", Array.from({ length: 9 }, () => payload));

    expect(() => journal.readStream("total")).toThrow(/journal read limit/i);
    expect(() => journal.readAll()).toThrow(/journal read limit/i);
  });

  it("fails before materializing an excessive event count", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    injectEvents(
      journal,
      "count",
      Array.from({ length: MAX_JOURNAL_READ_EVENTS + 1 }, () => "{}"),
    );

    expect(() => journal.readStream("count")).toThrow(/journal read limit/i);
    expect(() => journal.readAll()).toThrow(/journal read limit/i);
  });

  it("rejects an oversized appended row before creating a stream", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);

    expect(() => journal.append("oversized-append", 0, [{
      streamId: "oversized-append",
      type: "task.created",
      payload: { marker: "x".repeat(MAX_JOURNAL_EVENT_BYTES) },
      causationId: null,
      correlationId: "oversized-append",
    }])).toThrow(/journal append limit/i);
    expect(journal.readStream("oversized-append")).toEqual([]);
  });

  it("rejects an oversized append batch atomically", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const payload = { marker: "x".repeat(7_500_000) };
    const batch = Array.from({ length: 9 }, (_, index) => ({
      streamId: "oversized-batch",
      type: `event.${index}`,
      payload,
      causationId: null,
      correlationId: "oversized-batch",
    }));

    expect(() => journal.append("oversized-batch", 0, batch)).toThrow(/journal append limit/i);
    expect(journal.readStream("oversized-batch")).toEqual([]);
  });

  it("rejects an append that would exceed the projected stream count", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    injectEvents(
      journal,
      "full-stream",
      Array.from({ length: MAX_JOURNAL_READ_EVENTS }, () => "{}"),
    );

    expect(() => journal.append("full-stream", MAX_JOURNAL_READ_EVENTS, [{
      streamId: "full-stream",
      type: "one.too.many",
      payload: {},
      causationId: null,
      correlationId: "full-stream",
    }])).toThrow(/journal append limit/i);
    expect(rawDatabase(journal).prepare(
      "SELECT current_version FROM streams WHERE stream_id = ?",
    ).get("full-stream")).toEqual({ current_version: MAX_JOURNAL_READ_EVENTS });
  });

  it("replays repeated maximum legitimate worker evidence", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const stdout = "x".repeat(1024 * 1024);
    const evidence = { validation: { stdout, stderr: stdout } };
    journal.append("large-legitimate", 0, Array.from({ length: 3 }, (_, index) => ({
      streamId: "large-legitimate",
      type: `evidence.${index}`,
      payload: evidence,
      causationId: null,
      correlationId: "large-legitimate",
    })));

    expect(journal.readStream("large-legitimate")).toHaveLength(3);
    expect(MAX_JOURNAL_READ_TOTAL_BYTES).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(evidence)) * 3,
    );
  });

  it("replays worst-case escaped validation and cleanup failure evidence within ceilings", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const escapedMegabyte = '\\"'.repeat(512 * 1024);
    const evidence = {
      receipt: {
        validation: {
          stdout: escapedMegabyte,
          stderr: escapedMegabyte,
        },
      },
      candidateCleanupFailures: [{
        projectId: "project-1",
        taskId: "task-1",
        candidatePath: "/worktrees/.zentra-integration-000000/candidate",
        reason: escapedMegabyte,
        timestamp: "2026-07-12T00:00:00.000Z",
      }],
    };
    const encodedBytes = Buffer.byteLength(JSON.stringify(evidence));
    expect(encodedBytes).toBeLessThan(MAX_JOURNAL_EVENT_BYTES);
    expect(encodedBytes * 3).toBeLessThan(MAX_JOURNAL_READ_TOTAL_BYTES);

    journal.append("worst-case-evidence", 0, Array.from({ length: 3 }, (_, index) => ({
      streamId: "worst-case-evidence",
      type: ["task.integration_prepared", "task.integration_observed", "task.completed"][index]!,
      payload: evidence,
      causationId: null,
      correlationId: "worst-case-evidence",
    })));

    expect(journal.readStream("worst-case-evidence")).toHaveLength(3);
  });
});
