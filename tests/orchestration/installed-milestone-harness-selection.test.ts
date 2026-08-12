import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ModelCapability } from "../../src/policy/model-sheet.js";
import type { OpenCodeReadOnlyCapsule } from "../../src/agents/opencode-read-only-agent.js";
import { azureOpenAIModelBrokerForTest } from "../../src/providers/azure-openai-model-broker.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { GovernedWebResearch, type WebResearchTransport } from "../../src/research/web-research.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
import { ProjectConfigSchema } from "../../src/projects/project-config.js";
import { GitClient } from "../../src/workspaces/git-client.js";
import { HarnessWriterRegistry, UnregisteredHarnessWriterError } from "../../src/harnesses/harness-writer-registry.js";
import type { HarnessWriter } from "../../src/harnesses/harness-writer.js";
import {
  INSTALLED_MILESTONE_RESEARCH_URL,
  InstalledMilestoneRunner,
} from "../../src/orchestration/installed-milestone.js";

const roots: string[] = [];
const git = new GitClient();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeWriter(): HarnessWriter {
  return {
    prepare: async () => ({ binding: {} as never }),
    execute: async () => ({} as never),
  };
}

describe("InstalledMilestoneRunner harness resolution", () => {
  it("only opencode is registered by default, matching today's behavior", () => {
    const registry = new HarnessWriterRegistry({ opencode: fakeWriter() });
    expect(() => registry.get("opencode")).not.toThrow();
    expect(() => registry.get("claude_code")).toThrow(UnregisteredHarnessWriterError);
    expect(() => registry.get("codex")).toThrow(UnregisteredHarnessWriterError);
  });

  it("fails run() loudly with UnregisteredHarnessWriterError instead of swallowing it into a generic incomplete milestone", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-installed-milestone-harness-")));
    roots.push(root);
    const repository = path.join(root, "repository");
    await gitOk(root, ["init", "-b", "main", repository]);
    await gitOk(repository, ["config", "user.name", "Zentra Test"]);
    await gitOk(repository, ["config", "user.email", "test@zentra.local"]);
    mkdirSync(path.join(repository, "src"));
    writeFileSync(path.join(repository, "src/greeting.mjs"), "export const greeting = 'hello';\n");
    await gitOk(repository, ["add", "--", "."]);
    await gitOk(repository, ["commit", "-m", "initial"]);

    const fakeHarness = path.join(root, "codex");
    writeFileSync(fakeHarness, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") { process.stdout.write("fixture-codex 1\\n"); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
    const executable = realpathSync.native(fakeHarness);
    const hostAttestation = {
      harnessExpectedSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      harnessExpectedVersion: "fixture-codex 1",
    };
    const harnessHome = path.join(root, "codex-home");
    mkdirSync(harnessHome);

    const database = path.join(root, "journal.sqlite");
    const trace = path.join(root, "trace.jsonl");
    const sqlite = new SqliteEventJournal(database);
    const sink = AgentTailJsonlFileSink.open(root, trace, "installed-codex-unregistered");

    const azureDispatch = async (input: { readonly body: string }) => {
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
    const researchTransport: WebResearchTransport = { dispatch: async () => ({
      status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("IANA example domains are reserved for documentation."),
      compressedBytes: 52, decompressedBytes: 52, resolvedAddress: "192.0.43.8", tls: true, dispatched: true,
    }) };
    let capsuleExecutions = 0;
    const capsule: OpenCodeReadOnlyCapsule = {
      execute: async (request, receivedBroker, signal, observe) => {
        capsuleExecutions += 1;
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
        let researchEvidence: { readonly evidenceId: string } | null = null;
        if (request.role === "researcher") {
          const requestId = `research-${capsuleExecutions}`;
          observe?.({ type: "research_started", requestId });
          const researched = await new GovernedWebResearch(sqlite, researchTransport).execute({
            schemaVersion: 1, requestId, taskId: request.taskId, workerId: request.capsuleId,
            role: request.role, modelId: request.transportModelId, tool: "zentra_web_research",
            method: "GET", url: INSTALLED_MILESTONE_RESEARCH_URL,
            envelopeDigest: request.webResearchEnvelopeDigest, policyDigest: request.webResearch!.digest,
            trace: request.trace,
          }, request.webResearch, signal);
          observe?.({ type: "research_completed", requestId, result: researched });
          researchEvidence = researched.evidence;
        }
        const summary = receipt.response?.type === "text"
          ? `${receipt.response.text}${researchEvidence === null ? "" : ` [source:${researchEvidence.evidenceId}]`}`
          : null;
        return {
          outcome: receipt.outcome === "completed" ? "completed" : "failed",
          openCode: { version: "1.18.3", executableSha256: "d".repeat(64) },
          model: receipt.model,
          evidence: summary === null ? [] : [{ kind: request.role === "reviewer" ? "review" : request.role === "researcher" ? "research" : "plan",
            summary, ...(researchEvidence === null ? {} : { sourceEvidenceIds: [researchEvidence.evidenceId] }) }],
          cleanup: "completed", brokerTransport: "completed",
        };
      },
    };

    const models = { models: [
      model("planner", "planner", ["read_repository"]),
      model("researcher", "researcher", ["read_repository", "web_research"], "declared"),
      model("implementer", "implementer", ["read_repository", "write_worktree"]),
      model("reviewer", "reviewer", ["read_repository", "review_diff"]),
    ] };
    const security = {
      allowedRepositories: [repository], allowedFileScopes: ["src/**"], forbiddenPaths: [".env", ".git/**"],
      network: { default: "denied" as const, allowedDestinations: [new URL(INSTALLED_MILESTONE_RESEARCH_URL).origin] }, secretHandling: ["No parent secrets."],
      approvalRequiredOperations: ["external_effect"], releaseBoundary: "local_preparation_only",
      stopAndAskConditions: ["missing_authority"],
    };
    const project = ProjectConfigSchema.parse({
      projectId: "project", repositoryPath: repository, worktreeRoot: path.join(root, "worktrees"),
      validations: { focused: [process.execPath, "--version"], full: [process.execPath, "--version"] },
    });

    const runner = new InstalledMilestoneRunner({ journal: sqlite, sink, broker, readOnlyCapsule: capsule });
    try {
      await expect(runner.run({
        milestoneId: "installed-codex-unregistered", goal: "Update the exact greeting", file: "src/greeting.mjs",
        tracePath: trace, project, models, security, azureDeployment: "zentra-deployment",
        harness: "codex", harnessExecutable: executable, harnessHome, ...hostAttestation,
        signal: AbortSignal.timeout(20_000),
      })).rejects.toThrow(UnregisteredHarnessWriterError);
      await expect(runner.run({
        milestoneId: "installed-codex-unregistered-2", goal: "Update the exact greeting", file: "src/greeting.mjs",
        tracePath: trace, project, models, security, azureDeployment: "zentra-deployment",
        harness: "codex", harnessExecutable: executable, harnessHome, ...hostAttestation,
        signal: AbortSignal.timeout(20_000),
      })).rejects.toThrow(/no writer is registered for harness "codex"/);
    } finally {
      sink.close();
      sqlite.close();
    }
  }, 30_000);
});

function model(
  id: string,
  role: "planner" | "researcher" | "implementer" | "reviewer",
  tools: string[],
  network: "denied" | "declared" = "denied",
): ModelCapability {
  return {
    id, harness: "opencode", model: role === "implementer" ? `fixture/${id}` : "zentra-deployment", roles: [role], specialties: [], costTier: "low",
    contextTokens: 128_000, maxConcurrency: 1, toolPermissions: tools, network,
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
