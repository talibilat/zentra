import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const journals: SqliteEventJournal[] = [];

afterEach(() => {
  for (const journal of journals) journal.close();
  journals.length = 0;
});

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
    const databasePath = join(mkdtempSync(join(tmpdir(), "zentra-journal-")), "journal.db");

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
});
