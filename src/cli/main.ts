#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";
import { isSafeWorktreeTaskIdentity } from "../contracts/task-identity.js";

import { ValidationRunner } from "../capabilities/validation-runner.js";
import { DockerCapsuleConformance } from "../capsule/docker-capsule.js";
import { loadCapsulePolicy } from "../capsule/egress-policy.js";
import {
  EnvironmentGitHubCredentialProvider,
  GitHubEffectBroker,
} from "../capsule/github-broker.js";
import { MAX_RETAINED_ARTIFACT_BYTES } from "../contracts/artifact.js";
import type { NewEvent } from "../contracts/event.js";
import {
  AuthorityLevelSchema,
  MilestonePlanSchema,
  PlannedTaskSchema,
  RiskClassificationSchema,
  RiskLevelSchema,
  type PlannedTask,
} from "../contracts/milestone.js";
import {
  resolveBundledFixture,
  type BundledFixture,
} from "../fixtures/bundled-fixtures.js";
import { IntegrationQueue } from "../integration/integration-queue.js";
import { IntegrationLeaseStore } from "../integration/integration-lease.js";
import { type DurablePagedEventJournal, type EventJournal } from "../journal/journal.js";
import { ProjectingEventJournal } from "../journal/projecting-journal.js";
import {
  ArchivedEventJournal,
  JournalRetentionService,
  openAuthoritativeJournal,
} from "../journal/retention.js";
import { SqliteEventJournal } from "../journal/sqlite-journal.js";
import { MilestoneRegistry } from "../milestones/milestone-registry.js";
import { projectMilestone } from "../milestones/milestone-projection.js";
import {
  AgentTailJsonlFileSink,
  assertSafeAgentTailJsonlPath,
} from "../observability/agent-tail-file-sink.js";
import { RecoveryService } from "../orchestration/recovery.js";
import { TracerBulletOrchestrator } from "../orchestration/tracer-bullet.js";
import { InstalledMilestoneRunner } from "../orchestration/installed-milestone.js";
import {
  loadModelSheet,
  ModelSheetError,
  publicModelSheetSummary,
} from "../policy/model-sheet.js";
import {
  loadSecuritySheet,
  publicSecuritySheetSummary,
  SecuritySheetError,
} from "../policy/security-sheet.js";
import { routeApprovedModel } from "../routing/model-router.js";
import { JournalOutcomeHistoryStore } from "../routing/outcome-history.js";
import type { OutcomeHistoryRecord } from "../routing/routing-events.js";
import {
  APPROVED_VALIDATION_EXECUTABLE,
  assertApprovedValidationExecutableIdentity,
  ProjectConfigSchema,
  type ProjectConfig,
} from "../projects/project-config.js";
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
import {
  createInstalledModelBroker,
  loadInstalledProviderConfig,
} from "../providers/provider-config.js";
import { openSessionInBrowser } from "../service/browser.js";
import { startZentraService } from "../service/start-service.js";
import { createHttpWorkflowClient } from "../surfaces/http-workflow-client.js";
import {
  WorkflowSurfaceError,
  type WorkflowSurface,
} from "../surfaces/workflow-surface.js";

const WORKER_ID = "zentra-deterministic-worker";
const REVIEWER_ID = "zentra-deterministic-reviewer";
const WORKER_TIMEOUT_MS = 120_000;
const MAX_OPERATIONAL_JSON_BYTES = 16 * 1024;
const MAX_WORKFLOW_DETAIL_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_LIVE_OUTPUT_BYTES = 8 * 1_048_576;
const LIVE_OUTPUT_FLUSH_TIMEOUT_MS = 5_000;
const LIVE_OUTPUT_DESTROY_TIMEOUT_MS = 1_000;
let forceDirectExit = false;
const MAX_PROJECT_ID_BYTES = 128;
const MAX_TITLE_BYTES = 512;
const MAX_FILE_BYTES = 255;
const MAX_DIFF_FRAMING_BYTES = 4_096;
// Every one-byte line may require one additional Git diff prefix byte.
const MAX_CONTENT_BYTES = Math.floor(
  (MAX_RETAINED_ARTIFACT_BYTES - MAX_DIFF_FRAMING_BYTES) / 2,
);
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_PROJECT_CONFIGS = 256;
const FIXED_REVIEWER_SOURCE = String.raw`
import { createHash } from "node:crypto";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const validation = request.validation;
const argvSha256 = sha256(JSON.stringify(validation.command));
const outputSha256 = sha256(JSON.stringify({ stdout: validation.stdout, stderr: validation.stderr }));
const validationSha256 = sha256(JSON.stringify({
  name: validation.name,
  outcome: validation.outcome,
  exitCode: validation.exitCode,
  startedAt: validation.startedAt,
  finishedAt: validation.finishedAt,
  command: validation.command,
  stdout: validation.stdout,
  stderr: validation.stderr,
  argvSha256,
  outputSha256,
  provenance: validation.provenance,
}));
const dangerous = request.diff.includes("requireAuthentication = false");
process.stdout.write(JSON.stringify({
  reviewerId: request.reviewerId,
  decision: dangerous ? "deny" : "approve",
  requestSha256: sha256(input),
  diffSha256: sha256(request.diff),
  validationSha256,
  decidedAt: new Date().toISOString(),
  reason: dangerous ? "Denied deterministic authentication bypass." : "Approved deterministic reviewed evidence.",
}) + "\n");
`;

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  BUNDLED_FIXTURE_INVALID: "Bundled fixture attestation failed.",
  COMMAND_REQUIRED: "An operational command is required.",
  DATABASE_NOT_FOUND: "Event journal was not found.",
  INVALID_COMMAND: "Invalid command arguments.",
  INVALID_CONFIG: "Project configuration is invalid.",
  INVALID_CONTENT: "Task content is too large.",
  INVALID_FILE: "File must be one safe root-level filename.",
  INVALID_MODEL_SHEET: "Model sheet is invalid.",
  INVALID_PROVIDER_CONFIG: "Provider configuration is invalid.",
  INVALID_SECURITY_SHEET: "Security sheet is invalid.",
  INVALID_TASK_ID: "Task ID must be one safe path and ref component.",
  INVALID_TITLE: "Task title is invalid.",
  OPERATION_FAILED: "Operation failed.",
  OUTPUT_TOO_LARGE: "Operational output exceeded the limit.",
  TASK_NOT_FOUND: "Task was not found.",
  not_found: "Workflow resource was not found.",
  stale: "Workflow state changed before the command was recorded.",
  consumed: "Workflow command was already consumed.",
  expired: "Workflow decision has expired.",
  digest_mismatch: "Workflow digest does not match.",
  invalid_transition: "Workflow transition is invalid.",
  uncertain: "Workflow submission outcome is uncertain; retry the exact command to reconcile it.",
  unavailable: "Workflow service is unavailable.",
  internal: "Workflow operation failed.",
});

type PublicErrorCode = keyof typeof PUBLIC_ERROR_MESSAGES;

type WriteOutput = (value: string) => void;

export interface CliRuntime {
  readonly cwd?: string;
  readonly stdout?: WriteOutput;
  readonly stderr?: WriteOutput;
  readonly signalSource?: SignalSource;
  readonly fixtureAnchor?: string | URL;
  readonly interactive?: boolean;
  readonly openBrowser?: typeof openSessionInBrowser;
  readonly startService?: typeof startZentraService;
  readonly workflowSurface?: WorkflowSurface;
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
  readonly securitySheet: string;
  readonly riskLevel: string;
  readonly authority: string;
  readonly requiresApproval?: boolean;
  readonly agentTailJsonl?: string;
  readonly agentTailStream?: boolean;
}

interface RecoverOptions extends ProjectOptions, DatabaseTaskOptions {}

interface StartOptions {
  readonly project?: string;
  readonly tokenTtlSeconds: number;
  readonly agenttrailTimeoutMs: number;
}

interface WorkflowRunOptions {
  readonly tickets?: string;
  readonly actor: string;
}

interface WorkflowMutationOptions {
  readonly runId: string;
  readonly expectedVersion: number;
  readonly actor: string;
  readonly commandId: string;
}

interface WorkflowQuestionAnswerOptions extends WorkflowMutationOptions { readonly optionId: string }
interface WorkflowRejectionOptions extends WorkflowMutationOptions { readonly reason: string }
interface WorkflowPlanApprovalOptions extends WorkflowMutationOptions {
  readonly planDigest: string;
  readonly envelopeDigest: string;
}
interface WorkflowCancelOptions extends Omit<WorkflowMutationOptions, "runId"> {}

interface JournalBoundaryOptions {
  readonly database: string;
  readonly throughPosition: number;
}

interface JournalArchiveOptions extends JournalBoundaryOptions { readonly maxEvents: number }
interface JournalPruneRequestOptions extends JournalBoundaryOptions { readonly operator: string }
interface JournalPruneOptions extends JournalPruneRequestOptions {
  readonly requestId: string;
  readonly confirm: string;
}
interface JournalNameOptions { readonly database: string; readonly name: string }
interface JournalMaintainOptions { readonly database: string; readonly vacuumPages?: number }
interface JournalReconcileOptions {
  readonly database: string;
  readonly operationId: string;
  readonly confirm: string;
}

interface PolicyPreviewOptions {
  readonly modelSheet: string;
  readonly securitySheet: string;
}

interface MilestonePreviewOptions extends PolicyPreviewOptions, ProjectOptions, Pick<DatabaseTaskOptions, "database"> {
  readonly agentTailJsonl: string;
  readonly agentTailStream?: boolean;
  readonly task: string;
}

interface MilestoneStatusOptions {
  readonly database: string;
  readonly milestoneId: string;
}

interface MilestoneRunOptions extends ProjectOptions, Pick<DatabaseTaskOptions, "database"> {
  readonly goal: string;
  readonly modelSheet: string;
  readonly securitySheet: string;
  readonly provider: string;
  readonly opencode: string;
  readonly opencodeHome: string;
  readonly opencodeSha256: string;
  readonly opencodeVersion: string;
  readonly agentTailJsonl: string;
  readonly file: string;
}

interface CapsuleConformanceOptions {
  readonly capsuleId: string;
  readonly policy: string;
  readonly project: string;
  readonly database: string;
  readonly agentTailJsonl: string;
}

interface GitHubBaseOptions {
  readonly policy: string;
  readonly database: string;
  readonly agentTailJsonl: string;
  readonly grantId: string;
}
interface GitHubPushOptions extends GitHubBaseOptions { readonly repository: string; readonly targetRef: string; readonly sourceCommit: string; readonly expectedOldOid: string; readonly sourceRepository: string }
interface GitHubPrOptions extends GitHubBaseOptions { readonly pushGrantId: string; readonly repository: string; readonly base: string; readonly headRef: string; readonly headCommit: string; readonly title?: string; readonly body?: string; readonly draft?: boolean }

interface CommandResult {
  readonly exitCode: number;
  readonly value: Record<string, unknown>;
  readonly streamOutput?: boolean;
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
  const liveOutput = runtime.stdout === undefined ? new LiveStdoutOutput() : undefined;
  const liveStdout = runtime.stdout ?? liveOutput!.write;
  const stderr = runtime.stderr ?? ((value: string) => process.stderr.write(value));
  const signalSource = runtime.signalSource ?? process;
  const controller = new AbortController();
  const abort = (): void => controller.abort(new DOMException("CLI signal", "AbortError"));
  signalSource.on("SIGINT", abort);
  signalSource.on("SIGTERM", abort);

  const commandResults: CommandResult[] = [];
  try {
    let workflowSurface = runtime.workflowSurface;
    if (workflowSurface === undefined && isWorkflowCommand(userArgv)) {
      workflowSurface = await createHttpWorkflowClient(runtime.cwd ?? process.cwd());
    }
    const program = createProgram(stdout, liveStdout, (result) => {
      commandResults.push(result);
    }, controller.signal, runtime.fixtureAnchor, {
      interactive: runtime.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true),
      openBrowser: runtime.openBrowser ?? openSessionInBrowser,
      startService: runtime.startService ?? startZentraService,
      ...(workflowSurface === undefined ? {} : { workflowSurface }),
    });
    await program.parseAsync([...userArgv], { from: "user" });
    let commandResult = commandResults[0];
    if (commandResult === undefined) {
      throw new CliFailure("COMMAND_REQUIRED");
    }
    if (
      commandResult.streamOutput === true &&
      liveOutput !== undefined &&
      !await liveOutput.flush()
    ) {
      commandResult = {
        ...commandResult,
        exitCode: 1,
        value: { ...commandResult.value, traceOutcome: "failed" },
      };
    }
    const serialized = serializeJson(commandResult.value);
    if (Buffer.byteLength(serialized) > operationalJsonLimit(userArgv)) {
      writeFixedError(stderr, commandLabel(userArgv), "OUTPUT_TOO_LARGE");
      return 1;
    }
    writeSerialized(commandResult.exitCode === 0 && commandResult.streamOutput !== true ? stdout : stderr, serialized);
    return commandResult.exitCode;
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return 0;
    }
    const failure = toFailure(error, isWorkflowCommand(userArgv));
    writeFixedError(stderr, commandLabel(userArgv), failure.code);
    return 1;
  } finally {
    liveOutput?.dispose();
    signalSource.off("SIGINT", abort);
    signalSource.off("SIGTERM", abort);
  }
}

function createProgram(
  stdout: WriteOutput,
  liveStdout: WriteOutput,
  setResult: (result: CommandResult) => void,
  signal: AbortSignal,
  fixtureAnchor: string | URL | undefined,
  startRuntime: {
    readonly interactive: boolean;
    readonly openBrowser: typeof openSessionInBrowser;
    readonly startService: typeof startZentraService;
    readonly workflowSurface?: WorkflowSurface;
  },
): Command {
  const program = new Command()
    .name("zentra")
    .description("Run bounded local software-development workflows with durable evidence.")
    .exitOverride()
    .configureOutput({ writeOut: stdout, writeErr: () => {} });

  program
    .command("start")
    .description("Start the tokenized local Zentra service for the current Git project.")
    .option("--project <path>", "path inside the Git project; defaults to cwd")
    .option("--token-ttl-seconds <seconds>", "session token lifetime in seconds", boundedTokenTtlSeconds, 900)
    .option("--agenttrail-timeout-ms <milliseconds>", "AgentTrail readiness deadline", boundedAgentTrailTimeout, 60_000)
    .action(async (options: StartOptions) => {
      const service = await startRuntime.startService({
        cwd: options.project ?? process.cwd(),
        tokenTtlMs: options.tokenTtlSeconds * 1_000,
        agentTrailStartupTimeoutMs: options.agenttrailTimeoutMs,
        signal,
      });
      stdout(`${service.sessionUrl}\n`);
      try {
        if (startRuntime.interactive && !signal.aborted) await startRuntime.openBrowser(service.sessionUrl);
        await service.closed;
      } catch (error) {
        await service.shutdown("internal_failure").catch(() => undefined);
        throw error;
      }
      setResult({
        exitCode: 0,
        value: {
          command: "start",
          status: "stopped",
          projectRoot: service.layout.projectRoot,
        },
      });
    });

  program
    .command("run")
    .description("Submit one workflow from an inline goal or ticket directory.")
    .argument("[goal]", "inline workflow goal")
    .option("--tickets <folder>", "directory containing bounded ticket inputs")
    .option("--actor <id>", "operator identity", "zentra-local-operator")
    .action(async (goal: string | undefined, options: WorkflowRunOptions) => {
      assertCliIdentity(options.actor);
      if ((goal === undefined) === (options.tickets === undefined)) throw new CliFailure("INVALID_COMMAND");
      const submission = goal === undefined
        ? { kind: "ticket_directory" as const, commandId: randomUUID(), directoryPath: canonicalTicketDirectory(options.tickets!) }
        : (assertSafeTitle(goal), { kind: "inline_goal" as const, commandId: randomUUID(), goal });
      const result = await requireWorkflowSurface(startRuntime).submitRun(
        submission,
        { actorId: options.actor, channel: "cli" },
      );
      setResult({ exitCode: 0, value: { command: "run", result } });
    });

  program.command("list").description("List durable workflow runs.").action(async () => {
    const runs = await requireWorkflowSurface(startRuntime).listRuns();
    setResult({ exitCode: 0, value: { command: "list", runs } });
  });

  program.command("status").description("Inspect one durable workflow run.")
    .argument("<run-id>", "run identity")
    .action(async (runId: string) => {
      assertCliIdentity(runId);
      const run = await requireWorkflowSurface(startRuntime).getRun(runId);
      if (run === null) throw new CliFailure("not_found");
      setResult({ exitCode: 0, value: { command: "status", run } });
    });

  program.command("cancel").description("Record cancellation of one workflow run.")
    .argument("<run-id>", "run identity")
    .requiredOption("--expected-version <version>", "exact current run stream version", nonnegativeInteger)
    .requiredOption("--actor <id>", "operator identity")
    .requiredOption("--command-id <id>", "single-use command identity")
    .action(async (runId: string, options: WorkflowCancelOptions) => {
      assertWorkflowMutationIdentities(runId, options.actor, options.commandId);
      const result = await requireWorkflowSurface(startRuntime).cancelRun({
        runId, expectedVersion: options.expectedVersion, commandId: options.commandId,
        cancellationId: options.commandId,
      }, { actorId: options.actor, channel: "cli" });
      setResult({ exitCode: 0, value: { command: "cancel", result } });
    });

  const question = program.command("question").description("Answer or reject durable workflow questions.");
  question.command("answer").description("Answer one pending question with an exact option.")
    .argument("<decision-id>", "question decision identity")
    .requiredOption("--run-id <id>", "owning run identity")
    .requiredOption("--expected-version <version>", "exact current decision stream version", nonnegativeInteger)
    .requiredOption("--actor <id>", "operator identity")
    .requiredOption("--command-id <id>", "single-use command identity")
    .requiredOption("--option-id <id>", "exact offered option identity")
    .action(async (decisionId: string, options: WorkflowQuestionAnswerOptions) => {
      assertWorkflowDecisionIdentities(decisionId, options);
      assertCliIdentity(options.optionId);
      const result = await requireWorkflowSurface(startRuntime).answerQuestion({
        runId: options.runId, decisionId, expectedVersion: options.expectedVersion,
        commandId: options.commandId, optionId: options.optionId,
      }, { actorId: options.actor, channel: "cli" });
      setResult({ exitCode: 0, value: { command: "question.answer", result } });
    });
  question.command("reject").description("Reject one pending question.")
    .argument("<decision-id>", "question decision identity")
    .requiredOption("--run-id <id>", "owning run identity")
    .requiredOption("--expected-version <version>", "exact current decision stream version", nonnegativeInteger)
    .requiredOption("--actor <id>", "operator identity")
    .requiredOption("--command-id <id>", "single-use command identity")
    .requiredOption("--reason <text>", "bounded rejection reason")
    .action(async (decisionId: string, options: WorkflowRejectionOptions) => {
      assertWorkflowDecisionIdentities(decisionId, options);
      assertCliText(options.reason);
      const result = await requireWorkflowSurface(startRuntime).rejectQuestion({
        runId: options.runId, decisionId, expectedVersion: options.expectedVersion,
        commandId: options.commandId, reason: options.reason,
      }, { actorId: options.actor, channel: "cli" });
      setResult({ exitCode: 0, value: { command: "question.reject", result } });
    });

  const plan = program.command("plan").description("Approve or reject durable workflow plans.");
  plan.command("approve").description("Approve one exact plan and authority envelope.")
    .argument("<decision-id>", "plan approval decision identity")
    .requiredOption("--run-id <id>", "owning run identity")
    .requiredOption("--expected-version <version>", "exact current decision stream version", nonnegativeInteger)
    .requiredOption("--actor <id>", "operator identity")
    .requiredOption("--command-id <id>", "single-use command identity")
    .requiredOption("--plan-digest <sha256>", "exact lowercase plan SHA-256")
    .requiredOption("--envelope-digest <sha256>", "exact lowercase authority-envelope SHA-256")
    .action(async (decisionId: string, options: WorkflowPlanApprovalOptions) => {
      assertWorkflowDecisionIdentities(decisionId, options);
      assertSha256(options.planDigest);
      assertSha256(options.envelopeDigest);
      const result = await requireWorkflowSurface(startRuntime).approvePlan({
        runId: options.runId, decisionId, expectedVersion: options.expectedVersion,
        commandId: options.commandId, planDigest: options.planDigest, envelopeDigest: options.envelopeDigest,
      }, { actorId: options.actor, channel: "cli" });
      setResult({ exitCode: 0, value: { command: "plan.approve", result } });
    });
  plan.command("reject").description("Reject one pending plan approval.")
    .argument("<decision-id>", "plan approval decision identity")
    .requiredOption("--run-id <id>", "owning run identity")
    .requiredOption("--expected-version <version>", "exact current decision stream version", nonnegativeInteger)
    .requiredOption("--actor <id>", "operator identity")
    .requiredOption("--command-id <id>", "single-use command identity")
    .requiredOption("--reason <text>", "bounded rejection reason")
    .action(async (decisionId: string, options: WorkflowRejectionOptions) => {
      assertWorkflowDecisionIdentities(decisionId, options);
      assertCliText(options.reason);
      const result = await requireWorkflowSurface(startRuntime).rejectPlan({
        runId: options.runId, decisionId, expectedVersion: options.expectedVersion,
        commandId: options.commandId, reason: options.reason,
      }, { actorId: options.actor, channel: "cli" });
      setResult({ exitCode: 0, value: { command: "plan.reject", result } });
    });

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

  const policy = program.command("policy").description("Inspect local policy inputs.");
  policy
    .command("preview")
    .description("Validate model and security sheets without creating operational effects.")
    .requiredOption("--model-sheet <path>", "Markdown model sheet")
    .requiredOption("--security-sheet <path>", "Markdown security sheet")
    .action((options: PolicyPreviewOptions) => {
      const model = loadModelSheetForCli(options.modelSheet);
      const security = loadSecuritySheetForCli(options.securitySheet);
      setResult({
        exitCode: 0,
        value: {
          command: "policy.preview",
          model: publicModelSheetSummary(model),
          security: publicSecuritySheetSummary(security),
          deniedCapabilities: deniedCapabilities(security),
        },
      });
    });

  const milestone = program.command("milestone").description("Run and inspect installed OpenCode workflows.");
  milestone
    .command("run")
    .description("Run Azure-brokered OpenCode planning, research, and review around an authenticated host OpenCode writer.")
    .requiredOption("--goal <sentence>", "one natural-language goal; wording grants no authority")
    .requiredOption("--config <path>", "canonical project configuration file")
    .requiredOption("--database <path>", "canonical SQLite event journal path")
    .requiredOption("--model-sheet <path>", "canonical Markdown model sheet")
    .requiredOption("--security-sheet <path>", "canonical Markdown security sheet")
    .requiredOption("--provider <path>", "canonical Azure provider configuration")
    .requiredOption("--opencode <path>", "canonical host OpenCode executable; provider transport uses user OS network authority")
    .requiredOption("--opencode-home <path>", "canonical explicit OpenCode home for writer and probe")
    .requiredOption("--opencode-sha256 <digest>", "operator-attested lowercase SHA-256 of the exact host OpenCode executable")
    .requiredOption("--opencode-version <version>", "operator-attested exact bounded OpenCode --version output")
    .requiredOption("--agent-tail-jsonl <path>", "canonical new Agent Tail JSONL trace path")
    .requiredOption("--file <path>", "one explicit security-authorized relative file")
    .action(async (options: MilestoneRunOptions) => {
      assertSafeTitle(options.goal);
      assertSafeRelativeFile(options.file);
      assertCanonicalInputFile(options.config);
      assertCanonicalInputFile(options.modelSheet);
      assertCanonicalInputFile(options.securitySheet);
      assertCanonicalInputFile(options.provider);
      assertCanonicalExecutable(options.opencode);
      assertCanonicalDirectory(options.opencodeHome);
      if (!/^[a-f0-9]{64}$/.test(options.opencodeSha256) || !isBoundedVersion(options.opencodeVersion)) {
        throw new CliFailure("INVALID_COMMAND");
      }
      assertCanonicalOutputPath(options.database);
      assertCanonicalOutputPath(options.agentTailJsonl);
      const configs = loadProjects(options.config);
      if (configs.length !== 1) throw new CliFailure("INVALID_CONFIG");
      const project = configs[0]!;
      const models = loadModelSheetForCli(options.modelSheet);
      const security = loadSecuritySheetForCli(options.securitySheet);
      let providerConfig;
      try {
        providerConfig = loadInstalledProviderConfig(options.provider);
      } catch {
        throw new CliFailure("INVALID_PROVIDER_CONFIG");
      }
      const broker = createInstalledModelBroker(providerConfig);
      const milestoneId = `milestone-${createHash("sha256")
        .update(`${project.projectId}\0${options.goal}\0${options.file}`, "utf8")
        .digest("hex").slice(0, 16)}`;
      const trace = prepareAgentTailTrace(options.database, options.agentTailJsonl, liveStdout, milestoneId);
      const sqlite = openJournal(options.database, "read-write");
      let sink: AgentTailJsonlFileSink | undefined;
      let runner: InstalledMilestoneRunner | undefined;
      let projectionFailed = false;
      let runFailed = false;
      try {
        sink = openAgentTailSink(sqlite, trace);
        runner = new InstalledMilestoneRunner({
          journal: sqlite,
          sink,
          broker,
        });
        await runner.run({
          milestoneId,
          goal: options.goal,
          file: options.file,
          tracePath: trace.canonicalPath,
          project,
          models,
          security,
          azureDeployment: providerConfig.deployment,
          openCodeExecutable: options.opencode,
          openCodeHome: options.opencodeHome,
          openCodeExpectedSha256: options.opencodeSha256,
          openCodeExpectedVersion: options.opencodeVersion,
          signal,
        });
      } catch {
        runFailed = true;
      } finally {
        projectionFailed = (runner?.traceProjectionFailed ?? false) || (sink?.streamFailed ?? false);
        try {
          sink?.close();
        } finally {
          sqlite.close();
        }
      }
      const replay = openJournal(options.database, "read-only");
      let terminal;
      try {
        terminal = new MilestoneRegistry(replay).inspect(milestoneId);
      } finally {
        replay.close();
      }
      if (terminal === null) throw new CliFailure("OPERATION_FAILED");
      const outcome = terminal.terminalOutcome;
      setResult({
        exitCode: milestoneExitCode(outcome, projectionFailed || runFailed),
        streamOutput: true,
        value: {
          command: "milestone.run",
          milestoneId,
          projectId: terminal.projectId,
          lifecycle: terminal.lifecycle,
          outcome,
          tracePath: trace.canonicalPath,
          ...(terminal.attention !== null ? {
            attention: { reason: terminal.attention.reason, classification: terminal.attention.classification },
          } : terminal.replanningAttention !== null ? {
            attention: { reason: "stale_evidence", classification: "bounded_replan" },
          } : {}),
          trace: {
            path: trace.canonicalPath,
            outcome: projectionFailed ? "failed" : terminal.result?.trace.outcome ?? "not_observed",
          },
        },
      });
    });
  milestone
    .command("preview")
    .description("Create a durable milestone plan preview without executing workers.")
    .requiredOption("--config <path>", "project configuration file")
    .requiredOption("--database <path>", "SQLite event journal")
    .requiredOption("--model-sheet <path>", "Markdown model sheet")
    .requiredOption("--security-sheet <path>", "Markdown security sheet")
    .requiredOption("--agent-tail-jsonl <path>", "Agent Tail JSONL trace path")
    .option(
      "--agent-tail-stream",
      "stream JSONL to agent-tail - over stdin; Agent Tail does not follow appended files",
      false,
    )
    .requiredOption("--task <sentence>", "natural-language milestone task")
    .action((options: MilestonePreviewOptions) => {
      assertSafeTitle(options.task);
      const configs = loadProjects(options.config);
      if (configs.length !== 1) throw new CliFailure("INVALID_CONFIG");
      const model = loadModelSheetForCli(options.modelSheet);
      const security = loadSecuritySheetForCli(options.securitySheet);
      const project = configs[0]!;
      const canonicalRepository = realpathSync.native(project.repositoryPath);
      if (!security.allowedRepositories.includes(canonicalRepository)) {
        throw new CliFailure("INVALID_SECURITY_SHEET");
      }
      const milestoneId = `milestone-${createHash("sha256").update(`${project.projectId}\0${options.task}`, "utf8").digest("hex").slice(0, 12)}`;
      const taskId = `${milestoneId}-task-1`;
      let routed;
      try {
        let history: OutcomeHistoryRecord[] = [];
        if (existsSync(options.database)) {
          const historyJournal = openJournal(options.database, "read-only");
          try {
            history = [...new JournalOutcomeHistoryStore(historyJournal).list({
              taskType: "milestone_planning",
              role: "planner",
              harness: "opencode",
            })];
          } finally {
            historyJournal.close();
          }
        }
        routed = routeApprovedModel(model, history, {
          executionId: `${milestoneId}-preview-routing`,
          taskId,
          taskType: "milestone_planning",
          role: "planner",
          harness: "opencode",
          requiredTools: ["read_repository"],
          network: "denied",
          requiredContextTokens: 2_000,
        });
      } catch {
        throw new CliFailure("INVALID_MODEL_SHEET");
      }
      const firstModel = routed.capability;
      const ownedPath = security.allowedFileScopes[0]!;
      const plan = {
        milestoneId,
        projectId: project.projectId,
        goal: options.task,
        tasks: [{
          taskId,
          title: "Preview milestone plan",
          description: `Plan work for: ${options.task}`,
          dependencies: [],
          ownedPaths: [ownedPath],
          forbiddenPaths: [...security.forbiddenPaths],
          acceptanceCriteria: [
            "The preview creates durable milestone plan evidence.",
            "The preview writes Agent Tail JSONL for the milestone plan.",
            "No worker, validation, commit, worktree, or integration effect runs.",
          ],
          roleAssignment: {
            role: "planner",
            agentId: firstModel.id,
            harness: firstModel.harness,
          },
          risk: {
            level: "low",
            authority: "read_only",
            requiresReview: false,
            requiresApproval: false,
          },
          budget: {
            maxSeconds: 300,
            maxRetries: 0,
            maxCostUsd: 1,
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
          },
        }],
      };
      MilestonePlanSchema.parse(plan);
      const events: readonly NewEvent<string, unknown>[] = [{
        streamId: milestoneId,
        type: "milestone.created",
        payload: { projectId: project.projectId, title: options.task, tracePath: options.agentTailJsonl },
        causationId: null,
        correlationId: milestoneId,
      }, {
        streamId: milestoneId,
        type: "milestone.plan_created",
        payload: { plan, stopAndAskBoundaries: security.stopAndAskConditions },
        causationId: null,
        correlationId: milestoneId,
      }];
      const previewValue = {
        command: "milestone.preview",
        milestone: {
          milestoneId,
          projectId: project.projectId,
          title: options.task,
          lifecycle: "ready",
          terminalOutcome: null,
          streamVersion: 2,
          plan,
          stopAndAsk: null,
          tasks: Object.fromEntries(plan.tasks.map((task) => [task.taskId, {
            taskId: task.taskId,
            status: "planned",
            terminalOutcome: null,
            blockedReason: null,
          }])),
        },
        tracePath: options.agentTailJsonl,
        stopAndAskBoundaries: security.stopAndAskConditions,
      } satisfies Record<string, unknown>;
      if (Buffer.byteLength(serializeJson(previewValue), "utf8") > MAX_OPERATIONAL_JSON_BYTES) {
        throw new CliFailure("OUTPUT_TOO_LARGE");
      }
      const trace = prepareAgentTailTrace(
        options.database,
        options.agentTailJsonl,
        options.agentTailStream === true ? liveStdout : undefined,
        milestoneId,
      );
      const sqliteJournal = openJournal(options.database, "read-write");
      let sink: AgentTailJsonlFileSink | undefined;
      let journal: ProjectingEventJournal | undefined;
      let stored;
      try {
        sink = openAgentTailSink(sqliteJournal, trace);
        journal = new ProjectingEventJournal(sqliteJournal, sink);
        new JournalOutcomeHistoryStore(journal).begin({
          executionId: routed.executionId,
          taskId,
          taskType: "milestone_planning",
          role: "planner",
          model: {
            capabilityId: firstModel.id,
            harness: "opencode",
            transportModelSha256: createHash("sha256").update(firstModel.model, "utf8").digest("hex"),
          },
          candidateCapabilityIds: [...routed.candidateCapabilityIds],
          modelSheetSha256: routed.modelSheetSha256,
          basis: routed.basis,
          correlationId: milestoneId,
        });
        stored = journal.append(milestoneId, 0, events);
      } finally {
        trace.projectionFailed = (journal?.projectionFailed ?? false) || (sink?.streamFailed ?? false);
        try {
          sink?.close();
        } finally {
          sqliteJournal.close();
        }
      }
      const view = projectMilestone(stored);
      if (view === null) throw new CliFailure("OPERATION_FAILED");
      setResult({
        exitCode: trace.projectionFailed ? 1 : 0,
        streamOutput: options.agentTailStream === true,
        value: {
          ...previewValue,
          milestone: view,
          traceOutcome: trace.projectionFailed ? "failed" : "completed",
        },
      });
    });
  milestone
    .command("list")
    .description("List milestone statuses from the event journal.")
    .requiredOption("--database <path>", "SQLite event journal")
    .action((options: Pick<DatabaseTaskOptions, "database">) => {
      const journal = openJournal(options.database, "read-only");
      try {
        setResult({
          exitCode: 0,
          value: {
            command: "milestone.list",
            milestones: new MilestoneRegistry(journal).list(),
          },
        });
      } finally {
        journal.close();
      }
    });
  milestone
    .command("status")
    .description("Inspect one milestone from the event journal.")
    .requiredOption("--database <path>", "SQLite event journal")
    .requiredOption("--milestone-id <id>", "milestone identity")
    .action((options: MilestoneStatusOptions) => {
      const journal = openJournal(options.database, "read-only");
      try {
        const milestoneView = new MilestoneRegistry(journal).inspect(options.milestoneId);
        if (milestoneView === null) throw new CliFailure("TASK_NOT_FOUND");
        setResult({
          exitCode: 0,
          value: { command: "milestone.status", milestone: publicMilestoneStatus(milestoneView) },
        });
      } finally {
        journal.close();
      }
    });

  const capsule = program.command("capsule").description("Run secure Docker capsule conformance.");
  capsule
    .command("conformance")
    .description("Verify the Darwin arm64 worker and TLS policy-proxy boundary with real Docker.")
    .requiredOption("--capsule-id <id>", "safe capsule identity")
    .requiredOption("--policy <path>", "external capsule egress policy JSON")
    .requiredOption("--project <path>", "canonical project directory mounted read-only")
    .requiredOption("--database <path>", "SQLite event journal")
    .requiredOption("--agent-tail-jsonl <path>", "new Agent Tail v1 JSONL trace path")
    .action(async (options: CapsuleConformanceOptions) => {
      assertSafeTaskId(options.capsuleId);
      const trace = prepareAgentTailTrace(options.database, options.agentTailJsonl, undefined, options.capsuleId);
      const sqliteJournal = openJournal(options.database, "read-write");
      let sink: AgentTailJsonlFileSink | undefined;
      let journal: ProjectingEventJournal | undefined;
      try {
        sink = openAgentTailSink(sqliteJournal, trace);
        journal = new ProjectingEventJournal(sqliteJournal, sink);
        const report = await new DockerCapsuleConformance(journal).run({
          capsuleId: options.capsuleId,
          policyPath: options.policy,
          projectPath: options.project,
          signal,
        });
        trace.projectionFailed = journal.projectionFailed || sink.streamFailed;
        setResult({
          exitCode: report.outcome === "completed" && !trace.projectionFailed ? 0 : 1,
          value: {
            command: "capsule.conformance",
            report,
            tracePath: options.agentTailJsonl,
            traceOutcome: trace.projectionFailed ? "failed" : "completed",
          },
        });
      } finally {
        try {
          sink?.close();
        } finally {
          sqliteJournal.close();
        }
      }
    });

  const github = program.command("github").description("Execute exact host-brokered GitHub capabilities.");
  const addGitHubBase = (command: Command): Command => command
    .requiredOption("--policy <path>", "canonical capsule policy JSON")
    .requiredOption("--database <path>", "SQLite event journal")
    .requiredOption("--agent-tail-jsonl <path>", "new Agent Tail v1 JSONL trace path")
    .requiredOption("--grant-id <id>", "single-use policy grant and request identity");
  addGitHubBase(github.command("push").description("Dispatch one exact push; completion requires later reconciliation."))
    .requiredOption("--repository <owner/name>", "exact GitHub repository")
    .requiredOption("--target-ref <ref>", "exact granted remote ref")
    .requiredOption("--source-commit <oid>", "exact source commit")
    .requiredOption("--expected-old-oid <oid>", "exact expected old remote commit")
    .requiredOption("--source-repository <path>", "canonical source repository path")
    .action(async (options: GitHubPushOptions) => runGitHubBrokerCli(options, setResult, (broker) => broker.push({ ...options, sourceRepositoryPath: options.sourceRepository, force: false, signal })));
  addGitHubBase(github.command("create-pr").description("Dispatch one exact pull request; completion requires later reconciliation."))
    .requiredOption("--push-grant-id <id>", "completed prerequisite push grant identity")
    .requiredOption("--repository <owner/name>", "exact GitHub repository")
    .requiredOption("--base <branch>", "exact granted base branch")
    .requiredOption("--head-ref <branch>", "exact head branch")
    .requiredOption("--head-commit <oid>", "exact head commit")
    .requiredOption("--title <title>", "pull request title")
    .requiredOption("--body <body>", "pull request body")
    .option("--draft", "create an exact draft pull request", false)
    .action(async (options: GitHubPrOptions) => runGitHubBrokerCli(options, setResult, (broker) => broker.createPullRequest({ ...options, title: options.title!, body: options.body!, draft: options.draft === true, signal })));
  addGitHubBase(github.command("reconcile-push").description("Read the exact remote ref for an uncertain push."))
    .action(async (options: GitHubBaseOptions) => runGitHubBrokerCli(options, setResult, (broker) => broker.reconcilePush({ grantId: options.grantId, signal })));
  addGitHubBase(github.command("reconcile-pr").description("Read exact pull-request state for an uncertain creation."))
    .action(async (options: GitHubBaseOptions) => runGitHubBrokerCli(options, setResult, (broker) => broker.reconcilePullRequest({ grantId: options.grantId, signal })));

  const journalMaintenance = program.command("journal")
    .description("Archive, verify, prune, export, restore, and maintain the event journal.");
  journalMaintenance.command("archive")
    .requiredOption("--database <path>", "canonical SQLite event journal path")
    .requiredOption("--through-position <position>", "exact inclusive global position", positiveInteger)
    .requiredOption("--max-events <count>", "bounded maximum archived event count", positiveInteger)
    .action((options: JournalArchiveOptions) => {
      const result = retentionForCli(options.database).archive(options);
      setResult({ exitCode: 0, value: {
        command: "journal.archive",
        segmentId: result.segmentId,
        fromPosition: result.fromPosition,
        throughPosition: result.throughPosition,
        eventCount: result.eventCount,
        segmentSha256: result.segmentSha256,
        manifestSha256: result.manifestSha256,
      } });
    });
  journalMaintenance.command("verify")
    .requiredOption("--database <path>", "canonical SQLite event journal path")
    .action((options: Pick<JournalBoundaryOptions, "database">) => {
      const result = retentionForCli(options.database).verify(true);
      setResult({ exitCode: 0, value: { command: "journal.verify", ...result } });
    });
  journalMaintenance.command("prune-request")
    .requiredOption("--database <path>", "canonical SQLite event journal path")
    .requiredOption("--through-position <position>", "exact inclusive global position", positiveInteger)
    .requiredOption("--operator <id>", "audited operator identity")
    .action((options: JournalPruneRequestOptions) => {
      const result = retentionForCli(options.database).requestPrune({
        throughPosition: options.throughPosition,
        operatorId: options.operator,
      });
      setResult({ exitCode: 0, value: { command: "journal.prune-request", ...result } });
    });
  journalMaintenance.command("prune")
    .requiredOption("--database <path>", "canonical SQLite event journal path")
    .requiredOption("--through-position <position>", "exact inclusive global position", positiveInteger)
    .requiredOption("--operator <id>", "audited operator identity")
    .requiredOption("--request-id <id>", "exact audited request identity")
    .requiredOption("--confirm <phrase>", "exact irreversible confirmation phrase")
    .action((options: JournalPruneOptions) => {
      const result = retentionForCli(options.database).prune({
        requestId: options.requestId,
        throughPosition: options.throughPosition,
        operatorId: options.operator,
        confirmation: options.confirm,
      });
      setResult({ exitCode: 0, value: { command: "journal.prune", ...result } });
    });
  journalMaintenance.command("maintain")
    .requiredOption("--database <path>", "canonical SQLite event journal path")
    .option("--vacuum-pages <count>", "bounded incremental vacuum page count (maximum 1000)", boundedVacuumPages)
    .action(async (options: JournalMaintainOptions) => {
      const result = await retentionForCli(options.database).maintain({
        checkpoint: true,
        ...(options.vacuumPages === undefined ? {} : { vacuumPages: options.vacuumPages }),
        signal,
      });
      setResult({ exitCode: result.checkpointed ? 0 : 1, value: { command: "journal.maintain", ...result } });
    });
  journalMaintenance.command("export")
    .requiredOption("--database <path>", "canonical SQLite event journal path")
    .requiredOption("--name <filename>", "new safe filename in the journal directory")
    .action((options: JournalNameOptions) => {
      const result = retentionForCli(options.database).export(options);
      setResult({ exitCode: 0, value: { command: "journal.export", ...result } });
    });
  journalMaintenance.command("restore")
    .requiredOption("--database <path>", "canonical SQLite event journal path")
    .requiredOption("--name <filename>", "new safe filename in the journal directory")
    .action((options: JournalNameOptions) => {
      const result = retentionForCli(options.database).restore(options);
      setResult({ exitCode: 0, value: { command: "journal.restore", ...result } });
    });
  journalMaintenance.command("recover")
    .requiredOption("--database <path>", "canonical SQLite event journal path")
    .action((options: Pick<JournalBoundaryOptions, "database">) => {
      const result = retentionForCli(options.database, "read-only").inspectRecovery();
      setResult({ exitCode: result.outcome === "clean" ? 0 : 1,
        value: { command: "journal.recover", ...result } });
    });
  journalMaintenance.command("inspect-recovery")
    .requiredOption("--database <path>", "canonical SQLite event journal path")
    .action((options: Pick<JournalBoundaryOptions, "database">) => {
      const result = retentionForCli(options.database, "read-only").inspectRecovery();
      setResult({ exitCode: result.outcome === "clean" ? 0 : 1,
        value: { command: "journal.inspect-recovery", ...result } });
    });
  journalMaintenance.command("reconcile")
    .requiredOption("--database <path>", "canonical SQLite event journal path")
    .requiredOption("--operation-id <id>", "exact incomplete retention operation identity")
    .requiredOption("--confirm <phrase>", "exact classification-bound reconcile confirmation")
    .action((options: JournalReconcileOptions) => {
      const result = retentionForCli(options.database).reconcile({
        operationId: options.operationId,
        confirmation: options.confirm,
      });
      setResult({ exitCode: 0, value: { command: "journal.reconcile", ...result } });
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
    .requiredOption("--security-sheet <path>", "Markdown security sheet for review policy")
    .option("--risk-level <level>", "review policy risk level", "low")
    .option("--authority <authority>", "review policy authority level", "workspace_write")
    .option("--requires-approval", "mark the task as requiring approval before integration", false)
    .option("--agent-tail-jsonl <path>", "append Agent Tail JSONL to a retained trace file")
    .option(
      "--agent-tail-stream",
      "stream retained JSONL to agent-tail - over stdin; Agent Tail does not follow appended files",
      false,
    )
    .action(async (options: RunOptions) => {
      assertSafeTaskId(options.taskId);
      assertSafeTitle(options.title);
      assertSafeRootFile(options.file);
      if (Buffer.byteLength(options.content, "utf8") > MAX_CONTENT_BYTES) {
        throw new CliFailure("INVALID_CONTENT");
      }
      const reviewPolicyTask = reviewPolicyTaskFromOptions(options);
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
      const reviewer = await configuredReviewer();
      const reviewPolicySecurity = loadSecuritySheetForCli(options.securitySheet);
      if (!reviewPolicySecurity.allowedRepositories.includes(realpathSync.native(projectConfig.repositoryPath))) {
        throw new CliFailure("INVALID_SECURITY_SHEET");
      }
      if (options.agentTailStream === true && options.agentTailJsonl === undefined) {
        throw new CliFailure("INVALID_COMMAND");
      }
      const trace = options.agentTailJsonl === undefined
        ? undefined
        : prepareAgentTailTrace(
          options.database,
          options.agentTailJsonl,
          options.agentTailStream === true ? liveStdout : undefined,
          options.taskId,
        );
      const workerFixture = attestedWorkerFixture(fixtureAnchor);
      try {
        const result = await withSystem(options.database, configs, "read-write", async (system) => {
          const taskView = await system.execution(workerFixture.path, reviewer).orchestrator.run({
            taskId: options.taskId,
            projectId: projectConfig.projectId,
            title: options.title,
            workerId: WORKER_ID,
            reviewerId: REVIEWER_ID,
            workerRequest: {
              executable: process.execPath,
              args: [
                workerFixture.path,
                "--file",
                options.file,
                "--content",
                options.content,
              ],
              timeoutMs: WORKER_TIMEOUT_MS,
            },
            reviewPolicySecurity,
            reviewPolicyTask,
            signal,
          });
          return taskView;
        }, trace);
        setResult({
          ...taskRunResult(result, options.agentTailJsonl, trace?.projectionFailed ?? false),
          streamOutput: options.agentTailStream === true,
        });
      } finally {
        workerFixture.cleanup();
      }
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

async function runGitHubBrokerCli(
  options: GitHubBaseOptions,
  setResult: (result: CommandResult) => void,
  operation: (broker: GitHubEffectBroker) => Promise<{
    readonly outcome: string;
    readonly requestId: string;
    readonly operation: string;
    readonly repository: string;
  }>,
): Promise<void> {
  assertSafeTaskId(options.grantId);
  const policy = loadCapsulePolicy(options.policy);
  const trace = prepareAgentTailTrace(options.database, options.agentTailJsonl, undefined, options.grantId);
  const sqlite = openJournal(options.database, "read-write");
  let sink: AgentTailJsonlFileSink | undefined;
  let journal: ProjectingEventJournal | undefined;
  let repositoryLeases: IntegrationLeaseStore | undefined;
  try {
    repositoryLeases = new IntegrationLeaseStore(realpathSync.native(options.database));
    sink = openAgentTailSink(sqlite, trace);
    journal = new ProjectingEventJournal(sqlite, sink);
    const broker = new GitHubEffectBroker(
      policy,
      journal,
      new EnvironmentGitHubCredentialProvider(),
      repositoryLeases,
    );
    const receipt = await operation(broker);
    trace.projectionFailed = journal.projectionFailed || sink.streamFailed;
    setResult({
      exitCode: receipt.outcome === "completed" && !trace.projectionFailed ? 0 : 1,
      value: {
        command: `github.${receipt.operation}`,
        receipt,
        tracePath: options.agentTailJsonl,
        traceOutcome: trace.projectionFailed ? "failed" : "completed",
      },
    });
  } finally {
    try {
      sink?.close();
    } finally {
      try {
        sqlite.close();
      } finally {
        repositoryLeases?.close();
      }
    }
  }
}

async function withSystem<T>(
  databasePath: string,
  configs: readonly ProjectConfig[],
  mode: "read-only" | "read-write",
  operation: (system: ReturnType<typeof composeSystem>) => Promise<T>,
  trace?: AgentTailTraceDestination,
): Promise<T> {
  const sqliteJournal = openJournal(databasePath, mode);
  let sink: AgentTailJsonlFileSink | undefined;
  let projectingJournal: ProjectingEventJournal | undefined;
  try {
    let journal: EventJournal = sqliteJournal;
    if (trace !== undefined) {
      if (mode !== "read-write") throw new Error("Agent Tail traces require a writable journal");
      sink = openAgentTailSink(sqliteJournal, trace);
      projectingJournal = new ProjectingEventJournal(sqliteJournal, sink);
      journal = projectingJournal;
    }
    return await operation(composeSystem(journal, configs));
  } finally {
    if (trace !== undefined) {
      trace.projectionFailed = (projectingJournal?.projectionFailed ?? false) || (sink?.streamFailed ?? false);
    }
    try {
      sink?.close();
    } finally {
      sqliteJournal.close();
    }
  }
}

function openJournal(
  databasePath: string,
  mode: "read-only" | "read-write",
): ArchivedEventJournal {
  const canonicalDatabasePath = canonicalDatabasePathForCreation(databasePath);
  if (mode === "read-write" && !existsSync(canonicalDatabasePath)) {
    const created = new SqliteEventJournal(canonicalDatabasePath);
    created.close();
  }
  if (!existsSync(canonicalDatabasePath)) throw new CliFailure("DATABASE_NOT_FOUND");
  try {
    return openAuthoritativeJournal(canonicalDatabasePath, mode);
  } catch (error) {
    if (!existsSync(canonicalDatabasePath)) throw new CliFailure("DATABASE_NOT_FOUND");
    throw error;
  }
}

function canonicalDatabasePathForCreation(databasePath: string): string {
  if (!path.isAbsolute(databasePath) || path.normalize(databasePath) !== databasePath) {
    throw new CliFailure("INVALID_COMMAND");
  }
  try {
    const parent = realpathSync.native(path.dirname(databasePath));
    if (!statSync(parent).isDirectory()) throw new CliFailure("INVALID_COMMAND");
    return path.join(parent, path.basename(databasePath));
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw new CliFailure("INVALID_COMMAND");
  }
}

function composeSystem(
  journal: EventJournal,
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
          workerFixture,
        ),
      };
    },
  };
}

function taskRunResult(task: TaskView, tracePath?: string, traceProjectionFailed = false): CommandResult {
  return {
    exitCode: task.terminalOutcome === "completed" && !traceProjectionFailed ? 0 : 1,
    value: {
      command: "task.run",
      outcome: task.capabilityBoundary?.status ?? task.terminalOutcome,
      task,
      ...(tracePath === undefined ? {} : {
        tracePath,
        traceOutcome: traceProjectionFailed ? "failed" : "completed",
      }),
    },
  };
}

function loadModelSheetForCli(sheetPath: string) {
  try {
    return loadModelSheet(sheetPath);
  } catch (error) {
    if (error instanceof ModelSheetError) throw new CliFailure("INVALID_MODEL_SHEET");
    throw error;
  }
}

function loadSecuritySheetForCli(sheetPath: string) {
  try {
    return loadSecuritySheet(sheetPath);
  } catch (error) {
    if (error instanceof SecuritySheetError) throw new CliFailure("INVALID_SECURITY_SHEET");
    throw error;
  }
}

interface AgentTailTraceDestination {
  readonly trustedRoot: string;
  readonly canonicalPath: string;
  readonly liveWriter?: WriteOutput;
  readonly traceId: string;
  projectionFailed: boolean;
}

function prepareAgentTailTrace(
  databasePath: string,
  requestedPath: string,
  liveWriter: WriteOutput | undefined,
  traceId: string,
): AgentTailTraceDestination {
  if (!path.isAbsolute(requestedPath)) throw new Error("Agent Tail trace path must be absolute");
  if (path.normalize(requestedPath) !== requestedPath) {
    throw new Error("Agent Tail trace path must be normalized");
  }
  const databaseDirectory = path.resolve(path.dirname(databasePath));
  if (path.dirname(requestedPath) !== databaseDirectory) {
    throw new Error("Agent Tail trace path must be a direct child of the event journal directory");
  }
  const relative = path.relative(databaseDirectory, requestedPath);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Agent Tail trace path must remain inside the event journal directory");
  }
  const trustedRoot = realpathSync.native(databaseDirectory);
  const canonicalPath = path.join(trustedRoot, relative);
  const canonicalDatabasePath = path.join(trustedRoot, path.basename(databasePath));
  if (
    canonicalPath === canonicalDatabasePath ||
    canonicalPath === `${canonicalDatabasePath}-wal` ||
    canonicalPath === `${canonicalDatabasePath}-shm`
  ) {
    throw new Error("Agent Tail trace path must not alias event journal files");
  }
  assertSafeAgentTailJsonlPath(trustedRoot, canonicalPath, true);
  return {
    trustedRoot,
    canonicalPath,
    traceId,
    ...(liveWriter === undefined ? {} : { liveWriter }),
    projectionFailed: false,
  };
}

function openAgentTailSink(
  journal: DurablePagedEventJournal,
  trace: AgentTailTraceDestination,
): AgentTailJsonlFileSink {
  const cursorName = AgentTailJsonlFileSink.projectionCursorName(trace.canonicalPath);
  const resume = journal.inspectProjectionCursor(cursorName) !== null;
  return AgentTailJsonlFileSink.open(
    trace.trustedRoot,
    trace.canonicalPath,
    trace.traceId,
    trace.liveWriter,
    resume,
  );
}

class LiveStdoutOutput {
  private readonly pending = new Set<Promise<void>>();
  private pendingBytes = 0;
  private failed = false;
  private readonly onError = (): void => {
    this.failed = true;
  };

  constructor() {
    process.stdout.on("error", this.onError);
  }

  readonly write = (value: string): void => {
    if (this.failed) throw new Error("Agent Tail live stream is unavailable");
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MAX_PENDING_LIVE_OUTPUT_BYTES - this.pendingBytes) {
      this.failed = true;
      throw new Error("Agent Tail live stream output exceeded its pending byte limit");
    }
    this.pendingBytes += bytes;
    let completion: Promise<void>;
    completion = new Promise((resolve) => {
      process.stdout.write(value, (error) => {
        if (error != null) this.failed = true;
        this.pendingBytes -= bytes;
        this.pending.delete(completion);
        resolve();
      });
    });
    this.pending.add(completion);
  };

  async flush(): Promise<boolean> {
    if (this.pending.size > 0) {
      const flushed = await waitForPending(this.pending, LIVE_OUTPUT_FLUSH_TIMEOUT_MS);
      if (!flushed) {
        this.failed = true;
        forceDirectExit = true;
        process.stdout.destroy();
        await waitForPending(this.pending, LIVE_OUTPUT_DESTROY_TIMEOUT_MS);
      }
    }
    return !this.failed;
  }

  dispose(): void {
    if (this.pending.size === 0) {
      process.stdout.off("error", this.onError);
      return;
    }
    void Promise.all([...this.pending]).finally(() => {
      process.stdout.off("error", this.onError);
    });
  }
}

async function waitForPending(
  pending: ReadonlySet<Promise<void>>,
  timeoutMs: number,
): Promise<boolean> {
  if (pending.size === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const completed = await Promise.race([
    Promise.all([...pending]).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return completed;
}

function deniedCapabilities(security: ReturnType<typeof loadSecuritySheet>): readonly string[] {
  const denied = ["general_shell", "raw_parent_secrets"];
  if (security.network.default === "denied") denied.push("network_by_default");
  if (security.releaseBoundary === "local_preparation_only") denied.push("remote_release_effects");
  return Object.freeze(denied);
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

function attestedWorkerFixture(anchor?: string | URL): BundledFixture {
  try {
    return anchor === undefined
      ? resolveBundledFixture("deterministic-worker.mjs")
      : resolveBundledFixture("deterministic-worker.mjs", anchor);
  } catch {
    throw new CliFailure("BUNDLED_FIXTURE_INVALID");
  }
}

async function configuredReviewer(): Promise<ReviewerAdapter> {
  await assertApprovedValidationExecutableIdentity(APPROVED_VALIDATION_EXECUTABLE);
  return new ProcessReviewerAdapter({
    executable: APPROVED_VALIDATION_EXECUTABLE,
    args: ["--input-type=module", "--eval", FIXED_REVIEWER_SOURCE],
  });
}

function assertSafeRootFile(candidate: string): void {
  if (
    candidate.length === 0 ||
    Buffer.byteLength(candidate, "utf8") > MAX_FILE_BYTES ||
    candidate === "." ||
    candidate === ".." ||
    candidate.includes("/") ||
    candidate.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    throw new CliFailure("INVALID_FILE");
  }
}

function assertSafeRelativeFile(candidate: string): void {
  if (candidate.length === 0 || Buffer.byteLength(candidate, "utf8") > 4_096 || path.isAbsolute(candidate) ||
    candidate.includes("\\") || /[\u0000-\u001f\u007f]/.test(candidate) ||
    candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new CliFailure("INVALID_FILE");
  }
}

function assertCanonicalInputFile(candidate: string): void {
  try {
    if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate ||
      realpathSync.native(candidate) !== candidate || !statSync(candidate).isFile()) throw new Error("invalid");
  } catch {
    throw new CliFailure("INVALID_COMMAND");
  }
}

function assertCanonicalExecutable(candidate: string): void {
  assertCanonicalInputFile(candidate);
  if ((statSync(candidate).mode & 0o111) === 0) throw new CliFailure("INVALID_COMMAND");
}

function assertCanonicalDirectory(candidate: string): void {
  try {
    if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate ||
      realpathSync.native(candidate) !== candidate || !statSync(candidate).isDirectory()) throw new Error("invalid");
  } catch {
    throw new CliFailure("INVALID_COMMAND");
  }
}

function assertCanonicalOutputPath(candidate: string): void {
  try {
    if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate ||
      realpathSync.native(path.dirname(candidate)) !== path.dirname(candidate) ||
      (existsSync(candidate) && realpathSync.native(candidate) !== candidate)) throw new Error("invalid");
  } catch {
    throw new CliFailure("INVALID_COMMAND");
  }
}

function retentionForCli(
  databasePath: string,
  mode: "read-only" | "read-write" = "read-write",
): JournalRetentionService {
  try {
    return mode === "read-only"
      ? JournalRetentionService.openReadOnly(databasePath)
      : new JournalRetentionService(databasePath);
  } catch {
    throw new CliFailure(existsSync(databasePath) ? "INVALID_COMMAND" : "DATABASE_NOT_FOUND");
  }
}

function positiveInteger(value: string): number {
  if (!/^[1-9]\d{0,15}$/.test(value)) throw new CliFailure("INVALID_COMMAND");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliFailure("INVALID_COMMAND");
  return parsed;
}

function nonnegativeInteger(value: string): number {
  if (!/^(0|[1-9]\d{0,15})$/.test(value)) throw new CliFailure("INVALID_COMMAND");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliFailure("INVALID_COMMAND");
  return parsed;
}

function requireWorkflowSurface(runtime: { readonly workflowSurface?: WorkflowSurface }): WorkflowSurface {
  if (runtime.workflowSurface === undefined) throw new CliFailure("unavailable");
  return runtime.workflowSurface;
}

function canonicalTicketDirectory(candidate: string): string {
  try {
    if (candidate.length === 0 || Buffer.byteLength(candidate, "utf8") > 4_096 || /[\u0000-\u001f\u007f]/.test(candidate)) {
      throw new Error("invalid ticket directory");
    }
    const canonical = realpathSync.native(path.resolve(candidate));
    if (!path.isAbsolute(canonical) || path.normalize(canonical) !== canonical || !statSync(canonical).isDirectory()) {
      throw new Error("invalid ticket directory");
    }
    return canonical;
  } catch {
    throw new CliFailure("INVALID_COMMAND");
  }
}

function assertWorkflowDecisionIdentities(
  decisionId: string,
  options: Pick<WorkflowMutationOptions, "runId" | "actor" | "commandId">,
): void {
  assertWorkflowMutationIdentities(options.runId, options.actor, options.commandId);
  assertCliIdentity(decisionId);
}

function assertWorkflowMutationIdentities(runId: string, actor: string, commandId: string): void {
  assertCliIdentity(runId);
  assertCliIdentity(actor);
  assertCliIdentity(commandId);
}

function assertCliIdentity(value: string): void {
  if (value.trim() === "" || Buffer.byteLength(value, "utf8") > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CliFailure("INVALID_COMMAND");
  }
}

function assertCliText(value: string): void {
  if (value.trim() === "" || Buffer.byteLength(value, "utf8") > 4_096 || /[\u0000\u007f]/.test(value)) {
    throw new CliFailure("INVALID_COMMAND");
  }
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new CliFailure("INVALID_COMMAND");
}

function boundedVacuumPages(value: string): number {
  const parsed = positiveInteger(value);
  if (parsed > 1_000) throw new CliFailure("INVALID_COMMAND");
  return parsed;
}

function boundedTokenTtlSeconds(value: string): number {
  const parsed = positiveInteger(value);
  if (parsed > 86_400) throw new CliFailure("INVALID_COMMAND");
  return parsed;
}

function boundedAgentTrailTimeout(value: string): number {
  const parsed = positiveInteger(value);
  if (parsed > 600_000) throw new CliFailure("INVALID_COMMAND");
  return parsed;
}

function assertSafeTitle(title: string): void {
  if (title.length === 0 || Buffer.byteLength(title, "utf8") > MAX_TITLE_BYTES) {
    throw new CliFailure("INVALID_TITLE");
  }
}

function isBoundedVersion(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= 512 && !/[\r\n\u0000-\u001f\u007f]/.test(value);
}

function reviewPolicyTaskFromOptions(options: RunOptions): PlannedTask {
  const riskLevel = RiskLevelSchema.safeParse(options.riskLevel);
  const authority = AuthorityLevelSchema.safeParse(options.authority);
  if (!riskLevel.success || !authority.success) {
    throw new CliFailure("INVALID_COMMAND");
  }
  const risk = RiskClassificationSchema.safeParse({
    level: riskLevel.data,
    authority: authority.data,
    requiresReview: true,
    requiresApproval: options.requiresApproval === true,
  });
  if (!risk.success) throw new CliFailure("INVALID_COMMAND");

  const task = PlannedTaskSchema.safeParse({
    taskId: options.taskId,
    title: options.title,
    description: options.title,
    dependencies: [],
    ownedPaths: [options.file],
    forbiddenPaths: [],
    acceptanceCriteria: ["Focused validation completed and independent review approved the diff."],
    roleAssignment: { role: "implementer", agentId: WORKER_ID, harness: "deterministic" },
    risk: risk.data,
    budget: {
      maxSeconds: WORKER_TIMEOUT_MS,
      maxRetries: 0,
      maxCostUsd: 0,
      maxInputTokens: 1,
      maxOutputTokens: 1,
    },
  });
  if (!task.success) throw new CliFailure("INVALID_COMMAND");
  return task.data;
}

function assertSafeTaskId(taskId: string): void {
  if (!isSafeWorktreeTaskIdentity(taskId)) {
    throw new CliFailure("INVALID_TASK_ID");
  }
}

function toFailure(error: unknown, workflowCommand = false): CliFailure {
  if (error instanceof CliFailure) return error;
  if (error instanceof WorkflowSurfaceError) return new CliFailure(error.code);
  if (error instanceof CommanderError) {
    return new CliFailure("INVALID_COMMAND");
  }
  if (workflowCommand) return new CliFailure("internal");
  return new CliFailure("OPERATION_FAILED");
}

function isWorkflowCommand(argv: readonly string[]): boolean {
  return argv[0] === "run" || argv[0] === "list" || argv[0] === "status" || argv[0] === "cancel" ||
    argv[0] === "question" || argv[0] === "plan";
}

function operationalJsonLimit(argv: readonly string[]): number {
  return argv[0] === "status" ? MAX_WORKFLOW_DETAIL_JSON_BYTES : MAX_OPERATIONAL_JSON_BYTES;
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
    paused: false,
    stopAndAsk: null,
    uncertainEffect: null,
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

function publicMilestoneStatus(milestone: NonNullable<ReturnType<MilestoneRegistry["inspect"]>>) {
  if (milestone.lifecycle === "terminal") return Object.freeze({
    milestoneId: milestone.milestoneId,
    projectId: milestone.projectId,
    lifecycle: milestone.lifecycle,
    terminalOutcome: milestone.terminalOutcome,
    streamVersion: milestone.streamVersion,
    traceId: milestone.traceId,
    tracePath: milestone.tracePath,
    result: milestone.result,
  });
  if (milestone.lifecycle !== "paused" || milestone.attention === null) return milestone;
  return Object.freeze({
    milestoneId: milestone.milestoneId,
    projectId: milestone.projectId,
    lifecycle: milestone.lifecycle,
    terminalOutcome: milestone.terminalOutcome,
    streamVersion: milestone.streamVersion,
    attention: milestone.attention,
  });
}

function commandLabel(argv: readonly string[]): string {
  if (argv[0] === "start") return "start";
  if (argv[0] === "run") return "run";
  if (argv[0] === "list") return "list";
  if (argv[0] === "status") return "status";
  if (argv[0] === "cancel") return "cancel";
  if (argv[0] === "question") return `question.${argv[1] ?? "unknown"}`;
  if (argv[0] === "plan") return `plan.${argv[1] ?? "unknown"}`;
  if (argv[0] === "milestone" && argv[1] === "run") return "milestone.run";
  if (argv[0] === "milestone" && argv[1] === "preview") return "milestone.preview";
  if (argv[0] === "milestone" && argv[1] === "list") return "milestone.list";
  if (argv[0] === "milestone" && argv[1] === "status") return "milestone.status";
  if (argv[0] === "policy" && argv[1] === "preview") return "policy.preview";
  if (argv[0] === "capsule" && argv[1] === "conformance") return "capsule.conformance";
  if (argv[0] === "github") return `github.${argv[1] ?? "unknown"}`;
  if (argv[0] === "project" && argv[1] === "validate") return "project.validate";
  if (argv[0] === "task" && argv[1] === "run") return "task.run";
  if (argv[0] === "task" && argv[1] === "status") return "task.status";
  if (argv[0] === "recover") return "recover";
  return "unknown";
}

function milestoneExitCode(outcome: TaskView["terminalOutcome"], traceFailed: boolean): number {
  if (traceFailed || outcome === null || outcome === "failed") return 1;
  if (outcome === "completed") return 0;
  if (outcome === "cancelled") return 2;
  if (outcome === "denied") return 3;
  return 4;
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
    if (!forceDirectExit) {
      process.exitCode = exitCode;
      return;
    }
    const fallback = setTimeout(() => process.exit(exitCode), LIVE_OUTPUT_DESTROY_TIMEOUT_MS);
    process.stderr.write("", () => {
      clearTimeout(fallback);
      process.exit(exitCode);
    });
  });
}
