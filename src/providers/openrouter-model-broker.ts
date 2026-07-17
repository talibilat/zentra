import { readFileSync, statSync } from "node:fs";

import { z } from "zod";

import {
  ModelBrokerReceiptSchema,
  ModelBrokerRequestSchema,
  ModelToolCallIdSchema,
  type ModelBroker,
  type ModelBrokerReceipt,
  type ModelBrokerRequest,
} from "../capsule/model-broker.js";

export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MAX_PROVIDER_CONFIG_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CREDENTIAL_ENV = /^[A-Z][A-Z0-9_]{0,127}$/;
const FORBIDDEN_ENV_NAMES = new Set([
  "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "NODE_OPTIONS", "NODE_PATH",
]);

class PostDispatchUncertainError extends Error {}

export const ProviderConfigSchema = z.strictObject({
  provider: z.literal("openrouter"),
  credentialEnv: z.string().regex(CREDENTIAL_ENV).refine((name) => !FORBIDDEN_ENV_NAMES.has(name)),
  timeoutMs: z.number().int().min(100).max(120_000),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
type ModelFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function loadProviderConfig(configPath: string): ProviderConfig {
  const stat = statSync(configPath);
  if (!stat.isFile() || stat.size > MAX_PROVIDER_CONFIG_BYTES) throw new Error("provider configuration is invalid");
  return ProviderConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
}

export class OpenRouterModelBroker implements ModelBroker {
  private readonly credential: string;

  constructor(
    private readonly config: ProviderConfig,
    environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly transport: ModelFetch = globalThis.fetch,
  ) {
    ProviderConfigSchema.parse(config);
    const credential = environment[config.credentialEnv];
    if (credential === undefined || credential.length === 0 || credential.length > 16 * 1024 || credential.includes("\0")) {
      throw new Error("configured provider credential is unavailable");
    }
    this.credential = credential;
  }

  async execute(rawRequest: ModelBrokerRequest, signal: AbortSignal): Promise<ModelBrokerReceipt> {
    const request = ModelBrokerRequestSchema.parse(rawRequest);
    if (signal.aborted) return emptyReceipt("cancelled");
    if (estimatedTokens(request.prompt) > request.maxInputTokens) return emptyReceipt("failed");

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException("provider timeout", "TimeoutError")), this.config.timeoutMs);
    const combined = AbortSignal.any([signal, timeout.signal]);
    let bytes: Uint8Array;
    try {
      const transport = this.transport(OPENROUTER_ENDPOINT, {
        method: "POST",
        redirect: "manual",
        signal: combined,
        headers: {
          authorization: `Bearer ${this.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.modelId,
          messages: [{ role: "user", content: request.prompt }],
          max_tokens: request.maxOutputTokens,
          tools: ["read", "glob", "grep"].map((name) => ({
            type: "function",
            function: { name, description: `Request the bounded ${name} repository tool.`, parameters: { type: "object" } },
          })),
        }),
      });
      const response = await raceAbort(transport, combined);
      if (response.status >= 300 && response.status < 400) return emptyReceipt("failed");
      if (!response.ok) return emptyReceipt("failed");
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
        void response.body?.cancel().catch(() => {});
        return emptyReceipt("failed");
      }
      const body = await readBoundedBody(response, combined);
      if (body === null) return emptyReceipt("failed");
      bytes = body;
    } catch (error) {
      if (error instanceof PostDispatchUncertainError || signal.aborted || timeout.signal.aborted) {
        return emptyReceipt("uncertain");
      }
      return emptyReceipt("uncertain");
    } finally {
      clearTimeout(timer);
    }

    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return parseProviderResponse(JSON.parse(text), request);
    } catch {
      return emptyReceipt("failed");
    }
  }
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await raceAbort(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(item.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error instanceof PostDispatchUncertainError ? error : new PostDispatchUncertainError();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out underlying read may retain the lock until cancellation settles.
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PostDispatchUncertainError());
      return;
    }
    const onAbort = (): void => reject(new PostDispatchUncertainError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const ProviderResponseSchema = z.object({
  model: z.string().min(1).max(256),
  choices: z.array(z.object({
    message: z.object({
      content: z.string().max(MAX_RESPONSE_BYTES).nullable(),
      tool_calls: z.array(z.object({
        id: ModelToolCallIdSchema,
        type: z.literal("function"),
        function: z.object({
          name: z.string().min(1).max(32),
          arguments: z.string().min(2).max(64 * 1024),
        }),
      })).max(16).optional(),
    }),
  })).length(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative(),
  }),
});

function parseProviderResponse(value: unknown, request: ModelBrokerRequest): ModelBrokerReceipt {
  const parsed = ProviderResponseSchema.safeParse(value);
  if (!parsed.success) return emptyReceipt("failed");
  const response = parsed.data;
  if (
    response.model !== request.modelId ||
    response.usage.prompt_tokens > request.maxInputTokens ||
    response.usage.completion_tokens > request.maxOutputTokens ||
    response.usage.cost > request.maxCostUsd
  ) return emptyReceipt("failed");
  const message = response.choices[0]!.message;
  const calls = message.tool_calls ?? [];
  let assistant: ModelBrokerReceipt["response"];
  if (calls.length > 0) {
    if (new Set(calls.map((call) => call.id)).size !== calls.length ||
      calls.some((call) => call.function.name !== "read" && call.function.name !== "glob" && call.function.name !== "grep")) {
      return emptyReceipt("failed");
    }
    const validated = calls.map((call) => validateToolCall(
      call.function.name as "read" | "glob" | "grep",
      call.function.arguments,
    ));
    if (validated.some((argumentsJson) => argumentsJson === null)) return emptyReceipt("failed");
    assistant = {
      type: "tool_calls",
      calls: calls.map((call, index) => ({
        id: call.id,
        name: call.function.name as "read" | "glob" | "grep",
        arguments: validated[index]!,
      })),
    };
  } else if (message.content !== null && message.content.length > 0) {
    assistant = { type: "text", text: message.content };
  } else {
    return emptyReceipt("failed");
  }
  return ModelBrokerReceiptSchema.parse({
    outcome: "completed",
    response: assistant,
    model: { id: request.modelId, provider: "openrouter", name: request.modelId },
    usage: {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
      costUsd: response.usage.cost,
    },
  });
}

const SafeRelativePathSchema = z.string().min(1).max(4_096).refine((candidate) => {
  if (candidate.startsWith("/") || candidate.includes("\\") || candidate.includes("\0")) return false;
  return candidate.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
});
const SafeGlobSchema = z.string().min(1).max(4_096).refine((candidate) =>
  !candidate.startsWith("/") && !candidate.includes("\\") && !candidate.includes("\0") &&
  candidate.split("/").every((segment) => segment !== ".."));
const ToolArgumentSchemas = {
  read: z.strictObject({
    filePath: SafeRelativePathSchema,
    offset: z.number().int().positive().max(10_000_000).optional(),
    limit: z.number().int().positive().max(2_000).optional(),
  }),
  glob: z.strictObject({
    pattern: SafeGlobSchema,
    path: SafeRelativePathSchema.optional(),
  }),
  grep: z.strictObject({
    pattern: z.string().min(1).max(4_096).refine((value) => !value.includes("\0")),
    path: SafeRelativePathSchema.optional(),
    include: SafeGlobSchema.optional(),
  }),
} as const;

function validateToolCall(name: "read" | "glob" | "grep", encoded: string): string | null {
  try {
    return JSON.stringify(ToolArgumentSchemas[name].parse(JSON.parse(encoded)));
  } catch {
    return null;
  }
}

function estimatedTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function emptyReceipt(outcome: Exclude<ModelBrokerReceipt["outcome"], "completed">): ModelBrokerReceipt {
  return { outcome, response: null, model: null, usage: null };
}
