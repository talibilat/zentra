import { describe, expect, it } from "vitest";

import { MultiAgentMilestoneCoordinator } from "../../src/orchestration/multi-agent-milestone.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";

describe("MultiAgentMilestoneCoordinator", () => {
  it("runs dependency-ready read-only tasks sequentially in deterministic plan order before writers", async () => {
    const calls: string[] = [];
    const states: Record<string, any> = {
      plan: { status: "planned", terminalOutcome: null },
      researchA: { status: "planned", terminalOutcome: null },
      researchB: { status: "planned", terminalOutcome: null },
      writer: { status: "planned", terminalOutcome: null },
      review: { status: "planned", terminalOutcome: null },
    };
    const plan = {
      tasks: [
        task("plan", "planner", []),
        task("researchA", "researcher", ["plan"]),
        task("researchB", "researcher", ["plan"]),
        task("writer", "implementer", ["researchA", "researchB"]),
        task("review", "reviewer", ["writer"]),
      ],
    };
    const registry = {
      inspect: () => ({
        milestoneId: "m", lifecycle: "running", terminalOutcome: null, plan, tasks: states,
        writerOwnership: {}, hasActiveEffects: false, hasUncertainEffects: false, hasTraceFailure: false,
      }),
      completeFromEvidence: () => ({ milestoneId: "m", lifecycle: "terminal", terminalOutcome: "completed", plan, tasks: states }),
      finishFromEvidence: () => { throw new Error("unexpected failure"); },
    };
    let active = 0;
    let maxActive = 0;
    const readOnly = { run: async (request: any) => {
      calls.push(request.taskId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      states[request.taskId] = { status: "completed", terminalOutcome: "completed" };
      return { status: "executed", operationOutcome: "completed", outcome: "completed" };
    } };
    const scheduler = { run: async () => {
      calls.push("writers");
      states.writer = { status: "completed", terminalOutcome: "completed" };
      states.review = { status: "completed", terminalOutcome: "completed" };
      return registry.inspect();
    } };

    const result = await new MultiAgentMilestoneCoordinator(registry as never, readOnly as never, scheduler as never).run({
      milestoneId: "m",
      readOnlyTasks: ["researchB", "plan", "researchA"].map((taskId) => ({
        taskId,
        request: {
          milestoneId: "m",
          taskId,
          role: taskId === "plan" ? "planner" : "researcher",
        } as never,
      })),
      writerSchedule: {} as never,
    });

    expect(calls[0]).toBe("plan");
    expect(calls.slice(1, 3)).toEqual(["researchA", "researchB"]);
    expect(calls.at(-1)).toBe("writers");
    expect(maxActive).toBe(1);
    expect(result.terminalOutcome).toBe("completed");
  });

  it.each([
    ["running task", false, { status: "running", terminalOutcome: null }],
    ["active resource intent", true, { status: "ready", terminalOutcome: null }],
  ] as const)("does not redispatch a read-only %s after restart", async (_name, hasActiveEffects, taskState) => {
    let executions = 0;
    let writerRuns = 0;
    const milestone = {
      milestoneId: "m", lifecycle: "running", terminalOutcome: null,
      plan: { tasks: [task("plan", "planner", [])] },
      tasks: { plan: taskState }, writerOwnership: {}, hasActiveEffects, hasUncertainEffects: false, hasTraceFailure: false,
    };
    const coordinator = new MultiAgentMilestoneCoordinator(
      { inspect: () => milestone } as never,
      { run: async () => { executions += 1; throw new Error("must not redispatch"); } } as never,
      { run: async () => { writerRuns += 1; return milestone; } } as never,
    );

    const result = await coordinator.run({
      milestoneId: "m",
      readOnlyTasks: [{ taskId: "plan", request: { milestoneId: "m", taskId: "plan", role: "planner" } as never }],
      writerSchedule: {} as never,
    });

    expect(result).toBe(milestone);
    expect(executions).toBe(0);
    expect(writerRuns).toBe(0);
  });

  it("returns durable state after a crash following resource intent and never dispatches the effect twice", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "restart", projectId: "project", title: "Restart", correlationId: "trace-restart",
      plan: readOnlyPlan(),
    });
    let executions = 0;
    const readOnly = { run: async () => {
      executions += 1;
      journal.append("restart", journal.readStream("restart").at(-1)!.streamVersion, [{
        streamId: "restart", type: "milestone.task_ready", payload: { taskId: "plan", admissionDigest: "a".repeat(64) },
        causationId: null, correlationId: "trace-restart",
      }, {
        streamId: "restart", type: "milestone.agent_resource_intent", payload: {
          taskId: "plan", capsuleId: "capsule-plan-1", resourceLabel: "zentra.plan.1",
          containerName: "zentra-plan-1", imageName: "zentra-plan-1:local", repositoryViewPath: "/tmp/zentra-plan-view",
        }, causationId: null, correlationId: "trace-restart",
      }]);
      throw new Error("crash after durable intent");
    } };
    const writers = { run: async () => { throw new Error("writers must remain blocked"); } };
    const coordinator = new MultiAgentMilestoneCoordinator(registry, readOnly as never, writers as never);
    const request = {
      milestoneId: "restart",
      readOnlyTasks: [{ taskId: "plan", request: { milestoneId: "restart", taskId: "plan", role: "planner" } as never }],
      writerSchedule: {} as never,
    };

    const crashed = await coordinator.run(request);
    const restarted = await coordinator.run(request);

    expect(crashed.hasActiveEffects).toBe(true);
    expect(restarted).toEqual(crashed);
    expect(executions).toBe(1);
    expect(journal.readStream("restart").filter((event) => event.type === "milestone.agent_resource_intent")).toHaveLength(1);
    journal.close();
  });
});

function task(taskId: string, role: string, dependencies: string[]) {
  return { taskId, dependencies, roleAssignment: { role } };
}

function readOnlyPlan() {
  return {
    milestoneId: "restart", projectId: "project", goal: "Produce a plan.",
    tasks: [{
      taskId: "plan", title: "Plan", description: "Produce a plan.", dependencies: [], ownedPaths: ["src/**"], forbiddenPaths: [".env"],
      acceptanceCriteria: ["Evidence retained."], roleAssignment: { role: "planner" as const, agentId: "planner", harness: "opencode" as const },
      risk: { level: "low" as const, authority: "read_only" as const, requiresReview: false, requiresApproval: false },
      budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
    }],
  };
}
