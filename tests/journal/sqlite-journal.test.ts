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
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

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
});
