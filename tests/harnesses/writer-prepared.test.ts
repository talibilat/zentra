import { describe, expect, it } from "vitest";

import { createPreparedWriterRegistry } from "../../src/harnesses/writer-prepared.js";
import type { PreparedWriterRequest } from "../../src/harnesses/harness-writer.js";

function prepared(): PreparedWriterRequest {
  return { binding: {} } as PreparedWriterRequest;
}

describe("prepared writer registry", () => {
  it("consumes a request it marked", () => {
    const registry = createPreparedWriterRegistry();
    const request = prepared();
    registry.mark(request);
    expect(registry.consume(request)).toBe(true);
  });

  it("rejects a request it never marked", () => {
    expect(createPreparedWriterRegistry().consume(prepared())).toBe(false);
  });

  it("rejects a second consume of the same request", () => {
    const registry = createPreparedWriterRegistry();
    const request = prepared();
    registry.mark(request);
    expect(registry.consume(request)).toBe(true);
    expect(registry.consume(request)).toBe(false);
  });

  it("does not recognize a request marked by a different registry", () => {
    const first = createPreparedWriterRegistry();
    const second = createPreparedWriterRegistry();
    const request = prepared();
    first.mark(request);
    expect(second.consume(request)).toBe(false);
    expect(first.consume(request)).toBe(true);
  });
});
