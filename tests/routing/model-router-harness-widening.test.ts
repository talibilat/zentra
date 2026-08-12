import { describe, expect, it } from "vitest";

import { routeApprovedModel } from "../../src/routing/model-router.js";
import type { ModelSheet } from "../../src/policy/model-sheet.js";

function sheetWith(harness: "opencode" | "claude_code" | "codex"): ModelSheet {
  return {
    models: [{
      id: `${harness}-implementer`,
      harness,
      model: "some/transport-model",
      roles: ["implementer"],
      specialties: ["coding"],
      costTier: "low",
      contextTokens: 128_000,
      maxConcurrency: 1,
      toolPermissions: ["read_repository", "write_worktree"],
      network: "denied",
      fallbackOrder: [],
      qualityHistory: { successes: 1, attempts: 1 },
    }],
  };
}

describe("model router harness widening", () => {
  it("routes to a claude_code candidate when requested", () => {
    const selection = routeApprovedModel(sheetWith("claude_code"), [], {
      executionId: "exec-1",
      taskId: "task-1",
      taskType: "implement",
      role: "implementer",
      harness: "claude_code",
      requiredTools: ["read_repository", "write_worktree"],
      network: "denied",
      requiredContextTokens: 1_000,
    });
    expect(selection.capability.harness).toBe("claude_code");
  });

  it("routes to a codex candidate when requested", () => {
    const selection = routeApprovedModel(sheetWith("codex"), [], {
      executionId: "exec-2",
      taskId: "task-2",
      taskType: "implement",
      role: "implementer",
      harness: "codex",
      requiredTools: ["read_repository", "write_worktree"],
      network: "denied",
      requiredContextTokens: 1_000,
    });
    expect(selection.capability.harness).toBe("codex");
  });
});
