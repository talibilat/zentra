# Agent Rail Console Phase 2 Step 4b (Milestones) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Milestones nav item in the Agent Rail Console to real data — `GET /api/v1/zentra/milestones` and `GET /api/v1/zentra/milestones/:milestoneId` routes backed by `WorkflowSurface.listMilestones()`/`getMilestone()`, and a `milestones-section.ts` console section with list + click-to-fetch detail — replacing the disabled "Phase 2" placeholder.

**Architecture:** `WorkflowSurface.listMilestones()`/`getMilestone()` construct a `MilestoneRegistry` from the surface's existing journal and delegate to its existing `list()`/`inspect()`. Unlike Step 4a (Pods), this needs two gateway routes because `MilestoneRegistry.list()` returns a lightweight `MilestoneSummary` while `inspect()` returns the much richer `MilestoneRecord` — the console section fetches the list once after session handoff, then fetches full detail on each card click (mirroring Controls' `selectRun`, not Pods' pure-client-side-selection).

**Tech Stack:** TypeScript (Node, ESM), Vitest, the existing framework-free console template-literal pattern, Playwright-driven Chromium for e2e.

## Global Constraints

- No mutation capability from the console for milestones — read-only, per the spec's non-goals.
- The detail route always returns the full `MilestoneRecord` — no lifecycle-dependent truncation like the CLI's `publicMilestoneStatus()` (see spec's Context/Non-goals for why).
- DOM must be built via `document.createElement`/`setText`, never `innerHTML` (console-wide rule).
- `data-screen-label` on `milestones-section.ts`'s markup must exactly match `"Milestones"` (the nav item's `label` in `shell.ts`).
- Reuse the existing `.workspace[data-columns="2"]` CSS variant (added for Pods) — do not add a new grid variant.
- Enabling the `milestones` nav item shifts the keyboard Tab order by one; this plan includes fixing `tests/ui/cross-surface-acceptance.e2e.test.ts` and `tests/ui/chromium-acceptance.ts` as an explicit task (Task 5), not an afterthought.
- Adding new files under `src/gateway/console/`/`tests/gateway/console/` requires regenerating `docs/codebase-map.html` via `pnpm docs:codebase-map` — also Task 5.
- Test-driven development: write the failing test before the implementation, for every task.

---

### Task 1: `WorkflowSurface.listMilestones()` and `getMilestone()`

**Files:**
- Modify: `src/surfaces/workflow-surface.ts:41` (new import), `src/surfaces/workflow-surface.ts:337-339` (insert after `listPods()`, before `private listRunsProjection()`)
- Test: `tests/surfaces/workflow-surface.test.ts`

**Interfaces:**
- Consumes: `MilestoneRegistry` (`src/milestones/milestone-registry.ts`, constructor `(journal: EventJournal)`, methods `list(): readonly MilestoneSummary[]` and `inspect(milestoneId: string): MilestoneRecord | null`).
- Produces: `WorkflowSurface.listMilestones(): readonly MilestoneSummary[]` and `WorkflowSurface.getMilestone(milestoneId: string): MilestoneRecord | null` — consumed by Task 2's gateway routes.

- [ ] **Step 1: Write the failing tests**

Add to `tests/surfaces/workflow-surface.test.ts`. First add these two imports near the top of the file, alongside the existing `PodRegistry`/`charter` imports added for Step 4a:

```ts
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";
import type { MilestonePlan } from "../../src/contracts/milestone.js";
```

Add a helper function anywhere near the bottom of the file, alongside the other test helper functions (e.g. near `temporaryDirectory()`):

```ts
function milestonePlan(milestoneId: string, taskId: string): MilestonePlan {
  return {
    milestoneId,
    projectId: "zentra",
    goal: `Goal for ${milestoneId}`,
    tasks: [{
      taskId,
      title: "Task",
      description: "Task description.",
      dependencies: [],
      ownedPaths: ["src/**"],
      forbiddenPaths: [".env"],
      acceptanceCriteria: ["Done."],
      roleAssignment: { role: "planner", agentId: "opencode-general", harness: "opencode" },
      risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
      budget: { maxSeconds: 300, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000 },
    }],
  };
}
```

Then add these tests inside the existing `describe("WorkflowSurface", () => { ... })` block, right after the `"lists registered pods by bounded replay..."` and `"returns an empty list when no pods are registered"` tests added for Step 4a:

```ts
  it("lists registered milestones by bounded replay", () => {
    const directory = temporaryDirectory();
    const journal = new SqliteEventJournal(path.join(directory, "workflow.sqlite"));
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-a", projectId: "zentra", title: "First milestone",
      correlationId: "trace-a", tracePath: "/tmp/trace-a.jsonl", plan: milestonePlan("milestone-a", "task-a"),
    });
    registry.register({
      milestoneId: "milestone-b", projectId: "zentra", title: "Second milestone",
      correlationId: "trace-b", tracePath: "/tmp/trace-b.jsonl", plan: milestonePlan("milestone-b", "task-b"),
    });

    const milestones = surfaceFor(journal).listMilestones();

    expect(milestones.map((milestone) => milestone.milestoneId)).toEqual(["milestone-a", "milestone-b"]);
    expect(milestones[0]).toMatchObject({ milestoneId: "milestone-a", projectId: "zentra", title: "First milestone", lifecycle: "ready", taskCount: 1 });
    journal.close();
  });

  it("returns an empty list when no milestones are registered", () => {
    const directory = temporaryDirectory();
    const journal = new SqliteEventJournal(path.join(directory, "workflow.sqlite"));
    expect(surfaceFor(journal).listMilestones()).toEqual([]);
    journal.close();
  });

  it("gets full milestone detail including plan and tasks", () => {
    const directory = temporaryDirectory();
    const journal = new SqliteEventJournal(path.join(directory, "workflow.sqlite"));
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-a", projectId: "zentra", title: "First milestone",
      correlationId: "trace-a", tracePath: "/tmp/trace-a.jsonl", plan: milestonePlan("milestone-a", "task-a"),
    });

    const milestone = surfaceFor(journal).getMilestone("milestone-a");

    expect(milestone).toMatchObject({
      milestoneId: "milestone-a", projectId: "zentra", title: "First milestone", lifecycle: "ready",
      plan: { milestoneId: "milestone-a", goal: "Goal for milestone-a" },
    });
    expect(milestone!.tasks["task-a"]).toBeDefined();
    journal.close();
  });

  it("returns null from getMilestone for an unknown id", () => {
    const directory = temporaryDirectory();
    const journal = new SqliteEventJournal(path.join(directory, "workflow.sqlite"));
    expect(surfaceFor(journal).getMilestone("missing")).toBeNull();
    journal.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/surfaces/workflow-surface.test.ts -t "milestone"`
Expected: FAIL with `TypeError: surfaceFor(...).listMilestones is not a function` (and similarly for `getMilestone`)

- [ ] **Step 3: Add the `MilestoneRegistry` import to `workflow-surface.ts`**

In `src/surfaces/workflow-surface.ts`, add this line to the import block, immediately before the existing `import type { PlanningAuthorityEnvelope } from "../planning/planning-contracts.js";` line (alphabetical: `milestones` before `planning`):

```ts
import { MilestoneRegistry, type MilestoneRecord, type MilestoneSummary } from "../milestones/milestone-registry.js";
```

- [ ] **Step 4: Add `listMilestones()` and `getMilestone()` to the `WorkflowSurface` class**

In `src/surfaces/workflow-surface.ts`, insert immediately after the closing `}` of `listPods()` (currently lines 337-339), before the blank line and `private listRunsProjection()`:

```ts
  listMilestones(): readonly MilestoneSummary[] {
    return this.guard(() => new MilestoneRegistry(this.journal).list());
  }

  getMilestone(milestoneId: string): MilestoneRecord | null {
    return this.guard(() => new MilestoneRegistry(this.journal).inspect(milestoneId));
  }

```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/surfaces/workflow-surface.test.ts`
Expected: PASS (all tests in the file, including the four new ones)

- [ ] **Step 6: Type-check**

Run: `pnpm check`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/surfaces/workflow-surface.ts tests/surfaces/workflow-surface.test.ts
git commit -m "Add WorkflowSurface.listMilestones()/getMilestone() over the existing MilestoneRegistry"
```

---

### Task 2: Gateway routes `GET /api/v1/zentra/milestones` and `GET /api/v1/zentra/milestones/:milestoneId`

**Files:**
- Modify: `src/gateway/loopback-gateway.ts:389-391` (insert after the `pods` GET branch)
- Test: `tests/gateway/loopback-gateway.test.ts`

**Interfaces:**
- Consumes: `WorkflowSurface.listMilestones()`/`getMilestone()` from Task 1 (via `this.workflow!.listMilestones`/`getMilestone` through the existing generic `invoke()` mechanism — no new gateway plumbing needed).
- Produces: `GET /api/v1/zentra/milestones` → 200 `MilestoneSummary[]`; `GET /api/v1/zentra/milestones/:milestoneId` → 200 `MilestoneRecord` | 404 — consumed by Task 3's `milestones-section.ts`.

- [ ] **Step 1: Write the failing tests**

In `tests/gateway/loopback-gateway.test.ts`, add to the `workflow()` fixture function, immediately after the existing `listPods` line:

```ts
    listMilestones: vi.fn(() => [{ milestoneId: "milestone-1", projectId: "zentra", title: "First milestone", lifecycle: "ready", terminalOutcome: null, streamVersion: 3, traceId: "trace-1", tracePath: null, taskCount: 1, result: null }]),
    getMilestone: vi.fn((milestoneId: string) => milestoneId === "missing" ? null : ({ milestoneId, projectId: "zentra", title: "First milestone", lifecycle: "ready", streamVersion: 3, plan: { milestoneId, tasks: [] } })),
```

Then add a new test inside `describe("LoopbackGateway", () => { ... })`, immediately after the `"exposes pods as a read-only, bearer-authenticated route"` test:

```ts
  it("exposes milestones as read-only, bearer-authenticated list and detail routes", async () => {
    const surface = workflow();
    const gateway = new LoopbackGateway({ workflow: surface });
    const session = await gateway.start(); gateway.setReadiness("ready");
    try {
      expect((await fetch(`${session.origin}/api/v1/zentra/milestones`)).status).toBe(401);
      expect((await fetch(`${session.origin}/api/v1/zentra/milestones/milestone-1`)).status).toBe(401);
      const auth = await establish(session);
      expect(await apiJson(session, auth, "/milestones")).toEqual([
        { milestoneId: "milestone-1", projectId: "zentra", title: "First milestone", lifecycle: "ready", terminalOutcome: null, streamVersion: 3, traceId: "trace-1", tracePath: null, taskCount: 1, result: null },
      ]);
      expect(surface.listMilestones).toHaveBeenCalledTimes(1);
      surface.listMilestones.mockReturnValueOnce([]);
      expect(await apiJson(session, auth, "/milestones")).toEqual([]);

      expect(await apiJson(session, auth, "/milestones/milestone-1")).toMatchObject({ milestoneId: "milestone-1", lifecycle: "ready" });
      expect(surface.getMilestone).toHaveBeenCalledWith("milestone-1");
      expect((await api(session, auth, "/milestones/missing")).status).toBe(404);
    } finally { await gateway.close(); }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/gateway/loopback-gateway.test.ts -t "exposes milestones as read-only"`
Expected: FAIL with 404 responses on both routes (or a TypeScript error on `listMilestones`/`getMilestone` not existing on the mocked surface type) — either is the correct failure signal before Step 3.

- [ ] **Step 3: Add the routes**

In `src/gateway/loopback-gateway.ts`, insert immediately after the closing `}` of the existing `pods` GET branch (currently lines 389-391), before the `runs` POST branch:

```ts
      if (request.method === "GET" && segments.length === 1 && segments[0] === "milestones" && url.search === "") {
        return this.jsonResult(response, await this.invoke("listMilestones"));
      }
      if (request.method === "GET" && segments.length === 2 && segments[0] === "milestones" && url.search === "") {
        const milestoneId = decodeSegment(segments[1]!, response); if (milestoneId === null) return;
        return this.jsonResult(response, await this.invoke("getMilestone", milestoneId));
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/gateway/loopback-gateway.test.ts`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Type-check**

Run: `pnpm check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/gateway/loopback-gateway.ts tests/gateway/loopback-gateway.test.ts
git commit -m "Expose GET /api/v1/zentra/milestones list and detail routes on the loopback gateway"
```

---

### Task 3: `milestones-section.ts` console section

**Files:**
- Create: `src/gateway/console/milestones-section.ts`
- Test: `tests/gateway/console/milestones-section.test.ts`

**Interfaces:**
- Consumes (at runtime, in the concatenated browser script, from `controls-section.ts`'s shared scope): `$`, `setText`, `request`, `value`, `list`, `label`, `badge`, `field`, `appendJson` (same shared helpers Pods already uses — do not import or redefine them).
- Produces: `MILESTONES_MARKUP: string`, `MILESTONES_SCRIPT: string` (exported) — consumed by Task 4's `shell.ts` and `console-ui.ts`. At runtime, registers `window.__consoleSections.milestones = {render: renderMilestones, load: loadMilestones}` — `load` consumed by Task 4's edit to `controls-section.ts`'s `refresh()`.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/console/milestones-section.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { MILESTONES_MARKUP, MILESTONES_SCRIPT } from "../../../src/gateway/console/milestones-section.js";

describe("milestones section", () => {
  it("keeps a two-panel workspace with a list root and a detail root", () => {
    expect(MILESTONES_MARKUP).toContain('id="milestones-list"');
    expect(MILESTONES_MARKUP).toContain('id="milestone-detail"');
  });

  it("reuses the shared two-column workspace variant", () => {
    expect(MILESTONES_MARKUP).toContain('data-columns="2"');
  });

  it("carries the data-screen-label the nav item's label must match", () => {
    expect(MILESTONES_MARKUP).toContain('data-screen-label="Milestones"');
  });

  it("fetches the milestone list from the real API, not a static demo dataset", () => {
    expect(MILESTONES_SCRIPT).toContain('request("/api/v1/zentra/milestones")');
    expect(MILESTONES_SCRIPT).not.toContain("DEMO_DATA");
  });

  it("fetches full milestone detail on selection, not just from the list response", () => {
    expect(MILESTONES_SCRIPT).toContain('request("/api/v1/zentra/milestones/"+encodeURIComponent(id))');
  });

  it("registers a load hook and does not self-invoke at script load", () => {
    expect(MILESTONES_SCRIPT).toContain("window.__consoleSections.milestones={render:renderMilestones,load:loadMilestones}");
    expect(MILESTONES_SCRIPT.trim().endsWith("load:loadMilestones};")).toBe(true);
  });

  it("never builds DOM with innerHTML", () => {
    expect(MILESTONES_SCRIPT).not.toContain("innerHTML");
  });

  it("selects a milestone on click", () => {
    expect(MILESTONES_SCRIPT).toContain('addEventListener("click"');
  });

  it("shows honest empty states for the list and the detail panel", () => {
    expect(MILESTONES_SCRIPT).toContain("No milestones yet.");
    expect(MILESTONES_SCRIPT).toContain("Milestones unavailable.");
    expect(MILESTONES_SCRIPT).toContain("Select a milestone to inspect its plan, tasks, and history.");
    expect(MILESTONES_SCRIPT).toContain("Milestone detail unavailable.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/gateway/console/milestones-section.test.ts`
Expected: FAIL with a module resolution error (`Cannot find module '../../../src/gateway/console/milestones-section.js'`)

- [ ] **Step 3: Create `src/gateway/console/milestones-section.ts`**

```ts
export const MILESTONES_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Milestones"><section class="workspace" data-columns="2" aria-label="Milestones"><section class="panel"><h2>Milestones</h2><div id="milestones-list" class="stack"></div></section><section class="panel"><h2>Milestone detail</h2><div id="milestone-detail"></div></section></section></div>`;

export const MILESTONES_SCRIPT = String.raw`let milestonesState=[];let milestonesLoadFailed=false;let milestoneSelectedId=null;let milestoneDetail=null;let milestoneDetailLoadFailed=false;
const loadMilestones=async()=>{
  try{const result=await request("/api/v1/zentra/milestones");milestonesState=list(result,["milestones"]);milestonesLoadFailed=false}
  catch{milestonesState=[];milestonesLoadFailed=true}
  if(milestoneSelectedId&&!milestonesState.some(milestone=>milestone.milestoneId===milestoneSelectedId)){milestoneSelectedId=null;milestoneDetail=null}
  renderMilestones();
};
const selectMilestone=async(id)=>{
  milestoneSelectedId=id;
  try{milestoneDetail=await request("/api/v1/zentra/milestones/"+encodeURIComponent(id));milestoneDetailLoadFailed=false}
  catch{milestoneDetail=null;milestoneDetailLoadFailed=true}
  renderMilestones();
};
const renderMilestonesList=()=>{
  const host=$("milestones-list");host.replaceChildren();
  if(!milestonesState.length){const empty=document.createElement("p");empty.className="empty";setText(empty,milestonesLoadFailed?"Milestones unavailable.":"No milestones yet.");host.append(empty);return}
  for(const milestone of milestonesState){
    const button=document.createElement("button");button.type="button";button.className="run-card";
    button.dataset.selected=String(milestone.milestoneId===milestoneSelectedId);
    const title=document.createElement("strong");setText(title,milestone.title);
    const meta=document.createElement("span");setText(meta,milestone.milestoneId+" · "+milestone.taskCount+" tasks");
    button.append(title,meta,badge(label(milestone.lifecycle)));
    button.addEventListener("click",()=>selectMilestone(milestone.milestoneId));
    host.append(button);
  }
};
const renderMilestoneDetail=()=>{
  const host=$("milestone-detail");host.replaceChildren();
  if(!milestoneSelectedId){const empty=document.createElement("p");empty.className="empty";setText(empty,"Select a milestone to inspect its plan, tasks, and history.");host.append(empty);return}
  const milestone=milestoneDetail;
  if(!milestone){const empty=document.createElement("p");empty.className="empty";setText(empty,"Milestone detail unavailable.");host.append(empty);return}
  const heading=document.createElement("h3");setText(heading,milestone.title);
  const facts=document.createElement("dl");facts.className="facts";
  const taskCount=Object.keys(milestone.tasks||{}).length;
  facts.append(
    field("Milestone",milestone.milestoneId),
    field("Project",milestone.projectId),
    field("Title",milestone.title),
    field("Lifecycle",label(milestone.lifecycle)),
    field("Terminal outcome",milestone.terminalOutcome?label(milestone.terminalOutcome):"Not terminal"),
    field("Tasks",String(taskCount)),
    field("Trace ID",milestone.traceId),
    field("Trace path",milestone.tracePath||"None"),
  );
  host.append(heading,facts);
  appendJson(host,"Plan",milestone.plan);
  appendJson(host,"Tasks",milestone.tasks);
  appendJson(host,"Historical tasks",milestone.historicalTasks);
  appendJson(host,"Writer ownership",milestone.writerOwnership);
  appendJson(host,"Revisions",milestone.revisions);
  appendJson(host,"Attention",milestone.attention);
  appendJson(host,"Replanning attention",milestone.replanningAttention);
  appendJson(host,"Authority envelope",milestone.authorityEnvelope);
  appendJson(host,"Result",milestone.result);
  appendJson(host,"Release operation",milestone.releaseOperation);
};
const renderMilestones=()=>{renderMilestonesList();renderMilestoneDetail()};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.milestones={render:renderMilestones,load:loadMilestones};`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/gateway/console/milestones-section.test.ts`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Type-check**

Run: `pnpm check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/gateway/console/milestones-section.ts tests/gateway/console/milestones-section.test.ts
git commit -m "Add milestones-section.ts: list + click-to-fetch detail over real milestone data"
```

---

### Task 4: Wire Milestones into the shell, script bundle, and refresh cycle

**Files:**
- Modify: `src/gateway/console/shell.ts` (imports, `NAV_GROUPS`, section wrapper list)
- Modify: `src/gateway/console/console-ui.ts` (import, `CONSOLE_SCRIPT` concatenation)
- Modify: `src/gateway/console/controls-section.ts:76` (`refresh()`)
- Modify: `tests/gateway/console/shell.test.ts`
- Modify: `tests/gateway/console/console-ui.test.ts`
- Modify: `tests/gateway/console/controls-section.test.ts`

**Interfaces:**
- Consumes: `MILESTONES_MARKUP`, `MILESTONES_SCRIPT` from Task 3; `window.__consoleSections.milestones?.load?.()` (registered by Task 3's `MILESTONES_SCRIPT`).
- Produces: the Milestones nav item becomes clickable and shows the wired section; `controls-section.ts`'s `refresh()` now also triggers a milestones load on every session-ready and every subsequent refresh cycle.

- [ ] **Step 1: Write the failing tests**

In `tests/gateway/console/shell.test.ts`, replace the existing test (currently titled `"marks Controls, Overview, Trail, and Pods as enabled nav targets"`, lines 22-29):

```ts
  it("marks Controls, Overview, Trail, and Pods as enabled nav targets", () => {
    for (const enabled of ["data-nav-id=\"controls\"", "data-nav-id=\"overview\"", "data-nav-id=\"trail\"", "data-nav-id=\"pods\""]) {
      expect(SHELL_MARKUP).toContain(enabled);
    }
    expect(SHELL_MARKUP).not.toContain('data-nav-id="pods" disabled');
    expect(SHELL_MARKUP).toContain('data-nav-id="milestones" disabled');
    expect(SHELL_MARKUP).toContain('data-nav-id="journal" disabled');
  });
```

with:

```ts
  it("marks Controls, Overview, Trail, Pods, and Milestones as enabled nav targets", () => {
    for (const enabled of ["data-nav-id=\"controls\"", "data-nav-id=\"overview\"", "data-nav-id=\"trail\"", "data-nav-id=\"pods\"", "data-nav-id=\"milestones\""]) {
      expect(SHELL_MARKUP).toContain(enabled);
    }
    expect(SHELL_MARKUP).not.toContain('data-nav-id="pods" disabled');
    expect(SHELL_MARKUP).not.toContain('data-nav-id="milestones" disabled');
    expect(SHELL_MARKUP).toContain('data-nav-id="journal" disabled');
  });
```

In `tests/gateway/console/console-ui.test.ts`, add `expect(html).toContain('id="milestones-list"');` to the existing `"includes every section's markup and preserves controls' DOM ids"` test (after the `id="pods-list"` line), and add two new tests after the existing `"includes the Pods section's data-screen-label marker"` test:

```ts
  it("includes the Milestones section's data-screen-label marker", () => {
    const html = consoleHtml();
    expect(html).toContain('data-screen-label="Milestones"');
  });

  it("concatenates MILESTONES_SCRIPT into the composed document", () => {
    const html = consoleHtml();
    expect(html).toContain("window.__consoleSections.milestones={render:renderMilestones,load:loadMilestones}");
  });
```

In `tests/gateway/console/controls-section.test.ts`, add a new test after the existing `"reloads the Pods section on refresh"` test:

```ts
  it("reloads the Milestones section on refresh", () => {
    expect(CONTROLS_SCRIPT).toContain("window.__consoleSections.milestones?.load?.()");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/gateway/console/shell.test.ts tests/gateway/console/console-ui.test.ts tests/gateway/console/controls-section.test.ts`
Expected: FAIL — the shell test fails because `milestones` is still `enabled: false`; the console-ui tests fail because `milestones-section.ts` isn't imported/concatenated yet; the controls-section test fails because the hook doesn't exist yet.

- [ ] **Step 3: Wire `shell.ts`**

In `src/gateway/console/shell.ts`, add this import after the existing `import { PODS_MARKUP } from "./pods-section.js";` line:

```ts
import { MILESTONES_MARKUP } from "./milestones-section.js";
```

Change the `milestones` entry in `NAV_GROUPS` (currently `{ id: "milestones", label: "Milestones", icon: "⊕", enabled: false },`) to:

```ts
    { id: "milestones", label: "Milestones", icon: "⊕", enabled: true },
```

Add the section wrapper. In the `SHELL_MARKUP` template, immediately after the existing `<section class="section" data-section-id="pods">${PODS_MARKUP}</section>` line, insert:

```ts
    <section class="section" data-section-id="milestones">${MILESTONES_MARKUP}</section>
```

- [ ] **Step 4: Wire `console-ui.ts`**

In `src/gateway/console/console-ui.ts`, add this import after the existing `import { PODS_SCRIPT } from "./pods-section.js";` line:

```ts
import { MILESTONES_SCRIPT } from "./milestones-section.js";
```

Change the `CONSOLE_SCRIPT` line from:

```ts
const CONSOLE_SCRIPT = `(()=>{"use strict";${CONTROLS_SCRIPT}\n${TRAIL_SCRIPT}\n${OVERVIEW_SCRIPT}\n${WARNINGS_SCRIPT}\n${SECURITY_SCRIPT}\n${COST_SCRIPT}\n${COMPARE_SCRIPT}\n${IMPORTS_SCRIPT}\n${POLICIES_SCRIPT}\n${PODS_SCRIPT}\n${SHELL_SCRIPT}})();`;
```

to:

```ts
const CONSOLE_SCRIPT = `(()=>{"use strict";${CONTROLS_SCRIPT}\n${TRAIL_SCRIPT}\n${OVERVIEW_SCRIPT}\n${WARNINGS_SCRIPT}\n${SECURITY_SCRIPT}\n${COST_SCRIPT}\n${COMPARE_SCRIPT}\n${IMPORTS_SCRIPT}\n${POLICIES_SCRIPT}\n${PODS_SCRIPT}\n${MILESTONES_SCRIPT}\n${SHELL_SCRIPT}})();`;
```

- [ ] **Step 5: Hook `loadMilestones` into the refresh cycle**

In `src/gateway/console/controls-section.ts`, find the `refresh` function (ends with `...window.__consoleSections.trail?.load?.();window.__consoleSections.pods?.load?.()};`). Change the ending from:

```
window.__consoleSections.trail?.load?.();window.__consoleSections.pods?.load?.()};
```

to:

```
window.__consoleSections.trail?.load?.();window.__consoleSections.pods?.load?.();window.__consoleSections.milestones?.load?.()};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/gateway/console/shell.test.ts tests/gateway/console/console-ui.test.ts tests/gateway/console/controls-section.test.ts tests/gateway/console/milestones-section.test.ts`
Expected: PASS (all tests in all four files)

- [ ] **Step 7: Type-check and run the full gateway test directory**

Run: `pnpm check`
Expected: no errors

Run: `pnpm exec vitest run tests/gateway`
Expected: PASS (every gateway test, confirming nothing else in the composed console broke)

- [ ] **Step 8: Commit**

```bash
git add src/gateway/console/shell.ts src/gateway/console/console-ui.ts src/gateway/console/controls-section.ts tests/gateway/console/shell.test.ts tests/gateway/console/console-ui.test.ts tests/gateway/console/controls-section.test.ts
git commit -m "Wire Milestones into the console shell, script bundle, and refresh cycle"
```

---

### Task 5: Fix the two recurring regressions this nav change causes

**Files:**
- Modify: `tests/ui/chromium-acceptance.ts:167`
- Modify: `tests/ui/cross-surface-acceptance.e2e.test.ts:139-153`
- Modify: `docs/codebase-map.html` (regenerated, not hand-edited)

**Interfaces:** none — this task fixes two known-recurring test regressions caused by Task 4's nav change, verified by pre-existing tests rather than new ones.

Enabling the `milestones` nav item shifts the console's keyboard Tab order by one, and adding two new files (`milestones-section.ts`, `milestones-section.test.ts`) makes `docs/codebase-map.html` stale. Both bug classes have happened twice already on this project (see `project_agent_rail_console_phase1` memory) — fix them now as part of this feature, not as a follow-up discovered by a later whole-branch review.

- [ ] **Step 1: Fix the stale keyboard-focus-order assertion**

In `tests/ui/chromium-acceptance.ts`, find `for (let index = 0; index < 14; index += 1) {` (inside `inspectHostileSource`'s Tab-capture loop) and change `14` to `15`.

In `tests/ui/cross-surface-acceptance.e2e.test.ts`, find:

```ts
    expect(browserResult.focusOrder.slice(0, 14)).toEqual([
      "button::▶ Controls",
      "button::◉ Overview",
      "button::⬡ Trail",
      "button::△ Warnings",
      "button::⛨ Security",
      "button::◔ Cost",
      "button::⑂ Compare runs",
      "button::⇥ Imports",
      "button::⬢ Pods",
      "button::⚙ Warning policies",
      expect.stringMatching(/^button:run-switcher-button:tickets/u),
      "textarea:goal:Goal",
      "button::Submit goal",
      "input:ticket-path:Project-relative folder",
    ]);
```

Change `.slice(0, 14)` to `.slice(0, 15)`, and insert `"button::⊕ Milestones",` as a new line immediately after `"button::⬢ Pods",` and immediately before `"button::⚙ Warning policies",` (GitHub broker and Journal remain disabled, so they stay out of the tab order entirely).

- [ ] **Step 2: Verify the focus-order fix**

Run: `pnpm exec vitest run tests/ui/cross-surface-acceptance.e2e.test.ts`
Expected: PASS (if this environment has no canonical headless Chromium, it will SKIP instead — note which happened)

- [ ] **Step 3: Regenerate the codebase map**

Run: `pnpm docs:codebase-map`

- [ ] **Step 4: Verify the codebase-map fix**

Run: `pnpm exec vitest run tests/docs/codebase-map.test.ts`
Expected: PASS

- [ ] **Step 5: Commit both fixes separately**

```bash
git add tests/ui/chromium-acceptance.ts tests/ui/cross-surface-acceptance.e2e.test.ts
git commit -m "Fix stale keyboard-focus-order assertion after enabling Milestones nav item (widen shared capture loop to 15)"
git add docs/codebase-map.html
git commit -m "Regenerate codebase map after Milestones console section"
```

(Committed in this order deliberately: the test-file commit first, then the map regeneration second, so the map reflects the test file's final line numbers — the same ordering mistake from Step 4a's fix pass to avoid repeating.)

---

### Task 6: Real-browser e2e coverage

**Files:**
- Modify: `tests/ui/console-shell.e2e.test.ts`

**Interfaces:**
- Consumes: `consoleShellWorkflow(root)` (existing helper), `MilestoneRegistry` (`src/milestones/milestone-registry.ts`), `MilestonePlan` (`src/contracts/milestone.ts`), `ChromiumWorkflowDriver` (existing helper with `.click(selector)`, `.waitFor(expression)`, `.evaluate<T>(expression)`).
- Produces: e2e proof that the Milestones nav item is genuinely enabled and renders real registered-milestone data end-to-end through the real HTTP routes (both list and detail).

- [ ] **Step 1: Write the failing test**

In `tests/ui/console-shell.e2e.test.ts`, add this import near the top, alongside the existing `PodRegistry`/`charter` imports:

```ts
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";
import type { MilestonePlan } from "../../src/contracts/milestone.js";
```

Add a helper function near the top of the file (module scope, alongside the `label()` helper):

```ts
function milestonePlanFixture(milestoneId: string, taskId: string): MilestonePlan {
  return {
    milestoneId,
    projectId: "zentra",
    goal: `Goal for ${milestoneId}`,
    tasks: [{
      taskId,
      title: "Task",
      description: "Task description.",
      dependencies: [],
      ownedPaths: ["src/**"],
      forbiddenPaths: [".env"],
      acceptanceCriteria: ["Done."],
      roleAssignment: { role: "planner", agentId: "opencode-general", harness: "opencode" },
      risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
      budget: { maxSeconds: 300, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000 },
    }],
  };
}
```

Add a new test inside `describe.skipIf(acceptanceBrowser === null)("console shell, real browser", () => { ... })`, after the `"enables the Pods nav item and renders a registered pod's detail on click"` test:

```ts
  it("enables the Milestones nav item and renders a registered milestone's plan on click", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-milestones-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    new MilestoneRegistry(fixture.journal).register({
      milestoneId: "milestone-e2e", projectId: "zentra", title: "E2E milestone",
      correlationId: "trace-milestone-e2e", tracePath: "/tmp/milestone-e2e.jsonl",
      plan: milestonePlanFixture("milestone-e2e", "task-e2e"),
    });
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.click('[data-nav-id="milestones"]');
      await driver.waitFor(`document.querySelector('[data-section-id="milestones"]')?.dataset.active === "true"`);
      await driver.waitFor(`document.getElementById("milestones-list")?.textContent.includes("E2E milestone")`);
      await driver.click('#milestones-list button.run-card');
      await driver.waitFor(`document.getElementById("milestone-detail")?.textContent.includes("Goal for milestone-e2e")`);
      const detailText = await driver.evaluate<string>(`document.getElementById("milestone-detail")?.textContent || ""`);
      expect(detailText).toContain("milestone-e2e");
      expect(detailText).toContain("Ready");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts -t "enables the Milestones nav item"`
Expected: either SKIP (if no canonical headless Chromium is available in this environment) or FAIL at the first `waitFor` (nav item still disabled / click has no effect) if Chromium is available.

- [ ] **Step 3: No implementation step — Tasks 1-5 already made this pass**

This task is pure verification of the already-implemented behavior; there is no new source change here.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts`
Expected: PASS on every test in the file (or SKIP if this environment has no canonical Chromium — note which happened)

- [ ] **Step 5: Commit**

```bash
git add tests/ui/console-shell.e2e.test.ts
git commit -m "Add e2e coverage for the Milestones nav item and milestone detail rendering"
```

---

### Task 7: Full verification, merge, push, and issue tracking

**Files:** none (verification, git, and GitHub issue operations only)

**Interfaces:** none — this task consumes the finished state of Tasks 1-6 and produces the shipped, tracked result.

- [ ] **Step 1: Run the full check and test suite**

Run: `pnpm check`
Expected: no errors

Run: `pnpm test`
Expected: PASS (every test in the repository). Expect roughly 8-9 pre-existing environmental failures unrelated to this work (Docker Desktop unavailable, npm-pack/install e2e, AgentTrail fleet byte-eviction timing, and other heavy real-subprocess/real-browser tests — these flake under concurrent load but pass in isolation, per Step 4a's experience). Verify any failure beyond that known baseline by re-running the specific file in isolation (`pnpm exec vitest run <file>`) before treating it as a real regression from this branch.

- [ ] **Step 2: Build and verify the package**

Run: `pnpm build`
Expected: succeeds with no errors

- [ ] **Step 3: Merge the worktree branch into `main`**

(Exact branch name depends on what `superpowers:using-git-worktrees` created at execution start — substitute it below.)

```bash
git -C /Users/talibilat/Documents/Projects/zentra checkout main
git -C /Users/talibilat/Documents/Projects/zentra merge --no-ff <worktree-branch-name>
```

- [ ] **Step 4: Push `main`**

```bash
git -C /Users/talibilat/Documents/Projects/zentra push origin main
```

- [ ] **Step 5: Close #122**

```bash
gh issue close 122 --comment "Shipped: WorkflowSurface.listMilestones()/getMilestone(), GET /api/v1/zentra/milestones (+ /:id), and milestones-section.ts wired into the console shell. See docs/superpowers/specs/2026-08-06-agent-rail-console-phase2-milestones-design.md and docs/superpowers/plans/2026-08-06-agent-rail-console-phase2-milestones-plan.md."
```

- [ ] **Step 6: Update project memory**

Update `project_agent_rail_console_phase1.md` in the memory directory (`/Users/talibilat/.claude/projects/-Users-talibilat-Documents-Projects-zentra/memory/`) to record: #122 (Step 4b, Milestones) shipped, with its merge commit SHA; that it needed two gateway routes (list + detail) unlike Pods' one, confirming the issue's own prediction about `MilestoneSummary` vs `MilestoneRecord`; that the CLI's `publicMilestoneStatus()` truncation was deliberately not mirrored; and that the recurring focus-order/codebase-map regressions were fixed proactively this time (Task 5) rather than caught by a late whole-branch review, worth noting as evidence the earlier lesson stuck. Update the memory's `description` and `MEMORY.md`'s index line accordingly, following the existing file's structure.
