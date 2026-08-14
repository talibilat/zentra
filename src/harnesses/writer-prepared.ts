import type { PreparedWriterRequest } from "./harness-writer.js";

export interface PreparedWriterRegistry {
  mark(prepared: PreparedWriterRequest): void;
  consume(prepared: PreparedWriterRequest): boolean;
}

export function createPreparedWriterRegistry(): PreparedWriterRegistry {
  const prepared = new WeakSet<object>();
  return {
    mark(request: PreparedWriterRequest): void {
      prepared.add(request);
    },
    consume(request: PreparedWriterRequest): boolean {
      if (!prepared.has(request)) return false;
      prepared.delete(request);
      return true;
    },
  };
}
