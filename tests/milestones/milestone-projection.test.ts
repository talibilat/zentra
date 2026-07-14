import { describe, expect, it } from "vitest";

import type { StoredEvent } from "../../src/contracts/event.js";
import { projectMilestone } from "../../src/milestones/milestone-projection.js";
import { storedEventToAgentTailEvent } from "../../src/observability/agent-tail.js";

function event(input: Partial<StoredEvent> & { type: string; payload?: unknown }): StoredEvent {
  const version = input.streamVersion ?? 1;
  return {
    eventId: input.eventId ?? `event-${version}`,
    streamId: input.streamId ?? "milestone-1",
    streamVersion: version,
    globalPosition: input.globalPosition ?? version,
    recordedAt: input.recordedAt ?? `2026-07-14T12:00:0${version}.000Z`,
    type: input.type,
    payload: input.payload ?? {},
    causationId: input.causationId ?? null,
    correlationId: input.correlationId ?? "run-1",
  };
}

const plan = {
  milestoneId: "milestone-1",
  projectId: "zentra",
  goal: "Add milestone projection.",
  tasks: [
    {
      taskId: "task-a",
      title: "First task",
      description: "Do the first task.",
      dependencies: [],
      ownedPaths: ["src/milestones"],
      forbiddenPaths: [".env"],
      acceptanceCriteria: ["Projection works."],
      roleAssignment: { role: "implementer", agentId: "agent-a", harness: "opencode" },
      risk: { level: "low", authority: "workspace_write", requiresReview: true, requiresApproval: false },
      budget: { maxSeconds: 300, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000 },
    },
    {
      taskId: "task-b",
      title: "Second task",
      description: "Do the second task.",
      dependencies: ["task-a"],
      ownedPaths: ["tests/milestones"],
      forbiddenPaths: [".env"],
      acceptanceCriteria: ["Tests pass."],
      roleAssignment: { role: "verifier", agentId: "agent-b", harness: "opencode" },
      risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
      budget: { maxSeconds: 300, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000 },
    },
  ],
};

describe("projectMilestone", () => {
  it("rebuilds milestone status and planned task states from journal events", () => {
    const view = projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Agent Tail milestone" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: { taskId: "task-a" }, streamVersion: 3 }),
      event({ type: "milestone.task_running", payload: { taskId: "task-a" }, streamVersion: 4 }),
      event({ type: "milestone.task_completed", payload: { taskId: "task-a", outcome: "completed" }, streamVersion: 5 }),
      event({ type: "milestone.task_ready", payload: { taskId: "task-b" }, streamVersion: 6 }),
      event({ type: "milestone.task_blocked", payload: { taskId: "task-b", reason: "waiting for review" }, streamVersion: 7 }),
      event({ type: "milestone.paused", payload: {
        stopAndAsk: {
          reason: "plan_not_ready",
          message: "Verifier is blocked.",
          requestedBy: "agent-b",
          requiredDecision: "Choose next step.",
        },
      }, streamVersion: 8 }),
    ]);

    expect(view).toMatchObject({
      milestoneId: "milestone-1",
      projectId: "zentra",
      title: "Agent Tail milestone",
      lifecycle: "paused",
      terminalOutcome: null,
      streamVersion: 8,
      tasks: {
        "task-a": { status: "completed", terminalOutcome: "completed" },
        "task-b": { status: "blocked", terminalOutcome: null, blockedReason: "waiting for review" },
      },
    });
  });

  it("replays a canonical milestone terminal outcome", () => {
    const view = projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Terminal milestone" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.failed", payload: { reason: "validation failed" }, streamVersion: 3 }),
    ]);

    if (view === null) throw new Error("expected milestone view");
    expect(view.lifecycle).toBe("terminal");
    expect(view.terminalOutcome).toBe("failed");
  });

  it("fails closed on malformed or contradictory milestone histories", () => {
    expect(() => projectMilestone([event({ type: "milestone.task_ready", payload: { taskId: "task-a" } })]))
      .toThrow("first event must be milestone.created");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: { taskId: "unknown" }, streamVersion: 3 }),
    ])).toThrow("unknown planned task");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.failed", payload: {}, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: { taskId: "task-a" }, streamVersion: 3 }),
    ])).toThrow("milestone is already terminal");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: { taskId: "task-a" }, streamVersion: 3 }),
      event({ type: "milestone.task_running", payload: { taskId: "task-a" }, streamVersion: 4 }),
      event({ type: "milestone.task_ready", payload: { taskId: "task-a" }, streamVersion: 5 }),
    ])).toThrow("cannot become ready from running");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: { taskId: "task-b" }, streamVersion: 3 }),
    ])).toThrow("dependency task-a is not completed");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: { taskId: "task-a" }, streamVersion: 3 }),
      event({ type: "milestone.task_running", payload: { taskId: "task-a" }, streamVersion: 4 }),
      event({ type: "milestone.task_completed", payload: { taskId: "task-a", outcome: "failed" }, streamVersion: 5 }),
      event({ type: "milestone.task_ready", payload: { taskId: "task-b" }, streamVersion: 6 }),
    ])).toThrow("dependency task-a is not completed successfully");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.completed", payload: {}, streamVersion: 3 }),
    ])).toThrow("successful milestone completion requires all planned tasks completed");
    expect(() => projectMilestone([
      event({ streamId: "", type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
    ])).toThrow("milestone.created streamId must be a nonempty string");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.paused", payload: {
        stopAndAsk: {
          reason: "plan_not_ready",
          message: "Need a plan decision.",
          requestedBy: "zentra-planner",
          requiredDecision: "Approve a plan.",
        },
      }, streamVersion: 2 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 3 }),
    ])).toThrow("milestone.plan_created cannot follow a pause");
  });

  it("clears stop-and-ask when a paused milestone reaches a terminal outcome", () => {
    const view = projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Paused" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.paused", payload: {
        stopAndAsk: {
          reason: "plan_not_ready",
          message: "Need a decision.",
          requestedBy: "agent-a",
          requiredDecision: "Cancel or continue.",
        },
      }, streamVersion: 3 }),
      event({ type: "milestone.cancelled", payload: { reason: "operator cancelled" }, streamVersion: 4 }),
    ]);

    if (view === null) throw new Error("expected milestone view");
    expect(view.lifecycle).toBe("terminal");
    expect(view.terminalOutcome).toBe("cancelled");
    expect(view.stopAndAsk).toBeNull();
  });

  it("maps milestone events into one Agent Tail trace", () => {
    const exported = storedEventToAgentTailEvent(event({
      type: "milestone.task_running",
      payload: { taskId: "task-a" },
      correlationId: "run-shared",
      streamVersion: 4,
      globalPosition: 44,
    }));

    expect(exported.trace_id).toBe("run-shared");
    expect(exported.span_id).toBe("milestone:milestone-1");
    expect(exported.sequence).toBe(44);
    expect(exported.actor).toEqual({ id: "zentra-scheduler", role: "scheduler" });
    expect(exported.operation).toEqual({ name: "milestone", status: "running" });
    expect(exported.attributes.zentra.native_type).toBe("milestone.task_running");

    expect(storedEventToAgentTailEvent(event({
      type: "milestone.failed",
      streamVersion: 5,
      globalPosition: 45,
    })).operation.status).toBe("failed");
    expect(storedEventToAgentTailEvent(event({
      type: "milestone.cancelled",
      streamVersion: 6,
      globalPosition: 46,
    })).operation.status).toBe("cancelled");
    expect(storedEventToAgentTailEvent(event({
      type: "milestone.denied",
      streamVersion: 7,
      globalPosition: 47,
    })).operation.status).toBe("denied");
  });
});
