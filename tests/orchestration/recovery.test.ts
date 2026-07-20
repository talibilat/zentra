import { createHash } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/main.js";
import {
  ValidationRunner,
  type ValidationReport,
} from "../../src/capabilities/validation-runner.js";
import type { StoredEvent } from "../../src/contracts/event.js";
import { IntegrationQueue } from "../../src/integration/integration-queue.js";
import {
  cleanupFailureDatabasePath,
  CleanupFailureStore,
} from "../../src/integration/cleanup-failure-store.js";
import { IntegrationLeaseStore } from "../../src/integration/integration-lease.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import {
  RecoveryService,
  type RecoveryServiceOptions,
  type RecoveryDecision,
} from "../../src/orchestration/recovery.js";
import type { ProjectConfig } from "../../src/projects/project-config.js";
import { ProjectRegistry } from "../../src/projects/project-registry.js";
import { ReviewGate } from "../../src/reviews/review-gate.js";
import { canonicalValidationDigest } from "../../src/reviews/reviewer-adapter.js";
import type { ReviewDecision } from "../../src/reviews/reviewer-adapter.js";
import { TaskService } from "../../src/tasks/task-service.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import { WorkerLifecycleService, capabilityEnvelope } from "../../src/workers/worker-lifecycle.js";
import {
  GitClient,
  type CommandResult,
  type GitRunOptions,
} from "../../src/workspaces/git-client.js";
import { WorktreeManager, type WorkspaceLease } from "../../src/workspaces/worktree-manager.js";

const temporaryDirectories: string[] = [];
const openJournals: SqliteEventJournal[] = [];

afterEach(() => {
  for (const journal of openJournals.splice(0)) journal.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const result = await new GitClient().run(cwd, args, { timeoutMs: 10_000 });
  if (result.termination !== null || result.exitCode !== 0 || result.truncated) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

class RecordingGitClient extends GitClient {
  readonly calls: Array<{ cwd: string; args: readonly string[]; options: GitRunOptions }> = [];

  override run(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<CommandResult> {
    this.calls.push({ cwd, args: [...args], options });
    return super.run(cwd, args, options);
  }
}

class FaultingReadGitClient extends GitClient {
  constructor(private readonly fault: "truncated" | "timed_out") {
    super();
  }

  override run(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<CommandResult> {
    if (args.includes("worktree") && args.includes("list")) {
      return Promise.resolve({
        stdout: "",
        stderr: this.fault,
        exitCode: this.fault === "truncated" ? 0 : -1,
        truncated: this.fault === "truncated",
        termination: this.fault === "timed_out" ? "timed_out" : null,
      });
    }
    return super.run(cwd, args, options);
  }
}

class DelayedGitClient extends GitClient {
  signalObserved = false;
  private delayed = false;

  constructor(
    private readonly shouldDelay: (args: readonly string[]) => boolean,
    private readonly delayMs: number,
    private readonly onDelay: () => void,
  ) {
    super();
  }

  override async run(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<CommandResult> {
    if (!this.delayed && this.shouldDelay(args)) {
      this.delayed = true;
      this.signalObserved = options.signal !== undefined;
      this.onDelay();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.delayMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return super.run(cwd, args, options);
  }
}

class InjectedRenewFailureStore extends IntegrationLeaseStore {
  constructor(databasePath: string, private readonly shouldThrow: () => boolean) {
    super(databasePath);
  }

  override renew(...args: Parameters<IntegrationLeaseStore["renew"]>): ReturnType<IntegrationLeaseStore["renew"]> {
    if (this.shouldThrow()) throw new Error("injected recovery lease renewal failure");
    return super.renew(...args);
  }
}

class InjectedReleaseFailureStore extends IntegrationLeaseStore {
  override release(): never {
    throw new Error("injected recovery lease release failure");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Fixture {
  readonly baseDirectory: string;
  readonly databasePath: string;
  readonly project: ProjectConfig;
  readonly registry: ProjectRegistry;
  readonly worktrees: WorktreeManager;
  readonly integrationBase: string;
}

async function fixture(): Promise<Fixture> {
  const baseDirectory = mkdtempSync(path.join(tmpdir(), "zentra-recovery-"));
  temporaryDirectories.push(baseDirectory);
  const repositoryPath = path.join(baseDirectory, "repository");
  const worktreeRoot = path.join(baseDirectory, "worktrees");
  mkdirSync(worktreeRoot);
  await gitOk(baseDirectory, ["init", "-b", "main", repositoryPath]);
  await gitOk(repositoryPath, ["config", "user.name", "Zentra Fixture"]);
  await gitOk(repositoryPath, ["config", "user.email", "fixture@zentra.local"]);
  writeFileSync(path.join(repositoryPath, "greeting.txt"), "hello\n", "utf8");
  await gitOk(repositoryPath, ["add", "--", "greeting.txt"]);
  await gitOk(repositoryPath, ["commit", "-m", "initial"]);

  const project: ProjectConfig = {
    projectId: "greeting-project",
    repositoryPath,
    integrationBranch: "zentra/integration",
    worktreeRoot,
    validations: {
      focused: [process.execPath, "-e", "process.exit(0)"],
      full: [process.execPath, "-e", "process.exit(0)"],
      focusedTimeoutMs: 5_000,
      fullTimeoutMs: 5_000,
    },
  };
  const worktrees = new WorktreeManager();
  await worktrees.ensureIntegrationBranch(project);
  const integrationBase = await gitOk(repositoryPath, ["rev-parse", project.integrationBranch]);
  return {
    baseDirectory,
    databasePath: path.join(baseDirectory, "journal.sqlite"),
    project,
    registry: new ProjectRegistry([project]),
    worktrees,
    integrationBase,
  };
}

function openSystem(
  testFixture: Fixture,
  git: GitClient = new GitClient(),
  options: RecoveryServiceOptions = {},
) {
  const journal = new SqliteEventJournal(testFixture.databasePath);
  openJournals.push(journal);
  const tasks = new TaskService(journal);
  const recovery = new RecoveryService(
    journal,
    tasks,
    testFixture.registry,
    testFixture.worktrees,
    git,
    options,
  );
  return { journal, tasks, recovery };
}

function closeJournal(journal: SqliteEventJournal): void {
  journal.close();
  openJournals.splice(openJournals.indexOf(journal), 1);
}

function writeRecoveryConfig(testFixture: Fixture): string {
  const configPath = path.join(testFixture.baseDirectory, "project.json");
  writeFileSync(configPath, `${JSON.stringify(testFixture.project, null, 2)}\n`, "utf8");
  return configPath;
}

async function invokeRecoveryCli(
  testFixture: Fixture,
  command: "recover" | "recover-apply",
): Promise<{ readonly code: number; readonly json: Record<string, unknown> }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli([
    command,
    "--config", writeRecoveryConfig(testFixture),
    "--database", testFixture.databasePath,
    "--task-id", "task-9",
  ], {
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  });
  return { code, json: JSON.parse(`${stdout}${stderr}`) as Record<string, unknown> };
}

function createTask(tasks: TaskService): void {
  tasks.create({
    taskId: "task-9",
    projectId: "greeting-project",
    title: "Recover greeting",
    correlationId: "task-9",
  });
}

async function leaseTask(
  testFixture: Fixture,
  tasks: TaskService,
): Promise<WorkspaceLease> {
  const lease = await testFixture.worktrees.create(testFixture.project, "task-9");
  tasks.append(
    "task-9",
    "task.leased",
    { leaseOwner: "worker-1", workspace: lease.path },
    null,
  );
  return lease;
}

function worktreeCreationIntent(testFixture: Fixture, taskId = "task-9") {
  return {
    taskId,
    branch: `ticket/${taskId}`,
    path: path.resolve(testFixture.project.worktreeRoot, taskId),
    baseCommit: testFixture.integrationBase,
  };
}

function recordWorktreeCreationStarted(
  tasks: TaskService,
  testFixture: Fixture,
  taskId = "task-9",
): void {
  tasks.append(
    taskId,
    "task.worktree_creation_started",
    worktreeCreationIntent(testFixture, taskId),
    null,
  );
}

function completedValidation(
  command: readonly string[],
  name: "focused" | "full",
  provenance: ValidationReport["provenance"],
): ValidationReport {
  const stdout = `${name} passed\n`;
  const stderr = "";
  const timeoutMs = provenance.timeoutMs ?? 5_000;
  return {
    name,
    outcome: "completed",
    exitCode: 0,
    stdout,
    stderr,
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:00:01.000Z",
    command: [...command],
    argvSha256: sha256(JSON.stringify(command)),
    outputSha256: sha256(JSON.stringify({ stdout, stderr })),
    timeoutMs,
    provenance: { ...provenance, timeoutMs },
  };
}

interface IntegratedEvidence {
  readonly lease: WorkspaceLease;
  readonly sourceCommit: string;
  readonly resultCommit: string;
  readonly receipt: Record<string, unknown>;
}

interface IntegrationStartedEvidence {
  readonly lease: WorkspaceLease;
  readonly sourceCommit: string;
  readonly review: ReviewDecision;
}

async function appendThroughIntegrationStarted(
  testFixture: Fixture,
  tasks: TaskService,
): Promise<IntegrationStartedEvidence> {
  const lease = await leaseTask(testFixture, tasks);
  tasks.append("task-9", "task.started", { workerId: "worker-1" }, null);
  writeFileSync(path.join(lease.path, "greeting.txt"), "recovered\n", "utf8");
  const inspected = await testFixture.worktrees.inspect(lease);
  const diffSha256 = sha256(inspected.diff);
  tasks.append(
    "task-9",
    "task.validation_started",
    { patch: { type: "artifact.ready", path: "greeting.txt", sha256: sha256("recovered\n") }, diffSha256 },
    null,
  );
  const focused = completedValidation(testFixture.project.validations.focused, "focused", {
    invocationId: "focused-task-9",
    canonicalCwd: realpathSync(lease.path),
    subjectSha256: diffSha256,
  });
  tasks.append(
    "task-9",
    "task.review_requested",
    { reviewerId: "reviewer-1", validation: focused },
    null,
  );
  const review: ReviewDecision = {
    reviewerId: "reviewer-1",
    approved: true,
    diffSha256,
    validationSha256: canonicalValidationDigest(focused),
    decidedAt: "2026-07-12T00:00:02.000Z",
    reason: "approved",
  };
  tasks.append("task-9", "task.review_approved", { review }, null);
  const sourceCommit = await testFixture.worktrees.commit(
    lease,
    ["greeting.txt"],
    "Recover greeting",
    diffSha256,
  );
  tasks.append(
    "task-9",
    "task.integration_started",
    { sourceCommit, review },
    null,
  );
  return { lease, sourceCommit, review };
}

async function appendThroughIntegrationObserved(
  testFixture: Fixture,
  tasks: TaskService,
  includeObserved = true,
): Promise<IntegratedEvidence> {
  const { lease, sourceCommit, review } = await appendThroughIntegrationStarted(
    testFixture,
    tasks,
  );
  await gitOk(testFixture.project.repositoryPath, ["switch", testFixture.project.integrationBranch]);
  await gitOk(testFixture.project.repositoryPath, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgSign=false",
    "merge",
    "--no-ff",
    "--no-edit",
    "--no-verify",
    sourceCommit,
  ]);
  const resultCommit = await gitOk(testFixture.project.repositoryPath, ["rev-parse", "HEAD"]);
  const originalIntegrationCommit = await gitOk(testFixture.project.repositoryPath, [
    "rev-parse",
    `${resultCommit}^1`,
  ]);
  const receipt = {
    taskId: "task-9",
    projectId: testFixture.project.projectId,
    sourceCommit,
    originalIntegrationCommit,
    resultCommit,
    review,
    validation: completedValidation(testFixture.project.validations.full, "full", {
      invocationId: "full-task-9",
      canonicalCwd: path.join(
        realpathSync(testFixture.project.worktreeRoot),
        ".zentra-integration-000000",
        "00000000-0000-4000-8000-000000000000",
      ),
      subjectSha256: resultCommit,
    }),
    outcome: "completed",
  };
  tasks.append(
    "task-9",
    "task.integration_prepared",
    { receipt },
    null,
  );
  if (includeObserved) {
    tasks.append(
      "task-9",
      "task.integration_observed",
      { receipt, verification: "verified" },
      null,
    );
  }
  return { lease, sourceCommit, resultCommit, receipt };
}

async function appendAtCompletionPath(
  testFixture: Fixture,
  tasks: TaskService,
  completionPath: "integration_prepared" | "integration_observed" | "cleanup_started" |
    "cleanup_observed" | "cleanup_reconciled" | "cleanup_completed",
): Promise<IntegratedEvidence> {
  const evidence = await appendThroughIntegrationObserved(
    testFixture,
    tasks,
    completionPath !== "integration_prepared",
  );
  if (completionPath === "integration_prepared" || completionPath === "integration_observed") {
    return evidence;
  }
  const cleanup = {
    sourceCommit: evidence.sourceCommit,
    resultCommit: evidence.resultCommit,
    workspace: evidence.lease.path,
    branch: evidence.lease.branch,
  };
  tasks.append("task-9", "task.cleanup_started", cleanup, null);
  await testFixture.worktrees.cleanupCompleted(
    testFixture.project,
    evidence.lease,
    evidence.sourceCommit,
    { timeoutMs: 10_000 },
  );
  if (completionPath === "cleanup_started") return evidence;
  if (completionPath === "cleanup_completed") {
    tasks.append("task-9", "task.cleanup_completed", cleanup, null);
    return evidence;
  }
  const observation = {
    phase: "ref_deletion",
    uncertain: true,
    evidence: { taskId: "task-9" },
    reason: "cleanup acknowledgement was lost",
  };
  tasks.append("task-9", "task.cleanup_observed", observation, null);
  if (completionPath === "cleanup_reconciled") {
    tasks.append("task-9", "task.cleanup_reconciled", { cleanup, observation }, null);
  }
  return evidence;
}

function databaseFor(journal: SqliteEventJournal): {
  prepare(sql: string): { run(...args: unknown[]): void };
} {
  return (journal as unknown as {
    db: { prepare(sql: string): { run(...args: unknown[]): void } };
  }).db;
}

function replaceEventPayload(
  journal: SqliteEventJournal,
  type: string,
  transform: (payload: Record<string, unknown>) => unknown,
): void {
  const event = journal.readStream("task-9").find((candidate) => candidate.type === type)!;
  databaseFor(journal).prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(
    JSON.stringify(transform(event.payload as Record<string, unknown>)),
    event.eventId,
  );
}

function appendRawDuplicate(journal: SqliteEventJournal, type: string): void {
  const events = journal.readStream("task-9");
  const event = events.find((candidate) => candidate.type === type) ?? events.at(-1)!;
  journal.append("task-9", events.at(-1)!.streamVersion, [{
    streamId: "task-9",
    type,
    payload: event.payload,
    causationId: event.causationId,
    correlationId: event.correlationId,
  }]);
}

function replaceLastPayload(
  journal: SqliteEventJournal,
  transform: (payload: Record<string, unknown>) => unknown,
): void {
  const events = journal.readStream("task-9");
  const last = events.at(-1)!;
  const payload = transform(last.payload as Record<string, unknown>);
  databaseFor(journal).prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(
    JSON.stringify(payload),
    last.eventId,
  );
}

describe("RecoveryService", () => {
  it("retains generic worker uncertainty across restart and forbids effect redispatch", async () => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    createTask(first.tasks);
    const workers = new WorkerLifecycleService(first.journal);
    workers.bind({
      schemaVersion: 1, workerId: "worker-uncertain", taskId: "task-9", rootTaskId: "task-9",
      parentWorkerId: null, harness: "deterministic", role: "implementer", model: null,
      envelope: capabilityEnvelope({ role: "implementer", authority: "workspace_write", capabilities: ["read_repository", "write_worktree"], network: "denied", secrets: "none", effects: { worktree: "assigned", pathExpansion: "none", integration: "none", release: "none", external: "none" }, resources: { repository: "assigned_worktree", paths: ["greeting.txt"], forbiddenPaths: [".env"] } }),
      budget: { budgetId: "task-9", maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100, maxToolCalls: 10, maxModelTurns: 10, maxActiveWorkers: 1, maxConcurrentTools: 1, maxConcurrentModelTurns: 1 },
      taskContext: { kind: "standalone" }, trace: { traceId: "task-9", correlationId: "task-9" },
    });
    workers.start("task-9", "worker-uncertain");
    workers.uncertain("task-9", "worker-uncertain", "process acknowledgement missing");
    closeJournal(first.journal);

    const restarted = openSystem(testFixture);
    await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringContaining("redispatch is forbidden"),
    });
  });
  it("resumes safe preparation after task creation before worktree creation", async () => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    const { tasks } = first;
    createTask(tasks);
    closeJournal(first.journal);

    const inspected = await openSystem(testFixture).recovery.inspect("task-9");
    expect(inspected.action, inspected.reason).toBe("resume_preparation");
    expect(inspected).toMatchObject({
      taskId: "task-9",
      action: "resume_preparation",
    });
    expect(existsSync(path.join(testFixture.project.worktreeRoot, "task-9"))).toBe(false);
  });

  it("inspects and resumes an exact registered clean worktree before worker start", async () => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    const { tasks } = first;
    createTask(tasks);
    await leaseTask(testFixture, tasks);
    closeJournal(first.journal);

    await expect(openSystem(testFixture).recovery.inspect("task-9")).resolves.toMatchObject({
      action: "resume_preparation",
    });
  });

  it("reconciles an unrecorded created worktree after restart without creating another", async () => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    createTask(first.tasks);
    const lease = await testFixture.worktrees.create(testFixture.project, "task-9");
    closeJournal(first.journal);

    const restarted = openSystem(testFixture);
    await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/workspace.*not recorded|durable Git effects/i),
    });
    expect(existsSync(lease.path)).toBe(true);
    expect(await gitOk(testFixture.project.repositoryPath, ["worktree", "list", "--porcelain"])).toContain(lease.path);
    expect(restarted.journal.readStream("task-9").map((event) => event.type)).toEqual([
      "task.created",
    ]);
  });

  it("fails closed when an unregistered object occupies the configured ticket path", async () => {
    const testFixture = await fixture();
    const { tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    mkdirSync(path.join(testFixture.project.worktreeRoot, "task-9"));

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_failure",
      reason: expect.stringMatching(/exists.*not.*registered/i),
    });
  });

  describe("uncertain worktree creation (issue 002)", () => {
    it("resumes preparation when prepared evidence is durable but no Git effect occurred", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
        action: "resume_preparation",
      });
      expect(existsSync(path.join(testFixture.project.worktreeRoot, "task-9"))).toBe(false);
    });

    it("adopts an exactly completed worktree creation as if task.leased had been recorded", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      // The Git effect actually completed exactly as intended, but the
      // caller never durably recorded task.leased (e.g. interrupted between
      // Git success and the leased append).
      await testFixture.worktrees.create(testFixture.project, "task-9");
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
        action: "resume_preparation",
        reason: expect.stringMatching(/exact intended branch, path, and base/i),
      });
      // Never automatically retried: the branch and worktree remain exactly
      // as Git created them.
      expect(existsSync(path.join(testFixture.project.worktreeRoot, "task-9"))).toBe(true);
    });

    it("adopts the prepared commit after the integration branch advances", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      await testFixture.worktrees.create(testFixture.project, "task-9");
      await gitOk(testFixture.project.repositoryPath, ["switch", testFixture.project.integrationBranch]);
      writeFileSync(path.join(testFixture.project.repositoryPath, "advanced.txt"), "advanced\n");
      await gitOk(testFixture.project.repositoryPath, ["add", "--", "advanced.txt"]);
      await gitOk(testFixture.project.repositoryPath, ["commit", "-m", "advance integration"]);
      closeJournal(first.journal);

      await expect(openSystem(testFixture).recovery.inspect("task-9")).resolves.toMatchObject({
        action: "resume_preparation",
        reason: expect.stringMatching(/exact intended branch, path, and base/i),
      });
    });

    it("awaits reconciliation and never auto-cleans a partial worktree creation (branch created without registration)", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      // Simulate a partial effect: the ticket branch was created, but the
      // worktree was never registered (e.g. interrupted between the two).
      await gitOk(testFixture.project.repositoryPath, ["branch", "ticket/task-9"]);
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      const decision = await restarted.recovery.inspect("task-9");
      expect(decision.action).toBe("await_reconciliation");
      // The branch must be preserved, not deleted or retried.
      const branch = await new GitClient().run(testFixture.project.repositoryPath, [
        "show-ref", "--verify", "refs/heads/ticket/task-9",
      ]);
      expect(branch.exitCode).toBe(0);
    });

    it("preserves a competing ticket branch that exists with the wrong base commit, never deleting it", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      // A branch with the exact intended name exists, but points at a
      // commit that is not the intended base (e.g. created by a stale or
      // competing process, or left over from a previous unrelated attempt).
      await gitOk(testFixture.project.repositoryPath, [
        "branch", "ticket/task-9", "HEAD",
      ]);
      await gitOk(testFixture.project.repositoryPath, [
        "worktree", "add", path.join(testFixture.project.worktreeRoot, "task-9"), "ticket/task-9",
      ]);
      await gitOk(
        path.join(testFixture.project.worktreeRoot, "task-9"),
        ["commit", "--allow-empty", "-m", "competing commit not from the intended base"],
      );
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      const decision = await restarted.recovery.inspect("task-9");
      expect(decision.action).toBe("await_reconciliation");
      expect(decision.reason).toMatch(/exact intended base|does not point/i);
      const branch = await new GitClient().run(testFixture.project.repositoryPath, [
        "show-ref", "--verify", "refs/heads/ticket/task-9",
      ]);
      expect(branch.exitCode).toBe(0);
      expect(existsSync(path.join(testFixture.project.worktreeRoot, "task-9"))).toBe(true);
    });

    it("fails closed (dirty path refusal) when the configured path exists but is not an exact registered worktree", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      // The configured path exists but was never registered by Git at all
      // (occupied by something else entirely).
      mkdirSync(path.join(testFixture.project.worktreeRoot, "task-9"));
      writeFileSync(path.join(testFixture.project.worktreeRoot, "task-9", "occupied.txt"), "dirty\n");
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      const decision = await restarted.recovery.inspect("task-9");
      expect(decision.action).toBe("await_reconciliation");
      expect(existsSync(path.join(testFixture.project.worktreeRoot, "task-9", "occupied.txt"))).toBe(true);
    });

    it("preserves prepared evidence and never retries when the recorded base commit is unavailable", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      // Record an intent whose base does not match the project's configured
      // integration branch (e.g. stale evidence from a reconfiguration).
      first.tasks.append(
        "task-9",
        "task.worktree_creation_started",
        { ...worktreeCreationIntent(testFixture), baseCommit: "f".repeat(40) },
        null,
      );
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
        action: "await_reconciliation",
        reason: expect.stringMatching(/failed closed|unavailable/i),
      });
    });

    it("REGRESSION: a terminal outcome must never hide uncertain worktree creation from reconciliation", async () => {
      // This is the exact bug from issue 002: under the old tracer-bullet
      // behavior, an interrupted git worktree add was unconditionally
      // terminalized (task.cancelled), and recovery's blind
      // `if (task.lifecycle === "terminal") return await_reconciliation`
      // no-op meant the orphaned branch/worktree could never be reconciled.
      //
      // Against the OLD code this test would fail: appending task.cancelled
      // after only task.created/task.worktree_creation_started would make
      // the task terminal, and the terminal short-circuit would return a
      // no-op await_reconciliation decision without ever inspecting Git, so
      // the assertion on the *reason* mentioning real Git state would fail
      // (it would instead read "task is already terminal ... no-op").
      //
      // Against the fixed code, tracer-bullet never appends a terminal
      // outcome for an interrupted worktree creation in the first place, so
      // the task remains nonterminal and this exact Git-inspecting branch is
      // reached and reconciles the real state instead of hiding it.
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      await testFixture.worktrees.create(testFixture.project, "task-9");
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      const task = restarted.tasks.get("task-9");
      expect(task?.lifecycle).not.toBe("terminal");

      const decision = await restarted.recovery.inspect("task-9");
      expect(decision.action).toBe("resume_preparation");
      expect(decision.reason).toMatch(/exact intended branch, path, and base/i);
      expect(decision.reason).not.toMatch(/already terminal/i);
    });
  });

  describe("authorizeBoundedCleanup (issue 002, problem 2)", () => {
    it("removes the worktree and branch for a safe, exact, unleased state and ends in a terminal outcome", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      // Git actually completed exactly as intended, but the task was
      // abandoned before any worker ever started (no task.leased).
      await testFixture.worktrees.create(testFixture.project, "task-9");
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
        action: "resume_preparation",
      });

      const worktreePath = path.join(testFixture.project.worktreeRoot, "task-9");
      expect(existsSync(worktreePath)).toBe(true);

      const result = await restarted.recovery.authorizeBoundedCleanup("task-9");

      expect(result.lifecycle).toBe("terminal");
      expect(["cancelled", "denied"]).toContain(result.terminalOutcome);
      expect(existsSync(worktreePath)).toBe(false);
      const branch = await new GitClient().run(testFixture.project.repositoryPath, [
        "show-ref", "--verify", "refs/heads/ticket/task-9",
      ]);
      expect(branch.exitCode).not.toBe(0);

      // The task must be genuinely terminal in the durable journal, not
      // just in the in-memory return value.
      expect(restarted.tasks.get("task-9")?.lifecycle).toBe("terminal");
    });

    it("refuses (throws, no effect) for a partial worktree creation, preserving the branch untouched", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      // Partial effect: branch created, worktree never registered.
      await gitOk(testFixture.project.repositoryPath, ["branch", "ticket/task-9"]);
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
        action: "await_reconciliation",
      });

      await expect(restarted.recovery.authorizeBoundedCleanup("task-9")).rejects.toThrow(
        /not authorized/i,
      );

      const branch = await new GitClient().run(testFixture.project.repositoryPath, [
        "show-ref", "--verify", "refs/heads/ticket/task-9",
      ]);
      expect(branch.exitCode).toBe(0);
      expect(restarted.tasks.get("task-9")?.lifecycle).not.toBe("terminal");
    });

    it("refuses (throws, no effect) for a competing branch identity that does not match the intended base", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      await gitOk(testFixture.project.repositoryPath, ["branch", "ticket/task-9", "HEAD"]);
      await gitOk(testFixture.project.repositoryPath, [
        "worktree", "add", path.join(testFixture.project.worktreeRoot, "task-9"), "ticket/task-9",
      ]);
      await gitOk(
        path.join(testFixture.project.worktreeRoot, "task-9"),
        ["commit", "--allow-empty", "-m", "competing commit not from the intended base"],
      );
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
        action: "await_reconciliation",
      });

      await expect(restarted.recovery.authorizeBoundedCleanup("task-9")).rejects.toThrow(
        /not authorized/i,
      );

      expect(existsSync(path.join(testFixture.project.worktreeRoot, "task-9"))).toBe(true);
      const branch = await new GitClient().run(testFixture.project.repositoryPath, [
        "show-ref", "--verify", "refs/heads/ticket/task-9",
      ]);
      expect(branch.exitCode).toBe(0);
    });

    it("refuses (throws, no effect) for a dirty worktree, preserving it untouched", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      const lease = await testFixture.worktrees.create(testFixture.project, "task-9");
      writeFileSync(path.join(lease.path, "unreviewed.txt"), "dirty\n");
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
        action: "await_reconciliation",
      });

      await expect(restarted.recovery.authorizeBoundedCleanup("task-9")).rejects.toThrow(
        /not authorized/i,
      );

      expect(existsSync(path.join(lease.path, "unreviewed.txt"))).toBe(true);
    });

    it("refuses (throws, no effect) once the task has already been leased, preserving the leased worktree", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      await leaseTask(testFixture, first.tasks);
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
        action: "resume_preparation",
        reason: expect.stringMatching(/leased worktree is ready/i),
      });

      await expect(restarted.recovery.authorizeBoundedCleanup("task-9")).rejects.toThrow(
        /worktree_creation_started/i,
      );

      expect(existsSync(path.join(testFixture.project.worktreeRoot, "task-9"))).toBe(true);
    });

    it("never performs any effect from inspect() alone: only the explicit method call removes state", async () => {
      const testFixture = await fixture();
      const first = openSystem(testFixture);
      createTask(first.tasks);
      recordWorktreeCreationStarted(first.tasks, testFixture);
      await testFixture.worktrees.create(testFixture.project, "task-9");
      closeJournal(first.journal);

      const restarted = openSystem(testFixture);
      const worktreePath = path.join(testFixture.project.worktreeRoot, "task-9");

      // Calling inspect() repeatedly must never remove anything.
      await restarted.recovery.inspect("task-9");
      await restarted.recovery.inspect("task-9");
      await restarted.recovery.inspect("task-9");

      expect(existsSync(worktreePath)).toBe(true);
      const branch = await new GitClient().run(testFixture.project.repositoryPath, [
        "show-ref", "--verify", "refs/heads/ticket/task-9",
      ]);
      expect(branch.exitCode).toBe(0);
      expect(restarted.tasks.get("task-9")?.lifecycle).not.toBe("terminal");
    });
  });

  it("awaits reconciliation after worker start whether its unrecorded effect is visible", async () => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    const { tasks } = first;
    createTask(tasks);
    const lease = await leaseTask(testFixture, tasks);
    tasks.append("task-9", "task.started", { workerId: "worker-1" }, null);
    const workerResult = await new ProcessSupervisor().execute({
      taskId: "task-9",
      executable: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync("greeting.txt", "worker wrote this\\n"); console.log(JSON.stringify({ type: "artifact.ready", path: "greeting.txt", sha256: "${"0".repeat(64)}" }))`,
      ],
      cwd: lease.path,
      timeoutMs: 5_000,
    }, AbortSignal.timeout(10_000), "worker");
    expect(workerResult.outcome).toBe("completed");
    closeJournal(first.journal);

    const restarted = openSystem(testFixture);
    const decision = await restarted.recovery.retainClassification("task-9");
    expect(decision.action).toBe("await_reconciliation");
    expect(decision.reason).toMatch(/worker|dirty|effect/i);
    expect(restarted.tasks.readStream("task-9").at(-1)).toMatchObject({
      type: "task.effect_uncertain",
      payload: {
        boundary: "worker",
        retryPolicy: "never_automatic",
        recoveryClassification: "await_reconciliation",
      },
    });
    expect(restarted.tasks.get("task-9")).toMatchObject({
      lifecycle: "running",
      paused: true,
      terminalOutcome: null,
    });
    await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
    });
    restarted.tasks.recordEffectReconciliation("task-9", {
      schemaVersion: 1,
      boundary: "worker",
      resolution: "abandoned",
      reason: "operator abandoned the uncertain worker result",
      decidedBy: "operator-1",
      decisionId: "decision-1",
    });
    await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/explicitly abandoned/i),
    });
    expect(existsSync(lease.path)).toBe(true);
    closeJournal(restarted.journal);
  });

  it("does not retry validation after its result was not recorded", async () => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    const { tasks } = first;
    createTask(tasks);
    const lease = await leaseTask(testFixture, tasks);
    tasks.append("task-9", "task.started", { workerId: "worker-1" }, null);
    writeFileSync(path.join(lease.path, "greeting.txt"), "worker wrote this\n", "utf8");
    const { diff } = await testFixture.worktrees.inspect(lease);
    tasks.append(
      "task-9",
      "task.validation_started",
      {
        diffSha256: sha256(diff),
        patch: { type: "artifact.ready", path: "greeting.txt", sha256: sha256("worker wrote this\n") },
      },
      null,
    );
    const discardedValidation = await new ValidationRunner(new ProcessSupervisor()).run(
      testFixture.project,
      "focused",
      lease.path,
      AbortSignal.timeout(10_000),
      { invocationId: "discarded-before-restart", subjectSha256: sha256(diff) },
    );
    expect(discardedValidation).toMatchObject({ outcome: "completed", exitCode: 0 });
    closeJournal(first.journal);

    await expect(openSystem(testFixture).recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/must not be retried/i),
    });
  });

  it("awaits reconciliation for Task 8 commit_observed evidence", async () => {
    const testFixture = await fixture();
    const { tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const lease = await leaseTask(testFixture, tasks);
    tasks.append("task-9", "task.started", { workerId: "worker-1" }, null);
    writeFileSync(path.join(lease.path, "greeting.txt"), "changed\n", "utf8");
    const { diff } = await testFixture.worktrees.inspect(lease);
    const validation = completedValidation(testFixture.project.validations.focused, "focused", {
      invocationId: "focused-commit-observed",
      canonicalCwd: realpathSync(lease.path),
      subjectSha256: sha256(diff),
    });
    tasks.append("task-9", "task.validation_started", {
      patch: { type: "artifact.ready", path: "greeting.txt", sha256: sha256("changed\n") },
      diffSha256: sha256(diff),
    }, null);
    tasks.append("task-9", "task.review_requested", {
      reviewerId: "reviewer-1",
      validation,
    }, null);
    tasks.append("task-9", "task.review_approved", {
      review: {
        reviewerId: "reviewer-1",
        approved: true,
        diffSha256: sha256(diff),
        validationSha256: canonicalValidationDigest(validation),
        decidedAt: "2026-07-12T00:00:02.000Z",
        reason: "approved",
      },
    }, null);
    tasks.append("task-9", "task.commit_observed", {
      stage: "commit",
      reason: "commit result uncertain",
    }, null);

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/commit/i),
    });
  });

  it.each([
    ["before reviewer dispatch", false, "resume_preparation", /review has not been recorded/i],
    ["after reviewer dispatch intent", true, "await_reconciliation", /dispatch intent.*reconcile/i],
  ] as const)("classifies restart %s without retrying the writer", async (_name, dispatched, action, reason) => {
    const testFixture = await fixture();
    const { tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const lease = await leaseTask(testFixture, tasks);
    tasks.append("task-9", "task.started", { workerId: "worker-1" }, null);
    writeFileSync(path.join(lease.path, "greeting.txt"), "changed\n", "utf8");
    const { diff } = await testFixture.worktrees.inspect(lease);
    const diffSha256 = sha256(diff);
    tasks.append("task-9", "task.validation_started", {
      patch: { type: "artifact.ready", path: "greeting.txt", sha256: sha256("changed\n") }, diffSha256,
    }, null);
    const validation = completedValidation(testFixture.project.validations.focused, "focused", {
      invocationId: "focused-review-recovery", canonicalCwd: realpathSync(lease.path), subjectSha256: diffSha256,
    });
    tasks.append("task-9", "task.review_requested", { reviewerId: "reviewer-1", validation }, null);
    if (dispatched) tasks.append("task-9", "task.review_dispatch_intent", {
      schemaVersion: 1, reviewerId: "reviewer-1", diffSha256,
      validationSha256: canonicalValidationDigest(validation), dispatchId: "00000000-0000-4000-8000-000000000001",
    }, null);
    await expect(recovery.inspect("task-9")).resolves.toMatchObject({ action, reason: expect.stringMatching(reason) });
  });

  it("never retries a merge with an uncertain result", async () => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    const { tasks } = first;
    createTask(tasks);
    const evidence = await appendThroughIntegrationStarted(testFixture, tasks);
    const candidatePath = path.join(
      realpathSync(testFixture.project.worktreeRoot),
      ".zentra-integration-uncert",
      "11111111-1111-4111-8111-111111111111",
    );
    mkdirSync(candidatePath, { recursive: true });
    tasks.append("task-9", "task.integration_observed", {
      reason: "update-ref result is uncertain",
      evidence: {
        taskId: "task-9",
        projectId: testFixture.project.projectId,
        sourceCommit: evidence.sourceCommit,
        resultCommit: "a".repeat(40),
        reconciledHead: null,
        reconciliationIssue: "inspection failed",
        candidatePath,
      },
    }, null);
    closeJournal(first.journal);

    const before = await gitOk(testFixture.project.repositoryPath, ["rev-parse", `refs/heads/${testFixture.project.integrationBranch}`]);
    await expect(openSystem(testFixture).recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/integration|merge|effect/i),
    });
    expect(await gitOk(testFixture.project.repositoryPath, ["rev-parse", `refs/heads/${testFixture.project.integrationBranch}`])).toBe(before);
  });

  it("returns await_reconciliation for uncertain task.integration_observed evidence", async () => {
    const testFixture = await fixture();
    const { tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const evidence = await appendThroughIntegrationStarted(testFixture, tasks);
    tasks.append("task-9", "task.integration_observed", {
      reason: "update-ref result uncertain",
      evidence: {
        taskId: "task-9",
        projectId: testFixture.project.projectId,
        sourceCommit: evidence.sourceCommit,
        resultCommit: "a".repeat(40),
        reconciledHead: null,
        reconciliationIssue: "inspection failed",
        candidatePath: path.join(
          realpathSync(testFixture.project.worktreeRoot),
          ".zentra-integration-uncert",
          "22222222-2222-4222-8222-222222222222",
        ),
      },
    }, null);

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/integration.*evidence|uncertain/i),
    });
  });

  it("revalidates durable integration evidence after SQLite close and reopen", async () => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    createTask(first.tasks);
    await appendThroughIntegrationObserved(testFixture, first.tasks);
    closeJournal(first.journal);

    const restarted = openSystem(testFixture);
    await expect(restarted.recovery.inspect("task-9")).resolves.toMatchObject({
      taskId: "task-9",
      action: "record_completion",
      reason: expect.stringMatching(/durable|verified|integration/i),
    });
  });

  it("completes after restart when a stale ticket is integrated onto a newer durable base", async () => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    createTask(first.tasks);
    const lease = await leaseTask(testFixture, first.tasks);
    first.tasks.append("task-9", "task.started", { workerId: "worker-1" }, null);
    writeFileSync(path.join(lease.path, "greeting.txt"), "stale ticket\n", "utf8");
    const inspected = await testFixture.worktrees.inspect(lease);
    const diffSha256 = sha256(inspected.diff);
    first.tasks.append("task-9", "task.validation_started", {
      patch: { type: "artifact.ready", path: "greeting.txt", sha256: sha256("stale ticket\n") },
      diffSha256,
    }, null);
    const validations = new ValidationRunner(new ProcessSupervisor());
    const focused = await validations.run(
      testFixture.project,
      "focused",
      lease.path,
      AbortSignal.timeout(10_000),
      { invocationId: "stale-focused", subjectSha256: diffSha256 },
    );
    first.tasks.append("task-9", "task.review_requested", {
      reviewerId: "reviewer-1",
      validation: focused,
    }, null);
    const review = new ReviewGate().verify({
      workerId: "worker-1",
      reviewerId: "reviewer-1",
      diff: inspected.diff,
      validation: focused,
    }, {
      reviewerId: "reviewer-1",
      approved: true,
      diffSha256,
      validationSha256: canonicalValidationDigest(focused),
      decidedAt: "2026-07-12T00:00:02.000Z",
      reason: "approved",
    });
    first.tasks.append("task-9", "task.review_approved", { review }, null);
    const sourceCommit = await testFixture.worktrees.commit(
      lease,
      ["greeting.txt"],
      "stale ticket",
      diffSha256,
    );
    first.tasks.append("task-9", "task.integration_started", { sourceCommit, review }, null);

    await gitOk(testFixture.project.repositoryPath, ["switch", testFixture.project.integrationBranch]);
    writeFileSync(path.join(testFixture.project.repositoryPath, "base-b.txt"), "base B\n", "utf8");
    await gitOk(testFixture.project.repositoryPath, ["add", "--", "base-b.txt"]);
    await gitOk(testFixture.project.repositoryPath, ["commit", "-m", "advance integration to B"]);
    const baseB = await gitOk(testFixture.project.repositoryPath, ["rev-parse", "HEAD"]);
    const receipt = await new IntegrationQueue(new GitClient(), validations).integrate({
      project: testFixture.project,
      lease,
      review,
      signal: AbortSignal.timeout(10_000),
      onPrepared(prepared) {
        first.tasks.append("task-9", "task.integration_prepared", { receipt: prepared }, null);
      },
    });
    expect(receipt.originalIntegrationCommit).toBe(baseB);
    first.tasks.append("task-9", "task.integration_observed", {
      receipt,
      verification: "verified",
    }, null);
    closeJournal(first.journal);

    await expect(openSystem(testFixture).recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_completion",
    });
  });

  it("rejects a restarted completion when durable worker and reviewer identities contradict", async () => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    createTask(first.tasks);
    await appendThroughIntegrationObserved(testFixture, first.tasks);
    replaceEventPayload(first.journal, "task.started", () => ({ workerId: "other-worker" }));
    closeJournal(first.journal);

    const decision = await openSystem(testFixture).recovery.inspect("task-9");
    expect(decision.action).not.toBe("record_completion");
    expect(decision.reason).toMatch(/identity|worker|lease/i);
  });

  it("blocks prepared-only synthesis on durable cleanup evidence until acknowledgement", async () => {
    const testFixture = await fixture();
    const system = openSystem(testFixture);
    createTask(system.tasks);
    const evidence = await appendAtCompletionPath(
      testFixture,
      system.tasks,
      "integration_prepared",
    );
    const commonDirectory = realpathSync(path.join(testFixture.project.repositoryPath, ".git"));
    const candidatePath = (evidence.receipt.validation as ValidationReport)
      .provenance.canonicalCwd;
    const store = new CleanupFailureStore(cleanupFailureDatabasePath(commonDirectory));
    const failure = store.record({
      projectId: testFixture.project.projectId,
      taskId: "task-9",
      commonDirectory,
      repositoryIdentitySha256: sha256(commonDirectory),
      integrationRef: `refs/heads/${testFixture.project.integrationBranch}`,
      candidateId: path.basename(candidatePath),
      candidatePath,
      reason: "candidate cleanup result is unacknowledged",
      recordedAt: "2026-07-20T12:00:00.000Z",
      lease: null,
    });
    store.close();

    await expect(system.recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/durable unacknowledged.*cleanup|cleanup.*durable unacknowledged/i),
    });

    const acknowledgementStore = new CleanupFailureStore(
      cleanupFailureDatabasePath(commonDirectory),
    );
    acknowledgementStore.acknowledge({
      recordId: failure.recordId,
      actor: "operator:test",
      acknowledgedAt: "2026-07-20T12:05:00.000Z",
      dispositionEvidence: "candidate absence verified",
    });
    acknowledgementStore.close();
    await expect(system.recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_completion",
    });
  });

  it("diagnoses malformed cleanup evidence instead of a generic invalid chain", async () => {
    const testFixture = await fixture();
    const system = openSystem(testFixture);
    createTask(system.tasks);
    await appendThroughIntegrationObserved(testFixture, system.tasks);
    replaceEventPayload(system.journal, "task.integration_observed", (payload) => ({
      ...(payload as Record<string, unknown>),
      cleanupFailures: [{ taskId: "task-9", candidatePath: "relative" }],
    }));

    await expect(system.recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/cleanup failure evidence is invalid/i),
    });
  });

  it("records failure for an invalid identity chain before commit effects", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const lease = await leaseTask(testFixture, tasks);
    tasks.append("task-9", "task.started", { workerId: "worker-1" }, null);
    writeFileSync(path.join(lease.path, "greeting.txt"), "worker wrote this\n", "utf8");
    const { diff } = await testFixture.worktrees.inspect(lease);
    tasks.append("task-9", "task.validation_started", {
      patch: { type: "artifact.ready", path: "greeting.txt", sha256: sha256("worker wrote this\n") },
      diffSha256: sha256(diff),
    }, null);
    const focused = completedValidation(testFixture.project.validations.focused, "focused", {
      invocationId: "identity-focused",
      canonicalCwd: realpathSync(lease.path),
      subjectSha256: sha256(diff),
    });
    tasks.append("task-9", "task.review_requested", {
      reviewerId: "worker-1",
      validation: focused,
    }, null);

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_failure",
      reason: expect.stringMatching(/reviewer|identity|worker/i),
    });
    expect(journal.readStream("task-9").at(-1)?.type).toBe("task.review_requested");
  });

  it("rejects unsafe or non-root patch evidence before resuming validation", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const lease = await leaseTask(testFixture, tasks);
    tasks.append("task-9", "task.started", { workerId: "worker-1" }, null);
    writeFileSync(path.join(lease.path, "greeting.txt"), "worker wrote this\n", "utf8");
    const { diff } = await testFixture.worktrees.inspect(lease);
    tasks.append("task-9", "task.validation_started", {
      patch: { type: "artifact.ready", path: "../outside", sha256: sha256("worker wrote this\n") },
      diffSha256: sha256(diff),
    }, null);

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_failure",
      reason: expect.stringMatching(/patch|path|event chain/i),
    });
    expect(journal.readStream("task-9").at(-1)?.type).toBe("task.validation_started");
  });

  it("rejects focused validation provenance that is not bound to the exact diff and workspace", async () => {
    const testFixture = await fixture();
    const { tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const lease = await leaseTask(testFixture, tasks);
    tasks.append("task-9", "task.started", { workerId: "worker-1" }, null);
    writeFileSync(path.join(lease.path, "greeting.txt"), "worker wrote this\n", "utf8");
    const { diff } = await testFixture.worktrees.inspect(lease);
    const diffSha256 = sha256(diff);
    tasks.append("task-9", "task.validation_started", {
      patch: { type: "artifact.ready", path: "greeting.txt", sha256: sha256("worker wrote this\n") },
      diffSha256,
    }, null);
    tasks.append("task-9", "task.review_requested", {
      reviewerId: "reviewer-1",
      validation: completedValidation(testFixture.project.validations.focused, "focused", {
        invocationId: "wrong-focused-provenance",
        canonicalCwd: realpathSync(lease.path),
        subjectSha256: "wrong-subject",
      }),
    }, null);

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_failure",
      reason: expect.stringMatching(/focused|provenance|subject/i),
    });
  });

  it.each(["patch digest", "patch path"])(
    "does not complete when committed source contradicts %s evidence",
    async (target) => {
      const testFixture = await fixture();
      const { journal, tasks, recovery } = openSystem(testFixture);
      createTask(tasks);
      await appendThroughIntegrationObserved(testFixture, tasks);
      replaceEventPayload(journal, "task.validation_started", (payload) => {
        const patch = payload.patch as Record<string, unknown>;
        return {
          ...payload,
          patch: target === "patch digest"
            ? { ...patch, sha256: "0".repeat(64) }
            : { ...patch, path: "other.txt" },
        };
      });

      expect((await recovery.inspect("task-9")).action).not.toBe("record_completion");
    },
  );

  it.each([
    ["wrong full subject", (provenance: Record<string, unknown>) => ({ ...provenance, subjectSha256: "f".repeat(40) })],
    ["wrong full cwd", (provenance: Record<string, unknown>) => ({ ...provenance, canonicalCwd: "/tmp/not-a-candidate" })],
  ])("does not complete with %s provenance", async (_name, mutate) => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    replaceLastPayload(journal, (payload) => {
      const receipt = payload.receipt as Record<string, unknown>;
      const validation = receipt.validation as Record<string, unknown>;
      return {
        ...payload,
        receipt: {
          ...receipt,
          validation: {
            ...validation,
            provenance: mutate(validation.provenance as Record<string, unknown>),
          },
        },
      };
    });

    expect((await recovery.inspect("task-9")).action).not.toBe("record_completion");
  });

  it("rejects an extra descendant commit as the integration result", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    writeFileSync(path.join(testFixture.project.repositoryPath, "extra.txt"), "extra\n", "utf8");
    await gitOk(testFixture.project.repositoryPath, ["add", "--", "extra.txt"]);
    await gitOk(testFixture.project.repositoryPath, ["commit", "-m", "unrelated descendant"]);
    const descendant = await gitOk(testFixture.project.repositoryPath, ["rev-parse", "HEAD"]);
    replaceLastPayload(journal, (payload) => {
      const receipt = payload.receipt as Record<string, unknown>;
      const validation = receipt.validation as Record<string, unknown>;
      return {
        ...payload,
        receipt: {
          ...receipt,
          resultCommit: descendant,
          validation: {
            ...validation,
            provenance: {
              ...(validation.provenance as Record<string, unknown>),
              subjectSha256: descendant,
            },
          },
        },
      };
    });

    expect((await recovery.inspect("task-9")).action).not.toBe("record_completion");
  });

  it("rejects a merge result with reversed parent order", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const evidence = await appendThroughIntegrationObserved(testFixture, tasks);
    const sourceParent = await gitOk(testFixture.project.repositoryPath, ["rev-parse", `${evidence.sourceCommit}^`]);
    const tree = await gitOk(testFixture.project.repositoryPath, ["rev-parse", `${evidence.resultCommit}^{tree}`]);
    const reversed = await gitOk(testFixture.project.repositoryPath, [
      "commit-tree", tree, "-p", evidence.sourceCommit, "-p", sourceParent, "-m", "reversed",
    ]);
    await gitOk(testFixture.project.repositoryPath, [
      "update-ref", `refs/heads/${testFixture.project.integrationBranch}`, reversed,
    ]);
    replaceLastPayload(journal, (payload) => {
      const receipt = payload.receipt as Record<string, unknown>;
      const validation = receipt.validation as Record<string, unknown>;
      return {
        ...payload,
        receipt: {
          ...receipt,
          resultCommit: reversed,
          validation: {
            ...validation,
            provenance: {
              ...(validation.provenance as Record<string, unknown>),
              subjectSha256: reversed,
            },
          },
        },
      };
    });

    expect((await recovery.inspect("task-9")).action).not.toBe("record_completion");
  });

  it("returns a decision for invalid persisted JSON instead of rejecting", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const created = journal.readStream("task-9")[0]!;
    databaseFor(journal).prepare("UPDATE events SET payload = ? WHERE event_id = ?").run("{", created.eventId);

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      taskId: "task-9",
      action: "record_failure",
      reason: expect.stringMatching(/journal|JSON|failed closed/i),
    });
  });

  it("rejects traversal task ids before issuing filesystem-derived Git reads", async () => {
    const testFixture = await fixture();
    const git = new RecordingGitClient();
    const { recovery } = openSystem(testFixture, git);

    await expect(recovery.inspect("../outside")).resolves.toMatchObject({
      action: "record_failure",
      reason: expect.stringMatching(/task id/i),
    });
    expect(git.calls).toHaveLength(0);
  });

  it("rejects an outside durable lease alias before resolving or using that path", async () => {
    const testFixture = await fixture();
    const git = new RecordingGitClient();
    const { journal, tasks, recovery } = openSystem(testFixture, git);
    createTask(tasks);
    const lease = await leaseTask(testFixture, tasks);
    const outsideAlias = path.join(testFixture.baseDirectory, "outside-lease-alias");
    symlinkSync(lease.path, outsideAlias);
    replaceEventPayload(journal, "task.leased", (payload) => ({
      ...payload,
      workspace: outsideAlias,
    }));

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_failure",
      reason: expect.stringMatching(/durable workspace|configured ticket path/i),
    });
    expect(git.calls.every((call) => call.cwd !== outsideAlias)).toBe(true);
  });

  it("rejects noncontiguous or cross-stream event metadata", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    await leaseTask(testFixture, tasks);
    const leased = journal.readStream("task-9").at(-1)!;
    databaseFor(journal).prepare("UPDATE events SET correlation_id = ? WHERE event_id = ?").run(
      "other-correlation",
      leased.eventId,
    );

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_failure",
      reason: expect.stringMatching(/event|correlation|chain/i),
    });
  });

  it.each([
    ["wrong task", (receipt: Record<string, unknown>) => ({ ...receipt, taskId: "other" })],
    ["wrong project", (receipt: Record<string, unknown>) => ({ ...receipt, projectId: "other" })],
    ["wrong source", (receipt: Record<string, unknown>) => ({ ...receipt, sourceCommit: "a".repeat(40) })],
    ["wrong result", (receipt: Record<string, unknown>) => ({ ...receipt, resultCommit: "b".repeat(40) })],
    ["failed outcome", (receipt: Record<string, unknown>) => ({ ...receipt, outcome: "failed" })],
    ["truncated receipt", () => ({ taskId: "task-9" })],
  ])("does not complete from %s integration evidence", async (_name, mutate) => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    replaceLastPayload(journal, (payload) => ({
      ...payload,
      receipt: mutate(payload.receipt as Record<string, unknown>),
    }));

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
    });
  });

  it("rejects changed commands and inconsistent validation/review digests", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    replaceLastPayload(journal, (payload) => {
      const receipt = payload.receipt as Record<string, unknown>;
      const validation = receipt.validation as Record<string, unknown>;
      const review = receipt.review as Record<string, unknown>;
      return {
        ...payload,
        receipt: {
          ...receipt,
          validation: { ...validation, command: [process.execPath, "--version"] },
          review: { ...review, diffSha256: "c".repeat(64) },
        },
      };
    });

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
    });
  });

  it.each([
    ["review diff", "review"],
    ["validation argv", "argv"],
    ["validation output", "output"],
  ] as const)("rejects an inconsistent %s digest", async (_name, target) => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    replaceLastPayload(journal, (payload) => {
      const receipt = payload.receipt as Record<string, unknown>;
      const review = receipt.review as Record<string, unknown>;
      const validation = receipt.validation as Record<string, unknown>;
      return {
        ...payload,
        receipt: {
          ...receipt,
          review: target === "review" ? { ...review, diffSha256: "d".repeat(64) } : review,
          validation: target === "argv"
            ? { ...validation, argvSha256: "e".repeat(64) }
            : target === "output"
              ? { ...validation, outputSha256: "f".repeat(64) }
              : validation,
        },
      };
    });

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
    });
  });

  it.each(["truncated", "timed_out"] as const)(
    "rejects %s Git read evidence instead of deciding from partial state",
    async (fault) => {
      const testFixture = await fixture();
      const { tasks, recovery } = openSystem(testFixture, new FaultingReadGitClient(fault));
      createTask(tasks);

      await expect(recovery.inspect("task-9")).resolves.toMatchObject({
        action: "record_failure",
        reason: expect.stringMatching(/failed closed|truncated|termination/i),
      });
    },
  );

  it("rejects a symbolic integration ref and an externally changed integration ref", async () => {
    const testFixture = await fixture();
    const { tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    await gitOk(testFixture.project.repositoryPath, [
      "symbolic-ref",
      `refs/heads/${testFixture.project.integrationBranch}`,
      "refs/heads/main",
    ]);
    await expect(recovery.inspect("task-9")).resolves.toMatchObject({ action: "await_reconciliation" });

    await gitOk(testFixture.project.repositoryPath, ["symbolic-ref", "--delete", `refs/heads/${testFixture.project.integrationBranch}`]);
    await gitOk(testFixture.project.repositoryPath, ["branch", testFixture.project.integrationBranch, "main"]);
    await expect(recovery.inspect("task-9")).resolves.toMatchObject({ action: "await_reconciliation" });
  });

  it("rejects replacement refs before recommending completion", async () => {
    const testFixture = await fixture();
    const { tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const evidence = await appendThroughIntegrationObserved(testFixture, tasks);
    await gitOk(testFixture.project.repositoryPath, [
      "replace",
      evidence.resultCommit,
      evidence.sourceCommit,
    ]);

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/replace/i),
    });
  });

  it("rejects nonempty graft evidence before recommending completion", async () => {
    const testFixture = await fixture();
    const { tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const evidence = await appendThroughIntegrationObserved(testFixture, tasks);
    const gitDirectory = await gitOk(testFixture.project.repositoryPath, [
      "rev-parse",
      "--absolute-git-dir",
    ]);
    writeFileSync(
      path.join(gitDirectory, "info", "grafts"),
      `${evidence.resultCommit} ${evidence.sourceCommit}\n`,
      "utf8",
    );

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/graft/i),
    });
  });

  it.each(["task.commit_observed", "task.integration_observed", "task.completed"])(
    "rejects duplicate %s events instead of mixing occurrences",
    async (type) => {
      const testFixture = await fixture();
      const { journal, tasks, recovery } = openSystem(testFixture);
      createTask(tasks);
      const evidence = await appendThroughIntegrationObserved(testFixture, tasks);
      if (type === "task.commit_observed") {
        appendRawDuplicate(journal, type);
        appendRawDuplicate(journal, type);
      } else if (type === "task.integration_observed") {
        appendRawDuplicate(journal, type);
      } else {
        await recovery.recordCompletion("task-9");
        appendRawDuplicate(journal, type);
      }

      const inspected = await recovery.inspect("task-9");
      expect(inspected.action).not.toBe("record_completion");
      expect(inspected.reason).toMatch(/duplicate|more than once/i);
    },
  );

  it("fails closed when the registered worktree path contradicts durable lease evidence", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    await leaseTask(testFixture, tasks);
    const events = journal.readStream("task-9");
    const leased = events.find((event) => event.type === "task.leased")!;
    const database = (journal as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db;
    database.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(
      JSON.stringify({ leaseOwner: "worker-1", workspace: path.join(testFixture.project.worktreeRoot, "other") }),
      leased.eventId,
    );

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_failure",
      reason: expect.stringMatching(/worktree|workspace|path/i),
    });
  });

  it("rejects extra fields in strict Task 8 payloads", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    await leaseTask(testFixture, tasks);
    replaceEventPayload(journal, "task.leased", (payload) => ({
      ...payload,
      unexpected: "not allowed",
    }));

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_failure",
      reason: expect.stringMatching(/task\.leased|event chain/i),
    });
  });

  it("is read-only and uses only bounded hardened Git reads", async () => {
    const testFixture = await fixture();
    const git = new RecordingGitClient();
    const { journal, tasks, recovery } = openSystem(testFixture, git);
    createTask(tasks);
    const evidence = await appendThroughIntegrationObserved(testFixture, tasks);
    const eventCount = journal.readStream("task-9").length;
    const worktreeBefore = readFileSync(path.join(evidence.lease.path, "greeting.txt"), "utf8");
    const indexPath = await gitOk(evidence.lease.path, [
      "rev-parse", "--path-format=absolute", "--git-path", "index",
    ]);
    const indexBefore = existsSync(indexPath)
      ? createHash("sha256").update(readFileSync(indexPath)).digest("hex")
      : null;
    const refsBefore = await gitOk(testFixture.project.repositoryPath, [
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
    ]);
    const registrationsBefore = await gitOk(testFixture.project.repositoryPath, [
      "worktree", "list", "--porcelain",
    ]);
    const objectsBefore = await gitOk(testFixture.project.repositoryPath, ["count-objects", "-v"]);

    await recovery.inspect("task-9");

    expect(journal.readStream("task-9")).toHaveLength(eventCount);
    expect(readFileSync(path.join(evidence.lease.path, "greeting.txt"), "utf8")).toBe(worktreeBefore);
    expect(existsSync(indexPath)
      ? createHash("sha256").update(readFileSync(indexPath)).digest("hex")
      : null).toBe(indexBefore);
    expect(await gitOk(testFixture.project.repositoryPath, [
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
    ])).toBe(refsBefore);
    expect(await gitOk(testFixture.project.repositoryPath, [
      "worktree", "list", "--porcelain",
    ])).toBe(registrationsBefore);
    expect(await gitOk(testFixture.project.repositoryPath, ["count-objects", "-v"])).toBe(objectsBefore);
    expect(git.calls.length).toBeGreaterThan(0);
    for (const call of git.calls) {
      expect(call.options.timeoutMs).toBeGreaterThan(0);
      expect(call.args).toContain("--no-optional-locks");
      expect(call.args).toContain("--no-replace-objects");
      const commandIndex = call.args.findIndex((argument) => !["--no-optional-locks", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "core.fsmonitor=false"].includes(argument));
      const command = call.args.slice(commandIndex);
      expect(command[0]).not.toMatch(/^(add|commit|merge|update-ref|branch|switch|checkout|clean|reset)$/);
      expect(command.slice(0, 2)).not.toEqual(["worktree", "remove"]);
    }
    const diffReads = git.calls.filter((call) => call.args.includes("diff"));
    expect(diffReads.length).toBeGreaterThan(0);
    for (const call of diffReads) {
      expect(call.args).toContain("--no-ext-diff");
      expect(call.args).toContain("--no-textconv");
    }
  });

  it("leaves a failed dirty worktree untouched", async () => {
    const testFixture = await fixture();
    const { tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const lease = await leaseTask(testFixture, tasks);
    tasks.append("task-9", "task.failed", { reason: "worker failed" }, null);
    writeFileSync(path.join(lease.path, "greeting.txt"), "failure evidence\n", "utf8");

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/terminal.*no-op|already.*no-op/i),
    });
    expect(readFileSync(path.join(lease.path, "greeting.txt"), "utf8")).toBe("failure evidence\n");
  });

  it("does not recommend duplicate completion after the caller records completion once", async () => {
    const testFixture = await fixture();
    const { tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    expect((await recovery.inspect("task-9")).action).toBe("record_completion");

    const completed = await recovery.recordCompletion("task-9");
    expect(completed).toMatchObject({
      lifecycle: "terminal",
      terminalOutcome: "completed",
    });
    await expect(recovery.recordCompletion("task-9")).resolves.toEqual(completed);

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/already.*completed.*no-op|terminal.*no-op/i),
    });
  });

  it.each([
    "integration_prepared",
    "integration_observed",
    "cleanup_started",
    "cleanup_observed",
    "cleanup_reconciled",
    "cleanup_completed",
  ] as const)("applies authorized %s completion through the effectful CLI exactly once", async (completionPath) => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    createTask(first.tasks);
    await appendAtCompletionPath(testFixture, first.tasks, completionPath);
    closeJournal(first.journal);

    const inspection = await invokeRecoveryCli(testFixture, "recover");
    expect(inspection).toMatchObject({
      code: 0,
      json: { command: "recover", decision: { action: "record_completion" } },
    });
    const beforeApply = new SqliteEventJournal(testFixture.databasePath, { readOnly: true });
    expect(beforeApply.readStream("task-9").some((event) => event.type === "task.completed")).toBe(false);
    beforeApply.close();

    const applied = await invokeRecoveryCli(testFixture, "recover-apply");
    expect(applied).toMatchObject({
      code: 0,
      json: {
        command: "recover-apply",
        task: { taskId: "task-9", lifecycle: "terminal", terminalOutcome: "completed" },
      },
    });
    const repeated = await invokeRecoveryCli(testFixture, "recover-apply");
    expect(repeated).toEqual(applied);

    const replay = new SqliteEventJournal(testFixture.databasePath, { readOnly: true });
    expect(replay.readStream("task-9").filter((event) => event.type === "task.completed")).toHaveLength(1);
    replay.close();
  });

  it("fails closed through the recovery CLI for unknown and non-completion tasks", async () => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    createTask(first.tasks);
    const before = first.journal.readStream("task-9");
    closeJournal(first.journal);

    const unsupported = await invokeRecoveryCli(testFixture, "recover-apply");
    expect(unsupported).toMatchObject({
      code: 1,
      json: {
        command: "recover-apply",
        error: {
          code: "RECOVERY_NOT_AUTHORIZED",
          message: "Recovery completion is not authorized.",
        },
      },
    });
    const replay = new SqliteEventJournal(testFixture.databasePath, { readOnly: true });
    expect(replay.readStream("task-9")).toEqual(before);
    replay.close();

    let stdout = "";
    let stderr = "";
    const code = await runCli([
      "recover-apply",
      "--config", writeRecoveryConfig(testFixture),
      "--database", testFixture.databasePath,
      "--task-id", "missing",
    ], {
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    expect(code).toBe(1);
    expect(JSON.parse(`${stdout}${stderr}`)).toMatchObject({
      command: "recover-apply",
      error: { code: "TASK_NOT_FOUND" },
    });
  });

  it("allows only one concurrent CLI applicator to append terminal completion", async () => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    createTask(first.tasks);
    await appendThroughIntegrationObserved(testFixture, first.tasks);
    closeJournal(first.journal);

    const results = await Promise.all([
      invokeRecoveryCli(testFixture, "recover-apply"),
      invokeRecoveryCli(testFixture, "recover-apply"),
    ]);
    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.filter((result) => result.code === 1)).toHaveLength(1);
    expect(results.find((result) => result.code === 1)?.json).toMatchObject({
      error: { code: "RECOVERY_NOT_AUTHORIZED" },
    });
    const replay = new SqliteEventJournal(testFixture.databasePath, { readOnly: true });
    expect(replay.readStream("task-9").filter((event) => event.type === "task.completed")).toHaveLength(1);
    replay.close();
  });

  it("rejects a task.completed receipt that contradicts the verified observation", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    await recovery.recordCompletion("task-9");
    replaceEventPayload(journal, "task.completed", (payload) => ({
      ...payload,
      receipt: {
        ...(payload.receipt as Record<string, unknown>),
        projectId: "other-project",
      },
    }));

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/completed receipt|event chain/i),
    });
  });

  it("allows only one concurrent completion applicator to record terminal completion", async () => {
    const baseFixture = await fixture();
    let cleanupCalls = 0;
    class CountingWorktrees extends WorktreeManager {
      override async cleanupCompleted(
        ...args: Parameters<WorktreeManager["cleanupCompleted"]>
      ): Promise<void> {
        cleanupCalls += 1;
        return super.cleanupCompleted(...args);
      }
    }
    const testFixture: Fixture = {
      ...baseFixture,
      worktrees: new CountingWorktrees(),
    };
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);

    const [first, second] = await Promise.all([
      recovery.inspect("task-9"),
      recovery.inspect("task-9"),
    ]);
    expect(first.action).toBe("record_completion");
    expect(second.action).toBe("record_completion");

    const applications = await Promise.allSettled([
      recovery.recordCompletion("task-9"),
      recovery.recordCompletion("task-9"),
    ]);
    expect(applications.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(cleanupCalls).toBe(1);
    expect(journal.readStream("task-9").filter((event) => event.type === "task.completed")).toHaveLength(1);
    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/already.*completed|terminal/i),
    });
  });

  it("records cleanup completion after a crash left cleanup_started with both ticket states absent", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const evidence = await appendThroughIntegrationObserved(testFixture, tasks);
    tasks.append("task-9", "task.cleanup_started", {
      sourceCommit: evidence.sourceCommit,
      resultCommit: evidence.resultCommit,
      workspace: evidence.lease.path,
      branch: evidence.lease.branch,
    }, null);
    await testFixture.worktrees.cleanupCompleted(
      testFixture.project,
      evidence.lease,
      evidence.sourceCommit,
      { timeoutMs: 10_000 },
    );

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_completion",
    });
    await expect(recovery.recordCompletion("task-9")).resolves.toMatchObject({
      lifecycle: "terminal",
      terminalOutcome: "completed",
    });
    expect(journal.readStream("task-9").map((event) => event.type).slice(-2)).toEqual([
      "task.cleanup_completed",
      "task.completed",
    ]);
  });

  it("excludes another completion applicator while an authorized caller holds the durable lease", async () => {
    const baseFixture = await fixture();
    let releaseCleanup!: () => void;
    let reportCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { reportCleanupStarted = resolve; });
    const cleanupRelease = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    class GatedWorktrees extends WorktreeManager {
      override async cleanupCompleted(
        ...args: Parameters<WorktreeManager["cleanupCompleted"]>
      ): Promise<void> {
        reportCleanupStarted();
        await cleanupRelease;
        return super.cleanupCompleted(...args);
      }
    }
    const testFixture: Fixture = { ...baseFixture, worktrees: new GatedWorktrees() };
    const { journal, tasks, recovery: callerA } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    let releaseAuthorization!: () => void;
    let reportAuthorized!: () => void;
    const authorized = new Promise<void>((resolve) => { reportAuthorized = resolve; });
    const authorizationRelease = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    class PausedAfterAuthorizationRecovery extends RecoveryService {
      override async inspect(taskId: string): Promise<RecoveryDecision> {
        const result = await super.inspect(taskId);
        if (result.action === "record_completion") {
          reportAuthorized();
          await authorizationRelease;
        }
        return result;
      }
    }
    const callerB = new PausedAfterAuthorizationRecovery(
      journal,
      tasks,
      testFixture.registry,
      testFixture.worktrees,
      new GitClient(),
    );

    const staleApplication = callerB.recordCompletion("task-9");
    await authorized;
    const competingApplication = callerA.recordCompletion("task-9");
    await expect(competingApplication).rejects.toThrow(/lease is held by another owner/i);
    releaseAuthorization();
    try {
      await cleanupStarted;
    } finally {
      releaseCleanup();
    }
    await expect(staleApplication).resolves.toMatchObject({
      lifecycle: "terminal",
      terminalOutcome: "completed",
    });
    expect(journal.readStream("task-9").filter((event) =>
      event.type === "task.completed")).toHaveLength(1);
  });

  it("reconciles cleanup_observed from exact absent targets without retrying cleanup", async () => {
    const testFixture = await fixture();
    const { journal, tasks } = openSystem(testFixture);
    createTask(tasks);
    const evidence = await appendThroughIntegrationObserved(testFixture, tasks);
    const cleanup = {
      sourceCommit: evidence.sourceCommit,
      resultCommit: evidence.resultCommit,
      workspace: evidence.lease.path,
      branch: evidence.lease.branch,
    };
    const observation = {
      phase: "ref_deletion",
      uncertain: true,
      evidence: { taskId: "task-9", sourceCommit: evidence.sourceCommit },
      reason: "cleanup acknowledgement was lost",
    };
    tasks.append("task-9", "task.cleanup_started", cleanup, null);
    tasks.append("task-9", "task.cleanup_observed", observation, null);
    await testFixture.worktrees.cleanupCompleted(
      testFixture.project,
      evidence.lease,
      evidence.sourceCommit,
      { timeoutMs: 10_000 },
    );
    let cleanupRetries = 0;
    class NoRetryWorktrees extends WorktreeManager {
      override cleanupCompleted(): Promise<void> {
        cleanupRetries += 1;
        throw new Error("cleanup must not retry");
      }
    }
    const recovery = new RecoveryService(
      journal,
      tasks,
      testFixture.registry,
      new NoRetryWorktrees(),
      new GitClient(),
    );

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_completion",
    });
    await expect(recovery.recordCompletion("task-9")).resolves.toMatchObject({
      lifecycle: "terminal",
      terminalOutcome: "completed",
    });
    expect(cleanupRetries).toBe(0);
    expect(journal.readStream("task-9").map((event) => event.type).slice(-2)).toEqual([
      "task.cleanup_reconciled",
      "task.completed",
    ]);
  });

  it("finishes exactly once after a crash following cleanup reconciliation", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const evidence = await appendThroughIntegrationObserved(testFixture, tasks);
    const cleanup = {
      sourceCommit: evidence.sourceCommit,
      resultCommit: evidence.resultCommit,
      workspace: evidence.lease.path,
      branch: evidence.lease.branch,
    };
    const observation = {
      phase: "ref_deletion",
      uncertain: true,
      evidence: {},
      reason: "unknown",
    };
    tasks.append("task-9", "task.cleanup_started", cleanup, null);
    tasks.append("task-9", "task.cleanup_observed", observation, null);
    await testFixture.worktrees.cleanupCompleted(
      testFixture.project,
      evidence.lease,
      evidence.sourceCommit,
      { timeoutMs: 10_000 },
    );
    tasks.append("task-9", "task.cleanup_reconciled", { cleanup, observation }, null);

    await expect(recovery.inspect("task-9")).resolves.toMatchObject({
      action: "record_completion",
    });
    const applications = await Promise.allSettled([
      recovery.recordCompletion("task-9"),
      recovery.recordCompletion("task-9"),
    ]);
    expect(applications.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(journal.readStream("task-9").filter((event) =>
      event.type === "task.cleanup_reconciled")).toHaveLength(1);
    expect(journal.readStream("task-9").filter((event) =>
      event.type === "task.completed")).toHaveLength(1);
  });

  it.each([
    "integration_prepared",
    "integration_observed",
    "cleanup_started",
    "cleanup_observed",
    "cleanup_reconciled",
    "cleanup_completed",
  ] as const)("pauses deterministically after fresh %s authorization", async (completionPath) => {
    const testFixture = await fixture();
    const first = openSystem(testFixture);
    createTask(first.tasks);
    await appendAtCompletionPath(testFixture, first.tasks, completionPath);
    let releases = 0;
    let observed = false;
    const recovery = new RecoveryService(
      first.journal,
      first.tasks,
      testFixture.registry,
      testFixture.worktrees,
      new GitClient(),
      {
        completionHooks: {
          async afterAuthorization(path) {
            if (path !== completionPath || observed) return;
            observed = true;
            await new Promise<void>((resolve) => {
              releases += 1;
              resolve();
            });
          },
        },
      },
    );

    await expect(recovery.recordCompletion("task-9")).resolves.toMatchObject({
      lifecycle: "terminal",
      terminalOutcome: "completed",
    });
    expect(observed).toBe(true);
    expect(releases).toBe(1);
  });

  it("rejects an integration ref race after authorization with no completion append", async () => {
    const testFixture = await fixture();
    const { journal, tasks } = openSystem(testFixture);
    createTask(tasks);
    const evidence = await appendThroughIntegrationObserved(testFixture, tasks);
    const before = journal.readStream("task-9").length;
    const recovery = new RecoveryService(journal, tasks, testFixture.registry, testFixture.worktrees,
      new GitClient(), { completionHooks: { async afterAuthorization(pathName) {
        if (pathName === "integration_observed") {
          await gitOk(testFixture.project.repositoryPath, [
            "update-ref", `refs/heads/${testFixture.project.integrationBranch}`,
            evidence.receipt.originalIntegrationCommit as string,
          ]);
        }
      } } });

    await expect(recovery.recordCompletion("task-9")).rejects.toThrow(/evidence changed/i);
    expect(journal.readStream("task-9")).toHaveLength(before);
  });

  it("rejects a worktree race after authorization with no completion append", async () => {
    const testFixture = await fixture();
    const { journal, tasks } = openSystem(testFixture);
    createTask(tasks);
    const evidence = await appendThroughIntegrationObserved(testFixture, tasks);
    const before = journal.readStream("task-9").length;
    const recovery = new RecoveryService(journal, tasks, testFixture.registry, testFixture.worktrees,
      new GitClient(), { completionHooks: { afterAuthorization(pathName) {
        if (pathName === "integration_observed") {
          writeFileSync(path.join(evidence.lease.path, "greeting.txt"), "raced\n", "utf8");
        }
      } } });

    await expect(recovery.recordCompletion("task-9")).rejects.toThrow(/evidence changed/i);
    expect(journal.readStream("task-9")).toHaveLength(before);
  });

  it("rejects a journal race after authorization with no recovery completion append", async () => {
    const testFixture = await fixture();
    const { journal, tasks } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    const recovery = new RecoveryService(journal, tasks, testFixture.registry, testFixture.worktrees,
      new GitClient(), { completionHooks: { afterAuthorization(pathName) {
        if (pathName === "integration_observed") {
          const events = journal.readStream("task-9");
          journal.append("task-9", events.at(-1)!.streamVersion, [{
            streamId: "task-9",
            type: "task.recovery_race",
            payload: { reason: "independent writer" },
            causationId: null,
            correlationId: events[0]!.correlationId,
          }]);
        }
      } } });

    await expect(recovery.recordCompletion("task-9")).rejects.toThrow(/evidence changed/i);
    expect(journal.readStream("task-9").filter((event) =>
      event.type.startsWith("task.cleanup_") || event.type === "task.completed")).toHaveLength(0);
  });

  it("rejects lease replacement after authorization with no completion append", async () => {
    const testFixture = await fixture();
    const { journal, tasks } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    const before = journal.readStream("task-9").length;
    const recovery = new RecoveryService(journal, tasks, testFixture.registry, testFixture.worktrees,
      new GitClient(), { completionHooks: { afterAuthorization(pathName, authorization) {
        if (pathName !== "integration_observed") return;
        const store = new IntegrationLeaseStore(path.join(
          authorization.commonDirectory,
          ".zentra-integration-leases.sqlite",
        ));
        expect(store.release(authorization.lease)).toBe(true);
        expect(store.acquire(authorization.lease, 10_000, authorization.issuedAt)).not.toBeNull();
        store.close();
      } } });

    await expect(recovery.recordCompletion("task-9")).rejects.toThrow(/lease changed or expired/i);
    expect(journal.readStream("task-9")).toHaveLength(before);
  });

  it("rejects an expired short-lived authorization with no completion append", async () => {
    const testFixture = await fixture();
    const { journal, tasks } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    const before = journal.readStream("task-9").length;
    let now = Date.now();
    const recovery = new RecoveryService(journal, tasks, testFixture.registry, testFixture.worktrees,
      new GitClient(), {
        now: () => now,
        authorizationTtlMs: 10,
        completionHooks: { afterAuthorization(pathName) {
          if (pathName === "integration_observed") now += 10;
        } },
      });

    await expect(recovery.recordCompletion("task-9")).rejects.toThrow(/authorization expired/i);
    expect(journal.readStream("task-9")).toHaveLength(before);
  });

  it("serializes independent journals through the shared repository lease", async () => {
    const testFixture = await fixture();
    const setup = openSystem(testFixture);
    createTask(setup.tasks);
    await appendThroughIntegrationObserved(testFixture, setup.tasks);
    closeJournal(setup.journal);
    const secondDatabase = path.join(testFixture.baseDirectory, "independent.sqlite");
    copyFileSync(testFixture.databasePath, secondDatabase);
    const independentFixture = { ...testFixture, databasePath: secondDatabase };
    let release!: () => void;
    let authorized!: () => void;
    const authorizationReached = new Promise<void>((resolve) => { authorized = resolve; });
    const authorizationRelease = new Promise<void>((resolve) => { release = resolve; });
    const first = openSystem(testFixture, new GitClient(), { completionHooks: {
      async afterAuthorization(pathName) {
        if (pathName !== "integration_observed") return;
        authorized();
        await authorizationRelease;
      },
    } });
    const second = openSystem(independentFixture);

    const active = first.recovery.recordCompletion("task-9");
    await authorizationReached;
    await expect(second.recovery.recordCompletion("task-9")).rejects.toThrow(/lease is held/i);
    expect(second.journal.readStream("task-9").some((event) => event.type === "task.completed")).toBe(false);
    release();
    await expect(active).resolves.toMatchObject({ lifecycle: "terminal", terminalOutcome: "completed" });
  });

  it("renews a short durable lease throughout delayed recovery inspection", async () => {
    const testFixture = await fixture();
    const setup = openSystem(testFixture);
    createTask(setup.tasks);
    await appendThroughIntegrationObserved(testFixture, setup.tasks);
    let inspectionStarted!: () => void;
    const started = new Promise<void>((resolve) => { inspectionStarted = resolve; });
    const delayedGit = new DelayedGitClient(
      (args) => args.includes("worktree") && args.includes("list"),
      700,
      inspectionStarted,
    );
    const recovery = new RecoveryService(
      setup.journal,
      setup.tasks,
      testFixture.registry,
      testFixture.worktrees,
      delayedGit,
      { integrationLeaseMs: 300, integrationLeaseRenewalMs: 50 },
    );

    const application = recovery.recordCompletion("task-9");
    await started;
    await delay(450);
    const commonDirectory = realpathSync(await gitOk(testFixture.project.repositoryPath, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]));
    const competitor = new IntegrationLeaseStore(path.join(commonDirectory, ".zentra-integration-leases.sqlite"));
    expect(competitor.acquire({
      commonDirectory,
      integrationRef: `refs/heads/${testFixture.project.integrationBranch}`,
    }, 300)).toBeNull();
    competitor.close();

    await expect(application).resolves.toMatchObject({ lifecycle: "terminal", terminalOutcome: "completed" });
  });

  it("renews a short durable lease while effectful cleanup is delayed", async () => {
    const baseFixture = await fixture();
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const delayedGit = new DelayedGitClient(
      (args) => args.includes("worktree") && args.includes("remove"),
      700,
      cleanupStarted,
    );
    const testFixture: Fixture = { ...baseFixture, worktrees: new WorktreeManager(delayedGit) };
    const { tasks, recovery } = openSystem(testFixture, new GitClient(), {
      integrationLeaseMs: 300,
      integrationLeaseRenewalMs: 50,
    });
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);

    const application = recovery.recordCompletion("task-9");
    await started;
    await delay(450);
    const commonDirectory = realpathSync(await gitOk(testFixture.project.repositoryPath, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]));
    const competitor = new IntegrationLeaseStore(path.join(commonDirectory, ".zentra-integration-leases.sqlite"));
    expect(competitor.acquire({
      commonDirectory,
      integrationRef: `refs/heads/${testFixture.project.integrationBranch}`,
    }, 300)).toBeNull();
    competitor.close();

    await expect(application).resolves.toMatchObject({ lifecycle: "terminal", terminalOutcome: "completed" });
    expect(delayedGit.signalObserved).toBe(true);
  });

  it("aborts delayed cleanup after lease loss without further Git mutation or completion append", async () => {
    const baseFixture = await fixture();
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const delayedGit = new DelayedGitClient(
      (args) => args.includes("worktree") && args.includes("remove"),
      5_000,
      cleanupStarted,
    );
    const testFixture: Fixture = { ...baseFixture, worktrees: new WorktreeManager(delayedGit) };
    const { journal, tasks, recovery } = openSystem(testFixture, new GitClient(), {
      integrationLeaseMs: 300,
      integrationLeaseRenewalMs: 50,
    });
    createTask(tasks);
    const evidence = await appendThroughIntegrationObserved(testFixture, tasks);
    const integrationBefore = await gitOk(testFixture.project.repositoryPath, [
      "rev-parse", `refs/heads/${testFixture.project.integrationBranch}`,
    ]);

    const application = recovery.recordCompletion("task-9");
    await started;
    const commonDirectory = realpathSync(await gitOk(testFixture.project.repositoryPath, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]));
    const key = {
      commonDirectory,
      integrationRef: `refs/heads/${testFixture.project.integrationBranch}`,
    };
    const thief = new IntegrationLeaseStore(path.join(commonDirectory, ".zentra-integration-leases.sqlite"));
    const held = thief.read(key)!;
    expect(thief.release(held)).toBe(true);
    expect(thief.acquire(key, 1_000)).not.toBeNull();

    await expect(application).rejects.toThrow(/lease authority was lost|lease changed or expired/i);
    expect(delayedGit.signalObserved).toBe(true);
    expect(existsSync(evidence.lease.path)).toBe(true);
    expect(await gitOk(testFixture.project.repositoryPath, [
      "rev-parse", `refs/heads/${evidence.lease.branch}`,
    ])).toBe(evidence.sourceCommit);
    expect(await gitOk(testFixture.project.repositoryPath, [
      "rev-parse", `refs/heads/${testFixture.project.integrationBranch}`,
    ])).toBe(integrationBefore);
    expect(journal.readStream("task-9").filter((event) => [
      "task.cleanup_observed",
      "task.cleanup_completed",
      "task.completed",
    ].includes(event.type))).toHaveLength(0);
    thief.close();
  });

  it("contains a thrown renewal callback, aborts cleanup, and appends no completion result", async () => {
    const baseFixture = await fixture();
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    let throwRenew = false;
    const delayedGit = new DelayedGitClient(
      (args) => args.includes("worktree") && args.includes("remove"),
      5_000,
      () => {
        throwRenew = true;
        cleanupStarted();
      },
    );
    const testFixture: Fixture = { ...baseFixture, worktrees: new WorktreeManager(delayedGit) };
    const { journal, tasks, recovery } = openSystem(testFixture, new GitClient(), {
      integrationLeaseMs: 300,
      integrationLeaseRenewalMs: 50,
      integrationLeaseStoreFactory: (commonDirectory) => new InjectedRenewFailureStore(
        path.join(commonDirectory, ".zentra-integration-leases.sqlite"),
        () => throwRenew,
      ),
    });
    createTask(tasks);
    const evidence = await appendThroughIntegrationObserved(testFixture, tasks);

    const application = recovery.recordCompletion("task-9");
    await started;

    await expect(application).rejects.toThrow(/lease authority was lost.*injected recovery lease renewal failure/i);
    expect(delayedGit.signalObserved).toBe(true);
    expect(existsSync(evidence.lease.path)).toBe(true);
    expect(await gitOk(testFixture.project.repositoryPath, [
      "rev-parse", `refs/heads/${evidence.lease.branch}`,
    ])).toBe(evidence.sourceCommit);
    expect(journal.readStream("task-9").filter((event) => [
      "task.cleanup_observed",
      "task.cleanup_completed",
      "task.completed",
    ].includes(event.type))).toHaveLength(0);
  });

  it("does not replace a primary completion error when lease release throws", async () => {
    const testFixture = await fixture();
    const { journal, tasks } = openSystem(testFixture);
    createTask(tasks);
    await appendThroughIntegrationObserved(testFixture, tasks);
    const before = journal.readStream("task-9").length;
    const recovery = new RecoveryService(
      journal,
      tasks,
      testFixture.registry,
      testFixture.worktrees,
      new GitClient(),
      {
        integrationLeaseStoreFactory: (commonDirectory) => new InjectedReleaseFailureStore(
          path.join(commonDirectory, ".zentra-integration-leases.sqlite"),
        ),
        completionHooks: {
          afterAuthorization() {
            throw new Error("primary injected completion failure");
          },
        },
      },
    );

    await expect(recovery.recordCompletion("task-9")).rejects.toThrow("primary injected completion failure");
    expect(journal.readStream("task-9")).toHaveLength(before);
  });

  it("returns record_failure for a missing task because recovery cannot reconstruct it", async () => {
    const testFixture = await fixture();
    const { recovery } = openSystem(testFixture);

    await expect(recovery.inspect("missing")).resolves.toMatchObject({
      taskId: "missing",
      action: "record_failure",
      reason: expect.stringMatching(/diagnostic.*not found|not found.*diagnostic/i),
    });
  });

  it("refuses completion application when a fresh inspection does not authorize it", async () => {
    const testFixture = await fixture();
    const { journal, tasks, recovery } = openSystem(testFixture);
    createTask(tasks);
    const before = journal.readStream("task-9");

    await expect(recovery.recordCompletion("task-9")).rejects.toThrow(
      /not authorized: resume_preparation/i,
    );
    expect(journal.readStream("task-9")).toEqual(before);
  });
});
