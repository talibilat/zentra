import { describe, expect, it } from "vitest";

import {
  MilestoneSchema,
  MilestonePlanSchema,
  assertAcyclicMilestonePlan,
} from "../../src/contracts/milestone.js";

const baseTask = {
  taskId: "task-research",
  title: "Research the existing flow",
  description: "Inspect the current implementation and report constraints.",
  dependencies: [],
  ownedPaths: ["src/contracts"],
  forbiddenPaths: [".env"],
  acceptanceCriteria: ["The relevant contracts are documented."],
  roleAssignment: {
    role: "researcher",
    agentId: "opencode-researcher",
    harness: "opencode",
  },
  risk: {
    level: "low",
    authority: "read_only",
    requiresReview: false,
    requiresApproval: false,
  },
  budget: {
    maxSeconds: 600,
    maxRetries: 0,
    maxCostUsd: 1,
    maxInputTokens: 20_000,
    maxOutputTokens: 4_000,
  },
};

describe("Milestone contracts", () => {
  it("accepts a complete milestone plan with explicit ownership, risk, and budget", () => {
    const plan = MilestonePlanSchema.parse({
      milestoneId: "milestone-agent-tail",
      projectId: "zentra",
      goal: "Produce an Agent Tail trace from a run.",
      tasks: [
        baseTask,
        {
          ...baseTask,
          taskId: "task-export",
          title: "Export trace",
          dependencies: ["task-research"],
          ownedPaths: ["src/orchestration"],
          roleAssignment: {
            role: "implementer",
            agentId: "opencode-writer",
            harness: "opencode",
          },
          risk: {
            level: "medium",
            authority: "workspace_write",
            requiresReview: true,
            requiresApproval: false,
          },
        },
      ],
    });

    expect(plan.tasks).toHaveLength(2);
    expect(assertAcyclicMilestonePlan(plan)).toBe(plan);
  });

  it("rejects cyclic task dependencies", () => {
    const result = MilestonePlanSchema.safeParse({
      milestoneId: "milestone-cycle",
      projectId: "zentra",
      goal: "Reject cyclic plans.",
      tasks: [
        { ...baseTask, taskId: "task-a", dependencies: ["task-b"] },
        { ...baseTask, taskId: "task-b", dependencies: ["task-a"] },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a dependency on an unknown planned task", () => {
    const result = MilestonePlanSchema.safeParse({
      milestoneId: "milestone-missing-dependency",
      projectId: "zentra",
      goal: "Reject missing dependencies.",
      tasks: [{ ...baseTask, dependencies: ["task-missing"] }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects plans without explicit owned paths", () => {
    const result = MilestonePlanSchema.safeParse({
      milestoneId: "milestone-no-ownership",
      projectId: "zentra",
      goal: "Reject missing ownership.",
      tasks: [{ ...baseTask, ownedPaths: [] }],
    });

    expect(result.success).toBe(false);
  });

  it.each(["../outside", "/absolute/path"])("rejects unsafe ownership path %j", (ownedPath) => {
    const result = MilestonePlanSchema.safeParse({
      milestoneId: "milestone-unsafe-ownership",
      projectId: "zentra",
      goal: "Reject unsafe ownership.",
      tasks: [{ ...baseTask, ownedPaths: [ownedPath] }],
    });

    expect(result.success).toBe(false);
  });

  it("requires risk and budget before a plan is executable", () => {
    const { risk: _risk, budget: _budget, ...taskWithoutRiskAndBudget } = baseTask;
    const result = MilestonePlanSchema.safeParse({
      milestoneId: "milestone-missing-risk-budget",
      projectId: "zentra",
      goal: "Reject incomplete plans.",
      tasks: [taskWithoutRiskAndBudget],
    });

    expect(result.success).toBe(false);
  });

  it("rejects ready or running milestones without a plan", () => {
    for (const lifecycle of ["ready", "running"] as const) {
      const result = MilestoneSchema.safeParse({
        milestoneId: `milestone-${lifecycle}-without-plan`,
        projectId: "zentra",
        title: "Invalid executable milestone",
        lifecycle,
        terminalOutcome: null,
        plan: null,
        stopAndAsk: null,
      });

      expect(result.success).toBe(false);
    }
  });

  it("rejects a milestone whose embedded plan targets another identity", () => {
    const result = MilestoneSchema.safeParse({
      milestoneId: "milestone-a",
      projectId: "zentra",
      title: "Invalid embedded plan",
      lifecycle: "ready",
      terminalOutcome: null,
      plan: {
        milestoneId: "milestone-b",
        projectId: "other-project",
        goal: "Do the wrong work.",
        tasks: [baseTask],
      },
      stopAndAsk: null,
    });

    expect(result.success).toBe(false);
  });

  it("rejects contradictory owned and forbidden paths", () => {
    const exact = MilestonePlanSchema.safeParse({
      milestoneId: "milestone-exact-forbidden",
      projectId: "zentra",
      goal: "Reject exact overlap.",
      tasks: [{ ...baseTask, ownedPaths: ["src"], forbiddenPaths: ["src"] }],
    });
    const nested = MilestonePlanSchema.safeParse({
      milestoneId: "milestone-nested-forbidden",
      projectId: "zentra",
      goal: "Reject nested overlap.",
      tasks: [{ ...baseTask, ownedPaths: ["src"], forbiddenPaths: ["src/secrets"] }],
    });

    expect(exact.success).toBe(false);
    expect(nested.success).toBe(false);
  });

  it("requires approval for planned external effects", () => {
    const result = MilestonePlanSchema.safeParse({
      milestoneId: "milestone-external-effect",
      projectId: "zentra",
      goal: "Reject unapproved external effects.",
      tasks: [{
        ...baseTask,
        risk: {
          level: "high",
          authority: "external_effect",
          requiresReview: false,
          requiresApproval: false,
        },
      }],
    });

    expect(result.success).toBe(false);
  });

  it("aligns milestone terminal state with canonical task terminal outcomes", () => {
    expect(MilestoneSchema.parse({
      milestoneId: "milestone-completed",
      projectId: "zentra",
      title: "Complete milestone",
      lifecycle: "terminal",
      terminalOutcome: "completed",
      plan: null,
      stopAndAsk: null,
    }).terminalOutcome).toBe("completed");

    expect(MilestoneSchema.safeParse({
      milestoneId: "milestone-invalid-terminal",
      projectId: "zentra",
      title: "Invalid milestone",
      lifecycle: "terminal",
      terminalOutcome: "approval_required",
      plan: null,
      stopAndAsk: null,
    }).success).toBe(false);
  });

  it("requires terminal lifecycle and terminal outcome to be set together", () => {
    const terminalWithoutOutcome = MilestoneSchema.safeParse({
      milestoneId: "milestone-terminal-without-outcome",
      projectId: "zentra",
      title: "Invalid milestone",
      lifecycle: "terminal",
      terminalOutcome: null,
      plan: null,
      stopAndAsk: null,
    });
    const outcomeWithoutTerminal = MilestoneSchema.safeParse({
      milestoneId: "milestone-outcome-without-terminal",
      projectId: "zentra",
      title: "Invalid milestone",
      lifecycle: "running",
      terminalOutcome: "completed",
      plan: null,
      stopAndAsk: null,
    });

    expect(terminalWithoutOutcome.success).toBe(false);
    expect(outcomeWithoutTerminal.success).toBe(false);
  });

  it("represents stop-and-ask state without making it a terminal outcome", () => {
    const milestone = MilestoneSchema.parse({
      milestoneId: "milestone-paused",
      projectId: "zentra",
      title: "Paused milestone",
      lifecycle: "paused",
      terminalOutcome: null,
      plan: null,
      stopAndAsk: {
        reason: "undeclared_network",
        message: "Network access is not declared by the security sheet.",
        requestedBy: "opencode-researcher",
        requiredDecision: "Allow web research for this milestone.",
      },
    });

    expect(milestone.stopAndAsk?.reason).toBe("undeclared_network");
    expect(milestone.terminalOutcome).toBeNull();
  });
});
