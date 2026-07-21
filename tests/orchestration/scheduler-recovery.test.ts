import { describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { JournalScheduler, dispatchIntentSha256, type SchedulerTaskInput } from "../../src/scheduling/journal-scheduler.js";
import { DispatchGrantService } from "../../src/scheduling/dispatch-grant-service.js";

const controlIdentity = { controlPlaneId: "zentra", repositoryIdentity: "/tmp/recovery-repository" } as const;
const baseTime = Date.parse("2026-07-20T00:00:00.000Z");
const configuration = (journal: SqliteEventJournal, incarnation: string) => {
  const now = () => baseTime + (incarnation === "daemon-1" ? 0 : 31_000);
  return ({
  schedulerId: "installed", processIncarnation: incarnation, pid: incarnation === "daemon-1" ? 101 : 202,
  processStartIdentity: `start-${incarnation}`,
  platform: "darwin-arm64" as const, capabilities: ["write_worktree"], now,
  controlIdentity, grants: new DispatchGrantService(journal, controlIdentity, "policy-plane", now),
  daemonOwnerLiveness: () => "dead" as const,
  limits: {
    resources: { reasoning: 1, writers: 1, heavyValidation: 1, review: 1, integration: 1 },
    budget: { seconds: 100, inputTokens: 1_000, outputTokens: 1_000, costUsdNano: 1_000_000 },
  },
  });
};

function input(): SchedulerTaskInput {
  const unsigned = {
    taskId: "effect", projectId: "project-a", workerId: "worker-effect", effect: "potentially_effectful" as const,
    requiredCapabilities: ["write_worktree"], platform: "darwin-arm64" as const,
    workspace: { path: "/tmp/worktrees/effect", available: true },
    admission: { dependencies: [], decisionsApproved: true, pathsAvailable: true, capabilitySupported: true,
      platformSupported: true, policyPermits: true, budgetAvailable: true, workspaceValid: true,
      acceptanceCriteria: ["effect observed"], evidenceRequirements: ["receipt"] },
    resources: { reasoning: 1, writers: 1, heavyValidation: 0, review: 0, integration: 0 },
    budget: { seconds: 10, inputTokens: 10, outputTokens: 10, costUsdNano: 100 },
  };
  return { ...unsigned, grantId: `grant-${unsigned.taskId}` };
}
function authorize(journal: SqliteEventJournal, scheduled: SchedulerTaskInput, expiresAtMs = baseTime + 60 * 60_000): void {
  new DispatchGrantService(journal, controlIdentity, "policy-plane", () => baseTime).issue({
    grantId: scheduled.grantId, audience: scheduled.workerId,
    dispatchIntentSha256: dispatchIntentSha256(scheduled), expiresAtMs,
  });
}

describe("scheduler restart recovery", () => {
  it("never redispatches an intended effect and fails a stale process incarnation into reconciliation", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const crashed = new JournalScheduler(journal, configuration(journal, "daemon-1"));
    crashed.start();
    authorize(journal, input()); crashed.submit(input());
    const intended = crashed.tick()[0]!;

    const restarted = new JournalScheduler(journal, configuration(journal, "daemon-2"));
    await restarted.recover(async (candidate) => ({
      taskId: candidate.taskId,
      workerAlive: false,
      workspace: "dirty",
      effect: "uncertain",
      reason: "worker exited after an unobserved write",
    }));
    expect(restarted.tick()).toEqual([]);
    expect(restarted.inspect().tasks["effect"]).toMatchObject({
      status: "reconciling", blockedReasons: ["uncertain_effect"],
    });
    expect(() => restarted.started(intended.dispatchId, 303, "late-worker", "late-worker-start")).toThrow(/stale process incarnation/i);
    expect(journal.readStream("scheduler:installed").filter((event) => event.type === "scheduler.dispatch_intended")).toHaveLength(1);
    journal.close();
  });

  it("reconciles a definitely absent computation as failed and releases capacity without retry", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const first = new JournalScheduler(journal, configuration(journal, "daemon-1"));
    first.start();
    const compute = { ...input(), taskId: "compute", grantId: "grant-compute", effect: "computation" as const };
    authorize(journal, compute); first.submit(compute);
    first.tick();
    const second = new JournalScheduler(journal, configuration(journal, "daemon-2"));
    await second.recover(async (candidate) => ({ taskId: candidate.taskId, workerAlive: false,
      workspace: "valid", effect: "none", reason: "process did not start" }));
    expect(second.inspect().tasks["compute"]?.terminalOutcome).toBe("failed");
    expect(second.inspect().usage.resources.writers).toBe(0);
    expect(second.tick()).toEqual([]);
    journal.close();
  });

  it("retains capacity while a stale worker is still alive", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const first = new JournalScheduler(journal, configuration(journal, "daemon-1"));
    first.start(); authorize(journal, input()); first.submit(input()); first.tick();
    const second = new JournalScheduler(journal, configuration(journal, "daemon-2"));
    await second.recover(async (candidate) => ({ taskId: candidate.taskId, workerAlive: true,
      workspace: "dirty", effect: "uncertain", reason: "stale worker still has a live pid" }));
    expect(second.inspect().tasks.effect?.status).toBe("reconciling");
    expect(second.inspect().usage.resources.writers).toBe(1);
    const dispatchId = second.inspect().tasks.effect!.dispatch!.dispatchId;
    second.resolveReconciliation(dispatchId, "failed", "operator confirmed the stale worker exited");
    expect(second.inspect().usage.resources.writers).toBe(0);
    journal.close();
  });

  it("refuses takeover when OS evidence says the daemon owner is still healthy", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const first = new JournalScheduler(journal, configuration(journal, "daemon-1")); first.start();
    const healthy = { ...configuration(journal, "daemon-2"), daemonOwnerLiveness: () => "alive" as const };
    const second = new JournalScheduler(journal, healthy);
    await expect(second.recover(async (candidate) => ({ taskId: candidate.taskId, workerAlive: false,
      workspace: "missing", effect: "none", reason: "unused" }))).rejects.toThrow(/healthy or unverified/i);
    expect(first.inspect().activeIncarnations).toEqual(["daemon-1"]);
    journal.close();
  });

  it("takes over and releases worker capacity when reused PIDs have different start identities", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const firstOptions = { ...configuration(journal, "daemon-1"), pid: 777,
      processStartIdentity: "darwin-ps-v1:old" };
    const first = new JournalScheduler(journal, firstOptions); first.start(); authorize(journal, input());
    first.submit(input()); const dispatch = first.tick()[0]!;
    first.started(dispatch.dispatchId, 888, "worker-old", "darwin-ps-v1:worker-old");
    const secondOptions = { ...configuration(journal, "daemon-2"), pid: 777,
      processStartIdentity: "darwin-ps-v1:new",
      daemonOwnerLiveness: (owner: { processStartIdentity: string }) =>
        owner.processStartIdentity === "darwin-ps-v1:old" ? "dead" as const : "alive" as const };
    const second = new JournalScheduler(journal, secondOptions);
    await second.recover(async (candidate) => {
      expect(candidate).toMatchObject({ workerPid: 888, workerIncarnation: "worker-old",
        workerProcessStartIdentity: "darwin-ps-v1:worker-old" });
      return { taskId: candidate.taskId, workerAlive: false, workspace: "valid" as const,
        effect: "none" as const, reason: "PID start identity changed" };
    });
    expect(second.inspect().tasks.effect?.terminalOutcome).toBe("failed");
    expect(second.inspect().usage.resources.writers).toBe(0);
    journal.close();
  });
});
