import { describe, expect, it } from "vitest";

import { EXECUTABLE_HARNESSES, HARNESS_IDS, isHarnessId } from "../../src/harnesses/harness-id.js";

describe("harness id", () => {
  it("lists exactly the three executable harnesses", () => {
    expect(HARNESS_IDS).toEqual(["opencode", "claude_code", "codex"]);
    expect(EXECUTABLE_HARNESSES.size).toBe(3);
  });

  it("recognizes valid harness ids and rejects unknown or fixture-only ones", () => {
    expect(isHarnessId("opencode")).toBe(true);
    expect(isHarnessId("claude_code")).toBe(true);
    expect(isHarnessId("codex")).toBe(true);
    expect(isHarnessId("deterministic")).toBe(false);
    expect(isHarnessId("bogus")).toBe(false);
  });
});
