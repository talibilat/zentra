import { describe, expect, it } from "vitest";

import type { OpenCodeTaskAdmissionContext } from "../../src/contracts/authority-attention.js";
import type { MilestonePlan } from "../../src/contracts/milestone.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";
import { TwoAgentMilestoneCoordinator } from "../../src/orchestration/two-agent-milestone.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";

describe("TwoAgentMilestoneCoordinator", () => {
  it("admits a reviewer only after the implementer handoff and completes after verified integration", async () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new MilestoneRegistry(journal);
      const plan = twoAgentPlan();
      const security = securitySheet();
      const modelSheet = {
        models: [
          model("writer-1", "implementer", ["read_repository", "write_worktree"]),
          model("reviewer-1", "reviewer", ["read_repository", "review_diff"]),
        ],
      };
      registry.register({
        milestoneId: plan.milestoneId,
        projectId: plan.projectId,
        title: "Two-agent change",
        correlationId: "trace-two-agent",
        plan,
        authority: { security, modelSheet },
      });
      const calls: string[] = [];
      const coordinator = new TwoAgentMilestoneCoordinator(registry, {
        run: async (request) => {
          calls.push("writer");
          expect(registry.inspect(plan.milestoneId)?.tasks["review"]?.status).toBe("planned");
          await request.onReviewReady!({
            taskStreamId: "implement",
            diffSha256: "a".repeat(64),
            validation: {} as never,
          });
          calls.push("reviewer");
          return {
            taskId: "implement",
            projectId: "fixture",
            title: "Implement",
            lifecycle: "terminal",
            terminalOutcome: "completed",
            streamVersion: 12,
            leaseOwner: "writer-1",
            paused: false,
            stopAndAsk: null,
            uncertainEffect: null,
          };
        },
      });

      const run = coordinator.run({
        milestoneId: plan.milestoneId,
        writerTaskId: "implement",
        reviewerTaskId: "review",
        security,
        modelSheet,
        writerAdmission: admission("writer-1", "implementer", "workspace_write", ["read_repository", "write_worktree"]),
        reviewerAdmission: admission("reviewer-1", "reviewer", "review", ["read_repository", "review_diff"]),
        execution: {
          project: {
            projectId: "fixture",
            repositoryPath: process.cwd(),
          },
          task: plan.tasks[0],
          model: modelSheet.models[0],
          security,
          reviewerId: "reviewer-1",
        } as never,
      });

      await expect(run).rejects.toThrow("integrated task stream is not bound to the milestone trace");
      expect(calls).toEqual(["writer", "reviewer"]);
      const result = registry.inspect(plan.milestoneId)!;
      expect(result).toMatchObject({ lifecycle: "running", terminalOutcome: null });
      expect(result.tasks).toMatchObject({
        implement: { status: "completed", terminalOutcome: "completed" },
        review: { status: "completed", terminalOutcome: "completed" },
      });
      expect(journal.readStream(plan.milestoneId).map((event) => event.type)).toEqual(expect.arrayContaining([
        "milestone.task_running",
        "milestone.task_completed",
      ]));
      expect(journal.readStream(plan.milestoneId).map((event) => event.type)).not.toContain("milestone.completed");
    } finally {
      journal.close();
    }
  });
});

function twoAgentPlan(): MilestonePlan {
  const budget = { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 };
  return {
    milestoneId: "two-agent",
    projectId: "fixture",
    goal: "Implement and independently review one file.",
    tasks: [{
      taskId: "implement",
      title: "Implement",
      description: "Change the assigned file.",
      dependencies: [],
      ownedPaths: ["src/greeting.mjs"],
      forbiddenPaths: [".env"],
      acceptanceCriteria: ["Focused validation passes."],
      roleAssignment: { role: "implementer", agentId: "writer-1", harness: "opencode" },
      risk: { level: "low", authority: "workspace_write", requiresReview: true, requiresApproval: false },
      budget,
    }, {
      taskId: "review",
      title: "Review",
      description: "Review the validated change independently.",
      dependencies: ["implement"],
      ownedPaths: ["src/greeting.mjs"],
      forbiddenPaths: [".env"],
      acceptanceCriteria: ["The exact validated diff is approved."],
      roleAssignment: { role: "reviewer", agentId: "reviewer-1", harness: "opencode" },
      risk: { level: "low", authority: "review", requiresReview: false, requiresApproval: false },
      budget,
    }],
  };
}

function model(id: string, role: "implementer" | "reviewer", toolPermissions: readonly string[]) {
  return {
    id,
    harness: "opencode",
    model: `fixture/${id}`,
    roles: [role],
    specialties: [role === "implementer" ? "coding" : "review"],
    costTier: "low",
    contextTokens: 10_000,
    maxConcurrency: 1,
    toolPermissions: [...toolPermissions],
    network: "denied",
    fallbackOrder: [],
    qualityHistory: { successes: 1, attempts: 1 },
  };
}

function securitySheet(): SecuritySheet {
  return {
    allowedRepositories: [process.cwd()],
    allowedFileScopes: ["src/**"],
    forbiddenPaths: [".env"],
    network: { default: "denied", allowedDestinations: [] },
    secretHandling: ["Do not inherit parent secrets."],
    approvalRequiredOperations: [],
    releaseBoundary: "local_preparation_only",
    stopAndAskConditions: ["plan_not_ready"],
  };
}

function admission(
  actorId: string,
  role: "implementer" | "reviewer",
  authority: "workspace_write" | "review",
  toolPermissions: readonly string[],
): OpenCodeTaskAdmissionContext {
  return {
    kind: "opencode",
    repositoryPath: process.cwd(),
    actorId,
    harness: "opencode",
    role,
    capabilityId: actorId,
    transportModelId: `fixture/${actorId}`,
    authority,
    roles: [role],
    toolPermissions: [...toolPermissions],
    network: "denied",
    contextTokens: 10_000,
    requestedBudget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500, timeoutMs: 30_000 },
  };
}
