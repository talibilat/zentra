import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listJournalEvents } from "../../src/journal/journal-events.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): SqliteEventJournal {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-journal-events-"));
  directories.push(directory);
  const journal = new SqliteEventJournal(path.join(directory, "journal.sqlite"));
  journal.append("run:a", 0, [
    { streamId: "run:a", type: "run.started", payload: { n: 1 }, causationId: null, correlationId: "run:a" },
    { streamId: "run:a", type: "run.completed", payload: { n: 2 }, causationId: null, correlationId: "run:a" },
  ]);
  journal.append("pod:x", 0, [
    { streamId: "pod:x", type: "pod.registered", payload: { n: 3 }, causationId: null, correlationId: "pod:x" },
  ]);
  return journal;
}

describe("listJournalEvents", () => {
  it("returns every event in scan order when no filters are given", () => {
    const journal = fixture();
    const page = listJournalEvents(journal, {});
    expect(page.events.map((event) => event.type)).toEqual(["run.started", "run.completed", "pod.registered"]);
    expect(page.hasMore).toBe(false);
    journal.close();
  });

  it("filters by streamPrefix", () => {
    const journal = fixture();
    const page = listJournalEvents(journal, { streamPrefix: "run:" });
    expect(page.events).toHaveLength(2);
    expect(page.events.every((event) => event.streamId.startsWith("run:"))).toBe(true);
    journal.close();
  });

  it("filters by typePrefix", () => {
    const journal = fixture();
    const page = listJournalEvents(journal, { typePrefix: "pod." });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.type).toBe("pod.registered");
    journal.close();
  });

  it("combines streamPrefix and typePrefix", () => {
    const journal = fixture();
    const page = listJournalEvents(journal, { streamPrefix: "run:", typePrefix: "run.completed" });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.type).toBe("run.completed");
    journal.close();
  });

  it("caps results at limit", () => {
    const journal = fixture();
    const page = listJournalEvents(journal, { limit: 1 });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.type).toBe("run.started");
    journal.close();
  });

  it("continues from a prior page's nextPosition without skipping or duplicating events", () => {
    const journal = fixture();
    const first = listJournalEvents(journal, { limit: 1 });
    const second = listJournalEvents(journal, { afterPosition: first.nextPosition, limit: 10 });
    const combined = [...first.events, ...second.events].map((event) => event.type);
    expect(combined).toEqual(["run.started", "run.completed", "pod.registered"]);
    journal.close();
  });
});
