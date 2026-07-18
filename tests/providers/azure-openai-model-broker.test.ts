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
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: '{"file' } }] }, finish_reason: null, logprobs: null }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'Path":"src/index.ts"}' } }] }, finish_reason: "tool_calls", logprobs: null }] }),
      usageChunk(1, 1),
      "[DONE]",
    );
    await expect(broker(async () => transportResponse(200, fragmented)).execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "completed", response: { calls: [{ arguments: '{"filePath":"src/index.ts"}' }] } });
    const multiple = sse(
      chunk({ choices: [
        { index: 0, delta: { content: "a" }, finish_reason: "stop", logprobs: null },
        { index: 1, delta: { content: "b" }, finish_reason: "stop", logprobs: null },
      ] }), usageChunk(1, 1), "[DONE]",
    );
    await expect(broker(async () => transportResponse(200, multiple)).execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "failed" });
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
    expect(result).toEqual({ outcome: "uncertain", response: null, model: null, usage: null });
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
      const body = successfulStream(1, 1);
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
function usageChunk(promptTokens: number, completionTokens: number): string {
  return chunk({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } });
}
function sse(...values: string[]): Buffer { return Buffer.from(values.map((value) => `data: ${value}\n\n`).join("")); }
function successfulStream(promptTokens: number, completionTokens: number): Buffer {
  return sse(chunk({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop", logprobs: null }] }), usageChunk(promptTokens, completionTokens), "[DONE]");
}
function toolStream(name: string, argumentsJson: string): Buffer {
  return sse(chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name, arguments: argumentsJson } }] }, finish_reason: "tool_calls", logprobs: null }] }), usageChunk(1, 1), "[DONE]");
}
function dispatch(transport: ReturnType<typeof nodeAzureOpenAITransportForTest>, deadlineAt = Date.now() + 1_000, maxResponseBytes = 1_048_576) {
  return transport.dispatch({ url: new URL("https://zentra-test.openai.azure.com/path"), apiKey: "host-secret", body: "{}", timeoutMs: 1_000, deadlineAt, maxResponseBytes, signal: new AbortController().signal });
}
