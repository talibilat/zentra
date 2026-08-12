import { describe, expect, it } from "vitest";

import { HarnessWriterRegistry, UnregisteredHarnessWriterError } from "../../src/harnesses/harness-writer-registry.js";
import type { HarnessWriter } from "../../src/harnesses/harness-writer.js";

function fakeWriter(): HarnessWriter {
  return {
    prepare: async () => ({ binding: {} as never }),
    execute: async () => ({} as never),
  };
}

describe("InstalledMilestoneRunner harness resolution", () => {
  it("only opencode is registered by default, matching today's behavior", () => {
    const registry = new HarnessWriterRegistry({ opencode: fakeWriter() });
    expect(() => registry.get("opencode")).not.toThrow();
    expect(() => registry.get("claude_code")).toThrow(UnregisteredHarnessWriterError);
    expect(() => registry.get("codex")).toThrow(UnregisteredHarnessWriterError);
  });
});
