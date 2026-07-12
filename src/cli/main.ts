#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import { ValidationRunner } from "../capabilities/validation-runner.js";
import {
  resolveBundledFixture,
} from "../fixtures/bundled-fixtures.js";
import { IntegrationQueue } from "../integration/integration-queue.js";
import { SqliteEventJournal } from "../journal/sqlite-journal.js";
import { RecoveryService } from "../orchestration/recovery.js";
import { TracerBulletOrchestrator } from "../orchestration/tracer-bullet.js";
import { ProjectConfigSchema, type ProjectConfig } from "../projects/project-config.js";
import { ProjectRegistry } from "../projects/project-registry.js";
import { ReviewGate } from "../reviews/review-gate.js";
import {
  ProcessReviewerAdapter,
  type ReviewerAdapter,
} from "../reviews/reviewer-adapter.js";
import { TaskService } from "../tasks/task-service.js";
import type { TaskView } from "../tasks/task-projection.js";
import { ProcessSupervisor } from "../workers/process-supervisor.js";
import { GitClient } from "../workspaces/git-client.js";
import { WorktreeManager } from "../workspaces/worktree-manager.js";

const WORKER_ID = "zentra-deterministic-worker";
const WORKER_TIMEOUT_MS = 120_000;
const MAX_OPERATIONAL_JSON_BYTES = 16_384;
const MAX_TASK_ID_LENGTH = 128;
const MAX_PROJECT_ID_BYTES = 128;
const MAX_TITLE_BYTES = 512;
const MAX_FILE_BYTES = 255;
const MAX_CONTENT_BYTES = 1_048_576;
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_PROJECT_CONFIGS = 256;

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  BUNDLED_FIXTURE_INVALID: "Bundled fixture attestation failed.",
  COMMAND_REQUIRED: "An operational command is required.",
  DATABASE_NOT_FOUND: "Event journal was not found.",
  INVALID_COMMAND: "Invalid command arguments.",
  INVALID_CONFIG: "Project configuration is invalid.",
  INVALID_CONTENT: "Task content is too large.",
  INVALID_FILE: "File must be one safe root-level filename.",
  INVALID_TASK_ID: "Task ID must be one safe path and ref component.",
  INVALID_TITLE: "Task title is invalid.",
  OPERATION_FAILED: "Operation failed.",
  OUTPUT_TOO_LARGE: "Operational output exceeded the limit.",
  TASK_NOT_FOUND: "Task was not found.",
});

type PublicErrorCode = keyof typeof PUBLIC_ERROR_MESSAGES;

type WriteOutput = (value: string) => void;

export interface CliRuntime {
  readonly stdout?: WriteOutput;
  readonly stderr?: WriteOutput;
  readonly signalSource?: SignalSource;
  readonly fixtureAnchor?: string | URL;
}

export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

interface ProjectOptions {
  readonly config: string;
}

interface DatabaseTaskOptions {
  readonly database: string;
  readonly taskId: string;
}

interface RunOptions extends ProjectOptions, DatabaseTaskOptions {
  readonly title: string;
  readonly file: string;
  readonly content: string;
  readonly reviewerExecutable?: string;
  readonly reviewerArgument: readonly string[];
  readonly reviewerId?: string;
}

interface RecoverOptions extends ProjectOptions, DatabaseTaskOptions {}

interface CommandResult {
  readonly exitCode: number;
  readonly value: Record<string, unknown>;
}

class CliFailure extends Error {
  constructor(readonly code: PublicErrorCode) {
    super(PUBLIC_ERROR_MESSAGES[code]);
  }
}

export async function runCli(
  argv: readonly string[],
  runtime: CliRuntime = {},
): Promise<number> {
  const userArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const stdout = runtime.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = runtime.stderr ?? ((value: string) => process.stderr.write(value));
  const signalSource = runtime.signalSource ?? process;
  const controller = new AbortController();
  const abort = (): void => controller.abort(new DOMException("CLI signal", "AbortError"));
  signalSource.on("SIGINT", abort);
  signalSource.on("SIGTERM", abort);

  const commandResults: CommandResult[] = [];
  const program = createProgram(stdout, (result) => {
    commandResults.push(result);
  }, controller.signal, runtime.fixtureAnchor);

  try {
    await program.parseAsync([...userArgv], { from: "user" });
    const commandResult = commandResults[0];
    if (commandResult === undefined) {
      throw new CliFailure("COMMAND_REQUIRED");
    }
    const serialized = serializeJson(commandResult.value);
    if (Buffer.byteLength(serialized) > MAX_OPERATIONAL_JSON_BYTES) {
      writeFixedError(stderr, commandLabel(userArgv), "OUTPUT_TOO_LARGE");
      return 1;
    }
    writeSerialized(commandResult.exitCode === 0 ? stdout : stderr, serialized);
    return commandResult.exitCode;
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return 0;
    }
    const failure = toFailure(error);
    writeFixedError(stderr, commandLabel(userArgv), failure.code);
    return 1;
  } finally {
    signalSource.off("SIGINT", abort);
    signalSource.off("SIGTERM", abort);
  }
}

function createProgram(
  stdout: WriteOutput,
  setResult: (result: CommandResult) => void,
  signal: AbortSignal,
  fixtureAnchor: string | URL | undefined,
): Command {
  const program = new Command()
    .name("zentra")
    .description("Run the deterministic local Zentra MVP orchestrator.")
    .exitOverride()
    .configureOutput({ writeOut: stdout, writeErr: () => {} });

  const project = program.command("project").description("Manage project configuration.");
  project
    .command("validate")
    .description("Validate a Zentra project configuration file.")
    .requiredOption("--config <path>", "project configuration file")
    .action((options: ProjectOptions) => {
      const configs = loadProjects(options.config);
      new ProjectRegistry(configs);
      setResult({
        exitCode: 0,
        value: {
          command: "project.validate",
          status: "valid",
          projectIds: configs.map((config) => config.projectId),
        },
      });
    });

  const task = program.command("task").description("Run and inspect deterministic tasks.");
  task
    .command("run")
    .description("Run one deterministic local tracer-bullet task.")
    .requiredOption("--config <path>", "project configuration file")
    .requiredOption("--database <path>", "SQLite event journal")
    .requiredOption("--task-id <id>", "safe task identity")
    .requiredOption("--title <title>", "task title")
    .requiredOption("--file <relative-path>", "one root-level file")
    .requiredOption("--content <text>", "replacement file content")
    .option("--reviewer-executable <path>", "content-aware reviewer executable")
    .option(
      "--reviewer-argument <value>",
      "argument passed to the configured reviewer executable",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--reviewer-id <id>", "independent reviewer identity")
    .action(async (options: RunOptions) => {
      assertSafeTaskId(options.taskId);
      assertSafeTitle(options.title);
      assertSafeRootFile(options.file);
      assertSafeContent(options.content);
      const configs = loadProjects(options.config);
      if (configs.length !== 1) {
        throw new CliFailure("INVALID_CONFIG");
      }
      const projectConfig = configs[0]!;
      assertRepresentableTaskRun({
        taskId: options.taskId,
        projectId: projectConfig.projectId,
        title: options.title,
      });
      const reviewer = configuredReviewer(options);
      if (reviewer === null) {
        const denied = await withSystem(
          options.database,
          configs,
          "read-write",
          (system) => Promise.resolve(denyMissingReviewer(system.tasks, {
            taskId: options.taskId,
            projectId: projectConfig.projectId,
            title: options.title,
          })),
        );
        setResult(taskRunResult(denied));
        return;
      }
      const workerFixture = attestedWorkerFixture(fixtureAnchor);
      const result = await withSystem(options.database, configs, "read-write", async (system) => {
        const taskView = await system.execution(workerFixture, reviewer.adapter).orchestrator.run({
          taskId: options.taskId,
          projectId: projectConfig.projectId,
          title: options.title,
          workerId: WORKER_ID,
          reviewerId: reviewer.reviewerId,
          workerRequest: {
            executable: process.execPath,
            args: [
              workerFixture,
              "--file",
              options.file,
              "--content",
              options.content,
            ],
            timeoutMs: WORKER_TIMEOUT_MS,
          },
          signal,
        });
        return taskView;
      });
      setResult(taskRunResult(result));
    });

  task
    .command("status")
    .description("Replay one task status from the event journal.")
    .requiredOption("--database <path>", "SQLite event journal")
    .requiredOption("--task-id <id>", "safe task identity")
    .action(async (options: DatabaseTaskOptions) => {
      assertSafeTaskId(options.taskId);
      const taskView = await withSystem(options.database, [], "read-only", (system) =>
        Promise.resolve(system.tasks.get(options.taskId)));
      if (taskView === null) {
        throw new CliFailure("TASK_NOT_FOUND");
      }
      setResult({ exitCode: 0, value: { command: "task.status", task: taskView } });
    });

  program
    .command("recover")
    .description("Inspect one task and return its safe recovery classification.")
    .requiredOption("--config <path>", "project configuration file")
    .requiredOption("--database <path>", "SQLite event journal")
    .requiredOption("--task-id <id>", "safe task identity")
    .action(async (options: RecoverOptions) => {
      assertSafeTaskId(options.taskId);
      const configs = loadProjects(options.config);
      const decision = await withSystem(
        options.database,
        configs,
        "read-only",
        (system) =>
        system.recovery().inspect(options.taskId));
      setResult({
        exitCode: decision.action === "record_failure" ? 1 : 0,
        value: { command: "recover", decision: publicRecoveryDecision(decision) },
      });
    });

  return program;
}

async function withSystem<T>(
  databasePath: string,
  configs: readonly ProjectConfig[],
  mode: "read-only" | "read-write",
  operation: (system: ReturnType<typeof composeSystem>) => Promise<T>,
): Promise<T> {
  const journal = openJournal(databasePath, mode);
  try {
    return await operation(composeSystem(journal, configs));
  } finally {
    journal.close();
  }
}

function openJournal(
  databasePath: string,
  mode: "read-only" | "read-write",
): SqliteEventJournal {
  if (mode === "read-write") return new SqliteEventJournal(databasePath);
  if (!existsSync(databasePath)) throw new CliFailure("DATABASE_NOT_FOUND");
  try {
    return SqliteEventJournal.openReadOnly(databasePath);
  } catch (error) {
    if (!existsSync(databasePath)) throw new CliFailure("DATABASE_NOT_FOUND");
    throw error;
  }
}

function composeSystem(
  journal: SqliteEventJournal,
  configs: readonly ProjectConfig[],
) {
  const tasks = new TaskService(journal);
  let development: {
    readonly projects: ProjectRegistry;
    readonly git: GitClient;
    readonly worktrees: WorktreeManager;
  } | undefined;
  const developmentDependencies = () => {
    development ??= (() => {
      const git = new GitClient();
      return {
        projects: new ProjectRegistry(configs),
        git,
        worktrees: new WorktreeManager(git),
      };
    })();
    return development;
  };

  return {
    tasks,
    recovery(): RecoveryService {
      const { projects, git, worktrees } = developmentDependencies();
      return new RecoveryService(journal, tasks, projects, worktrees, git);
    },
    execution(workerFixture: string, reviewer: ReviewerAdapter) {
      const { projects, git, worktrees } = developmentDependencies();
      const supervisor = new ProcessSupervisor();
      const validations = new ValidationRunner(supervisor);
      return {
        orchestrator: new TracerBulletOrchestrator(
          tasks,
          projects,
          worktrees,
          supervisor,
          validations,
          reviewer,
          new ReviewGate(),
          new IntegrationQueue(git, validations),
        ),
      };
    },
  };
}

function taskRunResult(task: TaskView): CommandResult {
  return {
    exitCode: task.terminalOutcome === "completed" ? 0 : 1,
    value: {
      command: "task.run",
      outcome: task.terminalOutcome,
      task,
    },
  };
}

function loadProjects(configPath: string): readonly ProjectConfig[] {
  try {
    const configStat = statSync(configPath);
    if (!configStat.isFile() || configStat.size > MAX_CONFIG_BYTES) {
      throw new Error("invalid config file");
    }
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    if (candidates.length === 0 || candidates.length > MAX_PROJECT_CONFIGS) {
      throw new Error("invalid configuration count");
    }
    const configs = candidates.map((candidate) => ProjectConfigSchema.parse(candidate));
    if (configs.some((config) =>
      Buffer.byteLength(config.projectId, "utf8") > MAX_PROJECT_ID_BYTES
    )) {
      throw new Error("project identity is too large");
    }
    return configs;
  } catch {
    throw new CliFailure("INVALID_CONFIG");
  }
}

function attestedWorkerFixture(anchor?: string | URL): string {
  try {
    return anchor === undefined
      ? resolveBundledFixture("deterministic-worker.mjs")
      : resolveBundledFixture("deterministic-worker.mjs", anchor);
  } catch {
    throw new CliFailure("BUNDLED_FIXTURE_INVALID");
  }
}

function configuredReviewer(options: RunOptions): {
  readonly reviewerId: string;
  readonly adapter: ReviewerAdapter;
} | null {
  const executable = options.reviewerExecutable;
  const reviewerId = options.reviewerId;
  if (executable === undefined && reviewerId === undefined && options.reviewerArgument.length === 0) {
    return null;
  }
  if (
    executable === undefined ||
    executable.length === 0 ||
    reviewerId === undefined ||
    reviewerId.length === 0
  ) {
    throw new CliFailure("INVALID_COMMAND");
  }
  return {
    reviewerId,
    adapter: new ProcessReviewerAdapter({
      executable,
      args: options.reviewerArgument,
    }),
  };
}

function denyMissingReviewer(
  tasks: TaskService,
  input: { readonly taskId: string; readonly projectId: string; readonly title: string },
): TaskView {
  tasks.create({
    ...input,
    correlationId: input.taskId,
  });
  return tasks.append(
    input.taskId,
    "task.denied",
    {
      stage: "setup",
      reason: "content-aware reviewer is not configured",
    },
    null,
  );
}

function assertSafeRootFile(candidate: string): void {
  if (
    candidate.length === 0 ||
    Buffer.byteLength(candidate, "utf8") > MAX_FILE_BYTES ||
    candidate === "." ||
    candidate === ".." ||
    candidate.includes("/") ||
    candidate.includes("\\") ||
    path.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    throw new CliFailure("INVALID_FILE");
  }
}

function assertSafeTitle(title: string): void {
  if (title.length === 0 || Buffer.byteLength(title, "utf8") > MAX_TITLE_BYTES) {
    throw new CliFailure("INVALID_TITLE");
  }
}

function assertSafeContent(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    throw new CliFailure("INVALID_CONTENT");
  }
}

function assertSafeTaskId(taskId: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId) ||
    taskId.length > MAX_TASK_ID_LENGTH ||
    taskId.includes("..") ||
    taskId.includes("@{") ||
    taskId.endsWith(".") ||
    taskId.toLowerCase().endsWith(".lock")
  ) {
    throw new CliFailure("INVALID_TASK_ID");
  }
}

function toFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;
  if (error instanceof CommanderError) {
    return new CliFailure("INVALID_COMMAND");
  }
  return new CliFailure("OPERATION_FAILED");
}

function assertRepresentableTaskRun(input: {
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
}): void {
  const prospective = taskRunResult({
    ...input,
    lifecycle: "terminal",
    terminalOutcome: "completed",
    streamVersion: Number.MAX_SAFE_INTEGER,
    leaseOwner: WORKER_ID,
  });
  if (Buffer.byteLength(serializeJson(prospective.value)) > MAX_OPERATIONAL_JSON_BYTES) {
    throw new CliFailure("INVALID_CONFIG");
  }
}

function publicRecoveryDecision(decision: Awaited<ReturnType<RecoveryService["inspect"]>>) {
  const messages = {
    resume_preparation: "Recovery may resume preparation.",
    await_reconciliation: "Recovery requires reconciliation.",
    record_completion: "Recovery verified completion.",
    record_failure: "Recovery found invalid durable state.",
  } as const;
  return {
    taskId: decision.taskId,
    action: decision.action,
    message: messages[decision.action],
  };
}

function commandLabel(argv: readonly string[]): string {
  if (argv[0] === "project" && argv[1] === "validate") return "project.validate";
  if (argv[0] === "task" && argv[1] === "run") return "task.run";
  if (argv[0] === "task" && argv[1] === "status") return "task.status";
  if (argv[0] === "recover") return "recover";
  return "unknown";
}

function serializeJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function writeFixedError(
  write: WriteOutput,
  command: string,
  code: PublicErrorCode,
): void {
  const serialized = JSON.stringify({
    command,
    error: { code, message: PUBLIC_ERROR_MESSAGES[code] },
  });
  if (Buffer.byteLength(serialized) > MAX_OPERATIONAL_JSON_BYTES) {
    throw new Error("fixed public error exceeds operational output limit");
  }
  writeSerialized(write, serialized);
}

function writeSerialized(write: WriteOutput, serialized: string): void {
  write(`${serialized}\n`);
}

function isDirectExecution(entryPoint: string | undefined): boolean {
  if (entryPoint === undefined) return false;
  try {
    return realpathSync(path.resolve(entryPoint)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution(process.argv[1])) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
