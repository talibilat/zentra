import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { DaemonScheduler, InstalledProcessExecutor } from "../../src/scheduling/daemon-scheduler.js";
import { JournalScheduler, dispatchIntentSha256, type SchedulerTaskInput } from "../../src/scheduling/journal-scheduler.js";
import { DispatchGrantService } from "../../src/scheduling/dispatch-grant-service.js";
import { projectGlobalControl } from "../../src/scheduling/global-control.js";
import { schedulerControlStreamId } from "../../src/scheduling/scheduler-contracts.js";

const fixture = fileURLToPath(new URL("./fixtures/scheduled-worker.mjs", import.meta.url));
const roots: string[] = [];
const controlIdentity = { controlPlaneId: "zentra", repositoryIdentity: "/tmp/e2e-repository" } as const;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function input(taskId: string, projectId: string, workspace: string,
  resource: "writer" | "integration" = "writer"): SchedulerTaskInput {
  const unsigned = {
    taskId, projectId, workerId: `worker-${taskId}`, effect: "potentially_effectful" as const,
    requiredCapabilities: [resource === "writer" ? "write_worktree" : "integrate"],
    platform: "darwin-arm64" as const, workspace: { path: workspace, available: true },
    admission: { dependencies: [], decisionsApproved: true, pathsAvailable: true,
      capabilitySupported: true, platformSupported: true, policyPermits: true,
      budgetAvailable: true, workspaceValid: true, acceptanceCriteria: ["marker retained"],
      evidenceRequirements: ["worker exit"] },
    resources: resource === "writer"
      ? { reasoning: 1, writers: 1, heavyValidation: 0, review: 0, integration: 0 }
      : { reasoning: 0, writers: 0, heavyValidation: 0, review: 0, integration: 1 },
    budget: { seconds: 10, inputTokens: 10, outputTokens: 10, costUsdNano: 10 },
  };
  return { ...unsigned, grantId: `grant-${taskId}` };
}

describe("installed daemon scheduler multiprocess", () => {
  it("runs fair bounded waves in real processes with one integration slot and minimal environments", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-scheduler-e2e-"));
    roots.push(root);
    const marker = path.join(root, "effects.jsonl");
    const journal = new SqliteEventJournal(path.join(root, "journal.sqlite"));
    const grants = new DispatchGrantService(journal, controlIdentity, "policy-plane");
    const durable = new JournalScheduler(journal, options(grants));
    durable.start();
    const commands: Record<string, { executable: string; args: string[]; cwd: string }> = {};
    for (const [taskId, project, resource] of [
      ["a-writer", "project-a", "writer"], ["a-next", "project-a", "writer"],
      ["b-writer", "project-b", "writer"], ["a-integrate", "project-a", "integration"],
      ["b-integrate", "project-b", "integration"],
    ] as const) {
      const workspace = path.join(root, taskId);
      mkdirSync(workspace);
      const scheduled = input(taskId, project, workspace, resource);
      grants.issue({ grantId: scheduled.grantId, audience: scheduled.workerId,
        dispatchIntentSha256: dispatchIntentSha256(scheduled), expiresAtMs: Date.now() + 60 * 60_000 });
      durable.submit(scheduled);
      commands[taskId] = { executable: process.execPath, args: [fixture, marker, taskId, "delay"], cwd: workspace };
    }
    process.env.ZENTRA_SECRET_CANARY = "must-not-cross";
    try {
      const daemon = new DaemonScheduler(durable, new InstalledProcessExecutor(commands));
      const first = await daemon.runOnce();
      expect(first.map((intent) => intent.taskId)).toEqual(["a-writer", "b-integrate"]);
      expect(durable.inspect().usage.resources).toMatchObject({ writers: 1, integration: 1 });
      await daemon.awaitIdle();
      const second = await daemon.runOnce();
      expect(second.map((intent) => intent.taskId)).toEqual(["b-writer", "a-integrate"]);
      await daemon.awaitIdle();
      const third = await daemon.runOnce();
      expect(third.map((intent) => intent.taskId)).toEqual(["a-next"]);
      await daemon.awaitIdle();
      const effects = readFileSync(marker, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(new Set(effects.map((effect) => effect.pid)).size).toBeGreaterThanOrEqual(2);
      expect(effects.every((effect) => effect.secretInherited === false)).toBe(true);
      expect(new Set(effects.map((effect) => effect.taskId)).size).toBe(5);
      await daemon.shutdown();
    } finally {
      delete process.env.ZENTRA_SECRET_CANARY;
      journal.close();
    }
  });

  it("cancels an active process before dispatching queued work and produces no duplicate effect", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-scheduler-cancel-"));
    roots.push(root);
    const marker = path.join(root, "effects.jsonl");
    const journal = new SqliteEventJournal(path.join(root, "journal.sqlite"));
    const grants = new DispatchGrantService(journal, controlIdentity, "policy-plane");
    const durable = new JournalScheduler(journal, options(grants));
    durable.start();
    const activeWorkspace = path.join(root, "active");
    const nextWorkspace = path.join(root, "next");
    mkdirSync(activeWorkspace); mkdirSync(nextWorkspace);
    for (const scheduled of [input("active", "project-a", activeWorkspace), input("next", "project-b", nextWorkspace)]) {
      grants.issue({ grantId: scheduled.grantId, audience: scheduled.workerId,
        dispatchIntentSha256: dispatchIntentSha256(scheduled), expiresAtMs: Date.now() + 60 * 60_000 });
      durable.submit(scheduled);
    }
    const daemon = new DaemonScheduler(durable, new InstalledProcessExecutor({
      active: { executable: process.execPath, args: [fixture, marker, "active", "wait"], cwd: activeWorkspace },
      next: { executable: process.execPath, args: [fixture, marker, "next", "effect"], cwd: nextWorkspace },
    }));
    expect((await daemon.runOnce()).map((intent) => intent.taskId)).toEqual(["active"]);
    durable.cancel("active", "operator_requested");
    expect(await daemon.runOnce()).toEqual([]);
    await daemon.awaitIdle();
    expect(durable.inspect().tasks.active?.terminalOutcome).toBe("cancelled");
    expect((await daemon.runOnce()).map((intent) => intent.taskId)).toEqual(["next"]);
    await daemon.awaitIdle();
    const effects = readFileSync(marker, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(effects.map((effect) => effect.taskId)).toEqual(["next"]);
    await daemon.shutdown();
    journal.close();
  });

  it("terminates a real process at its durable time budget", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-scheduler-time-")); roots.push(root);
    const journal = new SqliteEventJournal(path.join(root, "journal.sqlite"));
    const grants = new DispatchGrantService(journal, controlIdentity, "policy-plane");
    const durable = new JournalScheduler(journal, options(grants)); durable.start();
    const workspace = path.join(root, "timed"); mkdirSync(workspace);
    const scheduled = { ...input("timed", "project-a", workspace),
      budget: { seconds: 1, inputTokens: 10, outputTokens: 10, costUsdNano: 10 } };
    grants.issue({ grantId: scheduled.grantId, audience: scheduled.workerId,
      dispatchIntentSha256: dispatchIntentSha256(scheduled), expiresAtMs: Date.now() + 60_000 });
    durable.submit(scheduled);
    const daemon = new DaemonScheduler(durable, new InstalledProcessExecutor({ timed: {
      executable: process.execPath, args: [fixture, path.join(root, "effects.jsonl"), "timed", "wait"], cwd: workspace,
    } }));
    await daemon.runOnce(); await daemon.awaitIdle();
    expect(durable.inspect().tasks.timed?.terminalOutcome).toBe("timed_out");
    await daemon.shutdown();
    journal.close();
  });

  it("fences true competing scheduler processes and never oversubscribes global capacity", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-scheduler-race-")); roots.push(root);
    const database = path.join(root, "journal.sqlite");
    const identity = { controlPlaneId: "zentra", repositoryIdentity: "/tmp/multiprocess-repository" };
    const journal = new SqliteEventJournal(database);
    const grants = new DispatchGrantService(journal, identity, "policy-plane");
    const tasks = [input("race-a", "project-a", "/tmp/worktrees/race-a"),
      input("race-b", "project-b", "/tmp/worktrees/race-b")];
    for (const scheduled of tasks) grants.issue({ grantId: scheduled.grantId, audience: scheduled.workerId,
      dispatchIntentSha256: dispatchIntentSha256(scheduled), expiresAtMs: Date.now() + 60_000 });
    journal.close();
    const barrier = path.join(root, "barrier");
    const fixturePath = path.resolve("tests/scheduling/fixtures/competing-scheduler.ts");
    const viteNode = path.resolve("node_modules/.bin/vite-node");
    const children = tasks.map((task, index) => runChild(viteNode, fixturePath, database, barrier, {
      schedulerId: `scheduler-${index}`, incarnation: `incarnation-${index}`, task,
      delayMs: index * 100,
    }));
    writeFileSync(barrier, "go", { mode: 0o600 });
    const results = await Promise.all(children);
    expect(results.filter((result) => result.status === "accepted"), JSON.stringify(results)).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const reopened = new SqliteEventJournal(database);
    const control = projectGlobalControl(reopened.readStream(schedulerControlStreamId(identity)));
    expect(control.resources.writers).toBe(1);
    expect(Object.keys(control.allocations)).toHaveLength(1);
    reopened.close();
  });
});

function options(grants: DispatchGrantService) {
  return { schedulerId: "installed", processIncarnation: "daemon-e2e", pid: process.pid,
    processStartIdentity: "daemon-e2e-start",
    platform: "darwin-arm64" as const,
    capabilities: ["write_worktree", "integrate"], now: Date.now,
    controlIdentity, grants,
    limits: { resources: { reasoning: 2, writers: 1, heavyValidation: 1, review: 1, integration: 1 },
      budget: { seconds: 1_000, inputTokens: 1_000, outputTokens: 1_000, costUsdNano: 1_000_000 } } };
}

function runChild(executable: string, fixturePath: string, database: string, barrier: string,
  command: unknown): Promise<{ status: string; intents?: number; error?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [fixturePath, database, barrier,
      Buffer.from(JSON.stringify(command)).toString("base64url")], {
      cwd: path.resolve("."), shell: false, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}
