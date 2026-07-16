import { describe, expect, it } from "vitest";

import {
  EffectReconciliationPayloadSchema,
  UncertainEffectPayloadSchema,
  uncertainEffectPayload,
} from "../../src/contracts/uncertain-effect.js";

describe("UncertainEffectPayloadSchema", () => {
  it("builds a bounded nonterminal stop-and-ask classification", () => {
    expect(uncertainEffectPayload({
      boundary: "commit",
      operation: "git commit",
      reason: "commit acknowledgement was lost",
      requestedBy: "zentra-integration-controller",
      workspace: { path: "/work/task-1", branch: "ticket/task-1" },
    })).toMatchObject({
      schemaVersion: 1,
      boundary: "commit",
      retryPolicy: "never_automatic",
      recoveryClassification: "await_reconciliation",
      stopAndAsk: { reason: "uncertain_effect" },
      workspace: { preservation: "required" },
    });
  });

  it("rejects alternate retry policies and unknown boundaries", () => {
    const valid = uncertainEffectPayload({
      boundary: "worker",
      operation: "OpenCode writer",
      reason: "writer result was not acknowledged",
      requestedBy: "zentra-worker-controller",
      workspace: null,
    });

    expect(() => UncertainEffectPayloadSchema.parse({
      ...valid,
      retryPolicy: "automatic",
    })).toThrow();
    expect(() => UncertainEffectPayloadSchema.parse({
      ...valid,
      boundary: "unknown",
    })).toThrow();
  });

  it("accepts explicit operator reconciliation evidence", () => {
    expect(EffectReconciliationPayloadSchema.parse({
      schemaVersion: 1,
      boundary: "cleanup",
      resolution: "effect_absent",
      reason: "candidate and ticket worktrees are exactly absent",
      decidedBy: "operator-1",
      decisionId: "decision-1",
    })).toMatchObject({ boundary: "cleanup", resolution: "effect_absent" });
  });
});
