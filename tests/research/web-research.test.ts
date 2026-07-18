import { describe, expect, it, vi } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { storedEventToAgentTailEvent } from "../../src/observability/agent-tail.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import {
  GovernedWebResearch,
  WebResearchPolicySchema,
  canonicalWebUrl,
  type WebResearchTransport,
} from "../../src/research/web-research.js";

const DIGEST = "a".repeat(64);

function policy() {
  return WebResearchPolicySchema.parse({
    schemaVersion: 1,
    destinations: [{ origin: "https://docs.example.com", pathPrefix: "/api/" }],
    contentTypes: ["application/json", "text/html", "text/plain"],
    maxRedirects: 2,
    maxCompressedBytes: 1_024,
    maxDecompressedBytes: 2_048,
    timeoutMs: 1_000,
    budget: { maxRequests: 3, maxBytes: 4_096, maxTimeMs: 3_000 },
  });
}

function request(url = "https://docs.example.com/api/page?token=secret&q=term") {
  return {
    schemaVersion: 1 as const,
    requestId: "request-1",
    taskId: "task-1",
    workerId: "researcher-1",
    role: "researcher" as const,
    modelId: "provider/model",
    tool: "zentra_web_research" as const,
    method: "GET" as const,
    url,
    envelopeDigest: DIGEST,
    policyDigest: policy().digest,
    trace: { traceId: "milestone-trace-1", correlationId: "milestone-trace-1" },
  };
}

function transport(steps: Parameters<WebResearchTransport["dispatch"]>[0][] = []): WebResearchTransport {
  return {
    dispatch: vi.fn(async (input) => {
      steps.push(input);
      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: Buffer.from("bounded evidence"),
        compressedBytes: 16,
        decompressedBytes: 16,
        resolvedAddress: "93.184.216.34",
        tls: true,
        dispatched: true,
      };
    }),
  };
}

describe("governed web research", () => {
  it("treats a non-directory destination path as exact", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const exact = WebResearchPolicySchema.parse({
      schemaVersion: 1,
      destinations: [{ origin: "https://docs.example.com", pathPrefix: "/exact" }],
      contentTypes: ["text/plain"],
      maxRedirects: 0,
      maxCompressedBytes: 1_024,
      maxDecompressedBytes: 1_024,
      timeoutMs: 1_000,
      budget: { maxRequests: 1, maxBytes: 2_048, maxTimeMs: 1_000 },
    });
    const calls: Parameters<WebResearchTransport["dispatch"]>[0][] = [];
    const result = await new GovernedWebResearch(journal, transport(calls)).execute(
      { ...request("https://docs.example.com/exact/child"), policyDigest: exact.digest },
      exact,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ outcome: "denied", reason: "destination_denied" });
    expect(calls).toHaveLength(0);
    journal.close();
  });

  it("canonicalizes HTTPS identity and rejects ambiguous or unsafe URLs", () => {
    expect(canonicalWebUrl("https://DOCS.example.com:443/a/../api/page?x=1").href).toBe("https://docs.example.com/api/page?x=1");
    for (const invalid of [
      "http://docs.example.com/api/", "https://user:pass@docs.example.com/api/",
      "https://docs.example.com:444/api/", "https://docs.example.com/api/#fragment",
      "https://127.0.0.1/api/", "https://[::1]/api/",
    ]) expect(() => canonicalWebUrl(invalid)).toThrow();
  });

  it("retains redacted source identity and provenance without raw query or content", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const result = await new GovernedWebResearch(journal, transport()).execute(request(), policy(), new AbortController().signal);
    expect(result).toMatchObject({
      outcome: "completed",
      content: "bounded evidence",
      evidence: {
        sourceUrl: "https://docs.example.com/api/page",
        method: "GET",
        status: 200,
        contentType: "text/plain",
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        parent: { workerId: "researcher-1", modelId: "provider/model", tool: "zentra_web_research" },
        envelopeDigest: DIGEST,
        policyDigest: policy().digest,
      },
    });
    expect(result.evidence?.querySha256).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(journal.readStream("web-research:task-1"));
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("bounded evidence");
    const trace = storedEventToAgentTailEvent(journal.readStream("web-research:task-1")[0]!);
    expect(trace).toMatchObject({
      trace_id: "milestone-trace-1",
      span_id: "web-research:request-1", parent_span_id: "worker:researcher-1",
      actor: { id: "researcher-1", role: "researcher" }, operation: { name: "web_research", status: "completed" },
      payload: { evidence: { sourceHost: "docs.example.com", sourcePathDigest: expect.stringMatching(/^[a-f0-9]{64}$/), method: "GET", status: 200, decompressedBytes: 16 } },
    });
    expect(JSON.stringify(trace)).not.toContain("token=secret");
    expect(JSON.stringify(trace)).not.toContain("/api/page");
    expect(journal.readStream("web-research:task-1")[0]?.correlationId).toBe("milestone-trace-1");
    journal.close();
  });

  it("denies role, method, destination, path, and public-address violations before dispatch", async () => {
    for (const mutation of [
      { role: "reviewer" }, { method: "POST" }, { url: "https://other.example/api/" },
      { url: "https://docs.example.com/private" },
    ] as const) {
      const network = transport();
      const journal = new SqliteEventJournal(":memory:");
      const result = await new GovernedWebResearch(journal, network).execute({ ...request(), ...mutation } as never, policy(), new AbortController().signal);
      expect(result.outcome).toBe("denied");
      expect(network.dispatch).not.toHaveBeenCalled();
      journal.close();
    }
  });

  it("revalidates every redirect and does not dispatch an out-of-policy hop", async () => {
    const calls: string[] = [];
    const network: WebResearchTransport = { dispatch: vi.fn(async (input) => {
      calls.push(input.url.href);
      return { status: 302, headers: { location: "https://private.example/secret" }, body: Buffer.alloc(0), compressedBytes: 0, decompressedBytes: 0, resolvedAddress: "93.184.216.34", tls: true, dispatched: true };
    }) };
    const journal = new SqliteEventJournal(":memory:");
    const result = await new GovernedWebResearch(journal, network).execute(request(), policy(), new AbortController().signal);
    expect(result).toMatchObject({ outcome: "denied", reason: "destination_denied" });
    expect(calls).toEqual(["https://docs.example.com/api/page?token=secret&q=term"]);
    journal.close();
  });

  it("charges redirects against request and byte budgets and passes a shrinking absolute deadline", async () => {
    const calls: number[] = [];
    const { digest: _digest, ...basePolicy } = policy();
    const limited = WebResearchPolicySchema.parse({ ...basePolicy, budget: { maxRequests: 1, maxBytes: 200, maxTimeMs: 3_000 } });
    const network: WebResearchTransport = { dispatch: vi.fn(async (input) => {
      calls.push(input.deadlineAt);
      return { status: 302, headers: { location: "https://docs.example.com/api/final" }, body: Buffer.alloc(60), compressedBytes: 60, decompressedBytes: 60, resolvedAddress: "93.184.216.34", tls: true, dispatched: true };
    }) };
    const journal = new SqliteEventJournal(":memory:");
    expect(await new GovernedWebResearch(journal, network).execute(
      { ...request(), policyDigest: limited.digest }, limited, new AbortController().signal,
    )).toMatchObject({ outcome: "denied", reason: "budget_exhausted", usage: { requests: 1, compressedBytes: 60, decompressedBytes: 60 } });
    expect(network.dispatch).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBeGreaterThan(Date.now());
    journal.close();
  });

  it("charges redirect bodies before a final response", async () => {
    let call = 0;
    const { digest: _digest, ...basePolicy } = policy();
    const limited = WebResearchPolicySchema.parse({ ...basePolicy, budget: { maxRequests: 3, maxBytes: 30, maxTimeMs: 3_000 } });
    const network: WebResearchTransport = { dispatch: vi.fn(async () => {
      call += 1;
      return call === 1
        ? { status: 302, headers: { location: "https://docs.example.com/api/final" }, body: Buffer.alloc(16), compressedBytes: 8, decompressedBytes: 16, resolvedAddress: "93.184.216.34", tls: true, dispatched: true }
        : { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.alloc(8), compressedBytes: 8, decompressedBytes: 8, resolvedAddress: "93.184.216.34", tls: true, dispatched: true };
    }) };
    const journal = new SqliteEventJournal(":memory:");
    expect(await new GovernedWebResearch(journal, network).execute(
      { ...request(), policyDigest: limited.digest }, limited, new AbortController().signal,
    )).toMatchObject({ outcome: "failed", reason: "decompressed_size_exceeded", usage: { requests: 2, compressedBytes: 16, decompressedBytes: 24 } });
    journal.close();
  });

  it("enforces content type, compressed and decompressed limits", async () => {
    for (const response of [
      { headers: { "content-type": "application/octet-stream" }, compressedBytes: 1, decompressedBytes: 1 },
      { headers: { "content-type": "text/plain" }, compressedBytes: 1_025, decompressedBytes: 1 },
      { headers: { "content-type": "text/plain" }, compressedBytes: 1, decompressedBytes: 2_049 },
    ]) {
      const network: WebResearchTransport = { dispatch: async () => ({ status: 200, body: Buffer.from("x"), resolvedAddress: "93.184.216.34", tls: true, dispatched: true, ...response }) };
      const journal = new SqliteEventJournal(":memory:");
      expect((await new GovernedWebResearch(journal, network).execute(request(), policy(), new AbortController().signal)).outcome).toBe("failed");
      journal.close();
    }
  });

  it.each([199, 404, 500])("fails non-2xx status %s without citable source evidence", async (status) => {
    const network: WebResearchTransport = { dispatch: async () => ({
      status, headers: { "content-type": "text/plain" }, body: Buffer.from("not accepted"),
      compressedBytes: 12, decompressedBytes: 12, resolvedAddress: "93.184.216.34", tls: true, dispatched: true,
    }) };
    const journal = new SqliteEventJournal(":memory:");
    const result = await new GovernedWebResearch(journal, network).execute(request(), policy(), new AbortController().signal);
    expect(result).toMatchObject({ outcome: "failed", reason: "http_status_failed", evidence: null });
    journal.close();
  });

  it("maps timeout, cancellation, and dispatched uncertainty without retry", async () => {
    for (const [error, outcome] of [
      [Object.assign(new Error("timeout"), { code: "WEB_TIMEOUT", dispatched: true }), "timed_out"],
      [Object.assign(new Error("cancelled"), { code: "WEB_CANCELLED", dispatched: false }), "cancelled"],
      [Object.assign(new Error("reset"), { code: "ECONNRESET", dispatched: true }), "uncertain"],
    ] as const) {
      const network: WebResearchTransport = { dispatch: vi.fn(async () => { throw error; }) };
      const journal = new SqliteEventJournal(":memory:");
      const result = await new GovernedWebResearch(journal, network).execute(request(), policy(), new AbortController().signal);
      expect(result.outcome).toBe(outcome);
      expect(network.dispatch).toHaveBeenCalledTimes(1);
      const trace = storedEventToAgentTailEvent(journal.readStream("web-research:task-1")[0]!);
      expect(trace).toMatchObject({ actor: { id: "researcher-1", role: "researcher" }, parent_span_id: "worker:researcher-1" });
      journal.close();
    }
  });

  it("replays budgets and refuses duplicate or exhausted requests after restart", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const broker = new GovernedWebResearch(journal, transport());
    await broker.execute(request(), policy(), new AbortController().signal);
    expect((await broker.execute(request(), policy(), new AbortController().signal)).outcome).toBe("denied");
    await broker.execute({ ...request(), requestId: "request-2" }, policy(), new AbortController().signal);
    await broker.execute({ ...request(), requestId: "request-3" }, policy(), new AbortController().signal);
    expect(await new GovernedWebResearch(journal, transport()).execute(
      { ...request(), requestId: "request-4" }, policy(), new AbortController().signal,
    )).toMatchObject({ outcome: "denied", reason: "budget_exhausted" });
    journal.close();
  });

  it("rejects forged event and source digests during replay", async () => {
    const source = new SqliteEventJournal(":memory:");
    await new GovernedWebResearch(source, transport()).execute(request(), policy(), new AbortController().signal);
    const event = source.readStream("web-research:task-1")[0]!;
    for (const payload of [
      { ...(event.payload as object), eventDigest: "b".repeat(64) },
      { ...(event.payload as any), evidence: { ...(event.payload as any).evidence, contentSha256: "b".repeat(64) } },
    ]) {
      const hostile = new SqliteEventJournal(":memory:");
      hostile.append(event.streamId, 0, [{ ...event, payload }]);
      await expect(new GovernedWebResearch(hostile, transport()).execute(
        { ...request(), requestId: "next" }, policy(), new AbortController().signal,
      )).rejects.toThrow();
      hostile.close();
    }
    source.close();
  });

  it("replays only the concrete legacy task-correlated event shape and writes new events with trace correlation", async () => {
    const source = new SqliteEventJournal(":memory:");
    await new GovernedWebResearch(source, transport()).execute(request(), policy(), new AbortController().signal);
    const current = source.readStream("web-research:task-1")[0]!;
    const currentPayload = current.payload as any;
    const { trace: _identityTrace, ...legacyIdentity } = currentPayload.identity;
    const { trace: _requestTrace, ...legacyRequest } = request();
    const { eventDigest: _eventDigest, ...currentBody } = currentPayload;
    const legacyBody = {
      ...currentBody,
      identity: legacyIdentity,
      requestDigest: digestCanonical(legacyRequest),
    };
    const legacyPayload = { ...legacyBody, eventDigest: digestCanonical(legacyBody) };
    const journal = new SqliteEventJournal(":memory:");
    journal.append(current.streamId, 0, [{
      streamId: current.streamId, type: current.type, payload: legacyPayload,
      causationId: null, correlationId: "task-1",
    }]);
    const next = await new GovernedWebResearch(journal, transport()).execute(
      { ...request(), requestId: "request-2" }, policy(), new AbortController().signal,
    );
    expect(next.outcome).toBe("completed");
    expect(journal.readStream("web-research:task-1").map((event) => event.correlationId))
      .toEqual(["task-1", "milestone-trace-1"]);
    source.close();
    journal.close();
  });
});
