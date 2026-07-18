import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import https, { type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import {
  GovernedWebResearch,
  NodeHttpsResearchTransport,
  WebResearchPolicySchema,
  nodeHttpsResearchTransportForTest,
} from "../../src/research/web-research.js";

let root: string;
let server: Server;
let port: number;
let requests: string[];
let certificate: Buffer;

beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-node-https-")));
  const keyPath = path.join(root, "server.key");
  const certPath = path.join(root, "server.crt");
  const generated = spawnSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-subj", "/CN=docs.example.com", "-days", "1"], {
    shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8",
  });
  if (generated.status !== 0) throw new Error("test certificate generation failed");
  certificate = readFileSync(certPath);
  requests = [];
  server = https.createServer({ key: readFileSync(keyPath), cert: certificate }, (request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/redirect") {
      response.statusCode = 302; response.setHeader("location", "https://docs.example.com/success"); response.end("12345"); return;
    }
    if (request.url === "/slow") { setTimeout(() => { response.setHeader("content-type", "text/plain"); response.end("slow"); }, 500); return; }
    const body = request.url === "/large" ? "x".repeat(4_096) : "trusted compressed source";
    const compressed = gzipSync(body);
    response.setHeader("content-type", "text/plain"); response.setHeader("content-encoding", "gzip"); response.end(compressed);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test HTTPS server did not bind");
  port = address.port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("NodeHttpsResearchTransport production path", () => {
  it("validates TLS hostname/CA, pins DNS, checks the connected address, and decompresses", async () => {
    const transport = controlledTransport();
    const response = await transport.dispatch(input("/success"));
    expect(response).toMatchObject({ status: 200, tls: true, resolvedAddress: "93.184.216.34", decompressedBytes: 25 });
    expect(response.body.toString("utf8")).toBe("trusted compressed source");
    expect(response.compressedBytes).toBeLessThan(response.decompressedBytes + 32);
    expect(requests).toEqual(["/success"]);
  });

  it("executes redirects through URL policy and charges exact aggregate bytes before another dispatch", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const base = policy(10_000);
    const completed = await new GovernedWebResearch(journal, controlledTransport()).execute(request("/redirect", base.digest), base, new AbortController().signal);
    expect(completed).toMatchObject({ outcome: "completed", usage: { requests: 2 }, evidence: { provenance: { redirectHops: 1 } } });
    expect(requests).toEqual(["/redirect", "/success"]);
    journal.close();

    requests = [];
    const exact = policy(10);
    const exactJournal = new SqliteEventJournal(":memory:");
    const exhausted = await new GovernedWebResearch(exactJournal, controlledTransport()).execute(request("/redirect", exact.digest), exact, new AbortController().signal);
    expect(exhausted).toMatchObject({ outcome: "denied", reason: "budget_exhausted", usage: { requests: 1, compressedBytes: 5, decompressedBytes: 5 } });
    expect(requests).toEqual(["/redirect"]);
    exactJournal.close();
  });

  it("enforces compressed and decompressed limits on real responses", async () => {
    await expect(controlledTransport().dispatch({ ...input("/success"), maxCompressedBytes: 4 })).rejects.toMatchObject({ code: "WEB_COMPRESSED_LIMIT" });
    await expect(controlledTransport().dispatch({ ...input("/large"), maxDecompressedBytes: 100 })).rejects.toMatchObject({ code: "ERR_BUFFER_TOO_LARGE", dispatched: true });
  });

  it("rejects loopback resolution, remote-address mismatch, untrusted certificates, and wrong hostnames", async () => {
    await expect(new NodeHttpsResearchTransport({ resolver: async () => [{ address: "127.0.0.1", family: 4 }] }).dispatch(input("/success")))
      .rejects.toMatchObject({ code: "WEB_PRIVATE_TARGET", dispatched: false });
    await expect(new NodeHttpsResearchTransport({ resolver: publicResolver, dial: () => ({ address: "127.0.0.1", family: 4, port }), ca: certificate }).dispatch(input("/success")))
      .rejects.toMatchObject({ code: "WEB_PRIVATE_TARGET", dispatched: true });
    await expect(new NodeHttpsResearchTransport({ resolver: publicResolver, dial: () => ({ address: "127.0.0.1", family: 4, port }) }).dispatch(input("/success"))).rejects.toThrow();
    await expect(controlledTransport().dispatch({ ...input("/success"), url: new URL("https://other.example/success") })).rejects.toThrow();
  });

  it("honors pre-abort, cancellation races, and absolute deadlines", async () => {
    const pre = new AbortController(); pre.abort();
    await expect(controlledTransport().dispatch(input("/success", pre.signal))).rejects.toMatchObject({ code: "WEB_CANCELLED", dispatched: false });
    expect(requests).toEqual([]);

    const running = new AbortController();
    const cancelled = controlledTransport().dispatch(input("/slow", running.signal));
    setTimeout(() => running.abort(), 25);
    await expect(cancelled).rejects.toMatchObject({ code: "WEB_CANCELLED" });

    await expect(controlledTransport().dispatch({ ...input("/slow"), timeoutMs: 20, deadlineAt: Date.now() + 20 })).rejects.toMatchObject({ code: "WEB_TIMEOUT" });
    await expect(controlledTransport().dispatch({ ...input("/success"), deadlineAt: Date.now() - 1 })).rejects.toMatchObject({ code: "WEB_TIMEOUT", dispatched: false });
  });
});

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }] as const;
function controlledTransport() {
  return nodeHttpsResearchTransportForTest({ resolver: publicResolver, dial: () => ({ address: "127.0.0.1", family: 4, port }), ca: certificate });
}
function input(pathname: string, signal = new AbortController().signal) {
  return { method: "GET" as const, url: new URL(`https://docs.example.com${pathname}`), timeoutMs: 1_000, deadlineAt: Date.now() + 1_000,
    maxCompressedBytes: 10_000, maxDecompressedBytes: 10_000, signal };
}
function policy(maxBytes: number) {
  return WebResearchPolicySchema.parse({ schemaVersion: 1, destinations: [{ origin: "https://docs.example.com", pathPrefix: "/" }], contentTypes: ["text/plain"],
    maxRedirects: 2, maxCompressedBytes: 10_000, maxDecompressedBytes: 10_000, timeoutMs: 1_000,
    budget: { maxRequests: 3, maxBytes, maxTimeMs: 2_000 } });
}
function request(pathname: string, policyDigest: string) {
  return { schemaVersion: 1 as const, requestId: `request-${pathname.slice(1)}`, taskId: "task-1", workerId: "worker-1", role: "researcher" as const,
    modelId: "provider/model", tool: "zentra_web_research" as const, method: "GET" as const, url: `https://docs.example.com${pathname}`,
    envelopeDigest: "a".repeat(64), policyDigest,
    trace: { traceId: "milestone-trace-1", correlationId: "milestone-trace-1" } };
}
