import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OpenCodeReadOnlyProgramResult } from "../../src/agents/opencode-read-only-program.js";
import { OpenCodeReadOnlyProgram } from "../../src/agents/opencode-read-only-program.js";
import type { OpenCodeReadOnlyCapsule } from "../../src/agents/opencode-read-only-agent.js";
import {
  ValidationRunner,
  type ValidationReport,
  type ValidationRunContext,
} from "../../src/capabilities/validation-runner.js";
import type { MilestonePlan, PlannedTask } from "../../src/contracts/milestone.js";
import { OpenCodeProbe } from "../../src/harnesses/opencode-probe.js";
import { OpenCodeWriter } from "../../src/harnesses/opencode-writer.js";
import { IntegrationQueue } from "../../src/integration/integration-queue.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
import { MultiWriterOwnershipScheduler } from "../../src/orchestration/multi-writer-scheduler.js";
import { MultiAgentMilestoneCoordinator } from "../../src/orchestration/multi-agent-milestone.js";
import { MultipleMilestoneScheduler } from "../../src/orchestration/multiple-milestone-scheduler.js";
import { WriterResourceGovernor } from "../../src/orchestration/writer-resource-governor.js";
import { OpenCodeIntegratedSingleFileTracer } from "../../src/orchestration/opencode-single-file-tracer-bullet.js";
import { WriterWorktreeCapsule } from "../../src/orchestration/writer-worktree-capsule.js";
import type { ModelCapability, ModelSheet } from "../../src/policy/model-sheet.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";
import { ProjectConfigSchema, type ProjectConfig } from "../../src/projects/project-config.js";
import { ReviewGate } from "../../src/reviews/review-gate.js";
import {
  OpenCodeReviewerAdapter,
  type OpenCodeReviewerProgram,
} from "../../src/reviews/opencode-reviewer-adapter.js";
import { TaskService } from "../../src/tasks/task-service.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import { GitClient } from "../../src/workspaces/git-client.js";
import { WorkspaceOwnershipGate } from "../../src/workspaces/workspace-ownership.js";
import { WorktreeManager } from "../../src/workspaces/worktree-manager.js";

const directories: string[] = [];
const git = new GitClient();

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MultipleMilestoneScheduler real-Git production path", () => {
  it("runs two production milestone coordinators with shared writer and integration control", async () => {
    const fixture = await fixtureProject();
    const databasePath = path.join(fixture.root, "scheduler.sqlite");
    const tracePaths = [path.join(fixture.root, "milestone-a.jsonl"), path.join(fixture.root, "milestone-b.jsonl")];
    let sqlite: SqliteEventJournal | null = new SqliteEventJournal(databasePath);
    const sinks = tracePaths.map((tracePath) => AgentTailJsonlFileSink.open(fixture.root, tracePath));
    try {
      const supervisor = new ProcessSupervisor();
      const writerModel = model("writer-model", "implementer", 2);
      const reviewerA = model("reviewer-a", "reviewer", 1);
      const reviewerB = model("reviewer-b", "reviewer", 1);
      const planner = model("planner", "planner", 1);
      const researcher = model("researcher", "researcher", 1);
      const modelSheet: ModelSheet = { models: [planner, researcher, writerModel, reviewerA, reviewerB] };
      const security = securitySheet(fixture.repository);
      const executable = fakeConcurrentOpenCode(fixture.root);
      const probe = await new OpenCodeProbe(supervisor).probe({
        executable,
        cwd: fixture.repository,
        timeoutMs: 5_000,
        modelId: writerModel.id,
        models: modelSheet,
        security,
      }, AbortSignal.timeout(10_000));
      expect(probe.outcome).toBe("completed");

      const plans = [milestonePlan("a"), milestonePlan("b")];
      const journals = sinks.map((sink) => new ProjectingEventJournal(sqlite!, sink));
      const registries = journals.map((journal, index) => {
        const plan = plans[index]!;
        const registry = new MilestoneRegistry(journal);
        registry.register({
          milestoneId: plan.milestoneId, projectId: plan.projectId,
          title: `Real Git milestone ${index === 0 ? "A" : "B"}`,
          correlationId: `trace-real-${index === 0 ? "a" : "b"}`,
          tracePath: tracePaths[index]!, plan, authority: { security, modelSheet },
        });
        return registry;
      });
      const worktrees = new WorktreeManager(git);
      const capsule = new WriterWorktreeCapsule(
        worktrees,
        new OpenCodeWriter(supervisor),
        new WorkspaceOwnershipGate(),
        git,
      );
      const validations = new TrackingValidationRunner(supervisor);
      const governor = new WriterResourceGovernor(2);
      const coordinators = plans.map((plan, index) => {
        const suffix = index === 0 ? "a" : "b";
        const registry = registries[index]!;
        const journal = journals[index]!;
        const reviewer = reviewerAdapter(`reviewer-${suffix}`, `review-${suffix}`, fixture.repository, plan.milestoneId);
        const tracer = new OpenCodeIntegratedSingleFileTracer(
          new TaskService(journal), capsule, validations, worktrees,
          { reviewer, reviews: new ReviewGate(), integrations: new IntegrationQueue(git, validations), git },
        );
        const execution = { run: (request: Parameters<OpenCodeIntegratedSingleFileTracer["run"]>[0]) => tracer.run(request) };
        const readOnly = new OpenCodeReadOnlyProgram(
          journal, sinks[index]!,
          { execute: async () => { throw new Error("fixture capsule owns the bounded response"); } },
          modelSheet, security, readOnlyCapsule(fixture.root, suffix),
        );
        return new MultiAgentMilestoneCoordinator(
          registry, readOnly, new MultiWriterOwnershipScheduler(registry, execution, governor),
        );
      });
      const requests = plans.map((plan, index) => {
        const suffix = index === 0 ? "a" : "b";
        const writer = plan.tasks.find((task) => task.taskId === `writer-${suffix}`)!;
        const reviewer = plan.tasks.find((task) => task.taskId === `review-${suffix}`)!;
        const reviewerModel = modelSheet.models.find((candidate) => candidate.id === reviewer.roleAssignment.agentId)!;
        return {
          milestoneId: plan.milestoneId,
          readOnlyTasks: [`research-${suffix}`, `plan-${suffix}`].map((taskId) => {
            const planned = plan.tasks.find((task) => task.taskId === taskId)!;
            return { taskId, request: {
              milestoneId: plan.milestoneId, taskId, repositoryPath: fixture.repository,
              role: planned.roleAssignment.role as "planner" | "researcher",
              rolePrompt: `Produce bounded ${planned.roleAssignment.role} evidence.`,
              budget: { maxSeconds: 15, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
              timeoutMs: 15_000, signal: AbortSignal.timeout(30_000),
            } };
          }),
          writerSchedule: {
            milestoneId: plan.milestoneId, maxConcurrentWriters: 2, security, modelSheet,
            tasks: [{
              writerTaskId: writer.taskId, reviewerTaskId: reviewer.taskId,
              writerAdmission: admission(fixture.repository, writerModel, writer),
              reviewerAdmission: admission(fixture.repository, reviewerModel, reviewer),
              execution: { project: fixture.project, task: writer, model: writerModel, security, probe,
                reviewerId: reviewer.roleAssignment.agentId, signal: AbortSignal.timeout(30_000) },
            }],
          },
        };
      });
      const scheduled = await new MultipleMilestoneScheduler(governor).run(plans.map((plan, index) => ({
        milestoneId: plan.milestoneId, projectId: plan.projectId,
        traceId: `trace-real-${index === 0 ? "a" : "b"}`,
        coordinator: coordinators[index]!, request: requests[index]!,
      })));

      expect(scheduled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const results = scheduled.map((result) => {
        if (result.status !== "fulfilled") throw result.reason;
        expect(result.value.terminalOutcome).toBe("completed");
        return result.value;
      });
      expect(validations.focusedRuns).toBe(2);
      expect(validations.fullRuns).toBe(2);
      expect(validations.maxActiveFull).toBe(1);
      expect(readFileSync(path.join(fixture.root, "writer-a.started"), "utf8")).toBe("started");
      expect(readFileSync(path.join(fixture.root, "writer-b.started"), "utf8")).toBe("started");
      expect(await gitOutput(fixture.repository, ["show", "zentra/integration:src/a.mjs"])).toContain("updated-a");
      expect(await gitOutput(fixture.repository, ["show", "zentra/integration:src/b.mjs"])).toContain("updated-b");
      expect(await gitOutput(fixture.repository, ["show", "main:src/a.mjs"])).toContain("base-a");
      expect(await gitOutput(fixture.repository, ["show", "main:src/b.mjs"])).toContain("base-b");
      expect(await gitOutput(fixture.repository, ["status", "--porcelain"])).toBe("");
      for (const [index, taskId] of ["writer-a", "writer-b"].entries()) {
        expect(journals[index]!.readStream(taskId).map((event) => event.type)).toEqual(expect.arrayContaining([
          "task.validation_completed",
          "task.review_approved",
          "task.integration_observed",
          "task.completed",
        ]));
      }
      expect(results.map((result) => result.result?.integratedCommits[0]?.taskId)).toEqual(["writer-a", "writer-b"]);
      for (const sink of sinks) sink.close();
      sqlite.close();
      sqlite = null;
      const reopened = SqliteEventJournal.openReadOnly(databasePath);
      try {
        for (const [index, plan] of plans.entries()) {
          expect(new MilestoneRegistry(reopened).inspect(plan.milestoneId)).toEqual(results[index]);
        }
      } finally {
        reopened.close();
      }
      for (const [index, tracePath] of tracePaths.entries()) {
        const tail = readFileSync(tracePath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
        expect(tail.at(-1)).toMatchObject({
          kind: "milestone.completed",
          trace_id: `trace-real-${index === 0 ? "a" : "b"}`,
          attributes: { zentra: { stream_id: plans[index]!.milestoneId } },
        });
        expect(tail.every((event) => event.trace_id === `trace-real-${index === 0 ? "a" : "b"}`)).toBe(true);
      }
    } finally {
      for (const sink of sinks) sink.close();
      sqlite?.close();
    }
  }, 60_000);
});

class TrackingValidationRunner extends ValidationRunner {
  focusedRuns = 0;
  fullRuns = 0;
  maxActiveFull = 0;
  private activeFull = 0;

  override async run(
    project: ProjectConfig,
    name: "focused" | "full",
    cwd: string,
    signal: AbortSignal,
    context?: ValidationRunContext,
  ): Promise<ValidationReport> {
    if (name === "focused") this.focusedRuns += 1;
    if (name === "full") {
      this.fullRuns += 1;
      this.activeFull += 1;
      this.maxActiveFull = Math.max(this.maxActiveFull, this.activeFull);
    }
    try {
      return await super.run(project, name, cwd, signal, context);
    } finally {
      if (name === "full") this.activeFull -= 1;
    }
  }
}

class ApprovingProgram implements OpenCodeReviewerProgram {
  constructor(private readonly reviewerId: string) {}

  run(request: Parameters<OpenCodeReviewerProgram["run"]>[0]): Promise<OpenCodeReadOnlyProgramResult> {
    const prompt = JSON.parse(request.rolePrompt) as { request: Record<string, unknown> };
    const challenged = prompt.request;
    const response = {
      schemaVersion: 1,
      reviewerId: this.reviewerId,
      decision: "approve",
      requestSha256: createHash("sha256").update(JSON.stringify(challenged), "utf8").digest("hex"),
      diffSha256: challenged["diffSha256"],
      validationSha256: challenged["validationSha256"],
      decidedAt: "2026-07-17T12:00:00.000Z",
      reason: "Approved the exact independently validated diff.",
    };
    return Promise.resolve({
      status: "executed",
      outcome: "completed",
      openCode: { version: "1.18.1", executableSha256: "c".repeat(64) },
      model: { id: `fixture/${this.reviewerId}`, provider: "fixture", name: this.reviewerId },
      evidence: [{ kind: "review", summary: JSON.stringify(response) }],
      cleanup: "completed",
      brokerTransport: "completed",
      trace: { outcome: "emitted" },
      operationOutcome: "completed",
      execution: {
        milestoneId: request.milestoneId,
        taskId: request.taskId,
        capsuleId: `capsule-${this.reviewerId}`,
        actorId: this.reviewerId,
        capabilityId: this.reviewerId,
        transportModelId: `fixture/${this.reviewerId}`,
      },
    });
  }
}

function readOnlyCapsule(root: string, suffix: "a" | "b"): OpenCodeReadOnlyCapsule {
  return {
    execute: async (request, _broker, _signal, observe) => {
      if (request.role === "planner") {
        writeFileSync(path.join(root, `readonly-${suffix}.started`), "started");
        const peer = path.join(root, `readonly-${suffix === "a" ? "b" : "a"}.started`);
        const deadline = Date.now() + 5_000;
        while (!existsSync(peer)) {
          if (Date.now() > deadline) throw new Error("read-only milestones did not overlap");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      observe?.({
        type: "resources_prepared",
        payload: {
          capsuleId: request.capsuleId,
          resourceLabel: request.resources.resourceLabel,
          containerName: request.resources.containerName,
          containerId: "d".repeat(64),
          imageName: request.resources.imageName,
          imageId: `sha256:${"e".repeat(64)}`,
          repositoryViewPath: request.repositoryPath,
          repositoryRevision: request.securityBoundary.repositoryRevision,
        },
      });
      observe?.({
        type: "cleanup_observed",
        payload: {
          capsuleId: request.capsuleId,
          resourceLabel: request.resources.resourceLabel,
          containerName: request.resources.containerName,
          containerId: "d".repeat(64),
          imageName: request.resources.imageName,
          imageId: `sha256:${"e".repeat(64)}`,
          repositoryViewPath: request.repositoryPath,
          repositoryRevision: request.securityBoundary.repositoryRevision,
          outcome: "completed",
          containerAbsent: true,
          imageAbsent: true,
          repositoryViewAbsent: false,
        },
      });
      return {
        outcome: "completed",
        openCode: { version: "1.18.1", executableSha256: "f".repeat(64) },
        model: { id: request.transportModelId, provider: "fixture", name: request.actorId },
        evidence: [{ kind: request.role === "planner" ? "plan" : "research", summary: `${request.role} evidence.` }],
        cleanup: "completed",
        brokerTransport: "completed",
      };
    },
  };
}

function reviewerAdapter(reviewerId: string, taskId: string, repositoryPath: string, milestoneId: string): OpenCodeReviewerAdapter {
  return new OpenCodeReviewerAdapter(new ApprovingProgram(reviewerId), {
    milestoneId,
    taskId,
    repositoryPath,
    reviewerId,
    budget: { maxSeconds: 15, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
    timeoutMs: 15_000,
  });
}

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly project: ProjectConfig;
}

async function fixtureProject(): Promise<Fixture> {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-multi-writer-")));
  directories.push(root);
  const repository = path.join(root, "repository");
  await gitOk(root, ["init", "-b", "main", repository]);
  await gitOk(repository, ["config", "user.name", "Zentra Fixture"]);
  await gitOk(repository, ["config", "user.email", "fixture@zentra.local"]);
  mkdirSync(path.join(repository, "src"));
  mkdirSync(path.join(repository, "test"));
  writeFileSync(path.join(repository, "src/a.mjs"), "export const a = 'base-a';\n");
  writeFileSync(path.join(repository, "src/b.mjs"), "export const b = 'base-b';\n");
  writeFileSync(path.join(repository, "test/changes.test.mjs"), `import assert from "node:assert/strict";
import test from "node:test";
import { a } from "../src/a.mjs";
import { b } from "../src/b.mjs";
test("bounded changes", () => {
  assert.ok(["base-a", "updated-a"].includes(a));
  assert.ok(["base-b", "updated-b"].includes(b));
  assert.notEqual(a + "|" + b, "base-a|base-b");
});
`);
  await gitOk(repository, ["add", "--", "src/a.mjs", "src/b.mjs", "test/changes.test.mjs"]);
  await gitOk(repository, ["commit", "-m", "initial"]);
  return {
    root,
    repository,
    project: ProjectConfigSchema.parse({
      projectId: "fixture",
      repositoryPath: repository,
      worktreeRoot: path.join(root, "worktrees"),
      validations: {
        focused: [process.execPath, "--test", "test/changes.test.mjs"],
        full: [process.execPath, "--test", "test/changes.test.mjs"],
        focusedTimeoutMs: 10_000,
        fullTimeoutMs: 10_000,
      },
    }),
  };
}

function fakeConcurrentOpenCode(root: string): string {
  const executable = path.join(root, "fake-concurrent-opencode.mjs");
  writeFileSync(executable, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("OpenCode fixture 1.0\\n");
  process.exit(0);
}
const workspace = args[9];
const packet = JSON.parse(args[10]);
const taskId = path.basename(workspace);
writeFileSync(path.join(${JSON.stringify(root)}, taskId + ".started"), "started");
const peer = taskId === "writer-a" ? "writer-b" : "writer-a";
const deadline = Date.now() + 5000;
while (!existsSync(path.join(${JSON.stringify(root)}, peer + ".started"))) {
  if (Date.now() > deadline) process.exit(12);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
if (taskId === "writer-b") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
const source = path.join(workspace, packet.ownedPaths[0]);
const current = readFileSync(source, "utf8");
writeFileSync(source, current.replace(taskId === "writer-a" ? "base-a" : "base-b", taskId === "writer-a" ? "updated-a" : "updated-b"));
process.stdout.write(JSON.stringify({ type: "step_finish" }) + "\\n");
`, { mode: 0o755 });
  return realpathSync.native(executable);
}

function milestonePlan(suffix: "a" | "b"): MilestonePlan {
  const task = (taskId: string, role: "planner" | "researcher" | "implementer" | "reviewer", agentId: string, dependencies: string[], ownedPath: string): PlannedTask => ({
    taskId,
    title: taskId,
    description: `Complete ${taskId}.`,
    dependencies,
    ownedPaths: [ownedPath],
    forbiddenPaths: [".env", ".git/**"],
    acceptanceCriteria: ["The exact change is validated and independently reviewed."],
    roleAssignment: { role, agentId, harness: "opencode" },
    risk: { level: "low", authority: role === "implementer" ? "workspace_write" : role === "reviewer" ? "review" : "read_only", requiresReview: role === "implementer", requiresApproval: false },
    budget: { maxSeconds: 15, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
  });
  return {
    milestoneId: `real-milestone-${suffix}`,
    projectId: "fixture",
    goal: "Integrate two independent reviewed files.",
    tasks: [
      task(`plan-${suffix}`, "planner", "planner", [], "src/**"),
      task(`research-${suffix}`, "researcher", "researcher", [`plan-${suffix}`], "src/**"),
      task(`writer-${suffix}`, "implementer", "writer-model", [`research-${suffix}`], `src/${suffix}.mjs`),
      task(`review-${suffix}`, "reviewer", `reviewer-${suffix}`, [`writer-${suffix}`], `src/${suffix}.mjs`),
    ],
  };
}

function model(id: string, role: "planner" | "researcher" | "implementer" | "reviewer", maxConcurrency: number): ModelCapability {
  return {
    id,
    harness: "opencode",
    model: role === "implementer" ? "provider/model" : `fixture/${id}`,
    roles: [role],
    specialties: [role === "implementer" ? "coding" : role],
    costTier: "low",
    contextTokens: 128_000,
    maxConcurrency,
    toolPermissions: role === "implementer"
      ? ["read_repository", "write_worktree"]
      : role === "reviewer" ? ["read_repository", "review_diff"] : ["read_repository"],
    network: "denied",
    fallbackOrder: [],
    qualityHistory: { successes: 1, attempts: 1 },
  };
}

function admission(repository: string, capability: ModelCapability, task: PlannedTask) {
  return {
    kind: "opencode" as const,
    repositoryPath: repository,
    actorId: capability.id,
    harness: "opencode" as const,
    role: task.roleAssignment.role,
    capabilityId: capability.id,
    transportModelId: capability.model,
    authority: task.risk.authority,
    roles: [...capability.roles] as (typeof task.roleAssignment.role)[],
    toolPermissions: [...capability.toolPermissions],
    network: "denied" as const,
    contextTokens: capability.contextTokens,
    requestedBudget: {
      maxSeconds: task.budget.maxSeconds,
      maxCostUsd: task.budget.maxCostUsd,
      maxInputTokens: task.budget.maxInputTokens,
      maxOutputTokens: task.budget.maxOutputTokens,
      timeoutMs: task.budget.maxSeconds * 1_000,
    },
  };
}

function securitySheet(repository: string): SecuritySheet {
  return {
    allowedRepositories: [repository],
    allowedFileScopes: ["src/**"],
    forbiddenPaths: [".env", ".git/**"],
    network: { default: "denied", allowedDestinations: [] },
    secretHandling: ["Do not inherit parent secrets."],
    approvalRequiredOperations: ["external_effect"],
    releaseBoundary: "local_preparation_only",
    stopAndAskConditions: ["forbidden_file_scope"],
  };
}

async function gitOk(cwd: string, args: readonly string[]): Promise<void> {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout;
}
