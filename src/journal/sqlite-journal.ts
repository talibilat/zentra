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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const streamRow = this.db
        .prepare("SELECT current_version FROM streams WHERE stream_id = ?")
        .get(streamId) as { current_version: number } | undefined;
      const actualVersion = streamRow?.current_version ?? 0;
      if (actualVersion !== expectedVersion) {
        throw new Error(`expected version ${expectedVersion}, actual ${actualVersion}`);
      }

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
      for (const event of events) {
        version += 1;
        const eventId = randomUUID();
        const recordedAt = new Date().toISOString();
        const result = insertEvent.run(
          eventId,
          streamId,
          version,
          event.type,
          JSON.stringify(event.payload),
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
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE stream_id = ? AND stream_version > ?
         ORDER BY stream_version ASC`,
      )
      .all(streamId, afterVersion) as EventRow[];
    return rows.map(toStoredEvent);
  }

  readAll(afterPosition = 0): readonly StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE global_position > ?
         ORDER BY global_position ASC`,
      )
      .all(afterPosition) as EventRow[];
    return rows.map(toStoredEvent);
  }

  close(): void {
    this.db.close();
  }
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
