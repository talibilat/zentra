# Trail Swimlane View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the disabled "Swimlane" tab in Trail with a real one-lane-per-actor timeline view, reusing every piece of chrome (filter pills, scrubber, inspector, topbar search) the Events view already built.

**Architecture:** Extend `TrailActor` with `model`/`status`/`usage` (already present in the raw AgentTrail payload, just unmapped today). Add lane-based rendering to `trail-section.ts` driven by the exact same `trailVisibleEvents()` filtered/horizon-limited array the Events view already computes, grouped by actor instead of listed linearly. A new `trailActiveView` state variable switches which of the two renderers populates the shared `#trail-events` container.

**Tech Stack:** TypeScript, Vitest, the existing framework-free console template-literal/shared-IIFE pattern, real-browser (Chromium/CDP) e2e.

## Global Constraints

- No backend or AgentTrail change — every field Swimlane needs already exists in the raw `run_detail()` payload.
- Swimlane must consume `trailVisibleEvents()` unchanged — no separate filtering logic, no separate scrubber state.
- Clicking a Swimlane marker must reuse the exact same `trailSelectedEvent`/`renderTrailInspectorEvent` path the Events view uses — one inspector, not two.
- Full spec: `docs/superpowers/specs/2026-08-08-agent-rail-console-trail-swimlane-design.md`.

---

### Task 1: Extend `TrailActor` with model/status/usage

**Files:**
- Modify: `src/gateway/console/trail-reshape.ts`
- Test: `tests/gateway/console/trail-reshape.test.ts`

**Interfaces:**
- Produces: `TrailActorUsageMetric { available: boolean; value: number | null }`, `TrailActorUsage { inputTokens, outputTokens, totalTokens, costUsd }` (each a `TrailActorUsageMetric`), and `TrailActor` gains `model: string | null`, `status: string`, `usage: TrailActorUsage`. Consumed by Task 2's lane header rendering.

- [ ] **Step 1: Write the failing test**

Add to `tests/gateway/console/trail-reshape.test.ts`, extending the existing `RUN_DETAIL` fixture's `actors` array (read the file first — the fixture and existing tests must keep passing unchanged, this only adds new fields and new tests):

```ts
const RUN_DETAIL_WITH_ACTOR_DETAIL = {
  ...RUN_DETAIL,
  actors: [
    {
      id: "pod-a", role: "implementation", model: "claude-sonnet-5", status: "running",
      usage: {
        input_tokens: { available: true, value: 120 },
        output_tokens: { available: true, value: 340 },
        total_tokens: { available: true, value: 460 },
        cost_usd: { available: false, value: null },
      },
    },
    { id: "pod-b", role: null, status: "done" },
  ],
};

describe("reshapeTrail actor detail", () => {
  it("maps model, status, and usage metrics from the raw actor payload", () => {
    const view = reshapeTrail(RUN_DETAIL_WITH_ACTOR_DETAIL);
    const actor = view.actors[0]!;
    expect(actor.model).toBe("claude-sonnet-5");
    expect(actor.status).toBe("running");
    expect(actor.usage).toEqual({
      inputTokens: { available: true, value: 120 },
      outputTokens: { available: true, value: 340 },
      totalTokens: { available: true, value: 460 },
      costUsd: { available: false, value: null },
    });
  });

  it("defaults model to null, status to unknown, and every usage metric to unavailable when absent", () => {
    const view = reshapeTrail(RUN_DETAIL_WITH_ACTOR_DETAIL);
    const actor = view.actors[1]!;
    expect(actor.model).toBeNull();
    expect(actor.status).toBe("unknown");
    expect(actor.usage).toEqual({
      inputTokens: { available: false, value: null },
      outputTokens: { available: false, value: null },
      totalTokens: { available: false, value: null },
      costUsd: { available: false, value: null },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/gateway/console/trail-reshape.test.ts -t "actor detail"`
Expected: FAIL — `actor.model`/`actor.status`/`actor.usage` are `undefined`

- [ ] **Step 3: Implement**

In `src/gateway/console/trail-reshape.ts`, add the two new exported interfaces after `TrailActor` is currently defined, then extend `TrailActor` and the actor-mapping loop:

```ts
export interface TrailActorUsageMetric {
  readonly available: boolean;
  readonly value: number | null;
}

export interface TrailActorUsage {
  readonly inputTokens: TrailActorUsageMetric;
  readonly outputTokens: TrailActorUsageMetric;
  readonly totalTokens: TrailActorUsageMetric;
  readonly costUsd: TrailActorUsageMetric;
}

export interface TrailActor {
  readonly id: string;
  readonly role: string | null;
  readonly color: string;
  readonly glyph: string;
  readonly model: string | null;
  readonly status: string;
  readonly usage: TrailActorUsage;
}
```

Add a helper and update the actor-mapping loop inside `reshapeTrail()`:

```ts
function actorUsageMetric(usage: Record<string, unknown>, key: string): TrailActorUsageMetric {
  const raw = usage[key];
  if (!isRecord(raw)) return { available: false, value: null };
  const available = raw["available"] === true;
  const value = typeof raw["value"] === "number" ? raw["value"] : null;
  return { available, value: available ? value : null };
}

function actorUsage(actor: Record<string, unknown>): TrailActorUsage {
  const usage = isRecord(actor["usage"]) ? actor["usage"] : {};
  return {
    inputTokens: actorUsageMetric(usage, "input_tokens"),
    outputTokens: actorUsageMetric(usage, "output_tokens"),
    totalTokens: actorUsageMetric(usage, "total_tokens"),
    costUsd: actorUsageMetric(usage, "cost_usd"),
  };
}
```

Change the existing actor-mapping loop (currently ending `return { id, role, color: actorColor(id), glyph: actorGlyph(id, role) };`) to:

```ts
  const actors: TrailActor[] = rawActors.filter(isRecord).map((actor) => {
    const id = String(actor["id"] ?? "unknown");
    const role = typeof actor["role"] === "string" ? actor["role"] : null;
    const model = typeof actor["model"] === "string" ? actor["model"] : null;
    const status = typeof actor["status"] === "string" ? actor["status"] : "unknown";
    return { id, role, color: actorColor(id), glyph: actorGlyph(id, role), model, status, usage: actorUsage(actor) };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/gateway/console/trail-reshape.test.ts`
Expected: all tests pass (existing tests unaffected, two new ones pass)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/trail-reshape.ts tests/gateway/console/trail-reshape.test.ts
git commit -m "Extend TrailActor with model, status, and usage for Swimlane"
```

---

### Task 2: Swimlane rendering and tab enablement

**Files:**
- Modify: `src/gateway/console/trail-section.ts`
- Test: `tests/gateway/console/trail-section.test.ts`

**Interfaces:**
- Consumes: `TrailActor.model`/`.status`/`.usage` (Task 1); existing `trailVisibleEvents()`, `trailSelectedEvent`, `renderTrailInspectorEvent`, `trailActorById`, `trailFormatClock`, `trailMaxOffset`, `label` (shared helper from `controls-section.ts`).
- Produces: enabled Swimlane tab, `trailActiveView` state, `renderTrailSwimlane()`.

- [ ] **Step 1: Write the failing tests**

Read `tests/gateway/console/trail-section.test.ts` first (particularly the "renders all four target tabs" test at lines 14-27) to match its exact assertion style. Change that test to only check `graph`/`tree` remain disabled (drop `"swimlane"` from the disabled-loop array), and add:

```ts
  it("enables the Swimlane tab", () => {
    const start = TRAIL_MARKUP.indexOf('data-trail-view="swimlane"');
    expect(start).toBeGreaterThan(-1);
    const tag = TRAIL_MARKUP.slice(start, TRAIL_MARKUP.indexOf("</button>", start));
    expect(tag).not.toContain("disabled");
    expect(tag).not.toContain('class="badge"');
  });
```

Add to the `describe("trail-section script", ...)` block:

```ts
  it("switches between Events and Swimlane without a second fetch", () => {
    expect(TRAIL_SCRIPT).toContain("trailActiveView");
    const requestCalls = TRAIL_SCRIPT.match(/request\(/g) ?? [];
    expect(requestCalls.length).toBe(1);
  });

  it("renders swimlane lanes from the same filtered event list the Events view uses, not a separate computation", () => {
    const swimlaneIndex = TRAIL_SCRIPT.indexOf("const renderTrailSwimlane=");
    expect(swimlaneIndex).toBeGreaterThan(-1);
    const nextConst = TRAIL_SCRIPT.indexOf("\nconst ", swimlaneIndex + 1);
    const body = TRAIL_SCRIPT.slice(swimlaneIndex, nextConst > -1 ? nextConst : undefined);
    expect(body).toContain("trailVisibleEvents()");
  });

  it("selects a swimlane marker into the same trailSelectedEvent the inspector reads", () => {
    const swimlaneIndex = TRAIL_SCRIPT.indexOf("const renderTrailSwimlane=");
    const nextConst = TRAIL_SCRIPT.indexOf("\nconst ", swimlaneIndex + 1);
    const body = TRAIL_SCRIPT.slice(swimlaneIndex, nextConst > -1 ? nextConst : undefined);
    expect(body).toContain("trailSelectedEvent=");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/gateway/console/trail-section.test.ts`
Expected: FAIL — Swimlane tab still disabled, `trailActiveView`/`renderTrailSwimlane` don't exist

- [ ] **Step 3: Enable the tab in `TRAIL_MARKUP`**

In `src/gateway/console/trail-section.ts`, change the Swimlane button (currently line 9) from the disabled shape to the enabled shape, mirroring exactly how the Events button (line 10) is already written, but keeping `data-trail-view="swimlane"` and the `Swimlane` label:

```ts
      <button type="button" data-trail-view="swimlane" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dim);cursor:pointer;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Swimlane</button>
```

(Note: the Events button uses an "active" style with `border:1px solid var(--accent)` etc. because it starts as the current tab — Swimlane should start in the same *inactive-but-enabled* style shown here, since Events remains the default active view; Task 3's active-view switching logic will restyle whichever tab is current.)

- [ ] **Step 4: Add view-switching state and Swimlane rendering to `TRAIL_SCRIPT`**

Read the current `TRAIL_SCRIPT` first to see its exact live structure (it was extended by Task 1's dependency on `TrailActor`'s shape, but this task only adds new script content, it does not change existing functions except where noted). Add after the existing `let trailScrubT=1;` declaration:

```js
let trailActiveView="events";
```

Add tab-click wiring near the other `addEventListener` calls at the bottom of the script (before the `window.__consoleSections.trail=...` line):

```js
for(const button of document.querySelectorAll("[data-trail-view]")){
  button.addEventListener("click",()=>{
    if(button.disabled)return;
    trailActiveView=button.dataset.trailView;
    for(const other of document.querySelectorAll("[data-trail-view]")){
      const active=other===button;
      other.setAttribute("aria-current",String(active));
      other.style.border=active?"1px solid var(--accent)":"1px solid transparent";
      other.style.background=active?"rgba(122,162,255,.12)":"transparent";
      other.style.color=active?"var(--accent)":"var(--dim)";
      other.style.cursor=active?"default":"pointer";
    }
    renderTrailView();
  });
}
```

Add the Swimlane renderer, modeled on `renderTrailEvents` for its empty-state handling but grouping by actor:

```js
const trailActorUsageLabel=(actor)=>actor.usage.totalTokens.available?actor.usage.totalTokens.value+" tokens":null;
const renderTrailSwimlane=()=>{
  const host=$("trail-events");host.replaceChildren();
  const visible=trailVisibleEvents();
  setText($("trail-event-count"),visible.length+" of "+trailEvents.length+" events");
  if(!visible.length){const empty=document.createElement("p");empty.className="empty";setText(empty,trailLoadFailed?"Trace evidence unavailable.":!trailRunId?"Select a run to see its trail.":"No events match the current filters.");host.append(empty);return}
  const maxOffset=trailMaxOffset()||1;
  const lanesByActor=new Map();
  for(const trailEvent of visible){
    if(!lanesByActor.has(trailEvent.actorId))lanesByActor.set(trailEvent.actorId,[]);
    lanesByActor.get(trailEvent.actorId).push(trailEvent);
  }
  const actorsInOrder=[...lanesByActor.keys()].map(id=>trailActorById(id)).sort((a,b)=>{
    const aFirst=lanesByActor.get(a.id).reduce((min,e)=>Math.min(min,e.offsetSeconds),Infinity);
    const bFirst=lanesByActor.get(b.id).reduce((min,e)=>Math.min(min,e.offsetSeconds),Infinity);
    return aFirst-bFirst;
  });
  for(const actor of actorsInOrder){
    const lane=document.createElement("div");lane.style.cssText="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)";
    const header=document.createElement("div");header.style.cssText="width:170px;flex:none;display:flex;flex-direction:column;gap:2px";
    const nameRow=document.createElement("div");nameRow.style.cssText="display:flex;align-items:center;gap:6px";
    const glyph=document.createElement("span");glyph.style.cssText="width:18px;height:18px;border-radius:5px;display:flex;align-items:center;justify-content:center;font:700 10px monospace;color:#0a0e17;background:"+actor.color;setText(glyph,actor.glyph);
    const idLabel=document.createElement("span");idLabel.style.cssText="font:600 11.5px sans-serif;color:var(--text)";setText(idLabel,actor.id);
    nameRow.append(glyph,idLabel);
    const metaRow=document.createElement("span");metaRow.style.cssText="font:400 10px monospace;color:var(--faint)";
    const usageLabel=trailActorUsageLabel(actor);
    setText(metaRow,label(actor.status)+(actor.model?" · "+actor.model:"")+(usageLabel?" · "+usageLabel:""));
    header.append(nameRow,metaRow);
    const track=document.createElement("div");track.style.cssText="position:relative;flex:1;height:24px;background:var(--panel2);border-radius:6px";
    for(const trailEvent of lanesByActor.get(actor.id)){
      const marker=document.createElement("button");marker.type="button";
      const left=Math.min(100,(trailEvent.offsetSeconds/maxOffset)*100);
      const selected=trailEvent.id===trailSelectedEvent;
      marker.style.cssText="position:absolute;top:50%;left:"+left+"%;transform:translate(-50%,-50%);width:10px;height:10px;border-radius:50%;border:"+(selected?"2px solid var(--accent)":"1px solid var(--panel)")+";background:"+(trailEvent.failed?"var(--err)":"var(--ok)")+";cursor:pointer;padding:0";
      marker.title=trailEvent.name+" · "+trailFormatClock(trailEvent.offsetSeconds);
      marker.addEventListener("click",()=>{trailSelectedEvent=trailEvent.id;renderTrailView()});
      track.append(marker);
    }
    lane.append(header,track);
    host.append(lane);
  }
};
```

Change `renderTrailView()` (currently `renderTrailPills();renderTrailEvents();...`) to dispatch on `trailActiveView`:

```js
const renderTrailView=()=>{
  renderTrailPills();
  if(trailActiveView==="swimlane")renderTrailSwimlane();else renderTrailEvents();
  const selected=trailSelectedEvent?trailEvents.find(event=>event.id===trailSelectedEvent):null;
  if(selected)renderTrailInspectorEvent(selected);else renderTrailInspectorDefault();
  renderTrailScrubber();
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/gateway/console/trail-section.test.ts`
Expected: all tests pass

- [ ] **Step 6: Run the full console-ui parse-check to confirm the concatenated script is still syntactically valid**

Run: `pnpm exec vitest run tests/gateway/console/console-ui.test.ts`
Expected: all tests pass — this file includes a `new Function(...)`-style parse check of the entire concatenated `CONSOLE_SCRIPT`, catching the exact syntax-break class documented in project memory (unisolated interpolations, stray commas, etc.)

- [ ] **Step 7: Commit**

```bash
git add src/gateway/console/trail-section.ts tests/gateway/console/trail-section.test.ts
git commit -m "Add Swimlane rendering and enable its nav tab"
```

---

### Task 3: e2e coverage

**Files:**
- Modify: `tests/ui/console-shell.e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-2, exercised end-to-end through a real browser.

- [ ] **Step 1: Write the failing test**

Read the existing Trail e2e tests in `tests/ui/console-shell.e2e.test.ts` (e.g. "renders real Trail events and inspector detail from a live AgentTrail backend") to match the `fakeAgentTrailForE2e` fixture pattern exactly. Add a new test seeding a run with at least two actors (reuse or extend the existing fake-AgentTrail fixture helper if it only seeds one actor today — check `fakeAgentTrailForE2e`'s current fixture data first), then:

```ts
  it("switches to Swimlane and shows one lane per actor with a clickable marker", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-trail-swimlane-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    let upstream: Awaited<ReturnType<typeof fakeAgentTrailForE2e>> | null = null;
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      const submittedRunId = await driver.submitGoal("Prove Swimlane renders real per-actor lanes");
      upstream = await fakeAgentTrailForE2e(submittedRunId);
      gateway.setAgentTrailAddress(upstream.address);
      await driver.click('[data-nav-id="trail"]');
      await driver.waitFor(`document.querySelector('[data-section-id="trail"]')?.dataset.active === "true"`);
      await driver.evaluate(`window.__consoleSections.trail.load()`);
      await driver.click('[data-trail-view="swimlane"]');
      const laneCount = await driver.evaluate<number>(`document.querySelectorAll("#trail-events > div").length`);
      expect(laneCount).toBeGreaterThanOrEqual(1);
      await driver.evaluate(`document.querySelector("#trail-events button")?.click()`);
      const inspectorText = await driver.evaluate<string>(`document.getElementById("trail-inspector")?.textContent || ""`);
      expect(inspectorText).toContain("EVENT");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
```

Adjust the exact assertions once you see the real fixture's actor/event data (the brief above gives the shape; match field names to what `fakeAgentTrailForE2e` actually returns).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts -t "Swimlane"`
Expected: FAIL (Swimlane tab not yet enabled, if Tasks 1-2 haven't landed yet in your working tree — treat this as a formality if they already have, and diagnose against the wiring instead if it fails unexpectedly)

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts -t "Swimlane"`
Expected: PASS

- [ ] **Step 4: Run the full e2e file to confirm no regressions**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add tests/ui/console-shell.e2e.test.ts
git commit -m "Add e2e coverage for the Swimlane view"
```

---

### Task 4: Verify, merge, push, close #125

Executed by the controller directly, matching the pattern used for prior steps' final task.

- [ ] **Step 1:** Confirm `docs/codebase-map.html` freshness (`pnpm exec vitest run tests/docs/codebase-map.test.ts`) — this plan touches no new files, but per the standing lesson (confirmed in #124), an edit-only change can still stale the map; regenerate (`pnpm docs:codebase-map`) and commit if the test fails.
- [ ] **Step 2:** Run the full test suite solo (`pnpm test`) — compare failures against the documented ~8-9 pre-existing environmental baseline; isolate-and-rerun anything outside it before treating it as a regression, including files this branch's own diff touches.
- [ ] **Step 3:** Run `pnpm build`. Must be clean.
- [ ] **Step 4:** Dispatch a final whole-branch code review (most capable available model). Address Critical/Important findings with a fix subagent, re-review, and re-verify the codebase map as the literal last commit if the fix pass touches any mapped file.
- [ ] **Step 5:** Merge to `main`, push to `origin`.
- [ ] **Step 6:** `gh issue close 125` with a summary comment.
- [ ] **Step 7:** Update project memory.
