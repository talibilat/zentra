import { describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import type { MilestonePlan } from "../../src/contracts/milestone.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";

const plan = (milestoneId: string, taskId: string): MilestonePlan => ({
  milestoneId,
  projectId: "zentra",
  goal: `Goal for ${milestoneId}`,
  tasks: [{
    taskId,
    title: "Task",
    description: "Task description.",
    dependencies: [],
    ownedPaths: ["src/**"],
    forbiddenPaths: [".env"],
    acceptanceCriteria: ["Done."],
    roleAssignment: { role: "planner", agentId: "opencode-general", harness: "opencode" },
    risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
    budget: { maxSeconds: 300, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000 },
  }],
});

describe("MilestoneRegistry", () => {
  it("registers, lists, inspects, and resumes multiple milestones independently", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new MilestoneRegistry(journal);
      const first = registry.register({
        milestoneId: "milestone-one",
        projectId: "zentra",
        title: "First milestone",
        correlationId: "run-one",
        tracePath: "/tmp/run-one.jsonl",
        plan: plan("milestone-one", "task-one"),
      });
      const second = registry.register({
        milestoneId: "milestone-two",
        projectId: "zentra",
        title: "Second milestone",
        correlationId: "run-two",
        tracePath: "/tmp/run-two.jsonl",
        plan: plan("milestone-two", "task-two"),
      });

      expect(first.milestoneId).toBe("milestone-one");
      expect(second.milestoneId).toBe("milestone-two");
      expect(registry.list()).toEqual([
        expect.objectContaining({
          milestoneId: "milestone-one",
          traceId: "run-one",
          tracePath: "/tmp/run-one.jsonl",
          lifecycle: "ready",
        }),
        expect.objectContaining({
          milestoneId: "milestone-two",
          traceId: "run-two",
          tracePath: "/tmp/run-two.jsonl",
          lifecycle: "ready",
        }),
      ]);
      expect(registry.inspect("milestone-one")?.title).toBe("First milestone");
      expect(registry.inspect("milestone-one")).toMatchObject({
        traceId: "run-one",
        tracePath: "/tmp/run-one.jsonl",
      });
      expect(registry.inspect("milestone-two")?.title).toBe("Second milestone");
      expect(registry.resume("milestone-one")).toEqual(registry.inspect("milestone-one"));
      expect(registry.inspect("missing")).toBeNull();
    } finally {
      journal.close();
    }
  });

  it("lists status without requiring worker streams", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new MilestoneRegistry(journal);
      registry.register({
        milestoneId: "milestone-plan-only",
        projectId: "zentra",
        title: "Plan only",
        correlationId: "run-plan-only",
        plan: plan("milestone-plan-only", "task-plan-only"),
      });

      expect(registry.list()).toEqual([
        expect.objectContaining({
          milestoneId: "milestone-plan-only",
          taskCount: 1,
          lifecycle: "ready",
          terminalOutcome: null,
        }),
      ]);
    } finally {
      journal.close();
    }
  });

  it("lists milestones through bounded pages after global history exceeds 10,000 events", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new MilestoneRegistry(journal);
      registry.register({
        milestoneId: "milestone-after-history",
        projectId: "zentra",
        title: "After history",
        correlationId: "run-after-history",
      });
      const noise = (offset: number, count: number) => Array.from({ length: count }, (_, index) => ({
        streamId: "noise",
        type: "task.noise",
        payload: { sequence: offset + index + 1 },
        causationId: null,
        correlationId: "noise",
      }));
      journal.append("noise", 0, noise(0, 10_000));
      journal.append("noise", 10_000, noise(10_000, 1));

      expect(() => journal.readAll()).toThrow(/use readAllPage/i);
      expect(registry.list()).toEqual([
        expect.objectContaining({ milestoneId: "milestone-after-history" }),
      ]);
    } finally {
      journal.close();
    }
  });

  it("does not mutate another milestone when inspecting one", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new MilestoneRegistry(journal);
      registry.register({
        milestoneId: "milestone-a",
        projectId: "zentra",
        title: "A",
        correlationId: "run-a",
      });
      registry.register({
        milestoneId: "milestone-b",
        projectId: "zentra",
        title: "B",
        correlationId: "run-b",
      });
      const before = journal.readAll();

      expect(registry.inspect("milestone-a")?.title).toBe("A");

      expect(journal.readAll()).toEqual(before);
      expect(registry.inspect("milestone-b")?.title).toBe("B");
    } finally {
      journal.close();
    }
  });

  it("rejects an invalid plan before mutating the journal", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new MilestoneRegistry(journal);
      expect(() => registry.register({
        milestoneId: "milestone-invalid",
        projectId: "zentra",
        title: "Invalid",
        correlationId: "run-invalid",
        plan: { ...plan("other-milestone", "task-invalid") },
      })).toThrow("milestone plan identity contradicts milestone identity");

      expect(journal.readAll()).toEqual([]);
    } finally {
      journal.close();
    }
  });

  it("durably binds exactly one release operation to the admitted verifier", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new MilestoneRegistry(journal);
      const verifierPlan = plan("release-milestone", "verifier");
      verifierPlan.tasks[0] = {
        ...verifierPlan.tasks[0]!,
        roleAssignment: { role: "verifier", agentId: "local-verifier", harness: "deterministic" },
        risk: { level: "medium", authority: "local_release_preparation", requiresReview: true, requiresApproval: false },
      };
      registry.register({
        milestoneId: "release-milestone", projectId: "zentra", title: "Release",
        correlationId: "release-trace", plan: verifierPlan,
      });
      journal.append("release-milestone", 2, [{
        streamId: "release-milestone", type: "milestone.task_ready",
        payload: { taskId: "verifier", admissionDigest: "a".repeat(64) },
        causationId: null, correlationId: "release-trace",
      }]);
      const binding = {
        schemaVersion: 1 as const, releaseId: "release-one", taskId: "verifier",
        packetDigest: "b".repeat(64), verifierAdmissionDigest: "a".repeat(64),
      };

      expect(registry.bindReleaseOperation("release-milestone", binding).releaseOperation).toEqual(binding);
      expect(registry.bindReleaseOperation("release-milestone", binding).releaseOperation).toEqual(binding);
      const before = journal.readStream("release-milestone");
      expect(() => registry.bindReleaseOperation("release-milestone", {
        ...binding, releaseId: "release-two", packetDigest: "c".repeat(64),
      })).toThrow(/already bound to release-one/);
      expect(journal.readStream("release-milestone")).toEqual(before);
    } finally {
      journal.close();
    }
  });
});
