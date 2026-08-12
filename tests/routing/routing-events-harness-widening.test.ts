import { describe, expect, it } from "vitest";

import { RoutingSelectionSchema } from "../../src/routing/routing-events.js";

function selectionWith(harness: string) {
  return {
    schemaVersion: 1 as const,
    executionId: "exec-1",
    taskId: "task-1",
    taskType: "implement",
    role: "implementer" as const,
    model: {
      capabilityId: "cap-1",
      harness,
      transportModelSha256: "a".repeat(64),
    },
    candidateCapabilityIds: ["cap-1"],
    modelSheetSha256: "b".repeat(64),
    algorithmVersion: "approved-history-v1" as const,
    basis: "sheet_order" as const,
  };
}

describe("routing selection harness widening", () => {
  it("accepts claude_code and codex as valid harnesses", () => {
    expect(() => RoutingSelectionSchema.parse(selectionWith("claude_code"))).not.toThrow();
    expect(() => RoutingSelectionSchema.parse(selectionWith("codex"))).not.toThrow();
  });

  it("still rejects an unrecognized harness", () => {
    expect(() => RoutingSelectionSchema.parse(selectionWith("bogus"))).toThrow();
  });
});
