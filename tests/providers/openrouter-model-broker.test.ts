import { describe, expect, it, vi } from "vitest";

import {
  OPENROUTER_ENDPOINT,
  OpenRouterModelBroker,
  ProviderConfigSchema,
} from "../../src/providers/openrouter-model-broker.js";

const request = {
  modelId: "openai/gpt-5-mini",
  prompt: "Inspect the repository.",
  maxInputTokens: 100,
  maxOutputTokens: 50,
  maxCostUsd: 0.25,
} as const;

describe("ProviderConfigSchema", () => {
  it("accepts only the narrow OpenRouter host configuration", () => {
    expect(ProviderConfigSchema.parse({
      provider: "openrouter",
      credentialEnv: "ZENTRA_OPENROUTER_KEY",
      timeoutMs: 5_000,
    })).toEqual({
      provider: "openrouter",
      credentialEnv: "ZENTRA_OPENROUTER_KEY",
      timeoutMs: 5_000,
    });
    expect(() => ProviderConfigSchema.parse({
      provider: "openrouter",
      credentialEnv: "ZENTRA_OPENROUTER_KEY",
      timeoutMs: 5_000,
      url: "https://example.invalid",
    })).toThrow();
    expect(() => ProviderConfigSchema.parse({
      provider: "openrouter",
      credentialEnv: "PATH",
      timeoutMs: 5_000,
    })).toThrow();
  });
});

describe("OpenRouterModelBroker", () => {
  it("uses the fixed endpoint, exact model, fixed headers, and bounded request", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(init?.headers).toEqual({
        authorization: "Bearer host-secret",
        "content-type": "application/json",
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: request.modelId,
        max_tokens: request.maxOutputTokens,
        messages: [{ role: "user", content: request.prompt }],
      });
      return Response.json({
        model: request.modelId,
        choices: [{ message: { content: "Bounded result", tool_calls: [] } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.01 },
      });
    });
    const broker = new OpenRouterModelBroker(
      { provider: "openrouter", credentialEnv: "ZENTRA_OPENROUTER_KEY", timeoutMs: 5_000 },
      { ZENTRA_OPENROUTER_KEY: "host-secret" },
      fetch,
    );

    await expect(broker.execute(request, new AbortController().signal)).resolves.toEqual({
      outcome: "completed",
      response: { type: "text", text: "Bounded result" },
      model: { id: request.modelId, provider: "openrouter", name: request.modelId },
      usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.01 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(OPENROUTER_ENDPOINT);
  });

  it("accepts only strictly validated read, glob, and grep tool calls", async () => {
    const execute = (name: string, args: string) => new OpenRouterModelBroker(
      { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 5_000 },
      { KEY: "secret" },
      async () => Response.json({
        model: request.modelId,
        choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: args } }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      }),
    ).execute(request, new AbortController().signal);

    await expect(execute("read", '{"filePath":"src/index.ts","limit":20}')).resolves.toMatchObject({
      outcome: "completed",
      response: { type: "tool_calls", calls: [{ name: "read" }] },
    });
    await expect(execute("glob", '{"pattern":"src/**/*.ts"}')).resolves.toMatchObject({ outcome: "completed" });
    await expect(execute("grep", '{"pattern":"TODO","path":"src","include":"**/*.ts"}')).resolves.toMatchObject({ outcome: "completed" });
    for (const [name, args] of [
      ["bash", "{}"],
      ["read", "not-json"],
      ["read", '{"filePath":"../secret"}'],
      ["read", '{"filePath":"/etc/passwd"}'],
      ["read", '{"filePath":"src/index.ts","unknown":true}'],
      ["glob", '{"pattern":"../*"}'],
      ["grep", '{"pattern":"x","path":"../"}'],
    ]) {
      await expect(execute(name!, args!)).resolves.toMatchObject({ outcome: "failed", response: null });
    }
  });

  it("rejects a provider tool-call ID that the receipt schema rejects", async () => {
    const broker = new OpenRouterModelBroker(
      { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 5_000 },
      { KEY: "secret" },
      async () => Response.json({
        model: request.modelId,
        choices: [{ message: { content: null, tool_calls: [{
          id: "bad id",
          type: "function",
          function: { name: "read", arguments: '{"filePath":"src/index.ts"}' },
        }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      }),
    );
    await expect(broker.execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "failed", response: null });
  });

  it("rejects redirects, identity drift, and usage over any request budget", async () => {
    const cases = [
      new Response(null, { status: 307, headers: { location: "https://example.invalid" } }),
      Response.json({ model: "other/model", choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }),
      Response.json({ model: request.modelId, choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 101, completion_tokens: 1, cost: 0 } }),
      Response.json({ model: request.modelId, choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 51, cost: 0 } }),
      Response.json({ model: request.modelId, choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.26 } }),
    ];
    for (const response of cases) {
      const broker = new OpenRouterModelBroker(
        { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 5_000 },
        { KEY: "secret" },
        async () => response,
      );
      await expect(broker.execute(request, new AbortController().signal))
        .resolves.toMatchObject({ outcome: "failed", response: null });
    }
  });

  it("classifies a received malformed provider response as failed rather than uncertain", async () => {
    const broker = new OpenRouterModelBroker(
      { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 5_000 },
      { KEY: "secret" },
      async () => new Response("not-json", { status: 200 }),
    );
    await expect(broker.execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "failed", response: null });
  });

  it("rejects invalid UTF-8 in a received response as deterministic failure", async () => {
    const broker = new OpenRouterModelBroker(
      { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 5_000 },
      { KEY: "secret" },
      async () => new Response(new Uint8Array([0xc3, 0x28]), { status: 200 }),
    );
    await expect(broker.execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "failed", response: null });
  });

  it("rejects declared and streamed response bodies over the fixed byte limit", async () => {
    const declared = new OpenRouterModelBroker(
      { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 5_000 },
      { KEY: "secret" },
      async () => new Response("", { headers: { "content-length": String(4 * 1024 * 1024 + 1) } }),
    );
    await expect(declared.execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "failed" });

    const streamed = new OpenRouterModelBroker(
      { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 5_000 },
      { KEY: "secret" },
      async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      })),
    );
    await expect(streamed.execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "failed" });
  });

  it("does not retry uncertain transport failures and distinguishes cancellation", async () => {
    const fetch = vi.fn(async () => { throw new Error("connection reset"); });
    const broker = new OpenRouterModelBroker(
      { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 5_000 },
      { KEY: "secret" },
      fetch,
    );
    await expect(broker.execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "uncertain" });
    expect(fetch).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    await expect(broker.execute(request, controller.signal))
      .resolves.toMatchObject({ outcome: "cancelled" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports caller cancellation after dispatch as uncertain", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const broker = new OpenRouterModelBroker(
      { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 5_000 },
      { KEY: "secret" },
      fetch,
    );
    const result = broker.execute(request, controller.signal);
    controller.abort();
    await expect(result).resolves.toMatchObject({ outcome: "uncertain" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds a response body that stalls after headers and reports uncertainty", async () => {
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const fetch = vi.fn(async () => new Response(stream, { status: 200 }));
    const broker = new OpenRouterModelBroker(
      { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 100 },
      { KEY: "secret" },
      fetch,
    );
    await expect(broker.execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "uncertain" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds a transport that ignores timeout abort and reports uncertainty without retry", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const broker = new OpenRouterModelBroker(
      { provider: "openrouter", credentialEnv: "KEY", timeoutMs: 100 },
      { KEY: "secret" },
      fetch,
    );
    await expect(broker.execute(request, new AbortController().signal))
      .resolves.toMatchObject({ outcome: "uncertain" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
