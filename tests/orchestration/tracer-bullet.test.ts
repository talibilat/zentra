import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
import { projectArtifacts } from "../../src/contracts/artifact.js";
import type { PlannedTask } from "../../src/contracts/milestone.js";
import {
  IntegrationExecutionError,
  IntegrationUncertainError,
  IntegrationQueue,
  type CleanupFailure,
  type IntegrationReceipt,
} from "../../src/integration/integration-queue.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
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
  WorkspaceCreationUncertainError,
  WorkspaceGitTerminationError,
  WorkspaceCommitUncertainError,
  WorktreeManager,
  type WorkspaceCreationIntent,
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
  readonly taskService?: (journal: SqliteEventJournal) => TaskService;
}

function system(configPath: string, overrides: SystemOverrides = {}) {
  const journal = new SqliteEventJournal(":memory:");
  journals.push(journal);
  const supervisor = new ProcessSupervisor();
  const validations = overrides.validations ?? new ValidationRunner(supervisor);
  const worktrees = overrides.worktrees ?? new WorktreeManager();
  const tasks = overrides.taskService?.(journal) ?? new TaskService(journal);
  const orchestrator = new TracerBulletOrchestrator(
    tasks,
    ProjectRegistry.fromFile(configPath),
    worktrees,
    overrides.worker ?? new ProcessSupervisor(),
    validations,
    overrides.reviewer ?? new DeterministicReviewerAdapter(supervisor, reviewerFixture),
    new ReviewGate(),
    overrides.integrations ?? new IntegrationQueue(new GitClient(), validations),
    workerFixture,
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

const reviewPolicyTask: PlannedTask = {
  taskId: "task-greeting",
  title: "Update greeting",
  description: "Update greeting",
  dependencies: [],
  ownedPaths: ["greeting.txt"],
  forbiddenPaths: [],
  acceptanceCriteria: ["Focused validation completed and independent review approved the diff."],
  roleAssignment: { role: "implementer", agentId: "worker-1", harness: "deterministic" },
  risk: {
    level: "low",
    authority: "workspace_write",
    requiresReview: true,
    requiresApproval: false,
  },
  budget: {
    maxSeconds: 10_000,
    maxRetries: 0,
    maxCostUsd: 0,
    maxInputTokens: 1,
    maxOutputTokens: 1,
  },
};

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
  reviewPolicySecurity: {
    allowedRepositories: [],
    allowedFileScopes: ["greeting.txt", "auth.ts"],
    forbiddenPaths: [],
    network: { default: "denied", allowedDestinations: [] },
    secretHandling: ["Test workers receive minimal environments."],
    approvalRequiredOperations: [],
    releaseBoundary: "local_preparation_only",
    stopAndAskConditions: ["missing_authority", "forbidden_file_scope"],
  },
  reviewPolicyTask,
} as const;

function runSignal(): AbortSignal {
  return AbortSignal.timeout(20_000);
}

function snapshotDirectory(directory: string): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = (current: string, relative: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const entryRelative = path.join(relative, entry.name);
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath, entryRelative);
      else snapshot[entryRelative] = readFileSync(entryPath).toString("base64");
    }
  };
  visit(directory, "");
  return snapshot;
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
      streamVersion: 21,
      leaseOwner: "worker-1",
      paused: false,
      stopAndAsk: null,
      uncertainEffect: null,
      capabilityBoundary: null,
      capabilityResolution: null,
      superseded: false,
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
      "task.worktree_creation_started",
      "task.leased",
      "task.started",
      "task.artifact_recording",
      "artifact.patch_recorded",
      "task.validation_started",
      "task.artifact_recording",
      "artifact.validation_report_recorded",
      "task.review_requested",
      "task.artifact_recording",
      "artifact.review_report_recorded",
      "task.review_approved",
      "task.integration_started",
      "task.artifact_recording",
      "artifact.integration_receipt_recorded",
      "task.integration_prepared",
      "task.integration_observed",
      "task.cleanup_started",
      "task.cleanup_completed",
      "task.completed",
    ]);
    const validationStarted = events.find((event) => event.type === "task.validation_started");
    expect(validationStarted?.payload).toMatchObject({
      patch: { path: "greeting.txt", sha256: sha256("hello from Zentra\n") },
      diffSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const reviewRequested = events.find((event) => event.type === "task.review_requested");
    expect(reviewRequested?.payload).toMatchObject({
      validation: { name: "focused", outcome: "completed", exitCode: 0 },
    });
    const approved = events.find((event) => event.type === "task.review_approved")?.payload as {
      review: unknown;
    };
    expect(events.find((event) => event.type === "task.integration_observed")?.payload).toMatchObject({
      verification: "verified",
      receipt: { outcome: "completed" },
      cleanupFailures: [],
    });
    const completed = events.find((event) => event.type === "task.completed")?.payload as {
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
    const artifactView = projectArtifacts(events);
    expect(artifactView.artifacts.map((artifact) => artifact.kind)).toEqual([
      "patch",
      "validation_report",
      "review_report",
      "integration_receipt",
    ]);
    const patchArtifact = artifactView.artifacts.find((artifact) => artifact.kind === "patch")!;
    const review = approved.review as { diffSha256: string };
    expect(patchArtifact.sha256).toBe(review.diffSha256);
    const receiptArtifact = artifactView.artifacts.find(
      (artifact) => artifact.kind === "integration_receipt",
    )!;
    expect(receiptArtifact.sha256).toBe(sha256(JSON.stringify(completed.receipt)));
    expect(artifactView.phaseByArtifactId[receiptArtifact.artifactId]).toBe("final");
    expect(artifactView.artifacts.every((artifact) => artifact.path.startsWith("artifacts/"))).toBe(
      true,
    );
    expect(existsSync(path.join(fixture.worktreeRoot, runInput.taskId))).toBe(false);
    const ticketRef = await new GitClient().run(fixture.repositoryPath, [
      "show-ref",
      "--verify",
      `refs/heads/ticket/${runInput.taskId}`,
    ]);
    expect(ticketRef.exitCode).not.toBe(0);
  });

  it("appends each successful artifact and consuming lifecycle boundary as one batch", async () => {
    const fixture = await fixtureRepository();
    const batches: string[][] = [];
    class RecordingTaskService extends TaskService {
      override appendBatch(
        ...args: Parameters<TaskService["appendBatch"]>
      ): ReturnType<TaskService["appendBatch"]> {
        batches.push(args[1].map((input) => input.type));
        return super.appendBatch(...args);
      }
    }
    const { orchestrator } = system(fixture.configPath, {
      taskService: (journal) => new RecordingTaskService(journal),
    });

    await orchestrator.run({ ...runInput, taskId: "task-atomic-boundaries", signal: runSignal() });

    expect(batches).toEqual(expect.arrayContaining([
      ["task.artifact_recording", "artifact.patch_recorded", "task.validation_started"],
      ["task.artifact_recording", "artifact.validation_report_recorded", "task.review_requested"],
      ["task.artifact_recording", "artifact.review_report_recorded", "task.review_approved"],
      ["task.artifact_recording", "artifact.integration_receipt_recorded", "task.integration_prepared"],
    ]));
    expect(batches.filter((batch) => batch.includes("task.artifact_recording"))).toHaveLength(4);
  });

  it("rejects replay when every typed artifact event is deleted", async () => {
    const fixture = await fixtureRepository();
    const { journal, orchestrator } = system(fixture.configPath);
    await orchestrator.run({ ...runInput, signal: runSignal() });

    const tamperedEvents = journal.readStream(runInput.taskId).filter(
      (event) => !event.type.startsWith("artifact."),
    );

    expect(() => projectArtifacts(tamperedEvents)).toThrow("missing patch artifact");
  });

  it.each([
    "patch",
    "validation_report",
    "review_report",
    "integration_receipt",
  ] as const)("detects trailing %s artifact deletion after an immediate crash", async (kind) => {
    const fixture = await fixtureRepository();
    class CrashAfterArtifactTaskService extends TaskService {
      private crashed = false;

      override appendBatch(
        ...args: Parameters<TaskService["appendBatch"]>
      ): ReturnType<TaskService["appendBatch"]> {
        if (this.crashed) throw new Error(`simulated crash after ${kind}`);
        const view = super.appendBatch(...args);
        if (args[1].some((input) => input.type === `artifact.${kind}_recorded`)) {
          this.crashed = true;
          throw new Error(`simulated crash after ${kind}`);
        }
        return view;
      }

      override get(taskId: string): ReturnType<TaskService["get"]> {
        if (this.crashed) throw new Error(`simulated crash after ${kind}`);
        return super.get(taskId);
      }
    }
    const { journal, orchestrator } = system(fixture.configPath, {
      taskService: (stream) => new CrashAfterArtifactTaskService(stream),
    });

    await expect(orchestrator.run({
      ...runInput,
      taskId: `task-crash-${kind}`,
      signal: runSignal(),
    })).rejects.toThrow(`simulated crash after ${kind}`);
    const stream = journal.readStream(`task-crash-${kind}`);
    expect(stream.some((event) => event.type === `artifact.${kind}_recorded`)).toBe(true);

    expect(() => projectArtifacts(stream.filter(
      (event) => event.type !== `artifact.${kind}_recorded`,
    ))).toThrow(
      `artifact protocol marker references missing ${kind} artifact`,
    );
  });

  it("records a final failed receipt when the integration ref moves after preparation", async () => {
    const fixture = await fixtureRepository();
    const validations = new ValidationRunner(new ProcessSupervisor());
    const delegate = new IntegrationQueue(new GitClient(), validations);
    class PostPreparationCasFailure extends IntegrationQueue {
      override integrate(input: Parameters<IntegrationQueue["integrate"]>[0]): Promise<IntegrationReceipt> {
        return delegate.integrate({
          ...input,
          onPrepared: async (prepared) => {
            await input.onPrepared?.(prepared);
            await gitOk(input.project.repositoryPath, ["switch", input.project.integrationBranch]);
            writeFileSync(path.join(input.project.repositoryPath, "competing.txt"), "competing\n");
            await gitOk(input.project.repositoryPath, ["add", "--", "competing.txt"]);
            await gitOk(input.project.repositoryPath, ["commit", "-m", "competing integration"]);
          },
        });
      }
    }
    const { journal, orchestrator } = system(fixture.configPath, {
      validations,
      integrations: new PostPreparationCasFailure(new GitClient(), validations),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-post-preparation-cas-failure",
      signal: runSignal(),
    });

    expect(result).toMatchObject({ lifecycle: "terminal", terminalOutcome: "failed" });
    const events = journal.readStream(result.taskId);
    expect(events.find((event) => event.type === "task.integration_prepared")?.payload)
      .toMatchObject({ receipt: { outcome: "completed" } });
    expect(events.at(-1)).toMatchObject({
      type: "task.failed",
      payload: { receipt: { outcome: "failed", resultCommit: expect.any(String) } },
    });
    const artifacts = projectArtifacts(events);
    const receiptArtifact = artifacts.artifacts.find((artifact) =>
      artifact.kind === "integration_receipt");
    expect(artifacts.evidenceByArtifactId[receiptArtifact!.artifactId])
      .toMatchObject({ outcome: "failed", resultCommit: expect.any(String) });
    expect(artifacts.phaseByArtifactId[receiptArtifact!.artifactId]).toBe("final");
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

  it("pauses when candidate cleanup is not proven complete", async () => {
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

    expect(result).toMatchObject({ paused: true, terminalOutcome: null });
    expect(journal.readStream(result.taskId).find((event) =>
      event.type === "task.integration_observed")?.payload).toMatchObject({
      cleanupFailures: [
        {
          taskId: result.taskId,
          reason: expect.stringContaining("candidate cleanup"),
        },
      ],
    });
    expect(journal.readStream(result.taskId).at(-1)).toMatchObject({
      type: "task.effect_uncertain",
      payload: { boundary: "cleanup", recoveryClassification: "await_reconciliation" },
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
      workerFixture,
    );

    await expect(orchestrator.run({
      ...runInput,
      taskId: "task-restart-real-evidence",
      signal: runSignal(),
    })).resolves.toMatchObject({ paused: true, terminalOutcome: null });
    expect(firstJournal.readStream("task-restart-real-evidence").at(-1)).toMatchObject({
      type: "task.effect_uncertain",
      payload: { boundary: "integration" },
    });
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
      action: "await_reconciliation",
    });
    expect(existsSync(path.join(fixture.worktreeRoot, "task-restart-real-evidence"))).toBe(true);
  }, 15_000);

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
      workerFixture,
    );

    await expect(orchestrator.run({
      ...runInput,
      taskId: "task-retained-candidate",
      signal: runSignal(),
    })).resolves.toMatchObject({ paused: true, terminalOutcome: null });
    const prepared = journal.readStream("task-retained-candidate").find((event) =>
      event.type === "task.integration_prepared")?.payload as {
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
      reason: expect.stringMatching(/candidate.*cleanup|cleanup.*retained/i),
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
      workerFixture,
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
    expect(journal.readStream(result.taskId).find((event) =>
      event.type === "task.cleanup_observed")).toMatchObject({
      payload: { phase: "worktree_removal", uncertain: true },
    });
    expect(journal.readStream(result.taskId).at(-1)).toMatchObject({
      type: "task.effect_uncertain",
      payload: { boundary: "cleanup" },
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
    expect(projectArtifacts(journal.readStream(runInput.taskId)).artifacts).toEqual([]);
    expect(journal.readStream(runInput.taskId).map((event) => event.type)).toEqual([
      "task.created",
      "task.worktree_creation_started",
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
      "task.worktree_creation_started",
      "task.leased",
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
      "task.worktree_creation_started",
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
        override run(
          project: ProjectConfig,
          name: "focused" | "full",
          _cwd: string,
          _signal: AbortSignal,
          context?: Parameters<ValidationRunner["run"]>[4],
        ): Promise<ValidationReport> {
          const report = validationReport(project, name, outcome);
          return Promise.resolve({
            ...report,
            provenance: {
              ...report.provenance,
              subjectSha256: context?.subjectSha256 ?? null,
            },
          });
        }
      }
      const validations = new OutcomeValidation(new ProcessSupervisor());
      const batches: string[][] = [];
      const traceRoot = realpathSync.native(fixture.baseDirectory);
      const tracePath = path.join(traceRoot, `validation-${outcome}.jsonl`);
      const sink = AgentTailJsonlFileSink.open(traceRoot, tracePath);
      class RecordingTaskService extends TaskService {
        override appendBatch(
          ...args: Parameters<TaskService["appendBatch"]>
        ): ReturnType<TaskService["appendBatch"]> {
          batches.push(args[1].map((input) => input.type));
          return super.appendBatch(...args);
        }
      }
      const { journal, orchestrator } = system(fixture.configPath, {
        validations,
        taskService: (stream) => new RecordingTaskService(new ProjectingEventJournal(stream, sink)),
      });

      let result;
      try {
        result = await orchestrator.run({
          ...runInput,
          taskId: `task-validation-${outcome}`,
          signal: new AbortController().signal,
        });
      } finally {
        sink.close();
      }

      expect(result.terminalOutcome).toBe(outcome);
      expect(projectArtifacts(journal.readStream(result.taskId)).artifacts.map((artifact) =>
        artifact.kind)).toEqual(["patch", "validation_report"]);
      expect(journal.readStream(result.taskId).map((event) => event.type)).toEqual([
        "task.created",
        "task.worktree_creation_started",
        "task.leased",
        "task.started",
        "task.artifact_recording",
        "artifact.patch_recorded",
        "task.validation_started",
        "task.artifact_recording",
        "artifact.validation_report_recorded",
        `task.${outcome}`,
      ]);
      expect(batches).toContainEqual([
        "task.artifact_recording",
        "artifact.validation_report_recorded",
        `task.${outcome}`,
      ]);
      expect(JSON.parse(readFileSync(tracePath, "utf8").trimEnd().split("\n").at(-1)!) as unknown)
        .toMatchObject({ kind: `task.${outcome}`, operation: { status: outcome } });
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
    const batches: string[][] = [];
    class RecordingTaskService extends TaskService {
      override appendBatch(
        ...args: Parameters<TaskService["appendBatch"]>
      ): ReturnType<TaskService["appendBatch"]> {
        batches.push(args[1].map((input) => input.type));
        return super.appendBatch(...args);
      }
    }
    const { journal, orchestrator } = system(fixture.configPath, {
      validations: new ReplayingValidationRunner(new ProcessSupervisor()),
      reviewer,
      taskService: (stream) => new RecordingTaskService(stream),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: "task-replayed-focused-validation",
      signal: runSignal(),
    });

    expect(result.terminalOutcome).toBe("failed");
    expect(reviewerCalls).toBe(0);
    const events = journal.readStream(result.taskId);
    expect(events.slice(-3).map((event) => event.type)).toEqual([
      "task.artifact_recording",
      "artifact.validation_report_recorded",
      "task.failed",
    ]);
    expect(events.at(-1)?.payload).toEqual({
      stage: "validation",
      reason: "focused validation report subject does not match the patch digest",
      validation: oldReport,
    });
    expect(batches).toContainEqual([
      "task.artifact_recording",
      "artifact.validation_report_recorded",
      "task.failed",
    ]);
    const artifacts = projectArtifacts(events);
    const validationArtifact = artifacts.artifacts.find((artifact) =>
      artifact.kind === "validation_report");
    expect(artifacts.evidenceByArtifactId[validationArtifact!.artifactId]).toEqual(oldReport);
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
    const batches: string[][] = [];
    class RecordingTaskService extends TaskService {
      override appendBatch(
        ...args: Parameters<TaskService["appendBatch"]>
      ): ReturnType<TaskService["appendBatch"]> {
        batches.push(args[1].map((input) => input.type));
        return super.appendBatch(...args);
      }
    }
    const { journal, orchestrator } = system(fixture.configPath, {
      reviewer,
      taskService: (stream) => new RecordingTaskService(stream),
    });

    const result = await orchestrator.run({
      ...runInput,
      taskId: `task-review-${kind}`,
      signal: new AbortController().signal,
    });

    expect(result.terminalOutcome).toBe(outcome);
    expect(projectArtifacts(journal.readStream(result.taskId)).artifacts.map((artifact) =>
      artifact.kind)).toEqual(
        kind === "valid"
          ? ["patch", "validation_report", "review_report"]
          : ["patch", "validation_report"],
      );
    expect(journal.readStream(result.taskId).map((event) => event.type)).toEqual([
      "task.created",
      "task.worktree_creation_started",
      "task.leased",
      "task.started",
      "task.artifact_recording",
      "artifact.patch_recorded",
      "task.validation_started",
      "task.artifact_recording",
      "artifact.validation_report_recorded",
      "task.review_requested",
      ...(kind === "valid"
        ? ["task.artifact_recording", "artifact.review_report_recorded"]
        : []),
      `task.${outcome}`,
    ]);
    if (kind === "valid") {
      expect(batches).toContainEqual([
        "task.artifact_recording",
        "artifact.review_report_recorded",
        "task.denied",
      ]);
    }
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
      const { journal, orchestrator } = system(fixture.configPath, {
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
      expect(projectArtifacts(journal.readStream(result.taskId)).artifacts.map((artifact) =>
        artifact.kind)).toEqual(["patch", "validation_report", "review_report"]);
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
      const batches: string[][] = [];
      class RecordingTaskService extends TaskService {
        override appendBatch(
          ...args: Parameters<TaskService["appendBatch"]>
        ): ReturnType<TaskService["appendBatch"]> {
          batches.push(args[1].map((input) => input.type));
          return super.appendBatch(...args);
        }
      }
      const { journal, orchestrator } = system(fixture.configPath, {
        integrations: new OutcomeIntegration(new GitClient(), validations),
        taskService: (stream) => new RecordingTaskService(stream),
      });

      const result = await orchestrator.run({
        ...runInput,
        taskId: `task-integration-${outcome}`,
        signal: new AbortController().signal,
      });

      expect(result.terminalOutcome).toBe(outcome);
      expect(projectArtifacts(journal.readStream(result.taskId)).artifacts.map((artifact) =>
        artifact.kind)).toEqual([
          "patch",
          "validation_report",
          "review_report",
          "integration_receipt",
        ]);
      expect(batches).toContainEqual([
        "task.artifact_recording",
        "artifact.integration_receipt_recorded",
        `task.${outcome}`,
      ]);
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
    expect(journal.readStream(result.taskId).at(-1)?.type).toBe("task.effect_uncertain");
    const observation = journal.readStream(result.taskId).findLast((event) =>
      event.type === "task.integration_observed")?.payload;
    expect(observation).toMatchObject({
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
    expect(journal.readStream(result.taskId).findLast((event) =>
      event.type === "task.integration_observed")?.payload).toMatchObject({
      verification: "failed",
      reason: expect.stringMatching(/replace/i),
    });
  });

  it.each([
    ["replacement refs", async (input: Parameters<IntegrationQueue["integrate"]>[0]) => {
      const source = await gitOk(input.project.repositoryPath, [
        "rev-parse",
        `refs/heads/${input.lease.branch}`,
      ]);
      const integration = await gitOk(input.project.repositoryPath, [
        "rev-parse",
        `refs/heads/${input.project.integrationBranch}`,
      ]);
      await gitOk(input.project.repositoryPath, ["replace", source, integration]);
    }],
    ["a graft file", async (input: Parameters<IntegrationQueue["integrate"]>[0]) => {
      const source = await gitOk(input.project.repositoryPath, [
        "rev-parse",
        `refs/heads/${input.lease.branch}`,
      ]);
      const integration = await gitOk(input.project.repositoryPath, [
        "rev-parse",
        `refs/heads/${input.project.integrationBranch}`,
      ]);
      writeFileSync(
        path.join(input.project.repositoryPath, ".git", "info", "grafts"),
        `${source} ${integration}\n`,
      );
    }],
  ] as const)("rejects pre-existing %s before integration effects", async (_name, substitute) => {
    const fixture = await fixtureRepository();
    const taskId = `task-pre-existing-${_name.replaceAll(" ", "-")}`;
    let sourceRead = false;
    let candidateCreated = false;
    let mergeAttempted = false;
    let updateRefAttempted = false;
    let fullValidationAttempted = false;
    let integrationRefBefore = "";
    let worktreeBefore: Readonly<Record<string, string>> = {};
    let completionEvidenceBefore = "";
    let journal!: SqliteEventJournal;

    class EffectTrackingGitClient extends GitClient {
      override run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): Promise<CommandResult> {
        if (args[0] === "rev-parse" && args.at(-1)?.includes(`ticket/${taskId}`)) sourceRead = true;
        if (args.includes("worktree") && args.includes("add")) candidateCreated = true;
        if (args.includes("merge") && !args.includes("merge-base")) mergeAttempted = true;
        if (args.includes("update-ref") && args.includes("--no-deref")) updateRefAttempted = true;
        return super.run(cwd, args, options);
      }
    }
    class EffectTrackingValidationRunner extends ValidationRunner {
      override run(...args: Parameters<ValidationRunner["run"]>): Promise<ValidationReport> {
        fullValidationAttempted = true;
        return super.run(...args);
      }
    }
    const integrationValidation = new EffectTrackingValidationRunner(new ProcessSupervisor());
    const delegate = new IntegrationQueue(new EffectTrackingGitClient(), integrationValidation);
    class PreExistingSubstitutionIntegration extends IntegrationQueue {
      override async integrate(input: Parameters<IntegrationQueue["integrate"]>[0]) {
        integrationRefBefore = await gitOk(input.project.repositoryPath, [
          "rev-parse",
          `refs/heads/${input.project.integrationBranch}`,
        ]);
        worktreeBefore = snapshotDirectory(input.lease.path);
        completionEvidenceBefore = JSON.stringify(
          journal.readStream(taskId).filter((event) => event.type === "task.completed"),
        );
        await substitute(input);
        return delegate.integrate(input);
      }
    }
    const setup = system(fixture.configPath, {
      integrations: new PreExistingSubstitutionIntegration(
        new GitClient(),
        new ValidationRunner(new ProcessSupervisor()),
      ),
    });
    journal = setup.journal;

    const result = await setup.orchestrator.run({ ...runInput, taskId, signal: runSignal() });

    expect(result.terminalOutcome).toBe("failed");
    expect(sourceRead).toBe(false);
    expect(candidateCreated).toBe(false);
    expect(mergeAttempted).toBe(false);
    expect(fullValidationAttempted).toBe(false);
    expect(updateRefAttempted).toBe(false);
    expect(await gitOk(fixture.repositoryPath, [
      "rev-parse",
      "refs/heads/zentra/integration",
    ])).toBe(integrationRefBefore);
    expect(snapshotDirectory(path.join(fixture.worktreeRoot, taskId))).toEqual(worktreeBefore);
    expect(JSON.stringify(
      journal.readStream(taskId).filter((event) => event.type === "task.completed"),
    )).toBe(completionEvidenceBefore);
  });

  it("rejects a graft introduced after candidate validation and before update-ref", async () => {
    const fixture = await fixtureRepository();
    const taskId = "task-racing-graft";
    let updateRefAttempted = false;
    let validationCompleted = false;
    let integrationRefBefore = "";
    let worktreeBefore: Readonly<Record<string, string>> = {};
    let completionEvidenceBefore = "";
    let journal!: SqliteEventJournal;

    class UpdateTrackingGitClient extends GitClient {
      override run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): Promise<CommandResult> {
        if (args.includes("update-ref") && args.includes("--no-deref")) updateRefAttempted = true;
        return super.run(cwd, args, options);
      }
    }
    class CompletingValidationRunner extends ValidationRunner {
      override async run(
        ...args: Parameters<ValidationRunner["run"]>
      ): Promise<ValidationReport> {
        const report = await super.run(...args);
        validationCompleted = true;
        return report;
      }
    }
    const integrationValidation = new CompletingValidationRunner(new ProcessSupervisor());
    const delegate = new IntegrationQueue(new UpdateTrackingGitClient(), integrationValidation);
    class RacingSubstitutionIntegration extends IntegrationQueue {
      override async integrate(input: Parameters<IntegrationQueue["integrate"]>[0]) {
        integrationRefBefore = await gitOk(input.project.repositoryPath, [
          "rev-parse",
          `refs/heads/${input.project.integrationBranch}`,
        ]);
        worktreeBefore = snapshotDirectory(input.lease.path);
        completionEvidenceBefore = JSON.stringify(
          journal.readStream(taskId).filter((event) => event.type === "task.completed"),
        );
        return delegate.integrate({
          ...input,
          onPrepared: async (receipt) => {
            expect(validationCompleted).toBe(true);
            await input.onPrepared?.(receipt);
            const commonDirectory = await gitOk(input.project.repositoryPath, [
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ]);
            writeFileSync(path.join(commonDirectory, "info", "grafts"), `${receipt.resultCommit}\n`);
          },
        });
      }
    }
    const setup = system(fixture.configPath, {
      integrations: new RacingSubstitutionIntegration(
        new GitClient(),
        new ValidationRunner(new ProcessSupervisor()),
      ),
    });
    journal = setup.journal;

    const result = await setup.orchestrator.run({ ...runInput, taskId, signal: runSignal() });

    expect(result.lifecycle).toBe("integrating");
    expect(updateRefAttempted).toBe(false);
    expect(await gitOk(fixture.repositoryPath, [
      "rev-parse",
      "refs/heads/zentra/integration",
    ])).toBe(integrationRefBefore);
    expect(snapshotDirectory(path.join(fixture.worktreeRoot, taskId))).toEqual(worktreeBefore);
    expect(journal.readStream(taskId).some((event) => event.type === "task.integration_prepared")).toBe(
      true,
    );
    expect(JSON.stringify(
      journal.readStream(taskId).filter((event) => event.type === "task.completed"),
    )).toBe(completionEvidenceBefore);
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
    expect(journal.readStream(result.taskId).find((event) =>
      event.type === "task.commit_observed")).toBeDefined();
    expect(journal.readStream(result.taskId).at(-1)).toMatchObject({
      type: "task.effect_uncertain",
      payload: { boundary: "commit", retryPolicy: "never_automatic" },
    });
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
    expect(journal.readStream(result.taskId).findLast((event) =>
      event.type === "task.integration_observed")?.payload).toEqual({
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

  describe("uncertain worktree creation (issue 002)", () => {
    // A GitClient that reports the exact real result of "git worktree add"
    // (a genuine subprocess always actually runs, so real Git state is
    // created exactly as it would be in production) but overrides how that
    // result is reported back to the caller, to deterministically simulate
    // the three points at which an interruption can be observed:
    //   (a) before the Git effect runs at all,
    //   (b) after Git has been invoked but its result is reported uncertain
    //       (mirrors a mid-effect cancellation/timeout),
    //   (c) after the effect is fully known to have succeeded.
    class WorktreeAddInterceptingGitClient extends GitClient {
      constructor(private readonly mode: "before" | "uncertain" | "branch-only" | "after") {
        super();
      }

      override async run(
        cwd: string,
        args: readonly string[],
        options: GitRunOptions = {},
      ): Promise<CommandResult> {
        const isWorktreeAdd = args.includes("worktree") && args.includes("add");
        if (isWorktreeAdd && this.mode === "before") {
          return {
            stdout: "",
            stderr: "Git execution cancelled before start",
            exitCode: -1,
            truncated: false,
            termination: "cancelled",
          };
        }
        if (isWorktreeAdd && this.mode === "branch-only") {
          const branch = args[args.indexOf("-b") + 1]!;
          const baseCommit = args.at(-1)!;
          await super.run(cwd, ["branch", branch, baseCommit], options);
          return {
            stdout: "",
            stderr: "worktree add failed after creating branch",
            exitCode: 1,
            truncated: false,
            termination: null,
          };
        }
        const result = await super.run(cwd, args, options);
        if (isWorktreeAdd && this.mode === "uncertain") {
          // The real "git worktree add" subprocess above already ran to
          // completion (Git may have created the branch and/or worktree),
          // but the caller observes this as an uncertain termination, just
          // as a real cancellation/timeout racing the process exit would.
          return { ...result, exitCode: -1, termination: "cancelled" };
        }
        return result;
      }
    }

    async function runWithInterceptedCreation(
      fixture: Awaited<ReturnType<typeof fixtureRepository>>,
      taskId: string,
      mode: "before" | "uncertain" | "branch-only" | "after",
      databasePath: string,
    ) {
      const worktrees = new WorktreeManager(new WorktreeAddInterceptingGitClient(mode));
      const journal = new SqliteEventJournal(databasePath);
      journals.push(journal);
      const tasks = new TaskService(journal);
      const projects = ProjectRegistry.fromFile(fixture.configPath);
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
        workerFixture,
      );
      const result = await orchestrator.run({
        ...runInput,
        taskId,
        signal: runSignal(),
      });
      return { journal, orchestrator, tasks, worktrees, projects, result };
    }

    it("(a) before any Git effect: leaves the task queued with no worktree evidence at all", async () => {
      const fixture = await fixtureRepository();
      const databasePath = path.join(fixture.baseDirectory, "before.sqlite");
      const { journal, result } = await runWithInterceptedCreation(
        fixture,
        "task-interrupt-before",
        "before",
        databasePath,
      );

      expect(result.lifecycle).toBe("queued");
      expect(result.terminalOutcome).toBeNull();
      const types = journal.readStream("task-interrupt-before").map((event) => event.type);
      expect(types).toEqual([
        "task.created",
        "task.worktree_creation_started",
        "task.effect_uncertain",
      ]);
      expect(existsSync(path.join(fixture.worktreeRoot, "task-interrupt-before"))).toBe(false);
      const branch = await new GitClient().run(fixture.repositoryPath, [
        "show-ref", "--verify", "refs/heads/ticket/task-interrupt-before",
      ]);
      expect(branch.exitCode).not.toBe(0);

      // Regression guard: the task must never be silently terminalized
      // (cancelled/timed_out/failed) merely because Git was interrupted.
      expect(result.terminalOutcome).not.toBe("cancelled");
      expect(result.terminalOutcome).not.toBe("timed_out");
      expect(result.terminalOutcome).not.toBe("failed");
    });

    it("(b) after Git ran but the result is reported uncertain: leaves the task nonterminal with durable prepared evidence, and recovery reconciles the real Git state", async () => {
      const fixture = await fixtureRepository();
      const databasePath = path.join(fixture.baseDirectory, "uncertain.sqlite");
      const { journal, worktrees, projects, result } = await runWithInterceptedCreation(
        fixture,
        "task-interrupt-uncertain",
        "uncertain",
        databasePath,
      );

      expect(result.lifecycle).toBe("queued");
      expect(result.terminalOutcome).toBeNull();
      const types = journal.readStream("task-interrupt-uncertain").map((event) => event.type);
      expect(types).toEqual([
        "task.created",
        "task.worktree_creation_started",
        "task.effect_uncertain",
      ]);

      // Git actually ran to completion underneath the uncertain report, so
      // the branch and worktree are genuinely present on disk.
      expect(existsSync(path.join(fixture.worktreeRoot, "task-interrupt-uncertain"))).toBe(true);
      const branch = await new GitClient().run(fixture.repositoryPath, [
        "show-ref", "--verify", "refs/heads/ticket/task-interrupt-uncertain",
      ]);
      expect(branch.exitCode).toBe(0);
      journal.close();
      journals.splice(journals.indexOf(journal), 1);

      // Simulate a real restart: reopen the same durable journal file.
      const restartedJournal = new SqliteEventJournal(databasePath);
      journals.push(restartedJournal);
      const recovery = new RecoveryService(
        restartedJournal,
        new TaskService(restartedJournal),
        projects,
        worktrees,
        new GitClient(),
      );
      await expect(recovery.inspect("task-interrupt-uncertain")).resolves.toMatchObject({
        action: "await_reconciliation",
      });
    });

    it("records branch-only partial effect evidence as nonterminal and awaits reconciliation", async () => {
      const fixture = await fixtureRepository();
      const databasePath = path.join(fixture.baseDirectory, "branch-only.sqlite");
      const { journal, worktrees, projects, result } = await runWithInterceptedCreation(
        fixture,
        "task-branch-only",
        "branch-only",
        databasePath,
      );

      expect(result).toMatchObject({ lifecycle: "queued", terminalOutcome: null });
      expect(journal.readStream(result.taskId).map((event) => event.type)).toEqual([
        "task.created",
        "task.worktree_creation_started",
        "task.effect_uncertain",
      ]);
      expect(existsSync(path.join(fixture.worktreeRoot, result.taskId))).toBe(false);
      expect(await gitOk(fixture.repositoryPath, [
        "rev-parse",
        `refs/heads/ticket/${result.taskId}`,
      ])).toMatch(/^[a-f0-9]{40}$/);

      const recovery = new RecoveryService(
        journal,
        new TaskService(journal),
        projects,
        worktrees,
        new GitClient(),
      );
      await expect(recovery.inspect(result.taskId)).resolves.toMatchObject({
        action: "await_reconciliation",
      });
    });

    it("(c) after full registration succeeds: leaves the task with prepared evidence, ready to adopt as leased", async () => {
      const fixture = await fixtureRepository();
      const databasePath = path.join(fixture.baseDirectory, "after.sqlite");
      const { journal, result } = await runWithInterceptedCreation(
        fixture,
        "task-interrupt-after",
        "after",
        databasePath,
      );

      // In this mode nothing is intercepted after Git succeeds, so the
      // orchestrator observes the real success and proceeds normally.
      expect(result.terminalOutcome).toBe("completed");
      const types = journal.readStream("task-interrupt-after").map((event) => event.type);
      expect(types[0]).toBe("task.created");
      expect(types[1]).toBe("task.worktree_creation_started");
      expect(types[2]).toBe("task.leased");
    });

    it("(d) adopt path: a task recovered as 'exact match, adopt' genuinely resumes and reaches completion, not just a decision label", async () => {
      // This is the Critical-severity regression this issue exists to fix:
      // recovery.inspect() previously only ever *labeled* this state
      // resume_preparation with nothing able to act on that label. This
      // test proves actual forward progress: worktree_creation_started
      // durable evidence -> interruption before task.leased -> restart ->
      // recovery decides resume_preparation (adopt) -> the task is
      // genuinely resumed through TracerBulletOrchestrator.resume() ->
      // task.leased is durably appended -> the worker actually runs ->
      // the task reaches full completion (task.completed), the strongest
      // proof of forward progress the test infrastructure can produce.
      const fixture = await fixtureRepository();
      const databasePath = path.join(fixture.baseDirectory, "adopt.sqlite");
      const taskId = "task-adopt-resume";

      // Phase 1: interrupt exactly at the point real Git succeeded but the
      // caller never durably recorded task.leased (mirrors mode "uncertain"
      // above, but here we let the *caller* (not the orchestrator) observe
      // the interruption, by driving WorktreeManager.create() directly with
      // a real Git client and truncating before task.leased is appended --
      // reusing the same durable "prepared" callback contract the
      // orchestrator itself relies on).
      const journal1 = new SqliteEventJournal(databasePath);
      journals.push(journal1);
      const tasks1 = new TaskService(journal1);
      const projects = ProjectRegistry.fromFile(fixture.configPath);
      const worktrees = new WorktreeManager(new GitClient());
      const project = projects.get("greeting-project");

      tasks1.create({
        taskId,
        projectId: "greeting-project",
        title: "Update greeting",
        correlationId: taskId,
      });
      await worktrees.ensureIntegrationBranch(project);
      const lease = await worktrees.create(project, taskId, {}, (intent) => {
        tasks1.append(taskId, "task.worktree_creation_started", intent, null);
      });
      // Deliberately stop here: never append task.leased, simulating a
      // process kill/interruption between Git's real success and the
      // durable leased fact -- exactly the uncertain window issue 002
      // describes. Verify the interrupted state genuinely matches what an
      // end user would see after a crash.
      expect(existsSync(lease.path)).toBe(true);
      expect(journal1.readStream(taskId).map((event) => event.type)).toEqual([
        "task.created",
        "task.worktree_creation_started",
      ]);
      journal1.close();
      journals.splice(journals.indexOf(journal1), 1);

      // Phase 2: restart. Reopen the same durable journal file, exactly as
      // a real CLI restart would.
      const journal2 = new SqliteEventJournal(databasePath);
      journals.push(journal2);
      const tasks2 = new TaskService(journal2);
      const recovery = new RecoveryService(
        journal2,
        tasks2,
        projects,
        worktrees,
        new GitClient(),
      );

      const decision = await recovery.inspect(taskId);
      expect(decision.action).toBe("resume_preparation");
      expect(decision.reason).toMatch(/exact intended branch, path, and base/i);

      // Regression guard: recovery must never have silently terminalized
      // this task while it awaited reconciliation.
      const preResumeView = tasks2.get(taskId);
      expect(preResumeView?.lifecycle).toBe("queued");
      expect(preResumeView?.terminalOutcome).toBeNull();

      // Phase 3: actually resume through the new adopt path (not merely
      // asserting the decision label, per the reviewer's core complaint).
      const supervisor = new ProcessSupervisor();
      const validations = new ValidationRunner(supervisor);
      const orchestrator = new TracerBulletOrchestrator(
        tasks2,
        projects,
        worktrees,
        supervisor,
        validations,
        new DeterministicReviewerAdapter(supervisor, reviewerFixture),
        new ReviewGate(),
        new IntegrationQueue(new GitClient(), validations),
        workerFixture,
      );

      const result = await orchestrator.resume({
        ...runInput,
        taskId,
        signal: runSignal(),
      });

      // Genuine forward progress: the task reached full completion, not
      // just a resume_preparation label. task.leased was durably appended
      // (proving adoption happened), the worker actually ran (task.started
      // and beyond exist), and the task completed end to end.
      expect(result.lifecycle).toBe("terminal");
      expect(result.terminalOutcome).toBe("completed");
      const finalTypes = journal2.readStream(taskId).map((event) => event.type);
      expect(finalTypes[0]).toBe("task.created");
      expect(finalTypes[1]).toBe("task.worktree_creation_started");
      expect(finalTypes[2]).toBe("task.leased");
      expect(finalTypes).toContain("task.started");
      expect(finalTypes).toContain("task.completed");

      // The adopt path never re-ran "git worktree add": the worktree
      // registration is exactly the one Git created in phase 1, and its
      // ticket branch commit lineage is unbroken back to that base.
      const registered = await gitOk(fixture.repositoryPath, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      expect(registered).not.toContain(lease.path + "\n" + lease.path);
    });

    it("(e) proven no-effect path retries creation exactly once and completes", async () => {
      const fixture = await fixtureRepository();
      const databasePath = path.join(fixture.baseDirectory, "adopt-refuse.sqlite");
      const taskId = "task-adopt-refuse";

      const journal = new SqliteEventJournal(databasePath);
      journals.push(journal);
      const tasks = new TaskService(journal);
      const projects = ProjectRegistry.fromFile(fixture.configPath);
      let creationAttempts = 0;
      class CountingGitClient extends GitClient {
        override run(
          cwd: string,
          args: readonly string[],
          options: GitRunOptions = {},
        ): Promise<CommandResult> {
          if (args.includes("worktree") && args.includes("add")) creationAttempts += 1;
          return super.run(cwd, args, options);
        }
      }
      const worktrees = new WorktreeManager(new CountingGitClient());
      const project = projects.get("greeting-project");

      tasks.create({
        taskId,
        projectId: "greeting-project",
        title: "Update greeting",
        correlationId: taskId,
      });
      await worktrees.ensureIntegrationBranch(project);
      const intent = {
        taskId,
        branch: `ticket/${taskId}`,
        path: path.join(fixture.worktreeRoot, taskId),
        baseCommit: await gitOk(project.repositoryPath, ["rev-parse", project.integrationBranch]),
      };
      tasks.append(taskId, "task.worktree_creation_started", intent, null);
      // No Git effect ever occurred: recovery may retry once after proving absence.

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
        workerFixture,
      );

      const result = await orchestrator.resume({ ...runInput, taskId, signal: runSignal() });
      expect(result.lifecycle).toBe("terminal");
      expect(result.terminalOutcome).toBe("completed");

      const types = journal.readStream(taskId).map((event) => event.type);
      expect(types.slice(0, 3)).toEqual([
        "task.created",
        "task.worktree_creation_started",
        "task.leased",
      ]);
      expect(types).toContain("task.completed");
      expect(creationAttempts).toBe(1);
      expect(existsSync(intent.path)).toBe(false);
    });
  });
});
