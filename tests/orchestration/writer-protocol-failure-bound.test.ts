import { describe, expect, it } from "vitest";

import { boundedProtocolFailure } from "../../src/orchestration/opencode-single-file-tracer-bullet.js";

describe("journaled writer protocol failure bound", () => {
  it("retains null", () => {
    expect(boundedProtocolFailure(null)).toBeNull();
  });

  it("retains the harness-native reason rather than normalizing it", () => {
    expect(boundedProtocolFailure("invalid_native_event_stream")).toBe("invalid_native_event_stream");
    expect(boundedProtocolFailure("invalid_claude_json_result")).toBe("invalid_claude_json_result");
  });

  it("rejects a value outside the retained vocabulary", () => {
    expect(() => boundedProtocolFailure("Invalid Native Event Stream")).toThrow(/retained vocabulary/);
    expect(() => boundedProtocolFailure("")).toThrow(/retained vocabulary/);
    expect(() => boundedProtocolFailure("_leading_underscore")).toThrow(/retained vocabulary/);
    expect(() => boundedProtocolFailure("a".repeat(65))).toThrow(/retained vocabulary/);
  });

  it("accepts a reason at the length limit", () => {
    expect(boundedProtocolFailure("a".repeat(64))).toBe("a".repeat(64));
  });
});
