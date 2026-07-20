import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  WorkflowSurfaceError,
  type WorkflowChangePage,
  type WorkflowSurface,
  type WorkflowSurfaceErrorCode,
} from "../surfaces/workflow-surface.js";
import { MAX_RETAINED_ARTIFACT_BYTES } from "../contracts/artifact.js";
import { OPERATIONS_SCRIPT_SHA256, operationsHtml } from "./operations-ui.js";
import { CLI_CONTROL_AUTHORIZATION_SCHEME } from "../surfaces/http-workflow-client.js";

const TOKEN_BYTES = 32;
const DEFAULT_TOKEN_TTL_MS = 15 * 60_000;
const MAX_TOKEN_TTL_MS = 24 * 60 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SOURCE_TEXT_RESPONSE_BYTES = MAX_RETAINED_ARTIFACT_BYTES;
const MAX_SOURCE_TEXT_JSON_RESPONSE_BYTES = 7 * 1024 * 1024;
const CHANGE_PAGE_SIZE = 100;
const EVENT_POLL_MS = 250;
const EVENT_WAIT_MS = 15_000;
const MAX_AGENTTRAIL_HTML_BYTES = 2 * 1024 * 1024;
const MAX_AGENTTRAIL_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_AGENTTRAIL_STREAM_BYTES = 8 * 1024 * 1024;
const AGENTTRAIL_COOKIE_NAME = "zentra_agenttrail";
const AGENTTRAIL_COOKIE_PATH = "/agenttrail/";
const UI_CALLER = { actorId: "zentra-local-operator", channel: "ui" } as const;
const MAX_ACTOR_ID_BYTES = 128;
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export type GatewayReadiness = "starting" | "ready" | "degraded" | "stopping";

export interface GatewaySession {
  readonly address: { readonly host: "127.0.0.1"; readonly port: number };
  readonly ipv6Address: { readonly host: "::1"; readonly port: number };
  readonly origin: string;
  readonly expiresAt: string;
  readonly url: string;
}

export interface LoopbackGatewayOptions {
  readonly now?: () => Date;
  readonly tokenTtlMs?: number;
  readonly workflow?: WorkflowSurface;
  readonly cliControlTokenDigest?: Buffer;
}

interface AuthSession {
  readonly bearerDigest: Buffer;
  readonly csrfDigest: Buffer;
  readonly agentTrailDigest: Buffer;
  readonly expiresAt: number;
}

export interface AgentTrailAddress {
  readonly host: "127.0.0.1";
  readonly port: number;
}

export class LoopbackGateway {
  private readonly now: () => Date;
  private readonly tokenTtlMs: number;
  private workflow: WorkflowSurface | undefined;
  private ipv4Server: Server | null = null;
  private ipv6Server: Server | null = null;
  private bootstrapDigest: Buffer | null = null;
  private bootstrapExpiresAt = 0;
  private authSession: AuthSession | null = null;
  private readonly cliControlTokenDigest: Buffer | null;
  private agentTrailAddress: AgentTrailAddress | null = null;
  private ipv4Port = 0;
  private ipv6Port = 0;
  private readiness: GatewayReadiness = "starting";

  constructor(options: LoopbackGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.tokenTtlMs = boundedTtl(options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS);
    this.workflow = options.workflow;
    if (options.cliControlTokenDigest !== undefined && options.cliControlTokenDigest.length !== 32) {
      throw new Error("CLI control token digest must be SHA-256");
    }
    this.cliControlTokenDigest = options.cliControlTokenDigest === undefined
      ? null
      : Buffer.from(options.cliControlTokenDigest);
  }

  async start(): Promise<GatewaySession> {
    if (this.ipv4Server !== null || this.ipv6Server !== null) throw new Error("Loopback gateway is already started");
    this.readiness = "starting";
    const ipv4 = createServer((request, response) => { void this.handle("ipv4", request, response); });
    const ipv6 = createServer((request, response) => { void this.handle("ipv6", request, response); });
    this.ipv4Server = ipv4;
    this.ipv6Server = ipv6;
    try {
      this.ipv4Port = await listenLoopback(ipv4, "127.0.0.1");
      this.ipv6Port = await listenLoopback(ipv6, "::1");
      return this.rotateSession();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  rotateSession(): GatewaySession {
    if (this.ipv4Server === null || this.ipv6Server === null || !this.ipv4Server.listening || !this.ipv6Server.listening) {
      throw new Error("Loopback gateway must be bound before minting a session");
    }
    const bootstrapToken = randomBytes(TOKEN_BYTES).toString("base64url");
    this.bootstrapDigest = digestToken(bootstrapToken);
    this.bootstrapExpiresAt = this.now().getTime() + this.tokenTtlMs;
    this.authSession = null;
    const origin = `http://127.0.0.1:${this.ipv4Port}`;
    return {
      address: { host: "127.0.0.1", port: this.ipv4Port },
      ipv6Address: { host: "::1", port: this.ipv6Port },
      origin,
      expiresAt: new Date(this.bootstrapExpiresAt).toISOString(),
      url: `${origin}/#token=${bootstrapToken}`,
    };
  }

  setReadiness(readiness: GatewayReadiness): void {
    if (this.ipv4Server === null || this.ipv6Server === null) throw new Error("Loopback gateway is not started");
    if (this.readiness === "stopping" && readiness !== "stopping") throw new Error("Loopback gateway cannot leave stopping state");
    this.readiness = readiness;
  }

  setWorkflowSurface(workflow: WorkflowSurface): void {
    if (this.workflow !== undefined) throw new Error("Loopback gateway workflow surface is already configured");
    this.workflow = workflow;
  }

  setAgentTrailAddress(address: AgentTrailAddress): void {
    if (this.agentTrailAddress !== null) throw new Error("Loopback gateway AgentTrail address is already configured");
    if (this.ipv4Server === null || this.ipv6Server === null) throw new Error("Loopback gateway is not started");
    this.agentTrailAddress = validatedAgentTrailAddress(address);
  }

  replaceAgentTrailAddress(address: AgentTrailAddress): void {
    if (this.agentTrailAddress === null) throw new Error("Loopback gateway AgentTrail address is not configured");
    if (this.readiness !== "degraded") {
      throw new Error("Loopback gateway AgentTrail address replacement requires durable degraded state");
    }
    this.agentTrailAddress = validatedAgentTrailAddress(address);
  }

  async close(): Promise<void> {
    const servers = [this.ipv4Server, this.ipv6Server].filter((server): server is Server => server !== null);
    this.ipv4Server = null;
    this.ipv6Server = null;
    this.readiness = "stopping";
    this.bootstrapDigest = null;
    this.bootstrapExpiresAt = 0;
    this.authSession = null;
    this.ipv4Port = 0;
    this.ipv6Port = 0;
    const results = await Promise.allSettled(servers.map(closeServer));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed !== undefined) throw failed.reason;
  }

  private async handle(family: "ipv4" | "ipv6", request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.applyHeaders(response);
    const port = family === "ipv4" ? this.ipv4Port : this.ipv6Port;
    const expectedHost = family === "ipv4" ? `127.0.0.1:${port}` : `[::1]:${port}`;
    if (request.headers.host !== expectedHost) return this.respond(response, 421, { error: "misdirected_request" });
    const expectedOrigin = `http://${expectedHost}`;
    if (request.headers.origin !== undefined && request.headers.origin !== expectedOrigin) {
      return this.respond(response, 403, { error: "origin_rejected" });
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "", expectedOrigin);
    } catch {
      return this.respond(response, 400, { error: "invalid_request" });
    }
    if (url.pathname === "/healthz" && url.search === "" && isRead(request)) {
      return this.respond(response, 200, { status: this.readiness });
    }
    if (url.pathname === "/readyz" && url.search === "" && isRead(request)) {
      return this.respond(response, this.readiness === "ready" ? 200 : 503, { status: this.readiness });
    }
    if (family === "ipv6") return this.respond(response, 404, { error: "not_found" });
    if (url.pathname === "/" && url.search === "" && isRead(request)) return this.serveUi(response);
    if (request.method === "POST" && url.pathname === "/api/v1/session" && url.search === "") {
      return this.createSession(request, response, expectedOrigin);
    }
    if (url.pathname === "/api/v1/zentra" || url.pathname.startsWith("/api/v1/zentra/")) {
      return this.routeApi(request, response, url, expectedOrigin);
    }
    if (url.pathname === "/agenttrail" || url.pathname.startsWith("/agenttrail/")) {
      return this.routeAgentTrail(request, response, url);
    }
    if (!supportedMethod(request.method)) return this.respond(response, 405, { error: "method_not_allowed" });
    return this.respond(response, 404, { error: "not_found" });
  }

  private serveUi(response: ServerResponse): void {
    if (this.readiness !== "ready") return this.respond(response, 503, { error: "service_unavailable", status: this.readiness });
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("content-security-policy", `default-src 'none'; connect-src 'self'; frame-src 'self'; script-src 'sha256-${OPERATIONS_SCRIPT_SHA256}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    response.end(operationsHtml());
  }

  private async createSession(request: IncomingMessage, response: ServerResponse, expectedOrigin: string): Promise<void> {
    if (request.headers.origin !== expectedOrigin) return this.respond(response, 403, { error: "origin_rejected" });
    if (this.readiness !== "ready") return this.respond(response, 503, { error: "service_unavailable", status: this.readiness });
    const body = await this.readBody(request, response);
    if (body === null) return;
    if (typeof body.token !== "string" || Object.keys(body).length !== 1 ||
      !this.authorized(body.token, this.bootstrapDigest, this.bootstrapExpiresAt)) {
      return this.respond(response, 401, { error: "unauthorized" });
    }
    this.bootstrapDigest = null;
    const bearerToken = randomBytes(TOKEN_BYTES).toString("base64url");
    const csrfToken = randomBytes(TOKEN_BYTES).toString("base64url");
    const agentTrailToken = randomBytes(TOKEN_BYTES).toString("base64url");
    const expiresAt = this.now().getTime() + this.tokenTtlMs;
    this.authSession = {
      bearerDigest: digestToken(bearerToken),
      csrfDigest: digestToken(csrfToken),
      agentTrailDigest: digestToken(agentTrailToken),
      expiresAt,
    };
    const maxAgeSeconds = Math.max(1, Math.ceil((expiresAt - this.now().getTime()) / 1_000));
    // This credential is browser-inaccessible and is sent only to the read-only AgentTrail namespace.
    response.setHeader("set-cookie", `${AGENTTRAIL_COOKIE_NAME}=${agentTrailToken}; Path=${AGENTTRAIL_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`);
    return this.respond(response, 201, {
      bearerToken,
      csrfToken,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  private async routeAgentTrail(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!isRead(request)) return this.respond(response, 405, { error: "method_not_allowed" });
    if (this.readiness !== "ready") {
      return this.respond(response, 503, { error: "service_unavailable", status: this.readiness });
    }
    if (this.agentTrailAddress === null) return this.respond(response, 503, { error: "agenttrail_unavailable" });
    if (url.searchParams.has("token")) return this.respond(response, 400, { error: "invalid_request" });
    const cookieToken = scopedCookie(request.headers.cookie, AGENTTRAIL_COOKIE_NAME);
    if (cookieToken === null || !this.authorized(
      cookieToken,
      this.authSession?.agentTrailDigest ?? null,
      this.authSession?.expiresAt ?? 0,
    )) return this.respond(response, 401, { error: "unauthorized" });

    const upstreamPath = url.pathname === "/agenttrail" ? "/" : url.pathname.slice("/agenttrail".length);
    if (!upstreamPath.startsWith("/") || upstreamPath.includes("\\") || /%2f|%5c/i.test(upstreamPath)) {
      return this.respond(response, 400, { error: "invalid_request" });
    }
    const query = new URLSearchParams(url.searchParams);
    const target = `${upstreamPath}${query.size === 0 ? "" : `?${query.toString()}`}`;
    await this.proxyAgentTrail(request, response, target, upstreamPath === "/");
  }

  private proxyAgentTrail(
    request: IncomingMessage,
    response: ServerResponse,
    target: string,
    index: boolean,
  ): Promise<void> {
    const address = this.agentTrailAddress!;
    return new Promise((resolve) => {
      const upstreamRequest = httpRequest({
        host: address.host,
        port: address.port,
        method: request.method,
        path: target,
        agent: false,
        headers: { accept: index ? "text/html" : (request.headers.accept ?? "*/*") },
      }, (upstream) => {
        const status = upstream.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          upstream.resume();
          this.respond(response, 502, { error: "agenttrail_redirect_rejected" });
          resolve();
          return;
        }
        const contentType = typeof upstream.headers["content-type"] === "string"
          ? upstream.headers["content-type"]
          : "application/octet-stream";
        const stream = contentType.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
        const limit = index ? MAX_AGENTTRAIL_HTML_BYTES : stream ? MAX_AGENTTRAIL_STREAM_BYTES : MAX_AGENTTRAIL_RESPONSE_BYTES;
        const declared = upstream.headers["content-length"];
        if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > limit)) {
          upstream.destroy();
          this.respond(response, 502, { error: "agenttrail_response_too_large" });
          resolve();
          return;
        }
        if (stream) {
          this.applyAgentTrailHeaders(response, status, contentType);
          if (request.method === "HEAD") { upstream.resume(); response.end(); resolve(); return; }
          let size = 0;
          upstream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
              upstream.destroy();
              response.destroy();
              return;
            }
            response.write(chunk);
          });
          upstream.once("end", () => { if (!response.destroyed) response.end(); resolve(); });
          upstream.once("error", () => { if (!response.destroyed) response.destroy(); resolve(); });
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        upstream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) { upstream.destroy(); return; }
          chunks.push(chunk);
        });
        upstream.once("error", () => {
          if (!response.writableEnded) this.respond(response, 502, { error: "agenttrail_proxy_failed" });
          resolve();
        });
        upstream.once("end", () => {
          if (size > limit) {
            this.respond(response, 502, { error: "agenttrail_response_too_large" });
            resolve();
            return;
          }
          let body = Buffer.concat(chunks);
          if (index && status >= 200 && status < 300) {
            body = Buffer.from(body.toString("utf8").replaceAll("/api/v1/", "/agenttrail/api/v1/"), "utf8");
            if (body.length > MAX_AGENTTRAIL_HTML_BYTES) {
              this.respond(response, 502, { error: "agenttrail_response_too_large" });
              resolve();
              return;
            }
          }
          this.applyAgentTrailHeaders(response, status, index ? "text/html; charset=utf-8" : contentType);
          response.end(request.method === "HEAD" ? undefined : body);
          resolve();
        });
      });
      upstreamRequest.once("error", () => {
        if (!response.writableEnded) this.respond(response, 502, { error: "agenttrail_unavailable" });
        resolve();
      });
      upstreamRequest.end();
    });
  }

  private applyAgentTrailHeaders(response: ServerResponse, statusCode: number, contentType: string): void {
    response.statusCode = statusCode;
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", contentType);
    response.setHeader("content-security-policy", "default-src 'none'; connect-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "SAMEORIGIN");
    response.removeHeader("content-length");
    response.removeHeader("location");
    response.removeHeader("set-cookie");
  }

  private async routeApi(request: IncomingMessage, response: ServerResponse, url: URL, expectedOrigin: string): Promise<void> {
    const authentication = this.authenticate(request);
    if (authentication === null) return this.respond(response, 401, { error: "unauthorized" });
    if (this.workflow === undefined) return this.respond(response, 503, { error: "workflow_unavailable" });
    const mutation = request.method !== "GET" && request.method !== "HEAD";
    if (authentication === "ui" && mutation && request.headers.origin !== expectedOrigin) return this.respond(response, 403, { error: "origin_rejected" });
    if (authentication === "ui" && mutation && !this.csrfAuthorized(request.headers["x-csrf-token"])) return this.respond(response, 403, { error: "csrf_rejected" });
    const segments = url.pathname.split("/").filter(Boolean).slice(3);
    try {
      if (request.method === "GET" && segments.length === 1 && segments[0] === "runs" && url.search === "") {
        return this.jsonResult(response, await this.invoke("listRuns"));
      }
      if (request.method === "POST" && segments.length === 1 && segments[0] === "runs" && url.search === "") {
        const body = await this.readBody(request, response); if (body === null) return;
        const [input, caller] = this.commandBody(body, authentication);
        const result = await this.invoke("submitRun", input, caller);
        return this.jsonResult(response, result, 201);
      }
      if (segments[0] === "runs" && segments.length >= 2) {
        const runId = decodeSegment(segments[1]!, response); if (runId === null) return;
        if (request.method === "GET" && segments.length === 2 && url.search === "") return this.jsonResult(response, await this.invoke("getRun", runId));
        if (request.method === "GET" && segments.length === 5 && segments[2] === "sources" && segments[4] === "text" && url.search === "") {
          const sourceId = decodeSegment(segments[3]!, response); if (sourceId === null) return;
          const result = await this.invoke("getSourceText", runId, sourceId);
          return this.sourceTextResult(response, result, runId, sourceId);
        }
        if (request.method === "GET" && segments.length === 3 && segments[2] === "attention" && url.search === "") return this.jsonResult(response, await this.invoke("listAttention", runId));
        if (request.method === "POST" && segments.length === 3 && segments[2] === "cancel" && url.search === "") {
          const body = await this.readBody(request, response); if (body === null) return;
          const [input, caller] = this.commandBody(body, authentication);
          const result = await this.invoke("cancelRun", { ...input, runId }, caller);
          return this.jsonResult(response, result);
        }
      }
      if (segments[0] === "decisions" && segments.length >= 2) {
        const decisionId = decodeSegment(segments[1]!, response); if (decisionId === null) return;
        if (request.method === "GET" && segments.length === 2 && url.search === "") return this.jsonResult(response, await this.invoke("getDecision", decisionId));
        const actions = { "answer": "answerQuestion", "reject-question": "rejectQuestion", "approve-plan": "approvePlan", "reject-plan": "rejectPlan" } as const;
        const method = segments.length === 3 ? actions[segments[2] as keyof typeof actions] : undefined;
        if (request.method === "POST" && method !== undefined && url.search === "") {
          const body = await this.readBody(request, response); if (body === null) return;
          const [input, caller] = this.commandBody(body, authentication);
          const result = await this.invoke(method, { ...input, decisionId }, caller);
          return this.jsonResult(response, result);
        }
      }
      if (request.method === "GET" && segments.length === 1 && segments[0] === "events") return this.streamEvents(request, response, url);
      if (!supportedMethod(request.method)) return this.respond(response, 405, { error: "method_not_allowed" });
      return this.respond(response, 404, { error: "not_found" });
    } catch (error) {
      return this.surfaceError(response, error);
    }
  }

  private async streamEvents(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const queryValues = url.searchParams.getAll("cursor");
    if ([...url.searchParams.keys()].some((key) => key !== "cursor") || queryValues.length > 1) return this.respond(response, 400, { error: "invalid_cursor" });
    const header = request.headers["last-event-id"];
    if (Array.isArray(header)) return this.respond(response, 400, { error: "invalid_cursor" });
    const raw = header ?? queryValues[0] ?? "0";
    if (!/^(0|[1-9][0-9]{0,15})$/.test(raw)) return this.respond(response, 400, { error: "invalid_cursor" });
    const after = Number(raw);
    if (!Number.isSafeInteger(after)) return this.respond(response, 400, { error: "invalid_cursor" });
    let page = await this.changePage(after);
    if (after > page.highWaterPosition) {
      return this.respond(response, 409, { error: "cursor_unavailable", cursor: page.highWaterPosition });
    }
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();
    const deadline = Date.now() + EVENT_WAIT_MS;
    while (page.changes.length === 0 && !response.destroyed && Date.now() < deadline) {
      await delay(EVENT_POLL_MS);
      try {
        page = await this.changePage(after);
      } catch (error) {
        const code = error instanceof WorkflowSurfaceError ? error.code : "internal";
        response.end(`event: error\ndata: ${JSON.stringify({ error: code })}\n\n`);
        return;
      }
    }
    if (response.destroyed) return;
    for (const change of page.changes) {
      response.write(`id: ${change.globalPosition}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`);
    }
    response.end(page.changes.length === 0
      ? `event: ready\ndata: {"cursor":${page.highWaterPosition}}\n\n`
      : `event: page\ndata: {"cursor":${page.nextCursor},"highWaterPosition":${page.highWaterPosition},"hasMore":${page.hasMore}}\n\n`);
  }

  private async changePage(afterPosition: number): Promise<WorkflowChangePage> {
    const page = await this.invoke("getChanges", afterPosition, CHANGE_PAGE_SIZE) as WorkflowChangePage;
    const cursorAheadOfJournal = afterPosition > page.highWaterPosition && page.changes.length === 0 &&
      page.cursor === afterPosition && page.nextCursor === afterPosition && !page.hasMore;
    if (page.afterPosition !== afterPosition || page.cursor !== page.nextCursor ||
      !Number.isSafeInteger(page.nextCursor) || !Number.isSafeInteger(page.highWaterPosition) ||
      page.nextCursor < afterPosition || (!cursorAheadOfJournal && page.highWaterPosition < page.nextCursor) ||
      page.changes.length > CHANGE_PAGE_SIZE ||
      page.changes.some((change, index) => !Number.isSafeInteger(change.globalPosition) ||
        change.globalPosition <= afterPosition || change.globalPosition > page.nextCursor ||
        (index > 0 && change.globalPosition <= page.changes[index - 1]!.globalPosition)) ||
      (page.changes.at(-1)?.globalPosition ?? afterPosition) !== page.nextCursor ||
      page.hasMore !== (page.nextCursor < page.highWaterPosition)) {
      throw new WorkflowSurfaceError("internal", "workflow change page is contradictory");
    }
    return page;
  }

  private async invoke(method: keyof WorkflowSurface, ...args: unknown[]): Promise<unknown> {
    const operation = this.workflow![method];
    return Reflect.apply(operation as (...values: unknown[]) => unknown, this.workflow, args);
  }

  private async readBody(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null> {
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      this.respond(response, 415, { error: "unsupported_media_type" }); return null;
    }
    const declared = request.headers["content-length"];
    if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
      this.respond(response, 413, { error: "body_too_large" }); request.resume(); return null;
    }
    let size = 0; const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) { this.respond(response, 413, { error: "body_too_large" }); request.destroy(); return null; }
        chunks.push(bytes);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isObject(parsed)) throw new Error("body must be an object");
      return parsed;
    } catch {
      if (!response.writableEnded) this.respond(response, 400, { error: "invalid_json" });
      return null;
    }
  }

  private commandBody(body: Record<string, unknown>, authentication: "ui" | "cli"): readonly [Record<string, unknown>, { readonly actorId: string; readonly channel: "ui" | "cli" }] {
    if (authentication === "ui") return [body, UI_CALLER];
    const { actorId, ...input } = body;
    if (typeof actorId !== "string" || actorId.trim() !== actorId || actorId.length === 0 ||
      Buffer.byteLength(actorId, "utf8") > MAX_ACTOR_ID_BYTES || /[\u0000-\u001f\u007f]/.test(actorId)) {
      throw new WorkflowSurfaceError("invalid_transition", "CLI actor identity is invalid");
    }
    return [input, { actorId, channel: "cli" }];
  }

  private authenticate(request: IncomingMessage): "ui" | "cli" | null {
    const authorization = request.headers.authorization;
    if (authorization === undefined || authorization.includes(",")) return null;
    if (authorization.startsWith("Bearer ") &&
      this.authorized(authorization.slice(7), this.authSession?.bearerDigest ?? null, this.authSession?.expiresAt ?? 0)) return "ui";
    const prefix = `${CLI_CONTROL_AUTHORIZATION_SCHEME} `;
    if (authorization.startsWith(prefix) && this.authorizedDigest(authorization.slice(prefix.length), this.cliControlTokenDigest)) return "cli";
    return null;
  }

  private csrfAuthorized(value: string | string[] | undefined): boolean {
    return typeof value === "string" && this.authorized(value, this.authSession?.csrfDigest ?? null, this.authSession?.expiresAt ?? 0);
  }

  private authorized(token: string, expected: Buffer | null, expiresAt: number): boolean {
    if (expected === null || this.now().getTime() >= expiresAt) return false;
    return timingSafeEqual(digestToken(token), expected);
  }

  private authorizedDigest(token: string, expected: Buffer | null): boolean {
    return expected !== null && /^[A-Za-z0-9_-]{43}$/.test(token) && timingSafeEqual(digestToken(token), expected);
  }

  private surfaceError(response: ServerResponse, error: unknown): void {
    const code: WorkflowSurfaceErrorCode = error instanceof WorkflowSurfaceError ? error.code : "internal";
    const status: Record<WorkflowSurfaceErrorCode, number> = {
      not_found: 404,
      stale: 409,
      consumed: 409,
      expired: 410,
      digest_mismatch: 409,
      invalid_transition: 409,
      uncertain: 503,
      unavailable: 503,
      internal: 500,
    };
    this.respond(response, status[code], { error: code });
  }

  private jsonResult(response: ServerResponse, result: unknown, statusCode = 200): void {
    if (result === null) return this.respond(response, 404, { error: "not_found" });
    if (result === undefined) return this.respond(response, statusCode, {});
    response.statusCode = statusCode;
    response.end(JSON.stringify(result));
  }

  private sourceTextResult(response: ServerResponse, result: unknown, runId: string, sourceId: string): void {
    if (!isObject(result)) throw new WorkflowSurfaceError("internal", "source text response is invalid");
    const text = result["text"];
    const sizeBytes = result["sizeBytes"];
    const acceptedMaxBytes = result["acceptedMaxBytes"];
    const artifact = result["artifact"];
    const digest = result["digest"];
    if (result["schemaVersion"] !== 1 || result["runId"] !== runId || result["sourceId"] !== sourceId ||
      typeof result["relativePath"] !== "string" || Buffer.byteLength(result["relativePath"], "utf8") > 4_096 ||
      result["mediaType"] !== "text/plain; charset=utf-8" || result["trust"] !== "untrusted_planning_data" ||
      typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || !isObject(artifact) ||
      artifact["artifactId"] !== `intake-text-v1:${digest}` || artifact["sha256"] !== digest ||
      artifact["sizeBytes"] !== sizeBytes || typeof text !== "string" ||
      !Number.isSafeInteger(sizeBytes) || !Number.isSafeInteger(acceptedMaxBytes) ||
      (sizeBytes as number) < 0 || (acceptedMaxBytes as number) < 1 ||
      (sizeBytes as number) > (acceptedMaxBytes as number) ||
      (acceptedMaxBytes as number) > MAX_SOURCE_TEXT_RESPONSE_BYTES ||
      Buffer.byteLength(text, "utf8") !== sizeBytes) {
      throw new WorkflowSurfaceError("internal", "source text response exceeds its bound");
    }
    const encoded = JSON.stringify({
      schemaVersion: 1,
      runId,
      sourceId,
      relativePath: result["relativePath"],
      sizeBytes,
      acceptedMaxBytes,
      digest,
      mediaType: result["mediaType"],
      trust: result["trust"],
      artifact: {
        artifactId: artifact["artifactId"],
        sha256: artifact["sha256"],
        sizeBytes: artifact["sizeBytes"],
      },
      text,
    });
    if (Buffer.byteLength(encoded, "utf8") > MAX_SOURCE_TEXT_JSON_RESPONSE_BYTES) {
      throw new WorkflowSurfaceError("internal", "source text JSON response exceeds its hard bound");
    }
    response.statusCode = 200;
    response.end(encoded);
  }

  private applyHeaders(response: ServerResponse): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    response.setHeader("content-type", "application/json; charset=utf-8");
  }

  private respond(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    response.statusCode = statusCode;
    response.end(JSON.stringify(body));
  }
}

function isRead(request: IncomingMessage): boolean { return request.method === "GET" || request.method === "HEAD"; }
function supportedMethod(method: string | undefined): boolean { return method === "GET" || method === "HEAD" || method === "POST"; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function decodeSegment(value: string, response: ServerResponse): string | null {
  try { const decoded = decodeURIComponent(value); if (decoded.length === 0 || decoded.includes("/")) throw new Error(); return decoded; }
  catch { response.statusCode = 400; response.end(JSON.stringify({ error: "invalid_request" })); return null; }
}

function listenLoopback(server: Server, host: "127.0.0.1" | "::1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    server.once("error", failed);
    server.listen({ host, port: 0, exclusive: true }, () => {
      server.off("error", failed);
      const address = server.address();
      if (address === null || typeof address === "string" || address.address !== host || address.port === 0) return reject(new Error(`Loopback gateway did not bind required host ${host}`));
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); });
}

function digestToken(token: string): Buffer { return createHash("sha256").update(token, "utf8").digest(); }

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function boundedTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TOKEN_TTL_MS) throw new RangeError("Gateway token TTL must be a positive bounded integer");
  return value;
}

function validatedAgentTrailAddress(address: AgentTrailAddress): AgentTrailAddress {
  if (address.host !== "127.0.0.1" || !Number.isSafeInteger(address.port) || address.port < 1 || address.port > 65_535) {
    throw new Error("Loopback gateway requires an exact AgentTrail loopback address");
  }
  return { host: "127.0.0.1", port: address.port };
}

function scopedCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  const values = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
