import { describe, expect, it } from "vitest";

import { classifyArtifactRetention, classifyLiveGate } from "./live-gate.js";

describe("installed live gate", () => {
  it.each([
    [undefined, "skip"],
    ["", "skip"],
    ["0", "skip"],
    ["1", "run"],
    ["true", "invalid"],
    ["2", "invalid"],
    [" 1", "invalid"],
  ] as const)("classifies %s as %s", (value, expected) => {
    expect(classifyLiveGate(value)).toBe(expected);
  });

  it.each([
    [undefined, "skip", "cleanup"],
    ["", "run", "cleanup"],
    ["0", "run", "cleanup"],
    ["1", "run", "keep"],
    ["1", "skip", "invalid"],
    ["true", "run", "invalid"],
  ] as const)("classifies artifact retention %s with %s gate as %s", (value, gate, expected) => {
    expect(classifyArtifactRetention(value, gate)).toBe(expected);
  });
});
