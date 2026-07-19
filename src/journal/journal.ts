import { randomUUID } from "node:crypto";
import type { NewEvent, StoredEvent } from "../contracts/event.js";
import type { StreamId } from "../contracts/ids.js";

export const ATOMIC_EVENT_JOURNAL = Symbol.for("zentra.atomic-event-journal.v1");

export interface EventJournal {
  append(
    streamId: StreamId,
    expectedVersion: number,
    events: readonly NewEvent<string, unknown>[],
  ): readonly StoredEvent[];
  readStream(streamId: StreamId, afterVersion?: number): readonly StoredEvent[];
  readAll(afterPosition?: number): readonly StoredEvent[];
}

export interface AtomicAppend {
  readonly streamId: StreamId;
  readonly expectedVersion: number;
  readonly events: readonly NewEvent<string, unknown>[];
}

export interface AtomicEventJournal extends EventJournal {
  readonly [ATOMIC_EVENT_JOURNAL]: true;
  appendAtomically(writes: readonly AtomicAppend[]): readonly StoredEvent[];
}

export interface PagedEventJournal extends EventJournal {
  readStreamPage(
    streamId: StreamId,
    afterVersion?: number,
    limits?: JournalPageLimits,
  ): StreamEventPage;
  readAllPage(afterPosition?: number, limits?: JournalPageLimits): GlobalEventPage;
}

export interface JournalPageLimits {
  readonly maxEvents: number;
  readonly maxBytes: number;
}

export interface GlobalEventPage {
  readonly events: readonly StoredEvent[];
  readonly nextPosition: number;
  readonly hasMore: boolean;
  readonly bytes: number;
  readonly highWaterPosition?: number;
}

export interface StreamEventPage {
  readonly events: readonly StoredEvent[];
  readonly nextVersion: number;
  readonly hasMore: boolean;
  readonly bytes: number;
}

export interface ProjectionCursor {
  readonly name: string;
  readonly position: number;
  readonly highWaterPosition: number;
  readonly lag: number;
  readonly replayCount: number;
  readonly activeClaimId: string | null;
}

export interface ProjectionClaim {
  readonly name: string;
  readonly claimId: string;
  readonly afterPosition: number;
  readonly throughPosition: number;
  readonly events: readonly StoredEvent[];
  readonly bytes: number;
  readonly highWaterPosition: number;
  readonly lag: number;
  readonly replayed: boolean;
  readonly replayCount: number;
  readonly claimantId: string;
}

export interface DurablePagedEventJournal extends PagedEventJournal {
  inspectProjectionCursor(name: string): ProjectionCursor | null;
  inspectProjectionClaim(name: string): ProjectionClaim | null;
  ensureProjectionCursor(name: string, initialPosition?: number | "head"): ProjectionCursor;
  claimProjection(
    name: string,
    claimantId: string,
    limits?: JournalPageLimits,
  ): ProjectionClaim | null;
  recoverProjectionClaim(
    name: string,
    claimId: string,
    claimantId: string,
  ): ProjectionClaim;
  commitProjection(name: string, claimId: string, claimantId: string): ProjectionCursor;
}

const CONSUMER_PAGE_LIMITS: JournalPageLimits = {
  maxEvents: 1_000,
  maxBytes: 16 * 1024 * 1024,
};
const MAX_MATERIALIZED_STREAM_EVENTS = 100_000;
const MAX_MATERIALIZED_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_PROJECTION_ENTRIES = 100_000;
export const DURABLE_PAGED_EVENT_JOURNAL = Symbol.for("zentra.durable-paged-event-journal.v1");
export function createProjectionClaimantId(): string {
  return `process:${process.pid}:${randomUUID()}`;
}

export function assertBoundedProjectionEntries(size: number, label: string): void {
  if (size > MAX_PROJECTION_ENTRIES) {
    throw new Error(`${label} exceeds the bounded projection entry limit`);
  }
}

export function isPagedEventJournal(journal: EventJournal): journal is PagedEventJournal {
  const candidate = journal as Partial<PagedEventJournal>;
  return typeof candidate.readStreamPage === "function" && typeof candidate.readAllPage === "function";
}

export function isAtomicEventJournal(journal: EventJournal): journal is AtomicEventJournal {
  return (journal as EventJournal & { readonly [ATOMIC_EVENT_JOURNAL]?: boolean })
    [ATOMIC_EVENT_JOURNAL] === true &&
    typeof (journal as Partial<AtomicEventJournal>).appendAtomically === "function";
}

export function isDurablePagedEventJournal(
  journal: EventJournal,
): journal is DurablePagedEventJournal {
  return (journal as EventJournal & { readonly [DURABLE_PAGED_EVENT_JOURNAL]?: boolean })
    [DURABLE_PAGED_EVENT_JOURNAL] === true;
}

export function* iterateAllEvents(
  journal: EventJournal,
  afterPosition = 0,
): Generator<StoredEvent, void, undefined> {
  let position = afterPosition;
  while (true) {
    const page = readAllPageCompatible(journal, position, CONSUMER_PAGE_LIMITS);
    for (const event of page.events) yield event;
    if (!page.hasMore) return;
    if (page.nextPosition <= position) {
      throw new Error("event journal global page did not make monotonic progress");
    }
    position = page.nextPosition;
  }
}

export function findAllEvent(
  journal: EventJournal,
  predicate: (event: StoredEvent) => boolean,
): StoredEvent | undefined {
  for (const event of iterateAllEvents(journal)) {
    if (predicate(event)) return event;
  }
  return undefined;
}

// Aggregate streams are targeted by identity and folded by strict projectors.
// Database access advances through bounded pages rather than legacy whole-read limits.
export function readStreamEvents(
  journal: EventJournal,
  streamId: StreamId,
  afterVersion = 0,
): readonly StoredEvent[] {
  const events: StoredEvent[] = [];
  let bytes = 0;
  for (const event of iterateStreamEvents(journal, streamId, afterVersion)) {
    bytes += Buffer.byteLength(JSON.stringify(event), "utf8");
    if (
      events.length >= MAX_MATERIALIZED_STREAM_EVENTS ||
      bytes > MAX_MATERIALIZED_STREAM_BYTES
    ) {
      throw new Error("targeted journal stream exceeds the bounded materialization limit");
    }
    events.push(event);
  }
  return events;
}

export function* iterateStreamEvents(
  journal: EventJournal,
  streamId: StreamId,
  afterVersion = 0,
): Generator<StoredEvent, void, undefined> {
  let version = afterVersion;
  while (true) {
    const page = readStreamPageCompatible(journal, streamId, version, CONSUMER_PAGE_LIMITS);
    for (const event of page.events) yield event;
    if (!page.hasMore) return;
    if (page.nextVersion <= version) {
      throw new Error("event journal stream page did not make monotonic progress");
    }
    version = page.nextVersion;
  }
}

export function foldStreamEvents<T>(
  journal: EventJournal,
  streamId: StreamId,
  initial: T,
  reduce: (state: T, event: StoredEvent) => T,
): T {
  let state = initial;
  for (const event of iterateStreamEvents(journal, streamId)) {
    state = reduce(state, event);
  }
  return state;
}

export function streamHasEvents(
  journal: EventJournal,
  streamId: StreamId,
): boolean {
  return readStreamPageCompatible(
    journal,
    streamId,
    0,
    { maxEvents: 1, maxBytes: 16 * 1024 * 1024 },
  )
    .events.length > 0;
}

export function readStreamPageCompatible(
  journal: EventJournal,
  streamId: StreamId,
  afterVersion: number,
  limits: JournalPageLimits,
): StreamEventPage {
  if (isPagedEventJournal(journal)) {
    return journal.readStreamPage(streamId, afterVersion, limits);
  }
  const candidates = journal.readStream(streamId, afterVersion);
  const events = boundedLegacyEvents(candidates, limits);
  return {
    events,
    nextVersion: events.at(-1)?.streamVersion ?? afterVersion,
    hasMore: candidates.length > events.length,
    bytes: storedEventsBytes(events),
  };
}

export function readAllPageCompatible(
  journal: EventJournal,
  afterPosition: number,
  limits: JournalPageLimits,
): GlobalEventPage {
  if (isPagedEventJournal(journal)) return journal.readAllPage(afterPosition, limits);
  const candidates = journal.readAll(afterPosition);
  const events = boundedLegacyEvents(candidates, limits);
  return {
    events,
    nextPosition: events.at(-1)?.globalPosition ?? afterPosition,
    hasMore: candidates.length > events.length,
    bytes: storedEventsBytes(events),
  };
}

function boundedLegacyEvents(
  candidates: readonly StoredEvent[],
  limits: JournalPageLimits,
): readonly StoredEvent[] {
  const events: StoredEvent[] = [];
  let bytes = 0;
  for (const event of candidates) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (events.length >= limits.maxEvents || bytes + eventBytes > limits.maxBytes) break;
    events.push(event);
    bytes += eventBytes;
  }
  if (events.length === 0 && candidates.length > 0) {
    throw new Error("legacy journal event exceeds the bounded compatibility page");
  }
  return events;
}

function storedEventsBytes(events: readonly StoredEvent[]): number {
  return events.reduce(
    (total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"),
    0,
  );
}
