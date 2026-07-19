import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import type { NewEvent, StoredEvent } from "../contracts/event.js";
import type { StreamId } from "../contracts/ids.js";
import type {
  AtomicAppend,
  DurablePagedEventJournal,
  GlobalEventPage,
  JournalPageLimits,
  ProjectionClaim,
  ProjectionCursor,
  StreamEventPage,
} from "./journal.js";
const DURABLE_JOURNAL_CAPABILITY = Symbol.for("zentra.durable-paged-event-journal.v1");
const ATOMIC_JOURNAL_CAPABILITY = Symbol.for("zentra.atomic-event-journal.v1");

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
  readonly global_position: number;
  readonly stream_version: number;
  readonly event_bytes: number;
}

interface ProjectionRow {
  readonly name: string;
  readonly position: number;
  readonly claim_id: string | null;
  readonly claim_through_position: number | null;
  readonly claim_event_count: number | null;
  readonly claim_bytes: number | null;
  readonly claim_digest: string | null;
  readonly claimant_id: string | null;
  readonly replay_count: number;
}

interface PageSelection {
  readonly count: number;
  readonly bytes: number;
  readonly through: number;
}

export const MAX_JOURNAL_READ_EVENTS = 10_000;
export const MAX_JOURNAL_EVENT_BYTES = 8 * 1024 * 1024;
export const MAX_JOURNAL_READ_TOTAL_BYTES = 64 * 1024 * 1024;
// The database and shared-memory values are compatibility exports only.
// Historical files are no longer admitted or rejected by total file size.
export const MAX_JOURNAL_DATABASE_BYTES = 128 * 1024 * 1024;
export const MAX_JOURNAL_WAL_BYTES = 128 * 1024 * 1024;
export const MAX_JOURNAL_SHARED_MEMORY_BYTES = 8 * 1024 * 1024;

const DEFAULT_PAGE_LIMITS: JournalPageLimits = {
  maxEvents: 1_000,
  maxBytes: 16 * 1024 * 1024,
};
const SQLITE_BUSY_TIMEOUT_MS = 1_000;
const SQLITE_OPERATION_TIMEOUT_MS = 1_000;
const SQLITE_OPERATION_TIMEOUT_NS = BigInt(SQLITE_OPERATION_TIMEOUT_MS) * 1_000_000n;
const SCHEMA_VERSION = 6;
const PROJECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GLOBAL_HEAD_TRIGGER_SQL = `
  CREATE TRIGGER events_update_global_head
  AFTER INSERT ON events
  BEGIN
    UPDATE journal_metadata
    SET global_position = NEW.global_position
    WHERE singleton = 1 AND global_position < NEW.global_position;
  END
`;

const EVENT_BYTES_SQL = `
  length(CAST(event_id AS BLOB)) +
  length(CAST(stream_id AS BLOB)) +
  length(CAST(type AS BLOB)) +
  length(CAST(payload AS BLOB)) +
  length(CAST(COALESCE(causation_id, '') AS BLOB)) +
  length(CAST(correlation_id AS BLOB)) +
  length(CAST(recorded_at AS BLOB))
`;

const EVENT_COLUMNS = `
  event_id, stream_id, stream_version, global_position, type, payload,
  causation_id, correlation_id, recorded_at
`;

const STREAM_PAGE_SIZE_SQL = `
  SELECT global_position, stream_version, ${EVENT_BYTES_SQL} AS event_bytes
  FROM events
  WHERE stream_id = ? AND stream_version > ? AND zentra_operation_guard()
  ORDER BY stream_version ASC
  LIMIT ?
`;
const STREAM_PAGE_ROWS_SQL = `
  SELECT ${EVENT_COLUMNS}
  FROM events
  WHERE stream_id = ? AND stream_version > ? AND stream_version <= ?
    AND zentra_operation_guard()
  ORDER BY stream_version ASC
  LIMIT ?
`;
const GLOBAL_PAGE_SIZE_SQL = `
  SELECT global_position, stream_version, ${EVENT_BYTES_SQL} AS event_bytes
  FROM events
  WHERE global_position > ? AND zentra_operation_guard()
  ORDER BY global_position ASC
  LIMIT ?
`;
const GLOBAL_PAGE_ROWS_SQL = `
  SELECT ${EVENT_COLUMNS}
  FROM events
  WHERE global_position > ? AND global_position <= ? AND zentra_operation_guard()
  ORDER BY global_position ASC
  LIMIT ?
`;
const GLOBAL_RANGE_SIZE_SQL = `
  SELECT global_position, stream_version, ${EVENT_BYTES_SQL} AS event_bytes
  FROM events
  WHERE global_position > ? AND global_position <= ? AND zentra_operation_guard()
  ORDER BY global_position ASC
  LIMIT ?
`;

export class SqliteEventJournal implements DurablePagedEventJournal {
  readonly [DURABLE_JOURNAL_CAPABILITY] = true;
  readonly [ATOMIC_JOURNAL_CAPABILITY] = true;
  private readonly db: Database.Database;
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
    this.readOnly = options.readOnly ?? false;
    this.db = this.readOnly
      ? new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
        timeout: SQLITE_BUSY_TIMEOUT_MS,
      })
      : new Database(databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
    try {
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
        this.assertCurrentSchema();
      } else {
        this.assertMigrationTriggerIntegrity();
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.db.pragma(`journal_size_limit = ${MAX_JOURNAL_WAL_BYTES}`);
        this.migrate();
        this.assertCurrentSchema();
      }
      this.assertBoundedReadPlans();
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
    return this.appendAtomically([{ streamId, expectedVersion, events }]);
  }

  appendAtomically(writes: readonly AtomicAppend[]): readonly StoredEvent[] {
    this.assertWritable();
    if (writes.length === 0) throw new Error("atomic append requires at least one stream");
    if (writes.length > MAX_JOURNAL_READ_EVENTS) throw new Error("event journal append limit exceeded");
    if (new Set(writes.map((write) => write.streamId)).size !== writes.length) {
      throw new Error("atomic append stream identities must be unique");
    }
    const prepared = writes.map((write) => {
      assertPosition(write.expectedVersion, "expected version");
      const serialized = write.events.map((event) => {
        if (event.streamId !== write.streamId) {
          throw new Error("event streamId does not match append stream");
        }
        const payload = JSON.stringify(event.payload);
        if (payload === undefined) throw new Error("event payload must be JSON-serializable");
        const bytes = eventBytes({
          eventId: event.eventId ?? "00000000-0000-4000-8000-000000000000",
          streamId: write.streamId,
          type: event.type,
          payload,
          causationId: event.causationId,
          correlationId: event.correlationId,
          recordedAt: "0000-00-00T00:00:00.000Z",
        });
        if (bytes > MAX_JOURNAL_EVENT_BYTES) throw new Error("event journal append limit exceeded");
        return { event, payload, bytes };
      });
      return { ...write, serialized };
    });
    const eventCount = prepared.reduce((total, write) => total + write.serialized.length, 0);
    const batchBytes = prepared.reduce(
      (total, write) => total + write.serialized.reduce((sum, item) => sum + item.bytes, 0),
      0,
    );
    if (eventCount > MAX_JOURNAL_READ_EVENTS || batchBytes > MAX_JOURNAL_READ_TOTAL_BYTES) {
      throw new Error("event journal append limit exceeded");
    }

    const append = this.db.transaction(() => {
      const versions = new Map<string, number>();
      for (const write of prepared) {
        const streamRow = this.db.prepare(
          "SELECT current_version FROM streams WHERE stream_id = ?",
        ).get(write.streamId) as { current_version: number } | undefined;
        const actualVersion = streamRow?.current_version ?? 0;
        if (actualVersion !== write.expectedVersion) {
          throw new Error(`expected version ${write.expectedVersion}, actual ${actualVersion}`);
        }
        versions.set(write.streamId, actualVersion);
      }
      const insert = this.db.prepare(`
        INSERT INTO events (
          event_id, stream_id, stream_version, type, payload,
          causation_id, correlation_id, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const stored: StoredEvent[] = [];
      for (const write of prepared) {
        const exists = this.db.prepare("SELECT 1 FROM streams WHERE stream_id = ?").get(write.streamId);
        if (exists === undefined) {
          this.db.prepare("INSERT INTO streams (stream_id, current_version) VALUES (?, 0)").run(write.streamId);
        }
        let version = versions.get(write.streamId)!;
        for (const item of write.serialized) {
          version += 1;
          const eventId = item.event.eventId ?? randomUUID();
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(eventId)) {
            throw new Error("event ID must be a canonical UUIDv4");
          }
          const recordedAt = new Date().toISOString();
          const result = insert.run(
            eventId, write.streamId, version, item.event.type, item.payload,
            item.event.causationId, item.event.correlationId, recordedAt,
          );
          stored.push({
            ...item.event,
            eventId,
            streamVersion: version,
            globalPosition: Number(result.lastInsertRowid),
            recordedAt,
          });
        }
        this.db.prepare("UPDATE streams SET current_version = ? WHERE stream_id = ?")
          .run(version, write.streamId);
      }
      return stored;
    });

    return append.immediate();
  }

  readStream(streamId: StreamId, afterVersion = 0): readonly StoredEvent[] {
    const page = this.readStreamPage(streamId, afterVersion, {
      maxEvents: MAX_JOURNAL_READ_EVENTS,
      maxBytes: MAX_JOURNAL_READ_TOTAL_BYTES,
    });
    if (page.hasMore) throw new Error("event journal read limit exceeded; use readStreamPage");
    return page.events;
  }

  readAll(afterPosition = 0): readonly StoredEvent[] {
    const page = this.readAllPage(afterPosition, {
      maxEvents: MAX_JOURNAL_READ_EVENTS,
      maxBytes: MAX_JOURNAL_READ_TOTAL_BYTES,
    });
    if (page.hasMore) throw new Error("event journal read limit exceeded; use readAllPage");
    return page.events;
  }

  readStreamPage(
    streamId: StreamId,
    afterVersion = 0,
    limits: JournalPageLimits = DEFAULT_PAGE_LIMITS,
  ): StreamEventPage {
    assertPosition(afterVersion, "after version");
    const bounded = validateLimits(limits);
    return this.runRead(() => this.readStreamPageInSnapshot(streamId, afterVersion, bounded));
  }

  readAllPage(
    afterPosition = 0,
    limits: JournalPageLimits = DEFAULT_PAGE_LIMITS,
  ): GlobalEventPage {
    assertPosition(afterPosition, "after position");
    const bounded = validateLimits(limits);
    return this.runRead(() => this.readAllPageInSnapshot(afterPosition, bounded));
  }

  inspectProjectionCursor(name: string): ProjectionCursor | null {
    validateProjectionName(name);
    const row = this.projectionRow(name, false);
    return row === null ? null : this.toProjectionCursor(row);
  }

  inspectProjectionClaim(name: string): ProjectionClaim | null {
    validateProjectionName(name);
    const row = this.projectionRow(name, false);
    if (row?.claim_id === null || row === null) return null;
    const { through, count, bytes } = validateClaimMetadata(row, this.globalHead());
    const evidence = this.readClaimedRange(
      row.position,
      through,
      count,
      bytes,
      requiredDigest(row.claim_digest),
    );
    return this.toProjectionClaim(row, evidence.events, bytes, true);
  }

  ensureProjectionCursor(name: string, initialPosition: number | "head" = 0): ProjectionCursor {
    validateProjectionName(name);
    this.assertWritable();
    const ensure = this.db.transaction(() => {
      const head = this.globalHead();
      const position = initialPosition === "head" ? head : initialPosition;
      assertPosition(position, "projection initial position");
      if (position > head) {
        throw new Error("projection initial position is ahead of journal head");
      }
      this.ensureProjection(name, position);
      return this.toProjectionCursor(this.projectionRow(name));
    });
    return ensure.immediate();
  }

  claimProjection(
    name: string,
    claimantId: string,
    limits: JournalPageLimits = DEFAULT_PAGE_LIMITS,
  ): ProjectionClaim | null {
    validateProjectionName(name);
    validateClaimantId(claimantId);
    this.assertWritable();
    const bounded = validateLimits(limits);
    const claim = this.db.transaction(() => {
      this.ensureProjection(name, 0);
      let row = this.projectionRow(name);
      if (row.claim_id !== null) {
        if (row.claimant_id !== claimantId) {
          throw new Error("projection claim is owned by another claimant");
        }
        this.db.prepare(`
          UPDATE projection_cursors
          SET replay_count = replay_count + 1
          WHERE name = ?
        `).run(name);
        row = this.projectionRow(name);
        const { through, count, bytes } = validateClaimMetadata(row, this.globalHead());
        const evidence = this.readClaimedRange(
          row.position,
          through,
          count,
          bytes,
          requiredDigest(row.claim_digest),
        );
        return this.toProjectionClaim(row, evidence.events, bytes, true);
      }

      const page = this.readAllPageInSnapshot(row.position, bounded);
      if (page.events.length === 0) return null;
      const evidence = this.readClaimedRange(
        row.position,
        page.nextPosition,
        page.events.length,
        page.bytes,
        null,
      );
      const claimId = randomUUID();
      this.db.prepare(`
        UPDATE projection_cursors
        SET claim_id = ?, claim_through_position = ?, claim_event_count = ?,
            claim_bytes = ?, claim_digest = ?, claimant_id = ?
        WHERE name = ? AND claim_id IS NULL
      `).run(
        claimId,
        page.nextPosition,
        page.events.length,
        page.bytes,
        evidence.digest,
        claimantId,
        name,
      );
      row = this.projectionRow(name);
      return this.toProjectionClaim(row, page.events, page.bytes, false);
    });
    return claim.immediate();
  }

  recoverProjectionClaim(
    name: string,
    claimId: string,
    claimantId: string,
  ): ProjectionClaim {
    validateProjectionName(name);
    validateClaimantId(claimantId);
    if (!claimId) throw new Error("projection claim ID must not be empty");
    this.assertWritable();
    const recover = this.db.transaction(() => {
      const row = this.projectionRow(name);
      if (row.claim_id !== claimId) {
        throw new Error("projection claim does not match the active claim");
      }
      if (!claimantProcessIsDead(requiredClaimantId(row.claimant_id))) {
        throw new Error("projection claim owner is live or cannot be verified dead");
      }
      const { through, count, bytes } = validateClaimMetadata(row, this.globalHead());
      const evidence = this.readClaimedRange(
        row.position,
        through,
        count,
        bytes,
        requiredDigest(row.claim_digest),
      );
      const result = this.db.prepare(`
        UPDATE projection_cursors
        SET claimant_id = ?, replay_count = replay_count + 1
        WHERE name = ? AND claim_id = ? AND claimant_id = ?
      `).run(claimantId, name, claimId, row.claimant_id);
      if (result.changes !== 1) throw new Error("projection claim recovery conflict");
      return this.toProjectionClaim(
        this.projectionRow(name),
        evidence.events,
        bytes,
        true,
      );
    });
    return recover.immediate();
  }

  commitProjection(name: string, claimId: string, claimantId: string): ProjectionCursor {
    validateProjectionName(name);
    validateClaimantId(claimantId);
    if (!claimId) throw new Error("projection claim ID must not be empty");
    this.assertWritable();
    const commit = this.db.transaction(() => {
      this.ensureProjection(name, 0);
      const row = this.projectionRow(name);
      if (row.claim_id !== claimId || row.claimant_id !== claimantId) {
        throw new Error("projection claim does not match the active claim");
      }
      const { through, count, bytes } = validateClaimMetadata(row, this.globalHead());
      this.readClaimedRange(
        row.position,
        through,
        count,
        bytes,
        requiredDigest(row.claim_digest),
      );
      const result = this.db.prepare(`
        UPDATE projection_cursors
        SET position = ?, claim_id = NULL, claim_through_position = NULL,
            claim_event_count = NULL, claim_bytes = NULL
            , claim_digest = NULL, claimant_id = NULL
        WHERE name = ? AND position = ? AND claim_id = ? AND claimant_id = ?
      `).run(through, name, row.position, claimId, claimantId);
      if (result.changes !== 1) throw new Error("projection claim commit conflict");
      return this.toProjectionCursor(this.projectionRow(name));
    });
    return commit.immediate();
  }

  private readStreamPageInSnapshot(
    streamId: string,
    afterVersion: number,
    limits: JournalPageLimits,
  ): StreamEventPage {
    const stream = this.db.prepare(
      "SELECT current_version FROM streams WHERE stream_id = ?",
    ).get(streamId) as { current_version: number } | undefined;
    const head = stream?.current_version ?? 0;
    if (afterVersion > head) {
      throw new Error(`event journal cursor is ahead of stream version ${head}`);
    }
    const sizeRows = this.sizeRows(
      STREAM_PAGE_SIZE_SQL,
      [streamId, afterVersion, limits.maxEvents + 1],
    );
    const selection = selectPage(sizeRows, afterVersion, head, limits, "version");
    if (selection.count === 0) {
      return { events: [], nextVersion: afterVersion, hasMore: false, bytes: 0 };
    }
    const rows = this.eventRows(
      STREAM_PAGE_ROWS_SQL,
      [streamId, afterVersion, selection.through, selection.count],
      selection.count,
    );
    verifySequence(rows.map((row) => row.stream_version), afterVersion, "version");
    return {
      events: rows.map(toStoredEvent),
      nextVersion: selection.through,
      hasMore: selection.through < head,
      bytes: selection.bytes,
    };
  }

  private readAllPageInSnapshot(
    afterPosition: number,
    limits: JournalPageLimits,
  ): GlobalEventPage {
    const head = this.globalHead();
    const retainedThrough = this.retainedThroughPosition();
    if (afterPosition < retainedThrough) {
      throw new Error(`event journal archived history is required through global position ${retainedThrough}`);
    }
    if (afterPosition > head) {
      throw new Error(`event journal cursor is ahead of global position ${head}`);
    }
    const sizeRows = this.sizeRows(
      GLOBAL_PAGE_SIZE_SQL,
      [afterPosition, limits.maxEvents + 1],
    );
    const selection = selectPage(sizeRows, afterPosition, head, limits, "position");
    if (selection.count === 0) {
      return { events: [], nextPosition: afterPosition, hasMore: false, bytes: 0 };
    }
    const rows = this.eventRows(
      GLOBAL_PAGE_ROWS_SQL,
      [afterPosition, selection.through, selection.count],
      selection.count,
    );
    verifySequence(rows.map((row) => row.global_position), afterPosition, "position");
    return {
      events: rows.map(toStoredEvent),
      nextPosition: selection.through,
      hasMore: selection.through < head,
      bytes: selection.bytes,
    };
  }

  private readClaimedRange(
    afterPosition: number,
    throughPosition: number,
    expectedCount: number,
    expectedBytes: number,
    expectedDigest: string | null,
  ): { readonly events: readonly StoredEvent[]; readonly digest: string } {
    const sizes = this.sizeRows(
      GLOBAL_RANGE_SIZE_SQL,
      [afterPosition, throughPosition, expectedCount + 1],
    );
    verifySequence(sizes.map((row) => row.global_position), afterPosition, "position");
    if (
      sizes.length !== expectedCount ||
      sizes.at(-1)?.global_position !== throughPosition ||
      sizes.some((row) => row.event_bytes > MAX_JOURNAL_EVENT_BYTES) ||
      sizes.reduce((total, row) => total + row.event_bytes, 0) !== expectedBytes
    ) {
      throw new Error("event journal projection claim is corrupt");
    }
    const rows = this.eventRows(
      GLOBAL_PAGE_ROWS_SQL,
      [afterPosition, throughPosition, expectedCount + 1],
      expectedCount + 1,
    );
    verifySequence(rows.map((row) => row.global_position), afterPosition, "position");
    if (
      rows.length !== expectedCount ||
      rows.at(-1)?.global_position !== throughPosition ||
      rows.reduce((total, row) => total + rowBytes(row), 0) !== expectedBytes
    ) {
      throw new Error("event journal projection claim is corrupt");
    }
    const digest = digestEventRows(rows);
    if (expectedDigest !== null && digest !== expectedDigest) {
      throw new Error("event journal projection claim digest does not match");
    }
    return { events: rows.map(toStoredEvent), digest };
  }

  private sizeRows(sql: string, parameters: readonly unknown[]): readonly EventSizeRow[] {
    this.beginBoundedOperation(Number(parameters.at(-1)));
    return this.db.prepare(sql).all(...parameters) as EventSizeRow[];
  }

  private eventRows(
    sql: string,
    parameters: readonly unknown[],
    maximumRows: number,
  ): readonly EventRow[] {
    this.beginBoundedOperation(maximumRows);
    return this.db.prepare(sql).all(...parameters) as EventRow[];
  }

  private runRead<T>(read: () => T): T {
    this.operationInterrupted = false;
    try {
      return this.db.transaction(read)();
    } catch (error) {
      if (this.operationInterrupted) {
        throw new Error("event journal read limit exceeded");
      }
      throw error;
    }
  }

  private beginBoundedOperation(maximumRows: number): void {
    this.operationDeadline = process.hrtime.bigint() + SQLITE_OPERATION_TIMEOUT_NS;
    this.operationInterrupted = false;
    this.operationRowsRemaining = maximumRows;
  }

  private globalHead(): number {
    const row = this.db.prepare(
      "SELECT global_position FROM journal_metadata WHERE singleton = 1",
    ).get() as { global_position: number } | undefined;
    if (row === undefined || !Number.isSafeInteger(row.global_position) || row.global_position < 0) {
      throw new Error("event journal metadata is corrupt");
    }
    const selected = this.db.prepare(
      "SELECT global_position FROM events ORDER BY global_position DESC LIMIT 1",
    ).get() as { global_position: number } | undefined;
    const actual = selected?.global_position ?? 0;
    if (actual !== row.global_position) {
      throw new Error("event journal global head metadata disagrees with events");
    }
    return row.global_position;
  }

  private ensureProjection(name: string, initialPosition: number): void {
    const retainedThrough = this.retainedThroughPosition();
    if (initialPosition < retainedThrough) {
      throw new Error(`projection initial position is below retained journal position ${retainedThrough}`);
    }
    this.db.prepare(`
      INSERT INTO projection_cursors (name, position)
      VALUES (?, ?)
      ON CONFLICT(name) DO NOTHING
    `).run(name, initialPosition);
  }

  private projectionRow(name: string): ProjectionRow;
  private projectionRow(name: string, required: false): ProjectionRow | null;
  private projectionRow(name: string, required = true): ProjectionRow | null {
    const row = this.db.prepare(`
      SELECT name, position, claim_id, claim_through_position,
             claim_event_count, claim_bytes, claim_digest, claimant_id, replay_count
      FROM projection_cursors WHERE name = ?
    `).get(name) as ProjectionRow | undefined;
    if (row === undefined && required) throw new Error("projection cursor is missing");
    return row ?? null;
  }

  private toProjectionCursor(row: ProjectionRow): ProjectionCursor {
    const head = this.globalHead();
    if (!Number.isSafeInteger(row.position) || row.position < 0) {
      throw new Error("projection cursor position must be a nonnegative safe integer");
    }
    if (!Number.isSafeInteger(row.replay_count) || row.replay_count < 0) {
      throw new Error("projection cursor replay count must be a nonnegative safe integer");
    }
    if (row.position > head) throw new Error("projection cursor is ahead of journal head");
    return {
      name: row.name,
      position: row.position,
      highWaterPosition: head,
      lag: head - row.position,
      replayCount: row.replay_count,
      activeClaimId: row.claim_id,
    };
  }

  private toProjectionClaim(
    row: ProjectionRow,
    events: readonly StoredEvent[],
    bytes: number,
    replayed: boolean,
  ): ProjectionClaim {
    const through = requiredInteger(row.claim_through_position, "projection claim range");
    const head = this.globalHead();
    return {
      name: row.name,
      claimId: row.claim_id!,
      afterPosition: row.position,
      throughPosition: through,
      events,
      bytes,
      highWaterPosition: head,
      lag: head - row.position,
      replayed,
      replayCount: row.replay_count,
      claimantId: requiredClaimantId(row.claimant_id),
    };
  }

  private migrate(): void {
    const migrate = this.db.transaction(() => {
      const version = this.db.pragma("user_version", { simple: true }) as number;
      if (version > 0) this.assertGlobalHeadTrigger();
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
      if (version > SCHEMA_VERSION) {
        throw new Error(`event journal schema version ${version} is not supported`);
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS journal_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          global_position INTEGER NOT NULL CHECK (global_position >= 0),
          retained_through_position INTEGER NOT NULL DEFAULT 0
            CHECK (retained_through_position >= 0 AND retained_through_position <= global_position),
          journal_id TEXT,
          archive_head_position INTEGER NOT NULL DEFAULT 0 CHECK (archive_head_position >= 0),
          archive_head_manifest_sha256 TEXT,
          archive_segment_count INTEGER NOT NULL DEFAULT 0 CHECK (archive_segment_count >= 0)
        );
        INSERT OR IGNORE INTO journal_metadata (singleton, global_position)
        SELECT 1, COALESCE(MAX(global_position), 0) FROM events
        ;
        CREATE TABLE IF NOT EXISTS projection_cursors (
          name TEXT PRIMARY KEY,
          position INTEGER NOT NULL CHECK (position >= 0),
          claim_id TEXT UNIQUE,
          claim_through_position INTEGER,
          claim_event_count INTEGER,
          claim_bytes INTEGER,
          claim_digest TEXT,
          claimant_id TEXT,
          replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
          CHECK (
            (claim_id IS NULL AND claim_through_position IS NULL AND
             claim_event_count IS NULL AND claim_bytes IS NULL AND claim_digest IS NULL AND
             claimant_id IS NULL) OR
            (claim_id IS NOT NULL AND claim_through_position > position AND
             claim_event_count > 0 AND claim_bytes > 0 AND claim_digest IS NOT NULL AND
             claimant_id IS NOT NULL)
          )
        );
        CREATE TABLE IF NOT EXISTS retention_operations (
          operation_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('archive', 'prune_request', 'prune', 'maintenance', 'restore')),
          state TEXT NOT NULL CHECK (state IN (
            'publishing', 'authorized', 'effect_applied', 'consumed', 'completed', 'failed'
          )),
          from_position INTEGER,
          through_position INTEGER NOT NULL CHECK (through_position >= 0),
          segment_id TEXT,
          segment_sha256 TEXT,
          manifest_sha256 TEXT,
          request_id TEXT,
          operator_id TEXT,
          maintenance_evidence TEXT,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS retention_one_active_operation
        ON retention_operations ((1))
        WHERE state IN ('publishing', 'authorized', 'effect_applied');
        CREATE INDEX IF NOT EXISTS retention_operations_request
        ON retention_operations (request_id, kind, state);
        CREATE INDEX IF NOT EXISTS retention_operations_state
        ON retention_operations (state, created_at);
      `);
      if (version > 0 && !tableHasColumn(this.db, "journal_metadata", "retained_through_position")) {
        this.db.exec(`
          ALTER TABLE journal_metadata ADD COLUMN retained_through_position INTEGER NOT NULL DEFAULT 0
            CHECK (retained_through_position >= 0)
        `);
      }
      if (!tableHasColumn(this.db, "journal_metadata", "journal_id")) {
        this.db.exec("ALTER TABLE journal_metadata ADD COLUMN journal_id TEXT");
      }
      if (!tableHasColumn(this.db, "journal_metadata", "archive_head_position")) {
        this.db.exec("ALTER TABLE journal_metadata ADD COLUMN archive_head_position INTEGER NOT NULL DEFAULT 0 CHECK (archive_head_position >= 0)");
      }
      if (!tableHasColumn(this.db, "journal_metadata", "archive_head_manifest_sha256")) {
        this.db.exec("ALTER TABLE journal_metadata ADD COLUMN archive_head_manifest_sha256 TEXT");
      }
      if (!tableHasColumn(this.db, "journal_metadata", "archive_segment_count")) {
        this.db.exec("ALTER TABLE journal_metadata ADD COLUMN archive_segment_count INTEGER NOT NULL DEFAULT 0 CHECK (archive_segment_count >= 0)");
      }
      if (!tableHasColumn(this.db, "retention_operations", "maintenance_evidence")) {
        this.db.exec("ALTER TABLE retention_operations ADD COLUMN maintenance_evidence TEXT");
      }
      if (version > 0 && version < 6) {
        this.db.exec(`
          DROP INDEX IF EXISTS retention_one_active_operation;
          DROP INDEX IF EXISTS retention_operations_request;
          DROP INDEX IF EXISTS retention_operations_state;
          ALTER TABLE retention_operations RENAME TO retention_operations_before_restore;
          CREATE TABLE retention_operations (
            operation_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN (
              'archive', 'prune_request', 'prune', 'maintenance', 'restore'
            )),
            state TEXT NOT NULL CHECK (state IN (
              'publishing', 'authorized', 'effect_applied', 'consumed', 'completed', 'failed'
            )),
            from_position INTEGER,
            through_position INTEGER NOT NULL CHECK (through_position >= 0),
            segment_id TEXT,
            segment_sha256 TEXT,
            manifest_sha256 TEXT,
            request_id TEXT,
            operator_id TEXT,
            maintenance_evidence TEXT,
            created_at TEXT NOT NULL
          );
          INSERT INTO retention_operations (
            operation_id, kind, state, from_position, through_position, segment_id,
            segment_sha256, manifest_sha256, request_id, operator_id,
            maintenance_evidence, created_at
          )
          SELECT operation_id, kind, state, from_position, through_position, segment_id,
            segment_sha256, manifest_sha256, request_id, operator_id,
            maintenance_evidence, created_at
          FROM retention_operations_before_restore;
          DROP TABLE retention_operations_before_restore;
          CREATE UNIQUE INDEX retention_one_active_operation
          ON retention_operations ((1))
          WHERE state IN ('publishing', 'authorized', 'effect_applied');
          CREATE INDEX retention_operations_request
          ON retention_operations (request_id, kind, state);
          CREATE INDEX retention_operations_state
          ON retention_operations (state, created_at);
        `);
      }
      const identity = this.db.prepare(
        "SELECT journal_id FROM journal_metadata WHERE singleton = 1",
      ).get() as { readonly journal_id: string | null };
      if (identity.journal_id === null) {
        this.db.prepare("UPDATE journal_metadata SET journal_id = ? WHERE singleton = 1")
          .run(randomUUID());
      }
      if (version === 1) {
        this.db.exec("ALTER TABLE projection_cursors ADD COLUMN claim_digest TEXT");
      }
      const addedClaimantColumn = !tableHasColumn(
        this.db,
        "projection_cursors",
        "claimant_id",
      );
      if (addedClaimantColumn) {
        this.db.exec("ALTER TABLE projection_cursors ADD COLUMN claimant_id TEXT");
        this.db.prepare(`
          UPDATE projection_cursors SET claimant_id = 'migration:unowned'
          WHERE claim_id IS NOT NULL
        `).run();
      }
      if (version === 1) {
        const active = this.db.prepare(`
          SELECT name, position, claim_id, claim_through_position,
                 claim_event_count, claim_bytes, claim_digest, claimant_id, replay_count
          FROM projection_cursors WHERE claim_id IS NOT NULL
        `).all() as ProjectionRow[];
        for (const row of active) {
          const evidence = this.readClaimedRange(
            row.position,
            requiredInteger(row.claim_through_position, "projection claim range"),
            requiredInteger(row.claim_event_count, "projection claim count"),
            requiredInteger(row.claim_bytes, "projection claim bytes"),
            null,
          );
          this.db.prepare(
            "UPDATE projection_cursors SET claim_digest = ?, claimant_id = ? WHERE name = ?",
          ).run(evidence.digest, "migration:unowned", row.name);
        }
      }
      const trigger = this.db.prepare(`
        SELECT 1 FROM sqlite_master
        WHERE type = 'trigger' AND name = 'events_update_global_head'
      `).get();
      if (trigger === undefined) this.db.exec(GLOBAL_HEAD_TRIGGER_SQL);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    migrate.immediate();
  }

  private assertMigrationTriggerIntegrity(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 0) this.assertGlobalHeadTrigger();
  }

  private assertCurrentSchema(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version !== SCHEMA_VERSION) {
      throw new Error("event journal schema migration required; open read-write first");
    }
    const metadata = this.db.prepare(`
      SELECT global_position, retained_through_position, journal_id,
             archive_head_position, archive_head_manifest_sha256, archive_segment_count
      FROM journal_metadata WHERE singleton = 1
    `).get() as {
      readonly global_position: number;
      readonly journal_id: string | null;
      readonly archive_head_position: number;
      readonly archive_head_manifest_sha256: string | null;
      readonly archive_segment_count: number;
    } | undefined;
    if (metadata === undefined || metadata.journal_id === null ||
      !/^[0-9a-f-]{36}$/.test(metadata.journal_id) ||
      !Number.isSafeInteger(metadata.global_position) || metadata.global_position < 0 ||
      !Number.isSafeInteger(metadata.archive_head_position) || metadata.archive_head_position < 0 ||
      metadata.archive_head_position > metadata.global_position ||
      !Number.isSafeInteger(metadata.archive_segment_count) || metadata.archive_segment_count < 0 ||
      ((metadata.archive_head_position === 0 || metadata.archive_segment_count === 0) !==
        (metadata.archive_head_position === 0 && metadata.archive_segment_count === 0)) ||
      (metadata.archive_segment_count === 0 ? metadata.archive_head_manifest_sha256 !== null :
        metadata.archive_head_manifest_sha256 === null || !/^[a-f0-9]{64}$/.test(metadata.archive_head_manifest_sha256))) {
      throw new Error("event journal archive metadata is corrupt");
    }
    this.db.prepare(
      "SELECT position, claim_digest, claimant_id FROM projection_cursors LIMIT 1",
    ).get();
    this.assertGlobalHeadTrigger();
    this.globalHead();
    this.retainedThroughPosition();
  }

  private retainedThroughPosition(): number {
    const row = this.db.prepare(
      "SELECT retained_through_position FROM journal_metadata WHERE singleton = 1",
    ).get() as { readonly retained_through_position: number } | undefined;
    if (row === undefined || !Number.isSafeInteger(row.retained_through_position) ||
      row.retained_through_position < 0 || row.retained_through_position > this.globalHead()) {
      throw new Error("event journal retained position metadata is corrupt");
    }
    return row.retained_through_position;
  }

  private assertBoundedReadPlans(): void {
    const streamPlan = this.db.prepare(`EXPLAIN QUERY PLAN ${STREAM_PAGE_SIZE_SQL}`).all(
      "",
      0,
      1,
    ) as Array<{ detail: string }>;
    const globalPlan = this.db.prepare(`EXPLAIN QUERY PLAN ${GLOBAL_PAGE_SIZE_SQL}`).all(
      0,
      1,
    ) as Array<{ detail: string }>;
    if (
      !/\(stream_id=\? AND stream_version>\?\)/i.test(
        streamPlan.map((row) => row.detail).join(" "),
      ) ||
      !/SEARCH events USING INTEGER PRIMARY KEY \(rowid>\?\)/i.test(
        globalPlan.map((row) => row.detail).join(" "),
      )
    ) {
      throw new Error("event journal schema does not support bounded reads");
    }
  }

  private assertGlobalHeadTrigger(): void {
    const row = this.db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'events_update_global_head'
    `).get() as { sql: string | null } | undefined;
    if (
      row?.sql === null || row?.sql === undefined ||
      normalizeSql(row.sql) !== normalizeSql(GLOBAL_HEAD_TRIGGER_SQL)
    ) {
      throw new Error("event journal global-head trigger is missing or corrupt");
    }
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error("event journal is read-only");
  }

  close(): void {
    this.db.close();
  }
}

function validateLimits(limits: JournalPageLimits): JournalPageLimits {
  if (
    !Number.isSafeInteger(limits.maxEvents) || limits.maxEvents <= 0 ||
    limits.maxEvents > MAX_JOURNAL_READ_EVENTS
  ) {
    throw new Error(`journal page maxEvents must be between 1 and ${MAX_JOURNAL_READ_EVENTS}`);
  }
  if (
    !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0 ||
    limits.maxBytes > MAX_JOURNAL_READ_TOTAL_BYTES
  ) {
    throw new Error(`journal page maxBytes must be between 1 and ${MAX_JOURNAL_READ_TOTAL_BYTES}`);
  }
  return limits;
}

function selectPage(
  rows: readonly EventSizeRow[],
  after: number,
  head: number,
  limits: JournalPageLimits,
  kind: "position" | "version",
): PageSelection {
  let expected = after + 1;
  let bytes = 0;
  let count = 0;
  let through = after;
  for (const row of rows) {
    const value = kind === "position" ? row.global_position : row.stream_version;
    if (value > head) {
      throw new Error(`event journal selected ${kind} ${value} exceeds head ${head}`);
    }
    if (value !== expected) {
      throw new Error(`event journal gap at ${kind} ${expected}`);
    }
    if (!Number.isSafeInteger(row.event_bytes) || row.event_bytes <= 0) {
      throw new Error("event journal row size is corrupt");
    }
    if (row.event_bytes > MAX_JOURNAL_EVENT_BYTES) {
      throw new Error("event journal event limit exceeded");
    }
    if (count === limits.maxEvents || bytes + row.event_bytes > limits.maxBytes) break;
    count += 1;
    bytes += row.event_bytes;
    through = value;
    expected += 1;
  }
  if (count === 0 && head > after) {
    if (rows.length === 0) throw new Error(`event journal gap at ${kind} ${expected}`);
    throw new Error("journal page maxBytes is smaller than the next event");
  }
  return { count, bytes, through };
}

function verifySequence(
  values: readonly number[],
  after: number,
  kind: "position" | "version",
): void {
  let expected = after + 1;
  for (const value of values) {
    if (value !== expected) throw new Error(`event journal gap at ${kind} ${expected}`);
    expected += 1;
  }
}

function eventBytes(input: {
  readonly eventId: string;
  readonly streamId: string;
  readonly type: string;
  readonly payload: string;
  readonly causationId: string | null;
  readonly correlationId: string;
  readonly recordedAt: string;
}): number {
  return Buffer.byteLength(input.eventId) +
    Buffer.byteLength(input.streamId) +
    Buffer.byteLength(input.type) +
    Buffer.byteLength(input.payload) +
    Buffer.byteLength(input.causationId ?? "") +
    Buffer.byteLength(input.correlationId) +
    Buffer.byteLength(input.recordedAt);
}

function rowBytes(row: EventRow): number {
  return eventBytes({
    eventId: row.event_id,
    streamId: row.stream_id,
    type: row.type,
    payload: row.payload,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    recordedAt: row.recorded_at,
  });
}

function digestEventRows(rows: readonly EventRow[]): string {
  const digest = createHash("sha256");
  for (const row of rows) {
    digest.update(JSON.stringify([
      row.event_id,
      row.stream_id,
      row.stream_version,
      row.global_position,
      row.type,
      row.payload,
      row.causation_id,
      row.correlation_id,
      row.recorded_at,
    ]), "utf8");
    digest.update("\n", "utf8");
  }
  return digest.digest("hex");
}

function toStoredEvent(row: EventRow): StoredEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload) as unknown;
  } catch {
    throw new Error(`event journal payload is corrupt at position ${row.global_position}`);
  }
  return {
    streamId: row.stream_id,
    type: row.type,
    payload,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    eventId: row.event_id,
    streamVersion: row.stream_version,
    globalPosition: row.global_position,
    recordedAt: row.recorded_at,
  };
}

function assertPosition(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
}

function requiredInteger(value: number | null, label: string): number {
  if (!Number.isSafeInteger(value) || value === null || value < 0) {
    throw new Error(`${label} is corrupt`);
  }
  return value;
}

function requiredDigest(value: string | null): string {
  if (value === null || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("event journal projection claim digest is corrupt");
  }
  return value;
}

function requiredClaimantId(value: string | null): string {
  if (value === null) throw new Error("event journal projection claimant is corrupt");
  if (value === "migration:unowned") return value;
  validateClaimantId(value);
  return value;
}

function validateClaimantId(value: string): void {
  if (!/^process:[1-9]\d{0,9}:[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("projection claimant must be a structured process identity");
  }
}

function tableHasColumn(
  database: Database.Database,
  table: string,
  column: string,
): boolean {
  const rows = database.pragma(`table_info(${table})`) as Array<{ readonly name: string }>;
  return rows.some((row) => row.name === column);
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/g, "")
    .trim()
    .toLowerCase();
}

function validateProjectionName(name: string): void {
  if (!PROJECTION_NAME.test(name)) {
    throw new Error("projection name must be a scoped ASCII identifier");
  }
}

function validateClaimMetadata(
  row: ProjectionRow,
  head: number,
): { readonly through: number; readonly count: number; readonly bytes: number } {
  if (!Number.isSafeInteger(row.position) || row.position < 0) {
    throw new Error("projection claim cursor must be a nonnegative safe integer");
  }
  const through = row.claim_through_position;
  const count = row.claim_event_count;
  const bytes = row.claim_bytes;
  if (
    through === null || !Number.isSafeInteger(through) || through <= row.position || through > head ||
    count === null || !Number.isSafeInteger(count) || count <= 0 || count > MAX_JOURNAL_READ_EVENTS ||
    bytes === null || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_JOURNAL_READ_TOTAL_BYTES ||
    through - row.position !== count ||
    !Number.isSafeInteger(row.replay_count) || row.replay_count < 0
  ) {
    throw new Error("event journal projection claim metadata limit or range is invalid");
  }
  return { through, count, bytes };
}

function claimantProcessIsDead(claimantId: string): boolean {
  if (claimantId === "migration:unowned") return true;
  const match = /^process:(\d+):[A-Za-z0-9._:-]+$/.exec(claimantId);
  if (match === null) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}
