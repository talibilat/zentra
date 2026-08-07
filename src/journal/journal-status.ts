import { isDurablePagedEventJournal, type EventJournal } from "./journal.js";
import { ProjectingEventJournal } from "./projecting-journal.js";
import { JournalRetentionService } from "./retention.js";

export interface JournalProjectionStatus {
  readonly cursorName: string;
  readonly position: number;
  readonly highWaterPosition: number;
  readonly lag: number;
  readonly replayCount: number;
  readonly active: boolean;
}

export interface JournalStatus {
  readonly retention: {
    readonly globalPosition: number;
    readonly retainedThroughPosition: number;
    readonly archiveHeadPosition: number;
    readonly archiveSegmentCount: number;
    readonly policyMode: "retain_forever";
    readonly recoveryOutcome: "clean" | "uncertain";
    readonly recoveryKind: "archive" | "prune" | "maintenance" | "restore" | null;
    readonly recoveryState: string | null;
  } | null;
  readonly projection: JournalProjectionStatus | null;
}

export function getJournalStatus(journal: EventJournal, databasePath: string | undefined): JournalStatus {
  return {
    retention: databasePath === undefined ? null : buildRetentionStatus(databasePath),
    projection: buildProjectionStatus(journal),
  };
}

function buildRetentionStatus(databasePath: string): JournalStatus["retention"] {
  const retention = JournalRetentionService.openReadOnly(databasePath);
  const summary = retention.metadataSummary();
  const recovery = retention.inspectRecovery();
  return {
    globalPosition: summary.globalPosition,
    retainedThroughPosition: summary.retainedThroughPosition,
    archiveHeadPosition: summary.archiveHeadPosition,
    archiveSegmentCount: summary.archiveSegmentCount,
    policyMode: summary.policy.mode,
    recoveryOutcome: recovery.outcome,
    recoveryKind: recovery.kind,
    recoveryState: recovery.outcome === "clean" ? null : recovery.state,
  };
}

function buildProjectionStatus(journal: EventJournal): JournalProjectionStatus | null {
  if (!(journal instanceof ProjectingEventJournal) || !isDurablePagedEventJournal(journal)) return null;
  const cursorName = journal.projectionCursorName;
  const cursor = journal.inspectProjectionCursor(cursorName);
  if (cursor === null) return null;
  return {
    cursorName,
    position: cursor.position,
    highWaterPosition: cursor.highWaterPosition,
    lag: cursor.lag,
    replayCount: cursor.replayCount,
    active: journal.inspectProjectionClaim(cursorName) !== null,
  };
}
