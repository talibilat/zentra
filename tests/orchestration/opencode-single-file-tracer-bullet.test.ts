import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ValidationRunner } from "../../src/capabilities/validation-runner.js";
import type { PlannedTask } from "../../src/contracts/milestone.js";
import { OpenCodeWriter } from "../../src/harnesses/opencode-writer.js";
import { OpenCodeProbe } from "../../src/harnesses/opencode-probe.js";
import { IntegrationQueue } from "../../src/integration/integration-queue.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
import {
  OpenCodeIntegratedSingleFileTracer,
  OpenCodeSingleFileTracerBullet,
} from "../../src/orchestration/opencode-single-file-tracer-bullet.js";
import { WriterWorktreeCapsule } from "../../src/orchestration/writer-worktree-capsule.js";
import type { ModelCapability } from "../../src/policy/model-sheet.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";
import {
  ProjectConfigSchema,
  type ProjectConfig,
} from "../../src/projects/project-config.js";
import { ReviewGate } from "../../src/reviews/review-gate.js";
import type { OpenCodeReadOnlyProgramResult } from "../../src/agents/opencode-read-only-program.js";
import {
  OpenCodeReviewerAdapter,
  type OpenCodeReviewerProgram,
} from "../../src/reviews/opencode-reviewer-adapter.js";
import {
  canonicalValidationDigest,
  type ReviewDecision,
  type ReviewInput,
  type ReviewerAdapter,
} from "../../src/reviews/reviewer-adapter.js";
import { TaskService } from "../../src/tasks/task-service.js";
import { projectTask } from "../../src/tasks/task-projection.js";
import { MilestoneRegistry, type MilestoneRecord } from "../../src/milestones/milestone-registry.js";
import { TwoAgentMilestoneCoordinator } from "../../src/orchestration/two-agent-milestone.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import { GitClient } from "../../src/workspaces/git-client.js";
import { WorkspaceOwnershipGate } from "../../src/workspaces/workspace-ownership.js";
import { WorktreeManager } from "../../src/workspaces/worktree-manager.js";

const directories: string[] = [];
const git = new GitClient();

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OpenCodeSingleFileTracerBullet", () => {
  it("records a real OpenCode source edit, configured validation, and complete Agent Tail trace", async () => {
    const fixture = await fixtureProject("hello from OpenCode");
    const result = await runTracer(fixture, "hello from OpenCode");

    expect(result.view).toMatchObject({ lifecycle: "terminal", terminalOutcome: "completed" });
    expect(readFileSync(path.join(result.worktree, "src/greeting.mjs"), "utf8"))
      .toContain("hello from OpenCode");
    expect(await gitOutput(fixture.repository, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(path.join(fixture.repository, "src/greeting.mjs"), "utf8")).toContain("hello");
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "artifact.patch_recorded",
      "artifact.validation_report_recorded",
      "task.started",
      "task.writer_completed",
      "task.validation_started",
      "task.validation_completed",
      "task.completed",
    ]));
    expect(requiredTraceKinds(result.trace)).toEqual([
      "task.started",
      "task.writer_completed",
      "task.validation_started",
      "task.validation_completed",
      "task.completed",
    ]);
    expect(result.trace.find((event) => event.kind === "task.writer_completed")).toMatchObject({
      actor: { id: "writer-model", role: "worker" },
      operation: { name: "writer", status: "completed" },
    });
    expect(result.trace.find((event) => event.kind === "task.started")).toMatchObject({
      actor: { id: "writer-model", role: "worker" },
      operation: { name: "writer", status: "running" },
    });
    expect(result.trace.find((event) => event.kind === "task.validation_completed")).toMatchObject({
      actor: { id: "zentra-validator", role: "validator" },
      operation: { name: "validation", status: "completed" },
    });
  });

  it("records failed configured validation and preserves the changed worktree", async () => {
    const fixture = await fixtureProject("hello from OpenCode");
    const result = await runTracer(fixture, "wrong greeting");

    expect(result.view).toMatchObject({ lifecycle: "terminal", terminalOutcome: "failed" });
    expect(existsSync(result.worktree)).toBe(true);
    expect(readFileSync(path.join(result.worktree, "src/greeting.mjs"), "utf8"))
      .toContain("wrong greeting");
    const validation = result.events.find((event) => event.type === "task.validation_completed");
    expect(validation?.payload).toMatchObject({
      outcome: "failed",
      validation: {
        name: "focused",
        outcome: "failed",
        command: fixture.project.validations.focused,
      },
    });
    expect(requiredTraceKinds(result.trace)).toEqual([
      "task.started",
      "task.writer_completed",
      "task.validation_started",
      "task.validation_completed",
      "task.failed",
    ]);
    expect(await gitOutput(fixture.repository, ["status", "--porcelain"])).toBe("");
  });

  it("commits the reviewed file and integrates through the validated default branch candidate", async () => {
    const fixture = await fixtureProject("hello from OpenCode");
    const reviewer = new OpenCodeReviewerAdapter(
      new ApprovingOpenCodeReviewerProgram(),
      {
        milestoneId: "two-agent-milestone",
        taskId: "review-tracer",
        repositoryPath: fixture.repository,
        reviewerId: "reviewer-1",
        budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
        timeoutMs: 5_000,
      },
    );
    const result = await runTracer(fixture, "hello from OpenCode", true, reviewer, true);

    expect(result.view).toMatchObject({ lifecycle: "terminal", terminalOutcome: "completed" });
    expect(result.milestone).toMatchObject({ lifecycle: "terminal", terminalOutcome: "completed" });
    expect(result.milestone?.tasks).toMatchObject({
      "writer-tracer": { status: "completed", terminalOutcome: "completed" },
      "review-tracer": { status: "completed", terminalOutcome: "completed" },
    });
    expect(existsSync(result.worktree)).toBe(false);
    expect(await gitOutput(fixture.repository, [
      "show",
      "zentra/integration:src/greeting.mjs",
    ])).toContain("hello from OpenCode");
    expect(await gitOutput(fixture.repository, ["show", "main:src/greeting.mjs"]))
      .toContain("'hello'");
    expect(await gitOutput(fixture.repository, ["status", "--porcelain"])).toBe("");
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "task.review_requested",
      "artifact.review_report_recorded",
      "task.review_approved",
      "task.integration_started",
      "artifact.integration_receipt_recorded",
      "task.integration_prepared",
      "task.integration_observed",
      "task.cleanup_started",
      "task.cleanup_completed",
      "task.completed",
    ]));
    const receiptEvent = result.events.find((event) => event.type === "task.integration_prepared");
    expect(receiptEvent?.payload).toMatchObject({
      receipt: {
        outcome: "completed",
        taskId: "writer-tracer",
        projectId: "fixture",
        validation: { name: "full", outcome: "completed", exitCode: 0 },
      },
    });
    const integrationStarted = result.events.find((event) => event.type === "task.integration_started");
    const sourceCommit = (integrationStarted?.payload as { sourceCommit?: string }).sourceCommit;
    expect(sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect((await gitOutput(fixture.repository, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      sourceCommit!,
    ])).trim()).toBe("src/greeting.mjs");
    const milestoneEvents = result.allEvents.filter((event) => event.streamId === "two-agent-milestone");
    const writerCompleted = milestoneEvents.findIndex((event) =>
      event.type === "milestone.task_completed" && (event.payload as { taskId?: string }).taskId === "writer-tracer");
    const reviewerReady = milestoneEvents.findIndex((event) =>
      event.type === "milestone.task_ready" && (event.payload as { taskId?: string }).taskId === "review-tracer");
    expect(writerCompleted).toBeGreaterThan(-1);
    expect(reviewerReady).toBeGreaterThan(writerCompleted);
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: { id: "writer-model", role: "implementer" },
        span_id: "milestone:two-agent-milestone:task:writer-tracer",
        parent_span_id: "milestone:two-agent-milestone",
      }),
      expect.objectContaining({
        actor: { id: "reviewer-1", role: "reviewer" },
        span_id: "milestone:two-agent-milestone:task:review-tracer",
        parent_span_id: "milestone:two-agent-milestone",
      }),
    ]));
  });

  it("preserves the committed ticket worktree when full candidate validation fails", async () => {
    const fixture = await fixtureProject("hello from OpenCode", true);
    const originalIntegration = await gitOutput(fixture.repository, ["rev-parse", "HEAD"]);
    const result = await runTracer(fixture, "hello from OpenCode", true);

    expect(result.view).toMatchObject({ lifecycle: "terminal", terminalOutcome: "failed" });
    expect(existsSync(result.worktree)).toBe(true);
    expect(await gitOutput(fixture.repository, ["rev-parse", "zentra/integration"]))
      .toBe(originalIntegration);
    expect(await gitOutput(fixture.repository, ["rev-parse", "ticket/writer-tracer"]))
      .toMatch(/^[0-9a-f]{40}\n$/);
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "task.integration_started",
      "artifact.integration_receipt_recorded",
      "task.failed",
    ]));
    expect(result.events.map((event) => event.type)).not.toContain("task.cleanup_started");
  });

  it("records an OpenCode reviewer denial and never commits or integrates", async () => {
    const fixture = await fixtureProject("hello from OpenCode");
    const reviewer = new OpenCodeReviewerAdapter(
      new DenyingOpenCodeReviewerProgram(),
      {
        milestoneId: "review-milestone",
        taskId: "review-task",
        repositoryPath: fixture.repository,
        reviewerId: "reviewer-1",
        budget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 },
        timeoutMs: 20_000,
      },
    );
    const result = await runTracer(fixture, "hello from OpenCode", true, reviewer);

    expect(result.view).toMatchObject({ lifecycle: "terminal", terminalOutcome: "denied" });
    expect(existsSync(result.worktree)).toBe(true);
    expect(result.events.map((event) => event.type)).toContain("artifact.review_report_recorded");
    expect(result.events.map((event) => event.type)).not.toContain("task.integration_started");
    expect(result.trace.find((event) => event.kind === "task.denied")).toMatchObject({
      actor: { id: "reviewer-1", role: "reviewer" },
      operation: { name: "review", status: "denied" },
    });
  });

  it("pauses without retry when OpenCode review transport is uncertain", async () => {
    const fixture = await fixtureProject("hello from OpenCode");
    const program = new UncertainOpenCodeReviewerProgram();
    const reviewer = new OpenCodeReviewerAdapter(program, {
      milestoneId: "review-milestone",
      taskId: "review-task",
      repositoryPath: fixture.repository,
      reviewerId: "reviewer-1",
      budget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 },
      timeoutMs: 20_000,
    });
    const result = await runTracer(fixture, "hello from OpenCode", true, reviewer);

    expect(result.view).toMatchObject({
      lifecycle: "awaiting_review",
      terminalOutcome: null,
      paused: true,
      uncertainEffect: {
        boundary: "review",
        evidence: {
          reviewerId: "reviewer-1",
          milestoneId: "review-milestone",
          taskId: "review-task",
          brokerTransport: "uncertain",
        },
      },
    });
    expect(program.calls).toBe(1);
    expect(existsSync(result.worktree)).toBe(true);
    expect(result.events.map((event) => event.type)).not.toContain("task.integration_started");
    expect(result.trace.find((event) => event.kind === "task.effect_uncertain")).toMatchObject({
      actor: { id: "zentra-recovery-controller", role: "recovery" },
      operation: { name: "review", status: "waiting" },
    });
  });
});

async function runTracer(
  fixture: Fixture,
  replacement: string,
  integrate = false,
  reviewer: ReviewerAdapter = new ApprovingReviewer(),
  coordinate = false,
): Promise<{
  view: Awaited<ReturnType<OpenCodeSingleFileTracerBullet["run"]>>;
  events: readonly { readonly type: string; readonly payload: unknown }[];
  trace: readonly TraceEvent[];
  allEvents: readonly { readonly streamId: string; readonly type: string; readonly payload: unknown }[];
  milestone: MilestoneRecord | null;
  worktree: string;
}> {
  const executable = fakeOpenCode(fixture.root, replacement);
  const databasePath = path.join(fixture.root, "run.sqlite");
  const tracePath = path.join(fixture.root, "agent-tail.jsonl");
  const sink = AgentTailJsonlFileSink.open(fixture.root, tracePath);
  const sqlite = new SqliteEventJournal(databasePath);
  const journal = new ProjectingEventJournal(sqlite, sink);
  const tasks = new TaskService(journal);
  const worktrees = new WorktreeManager();
  const supervisor = new ProcessSupervisor();
  const model = writerModel();
  const securitySheet = security(fixture.repository);
  const probe = await new OpenCodeProbe(supervisor).probe({
    executable,
    cwd: fixture.repository,
    timeoutMs: 5_000,
    modelId: model.id,
    models: { models: [model] },
    security: securitySheet,
  }, AbortSignal.timeout(10_000));
  if (probe.outcome !== "completed") throw new Error("fixture OpenCode probe failed");
  const capsule = new WriterWorktreeCapsule(
    worktrees,
    new OpenCodeWriter(supervisor),
    new WorkspaceOwnershipGate(),
  );
  const commonRequest = {
    project: fixture.project,
    task: plannedTask(),
    model,
    security: securitySheet,
    probe,
    signal: AbortSignal.timeout(15_000),
  };
  const integratedTracer = new OpenCodeIntegratedSingleFileTracer(
      tasks,
      capsule,
      new ValidationRunner(supervisor),
      worktrees,
      {
        reviewer,
        reviews: new ReviewGate(),
        integrations: new IntegrationQueue(git, new ValidationRunner(supervisor)),
        git,
      },
    );
  let milestone: MilestoneRecord | null = null;
  let view;
  if (integrate && coordinate) {
    const registry = new MilestoneRegistry(journal);
    const writer = plannedTask();
    const reviewTask: PlannedTask = {
      ...writer,
      taskId: "review-tracer",
      title: "Review greeting",
      description: "Independently review the validated greeting change.",
      dependencies: [writer.taskId],
      roleAssignment: { role: "reviewer", agentId: "reviewer-1", harness: "opencode" },
      risk: { level: "low", authority: "review", requiresReview: false, requiresApproval: false },
    };
    const modelSheet = { models: [model, reviewerModel()] };
    registry.register({
      milestoneId: "two-agent-milestone",
      projectId: fixture.project.projectId,
      title: "Implement and review greeting",
      correlationId: "two-agent-trace",
      plan: {
        milestoneId: "two-agent-milestone",
        projectId: fixture.project.projectId,
        goal: "Implement and independently review the greeting.",
        tasks: [writer, reviewTask],
      },
      authority: { security: securitySheet, modelSheet },
    });
    milestone = await new TwoAgentMilestoneCoordinator(registry, integratedTracer).run({
      milestoneId: "two-agent-milestone",
      writerTaskId: writer.taskId,
      reviewerTaskId: reviewTask.taskId,
      security: securitySheet,
      modelSheet,
      writerAdmission: admissionContext(fixture.repository, model, writer),
      reviewerAdmission: admissionContext(fixture.repository, reviewerModel(), reviewTask),
      execution: { ...commonRequest, reviewerId: "reviewer-1" },
    });
    view = tasks.get(writer.taskId)!;
  } else if (integrate) {
    view = await integratedTracer.run({ ...commonRequest, reviewerId: "reviewer-1" });
  } else {
    view = await new OpenCodeSingleFileTracerBullet(
      tasks,
      capsule,
      new ValidationRunner(supervisor),
      worktrees,
    ).run(commonRequest);
  }
  if (journal.projectionFailed) throw new Error("Agent Tail projection failed");
  sink.close();
  sqlite.close();
  const reopened = new SqliteEventJournal(databasePath);
  const events = reopened.readStream("writer-tracer");
  const allEvents = reopened.readAll();
  const replayed = projectTask(events);
  const replayedMilestone = milestone === null
    ? null
    : new MilestoneRegistry(reopened).inspect(milestone.milestoneId);
  reopened.close();
  if (replayed?.terminalOutcome !== view.terminalOutcome) {
    throw new Error("durable task replay contradicted the live result");
  }
  const trace = readFileSync(tracePath, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as TraceEvent);
  return {
    view,
    events,
    allEvents,
    trace,
    milestone: replayedMilestone,
    worktree: path.join(fixture.project.worktreeRoot, "writer-tracer"),
  };
}

class DenyingOpenCodeReviewerProgram implements OpenCodeReviewerProgram {
  run(request: Parameters<OpenCodeReviewerProgram["run"]>[0]): Promise<OpenCodeReadOnlyProgramResult> {
    const prompt = JSON.parse(request.rolePrompt) as { request: Record<string, unknown> };
    const challenged = prompt.request;
    const response = {
      schemaVersion: 1,
      reviewerId: challenged.reviewerId,
      decision: "deny",
      requestSha256: createHash("sha256")
        .update(JSON.stringify(challenged), "utf8")
        .digest("hex"),
      diffSha256: challenged.diffSha256,
      validationSha256: challenged.validationSha256,
      decidedAt: "2026-07-16T12:00:00.000Z",
      reason: "The OpenCode reviewer found an unsafe change.",
    };
    return Promise.resolve({
      status: "executed",
      outcome: "completed",
      openCode: { version: "1.18.1", executableSha256: "c".repeat(64) },
      model: { id: "fixture/model", provider: "fixture", name: "reviewer-v1" },
      evidence: [{ kind: "review", summary: JSON.stringify(response) }],
      cleanup: "completed",
      brokerTransport: "completed",
      trace: { outcome: "emitted" },
      operationOutcome: "completed",
      execution: {
        milestoneId: request.milestoneId,
        taskId: request.taskId,
        capsuleId: "capsule-review-1",
        actorId: "reviewer-1",
        capabilityId: "reviewer-1",
        transportModelId: "fixture/model",
      },
    });
  }
}

class ApprovingOpenCodeReviewerProgram implements OpenCodeReviewerProgram {
  run(request: Parameters<OpenCodeReviewerProgram["run"]>[0]): Promise<OpenCodeReadOnlyProgramResult> {
    const prompt = JSON.parse(request.rolePrompt) as { request: Record<string, unknown> };
    const challenged = prompt.request;
    const response = {
      schemaVersion: 1,
      reviewerId: challenged.reviewerId,
      decision: "approve",
      requestSha256: createHash("sha256").update(JSON.stringify(challenged), "utf8").digest("hex"),
      diffSha256: challenged.diffSha256,
      validationSha256: challenged.validationSha256,
      decidedAt: "2026-07-17T12:00:00.000Z",
      reason: "The exact validated change is approved.",
    };
    return Promise.resolve({
      status: "executed",
      outcome: "completed",
      openCode: { version: "1.18.1", executableSha256: "c".repeat(64) },
      model: { id: "fixture/reviewer-1", provider: "fixture", name: "reviewer-v1" },
      evidence: [{ kind: "review", summary: JSON.stringify(response) }],
      cleanup: "completed",
      brokerTransport: "completed",
      trace: { outcome: "emitted" },
      operationOutcome: "completed",
      execution: {
        milestoneId: request.milestoneId,
        taskId: request.taskId,
        capsuleId: "capsule-review-approved",
        actorId: "reviewer-1",
        capabilityId: "reviewer-1",
        transportModelId: "fixture/reviewer-1",
      },
    });
  }
}

class UncertainOpenCodeReviewerProgram implements OpenCodeReviewerProgram {
  calls = 0;

  run(request: Parameters<OpenCodeReviewerProgram["run"]>[0]): Promise<OpenCodeReadOnlyProgramResult> {
    this.calls += 1;
    return Promise.resolve({
      status: "executed",
      outcome: "failed",
      openCode: { version: "1.18.1", executableSha256: "c".repeat(64) },
      model: { id: "fixture/model", provider: "fixture", name: "reviewer-v1" },
      evidence: [],
      cleanup: "completed",
      brokerTransport: "uncertain",
      trace: { outcome: "emitted" },
      operationOutcome: "failed",
      execution: {
        milestoneId: request.milestoneId,
        taskId: request.taskId,
        capsuleId: "capsule-review-uncertain",
        actorId: "reviewer-1",
        capabilityId: "reviewer-1",
        transportModelId: "fixture/model",
      },
    });
  }
}

class ApprovingReviewer implements ReviewerAdapter {
  review(input: ReviewInput): Promise<ReviewDecision> {
    return Promise.resolve({
      reviewerId: input.reviewerId,
      approved: true,
      diffSha256: createHash("sha256").update(input.diff, "utf8").digest("hex"),
      validationSha256: canonicalValidationDigest(input.validation),
      decidedAt: new Date().toISOString(),
      reason: "approved by independent fixture reviewer",
    });
  }
}

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly project: ProjectConfig;
}

interface TraceEvent {
  readonly kind: string;
  readonly actor: unknown;
  readonly operation: unknown;
  readonly span_id?: string;
  readonly parent_span_id?: string | null;
}

async function fixtureProject(expected: string, fullFails = false): Promise<Fixture> {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-tracer-")));
  directories.push(root);
  const repository = path.join(root, "repository");
  await gitOk(root, ["init", "-b", "main", repository]);
  await gitOk(repository, ["config", "user.name", "Zentra Fixture"]);
  await gitOk(repository, ["config", "user.email", "fixture@zentra.local"]);
  mkdirSync(path.join(repository, "src"));
  mkdirSync(path.join(repository, "test"));
  writeFileSync(path.join(repository, "src/greeting.mjs"), "export const greeting = 'hello';\n");
  writeFileSync(
    path.join(repository, "test/greeting.test.mjs"),
    `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { greeting } from "../src/greeting.mjs";\ntest("greeting", () => assert.equal(greeting, ${JSON.stringify(expected)}));\n`,
  );
  writeFileSync(
    path.join(repository, "test/full.test.mjs"),
    `import assert from "node:assert/strict";\nimport test from "node:test";\ntest("full", () => assert.equal(${fullFails ? "false" : "true"}, true));\n`,
  );
  await gitOk(repository, [
    "add",
    "--",
    "src/greeting.mjs",
    "test/greeting.test.mjs",
    "test/full.test.mjs",
  ]);
  await gitOk(repository, ["commit", "-m", "initial"]);
  return {
    root,
    repository,
    project: ProjectConfigSchema.parse({
      projectId: "fixture",
      repositoryPath: repository,
      worktreeRoot: path.join(root, "worktrees"),
      validations: {
        focused: [process.execPath, "--test", "test/greeting.test.mjs"],
        full: [process.execPath, "--test", "test/full.test.mjs", "test/greeting.test.mjs"],
        focusedTimeoutMs: 5_000,
        fullTimeoutMs: 5_000,
      },
    }),
  };
}

function fakeOpenCode(root: string, replacement: string): string {
  const executable = path.join(root, `fake-opencode-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(executable, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("OpenCode fixture 1.0\\n");
  process.exit(0);
}
const workspace = args[9];
const packet = JSON.parse(args[10]);
if (!packet.brief.includes("greeting")) process.exit(9);
const source = path.join(workspace, packet.ownedPaths[0]);
const current = readFileSync(source, "utf8");
writeFileSync(source, current.replace("hello", ${JSON.stringify(replacement)}));
process.stdout.write(JSON.stringify({ type: "step_finish" }) + "\\n");
`, { mode: 0o755 });
  return realpathSync.native(executable);
}

function plannedTask(): PlannedTask {
  return {
    taskId: "writer-tracer",
    title: "Update greeting",
    description: "Update the greeting implementation.",
    dependencies: [],
    ownedPaths: ["src/greeting.mjs"],
    forbiddenPaths: [".env"],
    acceptanceCriteria: ["The focused greeting test passes."],
    roleAssignment: { role: "implementer", agentId: "writer-model", harness: "opencode" },
    risk: { level: "low", authority: "workspace_write", requiresReview: true, requiresApproval: false },
    budget: { maxSeconds: 5, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000 },
  };
}

function writerModel(): ModelCapability {
  return {
    id: "writer-model",
    harness: "opencode",
    model: "provider/model",
    roles: ["implementer"],
    specialties: ["coding"],
    costTier: "low",
    contextTokens: 128_000,
    maxConcurrency: 1,
    toolPermissions: ["read_repository", "write_worktree"],
    network: "denied",
    fallbackOrder: [],
    qualityHistory: { successes: 1, attempts: 1 },
  };
}

function reviewerModel(): ModelCapability {
  return {
    id: "reviewer-1",
    harness: "opencode",
    model: "fixture/reviewer-1",
    roles: ["reviewer"],
    specialties: ["review"],
    costTier: "low",
    contextTokens: 128_000,
    maxConcurrency: 1,
    toolPermissions: ["read_repository", "review_diff"],
    network: "denied",
    fallbackOrder: [],
    qualityHistory: { successes: 1, attempts: 1 },
  };
}

function admissionContext(repository: string, model: ModelCapability, task: PlannedTask) {
  return {
    kind: "opencode" as const,
    repositoryPath: repository,
    actorId: model.id,
    harness: "opencode" as const,
    role: task.roleAssignment.role,
    capabilityId: model.id,
    transportModelId: model.model,
    authority: task.risk.authority,
    roles: [...model.roles] as (typeof task.roleAssignment.role)[],
    toolPermissions: [...model.toolPermissions],
    network: "denied" as const,
    contextTokens: model.contextTokens,
    requestedBudget: {
      maxSeconds: task.budget.maxSeconds,
      maxCostUsd: task.budget.maxCostUsd,
      maxInputTokens: task.budget.maxInputTokens,
      maxOutputTokens: task.budget.maxOutputTokens,
      timeoutMs: task.budget.maxSeconds * 1_000,
    },
  };
}

function security(repository: string): SecuritySheet {
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

function requiredTraceKinds(trace: readonly TraceEvent[]): string[] {
  const required = new Set([
    "task.started",
    "task.writer_completed",
    "task.validation_started",
    "task.validation_completed",
    "task.completed",
    "task.failed",
  ]);
  return trace.map((event) => event.kind).filter((kind) => required.has(kind));
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
