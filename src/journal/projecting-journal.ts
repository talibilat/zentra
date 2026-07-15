import type { NewEvent, StoredEvent } from "../contracts/event.js";
import type { StreamId } from "../contracts/ids.js";
import type { EventJournal } from "./journal.js";

export interface StoredEventSink {
  append(events: readonly StoredEvent[]): void;
}

export class ProjectingEventJournal implements EventJournal {
  private failure: unknown = null;

  constructor(
    private readonly inner: EventJournal,
    private readonly sink: StoredEventSink,
  ) {}

  append(
    streamId: StreamId,
    expectedVersion: number,
    events: readonly NewEvent<string, unknown>[],
  ): readonly StoredEvent[] {
    const stored = this.inner.append(streamId, expectedVersion, events);
    if (this.failure === null) {
      try {
        this.sink.append(stored);
      } catch (error) {
        this.failure = error;
      }
    }
    return stored;
  }

  get projectionFailed(): boolean {
    return this.failure !== null;
  }

  readStream(streamId: StreamId, afterVersion = 0): readonly StoredEvent[] {
    return this.inner.readStream(streamId, afterVersion);
  }

  readAll(afterPosition = 0): readonly StoredEvent[] {
    return this.inner.readAll(afterPosition);
  }
}
