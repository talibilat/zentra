import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import type { StoredEvent } from "../../src/contracts/event.js";
import { projectMilestone } from "../../src/milestones/milestone-projection.js";
import { storedEventToAgentTailEvent } from "../../src/observability/agent-tail.js";
import { createAuthorityAttention, createOpenCodeAdmissionPacket } from "../../src/contracts/authority-attention.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";

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

function terminalPayload(
  outcome: "completed" | "cancelled" | "failed",
  milestonePlan: typeof plan | null,
) {
  return {
    schemaVersion: 1,
    outcome,
    result: {
      schemaVersion: 1,
      milestoneId: "milestone-1",
      projectId: "zentra",
      outcome,
      tasks: (milestonePlan?.tasks ?? []).map((task) => ({
        taskId: task.taskId,
        role: task.roleAssignment.role,
        status: outcome === "completed" ? "completed" : "planned",
        outcome: outcome === "completed" ? "completed" : null,
        evidence: [],
      })),
      integratedCommits: [], validations: [], reviews: [],
      trace: { traceId: "run-1", path: null, outcome: "not_observed" },
      pauses: [], uncertainties: [], decisions: [],
    },
  };
}

const security: SecuritySheet = {
  allowedRepositories: ["/tmp/repository"], allowedFileScopes: ["src/**", "tests/**"], forbiddenPaths: [".env"],
  network: { default: "denied", allowedDestinations: [] }, secretHandling: ["Do not expose secrets."],
  approvalRequiredOperations: [], releaseBoundary: "local_preparation_only", stopAndAskConditions: ["plan_not_ready"],
};

function pausedPayload(taskId: string) {
  const packet = createOpenCodeAdmissionPacket({
    plan: plan as never, milestoneId: "milestone-1", taskId, security, canonicalRepository: "/tmp/repository",
    actorId: taskId === "task-a" ? "agent-a" : "agent-b",
    harness: "opencode",
    role: taskId === "task-a" ? "implementer" : "verifier",
    capabilityId: taskId === "task-a" ? "agent-a" : "agent-b",
    transportModelId: "fixture/model",
    authority: taskId === "task-a" ? "workspace_write" : "read_only",
    roles: [taskId === "task-a" ? "implementer" : "verifier"],
    toolPermissions: ["read_repository"], network: "denied", contextTokens: 10_000,
    requestedBudget: { maxSeconds: 300, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000, timeoutMs: 300_000 },
  });
  return {
    attention: createAuthorityAttention({
      packet,
      reason: "plan_not_ready",
      classification: "hard_stop",
      configuredStopCondition: true,
    }),
  };
}

function readyPayload(taskId: string) {
  return { taskId, admissionDigest: "a".repeat(64) };
}

describe("projectMilestone", () => {
  it("rejects duplicate resource intents and trace observations before task completion", () => {
    const intent = { taskId: "task-a", capsuleId: "capsule-a", resourceLabel: "org.zentra.capsule-id=capsule-a", containerName: "container-a", imageName: "image-a", repositoryViewPath: "/tmp/view-a" };
    const prefix = [
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Resources" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: readyPayload("task-a"), streamVersion: 3 }),
      event({ type: "milestone.agent_resource_intent", payload: intent, streamVersion: 4 }),
    ];
    expect(() => projectMilestone([
      ...prefix,
      event({ type: "milestone.agent_resource_intent", payload: intent, streamVersion: 5 }),
    ])).toThrow("duplicate OpenCode resource intent");
    expect(() => projectMilestone([
      ...prefix,
      event({ type: "milestone.agent_trace_observed", payload: { taskId: "task-a", outcome: "emitted" }, streamVersion: 5 }),
    ])).toThrow("requires task completion");
    expect(() => projectMilestone([
      ...prefix,
      event({ type: "milestone.agent_cleanup_observed", payload: {
        ...intent, taskId: "task-b", containerId: null, imageId: null, repositoryRevision: null,
        outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: true,
      }, streamVersion: 5 }),
    ])).toThrow("out of order");
  });

  it("rejects OpenCode completion evidence that contradicts the running repository revision", () => {
    const openCodePlan = {
      ...plan,
      tasks: [{
        ...plan.tasks[0]!,
        roleAssignment: { role: "planner", agentId: "agent-a", harness: "opencode" },
        risk: { ...plan.tasks[0]!.risk, authority: "read_only" },
      }],
    };
    const summary = "Evidence.";
    const running = {
      taskId: "task-a", capsuleId: "capsule-a", actorId: "agent-a", role: "planner", harness: "opencode",
      requestedModel: { capabilityId: "agent-a", transportModelId: "provider/model" },
      budget: { maxSeconds: 300, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000 },
      timeoutMs: 1_000,
      securityBoundary: {
        repository: "sanitized_read_only_bind_mount", scratch: "bounded_ephemeral", network: "model_broker_only",
        home: "ephemeral", credentials: "none", shell: "none", readableScopes: ["src/**"], forbiddenPaths: [".env"], repositoryRevision: "a".repeat(64),
      },
    };
    const completed = {
      taskId: "task-a", capsuleId: "capsule-a", outcome: "completed", actorId: "agent-a", role: "planner", harness: "opencode",
      capabilityId: "agent-a", transportModelId: "provider/model", measuredHarness: { version: "1.18.3", executableSha256: "b".repeat(64) },
      model: { id: "provider/model", provider: "fixture", name: "model" }, cleanup: "completed", brokerTransport: "completed",
      evidence: [{ kind: "plan", summary, sha256: createHash("sha256").update(summary).digest("hex"), provenance: { harness: "opencode", capabilityId: "agent-a", transportModelId: "provider/model", repositoryRevision: "c".repeat(64) } }],
    };
    const intent = { taskId: "task-a", capsuleId: "capsule-a", resourceLabel: "org.zentra.capsule-id=capsule-a", containerName: "container-a", imageName: "image-a", repositoryViewPath: "/tmp/view-a" };
    const prepared = { ...intent, containerId: "d".repeat(64), imageId: `sha256:${"e".repeat(64)}`, repositoryRevision: "a".repeat(64) };
    const cleanup = { ...prepared, outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: true };
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "OpenCode" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan: openCodePlan }, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: readyPayload("task-a"), streamVersion: 3 }),
      event({ type: "milestone.agent_resource_intent", payload: intent, streamVersion: 4 }),
      event({ type: "milestone.task_running", payload: running, streamVersion: 5 }),
      event({ type: "milestone.agent_resources_prepared", payload: prepared, streamVersion: 6 }),
      event({ type: "milestone.agent_cleanup_observed", payload: cleanup, streamVersion: 7 }),
      event({ type: "milestone.task_completed", payload: completed, streamVersion: 8 }),
    ])).toThrow("contradicts its running identity");
  });

  it("rebuilds milestone status and planned task states from journal events", () => {
    const view = projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Agent Tail milestone" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.paused", payload: pausedPayload("task-a"), streamVersion: 3 }),
    ]);

    expect(view).toMatchObject({
      milestoneId: "milestone-1",
      projectId: "zentra",
      title: "Agent Tail milestone",
      lifecycle: "paused",
      terminalOutcome: null,
      streamVersion: 3,
      tasks: {
        "task-a": { status: "planned", terminalOutcome: null },
        "task-b": { status: "planned", terminalOutcome: null },
      },
    });
  });

  it("replays a canonical milestone terminal outcome", () => {
    const view = projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Terminal milestone" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.failed", payload: terminalPayload("failed", plan), streamVersion: 3 }),
    ]);

    if (view === null) throw new Error("expected milestone view");
    expect(view.lifecycle).toBe("terminal");
    expect(view.terminalOutcome).toBe("failed");
  });

  it("replays legacy non-success and singleton completion payloads with no issue-30 result", () => {
    const failed = projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Legacy failed" }, streamVersion: 1 }),
      event({ type: "milestone.failed", payload: { outcome: "failed", evidence: { stage: "legacy" } }, streamVersion: 2 }),
    ]);
    expect(failed).toMatchObject({ lifecycle: "terminal", terminalOutcome: "failed", result: null });

    const completed = projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Legacy complete" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: readyPayload("task-a"), streamVersion: 3 }),
      event({ type: "milestone.task_running", payload: { taskId: "task-a" }, streamVersion: 4 }),
      event({ type: "milestone.task_completed", payload: { taskId: "task-a", outcome: "completed" }, streamVersion: 5 }),
      event({ type: "milestone.task_ready", payload: readyPayload("task-b"), streamVersion: 6 }),
      event({ type: "milestone.task_running", payload: { taskId: "task-b" }, streamVersion: 7 }),
      event({ type: "milestone.task_completed", payload: { taskId: "task-b", outcome: "completed" }, streamVersion: 8 }),
      event({ type: "milestone.completed", payload: {
        outcome: "completed",
        evidence: {
          taskStreamId: "legacy-task", integrationEventId: "integration", integrationStreamVersion: 1,
          integrationPayloadDigest: "a".repeat(64), completionEventId: "completion", completionStreamVersion: 2,
          completionPayloadDigest: "b".repeat(64), resultCommit: "c".repeat(40),
        },
      }, streamVersion: 9 }),
    ]);
    expect(completed).toMatchObject({ lifecycle: "terminal", terminalOutcome: "completed", result: null });
  });

  it("fails closed on malformed or contradictory milestone histories", () => {
    expect(() => projectMilestone([event({ type: "milestone.task_ready", payload: { taskId: "task-a" } })]))
      .toThrow("first event must be milestone.created");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: readyPayload("unknown"), streamVersion: 3 }),
    ])).toThrow("unknown planned task");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.failed", payload: terminalPayload("failed", null), streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: readyPayload("task-a"), streamVersion: 3 }),
    ])).toThrow("milestone is already terminal");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: readyPayload("task-a"), streamVersion: 3 }),
      event({ type: "milestone.task_running", payload: { taskId: "task-a" }, streamVersion: 4 }),
      event({ type: "milestone.task_ready", payload: readyPayload("task-a"), streamVersion: 5 }),
    ])).toThrow("cannot become ready from running");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: readyPayload("task-b"), streamVersion: 3 }),
    ])).toThrow("dependency task-a is not completed");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.task_ready", payload: readyPayload("task-a"), streamVersion: 3 }),
      event({ type: "milestone.task_running", payload: { taskId: "task-a" }, streamVersion: 4 }),
      event({ type: "milestone.task_completed", payload: { taskId: "task-a", outcome: "failed" }, streamVersion: 5 }),
      event({ type: "milestone.task_ready", payload: readyPayload("task-b"), streamVersion: 6 }),
    ])).toThrow("dependency task-a is not completed successfully");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.completed", payload: terminalPayload("completed", plan), streamVersion: 3 }),
    ])).toThrow("milestone terminal result task outcome contradicts same-stream state");
    expect(() => projectMilestone([
      event({ streamId: "", type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
    ])).toThrow("milestone.created streamId must be a nonempty string");
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Bad" }, streamVersion: 1 }),
      event({ type: "milestone.paused", payload: pausedPayload("task-a"), streamVersion: 2 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 3 }),
    ])).toThrow("milestone authority attention binding is invalid");
  });

  it("clears stop-and-ask when a paused milestone reaches a terminal outcome", () => {
    const view = projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Paused" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.paused", payload: pausedPayload("task-a"), streamVersion: 3 }),
      event({ type: "milestone.cancelled", payload: terminalPayload("cancelled", plan), streamVersion: 4 }),
    ]);

    if (view === null) throw new Error("expected milestone view");
    expect(view.lifecycle).toBe("terminal");
    expect(view.terminalOutcome).toBe("cancelled");
    expect(view.stopAndAsk).toBeNull();
  });

  it.each([
    ["milestone.task_ready", { taskId: "task-a" }],
    ["milestone.task_blocked", { taskId: "task-a", reason: "blocked" }],
    ["milestone.agent_resource_intent", { taskId: "task-a" }],
    ["milestone.agent_resources_prepared", { taskId: "task-a" }],
    ["milestone.task_running", { taskId: "task-a" }],
    ["milestone.task_completed", { taskId: "task-a", outcome: "completed" }],
    ["milestone.agent_trace_observed", { taskId: "task-a", outcome: "emitted" }],
    ["milestone.agent_cleanup_observed", { taskId: "task-a" }],
    ["milestone.completed", {}],
    ["milestone.failed", {}],
  ])("rejects post-pause execution or effect event %s", (type, payload) => {
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Paused" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      event({ type: "milestone.paused", payload: pausedPayload("task-a"), streamVersion: 3 }),
      event({ type, payload, streamVersion: 4 }),
    ])).toThrow("milestone is paused pending plan replacement");
  });

  it.each([
    ["resource intent", [
      event({ type: "milestone.task_ready", payload: readyPayload("task-a"), streamVersion: 3 }),
      event({ type: "milestone.agent_resource_intent", payload: { taskId: "task-a", capsuleId: "capsule-a", resourceLabel: "org.zentra.capsule-id=capsule-a", containerName: "container-a", imageName: "image-a", repositoryViewPath: "/tmp/view-a" }, streamVersion: 4 }),
    ]],
    ["running execution", [
      event({ type: "milestone.task_ready", payload: readyPayload("task-a"), streamVersion: 3 }),
      event({ type: "milestone.task_running", payload: { taskId: "task-a" }, streamVersion: 4 }),
    ]],
    ["prepared resources", [
      event({ type: "milestone.task_ready", payload: readyPayload("task-a"), streamVersion: 3 }),
      event({ type: "milestone.agent_resource_intent", payload: { taskId: "task-a", capsuleId: "capsule-a", resourceLabel: "org.zentra.capsule-id=capsule-a", containerName: "container-a", imageName: "image-a", repositoryViewPath: "/tmp/view-a" }, streamVersion: 4 }),
      event({ type: "milestone.agent_resources_prepared", payload: { taskId: "task-a", capsuleId: "capsule-a", resourceLabel: "org.zentra.capsule-id=capsule-a", containerName: "container-a", containerId: "b".repeat(64), imageName: "image-a", imageId: `sha256:${"c".repeat(64)}`, repositoryViewPath: "/tmp/view-a", repositoryRevision: "d".repeat(64) }, streamVersion: 5 }),
    ]],
  ] as const)("rejects a pause after any task has %s", (_name, progress) => {
    expect(() => projectMilestone([
      event({ type: "milestone.created", payload: { projectId: "zentra", title: "Progress" }, streamVersion: 1 }),
      event({ type: "milestone.plan_created", payload: { plan }, streamVersion: 2 }),
      ...progress,
      event({ type: "milestone.paused", payload: pausedPayload("task-b"), streamVersion: progress.length + 3 }),
    ])).toThrow("authority pause must precede active or uncertain milestone effects");
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
    expect(exported.span_id).toBe("milestone:milestone-1:task:task-a");
    expect(exported.parent_span_id).toBe("milestone:milestone-1");
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
