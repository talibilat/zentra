import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";

export const MAX_UNACKNOWLEDGED_CLEANUP_FAILURES = 128;
export const MAX_CLEANUP_FAILURE_EVENTS = 256;
export const MAX_CLEANUP_FAILURE_EVENT_BYTES = 8 * 1024;
export const MAX_CLEANUP_FAILURE_JOURNAL_BYTES = 2 * 1024 * 1024;
export const CLEANUP_FAILURE_DATABASE = ".zentra-integration-cleanup-failures.sqlite";

const CanonicalTimestampSchema = z.string().refine((value) => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}, "timestamp must be canonical ISO UTC");
const AbsolutePathSchema = z.string().min(1).max(4_096).refine(path.isAbsolute);
const CleanupFailureLeaseInputSchema = z.strictObject({
  ownerToken: z.string().min(1).max(256),
  acquiredAt: z.number().int().safe(),
  expiresAt: z.number().int().safe(),
  pid: z.number().int().positive().safe(),
  hostname: z.string().min(1).max(256),
}).refine((lease) => lease.expiresAt > lease.acquiredAt, {
  message: "cleanup failure lease expiry must follow acquisition",
});
export const CleanupFailureLeaseEvidenceSchema = z.strictObject({
  ownerToken: z.string().min(1).max(256),
  acquiredAt: z.number().int().safe(),
  expiresAt: z.number().int().safe(),
  pid: z.number().int().positive().safe(),
  hostname: z.string().min(1).max(256),
  authority: z.literal("historical_evidence_only"),
}).refine((lease) => lease.expiresAt > lease.acquiredAt, {
  message: "cleanup failure lease expiry must follow acquisition",
});
export const CleanupFailureAcknowledgementSchema = z.strictObject({
  actor: z.string().min(1).max(512),
  acknowledgedAt: CanonicalTimestampSchema,
  dispositionEvidence: z.string().min(1).max(4_096),
});
export const CleanupFailureRecordSchema = z.strictObject({
  recordId: z.string().uuid(),
  projectId: z.string().min(1).max(512),
  taskId: z.string().min(1).max(512),
  commonDirectory: AbsolutePathSchema,
  repositoryIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  integrationRef: z.string().startsWith("refs/").max(1_024),
  candidateId: z.string().min(1).max(512),
  candidatePath: AbsolutePathSchema,
  reason: z.string().min(1).max(4_096),
  recordedAt: CanonicalTimestampSchema,
  lease: CleanupFailureLeaseEvidenceSchema.nullable(),
  acknowledgement: CleanupFailureAcknowledgementSchema.nullable(),
});
export const LegacyCleanupFailureRecordSchema = z.strictObject({
  projectId: z.string().min(1).max(512),
  taskId: z.string().min(1).max(512),
  candidatePath: AbsolutePathSchema,
  reason: z.string().min(1).max(4_096),
  timestamp: CanonicalTimestampSchema,
});
export const CleanupFailureEventRecordSchema = z.union([
  CleanupFailureRecordSchema,
  LegacyCleanupFailureRecordSchema,
]);
export const CleanupFailureStoreReferenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  database: z.literal(CLEANUP_FAILURE_DATABASE),
  recordIds: z.array(z.string().uuid()).max(MAX_UNACKNOWLEDGED_CLEANUP_FAILURES)
    .refine((ids) => new Set(ids).size === ids.length, "cleanup record IDs must be unique"),
  recordsSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const NewCleanupFailureSchema = z.strictObject({
  projectId: z.string().min(1).max(512),
  taskId: z.string().min(1).max(512),
  commonDirectory: AbsolutePathSchema,
  repositoryIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  integrationRef: z.string().startsWith("refs/").max(1_024),
  candidateId: z.string().min(1).max(512),
  candidatePath: AbsolutePathSchema,
  reason: z.string().min(1).max(4_096),
  recordedAt: CanonicalTimestampSchema,
  lease: CleanupFailureLeaseInputSchema.nullable(),
});
const StoredAcknowledgedPayloadSchema = CleanupFailureAcknowledgementSchema.extend({
  recordId: z.string().uuid(),
}).strict();

export interface CleanupFailureLeaseEvidence {
  readonly ownerToken: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly pid: number;
  readonly hostname: string;
  readonly authority: "historical_evidence_only";
}

export interface CleanupFailureAcknowledgement {
  readonly actor: string;
  readonly acknowledgedAt: string;
  readonly dispositionEvidence: string;
}

export interface CleanupFailureRecord {
  readonly recordId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly commonDirectory: string;
  readonly repositoryIdentitySha256: string;
  readonly integrationRef: string;
  readonly candidateId: string;
  readonly candidatePath: string;
  readonly reason: string;
  readonly recordedAt: string;
  readonly lease: CleanupFailureLeaseEvidence | null;
  readonly acknowledgement: CleanupFailureAcknowledgement | null;
}

export interface NewCleanupFailure extends Omit<CleanupFailureRecord,
  "recordId" | "acknowledgement" | "lease"
> {
  readonly lease: Omit<CleanupFailureLeaseEvidence, "authority"> | null;
}

export interface CleanupFailureScope {
  readonly projectId?: string;
  readonly commonDirectory: string;
  readonly repositoryIdentitySha256: string;
  readonly integrationRef: string;
  readonly taskId: string;
  readonly leaseOwnerToken?: string;
}

export interface CleanupFailureJournalStats {
  readonly eventCount: number;
  readonly eventBytes: number;
  readonly unacknowledgedCount: number;
}

export type CleanupFailureStoreReference = z.infer<typeof CleanupFailureStoreReferenceSchema>;
export type CleanupFailureEventRecord = z.infer<typeof CleanupFailureEventRecordSchema>;

interface EventRow {
  readonly sequence: number;
  readonly failure_id: string;
  readonly event_type: "recorded" | "acknowledged";
  readonly payload: string;
  readonly event_bytes: number;
}

interface StoredRecordedPayload extends Omit<CleanupFailureRecord, "acknowledgement"> {}

interface StoredAcknowledgedPayload extends CleanupFailureAcknowledgement {
  readonly recordId: string;
}

export class CleanupFailureStore {
  private readonly db: Database.Database;

  static openReadOnly(databasePath: string): CleanupFailureStore {
    return new CleanupFailureStore(databasePath, { readOnly: true });
  }

  constructor(
    databasePath: string,
    options: { readonly readOnly?: boolean } = {},
  ) {
    if (!path.isAbsolute(databasePath)) {
      throw new Error("cleanup failure database path must be absolute");
    }
    const readOnly = options.readOnly ?? false;
    this.db = readOnly
      ? new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1_000 })
      : new Database(databasePath, { timeout: 1_000 });
    try {
      if (!readOnly) {
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = FULL");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS cleanup_failure_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            failure_id TEXT NOT NULL,
            event_type TEXT NOT NULL CHECK (event_type IN ('recorded', 'acknowledged')),
            payload TEXT NOT NULL,
            event_bytes INTEGER NOT NULL CHECK (event_bytes > 0)
          );
          CREATE INDEX IF NOT EXISTS cleanup_failure_events_failure
            ON cleanup_failure_events (failure_id, sequence);
        `);
      }
      this.assertWithinBounds();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  record(input: NewCleanupFailure): CleanupFailureRecord {
    encodeEvent(input);
    const canonical = NewCleanupFailureSchema.parse(input);
    const record: CleanupFailureRecord = Object.freeze({
      ...canonical,
      recordId: randomUUID(),
      lease: canonical.lease === null
        ? null
        : Object.freeze({ ...canonical.lease, authority: "historical_evidence_only" as const }),
      acknowledgement: null,
    });
    const { acknowledgement: _acknowledgement, ...payload } = record;
    const encoded = encodeEvent(payload);

    const append = this.db.transaction(() => {
      const state = this.project();
      if (state.unacknowledged.length >= MAX_UNACKNOWLEDGED_CLEANUP_FAILURES) {
        throw new Error("cleanup failure journal unacknowledged count limit reached");
      }
      this.makeCapacity(encoded.bytes, state);
      this.insert(record.recordId, "recorded", encoded);
    });
    append.immediate();
    return record;
  }

  acknowledge(input: {
    readonly recordId: string;
    readonly actor: string;
    readonly acknowledgedAt: string;
    readonly dispositionEvidence: string;
  }): CleanupFailureRecord {
    const payload = StoredAcknowledgedPayloadSchema.parse(input);
    const encoded = encodeEvent(payload);
    let result: CleanupFailureRecord | null = null;
    const append = this.db.transaction(() => {
      const state = this.project();
      const record = state.records.get(input.recordId);
      if (record === undefined) throw new Error("cleanup failure record not found");
      if (record.acknowledgement !== null) {
        throw new Error("cleanup failure record is already acknowledged");
      }
      this.makeCapacity(encoded.bytes, state, input.recordId);
      this.insert(input.recordId, "acknowledged", encoded);
      result = Object.freeze({
        ...record,
        acknowledgement: Object.freeze({
          actor: input.actor,
          acknowledgedAt: input.acknowledgedAt,
          dispositionEvidence: input.dispositionEvidence,
        }),
      });
    });
    append.immediate();
    return result!;
  }

  listUnacknowledged(scope: CleanupFailureScope): readonly CleanupFailureRecord[] {
    validateScope(scope);
    return this.matching(scope).filter((record) => record.acknowledgement === null);
  }

  getHistory(scope: CleanupFailureScope): readonly CleanupFailureRecord[] {
    validateScope(scope);
    return this.matching(scope);
  }

  readReferenced(
    scope: CleanupFailureScope,
    reference: CleanupFailureStoreReference,
  ): readonly CleanupFailureRecord[] {
    validateScope(scope);
    const canonicalReference = CleanupFailureStoreReferenceSchema.parse(reference);
    const records = this.project().records;
    return Object.freeze(canonicalReference.recordIds.map((recordId) => {
      const record = records.get(recordId);
      if (record === undefined) throw new Error("referenced cleanup failure record was not found");
      if (
        (scope.projectId !== undefined && record.projectId !== scope.projectId) ||
        record.taskId !== scope.taskId ||
        record.commonDirectory !== scope.commonDirectory ||
        record.repositoryIdentitySha256 !== scope.repositoryIdentitySha256 ||
        record.integrationRef !== scope.integrationRef ||
        (scope.leaseOwnerToken !== undefined && record.lease?.ownerToken !== scope.leaseOwnerToken)
      ) {
        throw new Error("referenced cleanup failure record contradicts its project scope");
      }
      return record;
    }));
  }

  stats(): CleanupFailureJournalStats {
    const state = this.project();
    return {
      eventCount: state.eventCount,
      eventBytes: state.eventBytes,
      unacknowledgedCount: state.unacknowledged.length,
    };
  }

  close(): void {
    this.db.close();
  }

  private matching(scope: CleanupFailureScope): readonly CleanupFailureRecord[] {
    return [...this.project().records.values()].filter((record) =>
      (scope.projectId === undefined || record.projectId === scope.projectId) &&
      record.taskId === scope.taskId &&
      record.commonDirectory === scope.commonDirectory &&
      record.repositoryIdentitySha256 === scope.repositoryIdentitySha256 &&
      record.integrationRef === scope.integrationRef &&
      (scope.leaseOwnerToken === undefined || record.lease?.ownerToken === scope.leaseOwnerToken)
    );
  }

  private makeCapacity(
    addedBytes: number,
    initial: ProjectedJournal,
    protectedFailureId?: string,
  ): void {
    let state = initial;
    while (
      state.eventCount + 1 > MAX_CLEANUP_FAILURE_EVENTS ||
      state.eventBytes + addedBytes > MAX_CLEANUP_FAILURE_JOURNAL_BYTES
    ) {
      const evictable = state.acknowledged.find((record) => record.recordId !== protectedFailureId);
      if (evictable === undefined) {
        throw new Error("cleanup failure journal capacity exhausted by unacknowledged records");
      }
      this.db.prepare("DELETE FROM cleanup_failure_events WHERE failure_id = ?")
        .run(evictable.recordId);
      state = this.project();
    }
  }

  private insert(
    failureId: string,
    eventType: EventRow["event_type"],
    encoded: { readonly json: string; readonly bytes: number },
  ): void {
    this.db.prepare(`
      INSERT INTO cleanup_failure_events (
        event_id, failure_id, event_type, payload, event_bytes
      ) VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), failureId, eventType, encoded.json, encoded.bytes);
  }

  private project(): ProjectedJournal {
    const rows = this.db.prepare(`
      SELECT sequence, failure_id, event_type, payload, event_bytes
      FROM cleanup_failure_events
      ORDER BY sequence ASC
      LIMIT ?
    `).all(MAX_CLEANUP_FAILURE_EVENTS + 1) as EventRow[];
    if (rows.length > MAX_CLEANUP_FAILURE_EVENTS) {
      throw new Error("cleanup failure journal event count limit exceeded");
    }
    const records = new Map<string, CleanupFailureRecord>();
    let eventBytes = 0;
    for (const row of rows) {
      eventBytes += row.event_bytes;
      if (eventBytes > MAX_CLEANUP_FAILURE_JOURNAL_BYTES) {
        throw new Error("cleanup failure journal byte limit exceeded");
      }
      if (Buffer.byteLength(row.payload, "utf8") !== row.event_bytes) {
        throw new Error("cleanup failure journal event byte metadata is invalid");
      }
      const payload: unknown = JSON.parse(row.payload);
      if (row.event_type === "recorded") {
        const recorded = parseRecorded(payload, row.failure_id);
        if (records.has(recorded.recordId)) {
          throw new Error("cleanup failure journal contains a duplicate record");
        }
        records.set(recorded.recordId, Object.freeze({ ...recorded, acknowledgement: null }));
      } else {
        const acknowledgement = parseAcknowledged(payload, row.failure_id);
        const record = records.get(row.failure_id);
        if (record === undefined || record.acknowledgement !== null) {
          throw new Error("cleanup failure journal acknowledgement sequence is invalid");
        }
        records.set(row.failure_id, Object.freeze({
          ...record,
          acknowledgement: Object.freeze(acknowledgement),
        }));
      }
    }
    const values = [...records.values()];
    return {
      records,
      acknowledged: values.filter((record) => record.acknowledgement !== null),
      unacknowledged: values.filter((record) => record.acknowledgement === null),
      eventCount: rows.length,
      eventBytes,
      unacknowledgedCount: values.filter((record) => record.acknowledgement === null).length,
    };
  }

  private assertWithinBounds(): void {
    const state = this.project();
    if (state.unacknowledged.length > MAX_UNACKNOWLEDGED_CLEANUP_FAILURES) {
      throw new Error("cleanup failure journal unacknowledged count limit exceeded");
    }
  }
}

interface ProjectedJournal extends CleanupFailureJournalStats {
  readonly records: ReadonlyMap<string, CleanupFailureRecord>;
  readonly acknowledged: readonly CleanupFailureRecord[];
  readonly unacknowledged: readonly CleanupFailureRecord[];
}

function encodeEvent(payload: unknown): { readonly json: string; readonly bytes: number } {
  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_CLEANUP_FAILURE_EVENT_BYTES) {
    throw new Error("cleanup failure journal event byte limit exceeded");
  }
  return { json, bytes };
}

function validateScope(scope: CleanupFailureScope): void {
  if (scope.projectId !== undefined) nonempty(scope.projectId, "cleanup scope project ID");
  if (!path.isAbsolute(scope.commonDirectory)) throw new Error("cleanup scope common directory must be absolute");
  digest(scope.repositoryIdentitySha256);
  if (!scope.integrationRef.startsWith("refs/")) throw new Error("cleanup scope integration ref must be full");
  nonempty(scope.taskId, "cleanup scope task ID");
  if (scope.leaseOwnerToken !== undefined) nonempty(scope.leaseOwnerToken, "cleanup scope lease token");
}

function parseRecorded(payload: unknown, failureId: string): StoredRecordedPayload {
  const parsed = CleanupFailureRecordSchema.safeParse(
    isObject(payload) ? { ...payload, acknowledgement: null } : payload,
  );
  if (!parsed.success || parsed.data.recordId !== failureId) {
    throw new Error("cleanup failure journal recorded payload is invalid");
  }
  const { acknowledgement: _acknowledgement, ...recorded } = parsed.data;
  return recorded;
}

function parseAcknowledged(payload: unknown, failureId: string): CleanupFailureAcknowledgement {
  const parsed = StoredAcknowledgedPayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.recordId !== failureId) {
    throw new Error("cleanup failure journal acknowledgement payload is invalid");
  }
  return {
    actor: parsed.data.actor,
    acknowledgedAt: parsed.data.acknowledgedAt,
    dispositionEvidence: parsed.data.dispositionEvidence,
  };
}

export function cleanupFailureStoreReference(
  records: readonly CleanupFailureRecord[],
): CleanupFailureStoreReference {
  const canonical = records.map((record) => CleanupFailureRecordSchema.parse(record));
  return {
    schemaVersion: 1,
    database: CLEANUP_FAILURE_DATABASE,
    recordIds: canonical.map((record) => record.recordId),
    recordsSha256: createHash("sha256")
      .update(JSON.stringify(canonical), "utf8")
      .digest("hex"),
  };
}

export function cleanupFailureDatabasePath(commonDirectory: string): string {
  if (!path.isAbsolute(commonDirectory)) {
    throw new Error("cleanup failure common directory must be absolute");
  }
  return path.join(commonDirectory, CLEANUP_FAILURE_DATABASE);
}

function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be nonempty`);
}

function digest(value: unknown): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("cleanup repository identity digest is invalid");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
