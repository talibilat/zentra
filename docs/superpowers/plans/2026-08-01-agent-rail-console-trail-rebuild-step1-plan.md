# Agent Rail Console, Trail Rebuild Step 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AgentTrail iframe in the Agent Rail Console's Trail section with a native Events log, inspector panel, and shared Trail chrome, reading real data through a new reshaping gateway route.

**Architecture:** A pure reshaping module (`trail-reshape.ts`) turns AgentTrail's existing `run_detail()` JSON into a small presentational model. A new gateway route (`GET /api/v1/zentra/runs/:id/trail`) fetches from AgentTrail server-to-server and runs it through that reshaping module. The console's `trail-section.ts` is rebuilt to render that data as a filterable event log with an inspector panel, replacing the iframe while keeping the existing degrade/recover banner untouched.

**Tech Stack:** TypeScript, Node's built-in `http` module (no new dependency), Vitest, real-Chromium e2e via the existing `ChromiumWorkflowDriver`.

## Global Constraints

- No external network calls from the console (`SECURITY.md`). The new route only talks to the already-local AgentTrail process at `this.agentTrailAddress`.
- No `innerHTML`/`outerHTML` with interpolated data anywhere in `trail-section.ts` — build DOM via `document.createElement` and `setText`, exactly like `overview-section.ts`.
- No new mutation command. Every new endpoint in this step is read-only (`GET` only).
- **Font-stack interpolation safety.** `CONSOLE_FONT_STACK_MONO`/`CONSOLE_FONT_STACK_SANS` (from `design-tokens.ts`) contain literal double quotes (e.g. `"IBM Plex Mono",ui-monospace,monospace`). A prior sub-phase's fix interpolated these into **double-quoted** JS string literals inside a `String.raw` template and broke the entire concatenated console script's syntax — invisible to unit tests, only caught by running the real-browser e2e suite. Any place you write `${CONSOLE_FONT_STACK_MONO}` or `${CONSOLE_FONT_STACK_SANS}` inside a JS string literal in a `String.raw` template **must** use single quotes around that string (`'...${CONSOLE_FONT_STACK_MONO}...'`), never double quotes. Task 3 isolates every such interpolation into two one-line constants for exactly this reason — do not inline the raw constants elsewhere.
- Existing `applyGatewayChange` degrade/recover banner behavior (`gateway.degraded`, `gateway.backfill_target`, `gateway.recovered`) must keep working unchanged; only what it does on `gateway.recovered` changes (re-fetch Trail data instead of reloading an iframe).
- Disabled Trail tabs (Graph, Tree, Swimlane) use the same `<button disabled aria-disabled="true">...<span class="badge">Phase 2</span></button>` pattern `shell.ts` already uses for disabled sidebar nav items — do not invent a new disabled-state convention.

---

### Task 1: Trail reshaping module

**Files:**
- Create: `src/gateway/console/trail-reshape.ts`
- Test: `tests/gateway/console/trail-reshape.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (first task).
- Produces: `export interface TrailEvidenceLink { readonly type: string; readonly refEventId: string }`, `export interface TrailEvent { readonly id: string; readonly offsetSeconds: number; readonly kind: string; readonly name: string; readonly summary: string; readonly actorId: string; readonly failed: boolean; readonly sequence: number | null; readonly evidence: readonly TrailEvidenceLink[]; readonly payload: unknown }`, `export interface TrailActor { readonly id: string; readonly role: string | null; readonly color: string; readonly glyph: string }`, `export interface TrailView { readonly runId: string; readonly durationSeconds: number; readonly events: readonly TrailEvent[]; readonly actors: readonly TrailActor[] }`, `export function reshapeTrail(raw: unknown): TrailView`. Task 2 imports `reshapeTrail` and `TrailView`.

- [ ] **Step 1: Write the failing tests**

Create `tests/gateway/console/trail-reshape.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { reshapeTrail } from "../../../src/gateway/console/trail-reshape.js";

const RUN_DETAIL = {
  run: { trace_id: "trace-1" },
  duration_seconds: 42.5,
  events: [
    {
      event_id: "evt-1", offset_seconds: 1.5, sequence: 1, kind: "tool.call.attempt",
      actor: { id: "pod-a" }, operation: { status: "running", name: "run_tests" },
      relationships: [], payload: { preview: { ok: true } },
    },
    {
      event_id: "evt-2", offset_seconds: 3.25, sequence: 2, kind: "verification.finished",
      actor: { id: "pod-a" }, operation: { status: "failed", error: "assertion mismatch" },
      relationships: [{ type: "caused_by", event_id: "evt-1" }], payload: { preview: { detail: "boom" } },
    },
    {
      event_id: "evt-3", offset_seconds: 4.0, sequence: 3, kind: "scheduler.task_ready.failed",
      actor: { id: "pod-b" }, operation: { status: "done" },
      relationships: [], payload: null,
    },
  ],
  actors: [
    { id: "pod-a", role: "implementation" },
    { id: "pod-b", role: null },
  ],
};

describe("reshapeTrail", () => {
  it("maps run id and duration from AgentTrail's run_detail shape", () => {
    const view = reshapeTrail(RUN_DETAIL);
    expect(view.runId).toBe("trace-1");
    expect(view.durationSeconds).toBe(42.5);
  });

  it("maps each event's presentational fields", () => {
    const view = reshapeTrail(RUN_DETAIL);
    const first = view.events[0]!;
    expect(first.id).toBe("evt-1");
    expect(first.offsetSeconds).toBe(1.5);
    expect(first.kind).toBe("tool.call.attempt");
    expect(first.name).toBe("run_tests");
    expect(first.summary).toBe("tool.call.attempt - running");
    expect(first.actorId).toBe("pod-a");
    expect(first.failed).toBe(false);
    expect(first.sequence).toBe(1);
    expect(first.payload).toEqual({ preview: { ok: true } });
  });

  it("uses operation.error as the summary when present", () => {
    const view = reshapeTrail(RUN_DETAIL);
    expect(view.events[1]!.summary).toBe("assertion mismatch");
  });

  it("falls back to the last kind segment as the name when operation.name is absent", () => {
    const view = reshapeTrail(RUN_DETAIL);
    expect(view.events[1]!.name).toBe("finished");
  });

  it("classifies an event as failed when operation.status is a failure status", () => {
    const view = reshapeTrail(RUN_DETAIL);
    expect(view.events[1]!.failed).toBe(true);
  });

  it("classifies an event as failed when its kind ends in .failed regardless of status", () => {
    const view = reshapeTrail(RUN_DETAIL);
    expect(view.events[2]!.failed).toBe(true);
  });

  it("maps relationships into evidence links", () => {
    const view = reshapeTrail(RUN_DETAIL);
    expect(view.events[1]!.evidence).toEqual([{ type: "caused_by", refEventId: "evt-1" }]);
    expect(view.events[0]!.evidence).toEqual([]);
  });

  it("assigns each actor a deterministic color and glyph, stable across calls", () => {
    const first = reshapeTrail(RUN_DETAIL);
    const second = reshapeTrail(RUN_DETAIL);
    expect(first.actors[0]!.color).toBe(second.actors[0]!.color);
    expect(first.actors[0]!.glyph).toBe("I");
    expect(first.actors[1]!.glyph).toBe("P");
  });

  it("throws when the raw response is not an object", () => {
    expect(() => reshapeTrail("not an object")).toThrow();
    expect(() => reshapeTrail(null)).toThrow();
  });

  it("degrades gracefully when events or actors are missing entirely", () => {
    const view = reshapeTrail({ run: { trace_id: "trace-2" } });
    expect(view.events).toEqual([]);
    expect(view.actors).toEqual([]);
    expect(view.durationSeconds).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/gateway/console/trail-reshape.test.ts`
Expected: FAIL — `Cannot find module '../../../src/gateway/console/trail-reshape.js'`

- [ ] **Step 3: Implement `trail-reshape.ts`**

Create `src/gateway/console/trail-reshape.ts`:

```typescript
export interface TrailEvidenceLink {
  readonly type: string;
  readonly refEventId: string;
}

export interface TrailEvent {
  readonly id: string;
  readonly offsetSeconds: number;
  readonly kind: string;
  readonly name: string;
  readonly summary: string;
  readonly actorId: string;
  readonly failed: boolean;
  readonly sequence: number | null;
  readonly evidence: readonly TrailEvidenceLink[];
  readonly payload: unknown;
}

export interface TrailActor {
  readonly id: string;
  readonly role: string | null;
  readonly color: string;
  readonly glyph: string;
}

export interface TrailView {
  readonly runId: string;
  readonly durationSeconds: number;
  readonly events: readonly TrailEvent[];
  readonly actors: readonly TrailActor[];
}

const ACTOR_PALETTE = ["var(--run)", "var(--ok)", "var(--warn)", "var(--accent)", "var(--orch)", "var(--err)"] as const;
const FAILED_STATUSES = new Set(["error", "errored", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function actorColor(actorId: string): string {
  return ACTOR_PALETTE[hashString(actorId) % ACTOR_PALETTE.length]!;
}

function actorGlyph(actorId: string, role: string | null): string {
  const source = role !== null && role.length > 0 ? role : actorId;
  const letter = source.charAt(0).toUpperCase();
  return letter.length > 0 ? letter : "?";
}

function isEventFailed(kind: string, status: string): boolean {
  return kind.endsWith(".failed") || FAILED_STATUSES.has(status.toLowerCase());
}

function eventName(operation: Record<string, unknown>, kind: string): string {
  const name = operation["name"];
  if (typeof name === "string" && name.length > 0) return name;
  const segments = kind.split(".");
  const last = segments[segments.length - 1];
  return last !== undefined && last.length > 0 ? last : kind;
}

function eventSummary(operation: Record<string, unknown>, kind: string, status: string): string {
  const error = operation["error"];
  if (typeof error === "string" && error.length > 0) return error;
  return `${kind} - ${status}`;
}

export function reshapeTrail(raw: unknown): TrailView {
  if (!isRecord(raw)) throw new Error("trail_response_invalid");
  const run = raw["run"];
  const runId = isRecord(run) && typeof run["trace_id"] === "string" ? run["trace_id"] : "";
  const durationSeconds = typeof raw["duration_seconds"] === "number" ? raw["duration_seconds"] : 0;
  const rawEvents = Array.isArray(raw["events"]) ? raw["events"] : [];
  const rawActors = Array.isArray(raw["actors"]) ? raw["actors"] : [];

  const events: TrailEvent[] = rawEvents.filter(isRecord).map((event) => {
    const operation = isRecord(event["operation"]) ? event["operation"] : {};
    const actor = isRecord(event["actor"]) ? event["actor"] : {};
    const kind = typeof event["kind"] === "string" ? event["kind"] : "unknown";
    const status = typeof operation["status"] === "string" ? operation["status"] : "unknown";
    const relationships = Array.isArray(event["relationships"]) ? event["relationships"] : [];
    return {
      id: String(event["event_id"] ?? ""),
      offsetSeconds: typeof event["offset_seconds"] === "number" ? event["offset_seconds"] : 0,
      kind,
      name: eventName(operation, kind),
      summary: eventSummary(operation, kind, status),
      actorId: typeof actor["id"] === "string" ? actor["id"] : "unknown",
      failed: isEventFailed(kind, status),
      sequence: typeof event["sequence"] === "number" ? event["sequence"] : null,
      evidence: relationships.filter(isRecord).map((relationship) => ({
        type: String(relationship["type"] ?? "related"),
        refEventId: String(relationship["event_id"] ?? ""),
      })),
      payload: event["payload"] ?? null,
    };
  });

  const actors: TrailActor[] = rawActors.filter(isRecord).map((actor) => {
    const id = String(actor["id"] ?? "unknown");
    const role = typeof actor["role"] === "string" ? actor["role"] : null;
    return { id, role, color: actorColor(id), glyph: actorGlyph(id, role) };
  });

  return { runId, durationSeconds, events, actors };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/gateway/console/trail-reshape.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/trail-reshape.ts tests/gateway/console/trail-reshape.test.ts
git commit -m "Add Trail reshaping module: AgentTrail run_detail to console TrailView"
```

---

### Task 2: Backend route `GET /api/v1/zentra/runs/:id/trail`

**Files:**
- Modify: `src/gateway/loopback-gateway.ts`
- Test: `tests/gateway/loopback-gateway.test.ts`

**Interfaces:**
- Consumes: `reshapeTrail`, `TrailView` from Task 1's `src/gateway/console/trail-reshape.ts`.
- Produces: the route itself (no new exported symbols consumed by later tasks; Task 3 calls this route from the browser via `request(...)`, not via a TypeScript import).

- [ ] **Step 1: Write the failing tests**

Open `tests/gateway/loopback-gateway.test.ts`. Extend the `fakeAgentTrail` helper (defined near the bottom of the file, around line 435) so it also answers `GET /api/v1/runs/:id` with a realistic `run_detail()`-shaped body, and answers unknown trace ids with 404. Replace the existing `fakeAgentTrail` function body with:

```typescript
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
    if (request.url === `/api/v1/runs/${traceId}`) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        run: { trace_id: traceId },
        duration_seconds: 42.5,
        events: [
          {
            event_id: "evt-1", offset_seconds: 1.5, sequence: 1, kind: "tool.call.attempt",
            actor: { id: "pod-a" }, operation: { status: "running", name: "run_tests" },
            relationships: [], payload: { preview: { ok: true } },
          },
          {
            event_id: "evt-2", offset_seconds: 3.25, sequence: 2, kind: "verification.finished",
            actor: { id: "pod-a" }, operation: { status: "failed", error: "assertion mismatch" },
            relationships: [{ type: "caused_by", event_id: "evt-1" }], payload: { preview: { detail: "boom" } },
          },
        ],
        actors: [{ id: "pod-a", role: "implementation" }],
      }));
      return;
    }
    if (request.url === "/api/v1/runs/unknown-trace") {
      response.statusCode = 404;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (request.url === "/api/v1/runs/malformed-trace") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify("not an object"));
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
```

Add a new `describe` block anywhere after the existing tests in the file, before the helper functions section (before the `function token(...)` line near line 401):

```typescript
describe("LoopbackGateway trail endpoint", () => {
  it("reshapes AgentTrail's run detail into the console's trail view", async () => {
    const upstream = await fakeAgentTrail();
    const gateway = new LoopbackGateway({ workflow: workflow() });
    const session = await gateway.start();
    gateway.setAgentTrailAddress(upstream.address);
    gateway.setReadiness("ready");
    try {
      const auth = await establish(session);
      const body = await apiJson(session, auth, "/runs/trace-1/trail") as {
        runId: string; durationSeconds: number; events: unknown[]; actors: unknown[];
      };
      expect(body.runId).toBe("trace-1");
      expect(body.durationSeconds).toBe(42.5);
      expect(body.events).toHaveLength(2);
      expect(body.actors).toHaveLength(1);
    } finally {
      await gateway.close();
      await upstream.close();
    }
  });

  it("responds agenttrail_unavailable when AgentTrail's address is not configured", async () => {
    const gateway = new LoopbackGateway({ workflow: workflow() });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const auth = await establish(session);
      const response = await api(session, auth, "/runs/trace-1/trail");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "agenttrail_unavailable" });
    } finally {
      await gateway.close();
    }
  });

  it("propagates not_found when AgentTrail has no such trace", async () => {
    const upstream = await fakeAgentTrail();
    const gateway = new LoopbackGateway({ workflow: workflow() });
    const session = await gateway.start();
    gateway.setAgentTrailAddress(upstream.address);
    gateway.setReadiness("ready");
    try {
      const auth = await establish(session);
      const response = await api(session, auth, "/runs/unknown-trace/trail");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    } finally {
      await gateway.close();
      await upstream.close();
    }
  });

  it("responds agenttrail_unavailable when the upstream body cannot be reshaped", async () => {
    const upstream = await fakeAgentTrail();
    const gateway = new LoopbackGateway({ workflow: workflow() });
    const session = await gateway.start();
    gateway.setAgentTrailAddress(upstream.address);
    gateway.setReadiness("ready");
    try {
      const auth = await establish(session);
      const response = await api(session, auth, "/runs/malformed-trace/trail");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "agenttrail_unavailable" });
    } finally {
      await gateway.close();
      await upstream.close();
    }
  });

  it("requires a bearer token like every other zentra route", async () => {
    const upstream = await fakeAgentTrail();
    const gateway = new LoopbackGateway({ workflow: workflow() });
    const session = await gateway.start();
    gateway.setAgentTrailAddress(upstream.address);
    gateway.setReadiness("ready");
    try {
      const response = await fetch(`${session.origin}/api/v1/zentra/runs/trace-1/trail`);
      expect(response.status).toBe(401);
    } finally {
      await gateway.close();
      await upstream.close();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/gateway/loopback-gateway.test.ts`
Expected: FAIL — the new `it` blocks fail with 404 (`not_found`) because the route does not exist yet.

- [ ] **Step 3: Implement the route**

In `src/gateway/loopback-gateway.ts`, add the import (alongside the existing imports near the top):

```typescript
import { reshapeTrail, type TrailView } from "./console/trail-reshape.js";
```

Find the block handling `segments[0] === "runs" && segments.length >= 2` inside `routeApi` (it currently handles `sources/.../text`, `attention`, and `cancel`). Add a new branch for `trail` right after the `attention` branch:

```typescript
        if (request.method === "GET" && segments.length === 3 && segments[2] === "attention" && url.search === "") return this.jsonResult(response, await this.invoke("listAttention", runId));
        if (request.method === "GET" && segments.length === 3 && segments[2] === "trail" && url.search === "") {
          return this.trailResult(response, runId);
        }
```

(Insert the new `if` block directly below the existing `attention` line — do not remove or reorder the existing lines in that block.)

Add two new private methods to the `LoopbackGateway` class, right after the existing `routeApi` method (before `streamEvents`):

```typescript
  private async trailResult(response: ServerResponse, runId: string): Promise<void> {
    if (this.agentTrailAddress === null) return this.respond(response, 503, { error: "agenttrail_unavailable" });
    const upstream = await this.fetchAgentTrailJson(`/api/v1/runs/${encodeURIComponent(runId)}`);
    if (upstream === null) return this.respond(response, 503, { error: "agenttrail_unavailable" });
    if (upstream.status === 404) return this.respond(response, 404, { error: "not_found" });
    if (upstream.status < 200 || upstream.status >= 300) return this.respond(response, 503, { error: "agenttrail_unavailable" });
    let reshaped: TrailView;
    try {
      reshaped = reshapeTrail(upstream.body);
    } catch {
      return this.respond(response, 503, { error: "agenttrail_unavailable" });
    }
    return this.jsonResult(response, reshaped);
  }

  private fetchAgentTrailJson(path: string): Promise<{ readonly status: number; readonly body: unknown } | null> {
    const address = this.agentTrailAddress;
    if (address === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      const upstreamRequest = httpRequest({
        host: address.host,
        port: address.port,
        method: "GET",
        path,
        agent: false,
        headers: { accept: "application/json" },
      }, (upstream) => {
        const status = upstream.statusCode ?? 502;
        let size = 0;
        let oversized = false;
        const chunks: Buffer[] = [];
        upstream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_AGENTTRAIL_RESPONSE_BYTES) { oversized = true; upstream.destroy(); return; }
          chunks.push(chunk);
        });
        upstream.once("error", () => resolve(null));
        upstream.once("end", () => {
          if (oversized) { resolve(null); return; }
          try { resolve({ status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
          catch { resolve(null); }
        });
      });
      upstreamRequest.once("error", () => resolve(null));
      upstreamRequest.end();
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/gateway/loopback-gateway.test.ts`
Expected: PASS (all tests in the file, including the 5 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/loopback-gateway.ts tests/gateway/loopback-gateway.test.ts
git commit -m "Add GET /api/v1/zentra/runs/:id/trail, reshaping AgentTrail's run detail"
```

---

### Task 3: Rebuild `trail-section.ts` and wire it into the shell

**Files:**
- Modify: `src/gateway/console/trail-section.ts` (full rewrite)
- Modify: `src/gateway/console/shell.ts`
- Modify: `src/gateway/console/controls-section.ts`
- Test: `tests/gateway/console/trail-section.test.ts` (new)
- Test: `tests/gateway/console/shell.test.ts`
- Test: `tests/gateway/loopback-gateway.test.ts`

**Interfaces:**
- Consumes: `CONSOLE_FONT_STACK_MONO`, `CONSOLE_FONT_STACK_SANS` from `./design-tokens.js`; browser-scope helpers already defined in `CONTROLS_SCRIPT` (`$`, `setText`, `value`, `list`, `label`, `currentRun`, `state`, `request`) since all section scripts share one IIFE, concatenated in the order `CONTROLS_SCRIPT → TRAIL_SCRIPT → OVERVIEW_SCRIPT → SHELL_SCRIPT`.
- Produces: `window.__consoleSections.trail = { render: loadTrail }`, consumed by `controls-section.ts`'s `refresh()`/`selectRun()` and by `applyGatewayChange`'s `gateway.recovered` branch (both edited in this task).

- [ ] **Step 1: Write the failing tests**

Create `tests/gateway/console/trail-section.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { TRAIL_MARKUP, TRAIL_SCRIPT } from "../../../src/gateway/console/trail-section.js";

describe("trail-section markup", () => {
  it("keeps the AgentTrail status banner and drops the iframe", () => {
    expect(TRAIL_MARKUP).toContain('id="agenttrail-status"');
    expect(TRAIL_MARKUP).not.toContain("agenttrail-frame");
    expect(TRAIL_MARKUP).not.toContain("<iframe");
  });

  it("renders all four target tabs, with only Events enabled", () => {
    expect(TRAIL_MARKUP).toContain('data-trail-view="events"');
    for (const disabled of ["graph", "tree", "swimlane"]) {
      const start = TRAIL_MARKUP.indexOf(`data-trail-view="${disabled}"`);
      expect(start).toBeGreaterThan(-1);
      const tag = TRAIL_MARKUP.slice(start, TRAIL_MARKUP.indexOf("</button>", start));
      expect(tag).toContain("disabled");
      expect(tag).toContain('aria-disabled="true"');
      expect(tag).toContain('class="badge"');
    }
    const eventsStart = TRAIL_MARKUP.indexOf('data-trail-view="events"');
    const eventsTag = TRAIL_MARKUP.slice(eventsStart, TRAIL_MARKUP.indexOf("</button>", eventsStart));
    expect(eventsTag).not.toContain("disabled");
  });

  it("has containers for the filter pills, event list, inspector, and scrubber", () => {
    expect(TRAIL_MARKUP).toContain('id="trail-filter-pills"');
    expect(TRAIL_MARKUP).toContain('id="trail-events"');
    expect(TRAIL_MARKUP).toContain('id="trail-inspector"');
    expect(TRAIL_MARKUP).toContain('id="trail-scrub"');
    expect(TRAIL_MARKUP).toContain('id="trail-jump-live"');
    expect(TRAIL_MARKUP).toContain('id="trail-clock"');
    expect(TRAIL_MARKUP).toContain('id="trail-event-count"');
  });
});

describe("trail-section script", () => {
  it("isolates every font-stack interpolation inside a single-quoted constant, never a double-quoted string", () => {
    const lines = TRAIL_SCRIPT.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("preserves the existing gateway degrade/recover handling and re-fetches trail data on recovery", () => {
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.degraded"');
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.backfill_target"');
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.recovered"');
    const recoveredIndex = TRAIL_SCRIPT.indexOf('change.type==="gateway.recovered"');
    const recoveredBranch = TRAIL_SCRIPT.slice(recoveredIndex, recoveredIndex + 200);
    expect(recoveredBranch).toContain("loadTrail()");
    expect(TRAIL_SCRIPT).not.toContain("contentWindow");
  });

  it("registers loadTrail under window.__consoleSections.trail", () => {
    expect(TRAIL_SCRIPT).toContain("window.__consoleSections.trail={render:loadTrail}");
  });

  it("fetches the new trail endpoint for the current run", () => {
    expect(TRAIL_SCRIPT).toContain('"/api/v1/zentra/runs/"+encodeURIComponent(id)+"/trail"');
  });

  it("classifies failed events using the reshaped view's own failed field, not a re-derived one", () => {
    expect(TRAIL_SCRIPT).toContain("trailEvent.failed");
    expect(TRAIL_SCRIPT).not.toContain('.status.toLowerCase()');
  });

  it("filters visible events by actor, kind prefix, failed-only, search text, and scrub horizon", () => {
    expect(TRAIL_SCRIPT).toContain("trailFilterActor");
    expect(TRAIL_SCRIPT).toContain("trailFilterKind");
    expect(TRAIL_SCRIPT).toContain("trailFailedOnly");
    expect(TRAIL_SCRIPT).toContain("state.search");
    expect(TRAIL_SCRIPT).toContain("trailScrubT");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/gateway/console/trail-section.test.ts`
Expected: FAIL — current `TRAIL_MARKUP`/`TRAIL_SCRIPT` still have the iframe and none of the new markers.

- [ ] **Step 3: Rewrite `trail-section.ts`**

Replace the entire contents of `src/gateway/console/trail-section.ts` with:

```typescript
import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const TRAIL_MARKUP = `<div style="flex:1;min-height:0;display:flex;flex-direction:column" data-screen-label="Trail">
  <div id="agenttrail-status" class="agenttrail-status" data-tone="ok" role="status" aria-live="polite">AgentTrail is live and read-only.</div>
  <div style='flex:none;display:flex;align-items:center;gap:14px;padding:10px 18px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap'>
    <div style='display:flex;gap:4px'>
      <button type="button" data-trail-view="graph" disabled aria-disabled="true" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--faint);cursor:not-allowed;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Graph<span class="badge">Phase 2</span></button>
      <button type="button" data-trail-view="tree" disabled aria-disabled="true" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--faint);cursor:not-allowed;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Tree<span class="badge">Phase 2</span></button>
      <button type="button" data-trail-view="swimlane" disabled aria-disabled="true" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--faint);cursor:not-allowed;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Swimlane<span class="badge">Phase 2</span></button>
      <button type="button" data-trail-view="events" aria-current="true" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid var(--accent);background:rgba(122,162,255,.12);color:var(--accent);cursor:default;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Events</button>
    </div>
    <span style='width:1px;height:22px;background:var(--line)'></span>
    <div id="trail-filter-pills" style='display:flex;gap:5px;flex-wrap:wrap;align-items:center'></div>
    <div style='flex:1'></div>
    <span id="trail-event-count" style='font:400 11px ${CONSOLE_FONT_STACK_MONO};color:var(--faint)'></span>
  </div>
  <div style='flex:1;min-height:0;display:flex'>
    <div id="trail-events" style='flex:1;min-width:0;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:4px'></div>
    <aside id="trail-inspector" style='width:360px;flex:none;border-left:1px solid var(--line);background:var(--panel);overflow-y:auto'></aside>
  </div>
  <div style='height:52px;flex:none;padding:0 16px;border-top:1px solid var(--line);background:var(--panel);display:flex;align-items:center;gap:14px'>
    <div id="trail-clock" style='font:600 12px ${CONSOLE_FONT_STACK_MONO};color:var(--dim);width:110px;flex:none;text-align:center'></div>
    <input type="range" id="trail-scrub" min="0" max="1000" step="1" value="1000" style='flex:1'>
    <button type="button" id="trail-jump-live" style='height:26px;border-radius:6px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);cursor:pointer;font:600 11px ${CONSOLE_FONT_STACK_MONO};padding:0 12px'>Jump to live</button>
  </div>
</div>`;

export const TRAIL_SCRIPT = String.raw`const trailFontMono='${CONSOLE_FONT_STACK_MONO}';
const trailFontSans='${CONSOLE_FONT_STACK_SANS}';
const applyGatewayChange=(change)=>{const node=$("agenttrail-status");if(change.type==="gateway.degraded"){node.dataset.tone="error";setText(node,"AgentTrail unavailable. Zentra controls remain available while recovery is verified.")}if(change.type==="gateway.backfill_target"){node.dataset.tone="waiting";setText(node,"AgentTrail replacement is backfilling durable evidence.")}if(change.type==="gateway.recovered"){node.dataset.tone="ok";setText(node,"AgentTrail recovered from durable evidence and is live.");loadTrail()}};
let trailRunId=null;
let trailEvents=[];
let trailActors=[];
let trailSelectedEvent=null;
let trailFilterActor=null;
let trailFilterKind=null;
let trailFailedOnly=false;
let trailScrubT=1;
const trailActorById=(id)=>trailActors.find(actor=>actor.id===id)||{id,role:null,color:"var(--faint)",glyph:"?"};
const trailKindColor=(kind)=>{const palette=["var(--run)","var(--ok)","var(--warn)","var(--accent)","var(--orch)","var(--err)"];const prefix=kind.split(".")[0]||kind;let hash=0;for(let index=0;index<prefix.length;index+=1)hash=(hash*31+prefix.charCodeAt(index))|0;return palette[Math.abs(hash)%palette.length]};
const trailFormatClock=(seconds)=>{const total=Math.max(0,Math.round(seconds));const minutes=Math.floor(total/60);const rest=String(total%60).padStart(2,"0");return minutes+":"+rest};
const trailMaxOffset=()=>trailEvents.reduce((max,event)=>Math.max(max,event.offsetSeconds),0);
const trailVisibleEvents=()=>{const horizon=trailScrubT*trailMaxOffset();const term=state.search.trim().toLowerCase();return trailEvents.filter(event=>event.offsetSeconds<=horizon).filter(event=>!trailFilterActor||event.actorId===trailFilterActor).filter(event=>!trailFilterKind||event.kind.startsWith(trailFilterKind)).filter(event=>!trailFailedOnly||event.failed).filter(event=>!term||(event.name+" "+event.kind+" "+event.actorId+" "+event.summary).toLowerCase().includes(term))};
const trailPill=(labelText,active,onClick,color)=>{const button=document.createElement("button");button.type="button";button.style.cssText="padding:5px 11px;border-radius:999px;cursor:pointer;font:500 10.5px "+trailFontMono+";border:1px solid "+(active?(color||"var(--accent)"):"var(--line)")+";background:"+(active?"rgba(122,162,255,.14)":"var(--panel2)")+";color:"+(active?(color||"var(--accent)"):"var(--dim)");setText(button,labelText);button.addEventListener("click",onClick);return button};
const renderTrailPills=()=>{
  const host=$("trail-filter-pills");if(!host)return;host.replaceChildren();
  for(const actor of trailActors){host.append(trailPill(actor.id,trailFilterActor===actor.id,()=>{trailFilterActor=trailFilterActor===actor.id?null:actor.id;renderTrailView()},actor.color))}
  const kinds=[...new Set(trailEvents.map(event=>event.kind.split(".")[0]))].sort();
  for(const kind of kinds){host.append(trailPill(kind,trailFilterKind===kind,()=>{trailFilterKind=trailFilterKind===kind?null:kind;renderTrailView()}))}
  host.append(trailPill("failed only",trailFailedOnly,()=>{trailFailedOnly=!trailFailedOnly;renderTrailView()},"var(--err)"));
};
const trailInspectorRow=(key,text,color)=>{const row=document.createElement("div");row.style.cssText="display:flex;justify-content:space-between;gap:10px;padding:5px 0;font:400 11px "+trailFontMono+";color:var(--dim)";const k=document.createElement("span");setText(k,key);const v=document.createElement("span");v.style.color=color||"var(--text)";setText(v,text);row.append(k,v);return row};
const trailInspectorLabel=(text)=>{const label=document.createElement("div");label.style.cssText="font:600 10px "+trailFontMono+";color:var(--faint);letter-spacing:1.2px;margin-bottom:11px";setText(label,text);return label};
const renderTrailInspectorDefault=()=>{
  const host=$("trail-inspector");if(!host)return;host.replaceChildren();
  const heading=document.createElement("div");heading.style.cssText="font:600 15px "+trailFontSans+";padding:14px 16px;border-bottom:1px solid var(--line)";setText(heading,"Run");
  const block=document.createElement("div");block.style.cssText="padding:14px 16px";
  block.append(
    trailInspectorRow("trace_id",trailRunId||"—"),
    trailInspectorRow("duration",trailFormatClock(trailMaxOffset())),
    trailInspectorRow("events",String(trailEvents.length)),
    trailInspectorRow("actors",String(trailActors.length)),
  );
  host.append(heading,block);
};
const renderTrailInspectorEvent=(trailEvent)=>{
  const host=$("trail-inspector");if(!host)return;host.replaceChildren();
  const actor=trailActorById(trailEvent.actorId);
  const heading=document.createElement("div");heading.style.cssText="font:600 15px "+trailFontSans+";padding:14px 16px;border-bottom:1px solid var(--line)";setText(heading,trailEvent.name);
  const fieldsBlock=document.createElement("div");fieldsBlock.style.cssText="padding:14px 16px;border-bottom:1px solid var(--line)";
  fieldsBlock.append(
    trailInspectorLabel("EVENT"),
    trailInspectorRow("event_id",trailEvent.id),
    trailInspectorRow("actor",actor.id),
    trailInspectorRow("status",trailEvent.failed?"failed":"ok",trailEvent.failed?"var(--err)":"var(--ok)"),
    trailInspectorRow("sequence",trailEvent.sequence===null?"—":String(trailEvent.sequence)),
  );
  host.append(heading,fieldsBlock);
  if(trailEvent.evidence.length){
    const evidenceBlock=document.createElement("div");evidenceBlock.style.cssText="padding:14px 16px;border-bottom:1px solid var(--line)";
    evidenceBlock.append(trailInspectorLabel("EVIDENCE LINKS"));
    for(const link of trailEvent.evidence){
      const button=document.createElement("button");button.type="button";
      button.style.cssText="display:block;width:100%;border:none;border-left:2px solid var(--accent);background:rgba(122,162,255,.06);padding:10px 12px;margin-bottom:8px;cursor:pointer;text-align:left;border-radius:0 8px 8px 0;color:var(--text);font:600 10px "+trailFontMono;
      setText(button,link.type+" — event "+link.refEventId);
      button.addEventListener("click",()=>{trailSelectedEvent=link.refEventId;renderTrailView()});
      evidenceBlock.append(button);
    }
    host.append(evidenceBlock);
  }
  const payloadBlock=document.createElement("div");payloadBlock.style.cssText="padding:14px 16px";
  payloadBlock.append(trailInspectorLabel("PAYLOAD"));
  const pre=document.createElement("pre");pre.style.cssText="margin:0;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:11px;font:400 11.5px/1.6 "+trailFontMono+";color:var(--text);white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto";setText(pre,JSON.stringify(trailEvent.payload,null,2));
  payloadBlock.append(pre);
  host.append(payloadBlock);
};
const renderTrailEvents=()=>{
  const host=$("trail-events");if(!host)return;host.replaceChildren();
  const visible=trailVisibleEvents();
  setText($("trail-event-count"),visible.length+" of "+trailEvents.length+" events");
  if(!visible.length){const empty=document.createElement("p");empty.className="empty";setText(empty,trailRunId?"No events match the current filters.":"Trace evidence unavailable.");host.append(empty);return}
  for(const trailEvent of visible){
    const actor=trailActorById(trailEvent.actorId);
    const row=document.createElement("div");row.style.cssText="display:flex;align-items:stretch;border-radius:9px;border:1px solid "+(trailEvent.id===trailSelectedEvent?"var(--accent)":"var(--line)")+";background:"+(trailEvent.id===trailSelectedEvent?"rgba(122,162,255,.07)":"var(--panel)");
    const rail=document.createElement("span");rail.style.cssText="width:3px;align-self:stretch;border-radius:3px;flex:none;background:"+(trailEvent.failed?"var(--err)":"var(--ok)");
    const button=document.createElement("button");button.type="button";button.style.cssText="display:flex;align-items:center;gap:12px;flex:1;min-width:0;background:transparent;border:none;padding:10px 12px;cursor:pointer;text-align:left;color:var(--text)";
    const time=document.createElement("span");time.style.cssText="font:500 10.5px "+trailFontMono+";color:var(--faint);width:46px;flex:none";setText(time,trailFormatClock(trailEvent.offsetSeconds));
    const kind=document.createElement("span");kind.style.cssText="font:600 9.5px "+trailFontMono+";color:"+trailKindColor(trailEvent.kind)+";background:var(--panel2);padding:3px 7px;border-radius:4px;white-space:nowrap;flex:none";setText(kind,trailEvent.kind);
    const name=document.createElement("span");name.style.cssText="font:600 12.5px "+trailFontSans+";white-space:nowrap;overflow:hidden;text-overflow:ellipsis";setText(name,trailEvent.name);
    const summary=document.createElement("span");summary.style.cssText="flex:1;font:400 11.5px "+trailFontSans+";color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis";setText(summary,trailEvent.summary);
    const actorLabel=document.createElement("span");actorLabel.style.cssText="font:500 10.5px "+trailFontMono+";color:"+actor.color+";flex:none";setText(actorLabel,actor.id);
    button.append(time,kind,name,summary,actorLabel);
    button.addEventListener("click",()=>{trailSelectedEvent=trailEvent.id;renderTrailView()});
    row.append(rail,button);
    host.append(row);
  }
};
const renderTrailScrubber=()=>{
  const maxOffset=trailMaxOffset();
  setText($("trail-clock"),trailFormatClock(trailScrubT*maxOffset)+" / "+trailFormatClock(maxOffset));
  const scrub=$("trail-scrub");if(scrub)scrub.value=String(Math.round(trailScrubT*1000));
};
const renderTrailView=()=>{
  renderTrailPills();
  renderTrailEvents();
  const selected=trailSelectedEvent?trailEvents.find(event=>event.id===trailSelectedEvent):null;
  if(selected)renderTrailInspectorEvent(selected);else renderTrailInspectorDefault();
  renderTrailScrubber();
};
const loadTrail=async()=>{
  const run=currentRun();const id=run?value(run,["runId","id"],null):null;
  if(!id){trailRunId=null;trailEvents=[];trailActors=[];trailSelectedEvent=null;renderTrailView();return}
  trailRunId=id;
  try{
    const result=await request("/api/v1/zentra/runs/"+encodeURIComponent(id)+"/trail");
    trailEvents=list(result,["events"]);trailActors=list(result,["actors"]);
  }catch(error){trailEvents=[];trailActors=[]}
  trailScrubT=1;trailSelectedEvent=null;
  renderTrailView();
};
$("trail-scrub")?.addEventListener("input",(event)=>{trailScrubT=Number(event.target.value)/1000;renderTrailView()});
$("trail-jump-live")?.addEventListener("click",()=>{trailScrubT=1;renderTrailView()});
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.trail={render:loadTrail};
renderTrailView();`;
```

- [ ] **Step 4: Update `shell.ts`**

In `src/gateway/console/shell.ts`, find and delete the line that sets the now-removed iframe's `src` inside `handoff()`:

```typescript
    document.getElementById("agenttrail-frame").src="/agenttrail/";
```

Find the `console-search` input listener and make it also refresh Trail's view when Trail is the active section:

```typescript
$("console-search")?.addEventListener("input",(event)=>{
  // Placeholder for forward compatibility: nothing filters on state.search yet.
  // Trail (Phase 2 of the Agent Rail Console redesign) is what will read this.
  state.search=event.target.value;
});
```

Replace it with:

```typescript
$("console-search")?.addEventListener("input",(event)=>{
  state.search=event.target.value;
  if(document.querySelector('.section[data-section-id="trail"]')?.dataset.active==="true")window.__consoleSections.trail?.render?.();
});
```

Note this new listener calls `render`, which re-fetches Trail data on every keystroke. That is intentional and harmless here (the fetch is cheap and idempotent), matching how `loadTrail` already re-runs on every `selectRun`/`refresh` call from `controls-section.ts`.

- [ ] **Step 5: Update `controls-section.ts`**

In `src/gateway/console/controls-section.ts`, find the two lines that call `window.__consoleSections.overview?.render?.();window.__consoleSections.shell?.render?.();` — one inside `refresh` and one inside `selectRun`. Append a trail render call to each, so both read:

```typescript
window.__consoleSections.overview?.render?.();window.__consoleSections.shell?.render?.();window.__consoleSections.trail?.render?.();
```

(There are two occurrences — one in `refresh`, one in `selectRun`. Update both.)

- [ ] **Step 6: Update `tests/gateway/console/shell.test.ts`**

Search the file for any assertion referencing `agenttrail-frame` or the old `console-search` placeholder comment text and update them to match the new behavior. Add this test to the existing `describe` block:

```typescript
  it("removes the dead agenttrail-frame reference from handoff and wires console-search to Trail's render", () => {
    expect(SHELL_SCRIPT).not.toContain("agenttrail-frame");
    const searchIndex = SHELL_SCRIPT.indexOf('$("console-search")?.addEventListener("input"');
    expect(searchIndex).toBeGreaterThan(-1);
    const searchBranch = SHELL_SCRIPT.slice(searchIndex, searchIndex + 300);
    expect(searchBranch).toContain("window.__consoleSections.trail?.render?.()");
  });
```

(If an existing test in this file already asserts `toContain('id="agenttrail-frame"')` on `SHELL_MARKUP` or `TRAIL_MARKUP` output, remove that specific assertion — the shell itself never referenced that id directly, only `trail-section.ts` did, so check before assuming; only remove assertions that actually fail.)

- [ ] **Step 7: Update `tests/gateway/loopback-gateway.test.ts`'s full-page markup test**

In the first `it` block of the file (the one asserting on the served HTML page), find and remove these three now-false assertions:

```typescript
      expect(html).toContain('id="agenttrail-frame"');
      expect(html).toContain('title="AgentTrail evidence views"');
```

Keep `expect(html).toContain('id="agenttrail-status"');` and the three `gateway.degraded`/`gateway.backfill_target`/`gateway.recovered` assertions unchanged — the banner and its change handling still exist. Add in their place:

```typescript
      expect(html).toContain('data-trail-view="events"');
      expect(html).toContain('id="trail-events"');
      expect(html).toContain('id="trail-inspector"');
```

- [ ] **Step 8: Run all four test files to verify they pass**

Run: `npx vitest run tests/gateway/console/trail-section.test.ts tests/gateway/console/shell.test.ts tests/gateway/loopback-gateway.test.ts`
Expected: PASS (every test in all three files)

- [ ] **Step 9: Regenerate the codebase map**

Run: `pnpm docs:codebase-map`

- [ ] **Step 10: Commit**

```bash
git add src/gateway/console/trail-section.ts src/gateway/console/shell.ts src/gateway/console/controls-section.ts tests/gateway/console/trail-section.test.ts tests/gateway/console/shell.test.ts tests/gateway/loopback-gateway.test.ts docs/codebase-map.html
git commit -m "Rebuild Trail as a native Events log + inspector, replacing the AgentTrail iframe"
```

---

### Task 4: Real-browser e2e coverage

**Files:**
- Modify: `tests/ui/console-shell.e2e.test.ts`

**Interfaces:**
- Consumes: `ChromiumWorkflowDriver`, `LoopbackGateway`, `consoleShellWorkflow` (all already imported/defined in this file); the new `/api/v1/zentra/runs/:id/trail` route from Task 2; a small fake-AgentTrail HTTP server, written inline in this file following the exact pattern of `fakeAgentTrail` in `tests/gateway/loopback-gateway.test.ts` (that helper is not exported, so this task writes its own copy scoped to this file rather than importing across test files).
- Produces: nothing consumed by later tasks (last task before final verification).

- [ ] **Step 1: Update the existing Trail e2e test**

Find the existing test titled `"switches to the Trail nav item and confirms the restyled chrome still targets the embedded AgentTrail route"` in `tests/ui/console-shell.e2e.test.ts`. This fixture never calls `gateway.setAgentTrailAddress(...)`, so AgentTrail is unavailable in this scenario — replace the test to assert the new honest-unavailable fallback instead of the removed iframe:

```typescript
  it("switches to the Trail nav item and shows the honest unavailable state when AgentTrail is not configured", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-trail-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.click('[data-nav-id="trail"]');
      await driver.waitFor(`document.querySelector('[data-section-id="trail"]')?.dataset.active === "true"`);
      await driver.waitFor(`document.getElementById("trail-events")?.textContent.includes("Trace evidence unavailable.")`);
      const disabledTabs = await driver.evaluate<number>(`document.querySelectorAll('[data-trail-view][disabled]').length`);
      expect(disabledTabs).toBe(3);
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
```

- [ ] **Step 2: Add a new e2e test with a fake AgentTrail backing real Events data**

Add this helper function near the bottom of the file, alongside the other module-level helpers (after `label`, before or after `consoleShellWorkflow`):

```typescript
async function fakeAgentTrailForE2e(traceId: string): Promise<{
  readonly address: { readonly host: "127.0.0.1"; readonly port: number };
  close(): Promise<void>;
}> {
  const { createServer: createHttpServer } = await import("node:http");
  const server = createHttpServer((request, response) => {
    if (request.url === `/api/v1/runs/${traceId}`) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        run: { trace_id: traceId },
        duration_seconds: 12,
        events: [
          {
            event_id: "evt-1", offset_seconds: 1, sequence: 1, kind: "tool.call.attempt",
            actor: { id: "pod-a" }, operation: { status: "running", name: "run_tests" },
            relationships: [], payload: { preview: { ok: true } },
          },
          {
            event_id: "evt-2", offset_seconds: 2, sequence: 2, kind: "verification.finished",
            actor: { id: "pod-a" }, operation: { status: "failed", error: "assertion mismatch" },
            relationships: [{ type: "caused_by", event_id: "evt-1" }], payload: { preview: { detail: "boom" } },
          },
        ],
        actors: [{ id: "pod-a", role: "implementation" }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") { reject(new Error("fake AgentTrail did not bind")); return; }
      resolve(address.port);
    });
  });
  return {
    address: { host: "127.0.0.1", port },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}
```

Add a new test in the same `describe` block, after the Trail test from Step 1:

```typescript
  it("renders real Trail events and inspector detail from a live AgentTrail backend", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-trail-events-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    const runId = "trace-e2e-1";
    const upstream = await fakeAgentTrailForE2e(runId);
    gateway.setAgentTrailAddress(upstream.address);
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      const submittedRunId = await driver.submitGoal("Prove Trail renders real events");
      await driver.evaluate(`(()=>{state.selected={...state.selected,runId:${JSON.stringify(runId)}};return true})()`);
      await driver.click('[data-nav-id="trail"]');
      await driver.waitFor(`document.querySelector('[data-section-id="trail"]')?.dataset.active === "true"`);
      await driver.evaluate(`window.__consoleSections.trail.render()`);
      await driver.waitFor(`document.getElementById("trail-event-count")?.textContent === "2 of 2 events"`);
      await driver.click('#trail-filter-pills button');
      await driver.waitFor(`document.getElementById("trail-event-count")?.textContent === "1 of 2 events"`);
      await driver.click('#trail-filter-pills button');
      await driver.waitFor(`document.getElementById("trail-event-count")?.textContent === "2 of 2 events"`);
      const eventButtons = await driver.evaluate<number>(`document.querySelectorAll("#trail-events button").length`);
      expect(eventButtons).toBe(2);
      await driver.evaluate(`document.querySelectorAll("#trail-events button")[1].click()`);
      await driver.waitFor(`document.getElementById("trail-inspector")?.textContent.includes("assertion mismatch")`);
      expect(submittedRunId).toMatch(/^run-/);
    } finally {
      await gateway.close();
      await upstream.close();
      fixture.journal.close();
    }
  }, 60_000);
```

This test directly overwrites `state.selected.runId` via `driver.evaluate` to point Trail's data-loading at the fake AgentTrail fixture's trace id, since `consoleShellWorkflow`'s real workflow run id and AgentTrail's trace id are different id spaces in this fixture. This mirrors how the file already reaches into browser state directly for setup in other tests (see `selectRun` and `prepareInteractiveRefresh` in `chromium-acceptance.ts`, which also poke `document`/DOM state directly rather than only using public UI actions).

- [ ] **Step 3: Run the e2e file in isolation**

Run: `npx vitest run tests/ui/console-shell.e2e.test.ts`
Expected: PASS (all tests in the file, including the two touched/added in this task). If `acceptanceBrowser === null` on this machine, the whole `describe` block is skipped — in that case, note it in the task report and proceed; do not treat a skip as a pass without saying so.

- [ ] **Step 4: Commit**

```bash
git add tests/ui/console-shell.e2e.test.ts
git commit -m "Extend console-shell e2e coverage for the native Trail Events view"
```

---

### Task 5: Final verification

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Typecheck**

Run: `pnpm exec tsc --noEmit` (or the project's existing typecheck script — check `package.json`'s `scripts` for the exact command already used, e.g. `pnpm check` or `pnpm typecheck`)
Expected: no new errors.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm exec vitest run --reporter=json --outputFile=/tmp/vitest-trail-step1.json`

Expected: the same baseline failures already known from before this branch existed (Docker-capsule e2e, OpenCode read-only capsule, package-install e2e, AgentTrail fleet reconstruction, multi-writer scheduler e2e, and any pre-existing browser e2e flakiness under full-suite parallelism), plus every test touched or added in Tasks 1-4 passing. Compare the failing-file list against `git log` / the prior baseline before concluding anything new is a regression — if a new file fails that isn't in that known list, stop and investigate before proceeding.

- [ ] **Step 3: Regenerate the codebase map if needed**

Run: `pnpm docs:codebase-map`

If this produces a diff, commit it:

```bash
git add docs/codebase-map.html
git commit -m "Regenerate codebase map after Trail rebuild step 1"
```

- [ ] **Step 4: Confirm the CSP hash test is clean**

The first `it` block in `tests/gateway/loopback-gateway.test.ts` already asserts the served page's `content-security-policy` header matches a live SHA-256 hash of the concatenated script (computed from the actual served HTML, not a hardcoded constant) — this passing as part of Step 2's full suite run is sufficient; no separate action needed here beyond confirming it was among the passing tests.
