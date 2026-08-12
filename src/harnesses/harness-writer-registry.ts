import type { HarnessId } from "./harness-id.js";
import type { HarnessWriter } from "./harness-writer.js";

export class UnregisteredHarnessWriterError extends Error {
  constructor(readonly harness: HarnessId) {
    super(`no writer is registered for harness "${harness}"`);
  }
}

export class HarnessWriterRegistry {
  private readonly writers: ReadonlyMap<HarnessId, HarnessWriter>;

  constructor(writers: Partial<Record<HarnessId, HarnessWriter>>) {
    this.writers = new Map(Object.entries(writers) as [HarnessId, HarnessWriter][]);
  }

  get(harness: HarnessId): HarnessWriter {
    const writer = this.writers.get(harness);
    if (writer === undefined) throw new UnregisteredHarnessWriterError(harness);
    return writer;
  }
}
