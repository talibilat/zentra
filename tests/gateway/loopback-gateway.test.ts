import { createHash } from "node:crypto";
import { createServer, get, type IncomingHttpHeaders, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { CONSOLE_SCRIPT_SHA256 } from "../../src/gateway/console/console-ui.js";
import { LoopbackGateway } from "../../src/gateway/loopback-gateway.js";
import { WorkflowSurfaceError, type WorkflowSurface } from "../../src/surfaces/workflow-surface.js";

const caller = { actorId: "zentra-local-operator", channel: "ui" };

describe("LoopbackGateway", () => {
  it("hands a fragment bootstrap token off once and keeps session credentials out of URLs, storage, and HTML", async () => {
    const gateway = new LoopbackGateway({ workflow: workflow() });
    const session = await gateway.start();
    try {
      expect(new URL(session.url).search).toBe("");
      expect(new URL(session.url).hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/);
      expect((await fetch(session.url)).status).toBe(503);
      gateway.setReadiness("ready");

      const page = await fetch(session.url);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(page.headers.get("set-cookie")).toBeNull();
      expect(html).toContain("Zentra Agent Rail Console");
      expect(html).not.toContain(token(session));
      expect(html).toContain('history.replaceState(null,"","/")');
      expect(html).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
      expect(html).toContain('failure.error==="cursor_unavailable"');
      expect(html).toContain("state.cursor=0");
      expect(html).toContain('setText(button,"Expand source text")');
      expect(html).toContain('id="agenttrail-frame"');
      expect(html).toContain('title="AgentTrail evidence views"');
      expect(html).toContain('data-nav-id="trail"');
      expect(html).toContain('id="agenttrail-status"');
      expect(html).toContain('change.type==="gateway.degraded"');
      expect(html).toContain('change.type==="gateway.backfill_target"');
      expect(html).toContain('change.type==="gateway.recovered"');
      expect(html).not.toMatch(/innerHTML|outerHTML/);
      const script = html.match(/<script>([\s\S]+)<\/script>/)![1]!;
      expect(page.headers.get("content-security-policy")).toContain(
        `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
      );
      expect(page.headers.get("content-security-policy")).toContain(`'sha256-${CONSOLE_SCRIPT_SHA256}'`);

      const established = await establish(session);
      expect(established.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(established.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(established.agentTrailCookie).toMatch(/^zentra_agenttrail=[A-Za-z0-9_-]{43}; Path=\/agenttrail\/; HttpOnly; SameSite=Strict; Max-Age=[1-9][0-9]*$/);
      expect(JSON.stringify(established)).not.toContain(token(session));
      expect(JSON.stringify(established.body)).not.toContain("agentTrail");
      expect((await handoff(session)).status).toBe(401);
      expect((await fetch(`${session.origin}/`)).status).toBe(200);
    } finally {
      await gateway.close();
    }
  });

  it("proxies the authenticated AgentTrail UI, API, and SSE without leaking browser credentials", async () => {
    const upstream = await fakeAgentTrail();
    const gateway = new LoopbackGateway({ workflow: workflow() });
    const session = await gateway.start();
    gateway.setAgentTrailAddress(upstream.address);
    gateway.setReadiness("ready");
    try {
      expect(() => gateway.setAgentTrailAddress(upstream.address)).toThrow(/already configured/i);
      expect(() => gateway.replaceAgentTrailAddress(upstream.address)).toThrow(/degraded/i);
      const auth = await establish(session);
      const page = await fetch(`${session.origin}/agenttrail/`, { headers: {
        authorization: `Bearer ${auth.bearerToken}`,
        cookie: "browser=secret",
        "x-csrf-token": auth.csrfToken,
      } });
      expect(page.status).toBe(401);
      const authorizedPage = await fetch(`${session.origin}/agenttrail/`, { headers: {
        authorization: `Bearer ${auth.bearerToken}`,
        cookie: `${auth.agentTrailCookie.split(";", 1)[0]}; browser=secret`,
        "x-csrf-token": auth.csrfToken,
      } });
      const html = await authorizedPage.text();
      expect(authorizedPage.status).toBe(200);
      expect(html).toContain("AgentTrail");
      expect(html).toContain("Graph Tree Swimlane Sequence");
      expect(html).toContain("'/agenttrail/api/v1/runs'");
      expect(html).toContain("`/agenttrail/api/v1/events?cursor=${cursor}`");
      expect(authorizedPage.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(authorizedPage.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");

      const cookie = { cookie: auth.agentTrailCookie.split(";", 1)[0]! };
      const apiResponse = await fetch(`${session.origin}/agenttrail/api/v1/runs`, { headers: cookie });
      expect(await apiResponse.json()).toEqual([{ trace_id: "trace-1" }]);
      expect(apiResponse.headers.get("set-cookie")).toBeNull();
      expect(apiResponse.headers.get("access-control-allow-origin")).toBeNull();
      const headResponse = await fetch(`${session.origin}/agenttrail/api/v1/runs`, { method: "HEAD", headers: cookie });
      expect(headResponse.status).toBe(200);
      expect(await headResponse.text()).toBe("");
      const streamResponse = await fetch(`${session.origin}/agenttrail/api/v1/events?cursor=7`, { headers: cookie });
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
      expect(await streamResponse.text()).toContain("event: event");
      expect(upstream.requests.map(({ url }) => url)).toEqual(["/", "/api/v1/runs", "/api/v1/runs", "/api/v1/events?cursor=7"]);
      for (const request of upstream.requests) {
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers.cookie).toBeUndefined();
        expect(request.headers["x-csrf-token"]).toBeUndefined();
        expect(request.url).not.toContain("token");
      }

      expect((await fetch(`${session.origin}/agenttrail/api/v1/runs`, { method: "POST", headers: cookie })).status).toBe(405);
      expect((await fetch(`${session.origin}/agenttrail/oversized`, { headers: cookie })).status).toBe(502);
      const redirect = await fetch(`${session.origin}/agenttrail/redirect`, { redirect: "manual", headers: cookie });
      expect(redirect.status).toBe(502);
      expect(redirect.headers.get("location")).toBeNull();
      expect((await fetch(`${session.origin}/agenttrail/api/v1/runs`)).status).toBe(401);
      expect((await fetch(`${session.origin}/agenttrail/api/v1/runs?token=forbidden`, { headers: cookie })).status).toBe(400);

      const replacement = await fakeAgentTrail("trace-2");
      await upstream.close();
      gateway.setReadiness("degraded");
      gateway.replaceAgentTrailAddress(replacement.address);
      gateway.setReadiness("ready");
      try {
        const replaced = await fetch(`${session.origin}/agenttrail/api/v1/runs`, { headers: cookie });
        expect(await replaced.json()).toEqual([{ trace_id: "trace-2" }]);
      } finally {
        await replacement.close();
      }
    } finally {
      await gateway.close();
      await upstream.close().catch(() => undefined);
    }
  });

  it("enforces exact Host, Origin, bearer, CSRF, JSON media type, and body bounds", async () => {
    const gateway = new LoopbackGateway({ workflow: workflow() });
    const session = await gateway.start(); gateway.setReadiness("ready");
    try {
      expect((await handoff(session, "http://attacker.invalid")).status).toBe(403);
      const auth = await establish(session);
      expect((await fetch(`${session.origin}/api/v1/zentra/runs`)).status).toBe(401);
      expect((await fetch(`${session.origin}/api/v1/zentra/runs/run-1/sources/source-1/text`)).status).toBe(401);
      expect((await api(session, auth, "/runs", { headers: { origin: "http://attacker.invalid" } })).status).toBe(403);
      expect((await api(session, auth, "/runs", { method: "POST", body: "{}" })).status).toBe(403);
      expect((await api(session, auth, "/runs", { method: "POST", headers: mutationHeaders(session, auth) })).status).toBe(415);
      const oversized = "x".repeat(65 * 1024);
      expect((await api(session, auth, "/runs", { method: "POST", headers: { ...mutationHeaders(session, auth), "content-type": "application/json" }, body: JSON.stringify({ goal: oversized }) })).status).toBe(413);
      expect(await statusWithHost(session.address.port, "/api/v1/zentra/runs", "attacker.invalid")).toBe(421);
      const response = await api(session, auth, "/runs");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally { await gateway.close(); }
  });

  it("isolates exact CLI control authentication and forces bounded CLI actor evidence", async () => {
    const controlToken = "c".repeat(43);
    const surface = workflow();
    const gateway = new LoopbackGateway({
      workflow: surface,
      cliControlTokenDigest: createHash("sha256").update(controlToken).digest(),
    });
    const session = await gateway.start(); gateway.setReadiness("ready");
    try {
      const response = await fetch(`${session.origin}/api/v1/zentra/runs`, {
        method: "POST",
        headers: { authorization: `ZentraCLI ${controlToken}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "inline_goal", commandId: "cli-controlled-submit", goal: "Controlled", actorId: "cli-operator" }),
      });
      expect(response.status).toBe(201);
      expect(surface.submitRun).toHaveBeenCalledWith(
        { kind: "inline_goal", commandId: "cli-controlled-submit", goal: "Controlled" },
        { actorId: "cli-operator", channel: "cli" },
      );

      expect((await fetch(`${session.origin}/api/v1/zentra/runs`, {
        headers: { authorization: `Bearer ${controlToken}` },
      })).status).toBe(401);
      expect((await fetch(`${session.origin}/api/v1/zentra/runs`, {
        headers: { authorization: `ZentraCLI ${"d".repeat(43)}` },
      })).status).toBe(401);
      expect((await fetch(`${session.origin}/api/v1/zentra/runs?token=${controlToken}`)).status).toBe(401);
      expect((await fetch(`${session.origin}/api/v1/zentra/runs`, {
        headers: { cookie: `zentra_cli=${controlToken}` },
      })).status).toBe(401);
      expect((await fetch(`${session.origin}/api/v1/zentra/runs`, {
        method: "POST",
        headers: { authorization: `ZentraCLI ${controlToken}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "inline_goal", goal: "No actor" }),
      })).status).toBe(409);
      expect((await fetch(`${session.origin}/api/v1/zentra/runs`, {
        method: "POST",
        headers: { authorization: `ZentraCLI ${controlToken}`, origin: "http://attacker.invalid", "content-type": "application/json" },
        body: JSON.stringify({ kind: "inline_goal", goal: "Wrong origin", actorId: "operator" }),
      })).status).toBe(403);
    } finally { await gateway.close(); }
  });

  it("maps every workflow route to one shared surface with UI actor evidence and stable conflicts", async () => {
    const surface = workflow();
    const gateway = new LoopbackGateway({ workflow: surface });
    const session = await gateway.start(); gateway.setReadiness("ready");
    try {
      const auth = await establish(session);
      expect(await apiJson(session, auth, "/runs")).toEqual([{ runId: "run-1", lifecycle: "waiting" }]);
      expect(await apiJson(session, auth, "/runs/run-1")).toMatchObject({ run: { runId: "run-1" } });
      const sourceText = await api(session, auth, "/runs/run-1/sources/source-1/text");
      expect(sourceText.status).toBe(200);
      expect(sourceText.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await sourceText.json()).toEqual(expect.objectContaining({
        runId: "run-1", sourceId: "source-1", trust: "untrusted_planning_data",
        mediaType: "text/plain; charset=utf-8", digest: "a".repeat(64), sizeBytes: 45,
        text: '<script>globalThis.ticketAttack=true</script>',
      }));
      expect(surface.getSourceText).toHaveBeenCalledWith("run-1", "source-1");
      surface.getSourceText.mockReturnValueOnce({
        schemaVersion: 1, runId: "run-1", sourceId: "source-1", relativePath: "large.md",
        sizeBytes: 128, acceptedMaxBytes: 64, digest: "b".repeat(64),
        mediaType: "text/plain; charset=utf-8", trust: "untrusted_planning_data",
        artifact: { artifactId: `intake-text-v1:${"b".repeat(64)}`, sha256: "b".repeat(64), sizeBytes: 128 },
        text: "x".repeat(128),
      });
      expect((await api(session, auth, "/runs/run-1/sources/source-1/text")).status).toBe(500);
      expect(await apiJson(session, auth, "/runs/run-1/attention")).toEqual([{ decisionId: "decision-1", status: "pending" }]);
      expect(await apiJson(session, auth, "/decisions/decision-1")).toMatchObject({ decisionId: "decision-1" });

      const submission = { kind: "inline_goal", commandId: "ui-submit", goal: "Ship safely" };
      expect((await mutate(session, auth, "/runs", submission)).status).toBe(201);
      const command = { runId: "run-1", expectedVersion: 4, commandId: "command-1" };
      await mutate(session, auth, "/runs/run-1/cancel", { ...command, cancellationId: "cancel-1" });
      await mutate(session, auth, "/decisions/decision-1/answer", { ...command, optionId: "option-2" });
      await mutate(session, auth, "/decisions/decision-1/reject-question", { ...command, reason: "Need evidence" });
      await mutate(session, auth, "/decisions/decision-1/approve-plan", { ...command, planDigest: "a".repeat(64), envelopeDigest: "b".repeat(64) });
      await mutate(session, auth, "/decisions/decision-1/reject-plan", { ...command, reason: "Envelope too broad" });

      expect(surface.submitRun).toHaveBeenCalledWith(submission, caller);
      expect(surface.cancelRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", cancellationId: "cancel-1" }), caller);
      expect(surface.answerQuestion).toHaveBeenCalledWith(expect.objectContaining({ decisionId: "decision-1", optionId: "option-2" }), caller);
      expect(surface.approvePlan).toHaveBeenCalledWith(expect.objectContaining({ planDigest: "a".repeat(64), envelopeDigest: "b".repeat(64) }), caller);

      surface.answerQuestion.mockImplementationOnce(() => { throw new WorkflowSurfaceError("consumed", "dependency detail must not escape"); });
      const duplicate = await mutate(session, auth, "/decisions/decision-1/answer", { ...command, optionId: "option-2" });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toEqual({ error: "consumed" });
      expect((await api(session, auth, "/runs/missing")).status).toBe(404);
    } finally { await gateway.close(); }
  });

  it("serves exact-limit source text independently from bounded JSON envelope overhead", async () => {
    const surface = workflow();
    const gateway = new LoopbackGateway({ workflow: surface });
    const session = await gateway.start(); gateway.setReadiness("ready");
    try {
      const auth = await establish(session);
      for (const [text, escapeHeavy] of [
        ["x".repeat(1024 * 1024), false],
        ["\0".repeat(1024 * 1024), true],
      ] as const) {
        surface.getSourceText.mockReturnValueOnce(sourceText("run-1", "source-1", text));
        const response = await api(session, auth, "/runs/run-1/sources/source-1/text");
        const encoded = await response.text();
        expect(response.status).toBe(200);
        expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(7 * 1024 * 1024);
        if (escapeHeavy) expect(Buffer.byteLength(encoded, "utf8")).toBeGreaterThan(6 * 1024 * 1024);
        expect((JSON.parse(encoded) as { text: string }).text).toBe(text);
      }
    } finally { await gateway.close(); }
  });

  it("paginates durable global positions and reconnects through a reconstructed gateway", async () => {
    const changes = Array.from({ length: 205 }, (_, index) => change(index + 1, index % 2 === 0 ? "run.accepted" : "analysis.observed"));
    const firstSurface = workflow(changes);
    const gateway = new LoopbackGateway({ workflow: firstSurface });
    const session = await gateway.start(); gateway.setReadiness("ready");
    try {
      const auth = await establish(session);
      const first = await stream(session, auth, 0);
      expect(first).toContain("id: 1\nevent: change");
      expect(first).toContain("id: 100\nevent: change");
      expect(first).not.toContain("id: 101\nevent: change");
      expect(first).toContain('"hasMore":true');
      expect(first).not.toContain(auth.bearerToken);
      expect(first).not.toContain(auth.csrfToken);
      const second = await stream(session, auth, 100);
      expect(second).toContain("id: 101\nevent: change");
      expect(second).toContain("id: 200\nevent: change");
      expect(firstSurface.getChanges).toHaveBeenCalledWith(0, 100);
      expect(firstSurface.getChanges).toHaveBeenCalledWith(100, 100);
      expect((await api(session, auth, `/events?cursor=${auth.bearerToken}`)).status).toBe(400);
    } finally { await gateway.close(); }

    const reconstructedSurface = workflow(changes);
    const reconstructed = new LoopbackGateway({ workflow: reconstructedSurface });
    const resumed = await reconstructed.start(); reconstructed.setReadiness("ready");
    try {
      const auth = await establish(resumed);
      const final = await stream(resumed, auth, 200);
      expect(final).not.toContain("id: 200\n");
      expect(final).toContain("id: 201\nevent: change");
      expect(final).toContain("id: 205\nevent: change");
      expect(reconstructedSurface.getChanges).toHaveBeenCalledWith(200, 100);
      const unavailable = await api(resumed, auth, "/events?cursor=999", { headers: { "last-event-id": "999" } });
      expect(unavailable.status).toBe(409);
      expect(await unavailable.json()).toEqual({ error: "cursor_unavailable", cursor: 205 });
    } finally { await reconstructed.close(); }
  });

  it("maps only closed WorkflowSurfaceError codes and hides arbitrary dependency errors", async () => {
    const surface = workflow();
    const gateway = new LoopbackGateway({ workflow: surface });
    const session = await gateway.start(); gateway.setReadiness("ready");
    try {
      const auth = await establish(session);
      const mappings = [
        ["not_found", 404], ["stale", 409], ["consumed", 409], ["expired", 410],
        ["digest_mismatch", 409], ["invalid_transition", 409], ["unavailable", 503], ["internal", 500],
      ] as const;
      for (const [code, status] of mappings) {
        surface.listRuns.mockImplementationOnce(() => { throw new WorkflowSurfaceError(code, `secret ${code} dependency message`); });
        const response = await api(session, auth, "/runs");
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ error: code });
      }
      surface.listRuns.mockImplementationOnce(() => { throw Object.assign(new Error("database path /secret"), { code: "SQLITE_BUSY" }); });
      const arbitrary = await api(session, auth, "/runs");
      expect(arbitrary.status).toBe(500);
      expect(await arbitrary.json()).toEqual({ error: "internal" });
    } finally { await gateway.close(); }
  });

  it("keeps IPv4 and IPv6 health listeners while limiting the UI and API to IPv4", async () => {
    const gateway = new LoopbackGateway();
    const session = await gateway.start(); gateway.setReadiness("degraded");
    try {
      expect(await fetch(`${session.origin}/healthz`).then((value) => value.json())).toEqual({ status: "degraded" });
      expect((await fetch(`http://[::1]:${session.ipv6Address.port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://[::1]:${session.ipv6Address.port}/`)).status).toBe(404);
      expect((await fetch(`${session.origin}/readyz`)).status).toBe(503);
    } finally { await gateway.close(); }
    await expect(fetch(`${session.origin}/healthz`)).rejects.toThrow();
  });
});

interface FakeChange {
  readonly globalPosition: number;
  readonly eventId: string;
  readonly streamId: string;
  readonly streamVersion: number;
  readonly type: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly recordedAt: string;
  readonly payload: unknown;
}

function workflow(changes: FakeChange[] = []) {
  const append = (type: string): void => { changes.push(change((changes.at(-1)?.globalPosition ?? 0) + 1, type)); };
  return {
    submitRun: vi.fn((input: unknown) => { append("run.accepted"); return { runId: "run-new", input }; }),
    listRuns: vi.fn(() => [{ runId: "run-1", lifecycle: "waiting" }]),
    getRun: vi.fn((runId: string) => runId === "missing" ? null : ({ run: { runId, streamVersion: 4 }, planning: { readiness: { ready: false } } })),
    getSourceText: vi.fn((runId: string, sourceId: string) => ({ schemaVersion: 1, runId, sourceId,
      relativePath: "hostile.html", sizeBytes: 45, acceptedMaxBytes: 1024 * 1024, digest: "a".repeat(64),
      mediaType: "text/plain; charset=utf-8", trust: "untrusted_planning_data",
      artifact: { artifactId: `intake-text-v1:${"a".repeat(64)}`, sha256: "a".repeat(64), sizeBytes: 45 },
      text: '<script>globalThis.ticketAttack=true</script>' })),
    listAttention: vi.fn(() => [{ decisionId: "decision-1", status: "pending" }]),
    getDecision: vi.fn(() => ({ decisionId: "decision-1", runId: "run-1", streamVersion: 4, status: "pending", kind: "question" })),
    cancelRun: vi.fn((input: unknown) => ({ kind: "cancelled", input })),
    answerQuestion: vi.fn((input: unknown) => ({ kind: "answered", input })),
    rejectQuestion: vi.fn((input: unknown) => ({ kind: "question_rejected", input })),
    approvePlan: vi.fn((input: unknown) => ({ kind: "approved", input })),
    rejectPlan: vi.fn((input: unknown) => ({ kind: "plan_rejected", input })),
    getChanges: vi.fn((afterPosition: number, limit: number) => {
      const highWaterPosition = changes.at(-1)?.globalPosition ?? 0;
      const page = changes.filter(({ globalPosition }) => globalPosition > afterPosition).slice(0, limit);
      const nextCursor = page.at(-1)?.globalPosition ?? afterPosition;
      return { schemaVersion: 1, afterPosition, cursor: nextCursor, nextCursor, highWaterPosition,
        hasMore: nextCursor < highWaterPosition, changes: page };
    }),
  } as unknown as WorkflowSurface & {
    [K in keyof WorkflowSurface]: WorkflowSurface[K] & ReturnType<typeof vi.fn>;
  };
}

function sourceText(runId: string, sourceId: string, text: string) {
  const digest = "c".repeat(64);
  const sizeBytes = Buffer.byteLength(text, "utf8");
  return {
    schemaVersion: 1, runId, sourceId, relativePath: "exact-limit.txt",
    sizeBytes, acceptedMaxBytes: 1024 * 1024, digest,
    mediaType: "text/plain; charset=utf-8", trust: "untrusted_planning_data",
    artifact: { artifactId: `intake-text-v1:${digest}`, sha256: digest, sizeBytes },
    text,
  };
}

function change(globalPosition: number, type: string): FakeChange {
  return { globalPosition, eventId: `event-${globalPosition}`, streamId: "run:run-1", streamVersion: globalPosition,
    type, correlationId: "run-1", causationId: null, recordedAt: "2026-07-20T12:00:00.000Z",
    payload: { position: globalPosition } };
}

function token(session: { url: string }): string { return new URL(session.url).hash.slice("#token=".length); }
function handoff(session: { origin: string; url: string }, origin = session.origin): Promise<Response> {
  return fetch(`${session.origin}/api/v1/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: token(session) }) });
}
async function establish(session: { origin: string; url: string }) {
  const response = await handoff(session);
  expect(response.status).toBe(201);
  const agentTrailCookie = response.headers.get("set-cookie") ?? "";
  const body = await response.json() as { bearerToken: string; csrfToken: string; expiresAt: string };
  return { ...body, body, agentTrailCookie };
}
function api(session: { origin: string }, auth: { bearerToken: string }, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${session.origin}/api/v1/zentra${path}`, { ...init, headers: { authorization: `Bearer ${auth.bearerToken}`, ...init.headers } });
}
function mutationHeaders(session: { origin: string }, auth: { csrfToken: string }): Record<string, string> {
  return { origin: session.origin, "x-csrf-token": auth.csrfToken };
}
function mutate(session: { origin: string }, auth: { bearerToken: string; csrfToken: string }, path: string, body: unknown): Promise<Response> {
  return api(session, auth, path, { method: "POST", headers: { ...mutationHeaders(session, auth), "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function apiJson(session: { origin: string }, auth: { bearerToken: string }, path: string): Promise<unknown> {
  return api(session, auth, path).then((response) => response.json());
}
async function stream(session: { origin: string }, auth: { bearerToken: string }, cursor: number): Promise<string> {
  const response = await api(session, auth, `/events?cursor=${cursor}`, { headers: { "last-event-id": String(cursor) } });
  return response.text();
}
function statusWithHost(port: number, requestPath: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = get({ host: "127.0.0.1", port, path: requestPath, headers: { host } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
    request.once("error", reject);
  });
}

async function fakeAgentTrail(traceId = "trace-1"): Promise<{
  readonly address: { readonly host: "127.0.0.1"; readonly port: number };
  readonly requests: Array<{ readonly url: string; readonly headers: IncomingHttpHeaders }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ readonly url: string; readonly headers: IncomingHttpHeaders }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", headers: request.headers });
    if (request.url === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>AgentTrail</title><nav>Graph Tree Swimlane Sequence</nav><script>fetchJson('/api/v1/runs');new EventSource(`/api/v1/events?cursor=${cursor}`)</script>");
      return;
    }
    if (request.url === "/api/v1/runs") {
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", "upstream=unsafe");
      response.setHeader("access-control-allow-origin", "*");
      response.end(request.method === "HEAD" ? undefined : JSON.stringify([{ trace_id: traceId }]));
      return;
    }
    if (request.url === "/api/v1/events?cursor=7") {
      response.setHeader("content-type", "text/event-stream");
      response.end("event: event\ndata: {}\n\n");
      return;
    }
    if (request.url === "/oversized") {
      response.setHeader("content-length", String(5 * 1024 * 1024));
      response.end("too large");
      return;
    }
    if (request.url === "/redirect") {
      response.statusCode = 302;
      response.setHeader("location", "https://attacker.invalid/");
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const port = await listenTestServer(server);
  return {
    address: { host: "127.0.0.1", port },
    requests,
    close: () => closeTestServer(server),
  };
}

function listenTestServer(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("fake AgentTrail did not bind"));
      resolve(address.port);
    });
  });
}

function closeTestServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
