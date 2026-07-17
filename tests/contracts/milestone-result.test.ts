import { describe, expect, it } from "vitest";

import { MilestoneTerminalResultSchema } from "../../src/contracts/milestone-result.js";

const ref = {
  streamId: "task-a",
  eventId: "event-a",
  eventType: "task.completed",
  streamVersion: 2,
  payloadDigest: "a".repeat(64),
};

describe("MilestoneTerminalResultSchema", () => {
  it("accepts a bounded digest-only terminal result", () => {
    const result = MilestoneTerminalResultSchema.parse({
      schemaVersion: 1,
      milestoneId: "milestone-a",
      projectId: "project-a",
      outcome: "failed",
      tasks: [{ taskId: "task-a", role: "planner", status: "completed", outcome: "failed", evidence: [ref] }],
      integratedCommits: [],
      validations: [],
      reviews: [],
      trace: { traceId: "trace-a", path: "/tmp/trace.jsonl", outcome: "emitted" },
      pauses: [],
      uncertainties: [],
      decisions: [],
    });
    expect(result.tasks[0]?.outcome).toBe("failed");
  });

  it.each([
    ["raw stdout", { validations: [{ taskId: "task-a", name: "focused", outcome: "completed", exitCode: 0, argvDigest: "a".repeat(64), outputDigest: "b".repeat(64), subjectDigest: "c".repeat(64), evidence: ref, stdout: "secret" }] }],
    ["raw model summary", { tasks: [{ taskId: "task-a", role: "planner", status: "completed", outcome: "failed", evidence: [ref], summary: "model prose" }] }],
  ] as const)("rejects %s", (_name, replacement) => {
    const candidate = {
      schemaVersion: 1, milestoneId: "milestone-a", projectId: "project-a", outcome: "failed",
      tasks: [{ taskId: "task-a", role: "planner", status: "completed", outcome: "failed", evidence: [ref] }],
      integratedCommits: [], validations: [], reviews: [], trace: { traceId: "trace-a", path: null, outcome: "not_observed" },
      pauses: [], uncertainties: [], decisions: [], ...replacement,
    };
    expect(() => MilestoneTerminalResultSchema.parse(candidate)).toThrow();
  });
});
