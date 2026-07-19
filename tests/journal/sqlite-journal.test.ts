import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  foldStreamEvents,
} from "../../src/journal/journal.js";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_JOURNAL_DATABASE_BYTES,
  MAX_JOURNAL_EVENT_BYTES,
  MAX_JOURNAL_READ_EVENTS,
  MAX_JOURNAL_READ_TOTAL_BYTES,
  SqliteEventJournal,
} from "../../src/journal/sqlite-journal.js";

const journals: SqliteEventJournal[] = [];
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabase(): { readonly directory: string; readonly databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "zentra-journal-"));
  directories.push(directory);
  return { directory, databasePath: join(directory, "journal.db") };
}

function event(streamId: string, sequence: number, marker = "") {
  return {
    streamId,
    type: "test.event",
    payload: { sequence, marker },
    causationId: null,
    correlationId: streamId,
  } as const;
}

function database(journal: SqliteEventJournal): Database.Database {
  return (journal as unknown as { db: Database.Database }).db;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("SqliteEventJournal", () => {
  it("appends ordered events and enforces optimistic stream concurrency", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const stored = journal.append("task-1", 0, [event("task-1", 1)]);

    expect(stored[0]).toMatchObject({ streamVersion: 1, globalPosition: 1 });
    expect(journal.readStream("task-1")).toEqual(stored);
    expect(() => journal.append("task-1", 0, [event("task-1", 2)]))
      .toThrow("expected version 0, actual 1");
    expect(() => journal.append("task-1", 1, [event("other", 2)]))
      .toThrow(/streamId does not match/i);
  });

  it("preserves event identity and positions across close and reopen", () => {
    const { databasePath } = temporaryDatabase();
    const first = new SqliteEventJournal(databasePath);
    const stored = first.append("persistent", 0, [event("persistent", 1)]);
    first.close();

    const reopened = new SqliteEventJournal(databasePath);
    journals.push(reopened);
    expect(reopened.readAllPage().events).toEqual(stored);
  });

  it("opens a migrated journal read-only without changing its bytes or schema", () => {
    const { databasePath } = temporaryDatabase();
    const writer = new SqliteEventJournal(databasePath);
    const stored = writer.append("readonly", 0, [event("readonly", 1)]);
    writer.close();
    const before = { digest: sha256(databasePath), mtimeMs: statSync(databasePath).mtimeMs };

    const reader = SqliteEventJournal.openReadOnly(databasePath);
    expect(reader.readStreamPage("readonly").events).toEqual(stored);
    expect(() => reader.append("readonly", 1, [])).toThrow(/read.?only/i);
    expect(reader.inspectProjectionCursor("read-only")).toBeNull();
    reader.close();

    expect(sha256(databasePath)).toBe(before.digest);
    expect(statSync(databasePath).mtimeMs).toBe(before.mtimeMs);
  });

  it("does not create a missing database during read-only open", () => {
    const { databasePath } = temporaryDatabase();
    expect(() => SqliteEventJournal.openReadOnly(databasePath)).toThrow();
    expect(existsSync(databasePath)).toBe(false);
  });

  it("requires legacy databases to migrate through a read-write open", () => {
    const { databasePath } = temporaryDatabase();
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE streams (stream_id TEXT PRIMARY KEY, current_version INTEGER NOT NULL);
      CREATE TABLE events (
        global_position INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        stream_id TEXT NOT NULL REFERENCES streams (stream_id),
        stream_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        causation_id TEXT,
        correlation_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (stream_id, stream_version)
      );
    `);
    legacy.close();

    expect(() => SqliteEventJournal.openReadOnly(databasePath)).toThrow(/migration required/i);
    const migrated = new SqliteEventJournal(databasePath);
    migrated.close();
    const reader = SqliteEventJournal.openReadOnly(databasePath);
    reader.close();
  });

  it("retains per-event and per-batch append limits atomically", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    expect(() => journal.append("oversized", 0, [{
      ...event("oversized", 1),
      payload: { marker: "x".repeat(MAX_JOURNAL_EVENT_BYTES) },
    }])).toThrow(/append limit/i);
    expect(journal.readStream("oversized")).toEqual([]);

    const marker = "x".repeat(7_500_000);
    expect(() => journal.append(
      "batch",
      0,
      Array.from({ length: 9 }, (_, index) => event("batch", index, marker)),
    )).toThrow(/append limit/i);
    expect(journal.readStream("batch")).toEqual([]);
  });

  it("allows history to exceed the former event admission limit and pages all rows", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const total = MAX_JOURNAL_READ_EVENTS + 37;
    let version = 0;
    while (version < total) {
      const count = Math.min(500, total - version);
      journal.append(
        "long-history",
        version,
        Array.from({ length: count }, (_, index) => event("long-history", version + index + 1)),
      );
      version += count;
    }

    expect(() => journal.readStream("long-history")).toThrow(/use readStreamPage/i);
    let afterVersion = 0;
    let read = 0;
    while (true) {
      const page = journal.readStreamPage(
        "long-history",
        afterVersion,
        { maxEvents: 257, maxBytes: 128 * 1024 },
      );
      expect(page.events.length).toBeLessThanOrEqual(257);
      expect(page.bytes).toBeLessThanOrEqual(128 * 1024);
      read += page.events.length;
      afterVersion = page.nextVersion;
      if (!page.hasMore) break;
    }
    expect(read).toBe(total);
    expect(afterVersion).toBe(total);
    expect(foldStreamEvents(
      journal,
      "long-history",
      0,
      (count) => count + 1,
    )).toBe(total);
  });

  it("grows beyond the former database ceiling and reopens with bounded pages", { timeout: 30_000 }, () => {
    const { databasePath } = temporaryDatabase();
    const writer = new SqliteEventJournal(databasePath);
    const marker = "x".repeat(1024 * 1024);
    let version = 0;
    for (const count of [50, 50, 30]) {
      writer.append(
        "large-database",
        version,
        Array.from({ length: count }, (_, index) =>
          event("large-database", version + index + 1, marker)),
      );
      version += count;
    }
    writer.close();
    expect(statSync(databasePath).size).toBeGreaterThan(MAX_JOURNAL_DATABASE_BYTES);

    const reopened = new SqliteEventJournal(databasePath);
    journals.push(reopened);
    let afterVersion = 0;
    let count = 0;
    while (true) {
      const page = reopened.readStreamPage(
        "large-database",
        afterVersion,
        { maxEvents: 10, maxBytes: 2_500_000 },
      );
      expect(page.events.length).toBeLessThanOrEqual(2);
      expect(page.bytes).toBeLessThanOrEqual(2_500_000);
      count += page.events.length;
      afterVersion = page.nextVersion;
      if (!page.hasMore) break;
    }
    expect(count).toBe(130);
  });

  it("rejects corrupt oversized and invalid JSON rows before returning them", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const raw = database(journal);
    raw.prepare("INSERT INTO streams VALUES (?, ?)").run("invalid", 1);
    raw.prepare("INSERT INTO streams VALUES (?, ?)").run("oversized", 1);
    const insert = raw.prepare(`
      INSERT INTO events (
        event_id, stream_id, stream_version, type, payload,
        causation_id, correlation_id, recorded_at
      ) VALUES (?, ?, 1, 'test.event', ?, NULL, ?, '2026-07-01T00:00:00.000Z')
    `);
    insert.run("invalid-json", "invalid", "not-json", "invalid");
    insert.run(
      "oversized",
      "oversized",
      JSON.stringify("x".repeat(MAX_JOURNAL_EVENT_BYTES)),
      "oversized",
    );

    expect(() => journal.readStreamPage("invalid", 0, { maxEvents: 1, maxBytes: 1024 }))
      .toThrow(/payload is corrupt/i);
    expect(() => journal.readStreamPage(
      "oversized",
      0,
      { maxEvents: 1, maxBytes: MAX_JOURNAL_READ_TOTAL_BYTES },
    )).toThrow(/event limit/i);
  });

  it("uses indexed, row-limited page discovery without history aggregates", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const raw = database(journal);
    const prepared: string[] = [];
    const prepare = raw.prepare.bind(raw);
    raw.prepare = ((sql: string) => {
      prepared.push(sql);
      return prepare(sql);
    }) as typeof raw.prepare;

    journal.readStreamPage("indexed", 0, { maxEvents: 3, maxBytes: 1024 });
    journal.readAllPage(0, { maxEvents: 3, maxBytes: 1024 });

    const discovery = prepared.filter((sql) => sql.includes("AS event_bytes"));
    expect(discovery).toHaveLength(2);
    expect(discovery.join("\n")).not.toMatch(/\b(?:COUNT|SUM|MAX)\s*\(/i);
    expect(discovery.every((sql) => /LIMIT\s+\?/i.test(sql))).toBe(true);
    expect(discovery.every((sql) => sql.includes("zentra_operation_guard()"))).toBe(true);
  });

  it("rejects a deceptive index name when the plan omits the stream-version predicate", () => {
    const { databasePath } = temporaryDatabase();
    const raw = new Database(databasePath);
    raw.exec(`
      CREATE TABLE streams (stream_id TEXT PRIMARY KEY, current_version INTEGER NOT NULL);
      CREATE TABLE events (
        global_position INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        stream_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        causation_id TEXT,
        correlation_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX deceptive_stream_id_stream_version ON events (stream_id);
    `);
    raw.close();

    expect(() => new SqliteEventJournal(databasePath)).toThrow(
      /schema does not support bounded reads/i,
    );
  });

  it("keeps peak process memory bounded while paging a much larger history", () => {
    const journalModule = new URL("../../src/journal/sqlite-journal.ts", import.meta.url).href;
    const script = `
      import { SqliteEventJournal } from ${JSON.stringify(journalModule)};
      const journal = new SqliteEventJournal(":memory:");
      const db = journal.db;
      const count = 50_000;
      db.prepare("INSERT INTO streams VALUES (?, ?)").run("memory", count);
      db.prepare(\`
        WITH RECURSIVE rows(n) AS (
          VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < ?
        )
        INSERT INTO events (
          event_id, stream_id, stream_version, type, payload,
          causation_id, correlation_id, recorded_at
        )
        SELECT hex(n), 'memory', n, 'test.event', '{"ok":true}',
               NULL, 'memory', '2026-07-01T00:00:00.000Z'
        FROM rows
      \`).run(count);
      const page = journal.readAllPage(0, { maxEvents: 32, maxBytes: 8 * 1024 });
      console.log(JSON.stringify({
        events: page.events.length,
        bytes: page.bytes,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      }));
      journal.close();
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 10_000,
    });

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const evidence = JSON.parse(child.stdout) as {
      readonly events: number;
      readonly bytes: number;
      readonly peakRssBytes: number;
    };
    expect(evidence.events).toBe(32);
    expect(evidence.bytes).toBeLessThanOrEqual(8 * 1024);
    expect(evidence.peakRssBytes).toBeLessThan(192 * 1024 * 1024);
  });

  it("uses one snapshot for page sizing and row materialization", () => {
    const { databasePath } = temporaryDatabase();
    const reader = new SqliteEventJournal(databasePath);
    const writer = new SqliteEventJournal(databasePath);
    journals.push(reader, writer);
    writer.append("snapshot", 0, [event("snapshot", 1)]);
    const raw = database(reader);
    const prepare = raw.prepare.bind(raw);
    let appended = false;
    raw.prepare = ((sql: string) => {
      if (!appended && sql.includes("event_id, stream_id") && !sql.includes("AS event_bytes")) {
        appended = true;
        writer.append("snapshot", 1, [event("snapshot", 2)]);
      }
      return prepare(sql);
    }) as typeof raw.prepare;

    expect(reader.readStreamPage("snapshot").events).toHaveLength(1);
    expect(reader.readStreamPage("snapshot").events).toHaveLength(2);
  });

  it("uses a monotonic deadline and exposes a stable bounded-read error", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    journal.append("deadline", 0, [event("deadline", 1)]);
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("wall clock must not be used");
    });
    expect(journal.readAllPage().events).toHaveLength(1);
    expect(wallClock).not.toHaveBeenCalled();

    const guarded = journal as unknown as {
      beginBoundedOperation(maximumRows: number): void;
      operationDeadline: bigint;
    };
    const begin = guarded.beginBoundedOperation.bind(journal);
    guarded.beginBoundedOperation = (maximumRows) => {
      begin(maximumRows);
      guarded.operationDeadline = process.hrtime.bigint() - 1n;
    };
    expect(() => journal.readAllPage()).toThrow("event journal read limit exceeded");
  });
});

describe("bounded journal pages", () => {
  it("makes monotonic stream progress while another connection appends", () => {
    const { databasePath } = temporaryDatabase();
    const reader = new SqliteEventJournal(databasePath);
    const writer = new SqliteEventJournal(databasePath);
    journals.push(reader, writer);
    writer.append("concurrent", 0, [event("concurrent", 1), event("concurrent", 2)]);

    const first = reader.readStreamPage("concurrent", 0, { maxEvents: 1, maxBytes: 1024 });
    writer.append("concurrent", 2, [event("concurrent", 3)]);
    const second = reader.readStreamPage(
      "concurrent",
      first.nextVersion,
      { maxEvents: 10, maxBytes: 4096 },
    );

    expect(first.events.map((stored) => stored.streamVersion)).toEqual([1]);
    expect(second.events.map((stored) => stored.streamVersion)).toEqual([2, 3]);
    expect(second.nextVersion).toBe(3);
  });

  it("surfaces global and stream corruption instead of skipping gaps", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    journal.append("damaged", 0, [
      event("damaged", 1),
      event("damaged", 2),
      event("damaged", 3),
    ]);
    database(journal).prepare("DELETE FROM events WHERE global_position = 2").run();

    expect(() => journal.readAllPage(0)).toThrow(/gap.*position 2/i);
    expect(() => journal.readStreamPage("damaged", 0)).toThrow(/gap.*version 2/i);
  });

  it("rejects cursors ahead of the authoritative head", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    expect(() => journal.readAllPage(1)).toThrow(/ahead of global position/i);
    expect(() => journal.readStreamPage("missing", 1)).toThrow(/ahead of stream version/i);
  });
});

describe("journal migration", () => {
  it("adds cursor state without changing legacy event identity or position", () => {
    const { databasePath } = temporaryDatabase();
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE streams (stream_id TEXT PRIMARY KEY, current_version INTEGER NOT NULL);
      CREATE TABLE events (
        global_position INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        stream_id TEXT NOT NULL REFERENCES streams (stream_id),
        stream_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        causation_id TEXT,
        correlation_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (stream_id, stream_version)
      );
      INSERT INTO streams VALUES ('legacy', 1);
      INSERT INTO events VALUES (
        1, 'event-stable', 'legacy', 1, 'legacy.event', '{"stable":true}',
        NULL, 'legacy', '2026-07-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const journal = new SqliteEventJournal(databasePath);
    journals.push(journal);
    expect(journal.readAllPage().events[0]).toMatchObject({
      eventId: "event-stable",
      globalPosition: 1,
      streamVersion: 1,
    });
    expect(journal.ensureProjectionCursor("projection-after-migration").position).toBe(0);
  });

  it("fails closed when the migration trigger is replaced by a no-op", () => {
    const { databasePath } = temporaryDatabase();
    const journal = new SqliteEventJournal(databasePath);
    journal.close();
    const raw = new Database(databasePath);
    raw.exec(`
      DROP TRIGGER events_update_global_head;
      CREATE TRIGGER events_update_global_head AFTER INSERT ON events BEGIN SELECT 1; END;
    `);
    raw.close();

    expect(() => new SqliteEventJournal(databasePath)).toThrow(/global-head trigger/i);
  });

  it("fails closed when metadata disagrees with selected event positions", () => {
    const { databasePath } = temporaryDatabase();
    const journal = new SqliteEventJournal(databasePath);
    journal.append("metadata", 0, [event("metadata", 1)]);
    database(journal).prepare(
      "UPDATE journal_metadata SET global_position = 0 WHERE singleton = 1",
    ).run();
    journal.close();

    expect(() => new SqliteEventJournal(databasePath)).toThrow(/global head/i);
  });

  it("migrates a schema-v1 active claim with an exact digest and explicit recovery", () => {
    const { databasePath } = temporaryDatabase();
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE streams (stream_id TEXT PRIMARY KEY, current_version INTEGER NOT NULL);
      CREATE TABLE events (
        global_position INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        stream_id TEXT NOT NULL REFERENCES streams (stream_id),
        stream_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        causation_id TEXT,
        correlation_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (stream_id, stream_version)
      );
      CREATE TABLE journal_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        global_position INTEGER NOT NULL CHECK (global_position >= 0)
      );
      CREATE TABLE projection_cursors (
        name TEXT PRIMARY KEY,
        position INTEGER NOT NULL CHECK (position >= 0),
        claim_id TEXT UNIQUE,
        claim_through_position INTEGER,
        claim_event_count INTEGER,
        claim_bytes INTEGER,
        replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0)
      );
      CREATE TRIGGER events_update_global_head
      AFTER INSERT ON events
      BEGIN
        UPDATE journal_metadata
        SET global_position = NEW.global_position
        WHERE singleton = 1 AND global_position < NEW.global_position;
      END;
      INSERT INTO streams VALUES ('legacy-claim', 1);
      INSERT INTO journal_metadata VALUES (1, 0);
      INSERT INTO events VALUES (
        1, 'legacy-event-id', 'legacy-claim', 1, 'task.created',
        '{"projectId":"project","title":"Legacy"}', NULL, 'legacy-trace',
        '2026-07-01T00:00:00.000Z'
      );
      PRAGMA user_version = 1;
    `);
    const size = legacy.prepare(`
      SELECT length(CAST(event_id AS BLOB)) + length(CAST(stream_id AS BLOB)) +
             length(CAST(type AS BLOB)) + length(CAST(payload AS BLOB)) +
             length(CAST(COALESCE(causation_id, '') AS BLOB)) +
             length(CAST(correlation_id AS BLOB)) + length(CAST(recorded_at AS BLOB)) AS bytes
      FROM events WHERE global_position = 1
    `).get() as { bytes: number };
    legacy.prepare(`
      INSERT INTO projection_cursors (
        name, position, claim_id, claim_through_position,
        claim_event_count, claim_bytes, replay_count
      ) VALUES (?, 0, ?, 1, 1, ?, 0)
    `).run("legacy:projection", "legacy-claim-token", size.bytes);
    legacy.close();

    const migrated = new SqliteEventJournal(databasePath);
    journals.push(migrated);
    const active = migrated.inspectProjectionClaim("legacy:projection");
    expect(active).toMatchObject({
      claimId: "legacy-claim-token",
      claimantId: "migration:unowned",
      replayed: true,
      events: [expect.objectContaining({ eventId: "legacy-event-id", globalPosition: 1 })],
    });
    const recovered = migrated.recoverProjectionClaim(
      "legacy:projection", "legacy-claim-token",
      "process:99999999:00000000-0000-4000-8000-000000000001",
    );
    expect(recovered).toMatchObject({ claimantId: "process:99999999:00000000-0000-4000-8000-000000000001" });
  });

  it("rolls back schema-v1 migration without changing bytes or claim state when the trigger is corrupt", () => {
    const { databasePath } = temporaryDatabase();
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE streams (stream_id TEXT PRIMARY KEY, current_version INTEGER NOT NULL);
      CREATE TABLE events (
        global_position INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        stream_id TEXT NOT NULL REFERENCES streams (stream_id),
        stream_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        causation_id TEXT,
        correlation_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (stream_id, stream_version)
      );
      CREATE TABLE journal_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        global_position INTEGER NOT NULL CHECK (global_position >= 0)
      );
      CREATE TABLE projection_cursors (
        name TEXT PRIMARY KEY,
        position INTEGER NOT NULL CHECK (position >= 0),
        claim_id TEXT UNIQUE,
        claim_through_position INTEGER,
        claim_event_count INTEGER,
        claim_bytes INTEGER,
        replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0)
      );
      CREATE TRIGGER events_update_global_head AFTER INSERT ON events BEGIN SELECT 1; END;
      INSERT INTO streams VALUES ('legacy-corrupt', 1);
      INSERT INTO journal_metadata VALUES (1, 1);
      INSERT INTO events VALUES (
        1, 'legacy-corrupt-event', 'legacy-corrupt', 1, 'task.created',
        '{"projectId":"project","title":"Legacy"}', NULL, 'legacy-trace',
        '2026-07-01T00:00:00.000Z'
      );
      PRAGMA user_version = 1;
    `);
    const claimBytes = (legacy.prepare(`
      SELECT length(CAST(event_id AS BLOB)) + length(CAST(stream_id AS BLOB)) +
             length(CAST(type AS BLOB)) + length(CAST(payload AS BLOB)) +
             length(CAST(COALESCE(causation_id, '') AS BLOB)) +
             length(CAST(correlation_id AS BLOB)) + length(CAST(recorded_at AS BLOB)) AS bytes
      FROM events WHERE global_position = 1
    `).get() as { bytes: number }).bytes;
    legacy.prepare(`
      INSERT INTO projection_cursors VALUES (?, 0, ?, 1, 1, ?, 4)
    `).run("legacy:corrupt", "legacy-corrupt-claim", claimBytes);
    const beforeSchema = legacy.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name
    `).all();
    const beforeClaim = legacy.prepare("SELECT * FROM projection_cursors").get();
    const beforeVersion = legacy.pragma("user_version", { simple: true });
    legacy.close();
    const beforeBytes = readFileSync(databasePath);

    expect(() => new SqliteEventJournal(databasePath)).toThrow(/global-head trigger/i);

    expect(readFileSync(databasePath)).toEqual(beforeBytes);
    const unchanged = new Database(databasePath, { readonly: true });
    expect(unchanged.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name
    `).all()).toEqual(beforeSchema);
    expect(unchanged.prepare("SELECT * FROM projection_cursors").get()).toEqual(beforeClaim);
    expect(unchanged.pragma("user_version", { simple: true })).toBe(beforeVersion);
    unchanged.close();
  });
});

describe("durable projection claims", () => {
  it("replays an uncommitted claim after reopen and advances only on atomic commit", () => {
    const { databasePath } = temporaryDatabase();
    const first = new SqliteEventJournal(databasePath);
    first.append("outbox", 0, [event("outbox", 1), event("outbox", 2)]);
    const original = first.claimProjection("agent-tail", "process:99999999:00000000-0000-4000-8000-000000000001", { maxEvents: 1, maxBytes: 1024 })!;
    expect(original).toMatchObject({
      afterPosition: 0,
      throughPosition: 1,
      highWaterPosition: 2,
      lag: 2,
      replayed: false,
      replayCount: 0,
    });
    first.close();

    const reopened = new SqliteEventJournal(databasePath);
    journals.push(reopened);
    expect(() => reopened.claimProjection(
      "agent-tail",
      "process:99999998:00000000-0000-4000-8000-000000000002",
      { maxEvents: 10, maxBytes: 4096 },
    )).toThrow(/owned by another claimant/i);
    const replay = reopened.recoverProjectionClaim("agent-tail", original.claimId, "process:99999998:00000000-0000-4000-8000-000000000002");
    expect(replay.claimId).toBe(original.claimId);
    expect(replay.events.map((stored) => stored.eventId)).toEqual(
      original.events.map((stored) => stored.eventId),
    );
    expect(replay).toMatchObject({ replayed: true, replayCount: 1 });
    expect(reopened.inspectProjectionCursor("agent-tail")?.position).toBe(0);

    const committed = reopened.commitProjection("agent-tail", replay.claimId, "process:99999998:00000000-0000-4000-8000-000000000002");
    expect(committed).toMatchObject({ position: replay.throughPosition, lag: 1 });
    expect(() => reopened.commitProjection("agent-tail", replay.claimId, "process:99999998:00000000-0000-4000-8000-000000000002"))
      .toThrow(/claim.*does not match/i);
  });

  it("validates cursor identity and demonstrates event-ID duplicate suppression", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    journal.append("duplicates", 0, [event("duplicates", 1)]);
    expect(() => journal.claimProjection("../other", "process:1:00000000-0000-4000-8000-000000000001", { maxEvents: 1, maxBytes: 1024 }))
      .toThrow(/projection name/i);

    const delivered = new Set<string>();
    const deliver = (ids: readonly string[]) => ids.filter((id) => {
      if (delivered.has(id)) return false;
      delivered.add(id);
      return true;
    });
    const first = journal.claimProjection("safe:name", "process:1:00000000-0000-4000-8000-000000000001", { maxEvents: 1, maxBytes: 1024 })!;
    const replay = journal.claimProjection("safe:name", "process:1:00000000-0000-4000-8000-000000000001", { maxEvents: 1, maxBytes: 1024 })!;
    expect(deliver(first.events.map((stored) => stored.eventId))).toHaveLength(1);
    expect(deliver(replay.events.map((stored) => stored.eventId))).toHaveLength(0);
    expect(replay.replayCount).toBe(1);
  });

  it("serializes competing claims and does not replay committed events", () => {
    const { databasePath } = temporaryDatabase();
    const first = new SqliteEventJournal(databasePath);
    const second = new SqliteEventJournal(databasePath);
    journals.push(first, second);
    first.append("competing", 0, [event("competing", 1), event("competing", 2)]);

    const claimed = first.claimProjection("projection", "process:1:00000000-0000-4000-8000-000000000001", { maxEvents: 1, maxBytes: 1024 })!;
    expect(() => second.claimProjection(
      "projection",
      "process:2:00000000-0000-4000-8000-000000000002",
      { maxEvents: 2, maxBytes: 2048 },
    )).toThrow(/owned by another claimant/i);

    first.commitProjection("projection", claimed.claimId, "process:1:00000000-0000-4000-8000-000000000001");
    const next = second.claimProjection("projection", "process:2:00000000-0000-4000-8000-000000000002", { maxEvents: 2, maxBytes: 2048 })!;
    expect(next.events.map((stored) => stored.globalPosition)).toEqual([2]);
    expect(next.claimId).not.toBe(claimed.claimId);
  });

  it("does not expose an active claim token to another claimant", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    journal.append("ownership", 0, [event("ownership", 1)]);
    const claimed = (journal.claimProjection as unknown as Function)(
      "owned:projection",
      "process:1:00000000-0000-4000-8000-000000000001",
      { maxEvents: 1, maxBytes: 1024 },
    );
    expect(claimed).toMatchObject({ claimantId: "process:1:00000000-0000-4000-8000-000000000001" });

    expect(() => (journal.claimProjection as unknown as Function)(
      "owned:projection",
      "process:2:00000000-0000-4000-8000-000000000002",
      { maxEvents: 1, maxBytes: 1024 },
    )).toThrow(/owned by another claimant/i);
    expect(() => journal.commitProjection(
      "owned:projection",
      claimed.claimId,
      "process:2:00000000-0000-4000-8000-000000000002",
    )).toThrow(/does not match the active claim/i);
  });

  it("refuses direct automatic recovery while the prior claimant PID is live", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    journal.append("live-recovery", 0, [event("live-recovery", 1)]);
    const claim = journal.claimProjection(
      "live:recovery", `process:${process.pid}:00000000-0000-4000-8000-000000000001`, { maxEvents: 1, maxBytes: 1024 },
    )!;
    expect(() => journal.recoverProjectionClaim(
      "live:recovery", claim.claimId, `process:${process.pid}:00000000-0000-4000-8000-000000000002`,
    )).toThrow(/live or cannot be verified dead/i);
  });

  it("grants one exclusive claim across racing OS processes", { timeout: 10_000 }, async () => {
    const { databasePath } = temporaryDatabase();
    const seed = new SqliteEventJournal(databasePath);
    seed.append("process-race", 0, [event("process-race", 1)]);
    seed.close();
    const moduleUrl = new URL("../../src/journal/sqlite-journal.ts", import.meta.url).href;
    const script = `
      import { SqliteEventJournal } from ${JSON.stringify(moduleUrl)};
      const [databasePath, claimantId] = process.argv.slice(1);
      const journal = new SqliteEventJournal(databasePath);
      try {
        const claim = journal.claimProjection(
          "process:race",
          claimantId,
          { maxEvents: 1, maxBytes: 1024 },
        );
        console.log(JSON.stringify({ claimed: true, claimId: claim.claimId, claimantId }));
      } catch (error) {
        console.log(JSON.stringify({ claimed: false, error: String(error), claimantId }));
      } finally {
        journal.close();
      }
    `;
    const run = (claimantId: string) => new Promise<{
      readonly claimed: boolean;
      readonly claimId?: string;
      readonly claimantId: string;
      readonly error?: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", script, databasePath, claimantId],
        {
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? "" },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) return reject(new Error(stderr));
        resolve(JSON.parse(stdout) as {
          readonly claimed: boolean;
          readonly claimId?: string;
          readonly claimantId: string;
          readonly error?: string;
        });
      });
    });

    const results = await Promise.all([
      run("process:1:00000000-0000-4000-8000-000000000001"),
      run("process:2:00000000-0000-4000-8000-000000000002"),
    ]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.filter((result) => !result.claimed)).toEqual([
      expect.objectContaining({ error: expect.stringMatching(/owned by another claimant/i) }),
    ]);
    expect(new Set(results.flatMap((result) => result.claimId ?? []))).toHaveLength(1);
  });

  it("refuses to commit a claim whose authoritative range was corrupted", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    journal.append("claim-corruption", 0, [event("claim-corruption", 1)]);
    const claim = journal.claimProjection("projection", "process:1:00000000-0000-4000-8000-000000000001", { maxEvents: 1, maxBytes: 1024 })!;
    database(journal).prepare("DELETE FROM events WHERE global_position = 1").run();

    expect(() => journal.commitProjection("projection", claim.claimId, "process:1:00000000-0000-4000-8000-000000000001")).toThrow(/gap|corrupt|disagrees/i);
    expect(() => journal.inspectProjectionCursor("projection")).toThrow(/global head/i);
  });

  it("detects same-size event identity and payload replacement on replay and commit", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    journal.append("digest", 0, [event("digest", 1, "aa")]);
    const claim = journal.claimProjection("digest:projection", "process:1:00000000-0000-4000-8000-000000000001", { maxEvents: 1, maxBytes: 1024 })!;
    database(journal).prepare(`
      UPDATE events SET event_id = ?, payload = ? WHERE global_position = 1
    `).run("0".repeat(36), JSON.stringify({ sequence: 1, marker: "bb" }));

    expect(() => journal.claimProjection(
      "digest:projection",
      "process:1:00000000-0000-4000-8000-000000000001",
      { maxEvents: 1, maxBytes: 1024 },
    )).toThrow(/claim digest/i);
    expect(() => journal.commitProjection("digest:projection", claim.claimId, "process:1:00000000-0000-4000-8000-000000000001"))
      .toThrow(/claim digest/i);
  });

  it("rejects oversized persisted claim metadata before issuing a range query", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    journal.append("metadata-limit", 0, [event("metadata-limit", 1)]);
    journal.claimProjection("metadata:limit", "process:1:00000000-0000-4000-8000-000000000001", { maxEvents: 1, maxBytes: 1024 });
    const raw = database(journal);
    raw.prepare(`
      UPDATE projection_cursors
      SET claim_event_count = 9000000, claim_bytes = 900000000,
          claim_through_position = 9000000, replay_count = 9000000
      WHERE name = 'metadata:limit'
    `).run();

    expect(() => journal.inspectProjectionClaim("metadata:limit"))
      .toThrow(/projection claim metadata limit/i);
    expect(() => journal.claimProjection("metadata:limit", "process:1:00000000-0000-4000-8000-000000000001"))
      .toThrow(/projection claim metadata limit/i);
  });

  it("rejects invalid persisted cursor integers", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    journal.ensureProjectionCursor("cursor:invalid");
    database(journal).prepare(
      "UPDATE projection_cursors SET position = 1.5 WHERE name = 'cursor:invalid'",
    ).run();
    expect(() => journal.inspectProjectionCursor("cursor:invalid"))
      .toThrow(/projection cursor.*safe integer/i);
  });

  it("inspects existing cursors read-only and reports absent cursors without mutation", () => {
    const { databasePath } = temporaryDatabase();
    const writer = new SqliteEventJournal(databasePath);
    writer.ensureProjectionCursor("existing:cursor");
    writer.close();

    const reader = SqliteEventJournal.openReadOnly(databasePath);
    expect(reader.inspectProjectionCursor("existing:cursor")).toMatchObject({ position: 0 });
    expect(reader.inspectProjectionCursor("absent:cursor")).toBeNull();
    reader.close();

    const verify = new Database(databasePath, { readonly: true });
    expect(verify.prepare("SELECT name FROM projection_cursors ORDER BY name").all()).toEqual([
      { name: "existing:cursor" },
    ]);
    verify.close();
  });
});
