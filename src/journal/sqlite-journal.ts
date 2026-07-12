import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";

import Database from "better-sqlite3";

import type { NewEvent, StoredEvent } from "../contracts/event.js";
import type { StreamId } from "../contracts/ids.js";
import type { EventJournal } from "./journal.js";

interface EventRow {
  readonly event_id: string;
  readonly stream_id: string;
  readonly stream_version: number;
  readonly global_position: number;
  readonly type: string;
  readonly payload: string;
  readonly causation_id: string | null;
  readonly correlation_id: string;
  readonly recorded_at: string;
}

interface EventSizeRow {
  readonly event_bytes: number;
}

// These bounds contain the supervisor's maximum escaped output plus repeated
// prepared, observed, cleanup, and completion evidence for the local MVP.
export const MAX_JOURNAL_READ_EVENTS = 10_000;
export const MAX_JOURNAL_EVENT_BYTES = 8 * 1024 * 1024;
export const MAX_JOURNAL_READ_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_JOURNAL_EVENT_PAYLOAD_BYTES = MAX_JOURNAL_EVENT_BYTES;
export const MAX_JOURNAL_READ_TOTAL_PAYLOAD_BYTES = MAX_JOURNAL_READ_TOTAL_BYTES;
export const MAX_JOURNAL_DATABASE_BYTES = 128 * 1024 * 1024;
export const MAX_JOURNAL_WAL_BYTES = 128 * 1024 * 1024;
export const MAX_JOURNAL_SHARED_MEMORY_BYTES = 8 * 1024 * 1024;

const SQLITE_BUSY_TIMEOUT_MS = 1_000;
const SQLITE_OPERATION_TIMEOUT_MS = 1_000;
const BOUNDED_READ_LIMIT = MAX_JOURNAL_READ_EVENTS + 1;
const SQLITE_OPERATION_TIMEOUT_NS = BigInt(SQLITE_OPERATION_TIMEOUT_MS) * 1_000_000n;

const EVENT_BYTES_SQL = `
  length(CAST(event_id AS BLOB)) +
  length(CAST(stream_id AS BLOB)) +
  length(CAST(type AS BLOB)) +
  length(CAST(payload AS BLOB)) +
  length(CAST(COALESCE(causation_id, '') AS BLOB)) +
  length(CAST(correlation_id AS BLOB)) +
  length(CAST(recorded_at AS BLOB))
`;

const STREAM_READ_SIZE_SQL = `
  SELECT ${EVENT_BYTES_SQL} AS event_bytes
  FROM events
  WHERE (stream_id = ? AND stream_version > ?) AND zentra_operation_guard()
  ORDER BY stream_version ASC
  LIMIT ?
`;
const STREAM_READ_ROWS_SQL = `
  SELECT
    event_id, stream_id, stream_version, global_position, type, payload,
    causation_id, correlation_id, recorded_at
  FROM events
  WHERE stream_id = ? AND stream_version > ?
    AND zentra_operation_guard()
  ORDER BY stream_version ASC
  LIMIT ?
`;
const GLOBAL_READ_SIZE_SQL = `
  SELECT ${EVENT_BYTES_SQL} AS event_bytes
  FROM events
  WHERE (global_position > ?) AND zentra_operation_guard()
  ORDER BY global_position ASC
  LIMIT ?
`;
const GLOBAL_READ_ROWS_SQL = `
  SELECT
    event_id, stream_id, stream_version, global_position, type, payload,
    causation_id, correlation_id, recorded_at
  FROM events
  WHERE global_position > ?
    AND zentra_operation_guard()
  ORDER BY global_position ASC
  LIMIT ?
`;
const STREAM_APPEND_SIZE_SQL = `
  SELECT ${EVENT_BYTES_SQL} AS event_bytes
  FROM events
  WHERE (stream_id = ?) AND zentra_operation_guard()
  ORDER BY stream_version ASC
  LIMIT ?
`;
const GLOBAL_APPEND_SIZE_SQL = `
  SELECT ${EVENT_BYTES_SQL} AS event_bytes
  FROM events
  WHERE (1 = 1) AND zentra_operation_guard()
  ORDER BY global_position ASC
  LIMIT ?
`;

export class SqliteEventJournal implements EventJournal {
  private readonly db: Database.Database;
  private readonly databasePath: string;
  private readonly readOnly: boolean;
  private operationDeadline = 0n;
  private operationInterrupted = false;
  private operationRowsRemaining = 0;

  static openReadOnly(databasePath: string): SqliteEventJournal {
    return new SqliteEventJournal(databasePath, { readOnly: true });
  }

  constructor(
    databasePath: string,
    options: { readonly readOnly?: boolean } = {},
  ) {
    this.databasePath = databasePath;
    this.readOnly = options.readOnly ?? false;
    this.assertAdmittedFiles();
    this.db = this.readOnly
      ? new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
        timeout: SQLITE_BUSY_TIMEOUT_MS,
      })
      : new Database(databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
    try {
      this.assertAdmittedFiles();
      this.db.function("zentra_operation_guard", { directOnly: true }, () => {
        if (
          this.operationRowsRemaining <= 0 ||
          process.hrtime.bigint() > this.operationDeadline
        ) {
          this.operationInterrupted = true;
          throw new Error("event journal SQLite operation limit exceeded");
        }
        this.operationRowsRemaining -= 1;
        return 1;
      });
      if (this.readOnly) {
        this.assertBoundedReadPlans();
        return;
      }
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      const pageSize = this.db.pragma("page_size", { simple: true }) as number;
      this.db.pragma(`max_page_count = ${Math.floor(MAX_JOURNAL_DATABASE_BYTES / pageSize)}`);
      this.db.pragma(`journal_size_limit = ${MAX_JOURNAL_WAL_BYTES}`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS streams (
          stream_id TEXT PRIMARY KEY,
          current_version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
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
      this.assertBoundedReadPlans();
      this.assertAdmittedFiles();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  append(
    streamId: StreamId,
    expectedVersion: number,
    events: readonly NewEvent<string, unknown>[],
  ): readonly StoredEvent[] {
    if (this.readOnly) throw new Error("event journal is read-only");
    this.operationInterrupted = false;
    this.assertAdmittedFiles();
    this.assertBoundedReadPlans();
    const serialized = events.map((event) => {
      const payload = JSON.stringify(event.payload);
      if (payload === undefined) throw new Error("event payload must be JSON-serializable");
      const bytes = eventBytes({
        eventId: "00000000-0000-4000-8000-000000000000",
        streamId,
        type: event.type,
        payload,
        causationId: event.causationId,
        correlationId: event.correlationId,
        recordedAt: "0000-00-00T00:00:00.000Z",
      });
      if (bytes > MAX_JOURNAL_EVENT_BYTES) {
        throw new Error("event journal append limit exceeded");
      }
      return { event, payload, bytes };
    });
    const batchBytes = serialized.reduce((total, event) => total + event.bytes, 0);
    if (
      serialized.length > MAX_JOURNAL_READ_EVENTS ||
      batchBytes > MAX_JOURNAL_READ_TOTAL_BYTES
    ) {
      throw new Error("event journal append limit exceeded");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const streamRow = this.db
        .prepare("SELECT current_version FROM streams WHERE stream_id = ?")
        .get(streamId) as { current_version: number } | undefined;
      const actualVersion = streamRow?.current_version ?? 0;
      if (actualVersion !== expectedVersion) {
        throw new Error(`expected version ${expectedVersion}, actual ${actualVersion}`);
      }

      const streamSize = this.readSize(STREAM_APPEND_SIZE_SQL, streamId);
      const globalSize = this.readSize(GLOBAL_APPEND_SIZE_SQL);
      assertProjectedAppend(streamSize, serialized.length, batchBytes);
      assertProjectedAppend(globalSize, serialized.length, batchBytes);

      if (streamRow === undefined) {
        this.db
          .prepare("INSERT INTO streams (stream_id, current_version) VALUES (?, ?)")
          .run(streamId, actualVersion);
      }

      const insertEvent = this.db.prepare(`
        INSERT INTO events (
          event_id, stream_id, stream_version, type, payload,
          causation_id, correlation_id, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const stored: StoredEvent[] = [];
      let version = actualVersion;
      for (const serializedEvent of serialized) {
        const { event, payload } = serializedEvent;
        version += 1;
        const eventId = randomUUID();
        const recordedAt = new Date().toISOString();
        const result = insertEvent.run(
          eventId,
          streamId,
          version,
          event.type,
          payload,
          event.causationId,
          event.correlationId,
          recordedAt,
        );
        stored.push({
          streamId,
          type: event.type,
          payload: event.payload,
          causationId: event.causationId,
          correlationId: event.correlationId,
          eventId,
          streamVersion: version,
          globalPosition: Number(result.lastInsertRowid),
          recordedAt,
        });
      }

      this.db
        .prepare("UPDATE streams SET current_version = ? WHERE stream_id = ?")
        .run(version, streamId);
      this.db.exec("COMMIT");
      return stored;
    } catch (error) {
      if (this.db.inTransaction) {
        this.db.exec("ROLLBACK");
      }
      if (this.operationInterrupted) {
        throw new Error("event journal read limit exceeded");
      }
      throw error;
    }
  }

  readStream(streamId: StreamId, afterVersion = 0): readonly StoredEvent[] {
    this.operationInterrupted = false;
    this.assertAdmittedFiles();
    this.assertBoundedReadPlans();
    try {
      const rows = this.db.transaction(() => {
        const size = this.readSize(STREAM_READ_SIZE_SQL, streamId, afterVersion);
        assertWithinReadLimits(size);
        const statement = this.db.prepare(STREAM_READ_ROWS_SQL);
        this.beginBoundedOperation();
        return statement.all(
          streamId,
          afterVersion,
          BOUNDED_READ_LIMIT,
        ) as EventRow[];
      })();
      return rows.map(toStoredEvent);
    } catch (error) {
      if (this.operationInterrupted) {
        throw new Error("event journal read limit exceeded");
      }
      throw error;
    }
  }

  readAll(afterPosition = 0): readonly StoredEvent[] {
    this.operationInterrupted = false;
    this.assertAdmittedFiles();
    this.assertBoundedReadPlans();
    try {
      const rows = this.db.transaction(() => {
        const size = this.readSize(GLOBAL_READ_SIZE_SQL, afterPosition);
        assertWithinReadLimits(size);
        const statement = this.db.prepare(GLOBAL_READ_ROWS_SQL);
        this.beginBoundedOperation();
        return statement.all(afterPosition, BOUNDED_READ_LIMIT) as EventRow[];
      })();
      return rows.map(toStoredEvent);
    } catch (error) {
      if (this.operationInterrupted) {
        throw new Error("event journal read limit exceeded");
      }
      throw error;
    }
  }

  private readSize(
    sql: string,
    ...parameters: readonly unknown[]
  ): ReadSize {
    const statement = this.db.prepare(sql);
    let eventCount = 0;
    let totalBytes = 0;
    let maxEventBytes = 0;
    this.beginBoundedOperation();
    for (const row of statement.iterate(...parameters, BOUNDED_READ_LIMIT) as Iterable<EventSizeRow>) {
      eventCount += 1;
      if (!Number.isSafeInteger(row.event_bytes) || row.event_bytes < 0) {
        throw new Error("event journal read limit exceeded");
      }
      totalBytes += row.event_bytes;
      maxEventBytes = Math.max(maxEventBytes, row.event_bytes);
      if (
        eventCount > MAX_JOURNAL_READ_EVENTS ||
        totalBytes > MAX_JOURNAL_READ_TOTAL_BYTES ||
        maxEventBytes > MAX_JOURNAL_EVENT_BYTES
      ) {
        throw new Error("event journal read limit exceeded");
      }
    }
    return { eventCount, totalBytes, maxEventBytes };
  }

  private beginBoundedOperation(): void {
    this.operationDeadline = process.hrtime.bigint() + SQLITE_OPERATION_TIMEOUT_NS;
    this.operationInterrupted = false;
    this.operationRowsRemaining = BOUNDED_READ_LIMIT;
  }

  private assertBoundedReadPlans(): void {
    const streamPlans = [STREAM_READ_SIZE_SQL, STREAM_READ_ROWS_SQL].map((sql) =>
      this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
        "",
        0,
        BOUNDED_READ_LIMIT,
      ) as Array<{ detail: string }>
    );
    const globalPlans = [GLOBAL_READ_SIZE_SQL, GLOBAL_READ_ROWS_SQL].map((sql) =>
      this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
        0,
        BOUNDED_READ_LIMIT,
      ) as Array<{ detail: string }>
    );
    if (
      streamPlans.some((plan) =>
        !/SEARCH events USING (?:COVERING )?INDEX .*\(stream_id=\? AND stream_version>\?\)/i
          .test(plan.map((row) => row.detail).join(" "))
      ) ||
      globalPlans.some((plan) =>
        !/SEARCH events USING INTEGER PRIMARY KEY \(rowid>\?\)/i
          .test(plan.map((row) => row.detail).join(" "))
      )
    ) {
      throw new Error("event journal schema does not support bounded reads");
    }
  }

  private assertAdmittedFiles(): void {
    if (this.databasePath === ":memory:" || this.databasePath === "") return;
    assertFileWithinLimit(this.databasePath, MAX_JOURNAL_DATABASE_BYTES);
    assertFileWithinLimit(`${this.databasePath}-wal`, MAX_JOURNAL_WAL_BYTES);
    assertFileWithinLimit(
      `${this.databasePath}-shm`,
      MAX_JOURNAL_SHARED_MEMORY_BYTES,
    );
  }

  close(): void {
    this.db.close();
  }
}

interface ReadSize {
  readonly eventCount: number;
  readonly totalBytes: number;
  readonly maxEventBytes: number;
}

function assertWithinReadLimits(size: ReadSize): void {
  if (
    !Number.isSafeInteger(size.eventCount) ||
    !Number.isSafeInteger(size.totalBytes) ||
    !Number.isSafeInteger(size.maxEventBytes) ||
    size.eventCount > MAX_JOURNAL_READ_EVENTS ||
    size.totalBytes > MAX_JOURNAL_READ_TOTAL_BYTES ||
    size.maxEventBytes > MAX_JOURNAL_EVENT_BYTES
  ) {
    throw new Error("event journal read limit exceeded");
  }
}

function assertProjectedAppend(
  size: ReadSize,
  appendedCount: number,
  appendedBytes: number,
): void {
  assertWithinReadLimits(size);
  if (
    size.eventCount + appendedCount > MAX_JOURNAL_READ_EVENTS ||
    size.totalBytes + appendedBytes > MAX_JOURNAL_READ_TOTAL_BYTES
  ) {
    throw new Error("event journal append limit exceeded");
  }
}

function assertFileWithinLimit(path: string, limit: number): void {
  try {
    if (statSync(path).size > limit) {
      throw new Error("event journal file size limit exceeded");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

function eventBytes(event: {
  readonly eventId: string;
  readonly streamId: string;
  readonly type: string;
  readonly payload: string;
  readonly causationId: string | null;
  readonly correlationId: string;
  readonly recordedAt: string;
}): number {
  return Buffer.byteLength(event.eventId) +
    Buffer.byteLength(event.streamId) +
    Buffer.byteLength(event.type) +
    Buffer.byteLength(event.payload) +
    Buffer.byteLength(event.causationId ?? "") +
    Buffer.byteLength(event.correlationId) +
    Buffer.byteLength(event.recordedAt);
}

function toStoredEvent(row: EventRow): StoredEvent {
  return {
    streamId: row.stream_id,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    eventId: row.event_id,
    streamVersion: row.stream_version,
    globalPosition: row.global_position,
    recordedAt: row.recorded_at,
  };
}
