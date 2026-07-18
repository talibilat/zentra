import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import {
  WorkerLifecycleService,
  authorityCanNarrow,
  capabilitiesCanNarrow,
  capabilityEnvelope,
  effectCanNarrow,
  networkCanNarrow,
  projectWorkerLifecycle,
  repositoryCanNarrow,
  workerStreamId,
  type WorkerBinding,
} from "../../src/workers/worker-lifecycle.js";

describe("generic worker lifecycle", () => {
  const authorities = ["read_only", "workspace_write", "validation", "review", "integration", "local_release_preparation", "external_effect"] as const;
  const networks = ["denied", "model_provider_only", "declared_web_research"] as const;
  const repositories = ["none", "read_only", "assigned_worktree"] as const;
  const effects = ["none", "assigned", "zentra_only"] as const;
  const capabilities = ["read_repository", "write_worktree", "run_validation", "review_diff", "integrate", "web_research"] as const;

  it.each(authorities.flatMap((parent) => authorities.map((child) => [parent, child] as const)))(
    "defines authority partial order %s -> %s without ordering independent categories",
    (parent, child) => expect(authorityCanNarrow(parent, child)).toBe(child === parent || child === "read_only"),
  );

  it.each(networks.flatMap((parent) => networks.map((child) => [parent, child] as const)))(
    "defines network partial order %s -> %s",
    (parent, child) => expect(networkCanNarrow(parent, child)).toBe(child === parent || (parent === "model_provider_only" && child === "denied")),
  );

  it.each(repositories.flatMap((parent) => repositories.map((child) => [parent, child] as const)))(
    "defines repository partial order %s -> %s",
    (parent, child) => expect(repositoryCanNarrow(parent, child)).toBe(
      child === parent || (parent === "assigned_worktree" && (child === "read_only" || child === "none")) || (parent === "read_only" && child === "none"),
    ),
  );

  it.each(effects.flatMap((parent) => effects.map((child) => [parent, child] as const)))(
    "defines effect partial order %s -> %s",
    (parent, child) => expect(effectCanNarrow(parent, child)).toBe(child === parent || child === "none"),
  );

  it.each(capabilities.flatMap((parent) => capabilities.map((child) => [parent, child] as const)))(
    "keeps independent capabilities incomparable %s -> %s",
    (parent, child) => expect(capabilitiesCanNarrow([parent], [child])).toBe(child === parent),
  );

  it("serializes a complete lifecycle and measured model usage on one root-task stream", () => {
    const journal = new SqliteEventJournal(":memory:");
    const service = new WorkerLifecycleService(journal);
    service.bind(binding("writer"));
    service.start("task-1", "writer");
    service.observe("task-1", "writer", model("started", null, usage()));
    service.observe("task-1", "writer", model("completed", "completed", usage({ modelTurns: 1, inputTokens: 5 })));
    service.observe("task-1", "writer", { kind: "process", name: "opencode", outcome: "completed" });
    service.cleanup("task-1", "writer", "completed");
    service.terminate("task-1", "writer", "completed");

    const events = journal.readStream(workerStreamId("task-1"));
    expect(new Set(events.map((event) => event.streamId))).toEqual(new Set(["worker-task:task-1"]));
    expect(projectWorkerLifecycle(events).budget?.usage).toMatchObject({ modelTurns: 1, inputTokens: 5, toolCalls: 0 });
    expect(projectWorkerLifecycle(events).workers["writer"]).toMatchObject({ status: "terminal", terminalOutcome: "completed" });
    journal.close();
  });

  it("accepts a harness-neutral nested fixture with semantically narrower paths and no effect authority", () => {
    const journal = new SqliteEventJournal(":memory:");
    const service = new WorkerLifecycleService(journal);
    service.bind(binding("writer"));
    service.start("task-1", "writer");
    service.bind(binding("research", {
      parentWorkerId: "writer",
      role: "researcher",
      model: null,
      envelope: readEnvelope("researcher", ["src/lib/**"]),
    }));
    expect(service.start("task-1", "research")).toMatchObject({ status: "running", parentWorkerId: "writer" });
    journal.close();
  });

  it("allows inherited assigned-worktree authority only with exact parent scope and write capability/effect", () => {
    const journal = new SqliteEventJournal(":memory:");
    const service = new WorkerLifecycleService(journal);
    service.bind(binding("parent"));
    expect(() => service.bind(binding("exact", { parentWorkerId: "parent" }))).not.toThrow();
    expect(() => service.bind(binding("narrowed", {
      parentWorkerId: "parent",
      envelope: capabilityEnvelope({ role: "implementer", authority: "workspace_write", capabilities: ["read_repository", "write_worktree"], network: "denied", secrets: "none", effects: { worktree: "assigned", pathExpansion: "none", integration: "none", release: "none", external: "none" }, resources: { repository: "assigned_worktree", paths: ["src/lib/**"], forbiddenPaths: [".env"] } }),
    }))).toThrow(/path expansion/i);
    journal.close();
  });

  it.each([
    ["unknown parent", binding("child", { parentWorkerId: "missing", envelope: readEnvelope("researcher", ["src/**"]) })],
    ["self cycle", binding("child", { parentWorkerId: "child", envelope: readEnvelope("researcher", ["src/**"]) })],
    ["path expansion", binding("child", { parentWorkerId: "writer", envelope: readEnvelope("researcher", ["test/**"]) })],
    ["removed forbidden path", binding("child", { parentWorkerId: "writer", envelope: readEnvelope("researcher", ["src/**"], []) })],
  ] as const)("rejects hostile nested %s", (_name, child) => {
    const journal = new SqliteEventJournal(":memory:");
    const service = new WorkerLifecycleService(journal);
    service.bind(binding("writer"));
    expect(() => service.bind(child)).toThrow();
    journal.close();
  });

  it("rejects role-authority mismatches and reserved web research before binding", () => {
    expect(() => capabilityEnvelope({ role: "researcher", authority: "workspace_write", capabilities: ["read_repository"], network: "denied", secrets: "none", effects: { worktree: "none", pathExpansion: "none", integration: "none", release: "none", external: "none" }, resources: { repository: "read_only", paths: ["src/**"], forbiddenPaths: [] } })).toThrow(/role and authority/i);
    expect(() => capabilityEnvelope({ role: "researcher", authority: "read_only", capabilities: ["read_repository", "web_research"], network: "declared_web_research", secrets: "none", effects: { worktree: "none", pathExpansion: "none", integration: "none", release: "none", external: "none" }, resources: { repository: "read_only", paths: ["src/**"], forbiddenPaths: [] } })).toThrow(/reserved/i);
  });

  it("reserves active workers atomically across two services and SQLite connections", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-worker-race-"));
    const database = path.join(root, "events.sqlite");
    try {
      const first = new SqliteEventJournal(database);
      const second = new SqliteEventJournal(database);
      const a = new WorkerLifecycleService(first);
      const b = new WorkerLifecycleService(second);
      a.bind(binding("parent", { budget: budget({ maxActiveWorkers: 1 }) }));
      a.start("task-1", "parent");
      expect(() => b.bind(binding("child", {
        parentWorkerId: "parent", budget: budget({ maxActiveWorkers: 1 }), envelope: readEnvelope("researcher", ["src/**"]),
      }))).not.toThrow();
      expect(() => b.start("task-1", "child")).toThrow(/active worker budget/i);
      first.close();
      second.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("shares concurrent tool and model-turn reservations across descendants", () => {
    const journal = new SqliteEventJournal(":memory:");
    const service = new WorkerLifecycleService(journal);
    service.bind(binding("parent", { budget: budget({ maxConcurrentTools: 1, maxConcurrentModelTurns: 1 }) }));
    service.start("task-1", "parent");
    service.bind(binding("child", { parentWorkerId: "parent", budget: budget({ maxConcurrentTools: 1, maxConcurrentModelTurns: 1 }), envelope: readEnvelope("researcher", ["src/**"]) }));
    service.start("task-1", "child");
    service.observe("task-1", "parent", { kind: "tool", name: "read", phase: "started", outcome: null, usage: usage() });
    expect(() => service.observe("task-1", "child", { kind: "tool", name: "grep", phase: "started", outcome: null, usage: usage() })).toThrow(/concurrent activity/i);
    service.observe("task-1", "parent", { kind: "tool", name: "read", phase: "completed", outcome: "completed", usage: usage({ toolCalls: 1 }) });
    service.observe("task-1", "child", model("started", null, usage()));
    expect(() => service.observe("task-1", "parent", model("started", null, usage()))).toThrow(/concurrent activity/i);
    journal.close();
  });

  it("rejects completed cleanup and terminal events while activity reservations remain", () => {
    const journal = new SqliteEventJournal(":memory:");
    const service = new WorkerLifecycleService(journal);
    service.bind(binding("worker"));
    service.start("task-1", "worker");
    service.observe("task-1", "worker", model("started", null, usage()));
    const version = journal.readStream(workerStreamId("task-1")).length;
    expect(() => service.cleanup("task-1", "worker", "completed")).toThrow(/unresolved activity reservations/i);
    expect(journal.readStream(workerStreamId("task-1"))).toHaveLength(version);
    service.uncertain("task-1", "worker", "model result unknown");
    const uncertain = service.cleanup("task-1", "worker", "uncertain");
    expect(uncertain).toMatchObject({ status: "uncertain", activeModelTurns: 1, cleanup: "uncertain" });
    expect(() => service.terminate("task-1", "worker", "completed")).toThrow(/terminal requires cleanup|unresolved/i);
    journal.close();
  });

  it("rejects over-budget measured completion without consuming its reservation", () => {
    const journal = new SqliteEventJournal(":memory:");
    const service = new WorkerLifecycleService(journal);
    service.bind(binding("worker", { budget: budget({ maxModelTurns: 1, maxInputTokens: 1 }) }));
    service.start("task-1", "worker");
    service.observe("task-1", "worker", model("started", null, usage()));
    expect(() => service.observe("task-1", "worker", model("completed", "completed", usage({ modelTurns: 1, inputTokens: 2 })))).toThrow(/budget exceeded/i);
    expect(service.inspect("task-1")).toMatchObject({
      workers: { worker: { activeModelTurns: 1 } },
      budget: { usage: { modelTurns: 0, inputTokens: 0 } },
    });
    journal.close();
  });

  it("uses one optimistic version for parent terminal and descendant binding races", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-worker-parent-race-"));
    const database = path.join(root, "events.sqlite");
    try {
      const first = new SqliteEventJournal(database);
      const second = new SqliteEventJournal(database);
      const service = new WorkerLifecycleService(first);
      service.bind(binding("parent"));
      service.cleanup("task-1", "parent", "completed");
      const staleVersion = second.readStream(workerStreamId("task-1")).length;
      service.terminate("task-1", "parent", "failed");
      expect(() => second.append(workerStreamId("task-1"), staleVersion, [{
        streamId: workerStreamId("task-1"), type: "worker.bound", payload: binding("child", { parentWorkerId: "parent", envelope: readEnvelope("researcher", ["src/**"]) }),
        causationId: null, correlationId: "correlation-1",
      }])).toThrow(/expected version/);
      first.close(); second.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("retains nonterminal uncertainty across restart and blocks redispatch", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-worker-restart-"));
    const database = path.join(root, "events.sqlite");
    try {
      const first = new SqliteEventJournal(database);
      const service = new WorkerLifecycleService(first);
      service.bind(binding("writer"));
      service.start("task-1", "writer");
      service.uncertain("task-1", "writer", "process result unknown");
      first.close();
      const second = new SqliteEventJournal(database);
      const restarted = new WorkerLifecycleService(second);
      expect(restarted.inspect("task-1").workers["writer"]?.status).toBe("uncertain");
      expect(() => restarted.bind(binding("writer"))).toThrow(/duplicate/i);
      expect(() => restarted.start("task-1", "writer")).toThrow(/out of order/i);
      second.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function binding(workerId: string, overrides: Partial<WorkerBinding> = {}): WorkerBinding {
  return { schemaVersion: 1, workerId, taskId: "task-1", rootTaskId: "task-1", parentWorkerId: null,
    harness: "deterministic", role: "implementer", model: { capabilityId: "model", modelId: "provider/model" },
    envelope: writerEnvelope("implementer"), budget: budget(),
    taskContext: { kind: "standalone" },
    trace: { traceId: "trace-1", correlationId: "correlation-1" }, ...overrides };
}
function budget(overrides = {}) { return { budgetId: "budget-1", maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100, maxToolCalls: 10, maxModelTurns: 10, maxActiveWorkers: 4, maxConcurrentTools: 2, maxConcurrentModelTurns: 2, ...overrides }; }
function writerEnvelope(role: WorkerBinding["role"]) { return capabilityEnvelope({ role, authority: "workspace_write", capabilities: ["read_repository", "write_worktree"], network: "denied", secrets: "none", effects: { worktree: "assigned", pathExpansion: "none", integration: "none", release: "none", external: "none" }, resources: { repository: "assigned_worktree", paths: ["src/**"], forbiddenPaths: [".env"] } }); }
function readEnvelope(role: WorkerBinding["role"], paths: string[], forbiddenPaths = [".env"]) { return capabilityEnvelope({ role, authority: role === "reviewer" ? "review" : "read_only", capabilities: role === "reviewer" ? ["read_repository", "review_diff"] : ["read_repository"], network: "denied", secrets: "none", effects: { worktree: "none", pathExpansion: "none", integration: "none", release: "none", external: "none" }, resources: { repository: "read_only", paths, forbiddenPaths } }); }
function usage(overrides = {}) { return { seconds: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, modelTurns: 0, ...overrides }; }
function model(phase: "started" | "completed", outcome: "completed" | null, measured: ReturnType<typeof usage>) { return { kind: "model" as const, name: "provider/model", phase, outcome, usage: measured }; }
