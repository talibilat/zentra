import { describe, expect, it, vi } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import {
  JournalScheduler,
  dispatchIntentSha256,
  type SchedulerTaskInput,
} from "../../src/scheduling/journal-scheduler.js";
import { schedulerStreamId } from "../../src/scheduling/scheduler-contracts.js";
import { DispatchGrantService } from "../../src/scheduling/dispatch-grant-service.js";
import { DaemonScheduler, type DispatchExecution } from "../../src/scheduling/daemon-scheduler.js";
import { projectSchedulerDiagnostic } from "../../src/observability/scheduler-diagnostics.js";
import { projectGlobalControl } from "../../src/scheduling/global-control.js";
import { schedulerControlStreamId } from "../../src/scheduling/scheduler-contracts.js";
import { daemonLeaseStreamId, projectDaemonLease } from "../../src/leases/daemon-lease.js";
import { leaseStreamId, projectLease } from "../../src/leases/lease-projection.js";

class FakeClock {
  constructor(public value = Date.parse("2026-07-20T00:00:00.000Z")) {}
  now = (): number => this.value;
  advance(milliseconds: number): void { this.value += milliseconds; }
}

const limits = {
  resources: { reasoning: 2, writers: 1, heavyValidation: 1, review: 1, integration: 1 },
  budget: { seconds: 1_000, inputTokens: 10_000, outputTokens: 10_000, costUsdNano: 1_000_000_000 },
} as const;
const controlIdentity = { controlPlaneId: "zentra", repositoryIdentity: "/tmp/repository" } as const;

function task(taskId: string, projectId = "project-a", overrides: Partial<SchedulerTaskInput> = {}): SchedulerTaskInput {
  const base = {
    taskId,
    projectId,
    workerId: `worker-${taskId}`,
    effect: "computation" as const,
    requiredCapabilities: ["write_worktree"],
    platform: "darwin-arm64" as const,
    workspace: { path: `/tmp/worktrees/${taskId}`, available: true },
    admission: {
      dependencies: [] as { taskId: string; state: "completed" | "contract_stable" | "blocked" }[],
      decisionsApproved: true,
      pathsAvailable: true,
      capabilitySupported: true,
      platformSupported: true,
      policyPermits: true,
      budgetAvailable: true,
      workspaceValid: true,
      acceptanceCriteria: ["requested outcome is present"],
      evidenceRequirements: ["retained result"],
    },
    resources: { reasoning: 1, writers: 1, heavyValidation: 0, review: 0, integration: 0 },
    budget: { seconds: 10, inputTokens: 100, outputTokens: 100, costUsdNano: 1_000 },
  };
  const unsigned = { ...base, ...overrides };
  return {
    ...unsigned,
    grantId: overrides.grantId ?? `grant-${taskId}`,
  };
}

function scheduler(journal: SqliteEventJournal, clock: FakeClock, incarnation = "daemon-1") {
  const grants = new DispatchGrantService(journal, controlIdentity, "policy-plane", clock.now);
  const service = new JournalScheduler(journal, {
    schedulerId: "installed",
    processIncarnation: incarnation,
    pid: 123,
    processStartIdentity: `start-${incarnation}`,
    platform: "darwin-arm64",
    capabilities: ["write_worktree", "review_diff", "run_validation", "integrate"],
    limits,
    controlIdentity,
    grants,
    now: clock.now,
  });
  return Object.assign(service, { grantIssuer: grants, testNow: clock.now });
}
function submit(service: ReturnType<typeof scheduler>, input: SchedulerTaskInput): void {
  service.grantIssuer.issue({ grantId: input.grantId, audience: input.workerId,
    dispatchIntentSha256: dispatchIntentSha256(input), expiresAtMs: service.testNow() + 60 * 60_000 });
  service.submit(input);
}

describe("JournalScheduler", () => {
  it("projects every failed admission gate as a stable blocked reason", () => {
    const journal = new SqliteEventJournal(":memory:");
    const clock = new FakeClock();
    const service = scheduler(journal, clock);
    service.start();
    submit(service, task("blocked", "project-a", {
      admission: {
        dependencies: [{ taskId: "dependency", state: "blocked" }],
        decisionsApproved: false,
        pathsAvailable: false,
        capabilitySupported: false,
        platformSupported: false,
        policyPermits: false,
        budgetAvailable: false,
        workspaceValid: false,
        acceptanceCriteria: [],
        evidenceRequirements: [],
      },
    }));

    expect(service.tick()).toEqual([]);
    expect(service.inspect().tasks["blocked"]).toMatchObject({
      status: "blocked",
      blockedReasons: [
        "dependencies", "decisions", "paths", "capability", "platform", "policy",
        "budget", "workspace", "acceptance", "evidence",
      ],
    });
    expect(journal.readStream(schedulerStreamId("installed")).at(-1)?.type).toBe("scheduler.task_blocked");
    journal.close();
  });

  it("dispatches fairly across projects without exceeding resources or the integration slot", () => {
    const journal = new SqliteEventJournal(":memory:");
    const clock = new FakeClock();
    const service = scheduler(journal, clock);
    service.start();
    submit(service, task("a-1"));
    submit(service, task("a-2"));
    submit(service, task("b-1", "project-b"));
    submit(service, task("integration-a", "project-a", {
      resources: { reasoning: 0, writers: 0, heavyValidation: 0, review: 0, integration: 1 },
      requiredCapabilities: ["integrate"],
    }));
    submit(service, task("integration-b", "project-b", {
      resources: { reasoning: 0, writers: 0, heavyValidation: 0, review: 0, integration: 1 },
      requiredCapabilities: ["integrate"],
    }));

    const first = service.tick();
    expect(first.map((intent) => intent.taskId)).toEqual(["a-1", "integration-b"]);
    expect(service.inspect().usage.resources).toEqual({
      reasoning: 1, writers: 1, heavyValidation: 0, review: 0, integration: 1,
    });
    service.started(first[0]!.dispatchId, 201, "worker-incarnation-a1", "worker-start-a1");
    service.complete(first[0]!.dispatchId, "completed");
    const second = service.tick();
    expect(second.map((intent) => intent.taskId)).toEqual(["b-1"]);
    expect(service.inspect().tasks["a-2"]?.status).toBe("ready");
    expect(service.inspect().tasks["integration-a"]?.status).toBe("ready");
    expect(service.inspect().usage.resources.integration).toBe(1);
    journal.close();
  });

  it("consumes an exact, unexpired, single-use grant with the resource reservation", () => {
    const journal = new SqliteEventJournal(":memory:");
    const clock = new FakeClock();
    const service = scheduler(journal, clock);
    service.start();
    const mismatched = task("mismatch");
    service.grantIssuer.issue({ grantId: mismatched.grantId, audience: mismatched.workerId,
      dispatchIntentSha256: dispatchIntentSha256(mismatched), expiresAtMs: clock.now() + 60_000 });
    service.submit({ ...mismatched, resources: { ...mismatched.resources, review: 1 } });
    expect(service.tick()).toEqual([]);
    expect(service.inspect().tasks["mismatch"]?.blockedReasons).toEqual(["grant"]);

    service.submit(task("reuse", "project-b", { grantId: mismatched.grantId }));
    expect(service.tick()).toEqual([]);
    expect(service.inspect().tasks["reuse"]?.blockedReasons).toEqual(["grant"]);
    journal.close();
  });

  it("cannot dispatch a caller-self-asserted grant reference that was never independently issued", () => {
    const journal = new SqliteEventJournal(":memory:");
    const service = scheduler(journal, new FakeClock());
    service.start();
    service.submit(task("unissued"));
    expect(service.tick()).toEqual([]);
    expect(service.inspect().tasks.unissued?.blockedReasons).toEqual(["grant"]);
    expect(journal.readAll().some((event) => event.type === "dispatch_grant.issued")).toBe(false);
    journal.close();
  });

  it("atomically consumes a grant once using trusted time and its exact issued expiry", () => {
    const journal = new SqliteEventJournal(":memory:");
    const clock = new FakeClock();
    const grants = new DispatchGrantService(journal, controlIdentity, "policy-plane", clock.now);
    const scheduled = task("grant-race");
    const expiresAtMs = clock.now() + 10;
    grants.issue({ grantId: scheduled.grantId, audience: scheduled.workerId,
      dispatchIntentSha256: dispatchIntentSha256(scheduled), expiresAtMs });
    clock.advance(9);
    const first = grants.consumptionWrite(scheduled.grantId, { grantId: scheduled.grantId,
      dispatchId: "00000000-0000-4000-8000-000000000001", schedulerId: "a",
      processIncarnation: "inc-a", dispatchIntentSha256: dispatchIntentSha256(scheduled) });
    const second = grants.consumptionWrite(scheduled.grantId, { grantId: scheduled.grantId,
      dispatchId: "00000000-0000-4000-8000-000000000002", schedulerId: "b",
      processIncarnation: "inc-b", dispatchIntentSha256: dispatchIntentSha256(scheduled) });
    journal.appendAtomically([first]);
    expect(() => journal.appendAtomically([second])).toThrow(/expected version/i);
    const consumed = journal.readStream(first.streamId).at(-1)!.payload as { consumedAtMs: number; expiresAtMs: number };
    expect(consumed).toEqual(expect.objectContaining({ consumedAtMs: expiresAtMs - 1, expiresAtMs }));
    const expired = task("expired-grant");
    grants.issue({ grantId: expired.grantId, audience: expired.workerId,
      dispatchIntentSha256: dispatchIntentSha256(expired), expiresAtMs: clock.now() + 1 });
    clock.advance(1);
    expect(() => grants.consumptionWrite(expired.grantId, { grantId: expired.grantId,
      dispatchId: "00000000-0000-4000-8000-000000000003", schedulerId: "c",
      processIncarnation: "inc-c", dispatchIntentSha256: dispatchIntentSha256(expired) })).toThrow(/expired/i);
    journal.close();
  });

  it("rejects a zero-second task before any executor can spawn", () => {
    const journal = new SqliteEventJournal(":memory:");
    const service = scheduler(journal, new FakeClock()); service.start();
    expect(() => submit(service, task("zero", "project-a", {
      budget: { seconds: 0, inputTokens: 1, outputTokens: 1, costUsdNano: 1 },
    }))).toThrow(/seconds budget must be positive/i);
    expect(service.inspect().tasks.zero).toBeUndefined();
    journal.close();
  });

  it("shares capacity and single-use grants across alternate scheduler IDs", () => {
    const journal = new SqliteEventJournal(":memory:");
    const clock = new FakeClock();
    const first = scheduler(journal, clock, "daemon-1");
    first.start(); submit(first, task("shared"));
    expect(first.tick()).toHaveLength(1);
    first.stop();
    const grants = new DispatchGrantService(journal, controlIdentity, "policy-plane", clock.now);
    const alternate = new JournalScheduler(journal, { schedulerId: "alternate", processIncarnation: "daemon-2",
      pid: 456, processStartIdentity: "start-daemon-2", platform: "darwin-arm64", capabilities: ["write_worktree"], limits,
      controlIdentity, grants, now: clock.now });
    alternate.start();
    alternate.submit(task("shared", "project-b", { grantId: "grant-shared" }));
    expect(alternate.tick()).toEqual([]);
    expect(alternate.inspect().tasks.shared?.blockedReasons).toEqual(["grant"]);
    journal.close();
  });

  it("records backpressure and enforces the global budget reservation", () => {
    const journal = new SqliteEventJournal(":memory:");
    const clock = new FakeClock();
    const service = scheduler(journal, clock);
    service.start();
    submit(service, task("large", "project-a", {
      resources: { reasoning: 1, writers: 0, heavyValidation: 0, review: 0, integration: 0 },
      budget: { seconds: 900, inputTokens: 9_900, outputTokens: 9_900, costUsdNano: 900_000_000 },
    }));
    submit(service, task("waiting", "project-b", {
      resources: { reasoning: 1, writers: 0, heavyValidation: 0, review: 0, integration: 0 },
      budget: { seconds: 200, inputTokens: 200, outputTokens: 200, costUsdNano: 200_000_000 },
    }));
    expect(service.tick().map((intent) => intent.taskId)).toEqual(["large"]);
    expect(service.inspect().tasks["waiting"]).toMatchObject({ status: "ready", backpressure: "budget" });
    journal.close();
  });

  it("governs heavy validation and review independently at global capacity", () => {
    const journal = new SqliteEventJournal(":memory:");
    const clock = new FakeClock();
    const service = scheduler(journal, clock);
    service.start();
    submit(service, task("validation-a", "project-a", { requiredCapabilities: ["run_validation"],
      resources: { reasoning: 0, writers: 0, heavyValidation: 1, review: 0, integration: 0 } }));
    submit(service, task("validation-b", "project-b", { requiredCapabilities: ["run_validation"],
      resources: { reasoning: 0, writers: 0, heavyValidation: 1, review: 0, integration: 0 } }));
    submit(service, task("review-a", "project-a", { requiredCapabilities: ["review_diff"],
      resources: { reasoning: 0, writers: 0, heavyValidation: 0, review: 1, integration: 0 } }));
    submit(service, task("review-b", "project-b", { requiredCapabilities: ["review_diff"],
      resources: { reasoning: 0, writers: 0, heavyValidation: 0, review: 1, integration: 0 } }));
    const intents = service.tick();
    expect(intents.filter((intent) => intent.resources.heavyValidation === 1)).toHaveLength(1);
    expect(intents.filter((intent) => intent.resources.review === 1)).toHaveLength(1);
    expect(service.inspect().usage.resources).toMatchObject({ heavyValidation: 1, review: 1 });
    journal.close();
  });

  it("processes cancellation before any new dispatch", () => {
    const journal = new SqliteEventJournal(":memory:");
    const clock = new FakeClock();
    const service = scheduler(journal, clock);
    service.start();
    submit(service, task("active"));
    submit(service, task("next", "project-b"));
    const active = service.tick()[0]!;
    service.started(active.dispatchId, 201, "worker-active", "worker-start-active");
    service.cancel("active", "operator_requested");

    expect(service.tick()).toEqual([]);
    expect(service.inspect().tasks["active"]?.status).toBe("cancelling");
    expect(service.inspect().tasks["next"]?.status).toBe("ready");
    service.complete(active.dispatchId, "cancelled");
    expect(service.tick().map((intent) => intent.taskId)).toEqual(["next"]);
    journal.close();
  });

  it("enforces usage budgets and retains exact used and unused release evidence", () => {
    const journal = new SqliteEventJournal(":memory:");
    const service = scheduler(journal, new FakeClock()); service.start(); submit(service, task("usage"));
    const intent = service.tick()[0]!; service.started(intent.dispatchId, 10, "worker-usage", "worker-start-usage");
    expect(() => service.recordUsage(intent.dispatchId,
      { seconds: 0, inputTokens: 101, outputTokens: 0, costUsdNano: 0 })).toThrow(/dispatch budget/i);
    expect(() => service.recordUsage(intent.dispatchId,
      { seconds: 0, inputTokens: 0, outputTokens: 0, costUsdNano: 1_001 })).toThrow(/dispatch budget/i);
    service.recordUsage(intent.dispatchId, { seconds: 1, inputTokens: 40, outputTokens: 10, costUsdNano: 400 });
    service.complete(intent.dispatchId, "completed");
    const release = journal.readStream("scheduler:installed").findLast((event) => event.type === "scheduler.budget_released");
    expect(release?.payload).toMatchObject({ usedBudget: { seconds: 1, inputTokens: 40,
      outputTokens: 10, costUsdNano: 400 }, unusedBudget: { seconds: 9, inputTokens: 60,
      outputTokens: 90, costUsdNano: 600 } });
    journal.close();
  });

  it("heartbeats after the 60-second interval with positive jitter and a safe expiry margin", async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    vi.setSystemTime(clock.value);
    const journal = new SqliteEventJournal(":memory:");
    const service = scheduler(journal, clock); service.start(); submit(service, task("heartbeat", "project-a", {
      budget: { seconds: 120, inputTokens: 100, outputTokens: 100, costUsdNano: 1_000 },
    }));
    let settle!: (value: Awaited<DispatchExecution["completion"]>) => void;
    const completion = new Promise<Awaited<DispatchExecution["completion"]>>((resolve) => { settle = resolve; });
    const daemon = new DaemonScheduler(service, { start: async () => ({ pid: 77,
      workerIncarnation: "worker-heartbeat", processStartIdentity: "worker-start-heartbeat",
      completion, cancel: () => settle({ outcome: "cancelled",
        usage: { seconds: 0, inputTokens: 0, outputTokens: 0, costUsdNano: 0 } }) }) },
    { heartbeatJitterMs: () => 5_000 });
    await daemon.runOnce();
    for (let elapsed = 0; elapsed < 65_000; elapsed += 5_000) {
      clock.advance(5_000); await vi.advanceTimersByTimeAsync(5_000);
    }
    clock.advance(1); await vi.advanceTimersByTimeAsync(1);
    const heartbeats = journal.readAll().filter((event) => event.type === "scheduler.worker_heartbeat");
    expect(heartbeats).toHaveLength(2);
    const lease = journal.readStream(`lease:${service.inspect().tasks.heartbeat!.dispatch!.workerLeaseId}`);
    const renewed = lease.findLast((event) => event.type === "lease.renewed")!.payload as { expiresAtMs: number };
    expect(renewed.expiresAtMs - clock.value).toBeGreaterThan(60_000);
    service.cancel("heartbeat", "test complete"); await daemon.runOnce(); await daemon.awaitIdle(); await daemon.shutdown();
    vi.useRealTimers(); journal.close();
  });

  it("cancels and settles a process that starts after cancellation was requested", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const service = scheduler(journal, new FakeClock()); service.start(); submit(service, task("late"));
    let resolveStart!: (execution: DispatchExecution) => void;
    const starting = new Promise<DispatchExecution>((resolve) => { resolveStart = resolve; });
    let settle!: (value: Awaited<DispatchExecution["completion"]>) => void;
    let cancelled = false;
    const daemon = new DaemonScheduler(service, { start: () => starting });
    const run = daemon.runOnce();
    await Promise.resolve();
    service.cancel("late", "cancelled during process startup");
    const completion = new Promise<Awaited<DispatchExecution["completion"]>>((resolve) => { settle = resolve; });
    resolveStart({ pid: 88, workerIncarnation: "worker-late", processStartIdentity: "worker-start-late",
      completion, cancel: () => {
      cancelled = true; settle({ outcome: "cancelled", usage: { seconds: 0, inputTokens: 0,
        outputTokens: 0, costUsdNano: 0 } });
    } });
    await run;
    await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(service.inspect().tasks.late).toMatchObject({ cancellationSignalled: true, terminalOutcome: "cancelled" });
    await daemon.shutdown();
    journal.close();
  });

  it("arms the deadline before executor startup and cancels a late start without an effect", async () => {
    vi.useFakeTimers();
    const clock = new FakeClock(); vi.setSystemTime(clock.value);
    const journal = new SqliteEventJournal(":memory:");
    const service = scheduler(journal, clock); service.start(); submit(service, task("expired-start", "project-a", {
      budget: { seconds: 1, inputTokens: 1, outputTokens: 1, costUsdNano: 1 },
    }));
    let resolveStart!: (execution: DispatchExecution) => void;
    let observedSignal: AbortSignal | null = null;
    let effect = false;
    const starting = new Promise<DispatchExecution>((resolve) => { resolveStart = resolve; });
    const daemon = new DaemonScheduler(service, { start: (_intent, signal) => {
      observedSignal = signal; return starting;
    } });
    const running = daemon.runOnce(); await Promise.resolve();
    clock.advance(1_001); await vi.advanceTimersByTimeAsync(1_001);
    expect((observedSignal as unknown as AbortSignal).aborted).toBe(true);
    let settle!: (value: Awaited<DispatchExecution["completion"]>) => void;
    const completion = new Promise<Awaited<DispatchExecution["completion"]>>((resolve) => { settle = resolve; });
    resolveStart({ pid: 91, workerIncarnation: "worker-expired", processStartIdentity: "worker-start-expired",
      completion, cancel: () => settle({ outcome: "cancelled", usage: { seconds: 0,
        inputTokens: 0, outputTokens: 0, costUsdNano: 0 } }) });
    await running; await daemon.awaitIdle();
    expect(effect).toBe(false);
    expect(service.inspect().tasks["expired-start"]?.terminalOutcome).toBe("timed_out");
    await daemon.shutdown(); vi.useRealTimers(); journal.close();
  });

  it("cancels a worker before accepting token or cost overspend", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const service = scheduler(journal, new FakeClock()); service.start(); submit(service, task("overspend"));
    let settle!: (value: Awaited<DispatchExecution["completion"]>) => void;
    const completion = new Promise<Awaited<DispatchExecution["completion"]>>((resolve) => { settle = resolve; });
    async function* usage() {
      yield { seconds: 0, inputTokens: 101, outputTokens: 0, costUsdNano: 0 };
    }
    const daemon = new DaemonScheduler(service, { start: async () => ({ pid: 99,
      workerIncarnation: "worker-overspend", processStartIdentity: "worker-start-overspend",
      completion, usage: usage(), cancel: () => settle({ outcome: "cancelled",
        usage: { seconds: 0, inputTokens: 0, outputTokens: 0, costUsdNano: 0 } }) }) });
    await daemon.runOnce(); await daemon.awaitIdle();
    expect(service.inspect().tasks.overspend).toMatchObject({ terminalOutcome: "failed",
      usedBudget: { seconds: 0, inputTokens: 0, outputTokens: 0, costUsdNano: 0 } });
    expect(journal.readAll().filter((event) => event.type === "scheduler.usage_recorded")).toHaveLength(0);
    await daemon.shutdown();
    journal.close();
  });

  it("diagnoses global allocations, daemon fencing, deadlines, and worker incarnations", () => {
    const journal = new SqliteEventJournal(":memory:");
    const service = scheduler(journal, new FakeClock()); service.start(); submit(service, task("diagnostic"));
    const intent = service.tick()[0]!; service.started(intent.dispatchId, 321, "worker-diagnostic", "worker-start-diagnostic");
    service.heartbeat(intent.dispatchId, "worker-diagnostic");
    service.cancel("diagnostic", "operator requested"); service.tick();
    const leases = Object.fromEntries([intent.taskLeaseId, intent.workerLeaseId].map((leaseId) =>
      [leaseId, projectLease(journal.readStream(leaseStreamId(leaseId)))!]));
    const diagnostic = projectSchedulerDiagnostic(service.inspect(), {
      control: projectGlobalControl(journal.readStream(schedulerControlStreamId(controlIdentity))),
      daemonLease: projectDaemonLease(journal.readStream(daemonLeaseStreamId(controlIdentity))),
      leases, nowMs: new FakeClock().value + 5_000,
    });
    expect(diagnostic).toMatchObject({ globalAllocationCount: 1,
      daemonLease: { processIncarnation: "daemon-1", pid: 123, status: "active" },
      workers: [{ taskId: "diagnostic", workerIncarnation: "worker-diagnostic", pid: 321,
        deadlineAtMs: intent.deadlineAtMs, status: "cancelling", queueWaitMs: 0,
        cancellation: { requested: true, acknowledged: true, reason: "operator requested" },
        taskLease: { leaseId: intent.taskLeaseId, schedulerId: "installed", expiresAtMs: expect.any(Number),
          heartbeatAgeMs: 5_000 }, workerLease: { leaseId: intent.workerLeaseId,
          workerIncarnation: "worker-diagnostic", heartbeatAgeMs: 5_000 } }] });
    service.reconcileUncertainDispatch(intent.dispatchId, "worker process identity changed", "dirty");
    expect(projectSchedulerDiagnostic(service.inspect()).workers[0]?.reconciliationReason)
      .toBe("worker process identity changed");
    journal.close();
  });
});
