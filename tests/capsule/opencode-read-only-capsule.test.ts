import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import https from "node:https";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DockerOpenCodeReadOnlyCapsule, assertResearchCitations, parseOpenCodeFinalAssistantText } from "../../src/capsule/opencode-read-only-capsule.js";
import { DockerBrokerTransportUncertainError, type DockerClient } from "../../src/capsule/docker-client.js";
import type { ModelBroker } from "../../src/capsule/model-broker.js";
import type { ModelBrokerReceipt } from "../../src/capsule/model-broker.js";
import type { OpenCodeReadOnlyCapsuleRequest } from "../../src/agents/opencode-read-only-agent.js";
import { openCodeResourceIdentity } from "../../src/agents/opencode-resource-identity.js";
import { GovernedWebResearch, WebResearchPolicySchema, webResearchTerminalResult } from "../../src/research/web-research.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { storedEventToAgentTailEvent } from "../../src/observability/agent-tail.js";
import { azureOpenAIModelBrokerForTest } from "../../src/providers/azure-openai-model-broker.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DockerOpenCodeReadOnlyCapsule", () => {
  it("physically mounts the repository read-only and routes bounded turns through ModelBroker", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-project-")));
    roots.push(repository);
    const imageId = `sha256:${"a".repeat(64)}`;
    const containerId = "b".repeat(64);
    let imagePresent = true;
    let containerPresent = true;
    let transportUncertain = false;
    let modelTurnCount = 1;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "build") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "image" && args[1] === "inspect") {
        if (!imagePresent) return { exitCode: 1, stdout: "", stderr: "No such image" };
        return { exitCode: 0, stdout: JSON.stringify([{ Id: imageId, RepoTags: ["zentra-opencode-readonly:test"], Architecture: "arm64", Os: "linux", Config: { Labels: { "org.zentra.node-base-digest": "sha256:b30c143a092c7dced8e17ad67a8783c03234d4844ee84c39090c9780491aaf89", "org.zentra.capsule-id": "milestone.task" } } }]), stderr: "" };
      }
      if (args[0] === "create") return { exitCode: 0, stdout: `${containerId}\n`, stderr: "" };
      if (args[0] === "start") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "exec" && args.at(-1) === "--version") return { exitCode: 0, stdout: "1.18.3\n", stderr: "" };
      if (args[0] === "exec" && args.includes("/usr/bin/sha256sum")) return { exitCode: 0, stdout: "915ca1cd9eb5a7b3e15bd89dc71c38cf0caa9a02d13c5371422675b4b370bffb  /usr/local/bin/opencode\n", stderr: "" };
      if (args[0] === "image" && args[1] === "rm") { imagePresent = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (args[0] === "rm" && args[1] === "--force") { containerPresent = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (args[0] === "inspect") return containerPresent
        ? { exitCode: 0, stdout: JSON.stringify([{ Id: containerId, Name: "/zentra-opencode-readonly-test", Config: { Labels: { "org.zentra.capsule-id": "milestone.task" } } }]), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "No such container" };
      throw new Error(`unexpected Docker operation: ${args.join(" ")}`);
    });
    const runBrokered = vi.fn(async (
      args: readonly string[],
      _signal: AbortSignal,
      _timeoutMs: number,
      exchange: (request: unknown, signal: AbortSignal) => Promise<unknown>,
    ) => {
      if (transportUncertain) throw new DockerBrokerTransportUncertainError();
      expect(args).toEqual(["exec", "--interactive", containerId, "/usr/local/bin/node", "/runner/runner.mjs"]);
      expect(args.join(" ")).not.toContain(process.env.HOME ?? "host-home-never-present");
      let response: { receipt: { response: { type: "text"; text: string } } } | undefined;
      for (let index = 0; index < modelTurnCount; index += 1) {
        response = await exchange({
          type: "model_turn",
          requestId: `turn-${index + 1}`,
          prompt: "system: Plan safely.\nuser: Inspect contracts.",
        }, new AbortController().signal) as { receipt: { response: { type: "text"; text: string } } };
      }
      const openCodeOutput = [
        JSON.stringify({ type: "text", part: { type: "text", text: response!.receipt.response.text } }),
        JSON.stringify({ type: "step_finish" }),
      ].join("\n");
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ type: "opencode_result", exitCode: 0, stdout: openCodeOutput, stderr: "" })}\n`,
        stderr: "",
      };
    });
    const docker = {
      executable: "/Applications/Docker.app/Contents/Resources/bin/docker",
      run,
      runBrokered,
    } as unknown as DockerClient;
    const broker: ModelBroker = {
      execute: vi.fn(async (request): Promise<ModelBrokerReceipt> => ({
        outcome: "completed",
        response: { type: "text", text: `Plan from ${request.modelId}` },
        model: { id: request.modelId, provider: "fixture", name: "planner" },
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      })),
    };

    const observations: unknown[] = [];
    const result = await new DockerOpenCodeReadOnlyCapsule(docker).execute(
      request(repository), broker, new AbortController().signal, (observation) => observations.push(observation),
    );

    expect(result).toMatchObject({
      outcome: "completed",
      model: { id: "fixture/planner", provider: "fixture", name: "planner" },
      evidence: [{ kind: "plan", summary: "Plan from fixture/planner" }],
      cleanup: "completed",
    });
    expect(broker.execute).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "fixture/planner",
      maxInputTokens: 100,
      maxOutputTokens: 50,
      maxCostUsd: 1,
    }), expect.any(AbortSignal));
    expect(run).toHaveBeenCalledWith(expect.arrayContaining([
      "create", "--label", "org.zentra.capsule-id=milestone.task", "--network", "none", "--read-only",
      "--mount", `type=bind,src=${repository},dst=/project,readonly`,
    ]), expect.any(AbortSignal));
    expect(run).toHaveBeenCalledWith(["inspect", containerId], expect.any(AbortSignal), 30_000);
    expect(run).toHaveBeenCalledWith(["image", "inspect", imageId], expect.any(AbortSignal), 30_000);
    expect(observations).toEqual([
      expect.objectContaining({ type: "resources_prepared", payload: expect.objectContaining({ containerId, imageId, repositoryViewPath: repository }) }),
      { type: "model_started", modelId: "fixture/planner" },
      {
        type: "model_completed", modelId: "fixture/planner", outcome: "completed", failureReason: null,
        usage: { seconds: 0, inputTokens: 10, outputTokens: 5, costUsd: 0.01, costUsdNano: 10_000_000, toolCalls: 0, modelTurns: 1 },
      },
      expect.objectContaining({ type: "cleanup_observed", payload: expect.objectContaining({ outcome: "completed", containerAbsent: true, imageAbsent: true }) }),
    ]);

    imagePresent = true;
    containerPresent = true;
    modelTurnCount = 2;
    let measuredTurn = 0;
    const exactBroker: ModelBroker = { execute: async (modelRequest) => {
      const costUsdNano = measuredTurn++ === 0 ? 100_000_000 : 200_000_000;
      return { outcome: "completed", response: { type: "text", text: "exact" },
        model: { id: modelRequest.modelId, provider: "fixture", name: "planner" },
        usage: { inputTokens: 1, outputTokens: 1, costUsd: costUsdNano / 1_000_000_000, costUsdNano } };
    } };
    const exact = await new DockerOpenCodeReadOnlyCapsule(docker).execute({
      ...request(repository), budget: { maxSeconds: 30, maxCostUsd: 0.3, maxInputTokens: 100, maxOutputTokens: 50 },
    }, exactBroker, new AbortController().signal);
    expect(exact).toMatchObject({ outcome: "completed", usage: { costUsd: 0.3, costUsdNano: 300_000_000, modelTurns: 2 } });

    imagePresent = true;
    containerPresent = true;
    measuredTurn = 0;
    const excessiveBroker: ModelBroker = { execute: async (modelRequest) => {
      const attempt = measuredTurn++;
      const costUsdNano = attempt === 0 ? 100_000_000 : 200_000_001;
      return { outcome: "completed", response: { type: "text", text: "excess" },
        model: { id: attempt === 0 ? modelRequest.modelId : "substituted/model", provider: "fixture", name: "planner" },
        usage: { inputTokens: 1, outputTokens: 1, costUsd: costUsdNano / 1_000_000_000, costUsdNano } };
    } };
    const excessiveObservations: any[] = [];
    const excessive = await new DockerOpenCodeReadOnlyCapsule(docker).execute({
      ...request(repository), budget: { maxSeconds: 30, maxCostUsd: 0.3, maxInputTokens: 100, maxOutputTokens: 50 },
    }, excessiveBroker, new AbortController().signal, (observation) => excessiveObservations.push(observation));
    expect(excessive).toMatchObject({ outcome: "failed", cleanup: "completed",
      brokerFailureReason: "cost_budget_exceeded", usage: { costUsdNano: 300_000_001 } });
    expect(excessiveObservations.filter((observation) => observation.type === "model_started")).toHaveLength(2);
    expect(excessiveObservations.filter((observation) => observation.type === "model_completed")).toHaveLength(2);
    expect(excessiveObservations.findLast((observation) => observation.type === "model_completed")).toMatchObject({
      outcome: "failed", failureReason: "cost_budget_exceeded",
      usage: { costUsdNano: 200_000_001, modelTurns: 1 },
    });
    expect(excessiveObservations.at(-1)).toMatchObject({ type: "cleanup_observed", payload: { outcome: "completed" } });
    modelTurnCount = 1;

    imagePresent = true;
    containerPresent = true;
    const tokenPrecedenceObservations: any[] = [];
    const tokenPrecedence = await new DockerOpenCodeReadOnlyCapsule(docker).execute(
      request(repository),
      { execute: async () => ({ outcome: "completed", response: { type: "text", text: "token overrun" },
        model: { id: "substituted/model", provider: "fixture", name: "substituted" },
        usage: { inputTokens: 101, outputTokens: 1, costUsd: 0 } }) },
      new AbortController().signal,
      (observation) => tokenPrecedenceObservations.push(observation),
    );
    expect(tokenPrecedence).toMatchObject({ outcome: "failed", cleanup: "completed",
      brokerFailureReason: "token_budget_exceeded", usage: { inputTokens: 101 } });
    expect(tokenPrecedenceObservations.filter((observation) => observation.type === "model_completed")).toEqual([
      expect.objectContaining({ outcome: "failed", failureReason: "token_budget_exceeded",
        usage: expect.objectContaining({ inputTokens: 101, modelTurns: 1 }) }),
    ]);

    imagePresent = true;
    containerPresent = true;
    const modelTurnPrecedenceObservations: any[] = [];
    const modelTurnBroker = vi.fn(async (modelRequest) => ({
      outcome: "completed" as const, response: { type: "text" as const, text: "turn" },
      model: { id: modelRequest.modelId, provider: "fixture", name: "planner" },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    }));
    runBrokered.mockImplementationOnce(async (_args, _signal, _timeout, exchange) => {
      for (let index = 0; index < 31; index += 1) {
        const response = await exchange({ type: "model_turn", requestId: `turn-${index + 1}`, prompt: "turn" }, new AbortController().signal) as any;
        expect(response.receipt.outcome).toBe("completed");
      }
      const [lastSlot, denied] = await Promise.all([
        exchange({ type: "model_turn", requestId: "turn-32", prompt: "last slot" }, new AbortController().signal),
        exchange({ type: "model_turn", requestId: "turn-33", prompt: "must be denied" }, new AbortController().signal),
      ]) as any[];
      expect(lastSlot.receipt.outcome).toBe("completed");
      expect(denied.receipt).toMatchObject({ outcome: "failed", failureReason: "model_turn_budget_exceeded" });
      throw new Error("OpenCode stopped after fixed model-turn denial");
    });
    const modelTurnPrecedence = await new DockerOpenCodeReadOnlyCapsule(docker).execute(
      request(repository),
      { execute: modelTurnBroker },
      new AbortController().signal,
      (observation) => modelTurnPrecedenceObservations.push(observation),
    );
    expect(modelTurnPrecedence).toMatchObject({ outcome: "failed", cleanup: "completed",
      brokerFailureReason: "model_turn_budget_exceeded", usage: { modelTurns: 32 } });
    expect(modelTurnBroker).toHaveBeenCalledTimes(32);
    expect(modelTurnPrecedenceObservations.filter((observation) => observation.type === "model_started")).toHaveLength(32);
    expect(modelTurnPrecedenceObservations.filter((observation) => observation.type === "model_completed")).toHaveLength(32);
    expect(modelTurnPrecedenceObservations.findLast((observation) => observation.type === "model_completed"))
      .toMatchObject({ outcome: "completed", usage: expect.objectContaining({ modelTurns: 1 }) });

    imagePresent = true;
    containerPresent = true;
    const substitutedObservations: any[] = [];
    const substituted = await new DockerOpenCodeReadOnlyCapsule(docker).execute(
      request(repository),
      { execute: async () => ({ outcome: "completed", response: { type: "text", text: "substituted" },
        model: { id: "substituted/model", provider: "fixture", name: "substituted", configurationDigest: "d".repeat(64) },
        usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.01 } }) },
      new AbortController().signal,
      (observation) => substitutedObservations.push(observation),
    );
    expect(substituted).toMatchObject({ outcome: "failed", cleanup: "completed",
      brokerFailureReason: "provider_model_mismatch", usage: { inputTokens: 3, outputTokens: 2, costUsdNano: 10_000_000 } });
    expect(substitutedObservations.filter((observation) => observation.type === "model_started")).toHaveLength(1);
    expect(substitutedObservations.filter((observation) => observation.type === "model_completed")).toEqual([
      expect.objectContaining({ outcome: "failed", failureReason: "provider_model_mismatch",
        usage: expect.objectContaining({ inputTokens: 3, outputTokens: 2, costUsdNano: 10_000_000, modelTurns: 1 }) }),
    ]);
    expect(substitutedObservations.at(-1)).toMatchObject({ type: "cleanup_observed", payload: { outcome: "completed" } });

    imagePresent = true;
    containerPresent = true;
    let completionAttempts = 0;
    const acceptedCompletions: any[] = [];
    const observerFailure = await new DockerOpenCodeReadOnlyCapsule(docker).execute(
      request(repository), broker, new AbortController().signal,
      (observation) => {
        if (observation.type === "model_completed") {
          completionAttempts += 1;
          if (completionAttempts === 1) throw new Error("observer append failed before acceptance");
          acceptedCompletions.push(observation);
        }
      },
    );
    expect(observerFailure).toMatchObject({ outcome: "failed", cleanup: "completed" });
    expect(completionAttempts).toBe(2);
    expect(acceptedCompletions).toEqual([expect.objectContaining({ outcome: "completed" })]);

    for (const brokerOutcome of ["cancelled", "timed_out", "uncertain"] as const) {
      imagePresent = true;
      containerPresent = true;
      const mapped = await new DockerOpenCodeReadOnlyCapsule(docker).execute(
        request(repository),
        { execute: async () => ({ outcome: brokerOutcome,
          failureReason: brokerOutcome === "cancelled" ? "request_cancelled" as const :
            brokerOutcome === "timed_out" ? "request_timed_out_before_dispatch" as const : "transport_uncertain_after_dispatch" as const,
          response: null, model: null, usage: null }) },
        new AbortController().signal,
      );
      expect(mapped).toMatchObject({
        outcome: brokerOutcome === "uncertain" ? "failed" : brokerOutcome,
        brokerTransport: brokerOutcome === "uncertain" ? "uncertain" : "completed",
        brokerFailureReason: brokerOutcome === "cancelled" ? "request_cancelled" :
          brokerOutcome === "timed_out" ? "request_timed_out_before_dispatch" : "transport_uncertain_after_dispatch",
        cleanup: "completed",
      });
    }
    imagePresent = true;
    containerPresent = true;
    const toolFailureObservations: any[] = [];
    const toolFailure = await new DockerOpenCodeReadOnlyCapsule(docker).execute(
      request(repository),
      { execute: async () => ({ outcome: "failed", failureReason: "tool_call_arguments_schema_invalid",
        failureTool: "read", response: null, model: null, usage: null }) },
      new AbortController().signal,
      (observation) => toolFailureObservations.push(observation),
    );
    expect(toolFailure).toMatchObject({
      outcome: "failed", brokerFailureReason: "tool_call_arguments_schema_invalid", brokerFailureTool: "read",
    });
    expect(toolFailureObservations.find((observation) => observation.type === "model_completed")).toMatchObject({
      failureReason: "tool_call_arguments_schema_invalid", failureTool: "read",
    });
    imagePresent = true;
    containerPresent = true;
    transportUncertain = true;
    expect(await new DockerOpenCodeReadOnlyCapsule(docker).execute(
      request(repository), broker, new AbortController().signal,
    )).toMatchObject({ outcome: "failed", brokerTransport: "uncertain" });

    transportUncertain = false;
    imagePresent = true;
    containerPresent = true;
    const ambiguousObservations: any[] = [];
    runBrokered.mockImplementationOnce(async (_args, _signal, _timeout, exchange) => {
      void exchange({ type: "model_turn", requestId: "ambiguous-turn", prompt: "ambiguous" }, new AbortController().signal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new DockerBrokerTransportUncertainError();
    });
    const ambiguous = await new DockerOpenCodeReadOnlyCapsule(docker).execute(
      request(repository),
      { execute: async () => new Promise<ModelBrokerReceipt>(() => {}) },
      new AbortController().signal,
      (observation) => ambiguousObservations.push(observation),
    );
    expect(ambiguous).toMatchObject({ outcome: "failed", brokerTransport: "uncertain",
      brokerFailureReason: "transport_uncertain_after_dispatch", cleanup: "completed" });
    expect(ambiguousObservations.filter((observation) => observation.type === "model_started")).toHaveLength(1);
    expect(ambiguousObservations.filter((observation) => observation.type === "model_completed")).toEqual([
      expect.objectContaining({ outcome: "uncertain", failureReason: "transport_uncertain_after_dispatch",
        usage: expect.objectContaining({ modelTurns: 0 }) }),
    ]);
    expect(ambiguousObservations.at(-1)).toMatchObject({ type: "cleanup_observed", payload: { outcome: "completed" } });

    imagePresent = true;
    containerPresent = true;
    const researchPolicy = WebResearchPolicySchema.parse({
      schemaVersion: 1, destinations: [{ origin: "https://docs.example.com", pathPrefix: "/" }],
      contentTypes: ["text/plain"], maxRedirects: 1, maxCompressedBytes: 1_024, maxDecompressedBytes: 1_024,
      timeoutMs: 1_000, budget: { maxRequests: 1, maxBytes: 1_024, maxTimeMs: 1_000 },
    });
    const researchJournal = new SqliteEventJournal(":memory:");
    const research = new GovernedWebResearch(researchJournal, { dispatch: async () => ({
      status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("governed source fact"),
      compressedBytes: 20, decompressedBytes: 20, resolvedAddress: "93.184.216.34", tls: true, dispatched: true,
    }) });
    runBrokered.mockImplementationOnce(async (_args, _signal, _timeout, exchange) => {
      const researchReceipt = await exchange({ type: "research_request", requestId: "source-1", method: "GET", url: "https://docs.example.com/fact?secret=redacted" }, new AbortController().signal) as any;
      await exchange({ type: "model_turn", requestId: "turn-research", prompt: "source result" }, new AbortController().signal);
      const citation = `[source:${researchReceipt.result.evidence.evidenceId}]`;
      const output = [JSON.stringify({ type: "text", part: { type: "text", text: `Finding ${citation}` } }), JSON.stringify({ type: "step_finish" })].join("\n");
      return { exitCode: 0, stdout: `${JSON.stringify({ type: "opencode_result", exitCode: 0, stdout: output, stderr: "" })}\n`, stderr: "" };
    });
    const governed = await new DockerOpenCodeReadOnlyCapsule(docker).execute({
      ...request(repository), role: "researcher", webResearch: researchPolicy,
      webResearchEnvelopeDigest: "a".repeat(64), securityBoundary: { ...request(repository).securityBoundary, network: "brokered_web_research" },
    }, broker, new AbortController().signal, undefined, research);
    expect(governed).toMatchObject({
      outcome: "completed",
      evidence: [{ kind: "research", summary: expect.stringContaining("[source:"), sourceEvidenceIds: [expect.stringMatching(/^[a-f0-9]{64}$/)] }],
    });
    expect(JSON.stringify(researchJournal.readAll())).not.toContain("governed source fact");
    expect(JSON.stringify(researchJournal.readAll())).not.toContain("secret=redacted");
    researchJournal.close();

    imagePresent = true;
    containerPresent = true;
    const requiredUrl = "https://docs.example.com/fact";
    const requiredPolicy = WebResearchPolicySchema.parse({
      schemaVersion: 1,
      destinations: [{ origin: "https://docs.example.com", pathPrefix: "/fact" }],
      requiredRequest: { method: "GET", url: requiredUrl, maxRequests: 1 },
      contentTypes: ["text/plain"], maxRedirects: 0, maxCompressedBytes: 1_024, maxDecompressedBytes: 1_024,
      timeoutMs: 1_000, budget: { maxRequests: 1, maxBytes: 1_024, maxTimeMs: 1_000 },
    });
    const requiredJournal = new SqliteEventJournal(":memory:");
    const requiredDispatch = vi.fn(async () => ({
      status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("single governed source"),
      compressedBytes: 22, decompressedBytes: 22, resolvedAddress: "93.184.216.34", tls: true, dispatched: true,
    }));
    const requiredResearch = new GovernedWebResearch(requiredJournal, { dispatch: requiredDispatch });
    const repeatedObservations: any[] = [];
    vi.mocked(broker.execute).mockClear();
    runBrokered.mockImplementationOnce(async (_args, _signal, _timeout, exchange) => {
      await exchange({ type: "model_turn", requestId: "required-turn-1", prompt: "request source" }, new AbortController().signal);
      const first = await exchange({ type: "research_request", requestId: "required-source-1", method: "GET", url: requiredUrl }, new AbortController().signal) as any;
      const repeated = await exchange({ type: "research_request", requestId: "required-source-2", method: "GET", url: requiredUrl }, new AbortController().signal) as any;
      expect(repeated.result.evidence.evidenceId).toBe(first.result.evidence.evidenceId);
      await exchange({ type: "model_turn", requestId: "required-turn-2", prompt: "write cited final" }, new AbortController().signal);
      const citation = `[source:${first.result.evidence.evidenceId}]`;
      const output = [JSON.stringify({ type: "text", part: { type: "text", text: `Final ${citation}` } }), JSON.stringify({ type: "step_finish" })].join("\n");
      return { exitCode: 0, stdout: `${JSON.stringify({ type: "opencode_result", exitCode: 0, stdout: output, stderr: "" })}\n`, stderr: "" };
    });
    const repeatedResult = await new DockerOpenCodeReadOnlyCapsule(docker).execute({
      ...request(repository), role: "researcher", webResearch: requiredPolicy,
      webResearchEnvelopeDigest: "a".repeat(64), securityBoundary: { ...request(repository).securityBoundary, network: "brokered_web_research" },
    }, broker, new AbortController().signal, (observation) => repeatedObservations.push(observation), requiredResearch);
    expect(repeatedResult).toMatchObject({ outcome: "completed", evidence: [{
      kind: "research", summary: expect.stringMatching(/\[source:[a-f0-9]{64}\]/),
      sourceEvidenceIds: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    }] });
    expect(requiredDispatch).toHaveBeenCalledTimes(1);
    expect(requiredJournal.readStream("web-research:task-1")).toHaveLength(1);
    expect(repeatedObservations.filter((observation) => observation.type === "research_started")).toHaveLength(1);
    expect(repeatedObservations.filter((observation) => observation.type === "research_completed")).toHaveLength(1);
    const brokerRequests = vi.mocked(broker.execute).mock.calls.map(([modelRequest]) => modelRequest);
    expect(brokerRequests).toHaveLength(2);
    expect(brokerRequests[0]?.allowedTools).toContain("zentra_research_web_research");
    expect(brokerRequests[1]?.allowedTools).not.toContain("zentra_research_web_research");
    requiredJournal.close();

    for (const mode of ["attention", "thrown"] as const) {
      imagePresent = true;
      containerPresent = true;
      const observed: any[] = [];
      runBrokered.mockImplementationOnce(async (_args, _signal, _timeout, exchange) => {
        await exchange({ type: "research_request", requestId: `${mode}-1`, method: "GET", url: "https://outside.example/" }, new AbortController().signal);
        throw new Error("broker process stopped after research completion");
      });
      const result = await new DockerOpenCodeReadOnlyCapsule(docker).execute({
        ...request(repository), role: "researcher", webResearch: researchPolicy,
        webResearchEnvelopeDigest: "a".repeat(64), securityBoundary: { ...request(repository).securityBoundary, network: "brokered_web_research" },
      }, broker, new AbortController().signal, (observation) => observed.push(observation), {
        execute: async (raw) => {
          if (mode === "thrown") throw new Error("research execution threw");
          return webResearchTerminalResult(raw, "denied", "capability_attention");
        },
      });
      expect(result).toMatchObject({ outcome: "failed", cleanup: "completed" });
      expect(observed.filter((item) => item.type.startsWith("research_"))).toEqual([
        { type: "research_started", requestId: `${mode}-1` },
        expect.objectContaining({ type: "research_completed", requestId: `${mode}-1`, result: expect.objectContaining({
          outcome: mode === "attention" ? "denied" : "failed", reason: mode === "attention" ? "capability_attention" : "execution_threw",
        }) }),
      ]);
      expect(observed.at(-1)).toMatchObject({ type: "cleanup_observed", payload: { outcome: "completed" } });
    }
  });

  it("does not fabricate harness metadata when image build fails before attestation", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-pre-attest-")));
    roots.push(repository);
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "build") return { exitCode: 1, stdout: "", stderr: "build failed" };
      if (args[0] === "rm" || (args[0] === "image" && args[1] === "rm")) return { exitCode: 1, stdout: "", stderr: "No such object" };
      if (args[0] === "inspect" || (args[0] === "image" && args[1] === "inspect")) return { exitCode: 1, stdout: "", stderr: "No such object" };
      throw new Error(`unexpected Docker operation: ${args.join(" ")}`);
    });
    const docker = { run, runBrokered: vi.fn() } as unknown as DockerClient;

    const result = await new DockerOpenCodeReadOnlyCapsule(docker).execute(
      request(repository),
      { execute: vi.fn() },
      new AbortController().signal,
    );

    expect(result).toMatchObject({ outcome: "failed", openCode: null, model: null, cleanup: "completed" });
  });

  it("preserves deterministic-name container and image collisions without the capsule label", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-collision-")));
    roots.push(repository);
    const requested = request(repository);
    const foreignContainerId = "e".repeat(64);
    const foreignImageId = `sha256:${"f".repeat(64)}`;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "build") return { exitCode: 1, stdout: "", stderr: "build failed" };
      if (args[0] === "inspect" && args[1] === requested.resources.containerName) {
        return { exitCode: 0, stdout: JSON.stringify([{ Id: foreignContainerId, Name: `/${requested.resources.containerName}`, Config: { Labels: { "org.zentra.capsule-id": "foreign" } } }]), stderr: "" };
      }
      if (args[0] === "image" && args[1] === "inspect" && args[2] === requested.resources.imageName) {
        return { exitCode: 0, stdout: JSON.stringify([{ Id: foreignImageId, RepoTags: [requested.resources.imageName], Config: { Labels: { "org.zentra.capsule-id": "foreign" } } }]), stderr: "" };
      }
      throw new Error(`unsafe removal attempted: ${args.join(" ")}`);
    });

    const result = await new DockerOpenCodeReadOnlyCapsule({ run } as unknown as DockerClient).execute(
      requested, { execute: vi.fn() }, new AbortController().signal,
    );

    expect(result).toMatchObject({ outcome: "failed", cleanup: "uncertain" });
    expect(run.mock.calls.some(([args]) => (args as readonly string[])[0] === "rm")).toBe(false);
    expect(run.mock.calls.some(([args]) => (args as readonly string[])[0] === "image" && (args as readonly string[])[1] === "rm")).toBe(false);
  });

  it("idempotently reconciles prepared resources by label and exact identities", async () => {
    const identity = openCodeResourceIdentity("reconcile", "task", 1);
    mkdirSync(identity.repositoryViewPath);
    const view = realpathSync.native(identity.repositoryViewPath);
    roots.push(view);
    const containerId = "c".repeat(64);
    const imageId = `sha256:${"d".repeat(64)}`;
    let containerPresent = true;
    let imagePresent = true;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "container" && args[1] === "ls") return { exitCode: 0, stdout: containerPresent ? `${containerId}\n` : "", stderr: "" };
      if (args[0] === "image" && args[1] === "ls") return { exitCode: 0, stdout: imagePresent ? `${imageId}\n` : "", stderr: "" };
      if (args[0] === "rm") { containerPresent = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (args[0] === "image" && args[1] === "rm") { imagePresent = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (args[0] === "inspect") return containerPresent
        ? { exitCode: 0, stdout: JSON.stringify([{ Id: containerId, Name: `/${identity.containerName}`, Config: { Labels: { "org.zentra.capsule-id": identity.capsuleId } } }]), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "No such container" };
      if (args[0] === "image" && args[1] === "inspect") return imagePresent
        ? { exitCode: 0, stdout: JSON.stringify([{ Id: imageId, RepoTags: [identity.imageName], Config: { Labels: { "org.zentra.capsule-id": identity.capsuleId } } }]), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "No such image" };
      throw new Error(`unexpected Docker operation: ${args.join(" ")}`);
    });
    const capsule = new DockerOpenCodeReadOnlyCapsule({ run } as unknown as DockerClient);
    const prepared = { ...identity, containerId, imageId, repositoryViewPath: view, repositoryRevision: "a".repeat(64) };

    expect(await capsule.reconcile(prepared)).toEqual({
      outcome: "completed", containerId, imageId, containerAbsent: true, imageAbsent: true, repositoryViewAbsent: true,
    });
    expect(await capsule.reconcile(prepared)).toEqual({
      outcome: "completed", containerId, imageId, containerAbsent: true, imageAbsent: true, repositoryViewAbsent: true,
    });
  });

  it("fails reconciliation closed on deterministic-name resources with a foreign label", async () => {
    const identity = openCodeResourceIdentity("collision", "task", 1);
    mkdirSync(identity.repositoryViewPath);
    roots.push(identity.repositoryViewPath);
    const run = vi.fn(async (args: readonly string[]) => {
      if ((args[0] === "container" || args[0] === "image") && args[1] === "ls") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "inspect") return { exitCode: 0, stdout: JSON.stringify([{ Id: "a".repeat(64), Name: `/${identity.containerName}`, Config: { Labels: { "org.zentra.capsule-id": "foreign" } } }]), stderr: "" };
      if (args[0] === "image" && args[1] === "inspect") return { exitCode: 0, stdout: JSON.stringify([{ Id: `sha256:${"b".repeat(64)}`, RepoTags: [identity.imageName], Config: { Labels: { "org.zentra.capsule-id": "foreign" } } }]), stderr: "" };
      throw new Error(`unsafe removal attempted: ${args.join(" ")}`);
    });
    const result = await new DockerOpenCodeReadOnlyCapsule({ run } as unknown as DockerClient).reconcile({
      ...identity, containerId: null, imageId: null, repositoryRevision: null,
    });

    expect(result).toMatchObject({ outcome: "uncertain", containerAbsent: false, imageAbsent: false });
    expect(run.mock.calls.some(([args]) => (args as readonly string[])[0] === "rm")).toBe(false);
    expect(run.mock.calls.some(([args]) => (args as readonly string[])[0] === "image" && (args as readonly string[])[1] === "rm")).toBe(false);
  });

  it.each(["container", "image"] as const)("preserves a stale prepared %s ID whose current identity is corrupted", async (kind) => {
    const identity = openCodeResourceIdentity(`stale-${kind}`, "task", 1);
    mkdirSync(identity.repositoryViewPath);
    roots.push(identity.repositoryViewPath);
    const containerId = "6".repeat(64);
    const imageId = `sha256:${"7".repeat(64)}`;
    const run = vi.fn(async (args: readonly string[]) => {
      if ((args[0] === "container" || args[0] === "image") && args[1] === "ls") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "inspect" && args[1] === containerId && kind === "container") {
        return { exitCode: 0, stdout: JSON.stringify([{ Id: containerId, Name: `/${identity.containerName}`, Config: { Labels: { "org.zentra.capsule-id": "corrupted" } } }]), stderr: "" };
      }
      if (args[0] === "image" && args[1] === "inspect" && args[2] === imageId && kind === "image") {
        return { exitCode: 0, stdout: JSON.stringify([{ Id: imageId, RepoTags: [identity.imageName], Config: { Labels: { "org.zentra.capsule-id": "corrupted" } } }]), stderr: "" };
      }
      if (args[0] === "inspect" || (args[0] === "image" && args[1] === "inspect")) {
        return { exitCode: 1, stdout: "", stderr: "No such object" };
      }
      throw new Error(`stale resource removal attempted: ${args.join(" ")}`);
    });
    const result = await new DockerOpenCodeReadOnlyCapsule({ run } as unknown as DockerClient).reconcile({
      ...identity,
      containerId: kind === "container" ? containerId : null,
      imageId: kind === "image" ? imageId : null,
      repositoryRevision: "a".repeat(64),
    });

    expect(result.outcome).toBe("uncertain");
    expect(run.mock.calls.some(([args]) => (args as readonly string[])[0] === "rm")).toBe(false);
    expect(run.mock.calls.some(([args]) => (args as readonly string[])[0] === "image" && (args as readonly string[])[1] === "rm")).toBe(false);
  });
});

describe("OpenCode final evidence parsing", () => {
  it("accepts only one text in the final naturally completed step", () => {
    const output = [
      JSON.stringify({ type: "step_start" }),
      JSON.stringify({ type: "step_finish" }),
      JSON.stringify({ type: "step_start" }),
      JSON.stringify({ type: "text", part: { type: "text", text: "final evidence" } }),
      JSON.stringify({ type: "step_finish" }),
    ].join("\n");
    expect(parseOpenCodeFinalAssistantText(output)).toBe("final evidence");
  });

  it.each([
    JSON.stringify({ type: "text", part: { type: "text", text: "partial" } }),
    [
      JSON.stringify({ type: "text", part: { type: "text", text: "one" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "two" } }),
      JSON.stringify({ type: "step_finish" }),
    ].join("\n"),
    "not-json",
  ])("rejects partial or ambiguous output", (output) => {
    expect(() => parseOpenCodeFinalAssistantText(output)).toThrow();
  });
});

describe("OpenCode research citation verification", () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  it("requires every retained source exactly once", () => {
    expect(() => assertResearchCitations(`One [source:${first}] two [source:${second}]`, [first, second], "all_exactly_once")).not.toThrow();
  });
  it.each([
    [`Only [source:${first}]`, [first, second]],
    [`Duplicate [source:${first}] [source:${first}]`, [first]],
    [`Unknown [source:${second}]`, [first]],
    ["No citation", [first]],
  ] as const)("rejects incomplete, duplicate, unknown, or absent citations", (summary, retained) => {
    expect(() => assertResearchCitations(summary, retained, "all_exactly_once")).toThrow(/retained source evidence/i);
  });
});

describe("DockerOpenCodeReadOnlyCapsule real Docker path", () => {
  it("runs the attested OpenCode executable with no network and a typed host broker", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-real-")));
    roots.push(repository);
    writeFileSync(path.join(repository, "evidence.txt"), "violet repository fact 731\n");
    let turns = 0;
    const promptEvidence: string[] = [];
    const broker = azureOpenAIModelBrokerForTest({
      provider: "azure", endpoint: "https://zentra-test.openai.azure.com", deployment: "azure-deployment",
      apiVersion: "2025-04-01-preview", credentialEnv: "KEY", timeoutMs: 30_000, maxResponseBytes: 1_048_576,
      maxInputTokens: 10_000, maxOutputTokens: 1_000, maxToolCalls: 4,
      expectedProviderModels: ["fixture-provider-model"], inputTokenRateUsdPerMillion: "0", outputTokenRateUsdPerMillion: "0",
    }, { KEY: "host-only-secret" }, async (input) => {
      turns += 1;
      const prompt = (JSON.parse(input.body) as { messages: readonly { content: string }[] }).messages[0]!.content;
      promptEvidence.push(prompt.includes("violet repository fact 731") ? "file" : prompt.slice(0, 40));
      const title = prompt.startsWith("system: You are a title generator");
      const observedFile = prompt.includes("violet repository fact 731");
      return azureTransportResponse(title
        ? { type: "text", text: "Repository evidence" }
        : observedFile
          ? { type: "text", text: "Observed violet repository fact 731" }
          : { type: "tool_calls", name: "read", arguments: JSON.stringify({ filePath: "/project/evidence.txt" }) });
    });

    const result = await new DockerOpenCodeReadOnlyCapsule().execute({
      ...request(repository),
      role: "researcher",
      transportModelId: "azure-deployment",
      securityBoundary: {
        ...request(repository).securityBoundary,
        readableScopes: ["evidence.txt"],
      },
      timeoutMs: 60_000,
      budget: { maxSeconds: 60, maxCostUsd: 1, maxInputTokens: 10_000, maxOutputTokens: 1_000 },
    }, broker, new AbortController().signal);

    expect(result).toMatchObject({
      outcome: "completed",
      model: { id: "azure-deployment", provider: "azure", name: "fixture-provider-model" },
      cleanup: "completed",
    });
    expect(turns).toBeGreaterThanOrEqual(3);
    expect(promptEvidence).toContain("file");
    expect(result.evidence).toEqual([{ kind: "research", summary: "Observed violet repository fact 731" }]);
  }, 120_000);

  it("runs governed research through the supported local MCP protocol and requires citations", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-research-")));
    roots.push(repository);
    const policy = WebResearchPolicySchema.parse({
      schemaVersion: 1, destinations: [{ origin: "https://docs.example.com", pathPrefix: "/" }],
      contentTypes: ["text/plain"], maxRedirects: 1, maxCompressedBytes: 1_024, maxDecompressedBytes: 1_024,
      timeoutMs: 10_000, budget: { maxRequests: 2, maxBytes: 2_048, maxTimeMs: 20_000 },
    });
    const journal = new SqliteEventJournal(":memory:");
    const controlled = await controlledHttpsSource(repository, "governed MCP fact 913");
    const research = new GovernedWebResearch(journal, controlled.transport);
    const prompts: string[] = [];
    const broker = azureOpenAIModelBrokerForTest({
      provider: "azure", endpoint: "https://zentra-test.openai.azure.com", deployment: "azure-deployment",
      apiVersion: "2025-04-01-preview", credentialEnv: "KEY", timeoutMs: 30_000, maxResponseBytes: 1_048_576,
      maxInputTokens: 10_000, maxOutputTokens: 1_000, maxToolCalls: 4,
      expectedProviderModels: ["fixture-provider-model"], inputTokenRateUsdPerMillion: "0", outputTokenRateUsdPerMillion: "0",
    }, { KEY: "host-only-secret" }, async (input) => {
      const prompt = (JSON.parse(input.body) as { messages: readonly { content: string }[] }).messages[0]!.content;
      prompts.push(prompt);
      const citation = /\[source:[a-f0-9]{64}\]/.exec(prompt)?.[0];
      const title = prompt.startsWith("system: You are a title generator");
      const assistant = title ? { type: "text" as const, text: "Governed research" } : citation === undefined
        ? { type: "tool_calls" as const, name: "zentra_research_web_research", arguments: JSON.stringify({ url: "https://docs.example.com/fact", method: "GET" }) }
        : { type: "text" as const, text: `Observed governed MCP fact 913 ${citation}` };
      return azureTransportResponse(assistant);
    });
    const result = await new DockerOpenCodeReadOnlyCapsule().execute({
      ...request(repository), role: "researcher", transportModelId: "azure-deployment",
      rolePrompt: "Use the governed research tool, then report the fact with its source citation.",
      webResearch: policy, webResearchEnvelopeDigest: "a".repeat(64),
      securityBoundary: { ...request(repository).securityBoundary, network: "brokered_web_research" },
      timeoutMs: 60_000, budget: { maxSeconds: 60, maxCostUsd: 1, maxInputTokens: 10_000, maxOutputTokens: 1_000 },
    }, broker, new AbortController().signal, undefined, research);

    expect(result).toMatchObject({
      outcome: "completed",
      openCode: { version: "1.18.3", executableSha256: "915ca1cd9eb5a7b3e15bd89dc71c38cf0caa9a02d13c5371422675b4b370bffb" },
      evidence: [{ kind: "research", summary: expect.stringContaining("governed MCP fact 913"), sourceEvidenceIds: [expect.stringMatching(/^[a-f0-9]{64}$/)] }],
      cleanup: "completed",
    });
    expect(controlled.requests).toBe(1);
    expect(prompts.some((prompt) => prompt.includes("governed MCP fact 913"))).toBe(true);
    const sourceEvent = journal.readStream("web-research:task-1")[0]!;
    expect(sourceEvent.payload).toMatchObject({
      outcome: "completed", identity: { taskId: "task-1", workerId: "milestone.task", role: "researcher",
        envelopeDigest: "a".repeat(64), policyDigest: policy.digest,
        trace: request(repository).trace },
      evidence: { parent: { workerId: "milestone.task", modelId: "azure-deployment", tool: "zentra_web_research" },
        provenance: { transport: "zentra_https_broker", redirectHops: 0 } },
    });
    expect(sourceEvent.correlationId).toBe("milestone-trace-1");
    expect(storedEventToAgentTailEvent(sourceEvent)).toMatchObject({
      trace_id: "milestone-trace-1",
      actor: { id: "milestone.task", role: "researcher" }, parent_span_id: "worker:milestone.task",
      operation: { name: "web_research", status: "completed" },
    });
    await controlled.close();
    journal.close();
  }, 120_000);

  it("emits a typed completion and cleans up when real MCP research requires capability attention", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-attention-")));
    roots.push(repository);
    const policy = WebResearchPolicySchema.parse({ schemaVersion: 1, destinations: [{ origin: "https://docs.example.com", pathPrefix: "/" }],
      contentTypes: ["text/plain"], maxRedirects: 1, maxCompressedBytes: 1_024, maxDecompressedBytes: 1_024,
      timeoutMs: 10_000, budget: { maxRequests: 1, maxBytes: 1_024, maxTimeMs: 10_000 } });
    let turns = 0;
    const broker: ModelBroker = { execute: async (brokerRequest) => {
      turns += 1;
      const title = brokerRequest.prompt.startsWith("system: You are a title generator");
      return { outcome: "completed", response: title ? { type: "text", text: "Research attention" }
        : { type: "tool_calls", calls: [{ id: "attention-1", name: "zentra_research_web_research", arguments: JSON.stringify({ url: "https://outside.example/", method: "GET" }) }] },
        model: { id: brokerRequest.modelId, provider: "fixture", name: "researcher" }, usage: { inputTokens: 5, outputTokens: 2, costUsd: 0 } };
    } };
    const observations: any[] = [];
    const result = await new DockerOpenCodeReadOnlyCapsule().execute({ ...request(repository), role: "researcher",
      rolePrompt: "Use the governed research tool.", webResearch: policy, webResearchEnvelopeDigest: "a".repeat(64),
      securityBoundary: { ...request(repository).securityBoundary, network: "brokered_web_research" }, timeoutMs: 60_000,
      budget: { maxSeconds: 60, maxCostUsd: 1, maxInputTokens: 10_000, maxOutputTokens: 1_000 },
    }, broker, new AbortController().signal, (observation) => observations.push(observation), {
      execute: async (raw) => webResearchTerminalResult(raw, "denied", "capability_attention"),
    });
    expect(result).toMatchObject({ outcome: "failed", cleanup: "completed" });
    expect(observations.filter((item) => item.type.startsWith("research_"))).toEqual([
      { type: "research_started", requestId: expect.any(String) },
      { type: "research_completed", requestId: expect.any(String), result: expect.objectContaining({ outcome: "denied", reason: "capability_attention" }) },
    ]);
    expect(observations.at(-1)).toMatchObject({ type: "cleanup_observed", payload: { outcome: "completed", containerAbsent: true, imageAbsent: true } });
    expect(turns).toBe(2);
  }, 120_000);
});

function request(repositoryPath: string): OpenCodeReadOnlyCapsuleRequest {
  return {
    capsuleId: "milestone.task",
    taskId: "task-1",
    repositoryPath,
    role: "planner",
    actorId: "opencode-planner",
    rolePrompt: "Plan safely.",
    capabilityId: "opencode-planner",
    transportModelId: "fixture/planner",
    trace: { traceId: "milestone-trace-1", correlationId: "milestone-trace-1" },
    resources: {
      resourceLabel: "org.zentra.capsule-id=milestone.task",
      containerName: "zentra-opencode-readonly-test",
      imageName: "zentra-opencode-readonly:test",
    },
    budget: { maxSeconds: 10, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 50 },
    timeoutMs: 5_000,
    webResearch: null,
    webResearchEnvelopeDigest: null,
    securityBoundary: {
      repository: "sanitized_read_only_bind_mount",
      scratch: "bounded_ephemeral",
      network: "model_broker_only",
      home: "ephemeral",
      credentials: "none",
      shell: "none",
      readableScopes: ["README.md"],
      forbiddenPaths: [".env"],
      repositoryRevision: "a".repeat(64),
    },
  };
}

function azureTransportResponse(assistant: { readonly type: "text"; readonly text: string } | { readonly type: "tool_calls"; readonly name: string; readonly arguments: string }) {
  const chunk = (value: object) => `data: ${JSON.stringify({ id: "chatcmpl-capsule", object: "chat.completion.chunk", created: 1, model: "fixture-provider-model", ...value })}\n\n`;
  const choice = assistant.type === "text"
    ? { index: 0, delta: { content: assistant.text }, finish_reason: "stop", logprobs: null }
    : { index: 0, delta: { tool_calls: [{ index: 0, id: "research-1", type: "function", function: { name: assistant.name, arguments: assistant.arguments } }] }, finish_reason: "tool_calls", logprobs: null };
  const body = Buffer.from(chunk({ choices: [choice] }) + chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) + "data: [DONE]\n\n");
  return { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, body, dispatched: true as const };
}

async function controlledHttpsSource(root: string, content: string) {
  const key = path.join(root, "controlled.key");
  const cert = path.join(root, "controlled.crt");
  const generated = spawnSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-subj", "/CN=docs.example.com", "-days", "1"], {
    shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8",
  });
  if (generated.status !== 0) throw new Error("controlled HTTPS certificate generation failed");
  let requests = 0;
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
    requests += 1;
    response.setHeader("content-type", "text/plain");
    response.end(content);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("controlled HTTPS source did not bind");
  return {
    get requests() { return requests; },
    transport: { dispatch: (input: any) => new Promise<any>((resolve, reject) => {
      const request = https.request({ hostname: "127.0.0.1", port: address.port, path: input.url.pathname, method: input.method, rejectUnauthorized: false }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({ status: response.statusCode, headers: { "content-type": String(response.headers["content-type"]) }, body,
            compressedBytes: body.length, decompressedBytes: body.length, resolvedAddress: "93.184.216.34", tls: true, dispatched: true });
        });
      });
      request.on("error", reject);
      input.signal.addEventListener("abort", () => request.destroy(new Error("cancelled")), { once: true });
      request.end();
    }) },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
