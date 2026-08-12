import { describe, expect, it } from "vitest";

import { HarnessWriterRegistry, UnregisteredHarnessWriterError } from "../../src/harnesses/harness-writer-registry.js";
import type { HarnessWriter } from "../../src/harnesses/harness-writer.js";

function fakeWriter(): HarnessWriter {
  return {
    prepare: async () => ({ binding: {} as never }),
    execute: async () => ({} as never),
  };
}

describe("HarnessWriterRegistry", () => {
  it("resolves a writer registered for a harness", () => {
    const opencode = fakeWriter();
    const registry = new HarnessWriterRegistry({ opencode });
    expect(registry.get("opencode")).toBe(opencode);
  });

  it("throws a typed error for an unregistered harness", () => {
    const registry = new HarnessWriterRegistry({ opencode: fakeWriter() });
    expect(() => registry.get("claude_code")).toThrow(UnregisteredHarnessWriterError);
  });
});
