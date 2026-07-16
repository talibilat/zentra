import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import type { ModelCapability, ModelSheet } from "../../src/policy/model-sheet.js";
import {
  modelSheetSha256,
  routeApprovedModel,
  type OutcomeHistoryRecord,
} from "../../src/routing/model-router.js";

describe("routeApprovedModel", () => {
  it("uses model-sheet order when matching history is absent", () => {
    const sheet = modelSheet([
      model("writer-a", "provider/a", { qualityHistory: { successes: 0, attempts: 10 } }),
      model("writer-b", "provider/b", { qualityHistory: { successes: 10, attempts: 10 } }),
    ]);
    const selection = routeApprovedModel(sheet, [], request());

    expect(selection.capability).toBe(sheet.models[0]);
    expect(selection.basis).toBe("sheet_order");
  });

  it("prefers stronger matching history among current approved options", () => {
    const sheet = modelSheet();
    const history = [
      outcome("writer-a", "provider/a", "failed"),
      outcome("writer-a", "provider/a", "failed"),
      outcome("writer-b", "provider/b", "completed"),
      outcome("writer-b", "provider/b", "completed"),
      outcome("writer-b", "provider/b", "completed"),
    ];

    const selection = routeApprovedModel(sheet, history, request());

    expect(selection.capability).toBe(sheet.models[1]);
    expect(selection.basis).toBe("outcome_history");
  });

  it("never selects history identities outside the current model sheet", () => {
    const sheet = modelSheet();
    const history = [
      outcome("removed-model", "provider/removed", "completed"),
      outcome("writer-b", "provider/old-model", "completed"),
    ];

    expect(routeApprovedModel(sheet, history, request()).capability).toBe(sheet.models[0]);
  });

  it("counts evidence-bound review denials as unsuccessful outcomes", () => {
    const sheet = modelSheet();
    const history = [
      outcome("writer-a", "provider/a", "denied"),
      outcome("writer-a", "provider/a", "denied"),
      outcome("writer-a", "provider/a", "denied"),
      outcome("writer-b", "provider/b", "completed"),
      outcome("writer-b", "provider/b", "completed"),
      outcome("writer-b", "provider/b", "completed"),
    ];

    expect(routeApprovedModel(sheet, history, request()).capability.id).toBe("writer-b");
  });

  it("filters by role, tools, network, and context before ranking", () => {
    const sheet = modelSheet([
      model("wrong-role", "provider/wrong", { roles: ["reviewer"] }),
      model("missing-tool", "provider/tool", { toolPermissions: ["read_repository"] }),
      model("networked", "provider/network", { network: "declared" }),
      model("small", "provider/small", { contextTokens: 100 }),
      model("approved", "provider/approved"),
    ]);

    expect(routeApprovedModel(sheet, [], request()).capability.id).toBe("approved");
  });
});

function request() {
  return {
    executionId: "execution-1",
    taskId: "task-1",
    taskType: "single_file_implementation",
    role: "implementer" as const,
    harness: "opencode" as const,
    requiredTools: ["read_repository", "write_worktree"],
    network: "denied" as const,
    requiredContextTokens: 1_000,
  };
}

function modelSheet(models = [model("writer-a", "provider/a"), model("writer-b", "provider/b")]): ModelSheet {
  return { models };
}

function model(
  id: string,
  transport: string,
  overrides: Partial<ModelCapability> = {},
): ModelCapability {
  return {
    id,
    harness: "opencode",
    model: transport,
    roles: ["implementer"],
    specialties: ["coding"],
    costTier: "low",
    contextTokens: 10_000,
    maxConcurrency: 1,
    toolPermissions: ["read_repository", "write_worktree"],
    network: "denied",
    fallbackOrder: [],
    qualityHistory: { successes: 1, attempts: 1 },
    ...overrides,
  };
}

function outcome(
  capabilityId: string,
  transportModelId: string,
  terminalOutcome: "completed" | "failed" | "denied",
): OutcomeHistoryRecord {
  return {
    schemaVersion: 1,
    executionId: `${capabilityId}-${transportModelId.replace(/[^a-z0-9]/g, "-")}-${terminalOutcome}`,
    taskId: "task-1",
    taskType: "single_file_implementation",
    role: "implementer",
    model: {
      capabilityId,
      harness: "opencode",
      transportModelSha256: createHash("sha256").update(transportModelId).digest("hex"),
    },
    startedAt: "2026-07-16T12:00:00.000Z",
    finishedAt: "2026-07-16T12:00:01.000Z",
    durationMs: 1_000,
    outcome: terminalOutcome,
    validation: {
      status: terminalOutcome === "denied" ? "completed" : terminalOutcome,
      evidenceSha256: "a".repeat(64),
    },
    review: terminalOutcome === "denied"
      ? { status: "denied", evidenceSha256: "d".repeat(64) }
      : { status: "not_required", evidenceSha256: null },
    terminalEvidence: [{ eventId: "event-1", streamId: "task-1", sha256: "b".repeat(64) }],
    selection: { eventId: "selection-1", modelSheetSha256: modelSheetSha256(modelSheet()) },
  };
}
