import type { NewEvent, StoredEvent } from "../contracts/event.js";
import type { StreamId } from "../contracts/ids.js";
import {
  isDurablePagedEventJournal,
  createProjectionClaimantId,
  readAllPageCompatible,
  readStreamPageCompatible,
} from "./journal.js";

const DURABLE_JOURNAL_CAPABILITY = Symbol.for("zentra.durable-paged-event-journal.v1");
import type {
  DurablePagedEventJournal,
  EventJournal,
  GlobalEventPage,
  JournalPageLimits,
  ProjectionClaim,
  ProjectionCursor,
  StreamEventPage,
} from "./journal.js";

export interface StoredEventSink {
  readonly projectionCursorName?: string;
  readonly idempotentDelivery?: boolean;
  select?(events: readonly StoredEvent[]): readonly StoredEvent[];
  reconcile?(events: readonly StoredEvent[]): void;
  reconcileHistory?(
    committed: Iterable<StoredEvent>,
  ): void;
  append(events: readonly StoredEvent[]): void;
}

export class ProjectingEventJournal implements DurablePagedEventJournal {
  private failed = false;
  private readonly durable: DurablePagedEventJournal | null;

  get [DURABLE_JOURNAL_CAPABILITY](): boolean {
    return this.durable !== null;
  }

  constructor(
    private readonly inner: EventJournal,
    private readonly sink: StoredEventSink,
    private readonly cursorName = sink.projectionCursorName ?? "projection:default",
    initialPosition: number | "head" = 0,
    private readonly claimantId = createProjectionClaimantId(),
  ) {
    this.durable = isDurablePagedEventJournal(inner) ? inner : null;
    if (this.durable === null) return;
    this.durable.ensureProjectionCursor(this.cursorName, initialPosition);
    try {
      const cursor = this.durable.inspectProjectionCursor(this.cursorName)!;
      let active = this.durable.inspectProjectionClaim(this.cursorName);
      if (this.sink.reconcileHistory !== undefined) {
        if (active !== null && active.claimantId !== this.claimantId) {
          if (this.sink.idempotentDelivery !== true) {
            throw new Error("projection claim recovery requires an idempotent reconciler");
          }
          active = this.durable.recoverProjectionClaim(
            this.cursorName,
            active.claimId,
            this.claimantId,
          );
        }
        if (active !== null && supportsAuthoritativeTornRepair(this.sink)) {
          this.sink.repairTornClaim(
            this.durable,
            this.cursorName,
            active.claimId,
            this.claimantId,
            this.committedEvents(cursor.position),
          );
        } else {
          this.sink.reconcileHistory(this.committedEvents(cursor.position));
        }
        if (active !== null) {
          const selected = this.sink.select?.(active.events) ?? active.events;
          if (selected.length > 0) this.sink.append(selected);
          this.durable.commitProjection(this.cursorName, active.claimId, this.claimantId);
        }
      }
      this.drain();
    } catch {
      this.failed = true;
    }
  }

  append(
    streamId: StreamId,
    expectedVersion: number,
    events: readonly NewEvent<string, unknown>[],
  ): readonly StoredEvent[] {
    const stored = this.inner.append(streamId, expectedVersion, events);
    if (!this.failed) {
      if (this.durable === null) {
        try {
          const selected = this.sink.select?.(stored) ?? stored;
          if (selected.length > 0) this.sink.append(selected);
        } catch {
          this.failed = true;
        }
      } else {
        this.drain();
      }
    }
    return stored;
  }

  get projectionFailed(): boolean {
    return this.failed;
  }

  get projectionCursorName(): string {
    return this.cursorName;
  }

  readStream(streamId: StreamId, afterVersion = 0): readonly StoredEvent[] {
    return this.inner.readStream(streamId, afterVersion);
  }

  readAll(afterPosition = 0): readonly StoredEvent[] {
    return this.inner.readAll(afterPosition);
  }

  readStreamPage(
    streamId: StreamId,
    afterVersion = 0,
    limits?: JournalPageLimits,
  ): StreamEventPage {
    return readStreamPageCompatible(
      this.inner,
      streamId,
      afterVersion,
      limits ?? { maxEvents: 1_000, maxBytes: 16 * 1024 * 1024 },
    );
  }

  readAllPage(afterPosition = 0, limits?: JournalPageLimits): GlobalEventPage {
    return readAllPageCompatible(
      this.inner,
      afterPosition,
      limits ?? { maxEvents: 1_000, maxBytes: 16 * 1024 * 1024 },
    );
  }

  inspectProjectionCursor(name: string): ProjectionCursor | null {
    return this.requireDurable().inspectProjectionCursor(name);
  }

  inspectProjectionClaim(name: string): ProjectionClaim | null {
    return this.requireDurable().inspectProjectionClaim(name);
  }

  ensureProjectionCursor(name: string, initialPosition: number | "head" = 0): ProjectionCursor {
    return this.requireDurable().ensureProjectionCursor(name, initialPosition);
  }

  claimProjection(
    name: string,
    claimantId: string,
    limits?: JournalPageLimits,
  ): ProjectionClaim | null {
    return this.requireDurable().claimProjection(name, claimantId, limits);
  }

  recoverProjectionClaim(
    name: string,
    claimId: string,
    claimantId: string,
  ): ProjectionClaim {
    return this.requireDurable().recoverProjectionClaim(name, claimId, claimantId);
  }

  commitProjection(name: string, claimId: string, claimantId: string): ProjectionCursor {
    return this.requireDurable().commitProjection(name, claimId, claimantId);
  }

  private drain(): void {
    const journal = this.requireDurable();
    try {
      while (true) {
        const active = journal.inspectProjectionClaim(this.cursorName);
        let claim: ProjectionClaim | null;
        if (active !== null && active.claimantId !== this.claimantId) {
          if (this.sink.idempotentDelivery !== true || this.sink.reconcile === undefined) {
            throw new Error("projection claim recovery requires an idempotent reconciler");
          }
          claim = journal.recoverProjectionClaim(
            this.cursorName,
            active.claimId,
            this.claimantId,
          );
          this.sink.reconcile(claim.events);
        } else {
          claim = journal.claimProjection(this.cursorName, this.claimantId);
        }
        if (claim === null) return;
        const selected = this.sink.select?.(claim.events) ?? claim.events;
        if (selected.length > 0) this.sink.append(selected);
        journal.commitProjection(this.cursorName, claim.claimId, this.claimantId);
      }
    } catch {
      this.failed = true;
    }
  }

  private *committedEvents(throughPosition: number): Generator<StoredEvent> {
    let afterPosition = 0;
    while (afterPosition < throughPosition) {
      const page = this.requireDurable().readAllPage(afterPosition, {
        maxEvents: 1_000,
        maxBytes: 16 * 1024 * 1024,
      });
      for (const event of page.events) {
        if (event.globalPosition > throughPosition) return;
        yield event;
      }
      if (!page.hasMore || page.nextPosition <= afterPosition) return;
      afterPosition = page.nextPosition;
    }
  }

  private requireDurable(): DurablePagedEventJournal {
    if (this.durable === null) throw new Error("journal does not support durable projection claims");
    return this.durable;
  }
}

interface AuthoritativeTornRepairSink {
  repairTornClaim(
    journal: DurablePagedEventJournal,
    projectionName: string,
    claimId: string,
    claimantId: string,
    committed: Iterable<StoredEvent>,
  ): void;
}

function supportsAuthoritativeTornRepair(
  sink: StoredEventSink,
): sink is StoredEventSink & AuthoritativeTornRepairSink {
  return "repairTornClaim" in sink &&
    typeof (sink as Partial<AuthoritativeTornRepairSink>).repairTornClaim === "function";
}
