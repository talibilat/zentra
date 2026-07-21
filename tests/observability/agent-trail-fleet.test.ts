import { describe, expect, it } from "vitest";

import type { StoredEvent } from "../../src/contracts/event.js";
import {
  coalesceAgentTrailHeartbeats,
  projectAgentTrailFleet,
  rankAgentTrailWarnings,
} from "../../src/observability/agent-trail-fleet.js";

function event(position: number, type: string, payload: Record<string, unknown>, overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    streamId: "scheduler:installed",
    type,
    payload,
    causationId: position === 1 ? null : `event-${position - 1}`,
    correlationId: "run-fleet",
    eventId: `event-${position}`,
    streamVersion: position,
    globalPosition: position,
    recordedAt: new Date(Date.UTC(2026, 6, 21, 10, 0, position)).toISOString(),
    ...overrides,
  };
}

const limits = {
  resources: { reasoning: 4, writers: 2, heavyValidation: 1, review: 1, integration: 1 },
  budget: { seconds: 10_000, inputTokens: 20_000, outputTokens: 10_000, costUsdNano: 1_000_000_000 },
};

const task = (taskId: string, projectId: string, workerId: string, integration = false) => ({
  taskId,
  projectId,
  workerId,
  effect: "potentially_effectful",
  requiredCapabilities: [integration ? "integrate" : "write_worktree"],
  platform: "darwin-arm64",
  workspace: { path: `/tmp/worktrees/${taskId}`, available: true },
  admission: {
    dependencies: [], decisionsApproved: true, pathsAvailable: true,
    capabilitySupported: true, platformSupported: true, policyPermits: true,
    budgetAvailable: true, workspaceValid: true, acceptanceCriteria: ["verified"],
    evidenceRequirements: ["receipt"],
  },
  resources: integration
    ? { reasoning: 0, writers: 0, heavyValidation: 0, review: 0, integration: 1 }
    : { reasoning: 1, writers: 1, heavyValidation: 0, review: 0, integration: 0 },
  budget: { seconds: 300, inputTokens: 1_000, outputTokens: 500, costUsdNano: 100_000_000 },
  grantId: `grant-${taskId}`,
});

describe("canonical AgentTrail fleet projection", () => {
  it("distinguishes registered and active workers, stale incarnations, queue pressure, resources, and integration placeholders", () => {
    const events = [
      event(1, "scheduler.daemon_started", { schemaVersion: 1, schedulerId: "installed", processIncarnation: "daemon-old", pid: 111,
        platform: "darwin-arm64", capabilities: ["write_worktree", "integrate"], limits, startedAtMs: 1 }),
      event(2, "scheduler.daemon_started", { schemaVersion: 1, schedulerId: "installed", processIncarnation: "daemon-new", pid: 222,
        platform: "darwin-arm64", capabilities: ["write_worktree", "integrate"], limits, startedAtMs: 2 }),
      event(3, "scheduler.daemon_stale", { schemaVersion: 1, staleProcessIncarnation: "daemon-old", replacementProcessIncarnation: "daemon-new", detectedAtMs: 3 }),
      event(4, "scheduler.task_submitted", { task: task("implement-a", "project-a", "worker-a"), submittedAtMs: 4 }),
      event(5, "scheduler.task_submitted", { task: task("integrate-b", "project-b", "worker-b", true), submittedAtMs: 5 }),
      event(6, "scheduler.task_ready", { taskId: "implement-a" }),
      event(7, "scheduler.backpressure", { taskId: "implement-a", kind: "resources", observedAtMs: 7 }),
      event(8, "scheduler.task_ready", { taskId: "integrate-b" }),
      event(9, "scheduler.dispatch_started", { taskId: "integrate-b", dispatchId: "00000000-0000-4000-8000-000000000009",
        processIncarnation: "daemon-new", workerPid: 333, workerIncarnation: "worker-b-v2",
        workerProcessStartIdentity: "pid-333-start", startedAtMs: 9 }),
      event(10, "scheduler.worker_heartbeat", { taskId: "integrate-b", dispatchId: "00000000-0000-4000-8000-000000000009",
        processIncarnation: "daemon-new", workerIncarnation: "worker-b-v2", observedAtMs: 10 }),
    ];

    const fleet = projectAgentTrailFleet(events, { nowMs: 130_010, projectionPosition: 10, journalHighWaterPosition: 14 });

    expect(fleet.workers).toMatchObject({ registered: 2, active: 1 });
    expect(fleet.workers.items.find((worker) => worker.workerId === "worker-b")).toMatchObject({
      processIncarnation: "worker-b-v2", health: "stale", active: true,
    });
    expect(fleet.processIncarnations).toEqual([
      expect.objectContaining({ id: "daemon-new", state: "active" }),
      expect.objectContaining({ id: "daemon-old", state: "stale" }),
    ]);
    expect(fleet.queue).toMatchObject({ queued: 1, active: 1, backpressured: 1 });
    expect(fleet.queue.projects.map((project) => project.projectId)).toEqual(["project-a", "project-b"]);
    expect(fleet.resources).toMatchObject({ capacity: limits.resources, used: { integration: 0 } });
    expect(fleet.integrationUnits).toEqual([
      expect.objectContaining({ taskId: "integrate-b", state: "active", placeholder: true }),
    ]);
    expect(fleet.observability).toMatchObject({ state: "degraded", projectionLag: 4 });
  });

  it("coalesces heartbeat rows by worker and minute without removing meaningful events", () => {
    const events = [
      event(1, "scheduler.worker_heartbeat", { taskId: "task-1", workerIncarnation: "worker-v1", observedAtMs: 1_000 }),
      event(2, "scheduler.worker_heartbeat", { taskId: "task-1", workerIncarnation: "worker-v1", observedAtMs: 50_000 }),
      event(3, "scheduler.backpressure", { taskId: "task-1", kind: "resources", observedAtMs: 51_000 }),
      event(4, "scheduler.worker_heartbeat", { taskId: "task-1", workerIncarnation: "worker-v1", observedAtMs: 61_000 }),
    ];

    const visual = coalesceAgentTrailHeartbeats(events);

    expect(visual.map((item) => item.event.type)).toEqual([
      "scheduler.worker_heartbeat", "scheduler.backpressure", "scheduler.worker_heartbeat",
    ]);
    expect(visual[0]).toMatchObject({ coalescedCount: 2 });
    expect(events).toHaveLength(4);
  });

  it("projects bounded lease heartbeat health as observation without authority", () => {
    const events = [
      event(1, "lease.granted", { schemaVersion: 1, leaseId: "lease-1", taskId: "task-1",
        workerId: "worker-1", schedulerId: "installed", processIncarnation: "daemon-1", scope: "worker",
        grantedAtMs: 1, expiresAtMs: 180_001 }, { streamId: "lease:lease-1" }),
      event(2, "lease.heartbeat", { schemaVersion: 1, leaseId: "lease-1", processIncarnation: "daemon-1",
        workerIncarnation: "worker-v1", observedAtMs: 60_001, expiresAtMs: 180_001 },
      { streamId: "lease:lease-1" }),
    ];
    expect(projectAgentTrailFleet(events, { nowMs: 200_000 }).leases).toEqual([
      expect.objectContaining({ leaseId: "lease-1", state: "expired", lastHeartbeatAtMs: 60_001, authority: false }),
    ]);
  });

  it("ranks warnings as advisory evidence and preserves hostile text as inert data", () => {
    const warning = `<img src=x onerror="globalThis.compromised=true">`;
    expect(rankAgentTrailWarnings([
      { code: "STALE_HEARTBEAT", summary: warning, eventId: "event-10", actorId: "worker-b", evidenceEventIds: ["event-9", "event-10"] },
      { code: "BUDGET_PRESSURE", summary: "Budget at 90%", eventId: "event-8", actorId: "pod-a", evidenceEventIds: ["event-8"] },
    ])).toEqual([
      expect.objectContaining({ code: "STALE_HEARTBEAT", rank: 1, classification: "advisory", authority: "none", summary: warning }),
      expect.objectContaining({ code: "BUDGET_PRESSURE", rank: 2, classification: "advisory", authority: "none" }),
    ]);
  });

  it("uses exact acquired intervals, unique workers, and clears backpressure on dispatch and release", () => {
    const workerTask = task("task-a", "project-a", "worker-shared");
    const secondTask = task("task-b", "project-a", "worker-shared");
    const events = [
      event(1, "scheduler.daemon_started", { schemaVersion: 1, schedulerId: "installed", processIncarnation: "daemon-1",
        pid: 1, platform: "darwin-arm64", capabilities: ["write_worktree"], limits, startedAtMs: 1 }),
      event(2, "scheduler.task_submitted", { task: workerTask, submittedAtMs: 2 }),
      event(3, "scheduler.task_submitted", { task: secondTask, submittedAtMs: 3 }),
      event(4, "scheduler.task_ready", { taskId: "task-a" }),
      event(5, "scheduler.backpressure", { taskId: "task-a", kind: "resources", observedAtMs: 5 }),
      event(6, "scheduler.resources_acquired", { taskId: "task-a", resources: workerTask.resources }),
      event(7, "scheduler.budget_acquired", { taskId: "task-a", budget: workerTask.budget }),
      event(8, "scheduler.dispatch_intended", { taskId: "task-a", projectId: "project-a", workerId: "worker-shared",
        dispatchId: "00000000-0000-4000-8000-000000000008", processIncarnation: "daemon-1",
        taskLeaseId: "task-lease-a", workerLeaseId: "worker-lease-a", grantId: "grant-task-a",
        intentSha256: "a".repeat(64), effect: "potentially_effectful", workspace: workerTask.workspace,
        resources: workerTask.resources, budget: workerTask.budget, intendedAtMs: 8, deadlineAtMs: 1_000 }),
      event(9, "scheduler.resources_released", { taskId: "task-a", resources: workerTask.resources, releasedAtMs: 9 }),
      event(10, "scheduler.budget_released", { taskId: "task-a", reservedBudget: workerTask.budget,
        usedBudget: { seconds: 1, inputTokens: 2, outputTokens: 3, costUsdNano: 4 },
        unusedBudget: { seconds: 299, inputTokens: 998, outputTokens: 497, costUsdNano: 99_999_996 }, releasedAtMs: 10 }),
    ];
    const fleet = projectAgentTrailFleet(events, { nowMs: 10 });
    expect(fleet.workers).toMatchObject({ registered: 1, active: 1 });
    expect(fleet.workers.items[0]).toMatchObject({ workerId: "worker-shared", taskIds: ["task-a", "task-b"] });
    expect(fleet.resources.used).toEqual({ reasoning: 0, writers: 0, heavyValidation: 0, review: 0, integration: 0 });
    expect(fleet.budgets.reserved).toEqual({ seconds: 0, inputTokens: 0, outputTokens: 0, costUsdNano: 0 });
    expect(fleet.budgets.used).toEqual({ seconds: 1, inputTokens: 2, outputTokens: 3, costUsdNano: 4 });
    expect(fleet.queue.backpressured).toBe(0);
  });

  it("stales workers with their daemon and rejects mismatched heartbeat incarnations", () => {
    const scheduled = task("task-a", "project-a", "worker-a");
    const beforeHeartbeat = [
      event(1, "scheduler.daemon_started", { schemaVersion: 1, schedulerId: "installed", processIncarnation: "daemon-old",
        pid: 1, platform: "darwin-arm64", capabilities: ["write_worktree"], limits, startedAtMs: 1 }),
      event(2, "scheduler.task_submitted", { task: scheduled, submittedAtMs: 2 }),
      event(3, "scheduler.dispatch_started", { taskId: "task-a", dispatchId: "00000000-0000-4000-8000-000000000003",
        processIncarnation: "daemon-old", workerPid: 3, workerIncarnation: "worker-v1",
        workerProcessStartIdentity: "pid-3", startedAtMs: 3 }),
      event(4, "scheduler.daemon_stale", { schemaVersion: 1, staleProcessIncarnation: "daemon-old",
        replacementProcessIncarnation: "daemon-new", detectedAtMs: 4 }),
    ];
    expect(projectAgentTrailFleet(beforeHeartbeat, { nowMs: 4 }).workers.items[0]).toMatchObject({
      health: "stale", daemonIncarnation: "daemon-old", daemonState: "stale",
    });
    expect(() => projectAgentTrailFleet([...beforeHeartbeat,
      event(5, "scheduler.worker_heartbeat", { taskId: "task-a", dispatchId: "00000000-0000-4000-8000-000000000003",
        processIncarnation: "daemon-new", workerIncarnation: "worker-v2", observedAtMs: 5 }),
    ], { nowMs: 5 })).toThrow(/heartbeat.*incarnation/i);
  });

  it("reports supplied canonical replay gaps without claiming healthy convergence", () => {
    expect(projectAgentTrailFleet([], { projectionPosition: 8, journalHighWaterPosition: 10,
      historyComplete: false, droppedProjectionEntries: 2, ingestionGapCount: 1 }).observability).toEqual({
      state: "degraded", projectionPosition: 8, journalHighWaterPosition: 10, projectionLag: 2,
      historyComplete: false, retentionIndependent: true, droppedProjectionEntries: 2, ingestionGapCount: 1,
    });
  });
});
