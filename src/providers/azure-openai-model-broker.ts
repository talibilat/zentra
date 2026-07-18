import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { TLSSocket } from "node:tls";

import { z } from "zod";

import { isPublicAddress } from "../capsule/egress-policy.js";
import {
  ModelBrokerRequestSchema,
  ModelToolCallIdSchema,
  ModelToolNameSchema,
  type ModelBroker,
  type ModelBrokerReceipt,
  type ModelBrokerRequest,
} from "../capsule/model-broker.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import { nanoToUsdDisplay, usdNumberToNano } from "../contracts/cost.js";

const CREDENTIAL_ENV = /^[A-Z][A-Z0-9_]{0,127}$/;
const FORBIDDEN_ENV_NAMES = new Set(["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "NODE_OPTIONS", "NODE_PATH"]);
const DEPLOYMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const PROVIDER_MODEL = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254}[A-Za-z0-9])?$/;
const API_VERSION = /^20[2-9][0-9]-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])(?:-preview)?$/;
const AZURE_PUBLIC_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:openai\.azure\.com|cognitiveservices\.azure\.com)$/;
const DECIMAL_RATE = /^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,9})?$/;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const TOKENS_PER_MILLION = 1_000_000n;

export const AzureOpenAIProviderConfigSchema = z.strictObject({
  provider: z.literal("azure"),
  endpoint: z.string().min(1).max(512).refine(isCanonicalAzurePublicOrigin, "endpoint must be a canonical Azure public-cloud HTTPS origin"),
  deployment: z.string().min(1).max(128).regex(DEPLOYMENT),
  apiVersion: z.string().regex(API_VERSION),
  credentialEnv: z.string().regex(CREDENTIAL_ENV).refine((name) => !FORBIDDEN_ENV_NAMES.has(name)),
  timeoutMs: z.number().int().min(100).max(120_000),
  maxResponseBytes: z.number().int().min(1_024).max(4 * 1024 * 1024),
  maxInputTokens: z.number().int().positive().max(2_000_000),
  maxOutputTokens: z.number().int().positive().max(2_000_000),
  maxToolCalls: z.number().int().nonnegative().max(16),
  expectedProviderModels: z.array(z.string().min(1).max(256).regex(PROVIDER_MODEL)).min(1).max(32)
    .superRefine(canonicalStrings),
  inputTokenRateUsdPerMillion: z.string().regex(DECIMAL_RATE),
  outputTokenRateUsdPerMillion: z.string().regex(DECIMAL_RATE),
});

export type AzureOpenAIProviderConfig = Readonly<z.infer<typeof AzureOpenAIProviderConfigSchema>>;

interface AzureTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly dispatched: true;
}

interface AzureTransportRequest {
  readonly url: URL;
  readonly apiKey: string;
  readonly body: string;
  readonly timeoutMs: number;
  readonly deadlineAt: number;
  readonly maxResponseBytes: number;
  readonly signal: AbortSignal;
}

interface AzureTransport {
  dispatch(request: AzureTransportRequest): Promise<AzureTransportResponse>;
}

interface NodeAzureTransportOptions {
  readonly resolver?: typeof boundedLookup;
  readonly dial?: (selected: { readonly address: string; readonly family: number }) => { readonly address: string; readonly family: number; readonly port?: number };
  readonly ca?: Buffer;
  readonly allowNonPublicDialForTest?: boolean;
  readonly internalTestToken?: symbol;
}

const AZURE_TEST_TOKEN = Symbol("zentra-azure-transport-test");
const AZURE_BROKER_TOKEN = Symbol("zentra-azure-broker");

class NodeAzureOpenAITransport implements AzureTransport {
  constructor(private readonly options: NodeAzureTransportOptions = {}) {
    if (options.allowNonPublicDialForTest === true && options.internalTestToken !== AZURE_TEST_TOKEN) {
      throw new Error("non-public Azure dialing is test-only");
    }
  }

  async dispatch(input: AzureTransportRequest): Promise<AzureTransportResponse> {
    const addresses = await boundedResolution(
      (this.options.resolver ?? boundedLookup)(input.url.hostname, input.signal, input.deadlineAt),
      input.signal,
      input.deadlineAt,
    );
    if (addresses.length === 0) throw transportError("AZURE_RESOLUTION", false);
    if (addresses.some((entry) => !isPublicAddress(entry.address))) throw transportError("AZURE_PRIVATE_TARGET", false);
    const selected = addresses[0]!;
    if (input.signal.aborted) throw transportError("AZURE_CANCELLED", false);
    const remaining = Math.min(input.timeoutMs, input.deadlineAt - Date.now());
    if (remaining <= 0) throw transportError("AZURE_TIMEOUT", false);
    const dial: { readonly address: string; readonly family: number; readonly port?: number } = this.options.dial?.(selected) ?? selected;
    return new Promise((resolve, reject) => {
      let dispatched = false;
      let settled = false;
      let request: import("node:http").ClientRequest | undefined;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        action();
      };
      const fail = (error: unknown): void => finish(() => reject(markDispatch(error, dispatched)));
      const abort = (): void => {
        if (request === undefined) fail(transportError("AZURE_CANCELLED", false));
        else request.destroy(transportError("AZURE_CANCELLED", dispatched));
      };
      const timer = setTimeout(() => request === undefined
        ? fail(transportError("AZURE_TIMEOUT", false))
        : request.destroy(transportError("AZURE_TIMEOUT", dispatched)), remaining);
      timer.unref();
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) return abort();
      request = https.request(input.url, {
        method: "POST",
        ...(dial.port === undefined ? {} : { port: dial.port }),
        headers: {
          "api-key": input.apiKey,
          "content-type": "application/json",
          accept: "text/event-stream",
          "content-length": Buffer.byteLength(input.body, "utf8"),
        },
        agent: false,
        rejectUnauthorized: true,
        ...(this.options.ca === undefined ? {} : { ca: this.options.ca }),
        servername: input.url.hostname,
        lookup: (_hostname, options, callback) => {
          if ((options as { all?: boolean }).all === true) {
            (callback as (error: null, addresses: readonly { address: string; family: number }[]) => void)(null, [dial]);
          } else {
            (callback as (error: null, address: string, family: number) => void)(null, dial.address, dial.family);
          }
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const connectedAddress = response.socket.remoteAddress;
        const connectedTls = response.socket instanceof TLSSocket && response.socket.encrypted === true;
        if (!connectedTls) return response.destroy(transportError("AZURE_TLS", dispatched));
        try {
          verifiedRemoteAddress(connectedAddress, selected.address, dial.address, this.options.allowNonPublicDialForTest === true);
          const declaredLength = response.headers["content-length"];
          if (declaredLength !== undefined && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > input.maxResponseBytes)) {
            return response.destroy(transportError("AZURE_BODY_LIMIT", true));
          }
        } catch (error) {
          return response.destroy(markDispatch(error, dispatched));
        }
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.maxResponseBytes) response.destroy(transportError("AZURE_BODY_LIMIT", true));
          else chunks.push(chunk);
        });
        response.on("end", () => finish(() => resolve({
          status: response.statusCode ?? 0,
          headers: canonicalHeaders(response.headers),
          body: Buffer.concat(chunks),
          dispatched: true,
        })));
        response.on("error", fail);
      });
      request.on("socket", (socket) => socket.once("secureConnect", () => {
        try {
          verifiedRemoteAddress(socket.remoteAddress, selected.address, dial.address, this.options.allowNonPublicDialForTest === true);
          dispatched = true;
          request!.end(input.body, "utf8");
        } catch (error) {
          request!.destroy(markDispatch(error, dispatched));
        }
      }));
      request.on("error", fail);
      request.on("close", () => {
        if (!settled && !dispatched) fail(transportError("AZURE_TRANSPORT", false));
      });
    });
  }
}

export class AzureOpenAIModelBroker implements ModelBroker {
  private readonly config: AzureOpenAIProviderConfig;
  private readonly credential: string;
  private readonly configurationDigest: string;

  constructor(
    token: symbol,
    rawConfig: AzureOpenAIProviderConfig,
    environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly transport: AzureTransport = new NodeAzureOpenAITransport(),
  ) {
    if (token !== AZURE_BROKER_TOKEN) throw new Error("Azure broker construction is internal");
    this.config = Object.freeze(AzureOpenAIProviderConfigSchema.parse(rawConfig));
    const credential = environment[this.config.credentialEnv];
    if (credential === undefined || credential.length === 0 || Buffer.byteLength(credential, "utf8") > MAX_CREDENTIAL_BYTES || credential.includes("\0")) {
      throw new Error("configured provider credential is unavailable");
    }
    this.credential = credential;
    this.configurationDigest = digestCanonical(this.config);
  }

  static create(
    config: AzureOpenAIProviderConfig,
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ): AzureOpenAIModelBroker {
    return new AzureOpenAIModelBroker(AZURE_BROKER_TOKEN, config, environment);
  }

  async execute(rawRequest: ModelBrokerRequest, signal: AbortSignal): Promise<ModelBrokerReceipt> {
    const request = ModelBrokerRequestSchema.parse(rawRequest);
    if (signal.aborted) return emptyReceipt("cancelled");
    if (request.modelId !== this.config.deployment || estimatedTokens(request.prompt) > request.maxInputTokens ||
      request.maxInputTokens > this.config.maxInputTokens || request.maxOutputTokens > this.config.maxOutputTokens) {
      return emptyReceipt("failed");
    }
    const allowedTools = request.allowedTools ?? [];
    if (allowedTools.length > this.config.maxToolCalls) return emptyReceipt("failed");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const combined = AbortSignal.any([signal, controller.signal]);
    let response: AzureTransportResponse;
    try {
      response = await this.transport.dispatch({
        url: this.url(), apiKey: this.credential, timeoutMs: this.config.timeoutMs,
        deadlineAt: Date.now() + this.config.timeoutMs, maxResponseBytes: this.config.maxResponseBytes,
        signal: combined,
        body: JSON.stringify({
          messages: [{ role: "user", content: request.prompt }], max_completion_tokens: request.maxOutputTokens,
          stream: true, stream_options: { include_usage: true },
          ...(allowedTools.length === 0 ? {} : { tools: allowedTools.map(toolDefinition) }),
        }),
      });
    } catch (error) {
      clearTimeout(timer);
      const failure = transportRecord(error);
      if (failure.dispatched === true) return emptyReceipt("uncertain");
      if (signal.aborted || failure.code === "AZURE_CANCELLED") return emptyReceipt("cancelled");
      if (controller.signal.aborted || failure.code === "AZURE_TIMEOUT") return emptyReceipt("timed_out");
      return emptyReceipt("failed");
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 408 || response.status >= 500) return emptyReceipt("uncertain");
    if (response.status >= 300 && response.status < 400) return emptyReceipt("failed");
    if (response.status >= 400) return parseCompleteAzureError(response) ? emptyReceipt("failed") : emptyReceipt("uncertain");
    if (response.status < 200 || response.status >= 300) return emptyReceipt("failed");
    const contentType = response.headers["content-type"];
    if (contentType === undefined || !/^text\/event-stream(?:;\s*charset=utf-8)?$/i.test(contentType)) return emptyReceipt("failed");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
      return parseStream(text, request, this.config, this.configurationDigest);
    } catch {
      return emptyReceipt("failed");
    }
  }

  private url(): URL {
    return new URL(`${this.config.endpoint}/openai/deployments/${encodeURIComponent(this.config.deployment)}` +
      `/chat/completions?api-version=${encodeURIComponent(this.config.apiVersion)}`);
  }
}

export function azureOpenAIModelBrokerForTest(
  config: AzureOpenAIProviderConfig,
  environment: Readonly<Record<string, string | undefined>>,
  dispatch: AzureTransport["dispatch"],
): AzureOpenAIModelBroker {
  return new AzureOpenAIModelBroker(AZURE_BROKER_TOKEN, config, environment, { dispatch });
}

export function nodeAzureOpenAITransportForTest(
  options: Omit<NodeAzureTransportOptions, "allowNonPublicDialForTest" | "internalTestToken">,
  allowNonPublicDialForTest = true,
): AzureTransport {
  return new NodeAzureOpenAITransport({ ...options, allowNonPublicDialForTest, internalTestToken: AZURE_TEST_TOKEN });
}

const ToolCallDeltaSchema = z.strictObject({
  index: z.number().int().nonnegative().max(15), id: ModelToolCallIdSchema.optional(), type: z.literal("function").optional(),
  function: z.strictObject({ name: z.string().min(1).max(128).optional(), arguments: z.string().max(64 * 1024).optional() }).optional(),
});
const LogprobTokenSchema: z.ZodType = z.lazy(() => z.strictObject({
  token: z.string().max(16_384), logprob: z.number().finite(), bytes: z.array(z.number().int().min(0).max(255)).max(16_384).nullable(),
  top_logprobs: z.array(z.strictObject({ token: z.string().max(16_384), logprob: z.number().finite(), bytes: z.array(z.number().int().min(0).max(255)).max(16_384).nullable() })).max(20),
}));
const LogprobsSchema = z.strictObject({
  content: z.array(LogprobTokenSchema).max(2_000_000).nullable(),
  refusal: z.array(LogprobTokenSchema).max(2_000_000).nullable(),
});
const UsageSchema = z.strictObject({
  prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative(),
  prompt_tokens_details: z.strictObject({ audio_tokens: z.number().int().nonnegative().optional(), cached_tokens: z.number().int().nonnegative().optional() }).nullable().optional(),
  completion_tokens_details: z.strictObject({ accepted_prediction_tokens: z.number().int().nonnegative().optional(), audio_tokens: z.number().int().nonnegative().optional(), reasoning_tokens: z.number().int().nonnegative().optional(), rejected_prediction_tokens: z.number().int().nonnegative().optional() }).nullable().optional(),
});
const StreamChunkSchema = z.strictObject({
  id: z.string().min(1).max(256), object: z.literal("chat.completion.chunk"), created: z.number().int().nonnegative(),
  model: z.string().min(1).max(256).regex(PROVIDER_MODEL), system_fingerprint: z.string().max(256).nullable().optional(),
  prompt_filter_results: z.array(z.strictObject({ prompt_index: z.number().int().nonnegative(), content_filter_results: contentFilterResultsSchema() })).max(8).optional(),
  choices: z.array(z.strictObject({
    index: z.number().int().nonnegative().max(7),
    delta: z.strictObject({ role: z.literal("assistant").optional(), content: z.string().nullable().optional(), refusal: z.string().nullable().optional(), tool_calls: z.array(ToolCallDeltaSchema).max(16).optional() }),
    finish_reason: z.enum(["stop", "tool_calls", "length", "content_filter"]).nullable(),
    logprobs: LogprobsSchema.nullable().optional(), content_filter_results: contentFilterResultsSchema().optional(),
    content_filter_offsets: z.strictObject({
      check_offset: z.number().int().nonnegative(), start_offset: z.number().int().nonnegative(), end_offset: z.number().int().nonnegative(),
    }).optional(),
  })).max(8),
  usage: UsageSchema.nullable().optional(),
});

function parseStream(textValue: string, request: ModelBrokerRequest, config: AzureOpenAIProviderConfig, configurationDigest: string): ModelBrokerReceipt {
  if (textValue.includes("\r") && !textValue.includes("\r\n")) return emptyReceipt("failed");
  const text = textValue.replaceAll("\r\n", "\n");
  if (!text.endsWith("\n")) return emptyReceipt("uncertain");
  const frames = text.slice(0, text.endsWith("\n\n") ? -2 : -1).split("\n\n");
  if (frames.length < 2 || frames.at(-1) !== "data: [DONE]") return emptyReceipt("uncertain");
  let providerModel: string | null = null;
  let content = "";
  let finishReason: "stop" | "tool_calls" | "length" | "content_filter" | null = null;
  let usage: z.infer<typeof UsageSchema> | null = null;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for (const frame of frames.slice(0, -1)) {
    if (!frame.startsWith("data: ") || frame.includes("\n")) return emptyReceipt("failed");
    let raw: unknown;
    try { raw = JSON.parse(frame.slice(6)); } catch { return emptyReceipt("failed"); }
    const parsed = StreamChunkSchema.safeParse(raw);
    if (!parsed.success) return emptyReceipt("failed");
    const chunk = parsed.data;
    if (!config.expectedProviderModels.includes(chunk.model)) return emptyReceipt("failed");
    if (providerModel !== null && providerModel !== chunk.model) return emptyReceipt("failed");
    providerModel = chunk.model;
    if (chunk.usage !== undefined && chunk.usage !== null) {
      if (usage !== null || chunk.choices.length !== 0 || chunk.usage.total_tokens !== chunk.usage.prompt_tokens + chunk.usage.completion_tokens) return emptyReceipt("failed");
      usage = chunk.usage;
    }
    if (chunk.choices.length > 1 || (chunk.choices.length === 1 && chunk.choices[0]?.index !== 0)) return emptyReceipt("failed");
    const choice = chunk.choices[0];
    if (choice === undefined) continue;
    if (choice.delta.refusal !== undefined && choice.delta.refusal !== null) return emptyReceipt("failed");
    if (choice.delta.content !== undefined && choice.delta.content !== null) content += choice.delta.content;
    for (const delta of choice.delta.tool_calls ?? []) {
      const current = calls.get(delta.index) ?? { id: "", name: "", arguments: "" };
      current.id += delta.id ?? ""; current.name += delta.function?.name ?? ""; current.arguments += delta.function?.arguments ?? "";
      if (current.arguments.length > 64 * 1024) return emptyReceipt("failed");
      calls.set(delta.index, current);
    }
    if (choice.finish_reason !== null) {
      if (finishReason !== null) return emptyReceipt("failed");
      finishReason = choice.finish_reason;
    }
  }
  if (providerModel === null || usage === null || finishReason === null) return emptyReceipt("uncertain");
  if (finishReason === "length" || finishReason === "content_filter") return emptyReceipt("failed");
  if (usage.prompt_tokens > request.maxInputTokens || usage.prompt_tokens > config.maxInputTokens || usage.completion_tokens > request.maxOutputTokens || usage.completion_tokens > config.maxOutputTokens) return emptyReceipt("failed");
  const costNano = computedCostNano(usage.prompt_tokens, usage.completion_tokens, config);
  if (costNano > BigInt(usdNumberToNano(request.maxCostUsd))) return emptyReceipt("failed");
  let response: ModelBrokerReceipt["response"];
  if (finishReason === "tool_calls") {
    if (content !== "" || calls.size === 0 || calls.size > config.maxToolCalls || [...calls.keys()].some((index, position) => index !== position)) return emptyReceipt("failed");
    const allowed = new Set(request.allowedTools ?? []);
    const validated = [...calls.values()].map((call) => validateToolCall(call, allowed));
    if (validated.some((call) => call === null) || new Set(validated.map((call) => call?.id)).size !== validated.length) return emptyReceipt("failed");
    response = { type: "tool_calls", calls: validated as NonNullable<(typeof validated)[number]>[] };
  } else {
    if (calls.size > 0 || content.length === 0) return emptyReceipt("failed");
    response = { type: "text", text: content };
  }
  return {
    outcome: "completed", response,
    model: { id: config.deployment, provider: "azure", name: providerModel, configurationDigest },
    usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, costUsd: nanoToUsdDisplay(Number(costNano)), costUsdNano: Number(costNano) },
  };
}

const SafeRelativePathSchema = z.string().min(1).max(4_096).refine((candidate) => !candidate.startsWith("/") && !candidate.includes("\\") && !candidate.includes("\0") && candidate.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."));
const SafeGlobSchema = z.string().min(1).max(4_096).refine((candidate) => !candidate.startsWith("/") && !candidate.includes("\\") && !candidate.includes("\0") && candidate.split("/").every((segment) => segment !== ".."));
const ModelFacingResearchSchema = z.strictObject({
  url: z.string().min(1).max(16_384).refine((value) => { try { const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""; } catch { return false; } }),
  method: z.enum(["GET", "HEAD"]).optional(),
});
const ToolArgumentSchemas = {
  read: z.strictObject({ filePath: SafeRelativePathSchema, offset: z.number().int().positive().max(10_000_000).optional(), limit: z.number().int().positive().max(2_000).optional() }),
  glob: z.strictObject({ pattern: SafeGlobSchema, path: SafeRelativePathSchema.optional() }),
  grep: z.strictObject({ pattern: z.string().min(1).max(4_096).refine((value) => !value.includes("\0")), path: SafeRelativePathSchema.optional(), include: SafeGlobSchema.optional() }),
  zentra_research_web_research: ModelFacingResearchSchema,
} as const;

function validateToolCall(call: { id: string; name: string; arguments: string }, allowed: ReadonlySet<string>) {
  const name = ModelToolNameSchema.safeParse(call.name); const id = ModelToolCallIdSchema.safeParse(call.id);
  if (!name.success || !id.success || !allowed.has(name.data)) return null;
  try { return { id: id.data, name: name.data, arguments: JSON.stringify(ToolArgumentSchemas[name.data].parse(JSON.parse(call.arguments))) }; }
  catch { return null; }
}

function toolDefinition(name: z.infer<typeof ModelToolNameSchema>) {
  return { type: "function", function: { name, description: `Request the bounded ${name} tool.`, parameters: toolParameters(name) } };
}
function toolParameters(name: z.infer<typeof ModelToolNameSchema>): Readonly<Record<string, unknown>> {
  const relativePath = { type: "string", minLength: 1, maxLength: 4096 } as const;
  if (name === "read") return { type: "object", additionalProperties: false, required: ["filePath"], properties: { filePath: relativePath, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 2000 } } };
  if (name === "glob") return { type: "object", additionalProperties: false, required: ["pattern"], properties: { pattern: relativePath, path: relativePath } };
  if (name === "grep") return { type: "object", additionalProperties: false, required: ["pattern"], properties: { pattern: relativePath, path: relativePath, include: relativePath } };
  return { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", minLength: 1, maxLength: 16384 }, method: { type: "string", enum: ["GET", "HEAD"], default: "GET" } } };
}

function contentFilterResultsSchema() {
  const severity = z.strictObject({ filtered: z.boolean(), severity: z.enum(["safe", "low", "medium", "high"]) });
  const detected = z.strictObject({ filtered: z.boolean(), detected: z.boolean() });
  return z.strictObject({
    hate: severity.optional(), self_harm: severity.optional(), sexual: severity.optional(), violence: severity.optional(),
    jailbreak: detected.optional(), profanity: detected.optional(), protected_material_code: detected.optional(), protected_material_text: detected.optional(),
    custom_blocklists: z.array(z.strictObject({ filtered: z.boolean(), id: z.string().min(1).max(256) })).max(128).optional(),
    error: z.strictObject({ code: z.string().min(1).max(256), message: z.string().min(1).max(4096) }).optional(),
  });
}

const AzureErrorSchema = z.strictObject({ error: z.strictObject({
  code: z.union([z.string().min(1).max(256), z.number().int()]), message: z.string().min(1).max(64 * 1024),
  param: z.string().max(1024).nullable().optional(), type: z.string().max(256).nullable().optional(),
  innererror: z.unknown().optional(),
}) });
function parseCompleteAzureError(response: AzureTransportResponse): boolean {
  const type = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json" || response.body.length === 0) return false;
  try { return AzureErrorSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body))).success; }
  catch { return false; }
}

function computedCostNano(inputTokens: number, outputTokens: number, config: AzureOpenAIProviderConfig): bigint {
  const numerator = BigInt(inputTokens) * decimalRateToNano(config.inputTokenRateUsdPerMillion) + BigInt(outputTokens) * decimalRateToNano(config.outputTokenRateUsdPerMillion);
  return (numerator + TOKENS_PER_MILLION - 1n) / TOKENS_PER_MILLION;
}
function decimalRateToNano(value: string): bigint { return decimalToScaledInteger(value, 9); }
function decimalToScaledInteger(value: string, scale: number): bigint {
  const [whole, fraction = ""] = value.split(".");
  const padded = `${fraction}${"0".repeat(scale)}`.slice(0, scale);
  return BigInt(whole!) * 10n ** BigInt(scale) + BigInt(padded || "0");
}

function isCanonicalAzurePublicOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && url.pathname === "/" && url.search === "" && url.hash === "" && value === url.origin && AZURE_PUBLIC_HOST.test(url.hostname) && isIP(url.hostname) === 0; }
  catch { return false; }
}
function estimatedTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, "utf8") / 4); }
function emptyReceipt(outcome: Exclude<ModelBrokerReceipt["outcome"], "completed">): ModelBrokerReceipt { return { outcome, response: null, model: null, usage: null }; }
function canonicalStrings(values: readonly string[], context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]! >= value)) context.addIssue({ code: "custom", message: "values must be sorted and unique" });
}
function canonicalHeaders(headers: import("node:http").IncomingHttpHeaders): Readonly<Record<string, string>> {
  const retained: Record<string, string> = {};
  for (const name of ["content-type", "content-length", "location"] as const) if (typeof headers[name] === "string") retained[name] = headers[name];
  return retained;
}
function transportError(code: string, dispatched: boolean): Error & { readonly code: string; readonly dispatched: boolean } { return Object.assign(new Error(code), { code, dispatched }); }
function markDispatch(error: unknown, dispatched: boolean): Error & { readonly dispatched: boolean } {
  const result = error instanceof Error ? error : new Error("Azure transport failed");
  return Object.assign(result, { dispatched: transportRecord(result).dispatched === true || dispatched });
}
function transportRecord(error: unknown): { readonly code?: string; readonly dispatched?: boolean } { return typeof error === "object" && error !== null ? error as { code?: string; dispatched?: boolean } : {}; }
async function boundedLookup(hostname: string, signal: AbortSignal, deadlineAt: number): Promise<readonly { readonly address: string; readonly family: number }[]> {
  if (signal.aborted) throw transportError("AZURE_CANCELLED", false);
  const remaining = deadlineAt - Date.now(); if (remaining <= 0) throw transportError("AZURE_TIMEOUT", false);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); action(); };
    const abort = () => finish(() => reject(transportError("AZURE_CANCELLED", false)));
    const timer = setTimeout(() => finish(() => reject(transportError("AZURE_TIMEOUT", false))), remaining); timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    void dnsLookup(hostname, { all: true, verbatim: true }).then((addresses) => finish(() => resolve(addresses)), () => finish(() => reject(transportError("AZURE_RESOLUTION", false))));
  });
}
async function boundedResolution<T>(operation: Promise<T>, signal: AbortSignal, deadlineAt: number): Promise<T> {
  if (signal.aborted) throw transportError("AZURE_CANCELLED", false);
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw transportError("AZURE_TIMEOUT", false);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); action(); };
    const abort = () => finish(() => reject(transportError("AZURE_CANCELLED", false)));
    const timer = setTimeout(() => finish(() => reject(transportError("AZURE_TIMEOUT", false))), remaining); timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    operation.then((value) => finish(() => resolve(value)), () => finish(() => reject(transportError("AZURE_RESOLUTION", false))));
  });
}
function verifiedRemoteAddress(remote: string | undefined, selected: string, dial: string, allowTestDial: boolean): string {
  if (remote === undefined) throw transportError("AZURE_PEER_MISMATCH", false);
  const normalized = remote.toLowerCase().split("%", 1)[0]!; const expected = selected.toLowerCase().split("%", 1)[0]!; const dialAddress = dial.toLowerCase().split("%", 1)[0]!;
  const matches = (candidate: string) => normalized === candidate || (normalized.startsWith("::ffff:") && normalized.slice(7) === candidate);
  if (allowTestDial && dialAddress !== expected) { if (!matches(dialAddress)) throw transportError("AZURE_PEER_MISMATCH", false); return selected; }
  if (!matches(expected) || !isPublicAddress(normalized)) throw transportError("AZURE_PEER_MISMATCH", false);
  return normalized;
}
