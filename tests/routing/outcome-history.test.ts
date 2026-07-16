import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { JournalOutcomeHistoryStore } from "../../src/routing/outcome-history.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("JournalOutcomeHistoryStore", () => {
  it("persists complete measurable outcomes across SQLite restart", () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-routing-")));
    roots.push(root);
    const database = path.join(root, "history.sqlite");
    const journal = new SqliteEventJournal(database);
    const store = new JournalOutcomeHistoryStore(journal);
    const terminal = appendTerminal(journal, "completed");
    const selection = store.begin({
      executionId: "execution-1",
      taskId: "task-1",
      taskType: "single_file_implementation",
      role: "implementer",
      model: { capabilityId: "writer-a", harness: "opencode", transportModelSha256: "e".repeat(64) },
      candidateCapabilityIds: ["writer-a", "writer-b"],
      modelSheetSha256: "a".repeat(64),
      basis: "sheet_order",
      correlationId: "goal-1",
    });
    store.complete({
      executionId: "execution-1",
      startedAt: "2026-07-16T12:00:00.000Z",
      finishedAt: "2026-07-16T12:00:02.000Z",
      durationMs: 2_000,
      outcome: "completed",
      validation: { status: "completed", evidenceSha256: "b".repeat(64) },
      review: { status: "approved", evidenceSha256: "c".repeat(64) },
      terminalEvidence: [{
        eventId: terminal.eventId,
        streamId: "task-1",
        sha256: sha256(JSON.stringify(terminal.payload)),
      }],
      causationId: terminal.eventId,
    });
    journal.close();

    const reopened = new SqliteEventJournal(database);
    const records = new JournalOutcomeHistoryStore(reopened).list({
      taskType: "single_file_implementation",
      role: "implementer",
      harness: "opencode",
    });
    expect(records).toEqual([expect.objectContaining({
      executionId: "execution-1",
      taskType: "single_file_implementation",
      role: "implementer",
      model: { capabilityId: "writer-a", harness: "opencode", transportModelSha256: "e".repeat(64) },
      durationMs: 2_000,
      outcome: "completed",
      validation: { status: "completed", evidenceSha256: "b".repeat(64) },
      review: { status: "approved", evidenceSha256: "c".repeat(64) },
      terminalEvidence: [{
        eventId: terminal.eventId,
        streamId: "task-1",
        sha256: sha256(JSON.stringify(terminal.payload)),
      }],
      selection: { eventId: selection.eventId, modelSheetSha256: "a".repeat(64) },
    })]);
    reopened.close();
  });

  it("rejects duplicate completion and outcome without selection", () => {
    const journal = new SqliteEventJournal(":memory:");
    const store = new JournalOutcomeHistoryStore(journal);
    const terminal = appendTerminal(journal, "failed");
    expect(() => store.complete({
      executionId: "missing",
      startedAt: "2026-07-16T12:00:00.000Z",
      finishedAt: "2026-07-16T12:00:01.000Z",
      durationMs: 1_000,
      outcome: "failed",
      validation: { status: "failed", evidenceSha256: null },
      review: { status: "not_observed", evidenceSha256: null },
      terminalEvidence: [{ eventId: terminal.eventId, streamId: "task-1", sha256: null }],
      causationId: terminal.eventId,
    })).toThrow();

    store.begin({
      executionId: "execution-duplicate",
      taskId: "task-1",
      taskType: "single_file_implementation",
      role: "implementer",
      model: { capabilityId: "writer-a", harness: "opencode", transportModelSha256: "e".repeat(64) },
      candidateCapabilityIds: ["writer-a"],
      modelSheetSha256: "a".repeat(64),
      basis: "sheet_order",
      correlationId: "goal-1",
    });
    const completion = {
      executionId: "execution-duplicate",
      startedAt: "2026-07-16T12:00:00.000Z",
      finishedAt: "2026-07-16T12:00:01.000Z",
      durationMs: 1_000,
      outcome: "failed" as const,
      validation: { status: "failed" as const, evidenceSha256: "f".repeat(64) },
      review: { status: "not_observed" as const, evidenceSha256: null },
      terminalEvidence: [{ eventId: terminal.eventId, streamId: "task-1", sha256: null }],
      causationId: terminal.eventId,
    };
    store.complete(completion);
    expect(() => store.complete(completion)).toThrow(/incomplete selection|expected version/i);
    journal.close();
  });
});

function appendTerminal(journal: SqliteEventJournal, outcome: "completed" | "failed") {
  return journal.append("task-1", 0, [{
    streamId: "task-1",
    type: `task.${outcome}`,
    payload: { outcome },
    causationId: null,
    correlationId: "goal-1",
  }])[0]!;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
