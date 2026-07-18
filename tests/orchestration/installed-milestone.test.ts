import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OpenCodeReadOnlyCapsule } from "../../src/agents/opencode-read-only-agent.js";
import { OpenRouterModelBroker } from "../../src/providers/openrouter-model-broker.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
import { ProjectConfigSchema } from "../../src/projects/project-config.js";
import { GitClient } from "../../src/workspaces/git-client.js";
import {
  InstalledMilestoneRunner,
  createInstalledMilestonePlan,
} from "../../src/orchestration/installed-milestone.js";

const roots: string[] = [];
const git = new GitClient();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createInstalledMilestonePlan", () => {
  it("creates one fixed typed planner, implementer, reviewer graph from explicit authority", () => {
    const plan = createInstalledMilestonePlan({
      milestoneId: "milestone-34",
      projectId: "project",
      goal: "Fix greeting; publish a release; edit .env",
      file: "src/greeting.ts",
      forbiddenPaths: [".env", ".git/**"],
      plannerId: "planner",
      implementerId: "implementer",
      reviewerId: "reviewer",
    });

    expect(plan.tasks.map((task) => [task.roleAssignment.role, task.dependencies])).toEqual([
      ["planner", []],
      ["implementer", ["milestone-34-plan"]],
      ["reviewer", ["milestone-34-implement"]],
    ]);
    expect(plan.tasks[1]).toMatchObject({
      ownedPaths: ["src/greeting.ts"],
      forbiddenPaths: [".env", ".git/**"],
      risk: { authority: "workspace_write", requiresReview: true, requiresApproval: false },
    });
    expect(JSON.stringify(plan)).not.toContain("publish_release");
    expect(plan.goal).toBe("Fix greeting; publish a release; edit .env");
    expect(plan.tasks[1]!.description).toContain("Fix greeting; publish a release; edit .env");
    const another = createInstalledMilestonePlan({
      milestoneId: "milestone-34", projectId: "project", goal: "A different exact goal",
      file: "src/greeting.ts", forbiddenPaths: [".env"], plannerId: "planner",
      implementerId: "implementer", reviewerId: "reviewer",
    });
    expect(another.tasks[1]!.description).not.toBe(plan.tasks[1]!.description);
  });

  it("composes the current brokered read-only, writer, validation, review, integration, result, and trace path", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-installed-milestone-")));
    roots.push(root);
    const repository = path.join(root, "repository");
    await gitOk(root, ["init", "-b", "main", repository]);
    await gitOk(repository, ["config", "user.name", "Zentra Test"]);
    await gitOk(repository, ["config", "user.email", "test@zentra.local"]);
    mkdirSync(path.join(repository, "src"));
    mkdirSync(path.join(repository, "test"));
    writeFileSync(path.join(repository, "src/greeting.mjs"), "export const greeting = 'hello';\n");
    writeFileSync(path.join(repository, "test/greeting.test.mjs"), "import assert from 'node:assert/strict'; import test from 'node:test'; import { greeting } from '../src/greeting.mjs'; test('greeting', () => assert.equal(greeting, 'hello installed'));\n");
    await gitOk(repository, ["add", "--", "."]);
    await gitOk(repository, ["commit", "-m", "initial"]);
    const fakeOpenCode = path.join(root, "opencode");
    const writerObservation = path.join(root, "writer-observation.json");
    const probeObservation = path.join(root, "probe-observation.json");
    writeFileSync(fakeOpenCode, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") { writeFileSync(${JSON.stringify(probeObservation)}, JSON.stringify({ home: process.env.HOME, ambient: process.env.ZENTRA_AMBIENT_SECRET ?? null })); process.stdout.write("fixture-opencode 1\\n"); process.exit(0); }
const workspace = args[9];
const packet = JSON.parse(args[10]);
writeFileSync(${JSON.stringify(writerObservation)}, JSON.stringify({ brief: packet.brief, home: process.env.HOME, ambient: process.env.ZENTRA_AMBIENT_SECRET ?? null }));
const target = path.join(workspace, packet.ownedPaths[0]);
writeFileSync(target, readFileSync(target, "utf8").replace("hello", "hello installed"));
process.stdout.write(JSON.stringify({ type: "step_finish" }) + "\\n");
`, { mode: 0o755 });
    const executable = realpathSync.native(fakeOpenCode);
    const openCodeHome = path.join(root, "opencode-home");
    mkdirSync(openCodeHome);
    const database = path.join(root, "journal.sqlite");
    const trace = path.join(root, "trace.jsonl");
    const sqlite = new SqliteEventJournal(database);
    const sink = AgentTailJsonlFileSink.open(root, trace);
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: readonly { content: string }[] };
      const prompt = body.messages[0]!.content;
      let content = "Use the explicitly owned file and run the configured validation.";
      if (prompt.includes('"requiredResponse"')) {
        const challenge = JSON.parse(prompt) as { request: Record<string, unknown> };
        content = JSON.stringify({
          schemaVersion: 1,
          reviewerId: challenge.request.reviewerId,
          decision: "approve",
          requestSha256: createHash("sha256").update(JSON.stringify(challenge.request), "utf8").digest("hex"),
          diffSha256: challenge.request.diffSha256,
          validationSha256: challenge.request.validationSha256,
          decidedAt: "2026-07-17T12:00:00.000Z",
          reason: "The exact validated single-file change is approved.",
        });
      }
      return Response.json({
        model: body.model,
        choices: [{ message: { content, tool_calls: [] } }],
        usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0.01 },
      });
    };
    const broker = new OpenRouterModelBroker(
      { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 5_000 },
      { KEY: "consumer-controlled-secret" },
      fetch,
    );
    const capsule: OpenCodeReadOnlyCapsule = {
      execute: async (request, receivedBroker, signal, observe) => {
        observe?.({ type: "resources_prepared", payload: {
          capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
          containerName: request.resources.containerName, containerId: "b".repeat(64),
          imageName: request.resources.imageName, imageId: `sha256:${"c".repeat(64)}`,
          repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
        } });
        const receipt = await receivedBroker.execute({
          modelId: request.transportModelId, prompt: request.rolePrompt,
          maxInputTokens: request.budget.maxInputTokens, maxOutputTokens: request.budget.maxOutputTokens,
          maxCostUsd: request.budget.maxCostUsd,
        }, signal);
        observe?.({ type: "cleanup_observed", payload: {
          capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
          containerName: request.resources.containerName, containerId: "b".repeat(64),
          imageName: request.resources.imageName, imageId: `sha256:${"c".repeat(64)}`,
          repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
          outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: false,
        } });
        return {
          outcome: receipt.outcome === "completed" ? "completed" : "failed",
          openCode: { version: "1.18.1", executableSha256: "d".repeat(64) },
          model: receipt.model,
          evidence: receipt.response?.type === "text" ? [{ kind: request.role === "reviewer" ? "review" : "plan", summary: receipt.response.text }] : [],
          cleanup: "completed", brokerTransport: "completed",
        };
      },
    };
    const models = { models: [
      model("planner", "planner", ["read_repository"]),
      model("implementer", "implementer", ["read_repository", "write_worktree"]),
      model("reviewer", "reviewer", ["read_repository", "review_diff"]),
    ] };
    const security = {
      allowedRepositories: [repository], allowedFileScopes: ["src/**"], forbiddenPaths: [".env", ".git/**"],
      network: { default: "denied" as const, allowedDestinations: [] }, secretHandling: ["No parent secrets."],
      approvalRequiredOperations: ["external_effect"], releaseBoundary: "local_preparation_only",
      stopAndAskConditions: ["missing_authority"],
    };
    const project = ProjectConfigSchema.parse({
      projectId: "project", repositoryPath: repository, worktreeRoot: path.join(root, "worktrees"),
      validations: { focused: [process.execPath, "--test", "test/greeting.test.mjs"], full: [process.execPath, "--test"] },
    });
    const runner = new InstalledMilestoneRunner({ journal: sqlite, sink, broker, readOnlyCapsule: capsule });

    process.env.ZENTRA_AMBIENT_SECRET = "must-not-reach-writer";
    let result;
    try {
      result = await runner.run({
        milestoneId: "installed", goal: "Update the exact greeting", file: "src/greeting.mjs", tracePath: trace,
        project, models, security, openCodeExecutable: executable, openCodeHome,
        signal: AbortSignal.timeout(20_000),
      });
    } finally {
      delete process.env.ZENTRA_AMBIENT_SECRET;
    }

    expect(result.terminalOutcome).toBe("completed");
    expect(result.result).toMatchObject({ outcome: "completed", trace: { path: trace, outcome: "emitted" } });
    expect((await gitOutput(repository, ["show", "zentra/integration:src/greeting.mjs"]))).toContain("hello installed");
    expect(JSON.parse(readFileSync(writerObservation, "utf8"))).toEqual({
      brief: expect.stringContaining("Update the exact greeting"),
      home: openCodeHome,
      ambient: null,
    });
    expect(JSON.parse(readFileSync(probeObservation, "utf8"))).toEqual({ home: openCodeHome, ambient: null });
    const failed = await new InstalledMilestoneRunner({
      journal: sqlite,
      sink,
      broker: new OpenRouterModelBroker(
        { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 5_000 },
        { KEY: "failure-secret" },
        async () => new Response(null, { status: 500 }),
      ),
      readOnlyCapsule: capsule,
    }).run({
      milestoneId: "installed-provider-failure", goal: "Provider failure", file: "src/greeting.mjs",
      tracePath: trace, project, models, security, openCodeExecutable: executable, openCodeHome,
      signal: AbortSignal.timeout(20_000),
    });
    expect(failed).toMatchObject({ lifecycle: "terminal", terminalOutcome: "failed" });
    expect(failed.result).toMatchObject({ outcome: "failed", trace: { path: trace } });

    const pausedModels = {
      models: models.models.map((candidate) => candidate.id === "planner"
        ? { ...candidate, contextTokens: 100 }
        : candidate),
    };
    const paused = await new InstalledMilestoneRunner({ journal: sqlite, sink, broker, readOnlyCapsule: capsule }).run({
      milestoneId: "installed-authority-pause", goal: "Pause without invented failure", file: "src/greeting.mjs",
      tracePath: trace, project, models: pausedModels, security, openCodeExecutable: executable, openCodeHome,
      signal: AbortSignal.timeout(20_000),
    });
    expect(paused).toMatchObject({ lifecycle: "ready", terminalOutcome: null, attention: null });
    expect(sqlite.readStream("installed-authority-pause").map((event) => event.type)).not.toContain("milestone.paused");
    sink.close();
    sqlite.close();
    const retained = Buffer.concat([readFileSync(database), readFileSync(trace)]).toString("utf8");
    expect(retained).not.toContain("consumer-controlled-secret");
  }, 30_000);
});

function model(id: string, role: "planner" | "implementer" | "reviewer", tools: string[]) {
  return {
    id, harness: "opencode", model: `fixture/${id}`, roles: [role], specialties: [], costTier: "low",
    contextTokens: 128_000, maxConcurrency: 1, toolPermissions: tools, network: "denied",
    fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 },
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
