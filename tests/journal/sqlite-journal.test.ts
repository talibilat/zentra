import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  MAX_JOURNAL_EVENT_BYTES,
  MAX_JOURNAL_DATABASE_BYTES,
  MAX_JOURNAL_READ_EVENTS,
  MAX_JOURNAL_READ_TOTAL_BYTES,
  MAX_JOURNAL_SHARED_MEMORY_BYTES,
  MAX_JOURNAL_WAL_BYTES,
  SqliteEventJournal,
} from "../../src/journal/sqlite-journal.js";

const journals: SqliteEventJournal[] = [];
const temporaryDirectories: string[] = [];
const MALICIOUS_READ_PEAK_RSS_BYTES = 192 * 1024 * 1024;

afterEach(() => {
  vi.restoreAllMocks();
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

function assertAdmittedFiles(journal: SqliteEventJournal): void {
  (journal as unknown as { assertAdmittedFiles(): void }).assertAdmittedFiles();
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

function createSparseFile(path: string, bytes: number): void {
  writeFileSync(path, "");
  truncateSync(path, bytes);
}

function eventMetadataBytes(streamId: string): number {
  return Buffer.byteLength("0".repeat(36)) +
    Buffer.byteLength(streamId) +
    Buffer.byteLength("task.created") +
    Buffer.byteLength(streamId) +
    Buffer.byteLength("2026-07-12T00:00:00.000Z");
}

function injectEventsWithTotalBytes(
  journal: SqliteEventJournal,
  streamId: string,
  totalBytes: number,
  eventCount: number,
): void {
  const database = rawDatabase(journal);
  database.prepare("INSERT INTO streams (stream_id, current_version) VALUES (?, ?)")
    .run(streamId, eventCount);
  const insert = database.prepare(`
    INSERT INTO events (
      event_id, stream_id, stream_version, type, payload,
      causation_id, correlation_id, recorded_at
    ) VALUES (?, ?, ?, 'task.created', ?, NULL, ?, '2026-07-12T00:00:00.000Z')
  `);
  const metadataBytes = eventMetadataBytes(streamId);
  const payloadBytes = totalBytes - metadataBytes * eventCount;
  const basePayloadBytes = Math.floor(payloadBytes / eventCount);
  const remainder = payloadBytes % eventCount;
  database.transaction(() => {
    for (let index = 0; index < eventCount; index += 1) {
      const bytes = basePayloadBytes + (index < remainder ? 1 : 0);
      insert.run(
        String(index).padStart(36, "0"),
        streamId,
        index + 1,
        JSON.stringify("x".repeat(bytes - 2)),
        streamId,
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

  it.each([
    ["database", "", MAX_JOURNAL_DATABASE_BYTES],
    ["WAL", "-wal", MAX_JOURNAL_WAL_BYTES],
    ["shared-memory", "-shm", MAX_JOURNAL_SHARED_MEMORY_BYTES],
  ] as const)("rejects an oversized %s file before opening SQLite", (_, suffix, limit) => {
    const { databasePath } = temporaryDatabase();
    if (suffix !== "") {
      const database = new Database(databasePath);
      database.close();
    }
    createSparseFile(`${databasePath}${suffix}`, limit + 1);

    expect(() => new SqliteEventJournal(databasePath)).toThrow(/journal file size limit/i);
  });

  it.each([
    ["database", "", MAX_JOURNAL_DATABASE_BYTES],
    ["WAL", "-wal", MAX_JOURNAL_WAL_BYTES],
    ["shared-memory", "-shm", MAX_JOURNAL_SHARED_MEMORY_BYTES],
  ] as const)("admits a %s file exactly at its size limit", (_, suffix, limit) => {
    const { databasePath } = temporaryDatabase();
    const journal = new SqliteEventJournal(databasePath);
    journals.push(journal);
    createSparseFile(`${databasePath}${suffix}`, limit);

    expect(() => assertAdmittedFiles(journal)).not.toThrow();
  });

  it("configures SQLite operation and growth limits", () => {
    const { databasePath } = temporaryDatabase();
    const journal = new SqliteEventJournal(databasePath);
    journals.push(journal);
    const database = rawDatabase(journal);
    const pageSize = database.pragma("page_size", { simple: true }) as number;
    const maxPageCount = database.pragma("max_page_count", { simple: true }) as number;

    expect(maxPageCount * pageSize).toBeLessThanOrEqual(MAX_JOURNAL_DATABASE_BYTES);
    expect(database.pragma("journal_size_limit", { simple: true })).toBe(MAX_JOURNAL_WAL_BYTES);
  });

  it("uses bounded indexed discovery for stream and global reads", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const database = rawDatabase(journal);
    const preparedSql: string[] = [];
    const discoveryBindings: Array<{
      readonly sql: string;
      readonly parameters: readonly unknown[];
    }> = [];
    const prepare = database.prepare.bind(database);
    database.prepare = ((sql: string) => {
      preparedSql.push(sql);
      const statement = prepare(sql);
      if (!/EXPLAIN QUERY PLAN/i.test(sql) && sql.includes("AS event_bytes")) {
        return new Proxy(statement, {
          get(target, property) {
            if (property === "iterate") {
              return (...parameters: readonly unknown[]) => {
                discoveryBindings.push({ sql, parameters });
                return target.iterate(...parameters);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
      return statement;
    }) as typeof database.prepare;

    journal.readStream("task-1");
    journal.readAll();

    const operationalSql = preparedSql.filter((sql) => !/EXPLAIN QUERY PLAN/i.test(sql));
    const readSql = operationalSql.join("\n");
    expect(readSql).not.toMatch(/\b(?:COUNT|SUM|MAX)\s*\(/i);
    expect(readSql.match(/\bLIMIT\s+\?/gi)).toHaveLength(4);
    expect(readSql.match(/zentra_operation_guard\(\)/g)).toHaveLength(4);

    const streamSql = operationalSql.filter((sql) =>
      sql.includes("stream_id = ? AND stream_version > ?")
    );
    const globalSql = operationalSql.filter((sql) => sql.includes("global_position > ?"));
    expect(streamSql).toHaveLength(2);
    expect(globalSql).toHaveLength(2);
    expect(discoveryBindings).toHaveLength(2);
    expect(discoveryBindings.find(({ sql }) => sql.includes("stream_id = ?"))?.parameters)
      .toEqual(["task-1", 0, MAX_JOURNAL_READ_EVENTS + 1]);
    expect(discoveryBindings.find(({ sql }) => sql.includes("global_position > ?"))?.parameters)
      .toEqual([0, MAX_JOURNAL_READ_EVENTS + 1]);
    for (const sql of streamSql) {
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
        "task-1",
        0,
        MAX_JOURNAL_READ_EVENTS + 1,
      ) as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(" ")).toMatch(
        /SEARCH events USING (?:COVERING )?INDEX .*stream_id.*stream_version/i,
      );
    }
    for (const sql of globalSql) {
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
        0,
        MAX_JOURNAL_READ_EVENTS + 1,
      ) as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(" ")).toMatch(
        /SEARCH events USING INTEGER PRIMARY KEY \(rowid>\?\)/i,
      );
    }
  });

  it("fails closed when stream discovery does not use the journal index", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const database = rawDatabase(journal);
    const prepare = database.prepare.bind(database);
    database.prepare = ((sql: string) => {
      if (
        /EXPLAIN QUERY PLAN/i.test(sql) &&
        sql.includes("AS event_bytes") &&
        sql.includes("stream_id = ?")
      ) {
        return {
          all: () => [{
            detail: "SEARCH events USING INDEX adversarial_index " +
              "(stream_id=? AND stream_version>?)",
          }],
        };
      }
      return prepare(sql);
    }) as typeof database.prepare;

    expect(() => journal.readStream("task-1")).toThrow(
      /journal schema does not support bounded reads/i,
    );
  });

  it("materializes a normal replay from the same snapshot used for discovery", () => {
    const { databasePath } = temporaryDatabase();
    const reader = new SqliteEventJournal(databasePath);
    const writer = new SqliteEventJournal(databasePath);
    journals.push(reader, writer);
    writer.append("snapshot", 0, [{
      streamId: "snapshot",
      type: "event.1",
      payload: { sequence: 1 },
      causationId: null,
      correlationId: "snapshot",
    }]);
    const database = rawDatabase(reader);
    const prepare = database.prepare.bind(database);
    let appendedDuringRead = false;
    database.prepare = ((sql: string) => {
      if (
        !appendedDuringRead &&
        !/EXPLAIN QUERY PLAN/.test(sql) &&
        /SELECT\s+event_id, stream_id, stream_version, global_position/.test(sql)
      ) {
        appendedDuringRead = true;
        writer.append("snapshot", 1, [{
          streamId: "snapshot",
          type: "event.2",
          payload: { sequence: 2 },
          causationId: null,
          correlationId: "snapshot",
        }]);
      }
      return prepare(sql);
    }) as typeof database.prepare;

    expect(reader.readStream("snapshot").map((event) => event.type)).toEqual(["event.1"]);
    expect(reader.readStream("snapshot").map((event) => event.type)).toEqual([
      "event.1",
      "event.2",
    ]);
  });

  it("rejects a large malicious journal within peak-memory and wall-time budgets", () => {
    const journalModuleUrl = new URL(
      "../../src/journal/sqlite-journal.ts",
      import.meta.url,
    ).href;
    const script = `
      import { SqliteEventJournal } from ${JSON.stringify(journalModuleUrl)};
      const journal = new SqliteEventJournal(":memory:");
      const database = journal.db;
      const eventCount = 300_000;
      database.prepare("INSERT INTO streams (stream_id, current_version) VALUES (?, ?)")
        .run("malicious", eventCount);
      database.prepare(\`
        WITH RECURSIVE rows(n) AS (
          VALUES(1)
          UNION ALL
          SELECT n + 1 FROM rows WHERE n < ?
        )
        INSERT INTO events (
          event_id, stream_id, stream_version, type, payload,
          causation_id, correlation_id, recorded_at
        )
        SELECT hex(n), ?, n, 'event', '{}', NULL, ?, '2026-07-12T00:00:00.000Z'
        FROM rows
      \`).run(eventCount, "malicious", "malicious");
      const startedAt = performance.now();
      let rejected = false;
      try {
        journal.readAll();
      } catch (error) {
        rejected = /journal read limit/i.test(String(error));
      }
      const wallTimeMs = performance.now() - startedAt;
      journal.close();
      console.log(JSON.stringify({
        rejected,
        wallTimeMs,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      }));
    `;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: 10_000,
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout) as {
      readonly peakRssBytes: number;
      readonly rejected: boolean;
      readonly wallTimeMs: number;
    };
    expect(result.rejected).toBe(true);
    expect(result.wallTimeMs).toBeLessThan(1_000);
    expect(result.peakRssBytes).toBeLessThanOrEqual(MALICIOUS_READ_PEAK_RSS_BYTES);
  });

  it("does not evaluate an extra large virtual column during stream or global reads", () => {
    const { databasePath } = temporaryDatabase();
    const database = new Database(databasePath);
    database.function("adversarial_large_value", { deterministic: true }, () =>
      "x".repeat(128 * 1024 * 1024)
    );
    database.exec(`
      CREATE TABLE streams (
        stream_id TEXT PRIMARY KEY,
        current_version INTEGER NOT NULL
      );
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
      INSERT INTO streams VALUES ('generated', 1);
      INSERT INTO events (
        event_id, stream_id, stream_version, type, payload,
        causation_id, correlation_id, recorded_at
      ) VALUES (
        'event-1', 'generated', 1, 'event', '{}',
        NULL, 'generated', '2026-07-12T00:00:00.000Z'
      );
      ALTER TABLE events ADD COLUMN adversarial_materialization TEXT
        GENERATED ALWAYS AS (adversarial_large_value()) VIRTUAL;
    `);
    database.close();
    const journal = SqliteEventJournal.openReadOnly(databasePath);
    journals.push(journal);
    const beforeRss = process.memoryUsage().rss;
    const startedAt = performance.now();

    expect(journal.readStream("generated")).toHaveLength(1);
    expect(journal.readAll()).toHaveLength(1);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(process.memoryUsage().rss - beforeRss).toBeLessThan(64 * 1024 * 1024);
  });

  it("uses a monotonic clock for operation deadlines", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("wall clock must not guard SQLite operations");
    });

    expect(journal.readAll()).toEqual([]);
    expect(wallClock).not.toHaveBeenCalled();
  });

  it("interrupts expired SQLite execution and reports the public read-limit error", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    injectEvents(journal, "expired", ["{}"]);
    const guardedJournal = journal as unknown as {
      beginBoundedOperation(): void;
      operationDeadline: bigint;
      operationInterrupted: boolean;
    };
    const beginBoundedOperation = guardedJournal.beginBoundedOperation.bind(journal);
    guardedJournal.beginBoundedOperation = () => {
      beginBoundedOperation();
      guardedJournal.operationDeadline = process.hrtime.bigint() - 1n;
    };

    expect(() => journal.readStream("expired")).toThrow(
      new Error("event journal read limit exceeded"),
    );
    expect(guardedJournal.operationInterrupted).toBe(true);
  });

  it("rejects an adversarial schema that could bypass bounded query work", () => {
    const { databasePath } = temporaryDatabase();
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE streams (stream_id TEXT, current_version INTEGER);
      CREATE TABLE events (
        global_position INTEGER,
        event_id TEXT,
        stream_id TEXT,
        stream_version INTEGER,
        type TEXT,
        payload TEXT,
        causation_id TEXT,
        correlation_id TEXT,
        recorded_at TEXT
      );
    `);
    database.prepare("INSERT INTO streams VALUES (?, ?)").run("unindexed", 100_000);
    database.prepare(`
      WITH RECURSIVE rows(n) AS (
        VALUES(1)
        UNION ALL
        SELECT n + 1 FROM rows WHERE n < ?
      )
      INSERT INTO events
      SELECT n, hex(n), ?, n, 'event', '{}', NULL, ?, '2026-07-12T00:00:00.000Z'
      FROM rows
    `).run(100_000, "nonmatching", "nonmatching");
    database.close();
    const startedAt = performance.now();

    expect(() => SqliteEventJournal.openReadOnly(databasePath)).toThrow(
      /journal schema does not support bounded reads/i,
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("fails before materializing an oversized individual payload", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    injectEvents(journal, "oversized", [JSON.stringify("x".repeat(MAX_JOURNAL_EVENT_BYTES))]);

    expect(() => journal.readStream("oversized")).toThrow(/journal read limit/i);
  });

  it("accepts an event exactly at the per-event byte limit", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    injectEventsWithTotalBytes(journal, "event-boundary", MAX_JOURNAL_EVENT_BYTES, 1);

    expect(journal.readStream("event-boundary")).toHaveLength(1);
  });

  it("rejects an event one byte over the per-event byte limit", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    injectEventsWithTotalBytes(journal, "event-over", MAX_JOURNAL_EVENT_BYTES + 1, 1);

    expect(() => journal.readStream("event-over")).toThrow(/journal read limit/i);
  });

  it("fails before materializing excessive total payload bytes", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const payload = JSON.stringify("x".repeat(7_500_000));
    injectEvents(journal, "total", Array.from({ length: 9 }, () => payload));

    expect(() => journal.readStream("total")).toThrow(/journal read limit/i);
    expect(() => journal.readAll()).toThrow(/journal read limit/i);
  });

  it("accepts total materialized bytes exactly at the read limit", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    injectEventsWithTotalBytes(journal, "total-boundary", MAX_JOURNAL_READ_TOTAL_BYTES, 9);

    expect(journal.readStream("total-boundary")).toHaveLength(9);
  });

  it("rejects total materialized bytes one byte over the read limit", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    injectEventsWithTotalBytes(journal, "total-over", MAX_JOURNAL_READ_TOTAL_BYTES + 1, 9);

    expect(() => journal.readStream("total-over")).toThrow(/journal read limit/i);
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

  it("accepts exactly the maximum event count", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    injectEvents(
      journal,
      "count-boundary",
      Array.from({ length: MAX_JOURNAL_READ_EVENTS }, () => "{}"),
    );

    expect(journal.readStream("count-boundary")).toHaveLength(MAX_JOURNAL_READ_EVENTS);
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

  it("reports append guard interruption and preserves existing state atomically", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    const existing = journal.append("interrupted-append", 0, [{
      streamId: "interrupted-append",
      type: "event.existing",
      payload: { sequence: 1 },
      causationId: null,
      correlationId: "interrupted-append",
    }]);
    const guardedJournal = journal as unknown as {
      beginBoundedOperation(): void;
      operationDeadline: bigint;
    };
    const beginBoundedOperation = guardedJournal.beginBoundedOperation.bind(journal);
    let guardCount = 0;
    guardedJournal.beginBoundedOperation = () => {
      beginBoundedOperation();
      guardCount += 1;
      if (guardCount === 2) {
        guardedJournal.operationDeadline = process.hrtime.bigint() - 1n;
      }
    };

    expect(() => journal.append("interrupted-append", 1, [{
      streamId: "interrupted-append",
      type: "event.interrupted",
      payload: { sequence: 2 },
      causationId: null,
      correlationId: "interrupted-append",
    }])).toThrow(new Error("event journal append limit exceeded"));
    expect(journal.readStream("interrupted-append")).toEqual(existing);
    expect(rawDatabase(journal).prepare(
      "SELECT current_version FROM streams WHERE stream_id = ?",
    ).get("interrupted-append")).toEqual({ current_version: 1 });
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
