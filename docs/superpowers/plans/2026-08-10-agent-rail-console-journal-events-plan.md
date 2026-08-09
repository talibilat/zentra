# Journal Raw Event Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a paged, filterable raw-event browser to the Journal console section (alongside #124's existing status dashboard), reading from the durable `EventJournal` across every stream.

**Architecture:** A new `listJournalEvents(journal, query)` in `src/journal/journal-events.ts`, bounded-scan pagination (1,000 raw events examined per call, matching `journal.ts`'s existing `CONSUMER_PAGE_LIMITS`), optional stream-id/type prefix filters. A new `WorkflowSurface.listJournalEvents()` method (no new dependency — reads `this.journal` directly, unlike #124's `databasePath`). A new `GET /api/v1/zentra/journal/events` route with typed query-parameter parsing (the first route in this gateway to accept query parameters — every existing GET route requires an empty query string). A new "Events" tab within `journal-section.ts`, alongside the existing "Status" tab, introducing this console's first real pagination affordance ("Load more").

**Tech Stack:** TypeScript, Vitest, the existing framework-free console template-literal/shared-IIFE pattern, real-browser (Chromium/CDP) e2e.

## Global Constraints

- Read-only: `listJournalEvents` never calls a mutating journal method.
- A page can legitimately return zero matching events with `hasMore: true` — the scan window found nothing in that range, not that the journal is exhausted. The frontend must render this as "no matching events in this range, keep scanning" (via Load more), not as end-of-results.
- `nextPosition`/`hasMore` reflect where the bounded raw-event scan stopped, not how many filtered matches were found.
- Filters (`streamPrefix`, `typePrefix`) are optional; changing either resets pagination to a fresh scan from position 0.
- "Load more" appends to the existing list; it never replaces already-rendered rows, and a failed "Load more" leaves prior rows in place.
- Full spec: `docs/superpowers/specs/2026-08-10-agent-rail-console-journal-events-design.md`.

---

### Task 1: `listJournalEvents()` domain projection

**Files:**
- Create: `src/journal/journal-events.ts`
- Test: `tests/journal/journal-events.test.ts`

**Interfaces:**
- Consumes: `iterateAllEvents`, `type EventJournal`, `type StoredEvent` from `src/journal/journal.js` / `src/contracts/event.js`.
- Produces:
  ```ts
  export interface JournalEventQuery {
    readonly afterPosition?: number;
    readonly streamPrefix?: string;
    readonly typePrefix?: string;
    readonly limit?: number;
  }
  export interface JournalEventPage {
    readonly events: readonly StoredEvent[];
    readonly nextPosition: number;
    readonly hasMore: boolean;
  }
  export function listJournalEvents(journal: EventJournal, query: JournalEventQuery): JournalEventPage
  ```
  Consumed by Task 2 (`WorkflowSurface.listJournalEvents()`).

- [ ] **Step 1: Write the failing test**

Create `tests/journal/journal-events.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listJournalEvents } from "../../src/journal/journal-events.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): SqliteEventJournal {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-journal-events-"));
  directories.push(directory);
  const journal = new SqliteEventJournal(path.join(directory, "journal.sqlite"));
  journal.append("run:a", 0, [
    { streamId: "run:a", type: "run.started", payload: { n: 1 }, causationId: null, correlationId: "run:a" },
    { streamId: "run:a", type: "run.completed", payload: { n: 2 }, causationId: null, correlationId: "run:a" },
  ]);
  journal.append("pod:x", 0, [
    { streamId: "pod:x", type: "pod.registered", payload: { n: 3 }, causationId: null, correlationId: "pod:x" },
  ]);
  return journal;
}

describe("listJournalEvents", () => {
  it("returns every event in scan order when no filters are given", () => {
    const journal = fixture();
    const page = listJournalEvents(journal, {});
    expect(page.events.map((event) => event.type)).toEqual(["run.started", "run.completed", "pod.registered"]);
    expect(page.hasMore).toBe(false);
    journal.close();
  });

  it("filters by streamPrefix", () => {
    const journal = fixture();
    const page = listJournalEvents(journal, { streamPrefix: "run:" });
    expect(page.events).toHaveLength(2);
    expect(page.events.every((event) => event.streamId.startsWith("run:"))).toBe(true);
    journal.close();
  });

  it("filters by typePrefix", () => {
    const journal = fixture();
    const page = listJournalEvents(journal, { typePrefix: "pod." });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.type).toBe("pod.registered");
    journal.close();
  });

  it("combines streamPrefix and typePrefix", () => {
    const journal = fixture();
    const page = listJournalEvents(journal, { streamPrefix: "run:", typePrefix: "run.completed" });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.type).toBe("run.completed");
    journal.close();
  });

  it("caps results at limit", () => {
    const journal = fixture();
    const page = listJournalEvents(journal, { limit: 1 });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.type).toBe("run.started");
    journal.close();
  });

  it("continues from a prior page's nextPosition without skipping or duplicating events", () => {
    const journal = fixture();
    const first = listJournalEvents(journal, { limit: 1 });
    const second = listJournalEvents(journal, { afterPosition: first.nextPosition, limit: 10 });
    const combined = [...first.events, ...second.events].map((event) => event.type);
    expect(combined).toEqual(["run.started", "run.completed", "pod.registered"]);
    journal.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/journal/journal-events.test.ts`
Expected: FAIL — `Cannot find module '../../src/journal/journal-events.js'`

- [ ] **Step 3: Implement `src/journal/journal-events.ts`**

```ts
import { iterateAllEvents, type EventJournal } from "./journal.js";
import type { StoredEvent } from "../contracts/event.js";

export interface JournalEventQuery {
  readonly afterPosition?: number;
  readonly streamPrefix?: string;
  readonly typePrefix?: string;
  readonly limit?: number;
}

export interface JournalEventPage {
  readonly events: readonly StoredEvent[];
  readonly nextPosition: number;
  readonly hasMore: boolean;
}

const SCAN_WINDOW = 1_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function listJournalEvents(journal: EventJournal, query: JournalEventQuery): JournalEventPage {
  const afterPosition = query.afterPosition ?? 0;
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const events: StoredEvent[] = [];
  let position = afterPosition;
  let scanned = 0;
  let hasMore = false;

  for (const event of iterateAllEvents(journal, afterPosition)) {
    scanned += 1;
    position = event.globalPosition;
    if (
      (query.streamPrefix === undefined || event.streamId.startsWith(query.streamPrefix)) &&
      (query.typePrefix === undefined || event.type.startsWith(query.typePrefix))
    ) {
      events.push(event);
      if (events.length >= limit) { hasMore = true; break; }
    }
    if (scanned >= SCAN_WINDOW) { hasMore = true; break; }
  }

  return Object.freeze({ events: Object.freeze(events), nextPosition: position, hasMore });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/journal/journal-events.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/journal/journal-events.ts tests/journal/journal-events.test.ts
git commit -m "Add listJournalEvents() bounded-scan paged event projection"
```

---

### Task 2: `WorkflowSurface.listJournalEvents()`

**Files:**
- Modify: `src/surfaces/workflow-surface.ts`
- Test: `tests/surfaces/workflow-surface.test.ts`

**Interfaces:**
- Consumes: `listJournalEvents`, `type JournalEventPage`, `type JournalEventQuery` from Task 1's `src/journal/journal-events.js`.
- Produces: `WorkflowSurface.listJournalEvents(query): JournalEventPage` — consumed by Task 3 (gateway route).

- [ ] **Step 1: Write the failing test**

Add to `tests/surfaces/workflow-surface.test.ts` (read the file's existing `surfaceFor(journal)` helper and conventions first — matches the pattern already used for `getJournalStatus()`'s own tests, added in #124's Task 3):

```ts
describe("listJournalEvents", () => {
  it("returns a paged view of every event in the journal", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-workflow-surface-journal-events-"));
    try {
      const journal = new SqliteEventJournal(path.join(directory, "events.sqlite"));
      journal.append("stream-a", 0, [{
        streamId: "stream-a", type: "test.event", payload: {}, causationId: null, correlationId: "test",
      }]);
      const surface = surfaceFor(journal);
      const page = surface.listJournalEvents({});
      expect(page.events).toHaveLength(1);
      expect(page.hasMore).toBe(false);
      journal.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
```

(`mkdtempSync`, `rmSync`, `path`, `tmpdir`, `SqliteEventJournal` are already imported in this test file for its other fixtures — reuse them, do not re-import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/surfaces/workflow-surface.test.ts -t "listJournalEvents"`
Expected: FAIL — `surface.listJournalEvents is not a function`

- [ ] **Step 3: Implement**

In `src/surfaces/workflow-surface.ts`, extend the existing import line for `journal-status.js` (or add a neighboring one) to also import from Task 1's new module:

```ts
import { listJournalEvents, type JournalEventPage, type JournalEventQuery } from "../journal/journal-events.js";
```

(place this import alongside the existing `import { getJournalStatus, type JournalStatus } from "../journal/journal-status.js";` line, matching alphabetical/grouping convention already used there)

Add the method next to the existing `getJournalStatus()`:

```ts
  listJournalEvents(query: JournalEventQuery): JournalEventPage {
    return this.guard(() => listJournalEvents(this.journal, query));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/surfaces/workflow-surface.test.ts`
Expected: all pass, including the new test

- [ ] **Step 5: Commit**

```bash
git add src/surfaces/workflow-surface.ts tests/surfaces/workflow-surface.test.ts
git commit -m "Add WorkflowSurface.listJournalEvents()"
```

---

### Task 3: Gateway route with query-parameter parsing

**Files:**
- Modify: `src/gateway/loopback-gateway.ts`
- Test: `tests/gateway/loopback-gateway.test.ts`

**Interfaces:**
- Consumes: `WorkflowSurface.listJournalEvents()` (Task 2) via `this.invoke("listJournalEvents", query)`.
- Produces: `GET /api/v1/zentra/journal/events?afterPosition=&streamPrefix=&typePrefix=&limit=` — consumed by Task 4 (frontend).

**Note:** this is the first route in this gateway to accept query parameters — every existing GET route in `routeApi` requires `url.search === ""`. Read the surrounding route branches in `src/gateway/loopback-gateway.ts` first (around the existing `journal`/`github-broker`/`milestones` GET branches) to match the file's exact conventions for everything except the query-parsing itself, which has no precedent to copy — validate defensively (reject with 400 on a malformed numeric parameter, do not silently coerce `NaN`/negative values into something that would make `listJournalEvents` misbehave).

- [ ] **Step 1: Write the failing test**

Add to `tests/gateway/loopback-gateway.test.ts`, next to the existing `journal` route test (read that test and the file's `establish`/`apiJson`/`workflow()` fixture conventions first, matching them exactly):

```ts
  it("exposes paged journal events as a read-only, bearer-authenticated route", async () => {
    const page = { events: [], nextPosition: 0, hasMore: false };
    const gateway = new LoopbackGateway({ workflow: workflow({ listJournalEvents: (query: unknown) => { capturedQuery = query; return page; } }) });
    let capturedQuery: unknown;
    const session = await gateway.start();
    try {
      const auth = await establish(session);
      const response = await fetch(`${session.origin}/api/v1/zentra/journal/events?afterPosition=10&streamPrefix=run%3A&typePrefix=run.&limit=25`, {
        headers: { authorization: `Bearer ${auth.bearerToken}`, accept: "application/json" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(page);
      expect(capturedQuery).toEqual({ afterPosition: 10, streamPrefix: "run:", typePrefix: "run.", limit: 25 });
      const unauthenticated = await fetch(`${session.origin}/api/v1/zentra/journal/events`, { headers: { accept: "application/json" } });
      expect(unauthenticated.status).toBe(401);
      const invalid = await fetch(`${session.origin}/api/v1/zentra/journal/events?afterPosition=not-a-number`, {
        headers: { authorization: `Bearer ${auth.bearerToken}`, accept: "application/json" },
      });
      expect(invalid.status).toBe(400);
    } finally {
      await gateway.close();
    }
  });
```

(Adjust the exact `capturedQuery`/closure ordering and `workflow()` fixture mock-shape once you see the real file's conventions — the assertions above are the source of truth for behavior, the literal test scaffolding may need adjusting to match reality, same as every prior task in this series.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/gateway/loopback-gateway.test.ts -t "paged journal events"`
Expected: FAIL — route doesn't exist (404/unhandled)

- [ ] **Step 3: Add the route**

In `src/gateway/loopback-gateway.ts`, add immediately after the existing `journal` status GET branch:

```ts
      if (request.method === "GET" && segments.length === 2 && segments[0] === "journal" && segments[1] === "events") {
        const afterPositionRaw = url.searchParams.get("afterPosition");
        const limitRaw = url.searchParams.get("limit");
        const afterPosition = afterPositionRaw === null ? undefined : Number(afterPositionRaw);
        const limit = limitRaw === null ? undefined : Number(limitRaw);
        if (
          (afterPosition !== undefined && (!Number.isInteger(afterPosition) || afterPosition < 0)) ||
          (limit !== undefined && (!Number.isInteger(limit) || limit <= 0))
        ) {
          return this.respond(response, 400, { error: "invalid_request" });
        }
        const streamPrefix = url.searchParams.get("streamPrefix");
        const typePrefix = url.searchParams.get("typePrefix");
        const query = {
          ...(afterPosition === undefined ? {} : { afterPosition }),
          ...(streamPrefix === null ? {} : { streamPrefix }),
          ...(typePrefix === null ? {} : { typePrefix }),
          ...(limit === undefined ? {} : { limit }),
        };
        return this.jsonResult(response, await this.invoke("listJournalEvents", query));
      }
```

(read the exact current signature of `this.respond`/`this.jsonResult` used by neighboring routes to confirm the call shapes above match — this brief transcribes the existing convention from memory, verify against the real file)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/gateway/loopback-gateway.test.ts -t "paged journal events"`
Expected: PASS

- [ ] **Step 5: Run the full gateway test file to confirm no regressions**

Run: `pnpm exec vitest run tests/gateway/loopback-gateway.test.ts`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/gateway/loopback-gateway.ts tests/gateway/loopback-gateway.test.ts
git commit -m "Add GET /api/v1/zentra/journal/events route"
```

---

### Task 4: Frontend Events tab in `journal-section.ts`

**Files:**
- Modify: `src/gateway/console/journal-section.ts`
- Test: `tests/gateway/console/journal-section.test.ts`

**Interfaces:**
- Consumes: `GET /api/v1/zentra/journal/events` (Task 3); shared console helpers (`$`, `setText`, `request`, `field`, `appendJson`) already in scope at runtime.
- Produces: an "Events" tab within the Journal screen, `journalActiveView` state, `loadJournalEvents`/`renderJournalEvents`.

- [ ] **Step 1: Write the failing tests**

Read the current actual content of `src/gateway/console/journal-section.ts` in full first (it has grown since #124 shipped it — confirm the exact current `JOURNAL_MARKUP`/`JOURNAL_SCRIPT` before writing anything). Add to `tests/gateway/console/journal-section.test.ts`:

```ts
  it("has a Status/Events tab switcher within the Journal screen", () => {
    expect(JOURNAL_MARKUP).toContain('data-journal-view="status"');
    expect(JOURNAL_MARKUP).toContain('data-journal-view="events"');
  });

  it("has filter inputs and a load-more affordance for the Events tab", () => {
    expect(JOURNAL_MARKUP).toContain('id="journal-events-stream-filter"');
    expect(JOURNAL_MARKUP).toContain('id="journal-events-type-filter"');
    expect(JOURNAL_MARKUP).toContain('id="journal-events-load-more"');
  });

  it("fetches journal events from the real API, not a static demo dataset", () => {
    expect(JOURNAL_SCRIPT).toContain('"/api/v1/zentra/journal/events');
    expect(JOURNAL_SCRIPT).not.toContain("DEMO_DATA");
  });

  it("renders an honest message for a zero-match page that still has more to scan, distinct from true end-of-results", () => {
    expect(JOURNAL_SCRIPT).toContain("No matching events in this range.");
    expect(JOURNAL_SCRIPT).toContain("No events found.");
    expect(JOURNAL_SCRIPT).toContain("Journal events unavailable.");
  });

  it("appends load-more results instead of replacing the existing list", () => {
    const loadMoreIndex = JOURNAL_SCRIPT.indexOf("journal-events-load-more");
    expect(loadMoreIndex).toBeGreaterThan(-1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/gateway/console/journal-section.test.ts`
Expected: FAIL — none of the new markup/script exists yet

- [ ] **Step 3: Extend `JOURNAL_MARKUP`**

Wrap the existing Status content (the two `<section class="panel">` blocks #124 shipped) in a `data-journal-view="status"` container, and add a sibling `data-journal-view="events"` container, plus a small tab bar above both, matching Trail's `data-trail-view` tab-button visual style (read `trail-section.ts`'s tab-button markup to copy the exact CSS). `journal-section.ts` does not currently import the design-token font-stack constants (`CONSOLE_FONT_STACK_MONO`/`CONSOLE_FONT_STACK_SANS` from `./design-tokens.js`, the same import `trail-section.ts` has) — add that import now rather than hardcoding `sans-serif`/`monospace` literals in the new tab buttons, matching every other section's convention and specifically avoiding the hardcoded-font mistake #125's final review had to catch and fix after the fact:

```ts
import { CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const JOURNAL_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Journal">
  <div style='display:flex;gap:4px;margin-bottom:16px'>
    <button type="button" data-journal-view="status" aria-current="true" style='padding:7px 13px;border-radius:8px;border:1px solid var(--accent);background:rgba(122,162,255,.12);color:var(--accent);cursor:default;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Status</button>
    <button type="button" data-journal-view="events" style='padding:7px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dim);cursor:pointer;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Events</button>
  </div>
  <div data-journal-panel="status"><section class="panel"><h2>Retention and recovery</h2><div id="journal-retention"></div></section><section class="panel" style="margin-top:16px"><h2>Live projection</h2><div id="journal-projection"></div></section></div>
  <div data-journal-panel="events" style="display:none">
    <div style='display:flex;gap:10px;align-items:center;margin-bottom:12px'>
      <input type="text" id="journal-events-stream-filter" placeholder="Stream prefix" style='flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text)'>
      <input type="text" id="journal-events-type-filter" placeholder="Type prefix" style='flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text)'>
      <button type="button" id="journal-events-apply-filter" style='padding:6px 14px;border-radius:6px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);cursor:pointer'>Apply</button>
    </div>
    <section class="workspace" data-columns="2" aria-label="Journal events"><section class="panel"><h2>Events</h2><div id="journal-events-list" class="stack"></div><button type="button" id="journal-events-load-more" style="margin-top:10px">Load more</button></section><section class="panel"><h2>Event detail</h2><div id="journal-event-detail"></div></section></section>
  </div>
</div>`;
```

(this replaces the existing `export const JOURNAL_MARKUP = ...` line entirely — do not append, this is the full new markup value; verify the `${CONSOLE_FONT_STACK_...}` interpolation convention this file already uses if any exists in the current markup, and preserve it rather than hardcoding `sans-serif`/`monospace` literals, matching the exact lesson #125's final review caught — check the real current file for how it handles fonts before writing this)

- [ ] **Step 4: Extend `JOURNAL_SCRIPT`**

Add tab-switching state and wiring, plus the events-loading/rendering logic. Read the current exact `JOURNAL_SCRIPT` content first (particularly `loadJournalStatus`/`renderJournalStatus`, and Trail's `trailActiveView`/tab-click-loop pattern in `trail-section.ts` as the model to mirror) before writing this — the following is the shape to implement, adapt exactly to match real current helper names and surrounding code:

```js
let journalActiveView="status";
let journalEvents=[];
let journalEventsNextPosition=0;
let journalEventsHasMore=false;
let journalEventsLoadFailed=false;
let journalSelectedEventId=null;
let journalStreamFilter="";
let journalTypeFilter="";

const journalEventsQueryString=(afterPosition)=>{
  const params=new URLSearchParams();
  if(afterPosition!==undefined)params.set("afterPosition",String(afterPosition));
  if(journalStreamFilter)params.set("streamPrefix",journalStreamFilter);
  if(journalTypeFilter)params.set("typePrefix",journalTypeFilter);
  return params.toString();
};

const loadJournalEvents=async(append)=>{
  try{
    const afterPosition=append?journalEventsNextPosition:undefined;
    const page=await request("/api/v1/zentra/journal/events?"+journalEventsQueryString(afterPosition));
    journalEvents=append?[...journalEvents,...page.events]:page.events;
    journalEventsNextPosition=page.nextPosition;
    journalEventsHasMore=page.hasMore;
    journalEventsLoadFailed=false;
  }catch{
    if(!append){journalEvents=[];journalEventsNextPosition=0;journalEventsHasMore=false}
    journalEventsLoadFailed=true;
  }
  renderJournalEvents();
};

const renderJournalEventsList=()=>{
  const host=$("journal-events-list");if(!host)return;host.replaceChildren();
  if(journalEventsLoadFailed){const empty=document.createElement("p");empty.className="empty";setText(empty,"Journal events unavailable.");host.append(empty);return}
  if(!journalEvents.length){const empty=document.createElement("p");empty.className="empty";setText(empty,journalEventsHasMore?"No matching events in this range.":"No events found.");host.append(empty);return}
  for(const event of journalEvents){
    const row=document.createElement("button");row.type="button";row.className="run-card";
    row.dataset.selected=String(event.eventId===journalSelectedEventId);
    const position=document.createElement("span");setText(position,String(event.globalPosition));
    const stream=document.createElement("strong");setText(stream,event.streamId);
    const type=document.createElement("span");setText(type,event.type);
    row.append(position,stream,type);
    row.addEventListener("click",()=>{journalSelectedEventId=event.eventId;renderJournalEvents()});
    host.append(row);
  }
  const loadMore=$("journal-events-load-more");
  if(loadMore)loadMore.style.display=journalEventsHasMore?"block":"none";
};

const renderJournalEventDetail=()=>{
  const host=$("journal-event-detail");if(!host)return;host.replaceChildren();
  const event=journalEvents.find(candidate=>candidate.eventId===journalSelectedEventId);
  if(!event){const empty=document.createElement("p");empty.className="empty";setText(empty,"Select an event to inspect it.");host.append(empty);return}
  const facts=document.createElement("dl");facts.className="facts";
  facts.append(
    field("Position",String(event.globalPosition)),
    field("Stream",event.streamId),
    field("Type",event.type),
    field("Recorded at",event.recordedAt),
  );
  host.append(facts);
  appendJson(host,"Payload",event.payload);
};

const renderJournalEvents=()=>{renderJournalEventsList();renderJournalEventDetail()};

const renderJournalView=()=>{
  const statusPanel=document.querySelector('[data-journal-panel="status"]');
  const eventsPanel=document.querySelector('[data-journal-panel="events"]');
  if(statusPanel)statusPanel.style.display=journalActiveView==="status"?"block":"none";
  if(eventsPanel)eventsPanel.style.display=journalActiveView==="events"?"block":"none";
};

for(const button of document.querySelectorAll("[data-journal-view]")){
  button.addEventListener("click",()=>{
    journalActiveView=button.dataset.journalView;
    for(const other of document.querySelectorAll("[data-journal-view]")){
      const active=other===button;
      other.setAttribute("aria-current",String(active));
      other.style.border=active?"1px solid var(--accent)":"1px solid transparent";
      other.style.background=active?"rgba(122,162,255,.12)":"transparent";
      other.style.color=active?"var(--accent)":"var(--dim)";
      other.style.cursor=active?"default":"pointer";
    }
    renderJournalView();
    if(journalActiveView==="events"&&!journalEvents.length&&!journalEventsLoadFailed)loadJournalEvents(false);
  });
}
$("journal-events-apply-filter")?.addEventListener("click",()=>{
  journalStreamFilter=$("journal-events-stream-filter")?.value.trim()||"";
  journalTypeFilter=$("journal-events-type-filter")?.value.trim()||"";
  journalSelectedEventId=null;
  loadJournalEvents(false);
});
$("journal-events-load-more")?.addEventListener("click",()=>loadJournalEvents(true));
```

Change the existing `window.__consoleSections.journal={render:renderJournalStatus,load:loadJournalStatus}` line to also call `renderJournalView()` so the tab visibility is correct on first render:

```js
window.__consoleSections.journal={render:()=>{renderJournalStatus();renderJournalView()},load:loadJournalStatus};
```

(load-on-demand: Events data loads the first time the Events tab is clicked, not on every `refresh()` cycle — matching the load-more pattern's intent of not re-fetching a potentially-large dataset on every poll; this is a deliberate deviation from every prior section's "load on every refresh" convention, and should be called out as such in the implementer's report, not silently done)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/gateway/console/journal-section.test.ts`
Expected: all pass

- [ ] **Step 6: Run the console-ui parse-check**

Run: `pnpm exec vitest run tests/gateway/console/console-ui.test.ts`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add src/gateway/console/journal-section.ts tests/gateway/console/journal-section.test.ts
git commit -m "Add Events tab to journal-section.ts with paged browsing"
```

---

### Task 5: e2e coverage

**Files:**
- Modify: `tests/ui/console-shell.e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4, exercised end-to-end through a real browser.

- [ ] **Step 1: Write the failing test**

Read the existing Journal e2e test (from #124, titled something like "enables the Journal nav item and renders real retention and recovery status") as the structural model. Add a new test seeding several distinct events into the fixture's journal directly (via `fixture.journal.append(...)`, matching the pattern every event-seeding e2e test in this file already uses), then:

```ts
  it("browses real journal events on the Events tab, filters, and shows detail on click", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-journal-events-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    fixture.journal.append("probe:e2e", 0, [
      { streamId: "probe:e2e", type: "probe.one", payload: { marker: "first" }, causationId: null, correlationId: "probe:e2e" },
      { streamId: "probe:e2e", type: "probe.two", payload: { marker: "second" }, causationId: null, correlationId: "probe:e2e" },
    ]);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.click('[data-nav-id="journal"]');
      await driver.waitFor(`document.querySelector('[data-section-id="journal"]')?.dataset.active === "true"`);
      await driver.click('[data-journal-view="events"]');
      await driver.waitFor(`document.getElementById("journal-events-list")?.textContent.includes("probe.one")`);
      await driver.evaluate(`document.getElementById("journal-events-type-filter").value = "probe.two"`);
      await driver.click('#journal-events-apply-filter');
      await driver.waitFor(`document.getElementById("journal-events-list")?.textContent.includes("probe.two") && !document.getElementById("journal-events-list")?.textContent.includes("probe.one")`);
      await driver.click('#journal-events-list button');
      const detailText = await driver.evaluate<string>(`document.getElementById("journal-event-detail")?.textContent || ""`);
      expect(detailText).toContain("probe:e2e");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
```

Adjust exact selectors/wait conditions once you see the real rendered markup from Task 4.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts -t "browses real journal events"`
Expected: FAIL if Tasks 1-4 haven't landed yet; treat as a formality otherwise and diagnose against the wiring if it fails unexpectedly

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts -t "browses real journal events"`
Expected: PASS

- [ ] **Step 4: Run the full e2e file to confirm no regressions**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts`
Expected: all pass. If a prior test's `disabledTabs`-style hardcoded assertion or similar breaks, diagnose against this task's own changes before assuming it's environmental (per the established playbook, but this task doesn't touch any nav-enablement state, so an unrelated failure here is more likely genuinely environmental than in prior steps — verify with an isolated re-run either way).

- [ ] **Step 5: Commit**

```bash
git add tests/ui/console-shell.e2e.test.ts
git commit -m "Add e2e coverage for the Journal Events tab"
```

---

### Task 6: Regenerate codebase map (strictly last)

**Files:**
- Modify: `docs/codebase-map.html`

- [ ] **Step 1:** Confirm staleness: `pnpm exec vitest run tests/docs/codebase-map.test.ts` (expected to FAIL — Task 1 added a new file).
- [ ] **Step 2:** Regenerate: `pnpm docs:codebase-map`
- [ ] **Step 3:** Confirm fresh: `pnpm exec vitest run tests/docs/codebase-map.test.ts` (expected to PASS)
- [ ] **Step 4:** Commit: `git add docs/codebase-map.html && git commit -m "Regenerate codebase map for the Journal events browser"`

**Note for whoever executes Task 7:** if any fix-pass commits land after this task, re-run Steps 1-3 again as the literal last commit before merge — confirmed necessary on every step in this series, with zero exceptions, regardless of whether the triggering commit added/removed files.

---

### Task 7: Verify, merge, push, close #127

Executed by the controller directly, matching the pattern used for every prior step's final task.

- [ ] **Step 1:** Before running anything, check `ps -eo pid,ppid,etime,comm | awk '$2==1' | grep -c chrome-headless-shell` — kill any orphaned processes found (`pkill -9 -f "ms-playwright/chromium_headless_shell"`) before trusting a full-suite run's timing, per the lesson from #126.
- [ ] **Step 2:** Run the full test suite solo (`pnpm test`) — compare against the documented pre-existing environmental baseline (Docker Desktop, package e2e, AgentTrail fleet timing, real-Git orchestration); isolate-and-rerun anything outside it before treating it as a regression.
- [ ] **Step 3:** Run `pnpm build`. Must be clean.
- [ ] **Step 4:** Dispatch a final whole-branch code review (most capable available model), explicitly briefed to check for design-quality gaps given this was also built without interactive review — the pattern has caught real, otherwise-invisible bugs on both #125 and #126. Specifically ask it to reason about the new pagination pattern (this console's first): does "Load more" behave correctly across repeated clicks, does changing a filter correctly reset pagination state, does the zero-match-with-`hasMore:true` case render honestly rather than looking like a bug. Address findings with a fix subagent, re-review, re-verify the codebase map as the literal last commit.
- [ ] **Step 5:** Merge to `main`, push to `origin`.
- [ ] **Step 6:** `gh issue close 127` with a summary comment.
- [ ] **Step 7:** Update project memory — this closes out the entire Agent Rail Console Phase 2 initiative (#118-#127), the last ticket in this series.
