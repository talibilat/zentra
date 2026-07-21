import { describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import type { NewEvent } from "../../src/contracts/event.js";
import type { EventJournal } from "../../src/journal/journal.js";
import { PodCoordinator, authorizePodUsageMeter, type PodCoordinatorTimers, type PodUsageMeter } from "../../src/pods/pod-coordinator.js";
import { PodRegistry } from "../../src/pods/pod-registry.js";
import { RecordingPodDispatchAdapter } from "./fixtures.js";
import { charter, grant, lease, usage, workspaceLease } from "./pod-fixtures.js";

const now = () => new Date("2026-07-20T10:30:00.000Z");

function authoritativeMeter(): PodUsageMeter {
  const sessions = new WeakSet<object>();
  return authorizePodUsageMeter<PodUsageMeter>({
    capability: { elapsed: true, tokens: true, cost: true, retries: true, externalEffects: true },
    open: () => { const session = { snapshot: () => usage, close: () => {} }; sessions.add(session); return session; },
    verify: (session) => sessions.has(session),
  });
}

function seedResearch(registry: PodRegistry): void {
  const budget = { ...lease().budget, maxSeconds: 1, maxCostUsd: 0, maxInputTokens: 1, maxOutputTokens: 1 };
  const authority = lease({ leaseId: "lease-research", assignmentId: "assignment-research", workspaceLeaseId: "workspace-research",
    taskId: "research", agentId: "agent-read", capabilities: ["read_repository"], ownedPaths: ["tests/pods/**"], budget });
  registry.receiveLease("pod-1", authority);
  registry.receiveWorkspaceLease("pod-1", workspaceLease({ workspaceLeaseId: authority.workspaceLeaseId,
    podLeaseId: authority.leaseId, taskId: authority.taskId, path: "/tmp/zentra-worktrees/research", branch: "refs/heads/ticket/research" }));
  const assignment = { assignmentId: "assignment-research", taskId: "research", roleId: "researcher", agentId: "agent-read",
    charterRevision: 1, capabilities: ["read_repository"] as ("read_repository")[], ownedPaths: ["tests/pods/**"], budget };
  const current = registry.inspect("pod-1")!;
  const bindings = { assignmentDigest: digestCanonical(assignment), charterDigest: digestCanonical(current.charter),
    grantDigest: digestCanonical(current.grant), leaseDigest: digestCanonical(authority) };
  const proposalId = digestCanonical({ podId: "pod-1", charterRevision: 1, workspaceLeaseId: "workspace-research", ...bindings });
  registry.assign("pod-1", assignment, { proposalId, ...bindings });
  registry.claimDispatch("pod-1", { assignmentId: assignment.assignmentId, proposalId, dispatchId: "dispatch-research" });
  registry.startReservedInvocation("pod-1", { assignmentId: assignment.assignmentId, dispatchId: "dispatch-research",
    authorizedAt: now().toISOString(), executionId: "execution-research", charterRevision: 1 });
  registry.bindExecution("pod-1", { assignmentId: assignment.assignmentId, dispatchId: "dispatch-research",
    executionId: "execution-research", processId: "process-research", processIncarnation: "incarnation-research" });
  registry.recordEvidence("pod-1", { evidenceId: "research-evidence", taskId: "research", kind: "research-report", sha256: "d".repeat(64), sourceEventId: null });
  registry.observeDispatch("pod-1", { assignmentId: assignment.assignmentId, dispatchId: "dispatch-research", outcome: "completed", evidenceIds: ["research-evidence"], usage: { ...usage, elapsedMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 } });
}

function setup(adapter = new RecordingPodDispatchAdapter(), clock: () => Date = now, timers?: PodCoordinatorTimers, meter?: PodUsageMeter) {
  const journal = new SqliteEventJournal(":memory:");
  const registry = new PodRegistry(journal);
  registry.register({ charter: charter(), correlationId: "trace-1" });
  registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
  registry.start("pod-1");
  seedResearch(registry);
  registry.receiveLease("pod-1", lease());
  registry.receiveWorkspaceLease("pod-1", workspaceLease());
  const coordinator = new PodCoordinator(registry, adapter, clock, timers, meter ?? authoritativeMeter());
  return { journal, registry, coordinator, adapter };
}

describe("PodCoordinator", () => {
  it("proposes and dispatches only the exact parent-contained assignment and local isolated workspace", async () => {
    const { journal, coordinator, adapter } = setup();
    try {
      const proposal = coordinator.propose({
        podId: "pod-1", grant: grant(), lease: lease(), assignment: {
          assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
          charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
        },
      });
      expect(Object.isFrozen(proposal)).toBe(true);
      expect(Object.isFrozen(proposal.assignment)).toBe(true);
      expect(Object.isFrozen(proposal.assignment.budget)).toBe(true);
      const result = await coordinator.dispatch({
        proposal,
        signal: new AbortController().signal,
      });
      expect(result.outcome).toBe("completed");
      expect(adapter.packets).toEqual([expect.objectContaining({
        executionMode: "local_process", nativeSubagents: false, distributed: false,
        workspace: expect.objectContaining({ workspaceLeaseId: "workspace-1", repositoryPath: "/tmp/zentra-project",
          path: "/tmp/zentra-worktrees/implement", branch: "refs/heads/ticket/implement" }),
      })]);
      expect(JSON.stringify(adapter.packets)).not.toContain("refs/heads/main");
      expect(JSON.stringify(adapter.packets)).not.toContain("zentra/integration");
      const executionEvents = journal.readStream("pod-1").filter((event) =>
        ["pod.assignment_invocation_started", "pod.execution_reserved", "pod.execution_bound", "pod.assignment_observed"].includes(event.type) &&
        (event.payload as { assignmentId?: string }).assignmentId === "assignment-1");
      expect(executionEvents.map((event) => event.type)).toEqual([
        "pod.assignment_invocation_started", "pod.execution_reserved", "pod.execution_bound", "pod.assignment_observed",
      ]);
      expect(executionEvents[2]?.payload).toMatchObject({ executionId: expect.any(String), processId: expect.any(String),
        processIncarnation: expect.any(String) });
    } finally {
      journal.close();
    }
  });

  it("rejects a proposal whose immutable charter binding is substituted", async () => {
    const { journal, coordinator, adapter } = setup();
    try {
      const proposal = coordinator.propose({ podId: "pod-1", grant: grant(), lease: lease(), assignment: {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
      } });
      await expect(coordinator.dispatch({ proposal: { ...proposal, charterRevision: 2 }, signal: new AbortController().signal }))
        .rejects.toThrow(/stale or mutated/);
      expect(adapter.packets).toHaveLength(0);
    } finally { journal.close(); }
  });

  it.each([
    ["missing grant", () => ({ grant: null })],
    ["expired grant", () => ({ grant: grant({ expiresAt: "2026-07-20T10:29:59.000Z" }) })],
    ["inactive lease", () => ({ lease: lease({ status: "cancelled" }) })],
    ["expanded ownership", () => ({ assignment: { ownedPaths: ["src/**"] } })],
    ["expanded capability", () => ({ assignment: { capabilities: ["read_repository", "write_worktree"] } })],
    ["expanded budget", () => ({ assignment: { budget: { ...lease().budget, maxCostUsd: 3 } } })],
    ["wrong agent", () => ({ assignment: { agentId: "agent-read" } })],
  ] as const)("fails closed for %s", (_name, variation) => {
    const { journal, coordinator, adapter } = setup();
    try {
      const base = {
        podId: "pod-1", grant: grant(), lease: lease(), assignment: {
          assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
          charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
        },
      };
      const changed = variation() as Record<string, unknown>;
      const assignment = { ...base.assignment, ...(changed["assignment"] as object | undefined) };
      expect(() => coordinator.propose({ ...base, ...changed, assignment } as Parameters<typeof coordinator.propose>[0])).toThrow();
      expect(adapter.packets).toHaveLength(0);
    } finally {
      journal.close();
    }
  });

  it("fails before dispatch intent when no authoritative meter covers nonzero budgets", async () => {
    const { journal, registry, adapter } = setup();
    const coordinator = new PodCoordinator(registry, adapter, now);
    try {
      const proposal = coordinator.propose({ podId: "pod-1", grant: grant(), lease: lease(), assignment: {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
      } });
      await expect(coordinator.dispatch({ proposal, signal: new AbortController().signal })).rejects.toThrow(/authoritative usage meter/);
      expect(adapter.packets).toHaveLength(0);
      expect(registry.inspect("pod-1")?.assignments["assignment-1"]?.status).toBe("proposed");
    } finally { journal.close(); }
  });

  it("does not dispatch after cancellation or revision invalidates the assignment", async () => {
    const { journal, registry, coordinator, adapter } = setup();
    try {
      const proposal = coordinator.propose({
        podId: "pod-1", grant: grant(), lease: lease(), assignment: {
          assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
          charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
        },
      });
      registry.requestCancellation("pod-1", { requestedBy: "parent", reason: "stop" });
      await expect(coordinator.dispatch({
        proposal,
        signal: new AbortController().signal,
      })).rejects.toThrow(/cancellation|active/);
      expect(adapter.packets).toHaveLength(0);
    } finally {
      journal.close();
    }
  });

  it("records an uncertain result for central reconciliation and never retries it", async () => {
    const adapter = new RecordingPodDispatchAdapter({
      outcome: "uncertain", evidence: [{ evidenceId: "dispatch-uncertain", kind: "dispatch", sha256: "c".repeat(64) }],
    });
    const { journal, registry, coordinator } = setup(adapter);
    try {
      const proposal = coordinator.propose({
        podId: "pod-1", grant: grant(), lease: lease(), assignment: {
          assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
          charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
        },
      });
      await coordinator.dispatch({
        proposal,
        signal: new AbortController().signal,
      });
      expect(registry.inspect("pod-1")).toMatchObject({ lifecycle: "blocked", reconciliationRequired: true });
      await expect(coordinator.dispatch({
        proposal,
        signal: new AbortController().signal,
      })).rejects.toThrow();
      expect(adapter.packets).toHaveLength(1);
    } finally {
      journal.close();
    }
  });

  it("treats a malformed adapter result as uncertain instead of accepting agent claims", async () => {
    const adapter = new RecordingPodDispatchAdapter({ outcome: "completed", evidence: [] });
    const validStart = adapter.start.bind(adapter);
    adapter.start = async (packet) => ({ ...await validStart(packet),
      completion: Promise.resolve({ outcome: "completed", evidence: [], usage: { ...usage, inputTokens: 0 } } as never) });
    const { journal, registry, coordinator } = setup(adapter);
    try {
      const proposal = coordinator.propose({
        podId: "pod-1", grant: grant(), lease: lease(), assignment: {
          assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
          charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
        },
      });
      await expect(coordinator.dispatch({
        proposal,
        signal: new AbortController().signal,
      })).rejects.toThrow();
      expect(registry.inspect("pod-1")).toMatchObject({ lifecycle: "blocked", reconciliationRequired: true });
    } finally {
      journal.close();
    }
  });

  it("turns post-adapter evidence validation failure into durable reconciliation", async () => {
    const adapter = new RecordingPodDispatchAdapter({ outcome: "completed", evidence: [
      { evidenceId: "wrong-evidence", kind: "not-a-test-report", sha256: "a".repeat(64) },
    ] });
    const { journal, registry, coordinator } = setup(adapter);
    try {
      const proposal = coordinator.propose({ podId: "pod-1", grant: grant(), lease: lease(), assignment: {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
      } });
      await expect(coordinator.dispatch({ proposal, signal: new AbortController().signal })).rejects.toThrow(/evidence/);
      expect(registry.inspect("pod-1")).toMatchObject({ lifecycle: "blocked", reconciliationRequired: true,
        assignments: { "assignment-1": { status: "invoking" } } });
    } finally { journal.close(); }
  });

  it("enforces the trusted assignment deadline against a noncooperative adapter and ignores late completion", async () => {
    let nowMs = Date.parse("2026-07-20T10:30:00.000Z");
    let resolveLate!: (value: { outcome: "completed"; evidence: Array<{ evidenceId: string; kind: string; sha256: string }> }) => void;
    let calls = 0;
    const adapter = new RecordingPodDispatchAdapter();
    const validStart = adapter.start.bind(adapter);
    adapter.start = async (packet) => {
      calls += 1;
      const handle = await validStart(packet);
      return { ...handle, completion: new Promise((resolve) => { resolveLate = resolve; }),
        requestCancellation: () => new Promise<never>(() => {}) };
    };
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    const timers: PodCoordinatorTimers = {
      setTimeout: (callback, delayMs) => {
        delays.push(delayMs);
        callbacks.push(() => { nowMs += delayMs; callback(); });
        return callback;
      },
      clearTimeout: () => {},
    };
    const { journal, registry, coordinator } = setup(adapter, () => new Date(nowMs), timers);
    try {
      const proposal = coordinator.propose({ podId: "pod-1", grant: grant(), lease: lease(), assignment: {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
      } });
      const pending = coordinator.dispatch({ proposal, signal: new AbortController().signal });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      callbacks[0]!();
      for (let index = 0; index < 10 && callbacks.length < 2; index += 1) await Promise.resolve();
      callbacks[1]!();
      const result = await pending;
      expect(result).toEqual({ outcome: "uncertain", evidence: [] });
      expect(delays).toEqual([300_000, 5_000]);
      expect(calls).toBe(1);
      const beforeLate = journal.readStream("pod-1");
      resolveLate({ outcome: "completed", evidence: [{ evidenceId: "late", kind: "test-report", sha256: "1".repeat(64) }] });
      await Promise.resolve();
      expect(journal.readStream("pod-1")).toEqual(beforeLate);
      expect(registry.inspect("pod-1")).toMatchObject({ reconciliationRequired: true,
        assignments: { "assignment-1": { status: "invoking", observedOutcome: null,
          executionId: expect.any(String), processId: expect.any(String), processIncarnation: expect.any(String) } } });
      expect(journal.readStream("pod-1").some((event) => event.type === "pod.assignment_observed" &&
        (event.payload as { assignmentId?: string }).assignmentId === "assignment-1")).toBe(false);
      const restarted = new PodCoordinator(registry, adapter, () => new Date(nowMs), timers, authoritativeMeter());
      expect(await restarted.reconcile("pod-1", "assignment-1", "central-reconciler")).toMatchObject({
        reconciliationRequired: false, assignments: { "assignment-1": { status: "completed" } },
      });
    } finally { journal.close(); }
  });

  it("reconciles a startup hang from the durable reservation when no process binding exists", async () => {
    let nowMs = Date.parse("2026-07-20T10:30:00.000Z");
    const adapter = new RecordingPodDispatchAdapter();
    adapter.start = () => new Promise<never>(() => {});
    adapter.lookup = (reservation) => Promise.resolve({ identity: { ...reservation, processId: null, processIncarnation: null },
      status: "terminated", effect: "no_effect", terminationEvidenceSha256: "3".repeat(64),
      effectEvidenceSha256: "4".repeat(64), evidence: [] });
    const callbacks: Array<() => void> = [];
    const timers: PodCoordinatorTimers = {
      setTimeout: (callback, delayMs) => { callbacks.push(() => { nowMs += delayMs; callback(); }); return callback; },
      clearTimeout: () => {},
    };
    const { journal, registry, coordinator } = setup(adapter, () => new Date(nowMs), timers);
    try {
      const proposal = coordinator.propose({ podId: "pod-1", grant: grant(), lease: lease(), assignment: {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
      } });
      const pending = coordinator.dispatch({ proposal, signal: new AbortController().signal });
      await Promise.resolve(); await Promise.resolve();
      callbacks[0]!();
      expect(await pending).toEqual({ outcome: "uncertain", evidence: [] });
      expect(registry.inspect("pod-1")).toMatchObject({ reconciliationRequired: true,
        assignments: { "assignment-1": { executionId: expect.any(String), processId: null } } });
      expect(await coordinator.reconcile("pod-1", "assignment-1", "central")).toMatchObject({ reconciliationRequired: false,
        assignments: { "assignment-1": { status: "failed", processId: null } } });
    } finally { journal.close(); }
  });

  it("binds and cancels a handle that arrives after external cancellation during start", async () => {
    const adapter = new RecordingPodDispatchAdapter();
    const validStart = adapter.start.bind(adapter);
    let resolveStart!: (handle: Awaited<ReturnType<typeof validStart>>) => void;
    let packet!: Parameters<typeof validStart>[0];
    adapter.start = (candidate) => { packet = candidate; return new Promise((resolve) => { resolveStart = resolve; }); };
    const { journal, registry, coordinator } = setup(adapter);
    const external = new AbortController();
    try {
      const proposal = coordinator.propose({ podId: "pod-1", grant: grant(), lease: lease(), assignment: {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
      } });
      const pending = coordinator.dispatch({ proposal, signal: external.signal });
      await Promise.resolve(); await Promise.resolve();
      external.abort(new Error("cancel during start"));
      expect(await pending).toEqual({ outcome: "uncertain", evidence: [] });
      resolveStart(await validStart(packet));
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      expect(registry.inspect("pod-1")).toMatchObject({ reconciliationRequired: true,
        assignments: { "assignment-1": { processId: expect.any(String), processIncarnation: expect.any(String), observedOutcome: null } } });
      expect(journal.readStream("pod-1").some((event) => event.type === "pod.assignment_observed" &&
        (event.payload as { assignmentId?: string }).assignmentId === "assignment-1")).toBe(false);
    } finally { journal.close(); }
  });

  it("recovers a supervisor start crash when lookup later discovers the exact process", async () => {
    const adapter = new RecordingPodDispatchAdapter();
    adapter.start = () => Promise.reject(new Error("supervisor connection crashed"));
    adapter.lookup = (reservation) => Promise.resolve({ identity: { ...reservation, processId: "recovered-process",
      processIncarnation: "recovered-incarnation" }, status: "terminated", effect: "completed",
      terminationEvidenceSha256: "5".repeat(64), effectEvidenceSha256: "6".repeat(64), evidence: [
        { evidenceId: "recovered-test", kind: "test-report", sha256: "7".repeat(64) },
      ] });
    const { journal, registry, coordinator } = setup(adapter);
    try {
      const proposal = coordinator.propose({ podId: "pod-1", grant: grant(), lease: lease(), assignment: {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
      } });
      await expect(coordinator.dispatch({ proposal, signal: new AbortController().signal })).rejects.toThrow(/crashed/);
      expect(registry.inspect("pod-1")).toMatchObject({ reconciliationRequired: true,
        assignments: { "assignment-1": { executionId: expect.any(String), processId: null } } });
      expect(await coordinator.reconcile("pod-1", "assignment-1", "central")).toMatchObject({ reconciliationRequired: false,
        assignments: { "assignment-1": { status: "completed", processId: "recovered-process",
          processIncarnation: "recovered-incarnation" } } });
    } finally { journal.close(); }
  });

  it("rejects verified receipt overspend and requires reconciliation", async () => {
    const adapter = new RecordingPodDispatchAdapter({ outcome: "completed", evidence: [
      { evidenceId: "test-evidence", kind: "test-report", sha256: "2".repeat(64) },
    ] });
    const overspend = { ...usage, inputTokens: lease().budget.maxInputTokens + 1 };
    const sessions = new WeakSet<object>();
    const meter: PodUsageMeter = authorizePodUsageMeter({
      capability: { elapsed: true, tokens: true, cost: true, retries: true, externalEffects: true },
      open: (_identity, onUpdate) => {
        const session = { snapshot: () => overspend, close: () => {} };
        sessions.add(session);
        queueMicrotask(() => onUpdate(overspend));
        return session;
      },
      verify: (session) => sessions.has(session),
    });
    const { journal, registry, coordinator } = setup(adapter, now, undefined, meter);
    try {
      const proposal = coordinator.propose({ podId: "pod-1", grant: grant(), lease: lease(), assignment: {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
      } });
      expect(await coordinator.dispatch({ proposal, signal: new AbortController().signal })).toEqual({ outcome: "uncertain", evidence: [] });
      expect(registry.inspect("pod-1")).toMatchObject({ reconciliationRequired: true,
        assignments: { "assignment-1": { status: "invoking" } } });
    } finally { journal.close(); }
  });

  it("records canonical timeout only after exact bounded termination acknowledgement", async () => {
    let nowMs = Date.parse("2026-07-20T10:30:00.000Z");
    const adapter = new RecordingPodDispatchAdapter();
    const validStart = adapter.start.bind(adapter);
    adapter.start = async (packet) => ({ ...await validStart(packet), completion: new Promise<never>(() => {}) });
    const callbacks: Array<() => void> = [];
    const timers: PodCoordinatorTimers = {
      setTimeout: (callback, delayMs) => { callbacks.push(() => { nowMs += delayMs; callback(); }); return callback; },
      clearTimeout: () => {},
    };
    const { journal, registry, coordinator } = setup(adapter, () => new Date(nowMs), timers);
    try {
      const proposal = coordinator.propose({ podId: "pod-1", grant: grant(), lease: lease(), assignment: {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
      } });
      const pending = coordinator.dispatch({ proposal, signal: new AbortController().signal });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      callbacks[0]!();
      expect(await pending).toMatchObject({ outcome: "timed_out" });
      expect(registry.inspect("pod-1")).toMatchObject({ reconciliationRequired: false,
        assignments: { "assignment-1": { status: "timed_out", observedOutcome: "timed_out" } } });
      expect(journal.readStream("pod-1").find((event) => event.type === "pod.assignment_observed" &&
        (event.payload as { assignmentId?: string }).assignmentId === "assignment-1")).toMatchObject({ payload: { outcome: "timed_out" } });
    } finally { journal.close(); }
  });

  it("retains reconciliation and authority when external abort cannot obtain termination acknowledgement", async () => {
    let nowMs = Date.parse("2026-07-20T10:30:00.000Z");
    const adapter = new RecordingPodDispatchAdapter();
    const validStart = adapter.start.bind(adapter);
    let cancelRequests = 0;
    adapter.start = async (packet) => ({ ...await validStart(packet), completion: new Promise<never>(() => {}),
      requestCancellation: () => { cancelRequests += 1; return new Promise<never>(() => {}); } });
    const callbacks: Array<() => void> = [];
    const timers: PodCoordinatorTimers = {
      setTimeout: (callback, delayMs) => { callbacks.push(() => { nowMs += delayMs; callback(); }); return callback; },
      clearTimeout: () => {},
    };
    const { journal, registry, coordinator } = setup(adapter, () => new Date(nowMs), timers);
    const external = new AbortController();
    try {
      const proposal = coordinator.propose({ podId: "pod-1", grant: grant(), lease: lease(), assignment: {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
      } });
      const pending = coordinator.dispatch({ proposal, signal: external.signal });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      external.abort(new Error("operator abort"));
      for (let index = 0; index < 10 && callbacks.length < 2; index += 1) await Promise.resolve();
      callbacks[1]!();
      expect(await pending).toEqual({ outcome: "uncertain", evidence: [] });
      expect(cancelRequests).toBe(1);
      expect(registry.inspect("pod-1")).toMatchObject({ reconciliationRequired: true,
        assignments: { "assignment-1": { status: "invoking" } }, leases: { "lease-1": { status: "active" } } });
      expect(journal.readStream("pod-1").some((event) => event.type === "pod.assignment_observed" &&
        (event.payload as { assignmentId?: string }).assignmentId === "assignment-1")).toBe(false);
    } finally { journal.close(); }
  });

  it("fails a stale dispatch-intent race before the adapter can run", async () => {
    const inner = new SqliteEventJournal(":memory:");
    const competing = new PodRegistry(inner);
    competing.register({ charter: charter(), correlationId: "trace-1" });
    competing.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
    competing.start("pod-1");
    seedResearch(competing);
    competing.receiveLease("pod-1", lease());
    competing.receiveWorkspaceLease("pod-1", workspaceLease());
    let injected = false;
    const racing: EventJournal = {
      readStream: (...args) => inner.readStream(...args),
      readAll: (...args) => inner.readAll(...args),
      append: (streamId, expectedVersion, events: readonly NewEvent<string, unknown>[]) => {
        if (!injected && events[0]?.type === "pod.assignment_invocation_started") {
          injected = true;
          competing.requestCancellation("pod-1", { requestedBy: "parent", reason: "raced" });
        }
        return inner.append(streamId, expectedVersion, events);
      },
    };
    const adapter = new RecordingPodDispatchAdapter();
    const coordinator = new PodCoordinator(new PodRegistry(racing), adapter, now, undefined, authoritativeMeter());
    try {
      const proposal = coordinator.propose({
        podId: "pod-1", grant: grant(), lease: lease(), assignment: {
          assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
          charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
        },
      });
      await expect(coordinator.dispatch({
        proposal,
        signal: new AbortController().signal,
      })).rejects.toThrow(/expected version|stale/);
      expect(adapter.packets).toHaveLength(0);
      expect(competing.inspect("pod-1")?.lifecycle).toBe("cancel_requested");
      expect(inner.readStream("pod-1").slice(-2).map((event) => event.type)).toEqual([
        "pod.reconciliation_required", "pod.reconciliation_resolved",
      ]);
      expect(inner.readStream("pod-1").some((event) => event.type === "pod.assignment_invocation_started" &&
        (event.payload as { assignmentId?: string }).assignmentId === "assignment-1")).toBe(false);
    } finally {
      inner.close();
    }
  });

  it("reconciles append-then-throw of the atomic reservation as known no-effect", async () => {
    const inner = new SqliteEventJournal(":memory:");
    const registry = new PodRegistry(inner);
    registry.register({ charter: charter(), correlationId: "trace-1" });
    registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
    registry.start("pod-1");
    seedResearch(registry);
    registry.receiveLease("pod-1", lease());
    registry.receiveWorkspaceLease("pod-1", workspaceLease());
    let crashed = false;
    const journal: EventJournal = {
      readStream: (...args) => inner.readStream(...args), readAll: (...args) => inner.readAll(...args),
      append: (streamId, expectedVersion, events) => {
        const stored = inner.append(streamId, expectedVersion, events);
        if (!crashed && events.map((event) => event.type).join(",") ===
          "pod.assignment_invocation_started,pod.execution_reserved") {
          crashed = true;
          throw new Error("simulated append acknowledgement loss");
        }
        return stored;
      },
    };
    const adapter = new RecordingPodDispatchAdapter();
    const coordinator = new PodCoordinator(new PodRegistry(journal), adapter, now, undefined, authoritativeMeter());
    try {
      const proposal = coordinator.propose({ podId: "pod-1", grant: grant(), lease: lease(), assignment: {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
      } });
      await expect(coordinator.dispatch({ proposal, signal: new AbortController().signal })).rejects.toThrow(/acknowledgement loss/);
      expect(adapter.packets).toHaveLength(0);
      expect(new PodRegistry(inner).inspect("pod-1")).toMatchObject({ reconciliationRequired: false,
        assignments: { "assignment-1": { status: "failed", executionId: expect.any(String), processId: null } } });
      expect(inner.readStream("pod-1").slice(-4).map((event) => event.type)).toEqual([
        "pod.assignment_invocation_started", "pod.execution_reserved", "pod.reconciliation_required", "pod.reconciliation_resolved",
      ]);
    } finally { inner.close(); }
  });

  it("rechecks an external abort after invocation journal writes and records no-effect", async () => {
    const inner = new SqliteEventJournal(":memory:");
    const registry = new PodRegistry(inner);
    registry.register({ charter: charter(), correlationId: "trace-1" });
    registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
    registry.start("pod-1");
    seedResearch(registry);
    registry.receiveLease("pod-1", lease());
    registry.receiveWorkspaceLease("pod-1", workspaceLease());
    const external = new AbortController();
    const racing: EventJournal = {
      readStream: (...args) => inner.readStream(...args), readAll: (...args) => inner.readAll(...args),
      append: (streamId, expectedVersion, events) => {
        const stored = inner.append(streamId, expectedVersion, events);
        if (events[0]?.type === "pod.assignment_invocation_started") external.abort(new Error("operator cancelled"));
        return stored;
      },
    };
    const adapter = new RecordingPodDispatchAdapter();
    const coordinator = new PodCoordinator(new PodRegistry(racing), adapter, now, undefined, authoritativeMeter());
    try {
      const proposal = coordinator.propose({ podId: "pod-1", grant: grant(), lease: lease(), assignment: {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: lease().budget,
      } });
      await expect(coordinator.dispatch({ proposal, signal: external.signal })).rejects.toThrow(/cancelled/);
      expect(adapter.packets).toHaveLength(0);
      expect(inner.readStream("pod-1").slice(-2).map((event) => event.type)).toEqual([
        "pod.reconciliation_required", "pod.reconciliation_resolved",
      ]);
    } finally { inner.close(); }
  });

  it("property-checks generated budget and ownership expansions never reach dispatch", () => {
    for (let excess = 1; excess <= 32; excess += 1) {
      const { journal, coordinator, adapter } = setup();
      try {
        expect(() => coordinator.propose({
          podId: "pod-1", grant: grant(), lease: lease(), assignment: {
            assignmentId: `assignment-${excess}`, taskId: "implement", roleId: "implementer", agentId: "agent-write",
            charterRevision: 1, capabilities: ["write_worktree"],
            ownedPaths: excess % 2 === 0 ? ["src/pods/**"] : [`outside-${excess}/**`],
            budget: { ...lease().budget, maxSeconds: lease().budget.maxSeconds + excess },
          },
        })).toThrow();
        expect(adapter.packets).toHaveLength(0);
      } finally {
        journal.close();
      }
    }
  });
});
