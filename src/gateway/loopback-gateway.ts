import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const TOKEN_BYTES = 32;
const CLEANUP_SCRIPT = 'history.replaceState(null,"","/");document.documentElement.dataset.location=location.href;';
const CLEANUP_SCRIPT_SHA256 = createHash("sha256").update(CLEANUP_SCRIPT, "utf8").digest("base64");
const DEFAULT_TOKEN_TTL_MS = 15 * 60_000;
const MAX_TOKEN_TTL_MS = 24 * 60 * 60_000;
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
}

export class LoopbackGateway {
  private readonly now: () => Date;
  private readonly tokenTtlMs: number;
  private ipv4Server: Server | null = null;
  private ipv6Server: Server | null = null;
  private bootstrapDigest: Buffer | null = null;
  private expiresAt = 0;
  private ipv4Port = 0;
  private ipv6Port = 0;
  private readiness: GatewayReadiness = "starting";

  constructor(options: LoopbackGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.tokenTtlMs = boundedTtl(options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS);
  }

  async start(): Promise<GatewaySession> {
    if (this.ipv4Server !== null || this.ipv6Server !== null) {
      throw new Error("Loopback gateway is already started");
    }
    this.readiness = "starting";
    const ipv4 = createServer((request, response) => this.handle("ipv4", request, response));
    const ipv6 = createServer((request, response) => this.handle("ipv6", request, response));
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
    this.expiresAt = this.now().getTime() + this.tokenTtlMs;
    const origin = `http://127.0.0.1:${this.ipv4Port}`;
    return {
      address: { host: "127.0.0.1", port: this.ipv4Port },
      ipv6Address: { host: "::1", port: this.ipv6Port },
      origin,
      expiresAt: new Date(this.expiresAt).toISOString(),
      url: `${origin}/?token=${bootstrapToken}`,
    };
  }

  setReadiness(readiness: GatewayReadiness): void {
    if (this.ipv4Server === null || this.ipv6Server === null) {
      throw new Error("Loopback gateway is not started");
    }
    if (this.readiness === "stopping" && readiness !== "stopping") {
      throw new Error("Loopback gateway cannot leave stopping state");
    }
    this.readiness = readiness;
  }

  async close(): Promise<void> {
    const servers = [this.ipv4Server, this.ipv6Server].filter((server): server is Server => server !== null);
    this.ipv4Server = null;
    this.ipv6Server = null;
    this.readiness = "stopping";
    this.bootstrapDigest = null;
    this.expiresAt = 0;
    this.ipv4Port = 0;
    this.ipv6Port = 0;
    const results = await Promise.allSettled(servers.map(closeServer));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed !== undefined) throw failed.reason;
  }

  private handle(family: "ipv4" | "ipv6", request: IncomingMessage, response: ServerResponse): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    response.setHeader("content-security-policy", `default-src 'none'; script-src 'sha256-${CLEANUP_SCRIPT_SHA256}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method !== "GET" && request.method !== "HEAD") {
      this.respond(response, 405, { error: "method_not_allowed" });
      return;
    }
    const port = family === "ipv4" ? this.ipv4Port : this.ipv6Port;
    const expectedHost = family === "ipv4" ? `127.0.0.1:${port}` : `[::1]:${port}`;
    if (request.headers.host !== expectedHost) {
      this.respond(response, 421, { error: "misdirected_request" });
      return;
    }
    const expectedOrigin = `http://${expectedHost}`;
    if (request.headers.origin !== undefined && request.headers.origin !== expectedOrigin) {
      this.respond(response, 403, { error: "origin_rejected" });
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "", expectedOrigin);
    } catch {
      this.respond(response, 400, { error: "invalid_request" });
      return;
    }
    if (url.pathname === "/healthz" && url.search === "") {
      this.respond(response, 200, { status: this.readiness });
      return;
    }
    if (url.pathname === "/readyz" && url.search === "") {
      this.respond(response, this.readiness === "ready" ? 200 : 503, { status: this.readiness });
      return;
    }
    if (family === "ipv6") {
      this.respond(response, 404, { error: "not_found" });
      return;
    }
    if (url.pathname !== "/") {
      this.respond(response, 404, { error: "not_found" });
      return;
    }
    if (url.search !== "") {
      this.bootstrap(request, response, url);
      return;
    }
    this.respond(response, 401, { error: "unauthorized" });
  }

  private bootstrap(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const tokens = url.searchParams.getAll("token");
    if (
      request.method !== "GET" ||
      [...url.searchParams.keys()].some((key) => key !== "token") ||
      tokens.length !== 1 ||
      !this.authorized(tokens[0]!, this.bootstrapDigest)
    ) {
      this.respond(response, 401, { error: "unauthorized" });
      return;
    }
    if (this.readiness !== "ready") {
      this.respond(response, 503, { error: "service_unavailable", status: this.readiness });
      return;
    }

    // Request handlers execute synchronously until return, so clearing first makes consumption atomic.
    this.bootstrapDigest = null;
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Zentra</title><style>body{font:16px system-ui;margin:3rem;max-width:42rem}h1{font-size:2rem}</style><script>${CLEANUP_SCRIPT}</script></head><body><h1>Zentra</h1><p>The local orchestration service is ready.</p></body></html>`);
  }

  private authorized(token: string | null, expected: Buffer | null): boolean {
    if (token === null || expected === null || this.now().getTime() >= this.expiresAt) return false;
    return timingSafeEqual(digestToken(token), expected);
  }

  private respond(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    response.statusCode = statusCode;
    response.end(JSON.stringify(body));
  }
}

function listenLoopback(server: Server, host: "127.0.0.1" | "::1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    server.once("error", failed);
    server.listen({ host, port: 0, exclusive: true }, () => {
      server.off("error", failed);
      const address = server.address();
      if (address === null || typeof address === "string" || address.address !== host || address.port === 0) {
        reject(new Error(`Loopback gateway did not bind required host ${host}`));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
    server.closeAllConnections();
  });
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function boundedTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TOKEN_TTL_MS) {
    throw new RangeError("Gateway token TTL must be a positive bounded integer");
  }
  return value;
}
