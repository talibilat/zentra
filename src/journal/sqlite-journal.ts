import { randomUUID } from "node:crypto";

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

interface ReadSizeRow {
  readonly event_count: number;
  readonly total_bytes: number;
  readonly max_event_bytes: number;
}

// These bounds contain the supervisor's maximum escaped output plus repeated
// prepared, observed, cleanup, and completion evidence for the local MVP.
export const MAX_JOURNAL_READ_EVENTS = 10_000;
export const MAX_JOURNAL_EVENT_BYTES = 8 * 1024 * 1024;
export const MAX_JOURNAL_READ_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_JOURNAL_EVENT_PAYLOAD_BYTES = MAX_JOURNAL_EVENT_BYTES;
export const MAX_JOURNAL_READ_TOTAL_PAYLOAD_BYTES = MAX_JOURNAL_READ_TOTAL_BYTES;

const EVENT_BYTES_SQL = `
  length(CAST(event_id AS BLOB)) +
  length(CAST(stream_id AS BLOB)) +
  length(CAST(type AS BLOB)) +
  length(CAST(payload AS BLOB)) +
  length(CAST(COALESCE(causation_id, '') AS BLOB)) +
  length(CAST(correlation_id AS BLOB)) +
  length(CAST(recorded_at AS BLOB))
`;

export class SqliteEventJournal implements EventJournal {
  private readonly db: Database.Database;
  private readonly readOnly: boolean;

  static openReadOnly(databasePath: string): SqliteEventJournal {
    return new SqliteEventJournal(databasePath, { readOnly: true });
  }

  constructor(
    databasePath: string,
    options: { readonly readOnly?: boolean } = {},
  ) {
    this.readOnly = options.readOnly ?? false;
    this.db = this.readOnly
      ? new Database(databasePath, { readonly: true, fileMustExist: true })
      : new Database(databasePath);
    if (this.readOnly) return;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
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
  }

  append(
    streamId: StreamId,
    expectedVersion: number,
    events: readonly NewEvent<string, unknown>[],
  ): readonly StoredEvent[] {
    if (this.readOnly) throw new Error("event journal is read-only");
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

      const streamSize = this.readSize("stream_id = ?", streamId);
      const globalSize = this.readSize("1 = 1");
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
      throw error;
    }
  }

  readStream(streamId: StreamId, afterVersion = 0): readonly StoredEvent[] {
    const rows = this.db.transaction(() => {
      const size = this.readSize(
        "stream_id = ? AND stream_version > ?",
        streamId,
        afterVersion,
      );
      assertWithinReadLimits(size);
      return this.db
        .prepare(
          `SELECT * FROM events
           WHERE stream_id = ? AND stream_version > ?
           ORDER BY stream_version ASC`,
        )
        .all(streamId, afterVersion) as EventRow[];
    })();
    return rows.map(toStoredEvent);
  }

  readAll(afterPosition = 0): readonly StoredEvent[] {
    const rows = this.db.transaction(() => {
      const size = this.readSize("global_position > ?", afterPosition);
      assertWithinReadLimits(size);
      return this.db
        .prepare(
          `SELECT * FROM events
           WHERE global_position > ?
           ORDER BY global_position ASC`,
        )
        .all(afterPosition) as EventRow[];
    })();
    return rows.map(toStoredEvent);
  }

  private readSize(where: string, ...parameters: readonly unknown[]): ReadSizeRow {
    return this.db.prepare(`
      SELECT
        COUNT(*) AS event_count,
        COALESCE(SUM(${EVENT_BYTES_SQL}), 0) AS total_bytes,
        COALESCE(MAX(${EVENT_BYTES_SQL}), 0) AS max_event_bytes
      FROM events
      WHERE ${where}
    `).get(...parameters) as ReadSizeRow;
  }

  close(): void {
    this.db.close();
  }
}

function assertWithinReadLimits(size: ReadSizeRow): void {
  if (
    !Number.isSafeInteger(size.event_count) ||
    !Number.isSafeInteger(size.total_bytes) ||
    !Number.isSafeInteger(size.max_event_bytes) ||
    size.event_count > MAX_JOURNAL_READ_EVENTS ||
    size.total_bytes > MAX_JOURNAL_READ_TOTAL_BYTES ||
    size.max_event_bytes > MAX_JOURNAL_EVENT_BYTES
  ) {
    throw new Error("event journal read limit exceeded");
  }
}

function assertProjectedAppend(
  size: ReadSizeRow,
  appendedCount: number,
  appendedBytes: number,
): void {
  assertWithinReadLimits(size);
  if (
    size.event_count + appendedCount > MAX_JOURNAL_READ_EVENTS ||
    size.total_bytes + appendedBytes > MAX_JOURNAL_READ_TOTAL_BYTES
  ) {
    throw new Error("event journal append limit exceeded");
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
