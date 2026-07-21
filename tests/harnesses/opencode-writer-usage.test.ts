import { describe, expect, it } from "vitest";

import { parseOpenCodeWriterUsage } from "../../src/harnesses/opencode-writer.js";

describe("OpenCode 1.18.3 writer usage", () => {
  it("sums step_finish.part.tokens deterministically and retains cache and reasoning components", () => {
    expect(parseOpenCodeWriterUsage([
      { type: "tool_use", tool: "edit", callID: "tool-1" },
      { type: "step_finish", part: { type: "step-finish", tokens: {
        input: 100, output: 30, reasoning: 5, cache: { read: 20, write: 3 },
      } } },
      { type: "step_finish", part: { type: "step-finish", tokens: {
        input: 10, output: 4, reasoning: 1, cache: { read: 2, write: 0 },
      } } },
    ])).toEqual({
      inputTokens: 110,
      outputTokens: 34,
      reasoningTokens: 6,
      cacheReadTokens: 22,
      cacheWriteTokens: 3,
      toolCalls: 1,
    });
  });

  it.each([
    [{ type: "step_finish", part: { tokens: { input: -1, output: 1 } } }],
    [{ type: "step_finish", part: { tokens: { input: 1.5, output: 1 } } }],
    [{ type: "step_finish", part: { tokens: { input: 1, output: Number.MAX_SAFE_INTEGER } } }],
    [{ type: "step_finish", part: { tokens: { input: 1, output: 1, cache: { read: -1 } } } }],
    [{ type: "step_finish", part: { tokens: { input: 1, output: 1 } }, usage: { input: 1, output: 1 } }],
    [{ type: "step_finish", usage: { input: 1, inputTokens: 1, output: 1 } }],
  ])("rejects malformed, negative, overflow, or ambiguous usage %#", (event) => {
    expect(() => parseOpenCodeWriterUsage([event])).toThrow();
  });

  it("rejects bounded aggregate overflow across otherwise valid turns", () => {
    expect(() => parseOpenCodeWriterUsage([
      { type: "step_finish", part: { tokens: { input: 1_500_000, output: 0 } } },
      { type: "step_finish", part: { tokens: { input: 600_000, output: 0 } } },
    ])).toThrow(/bounded aggregate/i);
  });

  it("rejects mixing native and legacy schemas across separate turns", () => {
    expect(() => parseOpenCodeWriterUsage([
      { type: "step_finish", part: { tokens: { input: 1, output: 1 } } },
      { type: "step_finish", usage: { inputTokens: 1, outputTokens: 1 } },
    ])).toThrow(/mixes alternate/i);
  });
});
