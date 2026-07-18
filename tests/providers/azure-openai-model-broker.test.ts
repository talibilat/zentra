import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import https, { type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelBrokerReceiptSchema, type ModelBrokerRequest } from "../../src/capsule/model-broker.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import {
  AzureOpenAIModelBroker,
  AzureOpenAIProviderConfigSchema,
  azureOpenAIModelBrokerForTest,
  nodeAzureOpenAITransportForTest,
  type AzureOpenAIProviderConfig,
} from "../../src/providers/azure-openai-model-broker.js";

const config: AzureOpenAIProviderConfig = {
  provider: "azure",
  endpoint: "https://zentra-test.openai.azure.com",
  deployment: "gpt-5-mini-prod",
  apiVersion: "2025-04-01-preview",
  credentialEnv: "ZENTRA_AZURE_OPENAI_API_KEY",
  timeoutMs: 5_000,
  maxResponseBytes: 1_048_576,
  maxInputTokens: 100_000,
  maxOutputTokens: 10_000,
  maxToolCalls: 4,
  expectedProviderModels: ["gpt-5-mini-2025-01-01"],
  inputTokenRateUsdPerMillion: "1.25",
  outputTokenRateUsdPerMillion: "10",
};
const baseTools: NonNullable<ModelBrokerRequest["allowedTools"]> = ["read", "glob", "grep"];
const request: ModelBrokerRequest = {
  modelId: config.deployment,
  prompt: "Inspect the repository.",
  maxInputTokens: 100,
  maxOutputTokens: 50,
  maxCostUsd: 0.25,
  allowedTools: baseTools,
};
const officialStream = readFileSync(path.join(import.meta.dirname, "../fixtures/azure-openai-2025-04-01-preview-stream.sse"));

afterEach(() => vi.useRealTimers());

describe("AzureOpenAIProviderConfigSchema", () => {
  it("accepts only canonical fixed-point Azure configuration with a canonical provider-model allowlist", () => {
    expect(AzureOpenAIProviderConfigSchema.parse(config)).toEqual(config);
    for (const override of [
      { expectedProviderModels: [] },
      { expectedProviderModels: ["z-model", "a-model"] },
      { expectedProviderModels: ["same", "same"] },
      { inputTokenRateUsdPerMillion: 1.25 },
      { inputTokenRateUsdPerMillion: "1.1234567890" },
      { outputTokenRateUsdPerMillion: "1e3" },
    ]) expect(() => AzureOpenAIProviderConfigSchema.parse({ ...config, ...override })).toThrow();
  });

  it.each([
    "http://resource.openai.azure.com", "https://user@resource.openai.azure.com",
    "https://resource.openai.azure.com/path", "https://resource.openai.azure.com?x=1",
    "https://resource.openai.azure.com#fragment", "https://resource.openai.azure.com:444",
    "https://127.0.0.1", "https://localhost", "https://resource.internal",
    "https://resource.openai.azure.us", "https://openai.azure.com", "https://evilopenai.azure.com",
  ])("rejects endpoint SSRF and unsupported cloud input: %s", (endpoint) => {
    expect(() => AzureOpenAIProviderConfigSchema.parse({ ...config, endpoint })).toThrow();
  });
});

describe("AzureOpenAIModelBroker", () => {
  it("builds the exact request internally and parses the official-spec-shaped 2025-04-01-preview fixture", async () => {
    const dispatch = vi.fn(async (input: any) => {
      expect(input.url.href).toBe("https://zentra-test.openai.azure.com/openai/deployments/gpt-5-mini-prod/chat/completions?api-version=2025-04-01-preview");
      expect(input.apiKey).toBe("host-secret");
      const body = JSON.parse(input.body);
      expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_completion_tokens: 50 });
      expect(body).not.toHaveProperty("model");
      expect(JSON.stringify(body)).not.toContain("host-secret");
      return transportResponse(200, officialStream);
    });
    const result = await broker(dispatch).execute(request, new AbortController().signal);
    expect(result).toMatchObject({
      outcome: "completed", response: { type: "text", text: "Bounded result" },
      model: { id: config.deployment, provider: "azure", name: "gpt-5-mini-2025-01-01", configurationDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      usage: { inputTokens: 7, outputTokens: 3, costUsdNano: 38_750, costUsd: 0.00003875 },
    });
    expect(result.model?.configurationDigest).toBe(digestCanonical(config));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("advertises and accepts exactly the OpenCode MCP-facing research arguments", async () => {
    const dispatch = vi.fn(async (input: any) => {
      const body = JSON.parse(input.body);
      const tools = Object.fromEntries(body.tools.map((tool: any) => [tool.function.name, tool.function.parameters]));
      expect(tools.read).toMatchObject({
        additionalProperties: false, required: ["filePath"], properties: {
          filePath: { type: "string", minLength: 10, maxLength: 4096,
            description: expect.stringContaining("/project/src/greeting.mjs") },
          offset: { type: "integer", minimum: 1, maximum: 10_000_000 },
          limit: { type: "integer", minimum: 1, maximum: 2_000 },
        },
      });
      expect(tools.glob).toMatchObject({ properties: {
        pattern: { maxLength: 4096 }, path: { description: expect.stringContaining("Canonical absolute path below /project") },
      } });
      expect(tools.grep).toMatchObject({ properties: {
        pattern: { maxLength: 4096 }, path: { maxLength: 4096 }, include: { maxLength: 4096 },
      } });
      expect(body.tools.find((tool: any) => tool.function.name === "zentra_research_web_research").function.parameters).toEqual({
        type: "object", additionalProperties: false, required: ["url"],
        properties: {
          url: { type: "string", minLength: 1, maxLength: 16384 },
          method: { type: "string", enum: ["GET", "HEAD"], default: "GET" },
        },
      });
      return transportResponse(200, toolStream("zentra_research_web_research", '{"url":"https://learn.microsoft.com/azure","method":"GET"}'));
    });
    const result = await broker(dispatch).execute({ ...request, allowedTools: [...baseTools, "zentra_research_web_research"] }, new AbortController().signal);
    expect(result.response).toEqual({ type: "tool_calls", calls: [{
      id: "call-1", name: "zentra_research_web_research",
      arguments: '{"url":"https://learn.microsoft.com/azure","method":"GET"}',
    }] });
    for (const invalid of [
      { url: "https://learn.microsoft.com", schemaVersion: 1 },
      { url: "http://learn.microsoft.com" },
      { url: "https://learn.microsoft.com", method: "POST" },
    ]) {
      const failed = await broker(async () => transportResponse(200, toolStream("zentra_research_web_research", JSON.stringify(invalid))))
        .execute({ ...request, allowedTools: [...baseTools, "zentra_research_web_research"] }, new AbortController().signal);
      expect(failed.outcome).toBe("failed");
    }
  });

  it("accepts fragmented tool deltas but rejects multiple choices", async () => {
    const fragmented = sse(
      promptFilterSentinel(),
      chunk({ service_tier: "default", obfuscation: "tool-a", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: '{"file' } }] }, finish_reason: null, logprobs: null }] }),
      chunk({ service_tier: "default", obfuscation: "tool-b", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'Path":"src/index.ts"}' } }] }, finish_reason: "tool_calls", logprobs: null }] }),
      usageChunk(1, 1, { service_tier: "default", obfuscation: "tool-c", latency_checkpoint: latencyCheckpoint() }),
      "[DONE]",
    );
    await expect(broker(async () => transportResponse(200, fragmented)).execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "completed", response: { calls: [{ arguments: '{"filePath":"/project/src/index.ts"}' }] } });
    const multiple = sse(
      chunk({ choices: [
        { index: 0, delta: { content: "a" }, finish_reason: "stop", logprobs: null },
        { index: 1, delta: { content: "b" }, finish_reason: "stop", logprobs: null },
      ] }), usageChunk(1, 1), "[DONE]",
    );
    await expect(broker(async () => transportResponse(200, multiple)).execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "failed" });
  });

  it("normalizes measured and relative repository tool paths while rejecting alternate path encodings", async () => {
    for (const [name, input, expected] of [
      ["read", { filePath: "/project/src/greeting.mjs", offset: 1, limit: 2_000 }, { filePath: "/project/src/greeting.mjs", offset: 1, limit: 2_000 }],
      ["read", { filePath: "src/greeting.mjs" }, { filePath: "/project/src/greeting.mjs" }],
      ["read", { filePath: "src/café.mjs" }, { filePath: "/project/src/café.mjs" }],
      ["glob", { pattern: "src/**/*.ts", path: "src" }, { pattern: "src/**/*.ts", path: "/project/src" }],
      ["grep", { pattern: "greeting", path: "/project/src", include: "**/*.mjs" },
        { pattern: "greeting", path: "/project/src", include: "**/*.mjs" }],
    ] as const) {
      const result = await broker(async () => transportResponse(200, toolStream(name, JSON.stringify(input))))
        .execute(request, new AbortController().signal);
      expect(result).toMatchObject({ outcome: "completed", response: { calls: [{ name, arguments: JSON.stringify(expected) }] } });
    }

    const invalidPaths = [
      "", "/project", "/project/", "/etc/passwd", "/project/../etc", "/project/./src",
      "/project//src", "/project-sibling/src", "/projectevil/src", "../etc", "./src", "src/../etc",
      "src/./greeting.mjs", "src//greeting.mjs", "src\\greeting.mjs", "src\0greeting.mjs",
      "src\u0001greeting.mjs", "src\u0085greeting.mjs", "src/%2e%2e/etc", "src/%252e%252e/etc",
    ];
    for (const filePath of invalidPaths) {
      const result = await broker(async () => transportResponse(200, toolStream("read", JSON.stringify({ filePath }))))
        .execute(request, new AbortController().signal);
      expect(result).toMatchObject({ outcome: "failed", failureReason: "tool_call_arguments_schema_invalid", failureTool: "read" });
      if (filePath !== "") expect(JSON.stringify(result)).not.toContain(filePath);
    }
  });

  it("enforces read pagination and glob, include, and search-pattern bounds", async () => {
    const invalid: readonly [string, unknown][] = [
      ["read", { filePath: "/project/src/a.ts", offset: 0 }],
      ["read", { filePath: "/project/src/a.ts", offset: 10_000_001 }],
      ["read", { filePath: "/project/src/a.ts", limit: 2_001 }],
      ["glob", { pattern: "x".repeat(4_097) }],
      ["glob", { pattern: "src//*.ts" }],
      ["grep", { pattern: "x", include: "x".repeat(4_097) }],
      ["grep", { pattern: `x\u0001y` }],
    ];
    for (const [name, input] of invalid) {
      const result = await broker(async () => transportResponse(200, toolStream(name, JSON.stringify(input))))
        .execute(request, new AbortController().signal);
      expect(result).toMatchObject({ outcome: "failed", failureReason: "tool_call_arguments_schema_invalid", failureTool: name });
    }
  });

  it("rejects sentinel misuse, undocumented extensions, extension overflow, and unknown fields", async () => {
    const validChoice = chunk({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop", logprobs: null }] });
    const invalidStreams = [
      sse(JSON.stringify({ id: "", object: "", created: 0, model: "", choices: [], prompt_filter_results: [] }), validChoice, usageChunk(1, 1), "[DONE]"),
      sse(JSON.stringify({ ...JSON.parse(promptFilterSentinel()), usage: null }), validChoice, usageChunk(1, 1), "[DONE]"),
      sse(validChoice, promptFilterSentinel(), usageChunk(1, 1), "[DONE]"),
      sse(chunk({ service_tier: "undocumented", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop", logprobs: null }] }), usageChunk(1, 1), "[DONE]"),
      sse(chunk({ obfuscation: "x".repeat(16 * 1024 + 1), choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop", logprobs: null }] }), usageChunk(1, 1), "[DONE]"),
      sse(validChoice, usageChunk(1, 1, { latency_checkpoint: latencyCheckpoint({ engine_tbt_ms: -1 }) }), "[DONE]"),
      sse(validChoice, usageChunk(1, 1, { latency_checkpoint: { ...latencyCheckpoint(), unknown_ms: 1 } }), "[DONE]"),
      sse(chunk({ unknown_extension: true, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop", logprobs: null }] }), usageChunk(1, 1), "[DONE]"),
    ];
    for (const stream of invalidStreams) {
      await expect(broker(async () => transportResponse(200, stream)).execute(request, new AbortController().signal))
        .resolves.toMatchObject({ outcome: "failed", response: null, model: null, usage: null });
    }
  });

  it("binds the configured deployment and expected underlying provider model", async () => {
    const retargeted = successfulStream(1, 1).toString("utf8").replaceAll("gpt-5-mini-2025-01-01", "gpt-5-mini-retargeted");
    await expect(broker(async () => transportResponse(200, retargeted)).execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "failed", model: null });
    const dispatch = vi.fn(async () => transportResponse(200, successfulStream(1, 1)));
    await expect(broker(dispatch).execute({ ...request, modelId: "other-deployment" }, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "failed" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("uses fixed-point nanodollar cost with an exact boundary and one-nanodollar exceed", async () => {
    const exactConfig = { ...config, inputTokenRateUsdPerMillion: "1", outputTokenRateUsdPerMillion: "0" };
    const exact = azureOpenAIModelBrokerForTest(exactConfig, { ZENTRA_AZURE_OPENAI_API_KEY: "secret" }, async () => transportResponse(200, successfulStream(1, 0)));
    await expect(exact.execute({ ...request, maxCostUsd: 0.000001 }, new AbortController().signal)).resolves.toMatchObject({
      outcome: "completed", usage: { costUsdNano: 1_000, costUsd: 0.000001 },
    });
    await expect(exact.execute({ ...request, maxCostUsd: 0.000000999 }, new AbortController().signal)).resolves.toMatchObject({ outcome: "failed" });
  });

  it("rejects forged broker display cost that disagrees with authoritative nanodollars", () => {
    expect(() => ModelBrokerReceiptSchema.parse({
      outcome: "completed",
      response: { type: "text", text: "x" },
      model: { id: config.deployment, provider: "azure", name: "gpt-5-mini-2025-01-01" },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.3, costUsdNano: 299_999_999 },
    })).toThrow(/cost fields disagree/i);
  });

  it("requires one strict non-secret reason for every non-completed broker receipt", () => {
    const base = { response: null, model: null, usage: null };
    expect(() => ModelBrokerReceiptSchema.parse({ outcome: "failed", ...base })).toThrow(/failure reason/i);
    expect(() => ModelBrokerReceiptSchema.parse({ outcome: "failed", failureReason: "host-secret", ...base })).toThrow();
    expect(() => ModelBrokerReceiptSchema.parse({ outcome: "completed", failureReason: "provider_model_mismatch",
      response: { type: "text", text: "x" }, model: { id: "fixture/model", provider: "fixture", name: "fixture" },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } })).toThrow(/failure reason/i);
    expect(() => ModelBrokerReceiptSchema.parse({ outcome: "failed", failureReason: "provider_model_mismatch",
      failureTool: "read", ...base })).toThrow(/failure tool/i);
    expect(() => ModelBrokerReceiptSchema.parse({ outcome: "completed", failureTool: "read",
      response: { type: "text", text: "x" }, model: { id: "fixture/model", provider: "fixture", name: "fixture" },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } })).toThrow();
    expect(() => ModelBrokerReceiptSchema.parse({ outcome: "failed", failureReason: "tool_call_incomplete",
      failureTool: "unknown_tool", ...base })).toThrow();
    expect(ModelBrokerReceiptSchema.parse({ outcome: "failed", failureReason: "tool_call_incomplete",
      failureTool: "read", ...base })).toMatchObject({ failureTool: "read" });
  });

  it("returns fixed reasons for admission and pre-dispatch transport classes", async () => {
    const cases: readonly [ModelBrokerRequest, Partial<typeof config>, unknown, string][] = [
      [{ ...request, modelId: "other-deployment" }, {}, null, "request_model_mismatch"],
      [{ ...request, maxInputTokens: 1 }, {}, null, "input_budget_exceeded"],
      [request, { maxOutputTokens: 10 }, null, "output_budget_exceeded"],
      [request, { maxToolCalls: 2 }, null, "tool_budget_exceeded"],
      [request, {}, { code: "AZURE_RESOLUTION", dispatched: false }, "dns_resolution_failed"],
      [request, {}, { code: "AZURE_PRIVATE_TARGET", dispatched: false }, "dns_private_target"],
      [request, {}, { code: "AZURE_TLS", dispatched: false }, "tls_failed"],
      [request, {}, { code: "AZURE_TIMEOUT", dispatched: false }, "request_timed_out_before_dispatch"],
      [request, {}, { code: "ECONNREFUSED", dispatched: false }, "transport_failed_before_dispatch"],
      [request, {}, { code: "ECONNRESET", dispatched: true }, "transport_uncertain_after_dispatch"],
    ];
    for (const [brokerRequest, override, transportFailure, failureReason] of cases) {
      const dispatch = vi.fn(async () => {
        if (transportFailure !== null) throw Object.assign(new Error("provider text host-secret"), transportFailure);
        return transportResponse(200, successfulStream(1, 1));
      });
      const configured = azureOpenAIModelBrokerForTest({ ...config, ...override }, { ZENTRA_AZURE_OPENAI_API_KEY: "host-secret" }, dispatch);
      const result = await configured.execute(brokerRequest, new AbortController().signal);
      expect(result).toMatchObject({ failureReason, response: null, model: null, usage: null });
      expect(JSON.stringify(result)).not.toContain("host-secret");
    }
    const cancelled = new AbortController(); cancelled.abort();
    await expect(broker(async () => transportResponse(200, successfulStream(1, 1))).execute(request, cancelled.signal))
      .resolves.toMatchObject({ outcome: "cancelled", failureReason: "request_cancelled" });
  });

  it("admits a research second-turn prompt above 8k and below 32k but rejects one above 32k before dispatch", async () => {
    const dispatch = vi.fn(async () => transportResponse(200, successfulStream(10_000, 1)));
    const configured = broker(dispatch);
    const withinResearchBudget = { ...request, prompt: "r".repeat(40_000), maxInputTokens: 32_000 };
    await expect(configured.execute(withinResearchBudget, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "completed" });
    const aboveResearchBudget = { ...request, prompt: "r".repeat(128_004), maxInputTokens: 32_000 };
    await expect(configured.execute(aboveResearchBudget, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "failed", failureReason: "input_budget_exceeded" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("returns fixed reasons for status, response, model, usage, budget, filter, and tool classes", async () => {
    const cases: readonly [string | Uint8Array, string, string, ModelBrokerRequest?][] = [
      [new Uint8Array([0xc3, 0x28]), "text/event-stream", "response_utf8_invalid"],
      ["data: not-json\n\ndata: [DONE]\n\n", "text/event-stream", "response_json_invalid"],
      ["not-sse", "text/plain", "response_sse_invalid"],
      [sse(JSON.stringify({ ...JSON.parse(chunk({ choices: [] })), unknown: true }), "[DONE]"), "text/event-stream", "response_schema_invalid"],
      [sse(chunk({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop", logprobs: null }] })), "text/event-stream", "response_incomplete"],
      [successfulStream(1, 1).toString("utf8").replaceAll("gpt-5-mini-2025-01-01", "gpt-5-mini-retargeted"), "text/event-stream", "provider_model_mismatch"],
      [sse(chunk({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop", logprobs: null }] }),
        chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 } }), "[DONE]"), "text/event-stream", "usage_invalid"],
      [successfulStream(101, 1), "text/event-stream", "token_budget_exceeded"],
      [sse(chunk({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "content_filter", logprobs: null }] }), usageChunk(1, 1), "[DONE]"), "text/event-stream", "content_filtered"],
      [sse(chunk({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "length", logprobs: null }] }), usageChunk(1, 1), "[DONE]"), "text/event-stream", "completion_length_exceeded"],
      [toolStream("read", '{"filePath":"src/index.ts"}'), "text/event-stream", "unsupported_tool_call", { ...request, allowedTools: [] }],
      [toolStream("read", '{"wrong":"field"}'), "text/event-stream", "tool_call_arguments_schema_invalid"],
    ];
    for (const [body, contentType, failureReason, brokerRequest = request] of cases) {
      const result = await broker(async () => transportResponse(200, body, contentType)).execute(brokerRequest, new AbortController().signal);
      expect(result).toMatchObject({ failureReason, response: null, model: null, usage: null });
    }
    await expect(broker(async () => transportResponse(503, "unavailable", "text/plain")).execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "uncertain", failureReason: "provider_status_uncertain" });
    await expect(broker(async () => transportResponse(400, '{"error":{"code":"BadRequest","message":"rejected"}}', "application/json")).execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "failed", failureReason: "provider_status_rejected" });
    const costly = azureOpenAIModelBrokerForTest({ ...config, inputTokenRateUsdPerMillion: "1000000" },
      { ZENTRA_AZURE_OPENAI_API_KEY: "host-secret" }, async () => transportResponse(200, successfulStream(1, 1)));
    await expect(costly.execute({ ...request, maxCostUsd: 0 }, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "failed", failureReason: "cost_budget_exceeded" });
  });

  it("classifies every malformed tool-call boundary without retaining fragment values", async () => {
    const marker = "SENSITIVE_TOOL_FRAGMENT";
    const validArguments = '{"filePath":"src/index.ts"}';
    const valid = (index: number, id: string, name = "read", argumentsJson = validArguments) => ({
      index, id, type: "function", function: { name, arguments: argumentsJson },
    });
    const cases: readonly [Buffer, string, "read" | undefined, ModelBrokerRequest?][] = [
      [toolDiagnosticStream([{ index: 0, id: "call-1", type: "function", function: { name: "read" } }]), "tool_call_incomplete", "read"],
      [toolDiagnosticStream([valid(0, `bad id ${marker}`)]), "tool_call_id_invalid", "read"],
      [toolDiagnosticStream([valid(0, "call-1", `unknown_${marker}`)]), "tool_call_name_invalid", undefined],
      [toolDiagnosticStream([valid(0, "call-1", "read", `{"value":"${marker}`)]), "tool_call_arguments_json_invalid", "read"],
      [toolDiagnosticStream([valid(0, "call-1", "read", `{"unknown":"${marker}"}`)]), "tool_call_arguments_schema_invalid", "read"],
      [toolDiagnosticStream([valid(0, "same-id"), valid(1, "same-id")]), "tool_call_duplicate_id", "read"],
      [toolDiagnosticStream([valid(1, "call-1")]), "tool_call_index_invalid", "read"],
      [toolDiagnosticStream([valid(0, "call-0"), valid(1, "call-1"), valid(2, "call-2"), valid(3, "call-3"), valid(4, "call-4")]), "tool_call_count_exceeded", "read"],
      [toolDiagnosticStream([valid(0, "call-1")], marker), "tool_call_content_conflict", "read"],
      [toolDiagnosticStream([valid(0, "call-1")]), "unsupported_tool_call", "read", { ...request, allowedTools: [] }],
    ];
    for (const [stream, failureReason, failureTool, brokerRequest = request] of cases) {
      const result = await broker(async () => transportResponse(200, stream)).execute(brokerRequest, new AbortController().signal);
      expect(result).toMatchObject({ outcome: "failed", failureReason, response: null, model: null, usage: null });
      if (failureTool === undefined) expect(result).not.toHaveProperty("failureTool");
      else expect(result).toMatchObject({ failureTool });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(JSON.stringify(result)).not.toContain("src/index.ts");
      expect(JSON.stringify(result)).not.toContain("same-id");
    }
  });

  it("classifies complete status and stream outcomes without retry", async () => {
    for (const [response, outcome] of [
      [transportResponse(500, '{"error":{"code":"InternalServerError","message":"unknown"}}', "application/json"), "uncertain"],
      [transportResponse(408, '{"error":{"code":"Timeout","message":"unknown"}}', "application/json"), "uncertain"],
      [transportResponse(401, '{"error":{"code":"Unauthorized","message":"rejected before inference"}}', "application/json"), "failed"],
      [transportResponse(429, '{"error":{"code":"RateLimit","message":"rejected before inference"}}', "application/json"), "failed"],
      [transportResponse(307, "", "text/plain"), "failed"],
      [transportResponse(401, "truncated", "application/json"), "uncertain"],
      [transportResponse(200, sse(chunk({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop", logprobs: null }] }))), "uncertain"],
      [transportResponse(200, sse(chunk({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop", logprobs: null }] }), "[DONE]")), "uncertain"],
      [transportResponse(200, sse(chunk({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: null, logprobs: null }] }), usageChunk(1, 1), "[DONE]")), "uncertain"],
      [transportResponse(200, "data: not-json\n\ndata: [DONE]\n\n"), "failed"],
      [transportResponse(200, new Uint8Array([0xc3, 0x28])), "failed"],
    ] as const) {
      const dispatch = vi.fn(async () => response);
      await expect(broker(dispatch).execute(request, new AbortController().signal)).resolves.toMatchObject({ outcome });
      expect(dispatch).toHaveBeenCalledTimes(1);
    }
  });

  it("maps pre-dispatch cancellation separately from post-dispatch rejection and never leaks errors", async () => {
    const pre = new AbortController(); pre.abort();
    const dispatch = vi.fn(async () => transportResponse(200, successfulStream(1, 1)));
    await expect(broker(dispatch).execute(request, pre.signal)).resolves.toMatchObject({ outcome: "cancelled" });
    expect(dispatch).not.toHaveBeenCalled();
    const uncertain = vi.fn(async () => { throw Object.assign(new Error("host-secret reset"), { dispatched: true }); });
    const result = await broker(uncertain).execute(request, new AbortController().signal);
    expect(result).toEqual({ outcome: "uncertain", failureReason: "transport_uncertain_after_dispatch", response: null, model: null, usage: null });
    expect(JSON.stringify(result)).not.toContain("host-secret");
    expect(uncertain).toHaveBeenCalledTimes(1);
  });

  it("has no public credential-bearing transport constructor", () => {
    expect(() => new (AzureOpenAIModelBroker as any)(config, { ZENTRA_AZURE_OPENAI_API_KEY: "secret" }, { dispatch: vi.fn() })).toThrow();
  });
});

describe("Node Azure HTTPS transport", () => {
  let root: string;
  let server: Server;
  let port: number;
  let certificate: Buffer;
  let observedKeys: string[];
  let responseMode: "normal" | "large" | "slow";

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-azure-https-")));
    const key = path.join(root, "server.key"); const cert = path.join(root, "server.crt");
    const generated = spawnSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
      "-subj", "/CN=zentra-test.openai.azure.com", "-addext", "subjectAltName=DNS:zentra-test.openai.azure.com", "-days", "1"],
    { shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8" });
    if (generated.status !== 0) throw new Error("test certificate generation failed");
    certificate = readFileSync(cert); observedKeys = []; responseMode = "normal";
    server = https.createServer({ key: readFileSync(key), cert: certificate }, (incoming, response) => {
      observedKeys.push(String(incoming.headers["api-key"]));
      if (responseMode === "large") {
        response.setHeader("content-type", "text/event-stream; charset=utf-8");
        response.setHeader("content-length", "2048");
        response.end("x".repeat(2048));
        return;
      }
      if (responseMode === "slow") {
        setTimeout(() => { response.setHeader("content-type", "text/event-stream; charset=utf-8"); response.end(successfulStream(1, 1)); }, 500);
        return;
      }
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      const body = officialStream;
      response.write(body.subarray(0, 17)); response.write(body.subarray(17, 83)); response.end(body.subarray(83));
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("test server did not bind");
    port = address.port;
  });

  afterEach(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it("pins the selected address, verifies TLS/hostname and peer, then sends the API key and parses fragmented bytes", async () => {
    const transport = nodeAzureOpenAITransportForTest({ resolver: publicResolver, dial: () => ({ address: "127.0.0.1", family: 4, port }), ca: certificate });
    const result = await azureOpenAIModelBrokerForTest(config, { ZENTRA_AZURE_OPENAI_API_KEY: "host-secret" }, (input) => transport.dispatch(input))
      .execute(request, new AbortController().signal);
    expect(result.outcome).toBe("completed");
    expect(observedKeys).toEqual(["host-secret"]);
  });

  it("rejects private DNS, peer mismatch, certificate failure, and pre-DNS deadline without sending the API key", async () => {
    const privateTransport = nodeAzureOpenAITransportForTest({ resolver: async () => [{ address: "127.0.0.1", family: 4 }] });
    await expect(dispatch(privateTransport)).rejects.toMatchObject({ code: "AZURE_PRIVATE_TARGET", dispatched: false });
    const mismatch = nodeAzureOpenAITransportForTest({ resolver: publicResolver, dial: () => ({ address: "127.0.0.1", family: 4, port }), ca: certificate }, false);
    await expect(dispatch(mismatch)).rejects.toMatchObject({ code: "AZURE_PEER_MISMATCH", dispatched: false });
    const untrusted = nodeAzureOpenAITransportForTest({ resolver: publicResolver, dial: () => ({ address: "127.0.0.1", family: 4, port }) });
    await expect(dispatch(untrusted)).rejects.toMatchObject({ dispatched: false });
    const hanging = nodeAzureOpenAITransportForTest({ resolver: () => new Promise(() => {}) });
    await expect(dispatch(hanging, Date.now() + 20)).rejects.toMatchObject({ code: "AZURE_TIMEOUT", dispatched: false });
    expect(observedKeys).toEqual([]);
  });

  it("bounds the streamed body and maps a post-dispatch deadline to uncertainty", async () => {
    const transport = nodeAzureOpenAITransportForTest({ resolver: publicResolver, dial: () => ({ address: "127.0.0.1", family: 4, port }), ca: certificate });
    responseMode = "large";
    await expect(dispatch(transport, Date.now() + 1_000, 1_024)).rejects.toMatchObject({ code: "AZURE_BODY_LIMIT", dispatched: true });
    responseMode = "slow";
    const timedConfig = { ...config, timeoutMs: 100 };
    await expect(azureOpenAIModelBrokerForTest(timedConfig, { ZENTRA_AZURE_OPENAI_API_KEY: "secret" }, (input) => transport.dispatch(input))
      .execute(request, new AbortController().signal)).resolves.toMatchObject({ outcome: "uncertain" });
    expect(observedKeys).toHaveLength(2);
  });
});

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }] as const;
function broker(dispatch: (input: any) => Promise<any>) {
  return azureOpenAIModelBrokerForTest(config, { ZENTRA_AZURE_OPENAI_API_KEY: "host-secret" }, dispatch);
}
function transportResponse(status: number, body: string | Uint8Array, contentType = "text/event-stream; charset=utf-8") {
  return { status, headers: { "content-type": contentType }, body: typeof body === "string" ? Buffer.from(body) : body, dispatched: true as const };
}
function chunk(value: Record<string, unknown>): string {
  return JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-5-mini-2025-01-01", ...value });
}
function usageChunk(promptTokens: number, completionTokens: number, extensions: Record<string, unknown> = {}): string {
  return chunk({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }, ...extensions });
}
function sse(...values: string[]): Buffer { return Buffer.from(values.map((value) => `data: ${value}\n\n`).join("")); }
function successfulStream(promptTokens: number, completionTokens: number): Buffer {
  return sse(chunk({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop", logprobs: null }] }), usageChunk(promptTokens, completionTokens), "[DONE]");
}
function toolStream(name: string, argumentsJson: string): Buffer {
  return sse(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name, arguments: argumentsJson } }] }, finish_reason: "tool_calls", logprobs: null }] }), usageChunk(1, 1), "[DONE]");
}
function toolDiagnosticStream(toolCalls: readonly Record<string, unknown>[], content?: string): Buffer {
  return sse(chunk({ choices: [{ index: 0, delta: {
    ...(content === undefined ? {} : { content }), tool_calls: toolCalls,
  }, finish_reason: "tool_calls", logprobs: null }] }), usageChunk(1, 1), "[DONE]");
}
function promptFilterSentinel(): string {
  return JSON.stringify({
    id: "", object: "", created: 0, model: "", choices: [],
    prompt_filter_results: [{ prompt_index: 0, content_filter_results: {
      hate: { filtered: false, severity: "safe" }, self_harm: { filtered: false, severity: "safe" },
      sexual: { filtered: false, severity: "safe" }, violence: { filtered: false, severity: "safe" },
    } }],
  });
}
function latencyCheckpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine_tbt_ms: 1, engine_ttft_ms: 2, engine_ttlt_ms: 3, pre_inference_ms: 0.5,
    service_tbt_ms: 1.5, service_ttft_ms: 2.5, service_ttlt_ms: 3.5,
    total_duration_ms: 4, user_visible_ttft_ms: 2.25, ...overrides,
  };
}
function dispatch(transport: ReturnType<typeof nodeAzureOpenAITransportForTest>, deadlineAt = Date.now() + 1_000, maxResponseBytes = 1_048_576) {
  return transport.dispatch({ url: new URL("https://zentra-test.openai.azure.com/path"), apiKey: "host-secret", body: "{}", timeoutMs: 1_000, deadlineAt, maxResponseBytes, signal: new AbortController().signal });
}
