import type { NewEvent, StoredEvent } from "../contracts/event.js";
import type { StreamId } from "../contracts/ids.js";

export interface EventJournal {
  append(
    streamId: StreamId,
    expectedVersion: number,
    events: readonly NewEvent<string, unknown>[],
  ): readonly StoredEvent[];
  readStream(streamId: StreamId, afterVersion?: number): readonly StoredEvent[];
  readAll(afterPosition?: number): readonly StoredEvent[];
}
