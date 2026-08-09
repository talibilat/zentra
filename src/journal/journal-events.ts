import { iterateAllEvents, type EventJournal } from "./journal.js";
import type { StoredEvent } from "../contracts/event.js";

export interface JournalEventQuery {
  readonly afterPosition?: number;
  readonly streamPrefix?: string;
  readonly typePrefix?: string;
  readonly limit?: number;
}

export interface JournalEventPage {
  readonly events: readonly StoredEvent[];
  readonly nextPosition: number;
  readonly hasMore: boolean;
}

const SCAN_WINDOW = 1_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function listJournalEvents(journal: EventJournal, query: JournalEventQuery): JournalEventPage {
  const afterPosition = query.afterPosition ?? 0;
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const events: StoredEvent[] = [];
  let position = afterPosition;
  let scanned = 0;
  let hasMore = false;

  for (const event of iterateAllEvents(journal, afterPosition)) {
    scanned += 1;
    position = event.globalPosition;
    if (
      (query.streamPrefix === undefined || event.streamId.startsWith(query.streamPrefix)) &&
      (query.typePrefix === undefined || event.type.startsWith(query.typePrefix))
    ) {
      events.push(event);
      if (events.length >= limit) { hasMore = true; break; }
    }
    if (scanned >= SCAN_WINDOW) { hasMore = true; break; }
  }

  return Object.freeze({ events: Object.freeze(events), nextPosition: position, hasMore });
}
