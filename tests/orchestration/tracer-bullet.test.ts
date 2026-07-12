import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ValidationRunner,
  type ValidationReport,
} from "../../src/capabilities/validation-runner.js";
import {
  IntegrationExecutionError,
  IntegrationUncertainError,
  IntegrationQueue,
  type CleanupFailure,
  type IntegrationReceipt,
} from "../../src/integration/integration-queue.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { RecoveryService } from "../../src/orchestration/recovery.js";
import { TracerBulletOrchestrator } from "../../src/orchestration/tracer-bullet.js";
import type { ProjectConfig } from "../../src/projects/project-config.js";
import { ProjectRegistry } from "../../src/projects/project-registry.js";
import { ReviewGate } from "../../src/reviews/review-gate.js";
import {
  canonicalValidationDigest,
  ReviewerExecutionError,
  type ReviewDecision,
  type ReviewerAdapter,
  type ReviewInput,
} from "../../src/reviews/reviewer-adapter.js";
import { DeterministicReviewerAdapter } from "../support/deterministic-reviewer-adapter.js";
import { TaskService } from "../../src/tasks/task-service.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import type {
  WorkerAdapter,
  WorkerRequest,
  WorkerResult,
} from "../../src/workers/worker-adapter.js";
import {
  GitClient,
  type CommandResult,
  type GitRunOptions,
} from "../../src/workspaces/git-client.js";
import {
  WorkspaceCleanupError,
  WorkspaceGitTerminationError,
  WorkspaceCommitUncertainError,
  WorktreeManager,
  type WorkspaceLease,
} from "../../src/workspaces/worktree-manager.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string): string => {
  const candidates = [
    path.resolve(here, "../../fixtures", name),
    path.resolve(here, "../../../fixtures", name),
  ];
  const candidate = candidates.find(existsSync);
  if (candidate === undefined) throw new Error(`fixture not found: ${name}`);
  return candidate;
};
const workerFixture = fixturePath("deterministic-worker.mjs");
const reviewerFixture = path.resolve(here, "../fixtures/deterministic-reviewer.mjs");
const temporaryDirectories: string[] = [];
const journals: SqliteEventJournal[] = [];

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 25,
    });
  }
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const result = await new GitClient().run(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function fixtureRepository(): Promise<{
  baseDirectory: string;
  repositoryPath: string;
  worktreeRoot: string;
  configPath: string;
}> {
  const baseDirectory = mkdtempSync(path.join(tmpdir(), "zentra-tracer-"));
  temporaryDirectories.push(baseDirectory);
  const repositoryPath = path.join(baseDirectory, "repository");
  const worktreeRoot = path.join(baseDirectory, "worktrees");
  const configPath = path.join(repositoryPath, "zentra.project.json");

  await gitOk(baseDirectory, ["init", "-b", "main", repositoryPath]);
  await gitOk(repositoryPath, ["config", "user.name", "Zentra Fixture"]);
  await gitOk(repositoryPath, [
    "config",
    "user.email",
    "fixture@zentra.local",
  ]);
  mkdirSync(path.join(repositoryPath, "test"));
  writeFileSync(path.join(repositoryPath, "greeting.txt"), "hello\n", "utf8");
  writeFileSync(
    path.join(repositoryPath, "test/greeting.test.mjs"),
    `import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\n\ntest("greeting", async () => {\n  assert.equal(await readFile(new URL("../greeting.txt", import.meta.url), "utf8"), "hello from Zentra\\n");\n});\n`,
    "utf8",
  );
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        projectId: "greeting-project",
        repositoryPath,
        integrationBranch: "zentra/integration",
        worktreeRoot,
        validations: {
          focused: [process.execPath, "--test", "test/greeting.test.mjs"],
          full: [process.execPath, "--test"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await gitOk(repositoryPath, ["add", "--", "."]);
  await gitOk(repositoryPath, ["commit", "-m", "initial fixture"]);
  return { baseDirectory, repositoryPath, worktreeRoot, configPath };
}

interface SystemOverrides {
  readonly worker?: WorkerAdapter;
  readonly validations?: ValidationRunner;
  readonly reviewer?: ReviewerAdapter;
  readonly worktrees?: WorktreeManager;
  readonly integrations?: IntegrationQueue;
}

function system(configPath: string, overrides: SystemOverrides = {}) {
  const journal = new SqliteEventJournal(":memory:");
  journals.push(journal);
  const supervisor = new ProcessSupervisor();
  const validations = overrides.validations ?? new ValidationRunner(supervisor);
  const worktrees = overrides.worktrees ?? new WorktreeManager();
  const tasks = new TaskService(journal);
  const orchestrator = new TracerBulletOrchestrator(
    tasks,
    ProjectRegistry.fromFile(configPath),
    worktrees,
    overrides.worker ?? new ProcessSupervisor(),
    validations,
    overrides.reviewer ?? new DeterministicReviewerAdapter(supervisor, reviewerFixture),
    new ReviewGate(),
    overrides.integrations ?? new IntegrationQueue(new GitClient(), validations),
  );
  return { journal, orchestrator, tasks };
}

function validationReport(
  project: ProjectConfig,
  name: "focused" | "full",
  outcome: ValidationReport["outcome"],
): ValidationReport {
  const command = [...project.validations[name]];
  const stdout = outcome === "completed" ? `${name} passed` : "";
  const stderr = outcome === "completed" ? "" : `${name} ${outcome}`;
  return {
    name,
    outcome,
    exitCode: outcome === "completed" ? 0 : null,
    stdout,
    stderr,
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:00:01.000Z",
    command,
    argvSha256: sha256(JSON.stringify(command)),
    outputSha256: sha256(JSON.stringify({ stdout, stderr })),
    provenance: {
      invocationId: `tracer-fixture-${name}`,
      canonicalCwd: project.repositoryPath,
      subjectSha256: null,
    },
  };
}

function decision(input: ReviewInput, approved: boolean): ReviewDecision {
  return {
    reviewerId: input.reviewerId,
    approved,
    diffSha256: sha256(input.diff),
    validationSha256: canonicalValidationDigest(input.validation),
    decidedAt: "2026-07-12T00:00:02.000Z",
    reason: approved ? "approved" : "rejected",
  };
}

const runInput = {
  taskId: "task-greeting",
  projectId: "greeting-project",
  title: "Update greeting",
  workerId: "worker-1",
  reviewerId: "reviewer-1",
  workerRequest: {
    executable: process.execPath,
    args: [
      workerFixture,
      "--file",
      "greeting.txt",
      "--content",
      "hello from Zentra\n",
    ],
    timeoutMs: 10_000,
  },
} as const;

function runSignal(): AbortSignal {
  return AbortSignal.timeout(20_000);
}

describe("TracerBulletOrchestrator", () => {
  it("executes all 13 workflow steps and replays the evidence-backed terminal view", async () => {
    const fixture = await fixtureRepository();
    const { journal, orchestrator, tasks } = system(fixture.configPath);

    const result = await orchestrator.run({ ...runInput, signal: runSignal() });

    expect(result).toEqual({
      taskId: "task-greeting",
      projectId: "greeting-project",
      title: "Update greeting",
      lifecycle: "terminal",
      terminalOutcome: "completed",
      streamVersion: 12,
      leaseOwner: "worker-1",
    });
    expect(tasks.get("task-greeting")).toEqual(result);
    expect(
      await gitOk(fixture.repositoryPath, [
        "show",
        "zentra/integration:greeting.txt",
      ]),
    ).toBe("hello from Zentra");

    const events = journal.readStream("task-greeting");
    expect(events.map((event) => event.type)).toEqual([
      "task.created",
      "task.leased",
      "task.started",
      "task.validation_started",
      "task.review_requested",
      "task.review_approved",
      "task.integration_started",
      "task.integration_prepared",
      "task.integration_observed",
      "task.cleanup_started",
      "task.cleanup_completed",
      "task.completed",
    ]);
    expect(events[3]?.payload).toMatchObject({
      patch: { path: "greeting.txt", sha256: sha256("hello from Zentra\n") },
      diffSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(events[4]?.payload).toMatchObject({
      validation: { name: "focused", outcome: "completed", exitCode: 0 },
    });
    const approved = events[5]?.payload as { review: unknown };
    expect(events[8]?.payload).toMatchObject({
      verification: "verified",
      receipt: { outcome: "completed" },
      cleanupFailures: [],
    });
    const completed = events[11]?.payload as {
      receipt: { outcome: string; resultCommit: string; review: unknown };
    };
    expect(completed.receipt).toMatchObject({
      outcome: "completed",
      resultCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(completed.receipt.review).toEqual(approved.review);
    expect(completed.receipt.resultCommit).toBe(
      await gitOk(fixture.repositoryPath, [
        "rev-parse",
        "refs/heads/zentra/integration",
      ]),
    );
    expect(existsSync(path.join(fixture.worktreeRoot, runInput.taskId))).toBe(false);
    const ticketRef = await new GitClient().run(fixture.repositoryPath, [
      "show-ref",
      "--verify",
      `refs/heads/ticket/${runInput.taskId}`,
    ]);
    expect(ticketRef.exitCode).not.toBe(0);
  });

  it("completes when integration advances after the ticket source was created", async () => {
    const fixture = await fixtureRepository();
    const validations = new ValidationRunner(new ProcessSupervisor());
    const delegate = new IntegrationQueue(new GitClient(), validations);
    let baseB = "";
    class AdvancingIntegration extends IntegrationQueue {
      override async integrate(input: {
        project: ProjectConfig;
        lease: WorkspaceLease;
        review: ReviewDecision;
        signal: AbortSignal;
      }): Promise<IntegrationReceipt> {
        await gitOk(input.project.repositoryPath, ["switch", input.project.integrationBranch]);
        writeFileSync(path.join(input.project.repositoryPath, "base-b.txt"), "base B\n", "utf8");
        await gitOk(input.project.repositoryPath, ["add", "--", "base-b.txt"]);
        await gitOk(input.project.repositoryPath, ["commit", "-m", "advance integration to B"]);
        baseB = await gitOk(input.project.repositoryPath, ["rev-parse", "HEAD"]);
        return delegate.integrate(input);
      }
    }
    const { journal, orchestrator } = system(fixture.configPath, {
      validations,
      integrations: new AdvancingIntegration(new GitClient(), validations),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-stale-base",
      signal: runSignal(),
    });

    expect(result.terminalOutcome).toBe("completed");
    expect(journal.readStream(result.taskId).find((event) =>
      event.type === "task.integration_observed")?.payload).toMatchObject({
      receipt: { originalIntegrationCommit: baseB, outcome: "completed" },
      verification: "verified",
    });
  });

  it("persists candidate cleanup failures in integration evidence while completing", async () => {
    const fixture = await fixtureRepository();
    class CleanupFailingGitClient extends GitClient {
      override run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): Promise<CommandResult> {
        if (
          args.includes("worktree") &&
          args.includes("remove") &&
          args.some((argument) => argument.includes(".zentra-integration-"))
        ) {
          return Promise.resolve({
            stdout: "",
            stderr: "candidate cleanup denied",
            exitCode: 1,
            truncated: false,
            termination: null,
          });
        }
        return super.run(cwd, args, options);
      }
    }
    const validations = new ValidationRunner(new ProcessSupervisor());
    const integrations = new IntegrationQueue(new CleanupFailingGitClient(), validations);
    const { journal, orchestrator } = system(fixture.configPath, { validations, integrations });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-candidate-cleanup-evidence",
      signal: runSignal(),
    });

    expect(result.terminalOutcome).toBe("completed");
    expect(journal.readStream(result.taskId).find((event) =>
      event.type === "task.integration_observed")?.payload).toMatchObject({
      cleanupFailures: [
        {
          taskId: result.taskId,
          reason: expect.stringContaining("candidate cleanup"),
        },
      ],
    });
  });

  it("persists real candidate cleanup failure evidence with a failed full validation", async () => {
    const fixture = await fixtureRepository();
    class CleanupFailingGitClient extends GitClient {
      override run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): Promise<CommandResult> {
        if (
          args.includes("worktree") &&
          args.includes("remove") &&
          args.some((argument) => argument.includes(".zentra-integration-"))
        ) {
          return Promise.resolve({
            stdout: "",
            stderr: "candidate cleanup denied",
            exitCode: 1,
            truncated: false,
            termination: null,
          });
        }
        return super.run(cwd, args, options);
      }
    }
    class FailingFullValidation extends ValidationRunner {
      override run(
        project: ProjectConfig,
        name: "focused" | "full",
        cwd: string,
        signal: AbortSignal,
        context?: Parameters<ValidationRunner["run"]>[4],
      ): Promise<ValidationReport> {
        if (name === "full") return Promise.resolve(validationReport(project, name, "failed"));
        return super.run(project, name, cwd, signal, context);
      }
    }
    const validations = new FailingFullValidation(new ProcessSupervisor());
    const integrations = new IntegrationQueue(new CleanupFailingGitClient(), validations);
    const { journal, orchestrator } = system(fixture.configPath, { validations, integrations });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-failed-validation-cleanup",
      signal: runSignal(),
    });

    expect(result.terminalOutcome).toBe("failed");
    expect(journal.readStream(result.taskId).at(-1)?.payload).toMatchObject({
      receipt: { outcome: "failed", validation: { outcome: "failed" } },
      candidateCleanupFailures: [
        {
          taskId: result.taskId,
          reason: expect.stringContaining("candidate cleanup"),
        },
      ],
    });
  });

  it("recovers prepared evidence when integration observation append crashes after CAS", async () => {
    const fixture = await fixtureRepository();
    const databasePath = path.join(fixture.baseDirectory, "restart.sqlite");
    const firstJournal = new SqliteEventJournal(databasePath);
    journals.push(firstJournal);
    class ObservationCrashTaskService extends TaskService {
      override append(...args: Parameters<TaskService["append"]>): ReturnType<TaskService["append"]> {
        if (args[1] === "task.integration_observed") {
          throw new Error("simulated integration observation append crash");
        }
        return super.append(...args);
      }
    }
    const tasks = new ObservationCrashTaskService(firstJournal);
    const projects = ProjectRegistry.fromFile(fixture.configPath);
    const worktrees = new WorktreeManager();
    const supervisor = new ProcessSupervisor();
    const validations = new ValidationRunner(supervisor);
    const orchestrator = new TracerBulletOrchestrator(
      tasks,
      projects,
      worktrees,
      supervisor,
      validations,
      new DeterministicReviewerAdapter(supervisor, reviewerFixture),
      new ReviewGate(),
      new IntegrationQueue(new GitClient(), validations),
    );

    await expect(orchestrator.run({
      ...runInput,
      taskId: "task-restart-real-evidence",
      signal: runSignal(),
    })).rejects.toThrow("simulated integration observation append crash");
    expect(firstJournal.readStream("task-restart-real-evidence").at(-1)?.type).toBe(
      "task.integration_prepared",
    );
    firstJournal.close();
    journals.splice(journals.indexOf(firstJournal), 1);

    const restartedJournal = new SqliteEventJournal(databasePath);
    journals.push(restartedJournal);
    const recovery = new RecoveryService(
      restartedJournal,
      new TaskService(restartedJournal),
      projects,
      worktrees,
      new GitClient(),
    );
    await expect(recovery.inspect("task-restart-real-evidence")).resolves.toMatchObject({
      action: "record_completion",
    });
    await expect(recovery.recordCompletion("task-restart-real-evidence")).resolves.toMatchObject({
      lifecycle: "terminal",
      terminalOutcome: "completed",
    });
    expect(existsSync(path.join(fixture.worktreeRoot, "task-restart-real-evidence"))).toBe(false);
    const ticketRef = await new GitClient().run(fixture.repositoryPath, [
      "show-ref",
      "--verify",
      "refs/heads/ticket/task-restart-real-evidence",
    ]);
    expect(ticketRef.exitCode).not.toBe(0);
  });

  it("blocks prepared-only completion when candidate cleanup failed before observation crash", async () => {
    const fixture = await fixtureRepository();
    const databasePath = path.join(fixture.baseDirectory, "retained-candidate.sqlite");
    const journal = new SqliteEventJournal(databasePath);
    journals.push(journal);
    class ObservationCrashTaskService extends TaskService {
      override append(...args: Parameters<TaskService["append"]>): ReturnType<TaskService["append"]> {
        if (args[1] === "task.integration_observed") throw new Error("observation crash");
        return super.append(...args);
      }
    }
    class CandidateCleanupFailingGit extends GitClient {
      override run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): Promise<CommandResult> {
        if (
          args.includes("worktree") &&
          args.includes("remove") &&
          args.some((argument) => argument.includes(".zentra-integration-"))
        ) {
          return Promise.resolve({
            stdout: "",
            stderr: "candidate retained",
            exitCode: 1,
            truncated: false,
            termination: null,
          });
        }
        return super.run(cwd, args, options);
      }
    }
    const tasks = new ObservationCrashTaskService(journal);
    const projects = ProjectRegistry.fromFile(fixture.configPath);
    const worktrees = new WorktreeManager();
    const supervisor = new ProcessSupervisor();
    const validations = new ValidationRunner(supervisor);
    const orchestrator = new TracerBulletOrchestrator(
      tasks,
      projects,
      worktrees,
      supervisor,
      validations,
      new DeterministicReviewerAdapter(supervisor, reviewerFixture),
      new ReviewGate(),
      new IntegrationQueue(new CandidateCleanupFailingGit(), validations),
    );

    await expect(orchestrator.run({
      ...runInput,
      taskId: "task-retained-candidate",
      signal: runSignal(),
    })).rejects.toThrow("observation crash");
    const prepared = journal.readStream("task-retained-candidate").at(-1)?.payload as {
      receipt: { validation: { provenance: { canonicalCwd: string } } };
    };
    expect(existsSync(prepared.receipt.validation.provenance.canonicalCwd)).toBe(true);
    const recovery = new RecoveryService(
      journal,
      new TaskService(journal),
      projects,
      worktrees,
      new GitClient(),
    );
    await expect(recovery.inspect("task-retained-candidate")).resolves.toMatchObject({
      action: "await_reconciliation",
      reason: expect.stringMatching(/candidate.*registered|candidate.*present/i),
    });
  });

  it("recovers completion after cleanup is durable but task completion append crashes", async () => {
    const fixture = await fixtureRepository();
    const databasePath = path.join(fixture.baseDirectory, "cleanup-restart.sqlite");
    const firstJournal = new SqliteEventJournal(databasePath);
    journals.push(firstJournal);
    class CompletionCrashTaskService extends TaskService {
      override append(...args: Parameters<TaskService["append"]>): ReturnType<TaskService["append"]> {
        if (args[1] === "task.completed") throw new Error("simulated completion append crash");
        return super.append(...args);
      }
    }
    const tasks = new CompletionCrashTaskService(firstJournal);
    const projects = ProjectRegistry.fromFile(fixture.configPath);
    const worktrees = new WorktreeManager();
    const supervisor = new ProcessSupervisor();
    const validations = new ValidationRunner(supervisor);
    const orchestrator = new TracerBulletOrchestrator(
      tasks,
      projects,
      worktrees,
      supervisor,
      validations,
      new DeterministicReviewerAdapter(supervisor, reviewerFixture),
      new ReviewGate(),
      new IntegrationQueue(new GitClient(), validations),
    );

    await expect(orchestrator.run({
      ...runInput,
      taskId: "task-cleanup-restart",
      signal: runSignal(),
    })).rejects.toThrow("simulated completion append crash");
    expect(firstJournal.readStream("task-cleanup-restart").at(-1)?.type).toBe(
      "task.cleanup_completed",
    );
    expect(existsSync(path.join(fixture.worktreeRoot, "task-cleanup-restart"))).toBe(false);
    firstJournal.close();
    journals.splice(journals.indexOf(firstJournal), 1);

    const restartedJournal = new SqliteEventJournal(databasePath);
    journals.push(restartedJournal);
    const recovery = new RecoveryService(
      restartedJournal,
      new TaskService(restartedJournal),
      projects,
      worktrees,
      new GitClient(),
    );
    await expect(recovery.inspect("task-cleanup-restart")).resolves.toMatchObject({
      action: "record_completion",
    });
    await expect(recovery.recordCompletion("task-cleanup-restart")).resolves.toMatchObject({
      lifecycle: "terminal",
      terminalOutcome: "completed",
    });
  });

  it("records cleanup uncertainty and preserves the completed ticket worktree", async () => {
    const fixture = await fixtureRepository();
    let cleanupAttempts = 0;
    class UncertainCleanupWorktrees extends WorktreeManager {
      override cleanupCompleted(
        _project: ProjectConfig,
        lease: WorkspaceLease,
        sourceCommit: string,
      ): Promise<void> {
        cleanupAttempts += 1;
        throw new WorkspaceCleanupError(
          "worktree_removal",
          true,
          { taskId: lease.taskId, sourceCommit },
          "result unavailable",
        );
      }
    }
    const { journal, orchestrator } = system(fixture.configPath, {
      worktrees: new UncertainCleanupWorktrees(),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-cleanup-uncertain",
      signal: runSignal(),
    });

    expect(result).toMatchObject({ lifecycle: "integrating", terminalOutcome: null });
    expect(journal.readStream(result.taskId).at(-1)).toMatchObject({
      type: "task.cleanup_observed",
      payload: { phase: "worktree_removal", uncertain: true },
    });
    expect(existsSync(path.join(fixture.worktreeRoot, result.taskId))).toBe(true);
    expect(await gitOk(fixture.repositoryPath, [
      "rev-parse",
      `refs/heads/ticket/${result.taskId}`,
    ])).toMatch(/^[a-f0-9]{40}$/);
    const recovery = new RecoveryService(
      journal,
      new TaskService(journal),
      ProjectRegistry.fromFile(fixture.configPath),
      new UncertainCleanupWorktrees(),
      new GitClient(),
    );
    await expect(recovery.inspect(result.taskId)).resolves.toMatchObject({
      action: "await_reconciliation",
    });
    expect(cleanupAttempts).toBe(1);
  });

  it("injects the new workspace argument and ignores stale events on cancellation", async () => {
    const fixture = await fixtureRepository();
    let request: WorkerRequest | undefined;
    const worker: WorkerAdapter = {
      execute(received): Promise<WorkerResult> {
        request = received;
        return Promise.resolve({
          outcome: "cancelled",
          exitCode: null,
          events: [
            { type: "artifact.ready", path: "greeting.txt", sha256: "0".repeat(64) },
          ],
          stdout: "stale",
          rawStdout: "stale",
          stderr: "",
        });
      },
    };
    const { journal, orchestrator } = system(fixture.configPath, { worker });

    const result = await orchestrator.run({
      ...runInput,
      signal: new AbortController().signal,
    });

    const workspace = path.join(fixture.worktreeRoot, runInput.taskId);
    expect(request).toMatchObject({
      taskId: runInput.taskId,
      cwd: workspace,
      args: [
        workerFixture,
        "--workspace",
        workspace,
        "--file",
        "greeting.txt",
        "--content",
        "hello from Zentra\n",
      ],
    });
    expect(result.terminalOutcome).toBe("cancelled");
    expect(journal.readStream(runInput.taskId).map((event) => event.type)).toEqual([
      "task.created",
      "task.leased",
      "task.started",
      "task.cancelled",
    ]);
    expect(existsSync(workspace)).toBe(true);
    expect(readFileSync(path.join(workspace, "greeting.txt"), "utf8")).toBe(
      "hello\n",
    );
  });

  it.each([
    ["no artifact", []],
    [
      "multiple artifacts",
      [
        { type: "artifact.ready", path: "greeting.txt", sha256: "0".repeat(64) },
        { type: "artifact.ready", path: "other.txt", sha256: "0".repeat(64) },
      ],
    ],
    [
      "an absolute path",
      [{ type: "artifact.ready", path: "/tmp/greeting.txt", sha256: "0".repeat(64) }],
    ],
    [
      "a traversal path",
      [{ type: "artifact.ready", path: "../greeting.txt", sha256: "0".repeat(64) }],
    ],
    [
      "event and file mismatch",
      [{ type: "artifact.ready", path: "greeting.txt", sha256: "0".repeat(64) }],
    ],
  ])("fails and preserves the worktree for %s", async (_case, events) => {
    const fixture = await fixtureRepository();
    const worker: WorkerAdapter = {
      async execute(request): Promise<WorkerResult> {
        if (_case !== "no artifact" && _case !== "an absolute path" && _case !== "a traversal path") {
          writeFileSync(path.join(request.cwd, "greeting.txt"), "changed\n", "utf8");
          if (_case === "multiple artifacts") {
            writeFileSync(path.join(request.cwd, "other.txt"), "other\n", "utf8");
          }
        }
        return {
          outcome: "completed",
          exitCode: 0,
          events,
          stdout: "",
          rawStdout: "",
          stderr: "",
        };
      },
    };
    const { journal, orchestrator } = system(fixture.configPath, { worker });

    const result = await orchestrator.run({
      ...runInput,
      taskId: `task-${_case.replaceAll(" ", "-")}`,
      signal: new AbortController().signal,
    });

    expect(result.terminalOutcome).toBe("failed");
    expect(journal.readStream(result.taskId).at(-1)?.type).toBe("task.failed");
    expect(existsSync(path.join(fixture.worktreeRoot, result.taskId))).toBe(true);
  });

  it("rejects an empty diff and caller-supplied workspace authority", async () => {
    const fixture = await fixtureRepository();
    const unchangedWorker: WorkerAdapter = {
      execute(): Promise<WorkerResult> {
        return Promise.resolve({
          outcome: "completed",
          exitCode: 0,
          events: [
            {
              type: "artifact.ready",
              path: "greeting.txt",
              sha256: sha256("hello\n"),
            },
          ],
          stdout: "",
          rawStdout: "",
          stderr: "",
        });
      },
    };
    const first = system(fixture.configPath, { worker: unchangedWorker });
    const emptyDiff = await first.orchestrator.run({
      ...runInput,
      taskId: "task-empty-diff",
      signal: new AbortController().signal,
    });
    expect(emptyDiff.terminalOutcome).toBe("failed");

    const second = system(fixture.configPath, { worker: unchangedWorker });
    const suppliedWorkspace = await second.orchestrator.run({
      ...runInput,
      taskId: "task-supplied-workspace",
      workerRequest: {
        ...runInput.workerRequest,
        args: [...runInput.workerRequest.args, "--workspace", "/tmp/other"],
      },
      signal: new AbortController().signal,
    });
    expect(suppliedWorkspace.terminalOutcome).toBe("failed");
    expect(
      second.journal.readStream(suppliedWorkspace.taskId).map((event) => event.type),
    ).toEqual(["task.created", "task.failed"]);
  });

  it.each([
    ["arbitrary executable", "/bin/echo", workerFixture],
    ["arbitrary script", process.execPath, fileURLToPath(import.meta.url)],
  ])("rejects %s before creating a worktree or invoking a worker", async (
    _case,
    executable,
    script,
  ) => {
    const fixture = await fixtureRepository();
    let calls = 0;
    const worker: WorkerAdapter = {
      execute(): Promise<WorkerResult> {
        calls += 1;
        throw new Error("worker must not run");
      },
    };
    const { journal, orchestrator } = system(fixture.configPath, { worker });

    const result = await orchestrator.run({
      ...runInput,
      taskId: `task-${_case.replace(" ", "-")}`,
      workerRequest: {
        ...runInput.workerRequest,
        executable,
        args: [script, ...runInput.workerRequest.args.slice(1)],
      },
      signal: new AbortController().signal,
    });

    expect(result.terminalOutcome).toBe("failed");
    expect(calls).toBe(0);
    expect(existsSync(fixture.worktreeRoot)).toBe(false);
    expect(journal.readStream(result.taskId).map((event) => event.type)).toEqual([
      "task.created",
      "task.failed",
    ]);
  });

  it.each([
    ["unknown flag", [workerFixture, "--file", "greeting.txt", "--bogus", "x", "--content", "changed"]],
    ["duplicate flag", [workerFixture, "--file", "greeting.txt", "--file", "other.txt", "--content", "changed"]],
    ["missing flag", [workerFixture, "--file", "greeting.txt"]],
  ])("rejects worker args with %s before worktree creation", async (_case, args) => {
    const fixture = await fixtureRepository();
    let calls = 0;
    const { orchestrator } = system(fixture.configPath, {
      worker: {
        execute(): Promise<WorkerResult> {
          calls += 1;
          throw new Error("must not execute");
        },
      },
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: `task-args-${_case.replace(" ", "-")}`,
      workerRequest: { ...runInput.workerRequest, args },
      signal: new AbortController().signal,
    });

    expect(result.terminalOutcome).toBe("failed");
    expect(calls).toBe(0);
    expect(existsSync(fixture.worktreeRoot)).toBe(false);
  });

  it("rejects a nested worker target before worktree creation", async () => {
    const fixture = await fixtureRepository();
    const { orchestrator } = system(fixture.configPath);

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-nested-worker-target",
      workerRequest: {
        ...runInput.workerRequest,
        args: [workerFixture, "--file", "nested/greeting.txt", "--content", "changed"],
      },
      signal: runSignal(),
    });

    expect(result.terminalOutcome).toBe("failed");
    expect(existsSync(fixture.worktreeRoot)).toBe(false);
  });

  it.each([NaN, Infinity, 0, -1, 300_001])(
    "rejects invalid worker timeout %s before task creation",
    async (timeoutMs) => {
      const fixture = await fixtureRepository();
      const { journal, orchestrator } = system(fixture.configPath);

      await expect(orchestrator.run({
        ...runInput,
        taskId: `task-timeout-${String(timeoutMs)}`,
        workerRequest: { ...runInput.workerRequest, timeoutMs },
        signal: runSignal(),
      })).rejects.toThrow(/timeout/i);
      expect(journal.readAll()).toEqual([]);
      expect(existsSync(fixture.worktreeRoot)).toBe(false);
    },
  );

  it("rejects a tracked symlink target without modifying its external marker", async () => {
    const fixture = await fixtureRepository();
    const marker = path.join(fixture.baseDirectory, "external-marker.txt");
    writeFileSync(marker, "unchanged\n", "utf8");
    rmSync(path.join(fixture.repositoryPath, "greeting.txt"));
    symlinkSync(marker, path.join(fixture.repositoryPath, "greeting.txt"));
    await gitOk(fixture.repositoryPath, ["add", "--", "greeting.txt"]);
    await gitOk(fixture.repositoryPath, ["commit", "-m", "track external symlink"]);
    const { journal, orchestrator } = system(fixture.configPath);

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-symlink-target",
      signal: new AbortController().signal,
    });

    expect(result.terminalOutcome).toBe("failed");
    expect(readFileSync(marker, "utf8")).toBe("unchanged\n");
    expect(existsSync(path.join(fixture.worktreeRoot, result.taskId))).toBe(true);
    expect(journal.readStream(result.taskId).map((event) => event.type)).toEqual([
      "task.created",
      "task.leased",
      "task.started",
      "task.failed",
    ]);
  });

  it("rejects a worker-staged unreviewed path before validation or commit", async () => {
    const fixture = await fixtureRepository();
    const initialHead = await gitOk(fixture.repositoryPath, ["rev-parse", "HEAD"]);
    const worker: WorkerAdapter = {
      async execute(request): Promise<WorkerResult> {
        writeFileSync(path.join(request.cwd, "greeting.txt"), "hello from Zentra\n");
        writeFileSync(path.join(request.cwd, "unreviewed.txt"), "unreviewed\n");
        await gitOk(request.cwd, ["add", "--", "unreviewed.txt"]);
        return {
          outcome: "completed",
          exitCode: 0,
          events: [{
            type: "artifact.ready",
            path: "greeting.txt",
            sha256: sha256("hello from Zentra\n"),
          }],
          stdout: "",
          rawStdout: "",
          stderr: "",
        };
      },
    };
    const { journal, orchestrator } = system(fixture.configPath, { worker });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-staged-contamination",
      signal: new AbortController().signal,
    });

    expect(result.terminalOutcome).toBe("failed");
    expect(journal.readStream(result.taskId).map((event) => event.type)).toEqual([
      "task.created",
      "task.leased",
      "task.started",
      "task.failed",
    ]);
    expect(
      await gitOk(fixture.repositoryPath, ["rev-parse", "ticket/task-staged-contamination"]),
    ).toBe(initialHead);
    expect(existsSync(path.join(fixture.worktreeRoot, result.taskId))).toBe(true);
  });

  it.each(["failed", "cancelled", "timed_out"] as const)(
    "maps focused validation %s exactly and preserves the worktree",
    async (outcome) => {
      const fixture = await fixtureRepository();
      class OutcomeValidation extends ValidationRunner {
        override run(project: ProjectConfig, name: "focused" | "full"): Promise<ValidationReport> {
          return Promise.resolve(validationReport(project, name, outcome));
        }
      }
      const validations = new OutcomeValidation(new ProcessSupervisor());
      const { journal, orchestrator } = system(fixture.configPath, { validations });

      const result = await orchestrator.run({
        ...runInput,
        taskId: `task-validation-${outcome}`,
        signal: new AbortController().signal,
      });

      expect(result.terminalOutcome).toBe(outcome);
      expect(journal.readStream(result.taskId).map((event) => event.type)).toEqual([
        "task.created",
        "task.leased",
        "task.started",
        "task.validation_started",
        `task.${outcome}`,
      ]);
      expect(existsSync(path.join(fixture.worktreeRoot, result.taskId))).toBe(true);
    },
  );

  it("maps a thrown focused validation to failed", async () => {
    const fixture = await fixtureRepository();
    class ThrowingValidation extends ValidationRunner {
      override run(): Promise<ValidationReport> {
        throw new Error("validation infrastructure failed");
      }
    }
    const { orchestrator } = system(fixture.configPath, {
      validations: new ThrowingValidation(new ProcessSupervisor()),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-validation-throw",
      signal: new AbortController().signal,
    });

    expect(result.terminalOutcome).toBe("failed");
  });

  it("rejects a branded focused-validation report replayed from another cwd and subject", async () => {
    const fixture = await fixtureRepository();
    const project = ProjectRegistry.fromFile(fixture.configPath).get("greeting-project");
    const oldCwd = path.join(fixture.baseDirectory, "old-validation-workspace");
    mkdirSync(path.join(oldCwd, "test"), { recursive: true });
    writeFileSync(path.join(oldCwd, "greeting.txt"), "hello from Zentra\n");
    writeFileSync(
      path.join(oldCwd, "test/greeting.test.mjs"),
      readFileSync(path.join(fixture.repositoryPath, "test/greeting.test.mjs")),
    );
    const oldReport = await new ValidationRunner(new ProcessSupervisor()).run(
      project,
      "focused",
      oldCwd,
      runSignal(),
      { invocationId: "old-focused-validation", subjectSha256: "old-diff" },
    );
    let reviewerCalls = 0;
    class ReplayingValidationRunner extends ValidationRunner {
      override run(): Promise<ValidationReport> {
        return Promise.resolve(oldReport);
      }
    }
    const reviewer: ReviewerAdapter = {
      review(): Promise<ReviewDecision> {
        reviewerCalls += 1;
        throw new Error("reviewer must not run");
      },
    };
    const { journal, orchestrator } = system(fixture.configPath, {
      validations: new ReplayingValidationRunner(new ProcessSupervisor()),
      reviewer,
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-replayed-focused-validation",
      signal: runSignal(),
    });

    expect(result.terminalOutcome).toBe("failed");
    expect(reviewerCalls).toBe(0);
    expect(journal.readStream(result.taskId).at(-1)?.type).toBe("task.failed");
  });

  it("rejects context-bound validation executed with a substituted focused command", async () => {
    const fixture = await fixtureRepository();
    let reviewerCalls = 0;
    class SubstitutingValidationRunner extends ValidationRunner {
      override run(
        project: ProjectConfig,
        name: "focused" | "full",
        cwd: string,
        signal: AbortSignal,
        context?: Parameters<ValidationRunner["run"]>[4],
      ): Promise<ValidationReport> {
        const substituted = {
          ...project,
          validations: {
            ...project.validations,
            focused: [process.execPath, "-e", "process.exit(0)"] as [string, ...string[]],
          },
        };
        return super.run(substituted, name, cwd, signal, context);
      }
    }
    const reviewer: ReviewerAdapter = {
      review(): Promise<ReviewDecision> {
        reviewerCalls += 1;
        throw new Error("reviewer must not run");
      },
    };
    const { orchestrator } = system(fixture.configPath, {
      validations: new SubstitutingValidationRunner(new ProcessSupervisor()),
      reviewer,
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-substituted-focused-command",
      signal: runSignal(),
    });

    expect(result.terminalOutcome).toBe("failed");
    expect(reviewerCalls).toBe(0);
  });

  it.each([
    ["valid denial", "valid", "denied"],
    ["stale denial", "stale", "failed"],
    ["wrong-identity denial", "identity", "failed"],
  ] as const)("maps %s only after evidence verification", async (_case, kind, outcome) => {
    const fixture = await fixtureRepository();
    const reviewer: ReviewerAdapter = {
      review(input): Promise<ReviewDecision> {
        const denied = decision(input, false);
        return Promise.resolve(
          kind === "stale"
            ? { ...denied, diffSha256: "0".repeat(64) }
            : kind === "identity"
              ? { ...denied, reviewerId: "other-reviewer" }
              : denied,
        );
      },
    };
    const { journal, orchestrator } = system(fixture.configPath, { reviewer });

    const result = await orchestrator.run({
      ...runInput,
      taskId: `task-review-${kind}`,
      signal: new AbortController().signal,
    });

    expect(result.terminalOutcome).toBe(outcome);
    expect(journal.readStream(result.taskId).map((event) => event.type)).toEqual([
      "task.created",
      "task.leased",
      "task.started",
      "task.validation_started",
      "task.review_requested",
      `task.${outcome}`,
    ]);
  });

  it.each([
    ["extra field", { extra: true }],
    ["wrong approval type", { approved: "yes" }],
    ["invalid timestamp", { decidedAt: "yesterday" }],
    ["empty reason", { reason: "" }],
  ])("fails a custom reviewer decision with %s", async (_case, change) => {
    const fixture = await fixtureRepository();
    const reviewer: ReviewerAdapter = {
      review(input): Promise<ReviewDecision> {
        return Promise.resolve({ ...decision(input, true), ...change } as never);
      },
    };
    const { orchestrator } = system(fixture.configPath, { reviewer });

    const result = await orchestrator.run({
      ...runInput,
      taskId: `task-malformed-review-${_case.replaceAll(" ", "-")}`,
      signal: new AbortController().signal,
    });

    expect(result.terminalOutcome).toBe("failed");
  });

  it.each(["cancelled", "timed_out", "failed"] as const)(
    "preserves typed reviewer %s outcome",
    async (outcome) => {
      const fixture = await fixtureRepository();
      const reviewer: ReviewerAdapter = {
        review(): Promise<ReviewDecision> {
          throw new ReviewerExecutionError(outcome, "review stopped");
        },
      };
      const { orchestrator } = system(fixture.configPath, { reviewer });

      const result = await orchestrator.run({
        ...runInput,
        taskId: `task-reviewer-${outcome}`,
        signal: new AbortController().signal,
      });

      expect(result.terminalOutcome).toBe(outcome);
    },
  );

  it.each(["cancelled", "timed_out"] as const)(
    "maps bounded commit %s without starting integration",
    async (outcome) => {
      const fixture = await fixtureRepository();
      let integrationCalls = 0;
      class TerminatingWorktrees extends WorktreeManager {
        override commit(): Promise<string> {
          throw new WorkspaceGitTerminationError(outcome, "git commit");
        }
      }
      class RecordingIntegration extends IntegrationQueue {
        override integrate(): Promise<IntegrationReceipt> {
          integrationCalls += 1;
          throw new Error("integration must not run");
        }
      }
      const validations = new ValidationRunner(new ProcessSupervisor());
      const { orchestrator } = system(fixture.configPath, {
        worktrees: new TerminatingWorktrees(),
        integrations: new RecordingIntegration(new GitClient(), validations),
      });

      const result = await orchestrator.run({
        ...runInput,
        taskId: `task-commit-${outcome}`,
        signal: new AbortController().signal,
      });

      expect(result.terminalOutcome).toBe(outcome);
      expect(integrationCalls).toBe(0);
      expect(existsSync(path.join(fixture.worktreeRoot, result.taskId))).toBe(true);
    },
  );

  it.each(["failed", "cancelled", "timed_out"] as const)(
    "maps integration receipt %s exactly",
    async (outcome) => {
      const fixture = await fixtureRepository();
      class OutcomeIntegration extends IntegrationQueue {
        override async integrate(input: {
          project: ProjectConfig;
          lease: WorkspaceLease;
          review: ReviewDecision;
          signal: AbortSignal;
        }): Promise<IntegrationReceipt> {
          const sourceCommit = await gitOk(input.lease.path, ["rev-parse", "HEAD"]);
          return {
            taskId: input.lease.taskId,
            projectId: input.project.projectId,
            sourceCommit,
            originalIntegrationCommit: null,
            resultCommit: null,
            review: input.review,
            validation: validationReport(input.project, "full", outcome),
            outcome,
          };
        }

        override getCleanupFailures(): readonly CleanupFailure[] {
          return [
            {
              projectId: "greeting-project",
              taskId: "foreign-task",
              candidatePath: "/foreign/candidate",
              reason: "foreign cleanup failed",
              timestamp: "2026-07-12T00:00:00.000Z",
            },
            {
              projectId: "greeting-project",
              taskId: `task-integration-${outcome}`,
              candidatePath: "/retained/candidate",
              reason: "candidate cleanup failed",
              timestamp: "2026-07-12T00:00:00.000Z",
            },
          ];
        }
      }
      const validations = new ValidationRunner(new ProcessSupervisor());
      const { journal, orchestrator } = system(fixture.configPath, {
        integrations: new OutcomeIntegration(new GitClient(), validations),
      });

      const result = await orchestrator.run({
        ...runInput,
        taskId: `task-integration-${outcome}`,
        signal: new AbortController().signal,
      });

      expect(result.terminalOutcome).toBe(outcome);
      expect(existsSync(path.join(fixture.worktreeRoot, result.taskId))).toBe(true);
      const terminalPayload = journal.readStream(result.taskId).at(-1)?.payload as {
        candidateCleanupFailures: readonly CleanupFailure[];
      };
      expect(terminalPayload.candidateCleanupFailures).toEqual([
        expect.objectContaining({
          taskId: result.taskId,
          candidatePath: "/retained/candidate",
          reason: "candidate cleanup failed",
        }),
      ]);
    },
  );

  it("leaves a thrown post-start integration dependency nonterminal for reconciliation", async () => {
    const fixture = await fixtureRepository();
    class ThrowingIntegration extends IntegrationQueue {
      override integrate(): Promise<IntegrationReceipt> {
        throw new Error("integration infrastructure failed");
      }
    }
    const validations = new ValidationRunner(new ProcessSupervisor());
    const { orchestrator } = system(fixture.configPath, {
      integrations: new ThrowingIntegration(new GitClient(), validations),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-integration-throw",
      signal: new AbortController().signal,
    });

    expect(result.lifecycle).toBe("integrating");
    expect(result.terminalOutcome).toBeNull();
  });

  it.each([
    ["task identity", (receipt: IntegrationReceipt) => ({ ...receipt, taskId: "substituted-task" })],
    ["project identity", (receipt: IntegrationReceipt) => ({ ...receipt, projectId: "substituted-project" })],
    ["source commit", (receipt: IntegrationReceipt) => ({ ...receipt, sourceCommit: "0".repeat(40) })],
    ["integration base", (receipt: IntegrationReceipt) => ({
      ...receipt,
      originalIntegrationCommit: "0".repeat(40),
    })],
    ["review provenance", (receipt: IntegrationReceipt) => ({ ...receipt, review: { ...receipt.review } })],
    ["validation outcome", (receipt: IntegrationReceipt) => ({
      ...receipt,
      validation: { ...receipt.validation, outcome: "failed" as const },
    })],
    ["validation digest", (receipt: IntegrationReceipt) => ({
      ...receipt,
      validation: { ...receipt.validation, outputSha256: "0".repeat(64) },
    })],
    ["full command", (receipt: IntegrationReceipt) => {
      const command = [process.execPath, "-e", "process.exit(0)"];
      return {
        ...receipt,
        validation: {
          ...receipt.validation,
          command,
          argvSha256: sha256(JSON.stringify(command)),
        },
      };
    }],
    ["result commit", (receipt: IntegrationReceipt) => ({ ...receipt, resultCommit: "0".repeat(40) })],
  ] as const)("observes a completed receipt with substituted %s without terminalizing", async (
    _case,
    mutate,
  ) => {
    const fixture = await fixtureRepository();
    const validations = new ValidationRunner(new ProcessSupervisor());
    const delegate = new IntegrationQueue(new GitClient(), validations);
    class SubstitutingIntegration extends IntegrationQueue {
      override async integrate(input: {
        project: ProjectConfig;
        lease: WorkspaceLease;
        review: ReviewDecision;
        signal: AbortSignal;
      }): Promise<IntegrationReceipt> {
        const receipt = await delegate.integrate(input);
        return mutate(receipt);
      }
    }
    const { journal, orchestrator } = system(fixture.configPath, {
      validations,
      integrations: new SubstitutingIntegration(new GitClient(), validations),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-substituted-receipt",
      signal: new AbortController().signal,
    });

    expect(result.lifecycle).toBe("integrating");
    expect(result.terminalOutcome).toBeNull();
    expect(journal.readStream(result.taskId).at(-1)?.type).toBe("task.integration_observed");
    expect(journal.readStream(result.taskId).at(-1)?.payload).toMatchObject({
      verification: "failed",
      receipt: { outcome: "completed" },
      reason: expect.any(String),
    });
  });

  it("rejects a symbolic integration ref in an otherwise completed receipt", async () => {
    const fixture = await fixtureRepository();
    const validations = new ValidationRunner(new ProcessSupervisor());
    const delegate = new IntegrationQueue(new GitClient(), validations);
    class SymbolicIntegration extends IntegrationQueue {
      override async integrate(input: {
        project: ProjectConfig;
        lease: WorkspaceLease;
        review: ReviewDecision;
        signal: AbortSignal;
      }): Promise<IntegrationReceipt> {
        const receipt = await delegate.integrate(input);
        await gitOk(input.project.repositoryPath, [
          "symbolic-ref",
          `refs/heads/${input.project.integrationBranch}`,
          "refs/heads/main",
        ]);
        return receipt;
      }
    }
    const { orchestrator } = system(fixture.configPath, {
      validations,
      integrations: new SymbolicIntegration(new GitClient(), validations),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-symbolic-receipt",
      signal: new AbortController().signal,
    });

    expect(result.lifecycle).toBe("integrating");
    expect(result.terminalOutcome).toBeNull();
  });

  it("rejects completed receipt verification when replacement refs exist", async () => {
    const fixture = await fixtureRepository();
    const validations = new ValidationRunner(new ProcessSupervisor());
    const delegate = new IntegrationQueue(new GitClient(), validations);
    class ReplacingIntegration extends IntegrationQueue {
      override async integrate(input: {
        project: ProjectConfig;
        lease: WorkspaceLease;
        review: ReviewDecision;
        signal: AbortSignal;
      }): Promise<IntegrationReceipt> {
        const receipt = await delegate.integrate(input);
        await gitOk(input.project.repositoryPath, [
          "replace",
          receipt.resultCommit!,
          receipt.sourceCommit,
        ]);
        return receipt;
      }
    }
    const { journal, orchestrator } = system(fixture.configPath, {
      validations,
      integrations: new ReplacingIntegration(new GitClient(), validations),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-replacement-receipt",
      signal: runSignal(),
    });

    expect(result.lifecycle).toBe("integrating");
    expect(journal.readStream(result.taskId).at(-1)?.payload).toMatchObject({
      verification: "failed",
      reason: expect.stringMatching(/replace/i),
    });
  });

  it("rejects a result commit that does not descend from the reviewed source", async () => {
    const fixture = await fixtureRepository();
    const validations = new ValidationRunner(new ProcessSupervisor());
    const delegate = new IntegrationQueue(new GitClient(), validations);
    class UnrelatedIntegration extends IntegrationQueue {
      override async integrate(input: {
        project: ProjectConfig;
        lease: WorkspaceLease;
        review: ReviewDecision;
        signal: AbortSignal;
      }): Promise<IntegrationReceipt> {
        const receipt = await delegate.integrate(input);
        const tree = await gitOk(input.project.repositoryPath, ["rev-parse", "main^{tree}"]);
        const unrelated = await gitOk(input.project.repositoryPath, [
          "commit-tree",
          tree,
          "-m",
          "unrelated result",
        ]);
        await gitOk(input.project.repositoryPath, [
          "update-ref",
          `refs/heads/${input.project.integrationBranch}`,
          unrelated,
          receipt.resultCommit!,
        ]);
        return { ...receipt, resultCommit: unrelated };
      }
    }
    const { orchestrator } = system(fixture.configPath, {
      validations,
      integrations: new UnrelatedIntegration(new GitClient(), validations),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-unrelated-receipt",
      signal: new AbortController().signal,
    });

    expect(result.lifecycle).toBe("integrating");
    expect(result.terminalOutcome).toBeNull();
  });

  it("leaves an uncertain commit integration_ready without integration", async () => {
    const fixture = await fixtureRepository();
    let integrationCalls = 0;
    class UncertainWorktrees extends WorktreeManager {
      override commit(): Promise<string> {
        throw new WorkspaceCommitUncertainError("unknown HEAD");
      }
    }
    class RecordingIntegration extends IntegrationQueue {
      override integrate(): Promise<IntegrationReceipt> {
        integrationCalls += 1;
        throw new Error("must not integrate");
      }
    }
    const validations = new ValidationRunner(new ProcessSupervisor());
    const { journal, orchestrator } = system(fixture.configPath, {
      worktrees: new UncertainWorktrees(),
      integrations: new RecordingIntegration(new GitClient(), validations),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-uncertain-commit",
      signal: new AbortController().signal,
    });

    expect(result.lifecycle).toBe("integration_ready");
    expect(result.terminalOutcome).toBeNull();
    expect(journal.readStream(result.taskId).at(-1)?.type).toBe("task.commit_observed");
    expect(integrationCalls).toBe(0);
  });

  it("terminalizes cancellation after an acknowledged commit before integration starts", async () => {
    const fixture = await fixtureRepository();
    const controller = new AbortController();
    let integrationCalls = 0;
    class AbortingWorktrees extends WorktreeManager {
      override async commit(...args: Parameters<WorktreeManager["commit"]>): Promise<string> {
        const commit = await super.commit(...args);
        controller.abort();
        return commit;
      }
    }
    class RecordingIntegration extends IntegrationQueue {
      override integrate(): Promise<IntegrationReceipt> {
        integrationCalls += 1;
        throw new Error("must not integrate");
      }
    }
    const validations = new ValidationRunner(new ProcessSupervisor());
    const { orchestrator } = system(fixture.configPath, {
      worktrees: new AbortingWorktrees(),
      integrations: new RecordingIntegration(new GitClient(), validations),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-cancel-after-commit",
      signal: controller.signal,
    });

    expect(result.terminalOutcome).toBe("cancelled");
    expect(integrationCalls).toBe(0);
  });

  it("maps a typed integration source timeout exactly", async () => {
    const fixture = await fixtureRepository();
    class SourceTimeoutIntegration extends IntegrationQueue {
      override integrate(): Promise<IntegrationReceipt> {
        throw new IntegrationExecutionError("timed_out", "source identity read");
      }
    }
    const validations = new ValidationRunner(new ProcessSupervisor());
    const { orchestrator } = system(fixture.configPath, {
      integrations: new SourceTimeoutIntegration(new GitClient(), validations),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-integration-source-timeout",
      signal: new AbortController().signal,
    });

    expect(result.terminalOutcome).toBe("timed_out");
  });

  it("terminalizes a typed failed source-resolution error", async () => {
    const fixture = await fixtureRepository();
    class SourceFailureIntegration extends IntegrationQueue {
      override integrate(): Promise<IntegrationReceipt> {
        throw new IntegrationExecutionError("failed", "source identity read");
      }
    }
    const validations = new ValidationRunner(new ProcessSupervisor());
    const { orchestrator } = system(fixture.configPath, {
      integrations: new SourceFailureIntegration(new GitClient(), validations),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-integration-source-failed",
      signal: runSignal(),
    });

    expect(result.terminalOutcome).toBe("failed");
  });

  it("observes an explicit uncertain integration with durable evidence", async () => {
    const fixture = await fixtureRepository();
    class UncertainIntegration extends IntegrationQueue {
      override integrate(): Promise<IntegrationReceipt> {
        throw new IntegrationUncertainError(
          "update-ref reconciliation unresolved",
          Object.freeze({ mode: "competing-head", candidatePath: "/candidate" }),
        );
      }
    }
    const validations = new ValidationRunner(new ProcessSupervisor());
    const { journal, orchestrator } = system(fixture.configPath, {
      integrations: new UncertainIntegration(new GitClient(), validations),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-integration-uncertain",
      signal: runSignal(),
    });

    expect(result.lifecycle).toBe("integrating");
    expect(result.terminalOutcome).toBeNull();
    expect(journal.readStream(result.taskId).at(-1)?.payload).toEqual({
      reason: "update-ref reconciliation unresolved",
      evidence: { mode: "competing-head", candidatePath: "/candidate" },
      cleanupFailures: [],
    });
  });

  it("passes bounded cancellation options through setup and artifact Git", async () => {
    const fixture = await fixtureRepository();
    const controller = new AbortController();
    const calls: Array<{ operation: string; signal: AbortSignal | undefined; timeoutMs: number | undefined }> = [];
    class RecordingWorktrees extends WorktreeManager {
      override ensureIntegrationBranch(project: ProjectConfig, options: GitRunOptions = {}) {
        calls.push({ operation: "ensure", signal: options.signal, timeoutMs: options.timeoutMs });
        return super.ensureIntegrationBranch(project, options);
      }
      override create(project: ProjectConfig, taskId: string, options: GitRunOptions = {}) {
        calls.push({ operation: "create", signal: options.signal, timeoutMs: options.timeoutMs });
        return super.create(project, taskId, options);
      }
      override async inspect(lease: WorkspaceLease, options: GitRunOptions = {}) {
        calls.push({ operation: "inspect", signal: options.signal, timeoutMs: options.timeoutMs });
        const result = await super.inspect(lease, options);
        controller.abort();
        return result;
      }
    }
    const { orchestrator } = system(fixture.configPath, {
      worktrees: new RecordingWorktrees(),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-bounded-artifact",
      signal: controller.signal,
    });

    expect(result.terminalOutcome).toBe("cancelled");
    expect(calls.map((call) => call.operation)).toEqual(["ensure", "create", "inspect"]);
    for (const call of calls) {
      expect(call.signal).toBe(controller.signal);
      expect(call.timeoutMs).toBeGreaterThan(0);
    }
  });
});
