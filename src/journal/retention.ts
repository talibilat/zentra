import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import Database from "better-sqlite3";

import type { NewEvent, StoredEvent } from "../contracts/event.js";
import type { StreamId } from "../contracts/ids.js";
import {
  DURABLE_PAGED_EVENT_JOURNAL,
  type DurablePagedEventJournal,
  type GlobalEventPage,
  type JournalPageLimits,
  type ProjectionClaim,
  type ProjectionCursor,
  type StreamEventPage,
} from "./journal.js";
import { SqliteEventJournal } from "./sqlite-journal.js";

const ARCHIVE_FORMAT = "zentra-journal-archive-v1";
const MAX_ARCHIVE_EVENTS = 10_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_SEGMENTS = 10_000;
const MAX_ARCHIVE_LINE_BYTES = 8 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;
const DEFAULT_LIMITS = { maxEvents: 1_000, maxBytes: 16 * 1024 * 1024 } as const;
const RETENTION_STREAM = "journal:retention";
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface RetentionPolicy {
  readonly mode: "retain_forever";
  readonly automaticDeletion: false;
}

export interface ArchiveManifest {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly journalId: string;
  readonly segmentId: string;
  readonly fromPosition: number;
  readonly throughPosition: number;
  readonly eventCount: number;
  readonly byteLength: number;
  readonly segmentSha256: string;
  readonly previousManifestSha256: string | null;
  readonly createdAt: string;
  readonly policy: RetentionPolicy;
}

export interface ArchiveResult extends ArchiveManifest {
  readonly segmentPath: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
}

export interface PruneRequest {
  readonly requestId: string;
  readonly throughPosition: number;
  readonly confirmation: string;
}

interface JournalMetadata {
  readonly journalId: string;
  readonly globalPosition: number;
  readonly retainedThroughPosition: number;
  readonly archiveHeadPosition: number;
  readonly archiveHeadManifestSha256: string | null;
  readonly archiveSegmentCount: number;
}

interface ManifestFile {
  readonly path: string;
  readonly segmentPath: string;
  readonly manifest: ArchiveManifest;
  readonly sha256: string;
}

interface OperationRow {
  readonly operation_id: string;
  readonly kind: "archive" | "prune_request" | "prune" | "maintenance" | "restore";
  readonly state: "publishing" | "authorized" | "effect_applied" | "consumed" | "completed" | "failed";
  readonly from_position: number | null;
  readonly through_position: number;
  readonly segment_id: string | null;
  readonly segment_sha256: string | null;
  readonly manifest_sha256: string | null;
  readonly request_id: string | null;
  readonly operator_id: string | null;
  readonly maintenance_evidence: string | null;
}

export interface VacuumEvidence {
  readonly status: "not_requested" | "not_supported" | "completed";
  readonly requestedPages: number;
  readonly beforeFreelist: number;
  readonly afterFreelist: number;
  readonly reclaimedPages: number;
  readonly elapsedMs: number;
}

interface MaintenanceEvidence {
  readonly checkpointRequested: boolean;
  readonly checkpoint: { readonly busy: number; readonly logFrames: number; readonly checkpointedFrames: number } | null;
  readonly checkpointed: boolean;
  readonly vacuum: VacuumEvidence;
  readonly progress: { readonly totalPages: number; readonly remainingPages: number };
  readonly backupPath: string;
  readonly backupSha256: string;
  readonly backupBytes: number;
}

interface RestoreEvidence {
  readonly name: string;
  readonly eventCount?: number;
  readonly throughPosition: number;
  readonly sha256?: string;
  readonly bytes?: number;
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

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface RetentionRecovery {
  readonly outcome: "clean" | "uncertain";
  readonly operationId: string | null;
  readonly requestId: string | null;
  readonly kind: "archive" | "prune" | "maintenance" | "restore" | null;
  readonly state: string;
  readonly confirmation: string | null;
}

export interface RetentionReconcileResult {
  readonly operationId: string;
  readonly outcome: "completed" | "failed";
  readonly state: string;
  readonly repeated: boolean;
}

export class JournalRetentionService {
  readonly databasePath: string;
  readonly archiveRoot: string;
  private readonly databaseDirectory: string;
  private readonly directoryIdentity: FileIdentity;
  private readonly databaseIdentity: FileIdentity;
  private readonly archiveIdentity: FileIdentity | null;

  static openReadOnly(databasePath: string): JournalRetentionService {
    return new JournalRetentionService(databasePath, { readOnly: true });
  }

  constructor(databasePath: string, options: { readonly readOnly?: boolean } = {}) {
    if (!path.isAbsolute(databasePath) || path.normalize(databasePath) !== databasePath) {
      throw new Error("journal database path must be canonical and absolute");
    }
    this.databaseDirectory = realpathSync.native(path.dirname(databasePath));
    this.databasePath = path.join(this.databaseDirectory, path.basename(databasePath));
    if (!existsSync(this.databasePath) || realpathSync.native(this.databasePath) !== this.databasePath) {
      throw new Error("journal database must be an existing canonical file");
    }
    const databaseInfo = lstatSync(this.databasePath);
    if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink() || databaseInfo.nlink !== 1) {
      throw new Error("journal database must be a private regular file without links");
    }
    assertSafeSqliteSidecars(this.databasePath);
    if (options.readOnly !== true) {
      const migrated = new SqliteEventJournal(this.databasePath);
      migrated.close();
    }
    this.directoryIdentity = identity(statSync(this.databaseDirectory));
    this.databaseIdentity = identity(databaseInfo);
    this.archiveRoot = `${this.databasePath}.archives`;
    if (!existsSync(this.archiveRoot)) {
      if (options.readOnly === true) {
        this.archiveIdentity = null;
        this.assertIdentities();
        return;
      }
      mkdirSync(this.archiveRoot, { mode: 0o700 });
    }
    let archiveInfo = lstatSync(this.archiveRoot);
    if (!archiveInfo.isDirectory() || archiveInfo.isSymbolicLink() ||
      realpathSync.native(this.archiveRoot) !== this.archiveRoot) {
      throw new Error("journal archive root must be a canonical private directory");
    }
    if (options.readOnly !== true) {
      chmodSync(this.archiveRoot, 0o700);
      archiveInfo = lstatSync(this.archiveRoot);
    }
    if ((archiveInfo.mode & 0o777) !== 0o700 || !ownedByCurrentUser(archiveInfo)) {
      throw new Error("journal archive root must have private owner permissions");
    }
    this.archiveIdentity = identity(archiveInfo);
    this.assertIdentities();
  }

  policy(): RetentionPolicy {
    return { mode: "retain_forever", automaticDeletion: false };
  }

  archive(input: {
    readonly throughPosition: number;
    readonly maxEvents: number;
    readonly crashPoint?:
      | "after_segment"
      | "after_manifest"
      | "segment_before_link"
      | "segment_after_link"
      | "segment_chmod"
      | "segment_process_kill_after_fsync"
      | "manifest_before_link"
      | "manifest_after_link";
  }): ArchiveResult {
    assertPosition(input.throughPosition, "archive boundary");
    if (!Number.isSafeInteger(input.maxEvents) || input.maxEvents <= 0 || input.maxEvents > MAX_ARCHIVE_EVENTS) {
      throw new Error(`archive maxEvents must be between 1 and ${MAX_ARCHIVE_EVENTS}`);
    }
    this.assertIdentities();
    const verified = this.verify();
    const metadata = this.metadata();
    const fromPosition = metadata.archiveHeadPosition + 1;
    if (input.throughPosition < fromPosition) throw new Error("archive boundary is already archived");
    if (input.throughPosition > metadata.globalPosition) throw new Error("archive boundary is ahead of journal head");
    if (input.throughPosition - fromPosition + 1 > input.maxEvents) {
      throw new Error("archive range exceeds the bounded event limit");
    }
    const operationId = randomUUID();
    const segmentId = segmentIdentity(fromPosition, input.throughPosition);
    this.beginArchiveIntent(operationId, segmentId, fromPosition, input.throughPosition, verified);

    const segmentPath = this.childPath(`${segmentId}.events.jsonl`);
    const manifestPath = this.childPath(`${segmentId}.manifest.json`);
    try {
      const written = this.writeSegment(
        segmentPath,
        fromPosition,
        input.throughPosition,
        operationId,
        input.crashPoint === "segment_before_link" ? "before_link" :
          input.crashPoint === "segment_after_link" ? "after_link" :
            input.crashPoint === "segment_chmod" ? "before_chmod" :
              input.crashPoint === "segment_process_kill_after_fsync" ? "process_kill_after_fsync" : undefined,
      );
      if (input.crashPoint === "after_segment") throw new Error("simulated crash after archive segment publication");
      const manifest: ArchiveManifest = {
        format: ARCHIVE_FORMAT,
        journalId: metadata.journalId,
        segmentId,
        fromPosition,
        throughPosition: input.throughPosition,
        eventCount: written.eventCount,
        byteLength: written.byteLength,
        segmentSha256: written.sha256,
        previousManifestSha256: metadata.archiveHeadManifestSha256,
        createdAt: new Date().toISOString(),
        policy: this.policy(),
      };
      const manifestContent = `${JSON.stringify(manifest)}\n`;
      this.writeImmutable(
        manifestPath,
        manifestContent,
        operationId,
        input.crashPoint === "manifest_before_link" ? "before_link" :
          input.crashPoint === "manifest_after_link" ? "after_link" : undefined,
      );
      this.fsyncArchiveDirectory();
      if (input.crashPoint === "after_manifest") throw new Error("simulated crash after archive manifest publication");
      const manifestSha256 = sha256(manifestContent);
      this.completeArchive(operationId, manifest, manifestSha256);
      this.assertIdentities();
      return { ...manifest, segmentPath, manifestPath, manifestSha256 };
    } catch (error) {
      if (!existsSync(segmentPath) && !existsSync(manifestPath)) this.failOperation(operationId, "journal.archive.failed", error);
      throw error;
    }
  }

  verify(recordEvidence = false): {
    readonly verified: true;
    readonly throughPosition: number;
    readonly segmentCount: number;
  } {
    this.assertIdentities();
    const { metadata, manifests } = this.anchoredManifestFiles();
    for (const item of manifests) {
      this.scanSegment(item, undefined, true);
    }
    const result = {
      verified: true as const,
      throughPosition: metadata.archiveHeadPosition,
      segmentCount: metadata.archiveSegmentCount,
    };
    if (recordEvidence) this.audit("journal.archive.verified", result);
    return result;
  }

  requestPrune(input: { readonly throughPosition: number; readonly operatorId: string }): PruneRequest {
    assertPosition(input.throughPosition, "prune boundary");
    assertOperator(input.operatorId);
    this.assertIdentities();
    const db = this.openDatabase();
    const requestId = randomUUID();
    try {
      const request = db.transaction(() => {
        const metadata = metadataFromDatabase(db);
        if (input.throughPosition > metadata.globalPosition) {
          throw new Error("prune boundary is ahead of current journal head");
        }
        if (input.throughPosition <= metadata.retainedThroughPosition) {
          throw new Error("prune boundary is not above the retained boundary");
        }
        const stored = appendAudit(db, "journal.prune.requested", {
          requestId,
          throughPosition: input.throughPosition,
          operatorId: input.operatorId,
          irreversible: true,
        });
        if (stored.globalPosition <= input.throughPosition) {
          throw new Error("prune request audit record would be self-pruned");
        }
        db.prepare(`
          INSERT INTO retention_operations (
            operation_id, kind, state, through_position, request_id, operator_id, created_at
          ) VALUES (?, 'prune_request', 'completed', ?, ?, ?, ?)
        `).run(randomUUID(), input.throughPosition, requestId, input.operatorId, new Date().toISOString());
      });
      request.immediate();
    } finally {
      db.close();
    }
    const confirmation = `IRREVERSIBLY PRUNE THROUGH ${input.throughPosition} REQUEST ${requestId}`;
    return { requestId, throughPosition: input.throughPosition, confirmation };
  }

  prune(input: PruneRequest & {
    readonly operatorId: string;
    readonly confirmation: string;
    readonly crashPoint?: "after_authorization" | "after_delete";
  }): { readonly throughPosition: number; readonly deletedEvents: number } {
    assertOperator(input.operatorId);
    if (input.confirmation !== `IRREVERSIBLY PRUNE THROUGH ${input.throughPosition} REQUEST ${input.requestId}`) {
      throw new Error("irreversible prune confirmation does not match exactly");
    }
    this.assertIdentities();
    if (this.activeOperation() !== null) {
      throw new Error("retention result is uncertain and the effect must not be retried");
    }
    this.verifyArchiveOverlap(input.throughPosition);
    const operationId = randomUUID();
    const authorize = this.openDatabase();
    try {
      authorize.transaction(() => {
        const request = authorize.prepare(`
          SELECT through_position, operator_id, state FROM retention_operations
          WHERE kind = 'prune_request' AND request_id = ?
        `).get(input.requestId) as {
          readonly through_position: number;
          readonly operator_id: string;
          readonly state: string;
        } | undefined;
        if (request?.state === "consumed") throw new Error("prune request has already been consumed");
        if (request === undefined || request.state !== "completed" ||
          request.through_position !== input.throughPosition || request.operator_id !== input.operatorId) {
          throw new Error("audited prune request does not match");
        }
        const prior = authorize.prepare(`
          SELECT 1 FROM retention_operations WHERE kind = 'prune' AND request_id = ? LIMIT 1
        `).get(input.requestId);
        if (prior !== undefined) throw new Error("prune request has already been consumed");
        const metadata = metadataFromDatabase(authorize);
        if (input.throughPosition > metadata.archiveHeadPosition || input.throughPosition > metadata.globalPosition) {
          throw new Error("prune boundary is not covered by the anchored archive and journal head");
        }
        assertNoCursorBlockers(authorize, input.throughPosition);
        authorize.prepare(`
          UPDATE retention_operations SET state = 'consumed'
          WHERE kind = 'prune_request' AND state = 'completed' AND request_id = ?
        `).run(input.requestId);
        authorize.prepare(`
          INSERT INTO retention_operations (
            operation_id, kind, state, through_position, request_id, operator_id, created_at
          ) VALUES (?, 'prune', 'authorized', ?, ?, ?, ?)
        `).run(operationId, input.throughPosition, input.requestId, input.operatorId, new Date().toISOString());
        const stored = appendAudit(authorize, "journal.prune.authorized", {
          operationId,
          requestId: input.requestId,
          throughPosition: input.throughPosition,
          operatorId: input.operatorId,
          archiveHeadPosition: metadata.archiveHeadPosition,
        });
        if (stored.globalPosition <= input.throughPosition) throw new Error("prune authorization would be self-pruned");
      }).immediate();
    } catch (error) {
      if (error instanceof Error && /projection cursor blocked/i.test(error.message)) {
        this.audit("journal.prune.cursor_blocked", {
          requestId: input.requestId,
          throughPosition: input.throughPosition,
          reason: "projection_cursor_blocked",
        });
        this.audit("journal.prune.failed", {
          requestId: input.requestId,
          throughPosition: input.throughPosition,
          reason: "projection_cursor_blocked",
        });
      }
      throw error;
    } finally {
      authorize.close();
    }
    if (input.crashPoint === "after_authorization") throw new Error("simulated crash after prune authorization");

    let deletedEvents = 0;
    const effect = this.openDatabase();
    try {
      effect.transaction(() => {
        this.verifyArchiveOverlap(input.throughPosition);
        const operation = requiredOperation(effect, operationId, "authorized");
        assertNoCursorBlockers(effect, input.throughPosition);
        const metadata = metadataFromDatabase(effect);
        if (metadata.archiveHeadPosition < input.throughPosition) throw new Error("archive anchor moved below prune boundary");
        deletedEvents = effect.prepare("DELETE FROM events WHERE global_position <= ?").run(input.throughPosition).changes;
        effect.prepare(`
          UPDATE journal_metadata SET retained_through_position = ? WHERE singleton = 1
        `).run(input.throughPosition);
        effect.prepare("UPDATE retention_operations SET state = 'effect_applied' WHERE operation_id = ?")
          .run(operation.operation_id);
      }).immediate();
    } finally {
      effect.close();
    }
    if (input.crashPoint === "after_delete") throw new Error("simulated crash after prune deletion");

    const complete = this.openDatabase();
    try {
      complete.transaction(() => {
        requiredOperation(complete, operationId, "effect_applied");
        const stored = appendAudit(complete, "journal.prune.completed", {
          operationId,
          requestId: input.requestId,
          throughPosition: input.throughPosition,
          deletedEvents,
          irreversible: true,
        });
        if (stored.globalPosition <= input.throughPosition) throw new Error("prune completion would be self-pruned");
        complete.prepare("UPDATE retention_operations SET state = 'completed' WHERE operation_id = ?")
          .run(operationId);
      }).immediate();
    } finally {
      complete.close();
    }
    return { throughPosition: input.throughPosition, deletedEvents };
  }

  inspectRecovery(): RetentionRecovery {
    this.assertIdentities();
    const operation = this.activeOperation();
    if (operation === null) {
      if (this.archiveIdentity !== null && readdirSync(this.archiveRoot).some((name) => name.includes(".tmp-"))) {
        throw new Error("unknown retention temporary file requires operator inspection");
      }
      return {
        outcome: "clean",
        operationId: null,
        requestId: null,
        kind: null,
        state: "clean",
        confirmation: null,
      };
    }
    const tempResidues = this.strictTempResidues(operation);
    if (operation.kind === "archive") {
      const segmentPath = this.childPath(`${operation.segment_id}.events.jsonl`);
      const manifestPath = this.childPath(`${operation.segment_id}.manifest.json`);
      const segment = existsSync(segmentPath);
      const manifest = existsSync(manifestPath);
      let state = !segment && !manifest && tempResidues.length > 0 ? "archive_temp_only" :
        segment && manifest ? "fully_published_missing_completion" :
        segment ? "segment_only_orphan" : manifest ? "manifest_only_orphan" : "intent_without_publication";
      if (segment && manifest) {
        try {
          const content = this.readRestrictedFile(manifestPath, 64 * 1024);
          const parsed = JSON.parse(content) as ArchiveManifest;
          validateManifest(parsed);
          const metadata = this.metadata();
          if (parsed.journalId !== metadata.journalId || parsed.segmentId !== operation.segment_id ||
            parsed.fromPosition !== operation.from_position || parsed.throughPosition !== operation.through_position ||
            parsed.previousManifestSha256 !== metadata.archiveHeadManifestSha256) {
            throw new Error("published archive does not match its intent");
          }
          this.scanSegment({ path: manifestPath, segmentPath, manifest: parsed, sha256: sha256(content) }, undefined, true);
        } catch {
          state = "published_files_invalid";
        }
      }
      return {
        outcome: "uncertain",
        operationId: operation.operation_id,
        requestId: null,
        kind: "archive",
        state,
        confirmation: reconcileConfirmation(operation.operation_id, state),
      };
    }
    if (operation.kind === "maintenance") {
      const backupPath = this.childPath(`backup-${operation.operation_id}.sqlite`);
      const published = existsSync(backupPath);
      const state = published ? "maintenance_backup_published" :
        tempResidues.length > 0 ? "maintenance_temp_only" : "maintenance_no_artifact";
      return {
        outcome: "uncertain",
        operationId: operation.operation_id,
        requestId: null,
        kind: "maintenance",
        state,
        confirmation: reconcileConfirmation(operation.operation_id, state),
      };
    }
    if (operation.kind === "restore") {
      const evidence = parseRestoreEvidence(operation.maintenance_evidence, false);
      const destination = this.siblingPath(evidence.name);
      const temporary = `${destination}.tmp-${operation.operation_id}`;
      const temporaryExists = [temporary, `${temporary}-wal`, `${temporary}-shm`]
        .some((candidate) => existsSync(candidate));
      let state = existsSync(destination) ? "restore_published_missing_completion" :
        temporaryExists ? "restore_temp_only" : "restore_no_artifact";
      if (state === "restore_published_missing_completion") {
        try {
          verifyRestoredDatabase(destination, parseRestoreEvidence(operation.maintenance_evidence, true));
        } catch {
          state = "restore_published_invalid";
        }
      }
      return {
        outcome: "uncertain",
        operationId: operation.operation_id,
        requestId: null,
        kind: "restore",
        state,
        confirmation: reconcileConfirmation(operation.operation_id, state),
      };
    }
    const metadata = this.metadata();
    const state = operation.state === "effect_applied" || metadata.retainedThroughPosition >= operation.through_position
      ? "effect_applied_missing_completion"
      : "authorization_without_effect";
    return {
      outcome: "uncertain",
      operationId: operation.operation_id,
      requestId: operation.request_id,
      kind: "prune",
      state,
      confirmation: reconcileConfirmation(operation.operation_id, state),
    };
  }

  recover(): RetentionRecovery {
    return this.inspectRecovery();
  }

  reconcile(input: {
    readonly operationId: string;
    readonly confirmation: string;
  }): RetentionReconcileResult {
    const operation = this.operationById(input.operationId);
    if (operation === null) throw new Error("retention operation does not exist");
    if (operation.state === "completed" || operation.state === "failed") {
      return {
        operationId: operation.operation_id,
        outcome: operation.state,
        state: operation.state,
        repeated: true,
      };
    }
    const inspection = this.inspectRecovery();
    if (inspection.operationId !== operation.operation_id) throw new Error("another retention operation requires reconciliation");
    const expected = reconcileConfirmation(operation.operation_id, inspection.state);
    if (input.confirmation !== expected) throw new Error("retention reconcile confirmation does not match exactly");

    if (operation.kind === "archive") {
      if (inspection.state === "fully_published_missing_completion") {
        const pending = this.validatedPendingArchive(operation);
        this.completeArchive(operation.operation_id, pending.manifest, pending.manifestSha256, true);
        return {
          operationId: operation.operation_id,
          outcome: "completed",
          state: "recovered_archive_completion",
          repeated: false,
        };
      }
      if (["archive_temp_only", "segment_only_orphan", "manifest_only_orphan", "published_files_invalid"].includes(inspection.state)) {
        this.removePendingArchiveFiles(operation);
        this.recordReconciledFailure(operation, "journal.archive.repair_completed", inspection.state);
        return {
          operationId: operation.operation_id,
          outcome: "failed",
          state: "operator_cleanup_completed",
          repeated: false,
        };
      }
      if (inspection.state === "intent_without_publication") {
        this.recordReconciledFailure(operation, "journal.archive.failed", "intent_proven_without_effect");
        return {
          operationId: operation.operation_id,
          outcome: "failed",
          state: "no_effect_recorded",
          repeated: false,
        };
      }
      throw new Error("archive operation requires operator cleanup before reconciliation");
    }

    if (operation.kind === "prune") {
      const db = this.openDatabase();
      try {
        return db.transaction(() => {
          const current = requiredOperation(db, operation.operation_id, operation.state);
          const metadata = metadataFromDatabase(db);
          const remaining = (db.prepare(
            "SELECT COUNT(*) AS count FROM events WHERE global_position <= ?",
          ).get(current.through_position) as { readonly count: number }).count;
          if (metadata.retainedThroughPosition >= current.through_position && remaining === 0) {
            const stored = appendAudit(db, "journal.prune.recovered_completed", {
              operationId: current.operation_id,
              requestId: current.request_id,
              throughPosition: current.through_position,
              recovered: true,
            });
            if (stored.globalPosition <= current.through_position) throw new Error("recovered completion would be self-pruned");
            db.prepare("UPDATE retention_operations SET state = 'completed' WHERE operation_id = ?")
              .run(current.operation_id);
            return {
              operationId: current.operation_id,
              outcome: "completed" as const,
              state: "recovered_prune_completion",
              repeated: false,
            };
          }
          if (current.state === "authorized" && metadata.retainedThroughPosition < current.through_position && remaining > 0) {
            appendAudit(db, "journal.prune.failed", {
              operationId: current.operation_id,
              requestId: current.request_id,
              throughPosition: current.through_position,
              reason: "operator_reconciled_no_effect",
            });
            db.prepare("UPDATE retention_operations SET state = 'failed' WHERE operation_id = ?")
              .run(current.operation_id);
            return {
              operationId: current.operation_id,
              outcome: "failed" as const,
              state: "authorization_cancelled_no_effect",
              repeated: false,
            };
          }
          throw new Error("prune effect remains ambiguous and cannot be reconciled");
        }).immediate();
      } finally {
        db.close();
      }
    }
    if (operation.kind === "maintenance") {
      const backupPath = this.childPath(`backup-${operation.operation_id}.sqlite`);
      if (inspection.state === "maintenance_backup_published") {
        let evidence: MaintenanceEvidence;
        try {
          evidence = parseMaintenanceEvidence(operation.maintenance_evidence);
          verifyMaintenanceBackup(backupPath, evidence);
        } catch (error) {
          this.removeExactPrivateFile(backupPath);
          this.recordReconciledFailure(operation, "journal.maintenance.recovered_failed", publicReason(error));
          return {
            operationId: operation.operation_id,
            outcome: "failed",
            state: "maintenance_invalid_backup_cleaned",
            repeated: false,
          };
        }
        const db = this.openDatabase();
        try {
          db.transaction(() => {
            requiredOperation(db, operation.operation_id, "publishing");
            appendAudit(db, "journal.maintenance.recovered_completed", {
              operationId: operation.operation_id,
              ...evidence,
              recovered: true,
            });
            db.prepare("UPDATE retention_operations SET state = 'completed' WHERE operation_id = ?")
              .run(operation.operation_id);
          }).immediate();
        } finally {
          db.close();
        }
        return {
          operationId: operation.operation_id,
          outcome: "completed",
          state: "recovered_maintenance_completion",
          repeated: false,
        };
      }
      if (inspection.state === "maintenance_temp_only") {
        this.removeExactPrivateFile(this.childPath(`backup-${operation.operation_id}.sqlite.tmp-${operation.operation_id}`));
        this.fsyncArchiveDirectory();
        this.recordReconciledFailure(operation, "journal.maintenance.temp_cleaned", "operator_reconciled_temp_residue");
        return {
          operationId: operation.operation_id,
          outcome: "failed",
          state: "maintenance_temp_cleaned",
          repeated: false,
        };
      }
      this.recordReconciledFailure(operation, "journal.maintenance.recovered_failed", "no_proven_backup_effect");
      return {
        operationId: operation.operation_id,
        outcome: "failed",
        state: "maintenance_no_effect_recorded",
        repeated: false,
      };
    }
    if (operation.kind === "restore") {
      const evidence = parseRestoreEvidence(operation.maintenance_evidence,
        inspection.state === "restore_published_missing_completion");
      const destination = this.siblingPath(evidence.name);
      if (inspection.state === "restore_published_missing_completion") {
        verifyRestoredDatabase(destination, evidence);
        const db = this.openDatabase();
        try {
          db.transaction(() => {
            requiredOperation(db, operation.operation_id, "publishing");
            appendAudit(db, "journal.restore.recovered_completed", {
              operationId: operation.operation_id,
              ...evidence,
              recovered: true,
            });
            db.prepare("UPDATE retention_operations SET state = 'completed' WHERE operation_id = ?")
              .run(operation.operation_id);
          }).immediate();
        } finally {
          db.close();
        }
        return {
          operationId: operation.operation_id,
          outcome: "completed",
          state: "recovered_restore_completion",
          repeated: false,
        };
      }
      if (inspection.state === "restore_temp_only") {
        this.removeExactPrivateDatabaseFiles(`${destination}.tmp-${operation.operation_id}`);
      } else if (inspection.state === "restore_published_invalid") {
        this.removeExactPrivateFile(destination);
      }
      this.recordReconciledFailure(operation, "journal.restore.failed", inspection.state);
      return {
        operationId: operation.operation_id,
        outcome: "failed",
        state: inspection.state === "restore_no_artifact" ? "restore_no_effect_recorded" :
          "restore_artifact_cleaned",
        repeated: false,
      };
    }
    throw new Error("retention operation kind cannot be reconciled");
  }

  openCombinedJournal(mode: "read-only" | "read-write" = "read-only"): ArchivedEventJournal {
    this.verify();
    return new ArchivedEventJournal(this, mode);
  }

  export(input: {
    readonly name: string;
    readonly failurePoint?: "after_write";
  }): { readonly path: string; readonly eventCount: number; readonly throughPosition: number; readonly sha256: string } {
    this.verify();
    const throughPosition = this.globalHead();
    const destination = this.siblingPath(input.name);
    this.assertNewDestination(destination);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    const descriptor = openPrivate(temporary);
    const digest = createHash("sha256");
    let eventCount = 0;
    const journal = this.openCombinedJournal();
    let completed = false;
    try {
      let position = 0;
      while (position < throughPosition) {
        const page = journal.readAllPage(position, DEFAULT_LIMITS);
        const events = page.events.filter((event) => event.globalPosition <= throughPosition);
        for (const event of events) {
          const line = canonicalEventLine(event);
          writeSync(descriptor, line);
          digest.update(line);
          eventCount += 1;
        }
        if (input.failurePoint === "after_write" && eventCount > 0) {
          throw new Error("injected export failure after write");
        }
        const nextPosition = events.at(-1)?.globalPosition ?? position;
        if (nextPosition <= position) throw new Error("journal export did not make progress");
        position = nextPosition;
      }
      fsyncSync(descriptor);
      completed = true;
    } finally {
      journal.close();
      closeSync(descriptor);
      if (!completed && existsSync(temporary)) unlinkSync(temporary);
    }
    let published = false;
    try {
      publishNoClobber(temporary, destination, 0o400);
      published = true;
      fsyncDirectory(this.databaseDirectory);
      this.assertIdentities();
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      if (published && existsSync(destination)) unlinkSync(destination);
      throw error;
    }
    return { path: destination, eventCount, throughPosition, sha256: digest.digest("hex") };
  }

  restore(input: {
    readonly name: string;
    readonly failurePoint?: "after_write";
    readonly crashPoint?: "after_publish";
  }): { readonly path: string; readonly eventCount: number; readonly throughPosition: number; readonly sha256: string } {
    this.verify();
    const destination = this.siblingPath(input.name);
    this.assertNewDestination(destination);
    const throughPosition = this.globalHead();
    const operationId = randomUUID();
    const intent = this.openDatabase();
    try {
      intent.transaction(() => {
        intent.prepare(`
          INSERT INTO retention_operations (
            operation_id, kind, state, through_position, maintenance_evidence, created_at
          ) VALUES (?, 'restore', 'publishing', ?, ?, ?)
        `).run(operationId, throughPosition, JSON.stringify({ name: input.name, throughPosition }),
          new Date().toISOString());
        appendAudit(intent, "journal.restore.started", {
          operationId,
          name: input.name,
          throughPosition,
        });
      }).immediate();
    } catch (error) {
      if (String(error).includes("retention_one_active_operation")) {
        throw new Error("retention operation is already active");
      }
      throw error;
    } finally {
      intent.close();
    }
    const temporary = `${destination}.tmp-${operationId}`;
    const destinationDescriptor = openPrivate(temporary);
    closeSync(destinationDescriptor);
    const restored = new SqliteEventJournal(temporary);
    restored.close();
    const target = new Database(temporary);
    const journal = this.openCombinedJournal();
    let eventCount = 0;
    let restoredSha256 = "";
    try {
      const insert = target.prepare(`
        INSERT INTO events (global_position, event_id, stream_id, stream_version, type, payload,
          causation_id, correlation_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const stream = target.prepare("INSERT OR IGNORE INTO streams (stream_id, current_version) VALUES (?, 0)");
      let position = 0;
      while (position < throughPosition) {
        const page = journal.readAllPage(position, DEFAULT_LIMITS);
        const events = page.events.filter((event) => event.globalPosition <= throughPosition);
        target.transaction(() => {
          for (const event of events) {
            stream.run(event.streamId);
            insert.run(event.globalPosition, event.eventId, event.streamId, event.streamVersion, event.type,
              JSON.stringify(event.payload), event.causationId, event.correlationId, event.recordedAt);
            eventCount += 1;
          }
        }).immediate();
        if (input.failurePoint === "after_write" && eventCount > 0) {
          throw new Error("injected restore failure after write");
        }
        const nextPosition = events.at(-1)?.globalPosition ?? position;
        if (nextPosition <= position) throw new Error("journal restore did not make progress");
        position = nextPosition;
      }
      target.exec("UPDATE streams SET current_version = (SELECT MAX(stream_version) FROM events WHERE events.stream_id = streams.stream_id)");
      target.pragma("wal_checkpoint(TRUNCATE)");
    } catch (error) {
      target.close();
      journal.close();
      unlinkDatabaseFiles(temporary);
      this.failOperation(operationId, "journal.restore.failed", error);
      throw error;
    }
    target.close();
    journal.close();
    unlinkDatabaseSidecars(temporary);
    let published = false;
    try {
      const verify = new Database(temporary, { readonly: true, fileMustExist: true });
      try {
        if (verify.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("restored journal integrity check failed");
      } finally {
        verify.close();
      }
      fsyncFile(temporary);
      restoredSha256 = sha256File(temporary);
      const restoredBytes = statSync(temporary).size;
      const evidence = { name: input.name, eventCount, throughPosition, sha256: restoredSha256,
        bytes: restoredBytes } satisfies RestoreEvidence;
      const evidenceDatabase = this.openDatabase();
      try {
        evidenceDatabase.prepare(`
          UPDATE retention_operations SET maintenance_evidence = ?
          WHERE operation_id = ? AND state = 'publishing'
        `).run(JSON.stringify(evidence), operationId);
      } finally {
        evidenceDatabase.close();
      }
      publishNoClobber(temporary, destination, 0o600);
      published = true;
    } catch (error) {
      unlinkDatabaseFiles(temporary);
      this.failOperation(operationId, "journal.restore.failed", error);
      throw error;
    }
    try {
      fsyncDirectory(this.databaseDirectory);
    } catch (error) {
      if (!published) this.failOperation(operationId, "journal.restore.failed", error);
      throw error;
    }
    if (input.crashPoint === "after_publish") throw new Error("simulated crash after restore publication");
    const completion = this.openDatabase();
    try {
      completion.transaction(() => {
        requiredOperation(completion, operationId, "publishing");
        appendAudit(completion, "journal.restore.completed", {
          operationId,
          name: input.name,
          throughPosition,
          eventCount,
          sha256: restoredSha256,
        });
        completion.prepare("UPDATE retention_operations SET state = 'completed' WHERE operation_id = ?")
          .run(operationId);
      }).immediate();
    } finally {
      completion.close();
    }
    return { path: destination, eventCount, throughPosition, sha256: restoredSha256 };
  }

  async maintain(input: {
    readonly checkpoint: boolean;
    readonly vacuumPages?: number;
    readonly vacuumDeadlineMs?: number;
    readonly signal?: AbortSignal;
    readonly crashPoint?:
      | "after_backup_fsync"
      | "after_backup_publish"
      | "process_kill_after_backup_fsync";
  }): Promise<{
    readonly checkpointed: boolean;
    readonly checkpoint: { readonly busy: number; readonly logFrames: number; readonly checkpointedFrames: number } | null;
    readonly vacuum: VacuumEvidence;
    readonly backupPath: string;
    readonly backupSha256: string;
    readonly backupBytes: number;
  }> {
    const vacuumPages = input.vacuumPages ?? 0;
    if (!Number.isSafeInteger(vacuumPages) || vacuumPages < 0 || vacuumPages > 1_000) {
      throw new Error("vacuum pages must be an integer between 0 and 1000");
    }
    const vacuumDeadlineMs = input.vacuumDeadlineMs ?? 1_000;
    if (!Number.isSafeInteger(vacuumDeadlineMs) || vacuumDeadlineMs < 1 || vacuumDeadlineMs > 60_000) {
      throw new Error("vacuum deadline must be between 1 and 60000 milliseconds");
    }
    throwIfMaintenanceAborted(input.signal);
    const operationId = randomUUID();
    const intent = this.openDatabase();
    try {
      intent.transaction(() => {
        const metadata = metadataFromDatabase(intent);
        intent.prepare(`
          INSERT INTO retention_operations (
            operation_id, kind, state, through_position, created_at
          ) VALUES (?, 'maintenance', 'publishing', ?, ?)
        `).run(operationId, metadata.globalPosition, new Date().toISOString());
        appendAudit(intent, "journal.maintenance.started", {
          operationId,
          checkpoint: input.checkpoint,
          vacuumPages,
          vacuumDeadlineMs,
        });
      }).immediate();
    } catch (error) {
      if (String(error).includes("retention_one_active_operation")) throw new Error("retention operation is already active");
      throw error;
    } finally {
      intent.close();
    }
    const db = this.openDatabase();
    const backupPath = this.childPath(`backup-${operationId}.sqlite`);
    const backupTemporary = `${backupPath}.tmp-${operationId}`;
    const backupDescriptor = openPrivate(backupTemporary);
    closeSync(backupDescriptor);
    let checkpoint: { readonly busy: number; readonly logFrames: number; readonly checkpointedFrames: number } | null = null;
    let progress = { totalPages: 0, remainingPages: 0 };
    let evidence: MaintenanceEvidence;
    try {
      throwIfMaintenanceAborted(input.signal);
      if (input.checkpoint) {
        const row = (db.pragma("wal_checkpoint(PASSIVE)") as Array<{
          readonly busy: number;
          readonly log: number;
          readonly checkpointed: number;
        }>)[0]!;
        checkpoint = { busy: row.busy, logFrames: row.log, checkpointedFrames: row.checkpointed };
      }
      const vacuum = runIncrementalVacuum(db, vacuumPages, vacuumDeadlineMs, input.signal);
      throwIfMaintenanceAborted(input.signal);
      await db.backup(backupTemporary, { progress: (value) => {
        throwIfMaintenanceAborted(input.signal);
        progress = { totalPages: value.totalPages, remainingPages: value.remainingPages };
        return 100;
      } });
      progress = { totalPages: progress.totalPages, remainingPages: 0 };
      const backup = new Database(backupTemporary, { readonly: true, fileMustExist: true });
      try {
        if (backup.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("backup integrity check failed");
      } finally {
        backup.close();
      }
      unlinkDatabaseSidecars(backupTemporary);
      fsyncFile(backupTemporary);
      const backupBytes = statSync(backupTemporary).size;
      const backupSha256 = sha256File(backupTemporary);
      const checkpointed = checkpoint === null ||
        (checkpoint.busy === 0 && checkpoint.checkpointedFrames === checkpoint.logFrames);
      evidence = {
        checkpointRequested: input.checkpoint,
        checkpoint,
        checkpointed,
        vacuum,
        progress,
        backupPath,
        backupSha256,
        backupBytes,
      };
      const evidenceDatabase = this.openDatabase();
      try {
        evidenceDatabase.prepare(`
          UPDATE retention_operations SET maintenance_evidence = ?
          WHERE operation_id = ? AND state = 'publishing'
        `).run(JSON.stringify(evidence), operationId);
      } finally {
        evidenceDatabase.close();
      }
    } catch (error) {
      db.close();
      unlinkDatabaseFiles(backupTemporary);
      this.failOperation(operationId, "journal.maintenance.failed", error);
      throw error;
    }
    db.close();
    if (input.crashPoint === "after_backup_fsync") {
      throw new Error("injected maintenance crash after backup fsync");
    }
    if (input.crashPoint === "process_kill_after_backup_fsync") process.kill(process.pid, "SIGKILL");
    let backupPublished = false;
    try {
      publishNoClobber(backupTemporary, backupPath, 0o400);
      backupPublished = true;
      this.fsyncArchiveDirectory();
    } catch (error) {
      unlinkDatabaseFiles(backupTemporary);
      if (backupPublished && existsSync(backupPath)) unlinkSync(backupPath);
      this.failOperation(operationId, "journal.maintenance.failed", error);
      throw error;
    }
    if (input.crashPoint === "after_backup_publish") {
      throw new Error("injected maintenance crash after backup publication");
    }
    const completion = this.openDatabase();
    try {
      completion.transaction(() => {
        requiredOperation(completion, operationId, "publishing");
        appendAudit(completion, "journal.maintenance.progress", {
          operationId,
          ...evidence,
        });
        appendAudit(completion, "journal.maintenance.completed", {
          operationId,
          ...evidence,
        });
        completion.prepare("UPDATE retention_operations SET state = 'completed' WHERE operation_id = ?")
          .run(operationId);
      }).immediate();
    } finally {
      completion.close();
    }
    return {
      checkpointed: evidence.checkpointed,
      checkpoint: evidence.checkpoint,
      vacuum: evidence.vacuum,
      backupPath: evidence.backupPath,
      backupSha256: evidence.backupSha256,
      backupBytes: evidence.backupBytes,
    };
  }

  globalHead(): number {
    return this.metadata().globalPosition;
  }

  streamHead(streamId: string): number {
    const db = new Database(this.databasePath, { readonly: true, fileMustExist: true });
    try {
      return (db.prepare("SELECT current_version FROM streams WHERE stream_id = ?").get(streamId) as
        { readonly current_version: number } | undefined)?.current_version ?? 0;
    } finally {
      db.close();
    }
  }

  archivePage(afterPosition: number, limits: JournalPageLimits): GlobalEventPage {
    validatePageLimits(limits);
    const metadata = this.metadata();
    const events: StoredEvent[] = [];
    let bytes = 0;
    let hasMore = false;
    let pageFull = false;
    outer: for (const item of this.anchoredManifestFiles().manifests) {
      if (item.manifest.throughPosition <= afterPosition) continue;
      this.scanSegment(item, (event) => {
        if (event.globalPosition <= afterPosition) return;
        const size = storedEventBytes(event);
        if (pageFull) {
          hasMore = true;
          return;
        }
        if (events.length >= limits.maxEvents || bytes + size > limits.maxBytes) {
          hasMore = true;
          pageFull = true;
          return;
        }
        events.push(event);
        bytes += size;
        if (events.length === limits.maxEvents || bytes === limits.maxBytes) {
          pageFull = true;
        }
      }, true);
      if (pageFull) break outer;
    }
    if (hasMore && events.length === 0) throw new Error("journal page maxBytes is smaller than the next archived event");
    return {
      events,
      nextPosition: events.at(-1)?.globalPosition ?? afterPosition,
      hasMore: hasMore || (events.at(-1)?.globalPosition ?? afterPosition) < metadata.archiveHeadPosition,
      bytes,
    };
  }

  archiveStreamPage(streamId: string, afterVersion: number, limits: JournalPageLimits): StreamEventPage & { readonly archivedVersion: number } {
    validatePageLimits(limits);
    const events: StoredEvent[] = [];
    let bytes = 0;
    let archivedVersion = 0;
    let hasMore = false;
    let pageFull = false;
    outer: for (const item of this.anchoredManifestFiles().manifests) {
      this.scanSegment(item, (event) => {
        if (event.streamId !== streamId) return;
        if (event.streamVersion <= afterVersion) {
          archivedVersion = event.streamVersion;
          return;
        }
        if (pageFull) {
          hasMore = true;
          return;
        }
        const size = storedEventBytes(event);
        if (events.length >= limits.maxEvents || bytes + size > limits.maxBytes) {
          hasMore = true;
          pageFull = true;
          return;
        }
        events.push(event);
        archivedVersion = event.streamVersion;
        bytes += size;
        if (events.length === limits.maxEvents || bytes === limits.maxBytes) {
          pageFull = true;
        }
      }, true);
      if (pageFull) break outer;
    }
    if (hasMore && events.length === 0) throw new Error("journal page maxBytes is smaller than the next archived event");
    return { events, nextVersion: events.at(-1)?.streamVersion ?? afterVersion, hasMore, bytes, archivedVersion };
  }

  private beginArchiveIntent(
    operationId: string,
    segmentId: string,
    fromPosition: number,
    throughPosition: number,
    verified: { readonly throughPosition: number; readonly segmentCount: number },
  ): void {
    const db = this.openDatabase();
    try {
      db.transaction(() => {
        const metadata = metadataFromDatabase(db);
        if (metadata.archiveHeadPosition !== verified.throughPosition || metadata.archiveSegmentCount !== verified.segmentCount) {
          throw new Error("archive anchor changed concurrently");
        }
        db.prepare(`
          INSERT INTO retention_operations (
            operation_id, kind, state, from_position, through_position, segment_id, created_at
          ) VALUES (?, 'archive', 'publishing', ?, ?, ?, ?)
        `).run(operationId, fromPosition, throughPosition, segmentId, new Date().toISOString());
        appendAudit(db, "journal.archive.proposed", { operationId, segmentId, fromPosition, throughPosition });
        appendAudit(db, "journal.archive.started", { operationId, segmentId, fromPosition, throughPosition });
      }).immediate();
    } catch (error) {
      if (String(error).includes("retention_one_active_operation")) throw new Error("retention operation is already active");
      throw error;
    } finally {
      db.close();
    }
  }

  private completeArchive(
    operationId: string,
    manifest: ArchiveManifest,
    manifestSha256: string,
    recovered = false,
  ): void {
    const db = this.openDatabase();
    try {
      db.transaction(() => {
        const operation = requiredOperation(db, operationId, "publishing");
        const metadata = metadataFromDatabase(db);
        if (operation.from_position !== metadata.archiveHeadPosition + 1 ||
          manifest.previousManifestSha256 !== metadata.archiveHeadManifestSha256) {
          throw new Error("archive completion no longer matches anchored predecessor");
        }
        db.prepare(`
          UPDATE journal_metadata
          SET archive_head_position = ?, archive_head_manifest_sha256 = ?,
              archive_segment_count = archive_segment_count + 1
          WHERE singleton = 1
        `).run(manifest.throughPosition, manifestSha256);
        db.prepare(`
          UPDATE retention_operations
          SET state = 'completed', segment_sha256 = ?, manifest_sha256 = ?
          WHERE operation_id = ?
        `).run(manifest.segmentSha256, manifestSha256, operationId);
        appendAudit(db, recovered ? "journal.archive.recovered_completed" : "journal.archive.completed", {
          operationId,
          segmentId: manifest.segmentId,
          fromPosition: manifest.fromPosition,
          throughPosition: manifest.throughPosition,
          eventCount: manifest.eventCount,
          segmentSha256: manifest.segmentSha256,
          manifestSha256,
          ...(recovered ? { recovered: true } : {}),
        });
      }).immediate();
    } finally {
      db.close();
    }
  }

  private writeSegment(
    destination: string,
    fromPosition: number,
    throughPosition: number,
    operationId: string,
    publicationFailure?: "before_chmod" | "before_link" | "after_link" | "process_kill_after_fsync",
  ): {
    readonly eventCount: number;
    readonly byteLength: number;
    readonly sha256: string;
  } {
    this.assertNewDestination(destination);
    const temporary = `${destination}.tmp-${operationId}`;
    const descriptor = openPrivate(temporary);
    const digest = createHash("sha256");
    let eventCount = 0;
    let byteLength = 0;
    const journal = SqliteEventJournal.openReadOnly(this.databasePath);
    try {
      let position = fromPosition - 1;
      while (position < throughPosition) {
        const page = journal.readAllPage(position, {
          maxEvents: Math.min(256, throughPosition - position),
          maxBytes: 4 * 1024 * 1024,
        });
        if (page.events.length === 0) throw new Error(`journal archive gap at position ${position + 1}`);
        for (const event of page.events) {
          if (event.globalPosition > throughPosition) break;
          const line = canonicalEventLine(event);
          writeSync(descriptor, line);
          digest.update(line);
          eventCount += 1;
          byteLength += Buffer.byteLength(line);
          position = event.globalPosition;
        }
        if (eventCount > MAX_ARCHIVE_EVENTS || byteLength > MAX_ARCHIVE_BYTES) throw new Error("archive bound exceeded");
      }
      fsyncSync(descriptor);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    } finally {
      journal.close();
      closeSync(descriptor);
    }
    publishNoClobber(temporary, destination, 0o400, publicationFailure);
    this.fsyncArchiveDirectory();
    return { eventCount, byteLength, sha256: digest.digest("hex") };
  }

  private scanSegment(
    item: ManifestFile,
    visitor: ((event: StoredEvent) => void | false) | undefined,
    compareOverlap: boolean,
    requireComplete = true,
  ): boolean {
    const digest = createHash("sha256");
    const overlapDatabase = compareOverlap
      ? new Database(this.databasePath, { readonly: true, fileMustExist: true })
      : undefined;
    const retainedThrough = overlapDatabase === undefined
      ? 0
      : metadataFromDatabase(overlapDatabase).retainedThroughPosition;
    let count = 0;
    let bytes = 0;
    let expected = item.manifest.fromPosition;
    let stopped = false;
    try {
      forEachLine(item.segmentPath, (line) => {
        digest.update(line);
        bytes += Buffer.byteLength(line);
        const event = parseEventLine(line, expected);
        if (overlapDatabase !== undefined && event.globalPosition > retainedThrough) {
          compareActiveOverlap(overlapDatabase, event);
        }
        count += 1;
        expected += 1;
        if (visitor?.(event) === false) {
          stopped = true;
          return false;
        }
      });
    } finally {
      overlapDatabase?.close();
    }
    if (stopped && !requireComplete) return false;
    if (count !== item.manifest.eventCount || bytes !== item.manifest.byteLength ||
      expected - 1 !== item.manifest.throughPosition || digest.digest("hex") !== item.manifest.segmentSha256) {
      throw new Error("archive segment checksum, count, or range is corrupt");
    }
    return true;
  }

  private verifyArchiveOverlap(throughPosition: number): void {
    this.verify();
    for (const item of this.anchoredManifestFiles().manifests) {
      if (item.manifest.fromPosition > throughPosition) break;
      this.scanSegment(item, undefined, true);
    }
  }

  private manifestFiles(): readonly ManifestFile[] {
    if (this.archiveIdentity === null) return [];
    const names = readdirSync(this.archiveRoot).filter((name) => name.endsWith(".manifest.json")).sort();
    if (names.length > MAX_ARCHIVE_SEGMENTS) throw new Error("archive segment count limit exceeded");
    return names.map((name) => {
      const manifestPath = this.childPath(name);
      const content = this.readRestrictedFile(manifestPath, 64 * 1024);
      let manifest: ArchiveManifest;
      try {
        manifest = JSON.parse(content) as ArchiveManifest;
      } catch {
        throw new Error("archive manifest is corrupt");
      }
      validateManifest(manifest);
      if (name !== `${manifest.segmentId}.manifest.json`) throw new Error("archive manifest filename is inconsistent");
      return {
        path: manifestPath,
        segmentPath: this.childPath(`${manifest.segmentId}.events.jsonl`),
        manifest,
        sha256: sha256(content),
      };
    });
  }

  private anchoredManifestFiles(): {
    readonly metadata: JournalMetadata;
    readonly manifests: readonly ManifestFile[];
  } {
    const metadata = this.metadata();
    const active = this.activeOperation();
    const allManifests = this.manifestFiles();
    const manifests = active?.kind === "archive" && active.state === "publishing"
      ? allManifests.filter((item) => item.manifest.segmentId !== active.segment_id)
      : allManifests;
    if (manifests.length !== metadata.archiveSegmentCount) {
      throw new Error("journal archive chain has an orphan, gap, or truncation relative to its SQLite anchor");
    }
    let expected = 1;
    let previous: string | null = null;
    for (const item of manifests) {
      if (item.manifest.journalId !== metadata.journalId) {
        throw new Error("archive journal identity does not match SQLite");
      }
      if (item.manifest.fromPosition !== expected || item.manifest.previousManifestSha256 !== previous) {
        throw new Error(`journal archive chain gap or tamper at global position ${expected}`);
      }
      expected = item.manifest.throughPosition + 1;
      previous = item.sha256;
    }
    if (expected - 1 !== metadata.archiveHeadPosition || previous !== metadata.archiveHeadManifestSha256 ||
      metadata.retainedThroughPosition > metadata.archiveHeadPosition) {
      throw new Error("journal archive chain does not match its anchored head or retained boundary");
    }
    this.rejectUnexpectedArchiveFiles(manifests, active);
    return { metadata, manifests };
  }

  private rejectUnexpectedArchiveFiles(
    manifests: readonly ManifestFile[],
    active: OperationRow | null = null,
  ): void {
    if (this.archiveIdentity === null) {
      if (manifests.length !== 0) throw new Error("archive directory identity is missing");
      return;
    }
    const expected = new Set(manifests.flatMap((item) => [path.basename(item.path), path.basename(item.segmentPath)]));
    if (active?.kind === "archive" && active.state === "publishing" && active.segment_id !== null) {
      expected.add(`${active.segment_id}.events.jsonl`);
      expected.add(`${active.segment_id}.manifest.json`);
    }
    const unexpected = readdirSync(this.archiveRoot).filter((name) =>
      (name.endsWith(".manifest.json") || name.endsWith(".events.jsonl") || name.includes(".tmp-")) && !expected.has(name));
    if (unexpected.length > 0) throw new Error("archive contains orphan, linked, or interrupted files");
  }

  private activeOperation(): OperationRow | null {
    const db = new Database(this.databasePath, { readonly: true, fileMustExist: true });
    try {
      return (db.prepare(`
        SELECT * FROM retention_operations
        WHERE state IN ('publishing', 'authorized', 'effect_applied')
        ORDER BY created_at LIMIT 1
      `).get() as OperationRow | undefined) ?? null;
    } finally {
      db.close();
    }
  }

  private operationById(operationId: string): OperationRow | null {
    const db = new Database(this.databasePath, { readonly: true, fileMustExist: true });
    try {
      return (db.prepare("SELECT * FROM retention_operations WHERE operation_id = ?")
        .get(operationId) as OperationRow | undefined) ?? null;
    } finally {
      db.close();
    }
  }

  private strictTempResidues(operation: OperationRow): readonly string[] {
    const allTemps = readdirSync(this.archiveRoot).filter((name) => name.includes(".tmp-"));
    const expected = new Set<string>();
    if (operation.kind === "archive" && operation.segment_id !== null) {
      expected.add(`${operation.segment_id}.events.jsonl.tmp-${operation.operation_id}`);
      expected.add(`${operation.segment_id}.manifest.json.tmp-${operation.operation_id}`);
    }
    if (operation.kind === "maintenance") {
      expected.add(`backup-${operation.operation_id}.sqlite.tmp-${operation.operation_id}`);
    }
    for (const name of allTemps) {
      if (!expected.has(name)) throw new Error("unknown retention temporary file requires operator inspection");
      const info = lstatSync(this.childPath(name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
        throw new Error("retention temporary file is linked, permissive, or unsafe");
      }
    }
    return allTemps;
  }

  private validatedPendingArchive(operation: OperationRow): {
    readonly manifest: ArchiveManifest;
    readonly manifestSha256: string;
  } {
    const segmentPath = this.childPath(`${operation.segment_id}.events.jsonl`);
    const manifestPath = this.childPath(`${operation.segment_id}.manifest.json`);
    const content = this.readRestrictedFile(manifestPath, 64 * 1024);
    const manifest = JSON.parse(content) as ArchiveManifest;
    validateManifest(manifest);
    const metadata = this.metadata();
    if (manifest.journalId !== metadata.journalId || manifest.segmentId !== operation.segment_id ||
      manifest.fromPosition !== operation.from_position || manifest.throughPosition !== operation.through_position ||
      manifest.previousManifestSha256 !== metadata.archiveHeadManifestSha256) {
      throw new Error("published archive does not exactly match its durable intent");
    }
    const manifestSha256 = sha256(content);
    this.scanSegment({ path: manifestPath, segmentPath, manifest, sha256: manifestSha256 }, undefined, true);
    return { manifest, manifestSha256 };
  }

  private removePendingArchiveFiles(operation: OperationRow): void {
    for (const candidate of [
      this.childPath(`${operation.segment_id}.events.jsonl`),
      this.childPath(`${operation.segment_id}.manifest.json`),
      this.childPath(`${operation.segment_id}.events.jsonl.tmp-${operation.operation_id}`),
      this.childPath(`${operation.segment_id}.manifest.json.tmp-${operation.operation_id}`),
    ]) {
      if (!existsSync(candidate)) continue;
      this.removeExactPrivateFile(candidate);
    }
    this.fsyncArchiveDirectory();
  }

  private removeExactPrivateFile(candidate: string): void {
    if (!existsSync(candidate)) return;
    const info = lstatSync(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
      throw new Error("retention file identity is unsafe for operator cleanup");
    }
    unlinkSync(candidate);
  }

  private removeExactPrivateDatabaseFiles(databasePath: string): void {
    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      this.removeExactPrivateFile(candidate);
    }
    fsyncDirectory(this.databaseDirectory);
  }

  private recordReconciledFailure(operation: OperationRow, type: string, reason: string): void {
    const db = this.openDatabase();
    try {
      db.transaction(() => {
        requiredOperation(db, operation.operation_id, operation.state);
        appendAudit(db, type, {
          operationId: operation.operation_id,
          throughPosition: operation.through_position,
          reason,
          operatorReconciled: true,
        });
        db.prepare("UPDATE retention_operations SET state = 'failed' WHERE operation_id = ?")
          .run(operation.operation_id);
      }).immediate();
    } finally {
      db.close();
    }
  }

  private metadata(): JournalMetadata {
    const db = new Database(this.databasePath, { readonly: true, fileMustExist: true });
    try {
      return metadataFromDatabase(db);
    } finally {
      db.close();
    }
  }

  private audit(type: string, payload: Record<string, unknown>): void {
    const db = this.openDatabase();
    try {
      db.transaction(() => { appendAudit(db, type, payload); }).immediate();
    } finally {
      db.close();
    }
  }

  private failOperation(operationId: string, type: string, error: unknown): void {
    const db = this.openDatabase();
    try {
      db.transaction(() => {
        db.prepare("UPDATE retention_operations SET state = 'failed' WHERE operation_id = ?").run(operationId);
        appendAudit(db, type, { operationId, reason: publicReason(error) });
      }).immediate();
    } finally {
      db.close();
    }
  }

  private openDatabase(): Database.Database {
    this.assertIdentities();
    return new Database(this.databasePath, { timeout: 1_000 });
  }

  private childPath(name: string): string {
    assertSafeName(name);
    return path.join(this.archiveRoot, name);
  }

  private siblingPath(name: string): string {
    assertSafeName(name);
    const databaseName = path.basename(this.databasePath).toLowerCase();
    if ([databaseName, `${databaseName}-wal`, `${databaseName}-shm`, `${databaseName}-journal`,
      `${databaseName}.archives`].includes(name.toLowerCase())) {
      throw new Error("destination name is reserved for the journal");
    }
    return path.join(this.databaseDirectory, name);
  }

  private assertNewDestination(destination: string): void {
    this.assertIdentities();
    if (existsSync(destination)) throw new Error("destination already exists");
  }

  private writeImmutable(
    destination: string,
    content: string,
    operationId: string,
    publicationFailure?: "before_chmod" | "before_link" | "after_link" | "process_kill_after_fsync",
  ): void {
    this.assertNewDestination(destination);
    const temporary = `${destination}.tmp-${operationId}`;
    const descriptor = openPrivate(temporary);
    try {
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    publishNoClobber(temporary, destination, 0o400, publicationFailure);
  }

  private readRestrictedFile(filePath: string, maximumBytes: number): string {
    const descriptor = openNoFollow(filePath);
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.nlink !== 1 || info.size > maximumBytes ||
        (info.mode & 0o777) !== 0o400 || !ownedByCurrentUser(info)) {
        throw new Error("archive file is linked, permissive, has an invalid mode, or exceeds its bound");
      }
      return readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
  }

  private fsyncArchiveDirectory(): void {
    this.assertIdentities();
    fsyncDirectory(this.archiveRoot);
    this.assertIdentities();
  }

  private assertIdentities(): void {
    assertSameIdentity(statSync(this.databaseDirectory), this.directoryIdentity, "journal directory");
    const database = lstatSync(this.databasePath);
    if (!database.isFile() || database.isSymbolicLink() || database.nlink !== 1) {
      throw new Error("journal database identity is unsafe");
    }
    assertSameIdentity(database, this.databaseIdentity, "journal database");
    assertSafeSqliteSidecars(this.databasePath);
    if (this.archiveIdentity === null) {
      if (existsSync(this.archiveRoot)) throw new Error("archive directory identity changed");
      return;
    }
    const archive = lstatSync(this.archiveRoot);
    if (!archive.isDirectory() || archive.isSymbolicLink() ||
      (archive.mode & 0o777) !== 0o700 || !ownedByCurrentUser(archive)) {
      throw new Error("archive directory identity or private permissions are unsafe");
    }
    assertSameIdentity(archive, this.archiveIdentity, "archive directory");
  }
}

export class ArchivedEventJournal implements DurablePagedEventJournal {
  readonly [DURABLE_PAGED_EVENT_JOURNAL] = true;
  private readonly active: SqliteEventJournal;
  private readonly readOnly: boolean;

  constructor(
    private readonly retention: JournalRetentionService,
    mode: "read-only" | "read-write" = "read-only",
  ) {
    this.readOnly = mode === "read-only";
    this.active = mode === "read-only"
      ? SqliteEventJournal.openReadOnly(retention.databasePath)
      : new SqliteEventJournal(retention.databasePath);
  }

  append(streamId: StreamId, expectedVersion: number, events: readonly NewEvent<string, unknown>[]): readonly StoredEvent[] {
    return this.active.append(streamId, expectedVersion, events);
  }

  readAll(afterPosition = 0): readonly StoredEvent[] {
    return materializePages((position) => this.readAllPage(position), afterPosition, "global") as readonly StoredEvent[];
  }

  readStream(streamId: StreamId, afterVersion = 0): readonly StoredEvent[] {
    return materializePages((version) => this.readStreamPage(streamId, version), afterVersion, "stream") as readonly StoredEvent[];
  }

  readAllPage(afterPosition = 0, limits: JournalPageLimits = DEFAULT_LIMITS): GlobalEventPage {
    const combinedHead = this.retention.globalHead();
    const archived = this.retention.archivePage(afterPosition, limits);
    const events = [...archived.events];
    let bytes = archived.bytes;
    if (!archived.hasMore && events.length < limits.maxEvents && bytes < limits.maxBytes) {
      const active = this.active.readAllPage(Math.max(afterPosition, archived.nextPosition), {
        maxEvents: limits.maxEvents - events.length,
        maxBytes: limits.maxBytes - bytes,
      });
      events.push(...active.events);
      bytes += active.bytes;
      return {
        events,
        nextPosition: events.at(-1)?.globalPosition ?? afterPosition,
        hasMore: (events.at(-1)?.globalPosition ?? afterPosition) < combinedHead,
        bytes,
      };
    }
    return {
      ...archived,
      hasMore: archived.nextPosition < combinedHead,
    };
  }

  readStreamPage(streamId: StreamId, afterVersion = 0, limits: JournalPageLimits = DEFAULT_LIMITS): StreamEventPage {
    const combinedHead = this.retention.streamHead(streamId);
    const archived = this.retention.archiveStreamPage(streamId, afterVersion, limits);
    const events = [...archived.events];
    let bytes = archived.bytes;
    if (!archived.hasMore && events.length < limits.maxEvents && bytes < limits.maxBytes) {
      const active = this.active.readStreamPage(streamId, Math.max(afterVersion, archived.archivedVersion), {
        maxEvents: limits.maxEvents - events.length,
        maxBytes: limits.maxBytes - bytes,
      });
      events.push(...active.events);
      bytes += active.bytes;
      const nextVersion = events.at(-1)?.streamVersion ?? afterVersion;
      return { events, nextVersion, hasMore: nextVersion < combinedHead, bytes };
    }
    return {
      events: archived.events,
      nextVersion: archived.nextVersion,
      hasMore: archived.nextVersion < combinedHead,
      bytes: archived.bytes,
    };
  }

  inspectProjectionCursor(name: string): ProjectionCursor | null {
    validateProjectionName(name);
    const db = this.projectionDatabase(true);
    try {
      const row = projectionRow(db, name, false);
      return row === null ? null : projectionCursor(row, this.retention.globalHead());
    } finally {
      db.close();
    }
  }

  inspectProjectionClaim(name: string): ProjectionClaim | null {
    validateProjectionName(name);
    const db = this.projectionDatabase(true);
    try {
      const row = projectionRow(db, name, false);
      if (row === null || row.claim_id === null) return null;
      return this.projectionClaim(row, true);
    } finally {
      db.close();
    }
  }

  ensureProjectionCursor(name: string, initialPosition?: number | "head"): ProjectionCursor {
    this.assertWritable();
    validateProjectionName(name);
    const db = this.projectionDatabase(false);
    try {
      return db.transaction(() => {
        const head = this.retention.globalHead();
        const position = initialPosition === "head" ? head : initialPosition ?? 0;
        assertNonnegativePosition(position, "projection initial position");
        if (position > head) throw new Error("projection initial position is ahead of journal head");
        db.prepare("INSERT INTO projection_cursors (name, position) VALUES (?, ?) ON CONFLICT(name) DO NOTHING")
          .run(name, position);
        return projectionCursor(projectionRow(db, name), head);
      }).immediate();
    } finally {
      db.close();
    }
  }

  claimProjection(name: string, claimantId: string, limits?: JournalPageLimits): ProjectionClaim | null {
    this.assertWritable();
    validateProjectionName(name);
    validateClaimantId(claimantId);
    const bounded = limits ?? DEFAULT_LIMITS;
    validatePageLimits(bounded);
    const db = this.projectionDatabase(false);
    try {
      return db.transaction(() => {
        db.prepare("INSERT INTO projection_cursors (name, position) VALUES (?, 0) ON CONFLICT(name) DO NOTHING")
          .run(name);
        let row = projectionRow(db, name);
        if (row.claim_id !== null) {
          if (row.claimant_id !== claimantId) throw new Error("projection claim is owned by another claimant");
          db.prepare("UPDATE projection_cursors SET replay_count = replay_count + 1 WHERE name = ?").run(name);
          row = projectionRow(db, name);
          return this.projectionClaim(row, true);
        }
        const page = this.readAllPage(row.position, bounded);
        if (page.events.length === 0) return null;
        const claimId = randomUUID();
        db.prepare(`
          UPDATE projection_cursors
          SET claim_id = ?, claim_through_position = ?, claim_event_count = ?,
              claim_bytes = ?, claim_digest = ?, claimant_id = ?
          WHERE name = ? AND claim_id IS NULL
        `).run(
          claimId,
          page.nextPosition,
          page.events.length,
          page.bytes,
          digestStoredEvents(page.events),
          claimantId,
          name,
        );
        return this.projectionClaim(projectionRow(db, name), false);
      }).immediate();
    } finally {
      db.close();
    }
  }

  recoverProjectionClaim(name: string, claimId: string, claimantId: string): ProjectionClaim {
    this.assertWritable();
    validateProjectionName(name);
    validateClaimantId(claimantId);
    if (!claimId) throw new Error("projection claim ID must not be empty");
    const db = this.projectionDatabase(false);
    try {
      return db.transaction(() => {
        const row = projectionRow(db, name);
        if (row.claim_id !== claimId) throw new Error("projection claim does not match the active claim");
        if (!claimantProcessIsDead(requiredClaimantId(row.claimant_id))) {
          throw new Error("projection claim owner is live or cannot be verified dead");
        }
        this.projectionClaim(row, true);
        const result = db.prepare(`
          UPDATE projection_cursors SET claimant_id = ?, replay_count = replay_count + 1
          WHERE name = ? AND claim_id = ? AND claimant_id = ?
        `).run(claimantId, name, claimId, row.claimant_id);
        if (result.changes !== 1) throw new Error("projection claim recovery conflict");
        return this.projectionClaim(projectionRow(db, name), true);
      }).immediate();
    } finally {
      db.close();
    }
  }

  commitProjection(name: string, claimId: string, claimantId: string): ProjectionCursor {
    this.assertWritable();
    validateProjectionName(name);
    validateClaimantId(claimantId);
    if (!claimId) throw new Error("projection claim ID must not be empty");
    const db = this.projectionDatabase(false);
    try {
      return db.transaction(() => {
        const row = projectionRow(db, name);
        if (row.claim_id !== claimId || row.claimant_id !== claimantId) {
          throw new Error("projection claim does not match the active claim");
        }
        const claim = this.projectionClaim(row, true);
        const result = db.prepare(`
          UPDATE projection_cursors
          SET position = ?, claim_id = NULL, claim_through_position = NULL,
              claim_event_count = NULL, claim_bytes = NULL, claim_digest = NULL,
              claimant_id = NULL
          WHERE name = ? AND position = ? AND claim_id = ? AND claimant_id = ?
        `).run(claim.throughPosition, name, row.position, claimId, claimantId);
        if (result.changes !== 1) throw new Error("projection claim commit conflict");
        return projectionCursor(projectionRow(db, name), this.retention.globalHead());
      }).immediate();
    } finally {
      db.close();
    }
  }

  private projectionClaim(row: ProjectionRow, replayed: boolean): ProjectionClaim {
    const through = requiredClaimInteger(row.claim_through_position, "projection claim range");
    const count = requiredClaimInteger(row.claim_event_count, "projection claim count");
    const bytes = requiredClaimInteger(row.claim_bytes, "projection claim bytes");
    const digest = requiredClaimDigest(row.claim_digest);
    if (through <= row.position || through - row.position !== count || count > 10_000 || bytes > 64 * 1024 * 1024) {
      throw new Error("projection claim metadata limit or range is invalid");
    }
    const page = this.readAllPage(row.position, { maxEvents: count, maxBytes: bytes });
    if (page.events.length !== count || page.nextPosition !== through || page.bytes !== bytes ||
      digestStoredEvents(page.events) !== digest) {
      throw new Error("event journal projection claim digest or range is corrupt");
    }
    const head = this.retention.globalHead();
    return {
      name: row.name,
      claimId: row.claim_id!,
      afterPosition: row.position,
      throughPosition: through,
      events: page.events,
      bytes,
      highWaterPosition: head,
      lag: head - row.position,
      replayed,
      replayCount: row.replay_count,
      claimantId: requiredClaimantId(row.claimant_id),
    };
  }

  private projectionDatabase(readOnly: boolean): Database.Database {
    return new Database(this.retention.databasePath, {
      readonly: readOnly,
      fileMustExist: true,
      timeout: 1_000,
    });
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error("event journal is read-only");
  }

  close(): void { this.active.close(); }
}

export function openAuthoritativeJournal(
  databasePath: string,
  mode: "read-only" | "read-write",
): ArchivedEventJournal {
  const retention = mode === "read-only"
    ? JournalRetentionService.openReadOnly(databasePath)
    : new JournalRetentionService(databasePath);
  return retention.openCombinedJournal(mode);
}

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

function appendAudit(db: Database.Database, type: string, payload: Record<string, unknown>): StoredEvent {
  const row = db.prepare("SELECT current_version FROM streams WHERE stream_id = ?").get(RETENTION_STREAM) as
    { readonly current_version: number } | undefined;
  const version = (row?.current_version ?? 0) + 1;
  db.prepare("INSERT OR IGNORE INTO streams (stream_id, current_version) VALUES (?, 0)").run(RETENTION_STREAM);
  const eventId = randomUUID();
  const recordedAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO events (event_id, stream_id, stream_version, type, payload,
      causation_id, correlation_id, recorded_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(eventId, RETENTION_STREAM, version, type, JSON.stringify(payload), RETENTION_STREAM, recordedAt);
  db.prepare("UPDATE streams SET current_version = ? WHERE stream_id = ?").run(version, RETENTION_STREAM);
  return {
    streamId: RETENTION_STREAM,
    type,
    payload,
    causationId: null,
    correlationId: RETENTION_STREAM,
    eventId,
    streamVersion: version,
    globalPosition: Number(result.lastInsertRowid),
    recordedAt,
  };
}

function metadataFromDatabase(db: Database.Database): JournalMetadata {
  const row = db.prepare(`
    SELECT journal_id, global_position, retained_through_position,
           archive_head_position, archive_head_manifest_sha256, archive_segment_count
    FROM journal_metadata WHERE singleton = 1
  `).get() as {
    readonly journal_id: string;
    readonly global_position: number;
    readonly retained_through_position: number;
    readonly archive_head_position: number;
    readonly archive_head_manifest_sha256: string | null;
    readonly archive_segment_count: number;
  };
  return {
    journalId: row.journal_id,
    globalPosition: row.global_position,
    retainedThroughPosition: row.retained_through_position,
    archiveHeadPosition: row.archive_head_position,
    archiveHeadManifestSha256: row.archive_head_manifest_sha256,
    archiveSegmentCount: row.archive_segment_count,
  };
}

function requiredOperation(db: Database.Database, operationId: string, state: OperationRow["state"]): OperationRow {
  const row = db.prepare("SELECT * FROM retention_operations WHERE operation_id = ?").get(operationId) as OperationRow | undefined;
  if (row === undefined || row.state !== state) throw new Error("retention operation state changed or is missing");
  return row;
}

function projectionRow(db: Database.Database, name: string): ProjectionRow;
function projectionRow(db: Database.Database, name: string, required: false): ProjectionRow | null;
function projectionRow(db: Database.Database, name: string, required = true): ProjectionRow | null {
  const row = db.prepare(`
    SELECT name, position, claim_id, claim_through_position, claim_event_count,
           claim_bytes, claim_digest, claimant_id, replay_count
    FROM projection_cursors WHERE name = ?
  `).get(name) as ProjectionRow | undefined;
  if (row === undefined && required) throw new Error("projection cursor is missing");
  return row ?? null;
}

function projectionCursor(row: ProjectionRow, head: number): ProjectionCursor {
  assertNonnegativePosition(row.position, "projection cursor position");
  if (!Number.isSafeInteger(row.replay_count) || row.replay_count < 0 || row.position > head) {
    throw new Error("projection cursor metadata is corrupt");
  }
  return {
    name: row.name,
    position: row.position,
    highWaterPosition: head,
    lag: head - row.position,
    replayCount: row.replay_count,
    activeClaimId: row.claim_id,
  };
}

function validateProjectionName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name)) {
    throw new Error("projection name must be a scoped ASCII identifier");
  }
}

function validateClaimantId(value: string): void {
  if (!/^process:[1-9]\d{0,9}:[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("projection claimant must be a structured process identity");
  }
}

function requiredClaimantId(value: string | null): string {
  if (value === null) throw new Error("projection claimant is corrupt");
  if (value === "migration:unowned") return value;
  validateClaimantId(value);
  return value;
}

function requiredClaimInteger(value: number | null, label: string): number {
  if (value === null || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is corrupt`);
  return value;
}

function requiredClaimDigest(value: string | null): string {
  if (value === null || !/^[a-f0-9]{64}$/.test(value)) throw new Error("projection claim digest is corrupt");
  return value;
}

function digestStoredEvents(events: readonly StoredEvent[]): string {
  const digest = createHash("sha256");
  for (const event of events) digest.update(canonicalEventLine(event), "utf8");
  return digest.digest("hex");
}

function claimantProcessIsDead(claimantId: string): boolean {
  if (claimantId === "migration:unowned") return true;
  const match = /^process:(\d+):/.exec(claimantId);
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

function assertNoCursorBlockers(db: Database.Database, boundary: number): void {
  const rows = db.prepare(`
    SELECT name FROM projection_cursors WHERE position < ? OR claim_id IS NOT NULL ORDER BY name
  `).all(boundary) as Array<{ readonly name: string }>;
  if (rows.length > 0) throw new Error(`projection cursor blocked below prune boundary: ${rows.map((row) => row.name).join(", ")}`);
}

function compareActiveOverlap(db: Database.Database, event: StoredEvent): void {
  const row = db.prepare(`
    SELECT event_id, stream_id, stream_version, global_position, type, payload,
           causation_id, correlation_id, recorded_at
    FROM events WHERE global_position = ?
  `).get(event.globalPosition) as EventRow | undefined;
  if (row === undefined || canonicalEventLine(toStoredEvent(row)) !== canonicalEventLine(event)) {
    throw new Error(`archive conflicts with active journal at global position ${event.globalPosition}`);
  }
}

function runIncrementalVacuum(
  db: Database.Database,
  requestedPages: number,
  deadlineMs: number,
  signal?: AbortSignal,
): VacuumEvidence {
  const started = process.hrtime.bigint();
  const beforeFreelist = db.pragma("freelist_count", { simple: true }) as number;
  if (requestedPages === 0) {
    return {
      status: "not_requested",
      requestedPages,
      beforeFreelist,
      afterFreelist: beforeFreelist,
      reclaimedPages: 0,
      elapsedMs: 0,
    };
  }
  throwIfMaintenanceAborted(signal);
  const autoVacuum = db.pragma("auto_vacuum", { simple: true }) as number;
  if (autoVacuum !== 2) {
    return {
      status: "not_supported",
      requestedPages,
      beforeFreelist,
      afterFreelist: beforeFreelist,
      reclaimedPages: 0,
      elapsedMs: elapsedMilliseconds(started),
    };
  }
  if (elapsedMilliseconds(started) >= deadlineMs) throw new Error("incremental vacuum timed out before execution");
  db.pragma(`incremental_vacuum(${requestedPages})`);
  throwIfMaintenanceAborted(signal);
  const elapsedMs = elapsedMilliseconds(started);
  if (elapsedMs > deadlineMs) throw new Error("incremental vacuum exceeded its deadline");
  const afterFreelist = db.pragma("freelist_count", { simple: true }) as number;
  return {
    status: "completed",
    requestedPages,
    beforeFreelist,
    afterFreelist,
    reclaimedPages: Math.max(0, beforeFreelist - afterFreelist),
    elapsedMs,
  };
}

function throwIfMaintenanceAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error("journal maintenance was cancelled");
}

function elapsedMilliseconds(started: bigint): number {
  return Number((process.hrtime.bigint() - started) / 1_000_000n);
}

function parseMaintenanceEvidence(value: string | null): MaintenanceEvidence {
  if (value === null) throw new Error("maintenance completion evidence is missing");
  let evidence: MaintenanceEvidence;
  try {
    evidence = JSON.parse(value) as MaintenanceEvidence;
  } catch {
    throw new Error("maintenance completion evidence is corrupt");
  }
  if (typeof evidence.backupPath !== "string" || !/^[a-f0-9]{64}$/.test(evidence.backupSha256) ||
    !Number.isSafeInteger(evidence.backupBytes) || evidence.backupBytes <= 0 ||
    typeof evidence.checkpointed !== "boolean" || typeof evidence.checkpointRequested !== "boolean" ||
    !Number.isSafeInteger(evidence.progress?.totalPages) || evidence.progress.totalPages < 0 ||
    evidence.progress?.remainingPages !== 0 ||
    !Number.isSafeInteger(evidence.vacuum?.requestedPages) ||
    !Number.isSafeInteger(evidence.vacuum?.beforeFreelist) || evidence.vacuum.beforeFreelist < 0 ||
    !Number.isSafeInteger(evidence.vacuum?.afterFreelist) || evidence.vacuum.afterFreelist < 0 ||
    evidence.vacuum.reclaimedPages !== Math.max(0, evidence.vacuum.beforeFreelist - evidence.vacuum.afterFreelist) ||
    !["not_requested", "not_supported", "completed"].includes(evidence.vacuum?.status) ||
    (evidence.checkpointRequested && evidence.checkpoint === null) ||
    (!evidence.checkpointRequested && evidence.checkpoint !== null) ||
    evidence.checkpointed !== (evidence.checkpoint === null ||
      (evidence.checkpoint.busy === 0 && evidence.checkpoint.checkpointedFrames === evidence.checkpoint.logFrames))) {
    throw new Error("maintenance completion evidence is corrupt");
  }
  return evidence;
}

function parseRestoreEvidence(value: string | null, requirePublished: boolean): RestoreEvidence {
  let evidence: RestoreEvidence;
  try {
    evidence = JSON.parse(value ?? "") as RestoreEvidence;
  } catch {
    throw new Error("restore operation evidence is corrupt");
  }
  if (!SAFE_NAME.test(evidence.name) || !Number.isSafeInteger(evidence.throughPosition) ||
    evidence.throughPosition < 0 || (requirePublished &&
      (!Number.isSafeInteger(evidence.eventCount) || evidence.eventCount! < 0 ||
        !Number.isSafeInteger(evidence.bytes) || evidence.bytes! <= 0 ||
        typeof evidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.sha256)))) {
    throw new Error("restore operation evidence is corrupt");
  }
  return evidence;
}

function verifyRestoredDatabase(databasePath: string, evidence: RestoreEvidence): void {
  const descriptor = openNoFollow(databasePath);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
      !ownedByCurrentUser(info) || info.size !== evidence.bytes) {
      throw new Error("restored journal identity, mode, or size is invalid");
    }
  } finally {
    closeSync(descriptor);
  }
  if (sha256File(databasePath) !== evidence.sha256) throw new Error("restored journal digest is invalid");
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (database.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new Error("restored journal integrity check failed");
    }
  } finally {
    database.close();
  }
}

function verifyMaintenanceBackup(backupPath: string, evidence: MaintenanceEvidence): void {
  if (backupPath !== evidence.backupPath) throw new Error("maintenance backup path does not match evidence");
  const descriptor = openNoFollow(backupPath);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o400 ||
      info.size !== evidence.backupBytes) {
      throw new Error("maintenance backup identity, mode, or size is invalid");
    }
  } finally {
    closeSync(descriptor);
  }
  if (sha256File(backupPath) !== evidence.backupSha256) throw new Error("maintenance backup digest is invalid");
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    if (backup.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new Error("maintenance backup integrity check failed");
    }
    const autoVacuum = backup.pragma("auto_vacuum", { simple: true }) as number;
    if ((evidence.vacuum.status === "completed" && autoVacuum !== 2) ||
      (evidence.vacuum.status === "not_supported" && autoVacuum === 2)) {
      throw new Error("maintenance vacuum support evidence does not match backup");
    }
  } finally {
    backup.close();
  }
}

function forEachLine(filePath: string, visitor: (line: string) => void | false): void {
  const descriptor = openNoFollow(filePath);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_ARCHIVE_BYTES ||
      (info.mode & 0o777) !== 0o400 || !ownedByCurrentUser(info)) {
      throw new Error("archive segment is linked, permissive, has an invalid mode, or is oversized");
    }
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      pending += decoder.write(buffer.subarray(0, count));
      if (Buffer.byteLength(pending) > MAX_ARCHIVE_LINE_BYTES + COPY_BUFFER_BYTES) {
        throw new Error("archive event line exceeds its bound");
      }
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        if (visitor(line) === false) return;
      }
    }
    pending += decoder.end();
    if (pending.length !== 0) throw new Error("archive segment checksum or canonical form is tampered by an incomplete final line");
  } finally {
    closeSync(descriptor);
  }
}

function parseEventLine(line: string, expectedPosition: number): StoredEvent {
  let event: StoredEvent;
  try {
    event = JSON.parse(line) as StoredEvent;
  } catch {
    throw new Error("archive event JSON is corrupt");
  }
  if (event.globalPosition !== expectedPosition || canonicalEventLine(event) !== line) {
    throw new Error(`archive event canonical form or position ${expectedPosition} is corrupt`);
  }
  return event;
}

function validateManifest(manifest: ArchiveManifest): void {
  if (manifest.format !== ARCHIVE_FORMAT || !/^[0-9a-f-]{36}$/.test(manifest.journalId) ||
    !SAFE_NAME.test(manifest.segmentId) || !Number.isSafeInteger(manifest.fromPosition) ||
    manifest.fromPosition <= 0 || !Number.isSafeInteger(manifest.throughPosition) ||
    manifest.throughPosition < manifest.fromPosition ||
    manifest.eventCount !== manifest.throughPosition - manifest.fromPosition + 1 ||
    manifest.eventCount > MAX_ARCHIVE_EVENTS || !Number.isSafeInteger(manifest.byteLength) ||
    manifest.byteLength <= 0 || manifest.byteLength > MAX_ARCHIVE_BYTES ||
    !/^[a-f0-9]{64}$/.test(manifest.segmentSha256) ||
    (manifest.previousManifestSha256 !== null && !/^[a-f0-9]{64}$/.test(manifest.previousManifestSha256)) ||
    manifest.policy?.mode !== "retain_forever" || manifest.policy.automaticDeletion !== false) {
    throw new Error("archive manifest is corrupt");
  }
}

function canonicalEventLine(event: StoredEvent): string {
  return `${JSON.stringify({
    streamId: event.streamId,
    type: event.type,
    payload: event.payload,
    causationId: event.causationId,
    correlationId: event.correlationId,
    eventId: event.eventId,
    streamVersion: event.streamVersion,
    globalPosition: event.globalPosition,
    recordedAt: event.recordedAt,
  })}\n`;
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

function materializePages(
  read: (after: number) => GlobalEventPage | StreamEventPage,
  after: number,
  _kind: "global" | "stream",
): readonly StoredEvent[] {
  const events: StoredEvent[] = [];
  let cursor = after;
  while (true) {
    const page = read(cursor);
    events.push(...page.events);
    if (events.length > 100_000 || storedEventsBytes(events) > 64 * 1024 * 1024) {
      throw new Error("journal materialization limit exceeded; use pages");
    }
    if (!page.hasMore) return events;
    const next = "nextPosition" in page ? page.nextPosition : page.nextVersion;
    if (next <= cursor) throw new Error("journal page did not make monotonic progress");
    cursor = next;
  }
}

function storedEventsBytes(events: readonly StoredEvent[]): number {
  return events.reduce((total, event) => total + storedEventBytes(event), 0);
}

function storedEventBytes(event: StoredEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function openPrivate(filePath: string): number {
  return openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}

function openNoFollow(filePath: string): number {
  try {
    return openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error("archive file is unsafe or unavailable");
  }
}

function publishNoClobber(
  temporary: string,
  destination: string,
  mode: number,
  failurePoint?: "before_chmod" | "before_link" | "after_link" | "process_kill_after_fsync",
): void {
  let linked = false;
  try {
    if (failurePoint === "before_chmod") throw new Error("injected publication failure before chmod");
    chmodSync(temporary, mode);
    fsyncFile(temporary);
    if (failurePoint === "process_kill_after_fsync") process.kill(process.pid, "SIGKILL");
    if (failurePoint === "before_link") throw new Error("injected publication failure before link");
    linkSync(temporary, destination);
    linked = true;
    if (failurePoint === "after_link") throw new Error("injected publication failure after link");
  } catch (error) {
    if (linked && existsSync(destination)) unlinkSync(destination);
    throw error;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncFile(filePath: string): void {
  const descriptor = openNoFollow(filePath);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function sha256File(filePath: string): string {
  const descriptor = openNoFollow(filePath);
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  try {
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function unlinkDatabaseFiles(databasePath: string): void {
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}

function unlinkDatabaseSidecars(databasePath: string): void {
  for (const candidate of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}

function identity(info: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

function ownedByCurrentUser(info: { readonly uid: number }): boolean {
  return process.getuid === undefined || info.uid === process.getuid();
}

function assertSafeSqliteSidecars(databasePath: string): void {
  for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!existsSync(sidecar)) continue;
    const info = lstatSync(sidecar);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !ownedByCurrentUser(info)) {
      throw new Error("journal SQLite sidecar identity is unsafe");
    }
  }
}

function assertSameIdentity(
  info: { readonly dev: number; readonly ino: number },
  expected: FileIdentity,
  label: string,
): void {
  if (info.dev !== expected.dev || info.ino !== expected.ino) throw new Error(`${label} identity changed`);
}

function segmentIdentity(from: number, through: number): string {
  return `${String(from).padStart(16, "0")}-${String(through).padStart(16, "0")}`;
}

function reconcileConfirmation(operationId: string, state: string): string {
  return `RECONCILE OPERATION ${operationId} STATE ${state}`;
}

function validatePageLimits(limits: JournalPageLimits): void {
  if (!Number.isSafeInteger(limits.maxEvents) || limits.maxEvents <= 0 || limits.maxEvents > 10_000 ||
    !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0 || limits.maxBytes > MAX_ARCHIVE_BYTES) {
    throw new Error("journal page limits are invalid");
  }
}

function assertPosition(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function assertNonnegativePosition(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
}

function assertOperator(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("operator identity is invalid");
}

function assertSafeName(value: string): void {
  if (!SAFE_NAME.test(value) || value === "." || value === "..") throw new Error("destination must be one safe file name");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicReason(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "unknown failure";
}
