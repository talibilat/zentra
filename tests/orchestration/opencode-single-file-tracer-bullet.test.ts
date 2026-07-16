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
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
import { OpenCodeSingleFileTracerBullet } from "../../src/orchestration/opencode-single-file-tracer-bullet.js";
import { WriterWorktreeCapsule } from "../../src/orchestration/writer-worktree-capsule.js";
import type { ModelCapability } from "../../src/policy/model-sheet.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";
import type { ProjectConfig } from "../../src/projects/project-config.js";
import { TaskService } from "../../src/tasks/task-service.js";
import { projectTask } from "../../src/tasks/task-projection.js";
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
});

async function runTracer(fixture: Fixture, replacement: string): Promise<{
  view: Awaited<ReturnType<OpenCodeSingleFileTracerBullet["run"]>>;
  events: readonly { readonly type: string; readonly payload: unknown }[];
  trace: readonly TraceEvent[];
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
  const tracer = new OpenCodeSingleFileTracerBullet(
    tasks,
    new WriterWorktreeCapsule(
      worktrees,
      new OpenCodeWriter(supervisor),
      new WorkspaceOwnershipGate(),
    ),
    new ValidationRunner(supervisor),
    worktrees,
  );
  const view = await tracer.run({
    project: fixture.project,
    task: plannedTask(),
    model,
    security: securitySheet,
    probe,
    signal: AbortSignal.timeout(15_000),
  });
  if (journal.projectionFailed) throw new Error("Agent Tail projection failed");
  sink.close();
  sqlite.close();
  const reopened = new SqliteEventJournal(databasePath);
  const events = reopened.readStream("writer-tracer");
  const replayed = projectTask(events);
  reopened.close();
  if (replayed?.terminalOutcome !== view.terminalOutcome) {
    throw new Error("durable task replay contradicted the live result");
  }
  const trace = readFileSync(tracePath, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as TraceEvent);
  return {
    view,
    events,
    trace,
    worktree: path.join(fixture.project.worktreeRoot, "writer-tracer"),
  };
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
}

async function fixtureProject(expected: string): Promise<Fixture> {
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
  await gitOk(repository, ["add", "--", "src/greeting.mjs", "test/greeting.test.mjs"]);
  await gitOk(repository, ["commit", "-m", "initial"]);
  return {
    root,
    repository,
    project: {
      projectId: "fixture",
      repositoryPath: repository,
      integrationBranch: "zentra/integration",
      worktreeRoot: path.join(root, "worktrees"),
      validations: {
        focused: [process.execPath, "--test", "test/greeting.test.mjs"],
        full: [process.execPath, "--test"],
        focusedTimeoutMs: 5_000,
        fullTimeoutMs: 5_000,
      },
    },
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
