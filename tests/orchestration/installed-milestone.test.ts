import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OpenCodeReadOnlyCapsule } from "../../src/agents/opencode-read-only-agent.js";
import { azureOpenAIModelBrokerForTest } from "../../src/providers/azure-openai-model-broker.js";
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
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
writeFileSync(${JSON.stringify(writerObservation)}, JSON.stringify({ brief: packet.brief, home: process.env.HOME, ambient: process.env.ZENTRA_AMBIENT_SECRET ?? null, packet, permission: config.agent["zentra-writer"].permission }));
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
    let providerFailure = false;
    const azureDispatch = async (input: { readonly body: string }) => {
      if (providerFailure) return { status: 500, headers: { "content-type": "application/json" }, body: Buffer.from('{"error":{"code":"InternalServerError","message":"unknown"}}'), dispatched: true as const };
      const body = JSON.parse(input.body) as { messages: readonly { content: string }[] };
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
      return { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, body: azureResponse(content), dispatched: true as const };
    };
    const azureConfig = {
      provider: "azure" as const, endpoint: "https://zentra-test.openai.azure.com",
      deployment: "zentra-deployment", apiVersion: "2025-04-01-preview", credentialEnv: "KEY",
      timeoutMs: 5_000, maxResponseBytes: 1_048_576, maxInputTokens: 100_000,
      maxOutputTokens: 10_000, maxToolCalls: 4, expectedProviderModels: ["provider-model"],
      inputTokenRateUsdPerMillion: "1", outputTokenRateUsdPerMillion: "2",
    };
    const broker = azureOpenAIModelBrokerForTest(azureConfig, { KEY: "consumer-controlled-secret" }, azureDispatch);
    const capsule: OpenCodeReadOnlyCapsule = {
      execute: async (request, receivedBroker, signal, observe) => {
        observe?.({ type: "resources_prepared", payload: {
          capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
          containerName: request.resources.containerName, containerId: "b".repeat(64),
          imageName: request.resources.imageName, imageId: `sha256:${"c".repeat(64)}`,
          repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
        } });
        observe?.({ type: "model_started", modelId: request.transportModelId });
        const receipt = await receivedBroker.execute({
          modelId: request.transportModelId, prompt: request.rolePrompt,
          maxInputTokens: request.budget.maxInputTokens, maxOutputTokens: request.budget.maxOutputTokens,
          maxCostUsd: request.budget.maxCostUsd,
        }, signal);
        observe?.({ type: "model_completed", modelId: request.transportModelId,
          outcome: receipt.outcome === "completed" ? "completed" : "failed",
          usage: { seconds: 0, inputTokens: receipt.usage?.inputTokens ?? 0, outputTokens: receipt.usage?.outputTokens ?? 0,
            costUsd: receipt.usage?.costUsd ?? 0, costUsdNano: receipt.usage?.costUsdNano ?? 0, toolCalls: 0, modelTurns: 1 } });
        observe?.({ type: "cleanup_observed", payload: {
          capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
          containerName: request.resources.containerName, containerId: "b".repeat(64),
          imageName: request.resources.imageName, imageId: `sha256:${"c".repeat(64)}`,
          repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
          outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: false,
        } });
        return {
          outcome: receipt.outcome === "completed" ? "completed" : "failed",
          openCode: { version: "1.18.3", executableSha256: "d".repeat(64) },
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
    const extraToolModels = { models: models.models.map((candidate) => candidate.id === "planner"
      ? { ...candidate, toolPermissions: [...candidate.toolPermissions, "review_diff"] }
      : candidate) };
    await expect(runner.run({
      milestoneId: "installed-extra-tool", goal: "Reject extra tools", file: "src/greeting.mjs", tracePath: trace,
      project, models: extraToolModels, security, openCodeExecutable: executable, openCodeHome,
      signal: AbortSignal.timeout(20_000),
    })).rejects.toThrow("installed milestone requires exactly one approved planner capability");
    expect(sqlite.readStream("installed-extra-tool")).toEqual([]);

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
    const azureEvidence = sqlite.readAll().filter((event) => event.type === "milestone.task_completed")
      .map((event) => event.payload as any).filter((payload) => payload.model?.provider === "azure");
    expect(azureEvidence).toHaveLength(2);
    expect(azureEvidence.every((payload) => /^[a-f0-9]{64}$/.test(payload.model.configurationDigest) &&
      payload.evidence.every((item: any) => item.provenance.providerConfigurationDigest === payload.model.configurationDigest)))
      .toBe(true);
    const modelUsage = sqlite.readAll().filter((event) => event.type === "worker.observed")
      .map((event) => (event.payload as any).observation).filter((observation) => observation.kind === "model" && observation.phase === "completed");
    expect(modelUsage).toHaveLength(2);
    expect(modelUsage.every((observation) => observation.usage.costUsdNano === 60_000 && observation.usage.costUsd === 0.00006))
      .toBe(true);
    expect((await gitOutput(repository, ["show", "zentra/integration:src/greeting.mjs"]))).toContain("hello installed");
    expect(JSON.parse(readFileSync(writerObservation, "utf8"))).toEqual({
      brief: expect.stringContaining("Update the exact greeting"),
      home: openCodeHome,
      ambient: null,
      packet: expect.objectContaining({
        readPaths: ["src/**"], writePaths: ["src/greeting.mjs"],
        toolPermissions: ["read_repository", "write_worktree"],
        capabilityEnvelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      permission: expect.objectContaining({
        read: { "*": "deny", "src/**": "allow" },
        glob: { "*": "deny", "src/**": "allow" },
        grep: { "*": "deny", "src/**": "allow" },
        edit: { "*": "deny", "src/greeting.mjs": "allow" }, bash: "deny", webfetch: "deny",
      }),
    });
    expect(JSON.parse(readFileSync(probeObservation, "utf8"))).toEqual({ home: openCodeHome, ambient: null });
    providerFailure = true;
    const failed = await new InstalledMilestoneRunner({
      journal: sqlite,
      sink,
      broker: azureOpenAIModelBrokerForTest(azureConfig, { KEY: "failure-secret" }, azureDispatch),
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
    id, harness: "opencode", model: role === "implementer" ? `fixture/${id}` : "zentra-deployment", roles: [role], specialties: [], costTier: "low",
    contextTokens: 128_000, maxConcurrency: 1, toolPermissions: tools, network: "denied",
    fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 },
  };
}

function azureResponse(content: string): Buffer {
  const chunk = (value: unknown) => `data: ${JSON.stringify({
    id: "chatcmpl-installed", object: "chat.completion.chunk", created: 1,
    model: "provider-model", ...value as object,
  })}\n\n`;
  return Buffer.from(chunk({ choices: [{ index: 0, delta: { content }, finish_reason: "stop", logprobs: null }] }) +
    chunk({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }) +
    "data: [DONE]\n\n");
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
