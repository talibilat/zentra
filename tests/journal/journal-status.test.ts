import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getJournalStatus } from "../../src/journal/journal-status.js";
import { JournalRetentionService } from "../../src/journal/retention.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { readonly directory: string; readonly databasePath: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-journal-status-"));
  directories.push(directory);
  const databasePath = path.join(directory, "journal.sqlite");
  const journal = new SqliteEventJournal(databasePath);
  journal.append("stream-a", 0, [{
    streamId: "stream-a", type: "test.event", payload: {}, causationId: null, correlationId: "journal-status-test",
  }]);
  journal.close();
  return { directory, databasePath };
}

describe("getJournalStatus", () => {
  it("returns retention: null when no database path is configured", () => {
    const { databasePath } = fixture();
    const journal = new SqliteEventJournal(databasePath);
    try {
      const status = getJournalStatus(journal, undefined);
      expect(status.retention).toBeNull();
    } finally {
      journal.close();
    }
  });

  it("reports clean retention status with no archives yet", () => {
    const { databasePath } = fixture();
    const journal = new SqliteEventJournal(databasePath);
    try {
      const status = getJournalStatus(journal, databasePath);
      expect(status.retention).toEqual({
        globalPosition: 1,
        retainedThroughPosition: 0,
        archiveHeadPosition: 0,
        archiveSegmentCount: 0,
        policyMode: "retain_forever",
        recoveryOutcome: "clean",
        recoveryKind: null,
        recoveryState: null,
      });
    } finally {
      journal.close();
    }
  });

  it("reports an interrupted archive operation needing attention", () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    expect(() => retention.archive({ throughPosition: 1, maxEvents: 1, crashPoint: "after_segment" }))
      .toThrow(/simulated crash/i);
    const journal = new SqliteEventJournal(databasePath);
    try {
      const status = getJournalStatus(journal, databasePath);
      expect(status.retention?.recoveryOutcome).toBe("uncertain");
      expect(status.retention?.recoveryKind).toBe("archive");
      expect(status.retention?.recoveryState).toBe("segment_only_orphan");
    } finally {
      journal.close();
    }
  });

  it("returns projection: null for a plain journal that is not a ProjectingEventJournal", () => {
    const { databasePath } = fixture();
    const journal = new SqliteEventJournal(databasePath);
    try {
      const status = getJournalStatus(journal, undefined);
      expect(status.projection).toBeNull();
    } finally {
      journal.close();
    }
  });

  it("reports live projection cursor health for a ProjectingEventJournal", () => {
    const { databasePath } = fixture();
    const inner = new SqliteEventJournal(databasePath);
    const projected = new ProjectingEventJournal(inner, { append: () => {} }, "journal-status-test-cursor");
    try {
      const status = getJournalStatus(projected, undefined);
      expect(status.projection).toEqual({
        cursorName: "journal-status-test-cursor",
        position: 1,
        highWaterPosition: 1,
        lag: 0,
        replayCount: 0,
        active: false,
      });
    } finally {
      inner.close();
    }
  });

  it("degrades retention to null instead of throwing when the retention side fails, leaving projection intact", () => {
    const { directory, databasePath } = fixture();
    const inner = new SqliteEventJournal(databasePath);
    const projected = new ProjectingEventJournal(inner, { append: () => {} }, "journal-status-broken-retention-cursor");
    const notAJournalDatabase = path.join(directory, "not-a-journal.sqlite");
    writeFileSync(notAJournalDatabase, "this is not a sqlite journal database\n");
    expect(() => JournalRetentionService.openReadOnly(notAJournalDatabase).metadataSummary()).toThrow();
    try {
      const status = getJournalStatus(projected, notAJournalDatabase);
      expect(status.retention).toBeNull();
      expect(status.projection).toEqual({
        cursorName: "journal-status-broken-retention-cursor",
        position: 1,
        highWaterPosition: 1,
        lag: 0,
        replayCount: 0,
        active: false,
      });
    } finally {
      inner.close();
    }
  });
});
