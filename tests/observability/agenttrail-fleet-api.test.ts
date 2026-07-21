import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { StoredEvent } from "../../src/contracts/event.js";
import { agentTailEventToJsonLine, storedEventToAgentTailEvent } from "../../src/observability/agent-tail.js";
import { projectAgentTrailFleet } from "../../src/observability/agent-trail-fleet.js";

function stored(position: number, type: string, payload: unknown): StoredEvent {
  return { streamId: "scheduler:installed", type, payload, causationId: null, correlationId: "fleet-api",
    eventId: `event-${position}`, streamVersion: position, globalPosition: position,
    recordedAt: new Date(Date.UTC(2026, 6, 21, 10, 0, position)).toISOString() };
}

describe("AgentTrail fleet API", () => {
  it("rebuilds authoritative fleet state after the bounded live cursor resets", () => {
    const limits = { resources: { reasoning: 2, writers: 1, heavyValidation: 1, review: 1, integration: 1 },
      budget: { seconds: 1_000, inputTokens: 1_000, outputTokens: 1_000, costUsdNano: 1_000_000 } };
    const task = { taskId: "task-a", projectId: "project-a", workerId: "worker-a", effect: "potentially_effectful",
      requiredCapabilities: ["write_worktree"], platform: "darwin-arm64", workspace: { path: "/tmp/task-a", available: true },
      admission: { dependencies: [], decisionsApproved: true, pathsAvailable: true, capabilitySupported: true,
        platformSupported: true, policyPermits: true, budgetAvailable: true, workspaceValid: true,
        acceptanceCriteria: ["secret acceptance text"], evidenceRequirements: ["secret evidence text"] },
      resources: { reasoning: 1, writers: 1, heavyValidation: 0, review: 0, integration: 0 },
      budget: { seconds: 60, inputTokens: 100, outputTokens: 50, costUsdNano: 1_000 }, grantId: "grant-a" };
    const events = [
      stored(1, "scheduler.daemon_started", { schemaVersion: 1, schedulerId: "installed", processIncarnation: "daemon-a",
        pid: 10, platform: "darwin-arm64", capabilities: ["write_worktree"], limits, startedAtMs: 1 }),
      stored(2, "scheduler.task_submitted", { task, submittedAtMs: 2 }),
      stored(3, "scheduler.task_ready", { taskId: "task-a" }),
      stored(4, "scheduler.backpressure", { taskId: "task-a", kind: "resources", observedAtMs: 4 }),
    ];
    const input = events.map((event) => agentTailEventToJsonLine(storedEventToAgentTailEvent(event))).join("");
    const script = [
      "import json,sys",
      "from agent_tail.serve import RunStore",
      "store=RunStore(source_kind='file',max_live_updates=2)",
      "[store.feed_line(line) for line in sys.stdin]",
      "store.set_source_status(connected=True,state='caught_up')",
      "reset=next(iter(store.stream_updates(0)))",
      "detail=store.run_detail('fleet-api')",
      "print(json.dumps({'reset':reset,'fleet':detail['fleet']}))",
    ].join(";");
    const result = spawnSync("python3", ["-B", "-c", script], { input, encoding: "utf8", shell: false,
      env: { PATH: process.env.PATH ?? "", PYTHONPATH: path.resolve("agenttrail/upstream/src") } });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as any;
    expect(output.reset).toMatchObject({ type: "reset", data: { reason: "history_gap" } });
    expect(output.fleet).toMatchObject({
      workers: { registered: 1, active: 0 },
      queue: { queued: 1, active: 0, backpressured: 1 },
      observability: { state: "healthy", projection_lag: 0 },
      attention: expect.any(Array),
    });
    expect(JSON.stringify(output)).not.toMatch(/secret acceptance|secret evidence|\/tmp\/task-a/);
  });

  it("reconstructs the same fleet after more than ten thousand updates, TraceIndex byte eviction, and restart", () => {
    const limits = { resources: { reasoning: 2, writers: 1, heavyValidation: 1, review: 1, integration: 1 },
      budget: { seconds: 1_000, inputTokens: 1_000, outputTokens: 1_000, costUsdNano: 1_000_000 } };
    const scheduled = { taskId: "task-durable", projectId: "project-durable", workerId: "worker-durable",
      effect: "potentially_effectful", requiredCapabilities: ["write_worktree"], platform: "darwin-arm64",
      workspace: { path: "/tmp/durable", available: true }, admission: { dependencies: [], decisionsApproved: true,
        pathsAvailable: true, capabilitySupported: true, platformSupported: true, policyPermits: true,
        budgetAvailable: true, workspaceValid: true, acceptanceCriteria: ["retained"], evidenceRequirements: ["receipt"] },
      resources: { reasoning: 1, writers: 1, heavyValidation: 0, review: 0, integration: 0 },
      budget: { seconds: 60, inputTokens: 100, outputTokens: 50, costUsdNano: 1_000 }, grantId: "grant-durable" };
    const durable = [
      stored(1, "scheduler.daemon_started", { schemaVersion: 1, schedulerId: "installed", processIncarnation: "daemon-durable",
        pid: 10, platform: "darwin-arm64", capabilities: ["write_worktree"], limits, startedAtMs: 1 }),
      stored(2, "scheduler.task_submitted", { task: scheduled, submittedAtMs: 2 }),
      stored(3, "scheduler.task_ready", { taskId: "task-durable" }),
      stored(4, "scheduler.backpressure", { taskId: "task-durable", kind: "resources", observedAtMs: 4 }),
    ].map((event) => agentTailEventToJsonLine(storedEventToAgentTailEvent(event)));
    const filler = Array.from({ length: 10_050 }, (_, index) => JSON.stringify({
      schema_version: "1.0", event_id: `filler-${index}`, trace_id: "fleet-api", span_id: "task:filler",
      parent_span_id: null, emitter_id: "fixture", sequence: index + 5,
      timestamp: new Date(Date.UTC(2026, 6, 21, 11, 0, 0, index)).toISOString(), kind: "task.started",
      actor: { id: "filler-worker", role: "worker" }, operation: { name: "task", status: "running" },
      relationships: [], identities: { emitter_id: "fixture" }, attributes: {}, payload: { workerId: "filler-worker" },
    }) + "\n");
    const input = [...durable, ...filler].join("");
    const script = [
      "import json,sys",
      "from agent_tail.core import TraceIndex",
      "from agent_tail.serve import RunStore",
      "lines=list(sys.stdin)",
      "def replay():",
      " store=RunStore(TraceIndex(max_bytes=4096),source_kind='file',max_live_updates=10)",
      " [store.feed_line(line) for line in lines]",
      " store.set_source_status(connected=True,state='caught_up')",
      " return store.run_detail('fleet-api')",
      "first=replay()",
      "second=replay()",
      "print(json.dumps({'first':first['fleet'],'second':second['fleet'],'evictions':first['run']['event_count']}))",
    ].join("\n");
    const result = spawnSync("python3", ["-B", "-c", script], { input, encoding: "utf8", shell: false,
      maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? "", PYTHONPATH: path.resolve("agenttrail/upstream/src") } });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as any;
    expect(output.second).toEqual(output.first);
    expect(output.first).toMatchObject({ workers: { registered: 1, active: 0 },
      queue: { queued: 1, backpressured: 1 }, observability: {
        state: "healthy", projection_position: 10_054, journal_high_water_position: 10_054,
        projection_lag: 0, history_complete: true, retention_independent: true,
      } });
    expect(output.evictions).toBeLessThan(10_054);
  }, 30_000);

  it("matches TypeScript allocation, unique-worker, backpressure, and stale-incarnation semantics", () => {
    const limits = { resources: { reasoning: 2, writers: 1, heavyValidation: 1, review: 1, integration: 1 },
      budget: { seconds: 1_000, inputTokens: 1_000, outputTokens: 1_000, costUsdNano: 1_000_000 } };
    const task = (taskId: string) => ({ taskId, projectId: "project-a", workerId: "worker-shared",
      effect: "potentially_effectful" as const, requiredCapabilities: ["write_worktree"], platform: "darwin-arm64" as const,
      workspace: { path: `/tmp/${taskId}`, available: true }, admission: { dependencies: [], decisionsApproved: true,
        pathsAvailable: true, capabilitySupported: true, platformSupported: true, policyPermits: true,
        budgetAvailable: true, workspaceValid: true, acceptanceCriteria: ["retained"], evidenceRequirements: ["receipt"] },
      resources: { reasoning: 1, writers: 1, heavyValidation: 0, review: 0, integration: 0 },
      budget: { seconds: 60, inputTokens: 100, outputTokens: 50, costUsdNano: 1_000 }, grantId: `grant-${taskId}` });
    const first = task("task-a");
    const events = [
      stored(1, "scheduler.daemon_started", { schemaVersion: 1, schedulerId: "installed", processIncarnation: "daemon-old",
        pid: 10, platform: "darwin-arm64", capabilities: ["write_worktree"], limits, startedAtMs: 1 }),
      stored(2, "scheduler.task_submitted", { task: first, submittedAtMs: 2 }),
      stored(3, "scheduler.task_submitted", { task: task("task-b"), submittedAtMs: 3 }),
      stored(4, "scheduler.task_ready", { taskId: "task-a" }),
      stored(5, "scheduler.backpressure", { taskId: "task-a", kind: "resources", observedAtMs: 5 }),
      stored(6, "scheduler.resources_acquired", { taskId: "task-a", resources: first.resources }),
      stored(7, "scheduler.budget_acquired", { taskId: "task-a", budget: first.budget }),
      stored(8, "scheduler.dispatch_started", { taskId: "task-a", dispatchId: "00000000-0000-4000-8000-000000000008",
        processIncarnation: "daemon-old", workerPid: 8, workerIncarnation: "worker-v1",
        workerProcessStartIdentity: "pid-8", startedAtMs: 8 }),
      stored(9, "scheduler.resources_released", { taskId: "task-a", resources: first.resources, releasedAtMs: 9 }),
      stored(10, "scheduler.budget_released", { taskId: "task-a", reservedBudget: first.budget,
        usedBudget: { seconds: 1, inputTokens: 2, outputTokens: 3, costUsdNano: 4 },
        unusedBudget: { seconds: 59, inputTokens: 98, outputTokens: 47, costUsdNano: 996 }, releasedAtMs: 10 }),
      stored(11, "scheduler.daemon_stale", { schemaVersion: 1, staleProcessIncarnation: "daemon-old",
        replacementProcessIncarnation: "daemon-new", detectedAtMs: 11 }),
    ];
    const typescript = projectAgentTrailFleet(events, { nowMs: 11 });
    const input = events.map((event) => agentTailEventToJsonLine(storedEventToAgentTailEvent(event))).join("");
    const script = "import json,sys;from agent_tail.serve import RunStore;s=RunStore();[s.feed_line(x) for x in sys.stdin];s.set_source_status(connected=True,state='caught_up');print(json.dumps(s.run_detail('fleet-api')['fleet']))";
    const result = spawnSync("python3", ["-B", "-c", script], { input, encoding: "utf8", shell: false,
      env: { PATH: process.env.PATH ?? "", PYTHONPATH: path.resolve("agenttrail/upstream/src") } });
    expect(result.status, result.stderr).toBe(0);
    const python = JSON.parse(result.stdout) as any;
    expect(python.workers.registered).toBe(typescript.workers.registered);
    expect(python.workers.active).toBe(typescript.workers.active);
    expect(python.workers.items[0]).toMatchObject({ worker_id: "worker-shared", task_ids: ["task-a", "task-b"],
      health: "stale", daemon_state: "stale" });
    expect(python.resources.used).toEqual(typescript.resources.used);
    expect(python.budgets.reserved).toEqual(typescript.budgets.reserved);
    expect(python.budgets.used).toEqual(typescript.budgets.used);
    expect(python.queue.backpressured).toBe(typescript.queue.backpressured);
  });

  it("marks a mismatched Python heartbeat stale without replacing bound incarnations", () => {
    const limits = { resources: { reasoning: 1, writers: 1, heavyValidation: 0, review: 0, integration: 1 },
      budget: { seconds: 100, inputTokens: 100, outputTokens: 100, costUsdNano: 100 } };
    const scheduled = { taskId: "task-a", projectId: "project-a", workerId: "worker-a", effect: "potentially_effectful",
      requiredCapabilities: ["write_worktree"], platform: "darwin-arm64", workspace: { path: "/tmp/a", available: true },
      admission: { dependencies: [], decisionsApproved: true, pathsAvailable: true, capabilitySupported: true,
        platformSupported: true, policyPermits: true, budgetAvailable: true, workspaceValid: true,
        acceptanceCriteria: ["done"], evidenceRequirements: ["receipt"] },
      resources: { reasoning: 1, writers: 1, heavyValidation: 0, review: 0, integration: 0 },
      budget: { seconds: 10, inputTokens: 10, outputTokens: 10, costUsdNano: 10 }, grantId: "grant-a" };
    const events = [
      stored(1, "scheduler.daemon_started", { schemaVersion: 1, schedulerId: "installed", processIncarnation: "daemon-old",
        pid: 1, platform: "darwin-arm64", capabilities: ["write_worktree"], limits, startedAtMs: 1 }),
      stored(2, "scheduler.task_submitted", { task: scheduled, submittedAtMs: 2 }),
      stored(3, "scheduler.dispatch_started", { taskId: "task-a", dispatchId: "00000000-0000-4000-8000-000000000003",
        processIncarnation: "daemon-old", workerPid: 3, workerIncarnation: "worker-v1",
        workerProcessStartIdentity: "pid-3", startedAtMs: 3 }),
      stored(4, "scheduler.worker_heartbeat", { taskId: "task-a", dispatchId: "00000000-0000-4000-8000-000000000003",
        processIncarnation: "daemon-new", workerIncarnation: "worker-v2", observedAtMs: 4 }),
    ];
    const input = events.map((event) => agentTailEventToJsonLine(storedEventToAgentTailEvent(event))).join("");
    const script = "import json,sys;from agent_tail.serve import RunStore;s=RunStore();[s.feed_line(x) for x in sys.stdin];s.set_source_status(connected=True,state='caught_up');print(json.dumps(s.run_detail('fleet-api')['fleet']['workers']['items'][0]))";
    const result = spawnSync("python3", ["-B", "-c", script], { input, encoding: "utf8", shell: false,
      env: { PATH: process.env.PATH ?? "", PYTHONPATH: path.resolve("agenttrail/upstream/src") } });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ process_incarnation: "worker-v1",
      daemon_incarnation: "daemon-old", health: "stale", last_heartbeat_at_ms: null });
  });

  it("reports bounded projection overflow as an honest gap and lag", () => {
    const events = Array.from({ length: 4 }, (_, index) => JSON.stringify({
      schema_version: "1.0", event_id: `event-${index}`, trace_id: "bounded", span_id: `task:${index}`,
      parent_span_id: null, emitter_id: "fixture", sequence: index + 1,
      timestamp: new Date(Date.UTC(2026, 6, 21, 12, 0, index)).toISOString(), kind: "scheduler.task_submitted",
      actor: { id: "scheduler", role: "scheduler" }, operation: { name: "scheduling", status: "waiting" },
      relationships: [], identities: { emitter_id: "fixture" }, attributes: {}, payload: {
        taskId: `task-${index}`, projectId: "project-a", workerId: `worker-${index}`,
        resources: { reasoning: 1, writers: 0, heavyValidation: 0, review: 0, integration: 0 },
        budget: { seconds: 1, inputTokens: 1, outputTokens: 1, costUsdNano: 1 }, submittedAtMs: index,
      },
    }) + "\n").join("");
    const script = "import json,sys;from agent_tail.serve import RunStore;s=RunStore(fleet_max_entries=2);[s.feed_line(x) for x in sys.stdin];s.set_source_status(connected=True,state='caught_up');print(json.dumps(s.run_detail('bounded')['fleet']['observability']))";
    const result = spawnSync("python3", ["-B", "-c", script], { input: events, encoding: "utf8", shell: false,
      env: { PATH: process.env.PATH ?? "", PYTHONPATH: path.resolve("agenttrail/upstream/src") } });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "degraded", projection_position: 2,
      journal_high_water_position: 4, projection_lag: 2, history_complete: false,
      dropped_projection_entries: 2, retention_independent: true });
  });
});
