import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { TLSSocket } from "node:tls";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import { z } from "zod";

import { digestCanonical } from "../contracts/authority-attention.js";
import { foldStreamEvents, type EventJournal } from "../journal/journal.js";
import { isPublicAddress } from "../capsule/egress-policy.js";
import { researchDestinationAllows } from "./destination-policy.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentitySchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const TraceIdentitySchema = z.strictObject({
  traceId: z.string().min(1).max(512),
  correlationId: z.string().min(1).max(512),
});
const ContentTypeSchema = z.enum(["application/json", "application/xhtml+xml", "text/html", "text/markdown", "text/plain"]);
const DestinationSchema = z.strictObject({
  origin: z.string().transform((value, context) => {
    try {
      const url = canonicalWebUrl(value);
      if (url.pathname !== "/" || url.search !== "") throw new Error("origin contains path");
      return url.origin;
    } catch {
      context.addIssue({ code: "custom", message: "research destination must be a canonical HTTPS origin" });
      return z.NEVER;
    }
  }),
  pathPrefix: z.string().min(1).max(4_096).refine((value) => value.startsWith("/") && !value.includes("?") && !value.includes("#"), "invalid research path prefix"),
});
const RequiredWebResearchRequestSchema = z.strictObject({
  method: z.literal("GET"),
  url: z.string().transform((value, context) => {
    try {
      const url = canonicalWebUrl(value);
      if (url.search !== "" || url.href !== value) throw new Error("required URL is not canonical");
      return url.href;
    } catch {
      context.addIssue({ code: "custom", message: "required research request must be one canonical exact HTTPS GET URL" });
      return z.NEVER;
    }
  }),
  maxRequests: z.literal(1),
});

const WebResearchPolicyBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  destinations: z.array(DestinationSchema).min(1).max(128).superRefine(canonicalDestinations),
  requiredRequest: RequiredWebResearchRequestSchema.nullable().default(null),
  contentTypes: z.array(ContentTypeSchema).min(1).max(8).superRefine(canonicalStrings),
  maxRedirects: z.number().int().nonnegative().max(10),
  maxCompressedBytes: z.number().int().positive().max(64 * 1024 * 1024),
  maxDecompressedBytes: z.number().int().positive().max(64 * 1024 * 1024),
  timeoutMs: z.number().int().positive().max(120_000),
  citationMode: z.literal("all_exactly_once").default("all_exactly_once"),
  budget: z.strictObject({
    maxRequests: z.number().int().positive().max(1_000),
    maxBytes: z.number().int().positive().max(1024 * 1024 * 1024),
    maxTimeMs: z.number().int().positive().max(86_400_000),
  }),
}).superRefine((policy, context) => {
  if (policy.requiredRequest === null) return;
  const required = canonicalWebUrl(policy.requiredRequest.url);
  if (policy.budget.maxRequests !== 1 || !policy.destinations.some((destination) =>
    researchDestinationAllows(destination, required))) {
    context.addIssue({ code: "custom", message: "required research request must match one single-use destination" });
  }
});

const WebResearchPolicyOutputSchema = WebResearchPolicyBodySchema.extend({ digest: DigestSchema }).superRefine((policy, context) => {
  const { digest, ...body } = policy;
  if (digest !== digestCanonical(body)) context.addIssue({ code: "custom", message: "research policy digest mismatch" });
});
export const WebResearchPolicySchema = z.union([
  WebResearchPolicyBodySchema.transform((body) => Object.freeze({ ...body, digest: digestCanonical(body) })),
  WebResearchPolicyOutputSchema,
]);

export const WebResearchRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: IdentitySchema,
  taskId: IdentitySchema,
  workerId: IdentitySchema,
  role: z.enum(["planner", "researcher"]),
  modelId: z.string().min(1).max(512),
  tool: z.literal("zentra_web_research"),
  method: z.enum(["GET", "HEAD"]),
  url: z.string().min(1).max(16_384),
  envelopeDigest: DigestSchema,
  policyDigest: DigestSchema,
  trace: TraceIdentitySchema,
});
const ResultIdentitySchema = z.object({
  taskId: IdentitySchema, workerId: IdentitySchema,
  role: z.enum(["planner", "researcher", "implementer", "reviewer"]),
  modelId: z.string().min(1).max(512), tool: z.string().min(1).max(128),
  envelopeDigest: DigestSchema, policyDigest: DigestSchema,
  trace: TraceIdentitySchema,
});
const LegacyResultIdentitySchema = z.strictObject({
  taskId: IdentitySchema, workerId: IdentitySchema,
  role: z.enum(["planner", "researcher", "implementer", "reviewer"]),
  modelId: z.string().min(1).max(512), tool: z.string().min(1).max(128),
  envelopeDigest: DigestSchema, policyDigest: DigestSchema,
});

const SourceEvidenceBodySchema = z.strictObject({
  sourceUrl: z.string().url(),
  method: z.enum(["GET", "HEAD"]),
  querySha256: DigestSchema.nullable(),
  retrievedAt: z.string().datetime({ offset: true }),
  status: z.number().int().min(100).max(599),
  contentType: ContentTypeSchema,
  contentSha256: DigestSchema,
  compressedBytes: z.number().int().nonnegative(),
  decompressedBytes: z.number().int().nonnegative(),
  parent: z.strictObject({ workerId: IdentitySchema, modelId: z.string().min(1).max(512), tool: z.literal("zentra_web_research") }),
  envelopeDigest: DigestSchema,
  policyDigest: DigestSchema,
  provenance: z.strictObject({ transport: z.literal("zentra_https_broker"), redirectHops: z.number().int().nonnegative().max(10) }),
});
const SourceEvidenceSchema = SourceEvidenceBodySchema.extend({ evidenceId: DigestSchema }).superRefine((evidence, context) => {
  const { evidenceId, ...body } = evidence;
  if (evidenceId !== digestCanonical(body)) context.addIssue({ code: "custom", message: "source evidence digest mismatch" });
});

export const WebResearchResultSchema = z.strictObject({
  outcome: z.enum(["completed", "cancelled", "denied", "timed_out", "failed", "uncertain"]),
  reason: z.enum([
    "completed", "invalid_request", "destination_denied", "method_denied", "budget_exhausted",
    "redirect_denied", "content_type_denied", "compressed_size_exceeded", "decompressed_size_exceeded",
    "tls_required", "private_target_denied", "cancelled", "timed_out", "transport_failed", "transport_uncertain",
    "http_status_failed", "capability_attention", "execution_threw",
  ]),
  content: z.string().max(64 * 1024 * 1024).nullable(),
  evidence: SourceEvidenceSchema.nullable(),
  identity: z.strictObject({
    taskId: IdentitySchema, workerId: IdentitySchema,
    role: z.enum(["planner", "researcher", "implementer", "reviewer"]),
    modelId: z.string().min(1).max(512), tool: z.string().min(1).max(128),
    envelopeDigest: DigestSchema, policyDigest: DigestSchema,
    trace: TraceIdentitySchema,
  }),
  usage: z.strictObject({
    requests: z.number().int().nonnegative(), compressedBytes: z.number().int().nonnegative(),
    decompressedBytes: z.number().int().nonnegative(), elapsedMs: z.number().int().nonnegative(),
  }),
});

const JournalResultBodySchema = WebResearchResultSchema.omit({ content: true }).extend({
  requestId: IdentitySchema,
  requestDigest: DigestSchema,
  elapsedMs: z.number().int().nonnegative(),
});
const JournalResultSchema = JournalResultBodySchema.extend({ eventDigest: DigestSchema }).superRefine((result, context) => {
  const { eventDigest, ...body } = result;
  if (eventDigest !== digestCanonical(body)) context.addIssue({ code: "custom", message: "web research event digest mismatch" });
});
const LegacyJournalResultBodySchema = WebResearchResultSchema.omit({ content: true, identity: true }).extend({
  identity: LegacyResultIdentitySchema,
  requestId: IdentitySchema,
  requestDigest: DigestSchema,
  elapsedMs: z.number().int().nonnegative(),
});
const LegacyJournalResultSchema = LegacyJournalResultBodySchema.extend({ eventDigest: DigestSchema }).superRefine((result, context) => {
  const { eventDigest, ...body } = result;
  if (eventDigest !== digestCanonical(body)) context.addIssue({ code: "custom", message: "legacy web research event digest mismatch" });
});

export type WebResearchPolicy = z.output<typeof WebResearchPolicySchema>;
export type WebResearchRequest = z.infer<typeof WebResearchRequestSchema>;
export type WebResearchResult = z.infer<typeof WebResearchResultSchema>;
export type WebSourceEvidence = z.infer<typeof SourceEvidenceSchema>;
type BareWebResearchResult = Omit<WebResearchResult, "identity" | "usage">;

export function webResearchTerminalResult(
  rawRequest: unknown,
  outcome: "cancelled" | "denied" | "failed" | "timed_out",
  reason: "capability_attention" | "execution_threw",
): WebResearchResult {
  return WebResearchResultSchema.parse({
    outcome, reason, content: null, evidence: null, identity: ResultIdentitySchema.parse(rawRequest),
    usage: usage(0, 0, 0, 0),
  });
}

export interface WebResearchTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly compressedBytes: number;
  readonly decompressedBytes: number;
  readonly resolvedAddress: string;
  readonly tls: boolean;
  readonly dispatched: boolean;
}

export interface WebResearchTransport {
  dispatch(input: {
    readonly method: "GET" | "HEAD";
    readonly url: URL;
    readonly timeoutMs: number;
    readonly deadlineAt: number;
    readonly maxCompressedBytes: number;
    readonly maxDecompressedBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WebResearchTransportResponse>;
}

interface NodeHttpsResearchTransportOptions {
  readonly resolver?: typeof boundedLookup;
  readonly dial?: (selected: { readonly address: string; readonly family: number }) => { readonly address: string; readonly family: number; readonly port?: number };
  readonly ca?: Buffer;
  readonly allowNonPublicDialForTest?: boolean;
  readonly internalTestToken?: symbol;
}
const NODE_HTTPS_TEST_TOKEN = Symbol("zentra-node-https-test");

export class NodeHttpsResearchTransport implements WebResearchTransport {
  constructor(private readonly options: NodeHttpsResearchTransportOptions = {}) {
    if (options.allowNonPublicDialForTest === true && options.internalTestToken !== NODE_HTTPS_TEST_TOKEN) {
      throw new Error("non-public HTTPS dialing is test-only");
    }
  }

  async dispatch(input: Parameters<WebResearchTransport["dispatch"]>[0]): Promise<WebResearchTransportResponse> {
    const addresses = await (this.options.resolver ?? boundedLookup)(input.url.hostname, input.signal, input.deadlineAt);
    if (addresses.length === 0) throw transportError("WEB_RESOLUTION", false);
    if (addresses.some((entry) => !isPublicAddress(entry.address))) throw transportError("WEB_PRIVATE_TARGET", false);
    const selected = addresses[0]!;
    if (input.signal.aborted) throw transportError("WEB_CANCELLED", false);
    const remaining = Math.min(input.timeoutMs, input.deadlineAt - Date.now());
    if (remaining <= 0) throw transportError("WEB_TIMEOUT", false);
    const dial: { readonly address: string; readonly family: number; readonly port?: number } = this.options.dial?.(selected) ?? selected;
    let dispatched = false;
    return new Promise((resolve, reject) => {
      if (input.signal.aborted) return reject(transportError("WEB_CANCELLED", false));
      let request: import("node:http").ClientRequest | undefined;
      const abort = () => request === undefined
        ? reject(transportError("WEB_CANCELLED", false))
        : request.destroy(transportError("WEB_CANCELLED", dispatched));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) { abort(); return; }
      request = https.request(input.url, {
        method: input.method,
        ...(dial.port === undefined ? {} : { port: dial.port }),
        headers: { accept: "application/json, application/xhtml+xml, text/html, text/markdown, text/plain", "accept-encoding": "br, gzip, deflate", "user-agent": "Zentra-Governed-Research/1" },
        agent: false,
        rejectUnauthorized: true,
        ...(this.options.ca === undefined ? {} : { ca: this.options.ca }),
        servername: input.url.hostname,
        lookup: (_hostname, lookupOptions, callback) => {
          if ((lookupOptions as { all?: boolean }).all === true) {
            (callback as (error: null, addresses: readonly { address: string; family: number }[]) => void)(null, [dial]);
          } else {
            (callback as (error: null, address: string, family: number) => void)(null, dial.address, dial.family);
          }
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let compressedBytes = 0;
        let compressedLimitExceeded = false;
        const connectedAddress = response.socket.remoteAddress;
        const connectedTls = response.socket instanceof TLSSocket && response.socket.encrypted === true;
        response.on("data", (chunk: Buffer) => {
          compressedBytes += chunk.length;
          if (compressedBytes > input.maxCompressedBytes) {
            compressedLimitExceeded = true;
            response.destroy(transportError("WEB_COMPRESSED_LIMIT", true));
          }
          else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            if (compressedLimitExceeded) throw transportError("WEB_COMPRESSED_LIMIT", true);
            const compressed = Buffer.concat(chunks);
            const body = decompress(compressed, response.headers["content-encoding"], input.maxDecompressedBytes);
            resolve({
              status: response.statusCode ?? 0,
              headers: canonicalHeaders(response.headers), body, compressedBytes, decompressedBytes: body.length,
              resolvedAddress: verifiedRemoteAddress(connectedAddress, selected.address, dial.address, this.options.allowNonPublicDialForTest === true),
              tls: connectedTls, dispatched: true,
            });
          } catch (error) { reject(markDispatched(error)); }
        });
        response.on("error", (error) => reject(markDispatched(error)));
      });
      const timer = setTimeout(() => request.destroy(transportError("WEB_TIMEOUT", dispatched)), remaining);
      timer.unref();
      request.on("socket", (socket) => socket.once("secureConnect", () => { dispatched = true; }));
      request.on("error", (error) => reject(error));
      request.on("close", () => { clearTimeout(timer); input.signal.removeEventListener("abort", abort); });
      request.end();
    });
  }
}

export function nodeHttpsResearchTransportForTest(
  options: Omit<NodeHttpsResearchTransportOptions, "allowNonPublicDialForTest" | "internalTestToken">,
): NodeHttpsResearchTransport {
  return new NodeHttpsResearchTransport({ ...options, allowNonPublicDialForTest: true, internalTestToken: NODE_HTTPS_TEST_TOKEN });
}

export class GovernedWebResearch {
  constructor(private readonly journal: EventJournal, private readonly transport: WebResearchTransport) {}

  async execute(rawRequest: unknown, rawPolicy: unknown, signal: AbortSignal): Promise<WebResearchResult> {
    const started = Date.now();
    const identity = ResultIdentitySchema.parse(rawRequest);
    let request: WebResearchRequest;
    let policy: WebResearchPolicy;
    try {
      request = WebResearchRequestSchema.parse(rawRequest);
      policy = WebResearchPolicySchema.parse(rawPolicy);
    } catch {
      return WebResearchResultSchema.parse({ outcome: "denied", reason: "invalid_request", content: null, evidence: null, identity, usage: usage(0, 0, 0, Date.now() - started) });
    }
    const streamId = `web-research:${request.taskId}`;
    const prior = foldStreamEvents(this.journal, streamId, {
      version: 0,
      duplicate: false,
      usedRequests: 0,
      usedBytes: 0,
      usedTime: 0,
    }, (state, event) => {
      const entry = parseJournalResult(event.payload);
      return {
        version: event.streamVersion,
        duplicate: state.duplicate || entry.requestId === request.requestId,
        usedRequests: state.usedRequests + entry.usage.requests,
        usedBytes: state.usedBytes + entry.usage.compressedBytes + entry.usage.decompressedBytes,
        usedTime: state.usedTime + entry.usage.elapsedMs,
      };
    });
    const requestDigest = digestCanonical(request);
    let requests = 0;
    let compressedBytes = 0;
    let decompressedBytes = 0;
    const append = (result: BareWebResearchResult, elapsedMs = Date.now() - started): WebResearchResult => {
      const safe = WebResearchResultSchema.parse({ ...result, identity, usage: usage(requests, compressedBytes, decompressedBytes, elapsedMs) });
      const { content: _content, ...journalResult } = safe;
      this.journal.append(streamId, prior.version, [{
        streamId,
        type: "web_research.observed",
        payload: journalEvent({ ...journalResult, requestId: request.requestId, requestDigest, elapsedMs }),
        causationId: null,
        correlationId: request.trace.correlationId,
      }]);
      return safe;
    };
    if (request.policyDigest !== policy.digest) return append(denied("invalid_request"), 0);
    if (policy.requiredRequest !== null &&
      (request.method !== policy.requiredRequest.method || request.url !== policy.requiredRequest.url)) {
      return append(denied("invalid_request"), 0);
    }
    if (prior.duplicate) return append(denied("invalid_request"), 0);
    const { usedRequests, usedBytes, usedTime } = prior;
    if (usedRequests >= policy.budget.maxRequests || usedBytes >= policy.budget.maxBytes || usedTime >= policy.budget.maxTimeMs) {
      return append(denied("budget_exhausted"), 0);
    }

    let current: URL;
    try { current = canonicalWebUrl(request.url); } catch { return append(denied("invalid_request"), 0); }
    let redirects = 0;
    const deadlineAt = started + Math.min(policy.timeoutMs, policy.budget.maxTimeMs - usedTime);
    while (true) {
      if (!destinationAllows(policy, current)) return append(denied("destination_denied"));
      if (signal.aborted) return append({ outcome: "cancelled", reason: "cancelled", content: null, evidence: null });
      if (usedRequests + requests >= policy.budget.maxRequests || usedBytes + compressedBytes + decompressedBytes >= policy.budget.maxBytes || Date.now() >= deadlineAt) {
        return append(denied("budget_exhausted"));
      }
      let response: WebResearchTransportResponse;
      try {
        requests += 1;
        response = await this.transport.dispatch({
          method: request.method, url: current, timeoutMs: Math.max(1, deadlineAt - Date.now()), deadlineAt,
          maxCompressedBytes: policy.maxCompressedBytes, maxDecompressedBytes: policy.maxDecompressedBytes, signal,
        });
      } catch (error) {
        const record = errorRecord(error);
        if (record.code === "WEB_CANCELLED" || signal.aborted) return append({ outcome: "cancelled", reason: "cancelled", content: null, evidence: null });
        if (record.code === "WEB_TIMEOUT") return append({ outcome: "timed_out", reason: "timed_out", content: null, evidence: null });
        if (record.code === "WEB_PRIVATE_TARGET") return append(failed("private_target_denied"));
        if (record.code === "WEB_COMPRESSED_LIMIT") return append(failed("compressed_size_exceeded"));
        if (record.code === "WEB_DECOMPRESSED_LIMIT") return append(failed("decompressed_size_exceeded"));
        if (record.code === "WEB_CONTENT_ENCODING") return append(failed("content_type_denied"));
        return append({ outcome: record.dispatched ? "uncertain" : "failed", reason: record.dispatched ? "transport_uncertain" : "transport_failed", content: null, evidence: null });
      }
      compressedBytes += response.compressedBytes;
      decompressedBytes += response.decompressedBytes;
      if (Date.now() >= deadlineAt) return append({ outcome: "timed_out", reason: "timed_out", content: null, evidence: null });
      if (!response.tls) return append(failed("tls_required"));
      if (!isPublicAddress(response.resolvedAddress)) return append(failed("private_target_denied"));
      if (response.compressedBytes > policy.maxCompressedBytes) return append(failed("compressed_size_exceeded"));
      if (response.decompressedBytes > policy.maxDecompressedBytes || usedBytes + compressedBytes + decompressedBytes > policy.budget.maxBytes) return append(failed("decompressed_size_exceeded"));
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers["location"];
        if (location === undefined || redirects >= policy.maxRedirects) return append(denied("redirect_denied"));
        try { current = canonicalWebUrl(new URL(location, current).href); } catch { return append(denied("redirect_denied")); }
        redirects += 1;
        continue;
      }
      if (response.status < 200 || response.status >= 300) return append(failed("http_status_failed"));
      const contentType = normalizedContentType(response.headers["content-type"]);
      if (contentType === null || !policy.contentTypes.includes(contentType)) return append(failed("content_type_denied"));
      const contentSha256 = sha256(response.body);
      const sourceUrl = redactedSourceUrl(current);
      const evidenceBody = {
        sourceUrl,
        method: request.method,
        querySha256: current.search === "" ? null : sha256(Buffer.from(current.search.slice(1), "utf8")),
        retrievedAt: new Date().toISOString(), status: response.status, contentType, contentSha256,
        compressedBytes: response.compressedBytes, decompressedBytes: response.decompressedBytes,
        parent: { workerId: request.workerId, modelId: request.modelId, tool: request.tool },
        envelopeDigest: request.envelopeDigest, policyDigest: request.policyDigest,
        provenance: { transport: "zentra_https_broker", redirectHops: redirects },
      } as const;
      const evidence = SourceEvidenceSchema.parse({ ...evidenceBody, evidenceId: digestCanonical(evidenceBody) });
      return append({ outcome: "completed", reason: "completed", content: request.method === "HEAD" ? "" : response.body.toString("utf8"), evidence });
    }
  }
}

export function parseWebResearchEventPayload(type: string, payload: unknown): unknown {
  if (type !== "web_research.observed") throw new Error(`unknown web research event: ${type}`);
  return parseJournalResult(payload);
}

function parseJournalResult(payload: unknown): z.infer<typeof JournalResultSchema> | z.infer<typeof LegacyJournalResultSchema> {
  const current = JournalResultSchema.safeParse(payload);
  if (current.success) return current.data;
  return LegacyJournalResultSchema.parse(payload);
}

export function canonicalWebUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") throw new Error("research URL must be HTTPS without credentials or fragments");
  if (url.port !== "" && url.port !== "443") throw new Error("research URL port is not approved");
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) throw new Error("research URL must use a DNS host");
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/.test(url.hostname.toLowerCase())) throw new Error("research URL host is invalid");
  url.hostname = url.hostname.toLowerCase();
  url.port = "";
  return url;
}

function destinationAllows(policy: WebResearchPolicy, url: URL): boolean {
  return policy.destinations.some((destination) => researchDestinationAllows(destination, url));
}

function normalizedContentType(value: string | undefined): z.infer<typeof ContentTypeSchema> | null {
  const parsed = value?.split(";", 1)[0]?.trim().toLowerCase();
  const result = ContentTypeSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function redactedSourceUrl(url: URL): string {
  const copy = new URL(url.href);
  copy.search = "";
  return copy.href;
}

function denied(reason: "invalid_request" | "destination_denied" | "method_denied" | "budget_exhausted" | "redirect_denied"): BareWebResearchResult {
  return { outcome: "denied", reason, content: null, evidence: null };
}

function failed(reason: "content_type_denied" | "compressed_size_exceeded" | "decompressed_size_exceeded" | "tls_required" | "private_target_denied" | "http_status_failed"): BareWebResearchResult {
  return { outcome: "failed", reason, content: null, evidence: null };
}

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function errorRecord(error: unknown): { readonly code?: string; readonly dispatched?: boolean } {
  return typeof error === "object" && error !== null ? error as { code?: string; dispatched?: boolean } : {};
}
function journalEvent(body: z.input<typeof JournalResultBodySchema>): z.infer<typeof JournalResultSchema> {
  const parsed = JournalResultBodySchema.parse(body);
  return JournalResultSchema.parse({ ...parsed, eventDigest: digestCanonical(parsed) });
}
function transportError(code: string, dispatched: boolean): Error & { readonly code: string; readonly dispatched: boolean } {
  return Object.assign(new Error(code), { code, dispatched });
}
function markDispatched(error: unknown): Error & { readonly dispatched: true } {
  return Object.assign(error instanceof Error ? error : new Error("web transport failed"), { dispatched: true as const });
}
function decompress(value: Buffer, encoding: string | undefined, maximum: number): Buffer {
  const normalized = encoding?.trim().toLowerCase() ?? "identity";
  const options = { maxOutputLength: maximum };
  const output = normalized === "identity" ? value : normalized === "gzip" ? gunzipSync(value, options) :
    normalized === "deflate" ? inflateSync(value, options) : normalized === "br" ? brotliDecompressSync(value, options) :
      (() => { throw transportError("WEB_CONTENT_ENCODING", true); })();
  if (output.length > maximum) throw transportError("WEB_DECOMPRESSED_LIMIT", true);
  return output;
}
function canonicalHeaders(headers: import("node:http").IncomingHttpHeaders): Readonly<Record<string, string>> {
  const retained: Record<string, string> = {};
  for (const name of ["content-type", "content-encoding", "location"] as const) {
    const value = headers[name];
    if (typeof value === "string") retained[name] = value;
  }
  return retained;
}
function usage(requests: number, compressedBytes: number, decompressedBytes: number, elapsedMs: number) {
  return { requests, compressedBytes, decompressedBytes, elapsedMs };
}
async function boundedLookup(hostname: string, signal: AbortSignal, deadlineAt: number): Promise<readonly { readonly address: string; readonly family: number }[]> {
  if (signal.aborted) throw transportError("WEB_CANCELLED", false);
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw transportError("WEB_TIMEOUT", false);
  return new Promise<readonly { readonly address: string; readonly family: number }[]>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); action(); };
    const abort = () => finish(() => reject(transportError("WEB_CANCELLED", false)));
    const timer = setTimeout(() => finish(() => reject(transportError("WEB_TIMEOUT", false))), remaining);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    void dnsLookup(hostname, { all: true, verbatim: true }).then(
      (addresses) => finish(() => resolve(addresses)),
      () => finish(() => reject(transportError("WEB_RESOLUTION", false))),
    );
  });
}
function verifiedRemoteAddress(remote: string | undefined, selected: string, dial: string, allowNonPublicDialForTest: boolean): string {
  if (remote === undefined) throw transportError("WEB_PRIVATE_TARGET", true);
  const normalized = remote.toLowerCase().split("%", 1)[0]!;
  const expected = selected.toLowerCase().split("%", 1)[0]!;
  const dialNormalized = dial.toLowerCase().split("%", 1)[0]!;
  const matches = (candidate: string) => normalized === candidate || (normalized.startsWith("::ffff:") && normalized.slice(7) === candidate);
  if (allowNonPublicDialForTest && dialNormalized !== expected) {
    if (!matches(dialNormalized)) throw transportError("WEB_PRIVATE_TARGET", true);
    return selected;
  }
  if (!matches(expected) || !isPublicAddress(normalized)) throw transportError("WEB_PRIVATE_TARGET", true);
  return normalized;
}
function canonicalStrings(values: readonly string[], context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]! >= value)) context.addIssue({ code: "custom", message: "values must be sorted and unique" });
}
function canonicalDestinations(values: readonly { readonly origin: string; readonly pathPrefix: string }[], context: z.RefinementCtx): void {
  const identities = values.map((value) => `${value.origin}${value.pathPrefix}`);
  canonicalStrings(identities, context);
}
