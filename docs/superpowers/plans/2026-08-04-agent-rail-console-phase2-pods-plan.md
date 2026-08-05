# Agent Rail Console Phase 2 Step 4a (Pods) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Pods nav item in the Agent Rail Console to real data — a new `GET /api/v1/zentra/pods` route backed by `WorkflowSurface.listPods()`, and a `pods-section.ts` console section with list + click-to-select detail — replacing the disabled "Phase 2" placeholder.

**Architecture:** `WorkflowSurface.listPods()` constructs a `PodRegistry` from the surface's existing journal and returns `PodRegistry.list()`'s full `PodView[]` (no summary/detail split needed — `list()` already returns full projections). The gateway exposes it as one new `GET`-only route. The console section fetches once after session handoff (hooking into `controls-section.ts`'s existing `refresh()`, the same extension point Overview and Trail already use), then renders selection client-side from the already-fetched list — no per-pod detail fetch.

**Tech Stack:** TypeScript (Node, ESM), Vitest, the existing framework-free console template-literal pattern (no React/build step for the browser script), Playwright-driven Chromium for e2e.

## Global Constraints

- No mutation capability from the console for pods — read-only, per the spec's non-goals.
- No `GET /pods/:podId` route — the list response already contains full detail per pod (YAGNI, per spec).
- DOM must be built via `document.createElement`/`setText`, never `innerHTML` (established console-wide rule).
- Any `CONSOLE_FONT_STACK_MONO`/`CONSOLE_FONT_STACK_SANS` interpolation must be isolated into single-quoted one-line constants, never inlined into a double-quoted JS string or HTML attribute (the bug class #119's review caught twice — not applicable here since `pods-section.ts` uses no font-stack interpolation at all, but do not add any without following this rule).
- `data-screen-label` on a section's markup must exactly match its nav item's `label` in `shell.ts`'s `NAV_GROUPS` (the exact drift bug #120's review caught).
- Test-driven development: write the failing test before the implementation, for every task.

---

### Task 1: `WorkflowSurface.listPods()`

**Files:**
- Modify: `src/surfaces/workflow-surface.ts:331` (insert after `listRuns()`, before the `private listRunsProjection()` method)
- Test: `tests/surfaces/workflow-surface.test.ts`

**Interfaces:**
- Consumes: `PodRegistry` (`src/pods/pod-registry.ts`, constructor `(journal: EventJournal)`, method `list(): readonly PodView[]`), `PodView` (`src/pods/pod-projection.ts`).
- Produces: `WorkflowSurface.listPods(): readonly PodView[]` — consumed by Task 2's gateway route.

- [ ] **Step 1: Write the failing tests**

Add to `tests/surfaces/workflow-surface.test.ts`. First add two imports near the top of the file, alongside the existing `RunService` import:

```ts
import { PodRegistry } from "../../src/pods/pod-registry.js";
import { charter } from "../pods/pod-fixtures.js";
```

Then add a new test inside the existing `describe("WorkflowSurface", () => { ... })` block, right after the `"lists accepted streams by bounded replay..."` test (after its closing `});` around line 76):

```ts
  it("lists registered pods by bounded replay of pod.registered events", () => {
    const directory = temporaryDirectory();
    const journal = new SqliteEventJournal(path.join(directory, "workflow.sqlite"));
    const registry = new PodRegistry(journal);
    registry.register({ charter: charter({ podId: "pod-a" }), correlationId: "trace-a" });
    registry.register({ charter: charter({ podId: "pod-b" }), correlationId: "trace-b" });

    const pods = surfaceFor(journal).listPods();

    expect(pods.map((pod) => pod.podId)).toEqual(["pod-a", "pod-b"]);
    expect(pods[0]).toMatchObject({ podId: "pod-a", projectId: "zentra", lifecycle: "registered", revision: 1 });
    journal.close();
  });

  it("returns an empty list when no pods are registered", () => {
    const directory = temporaryDirectory();
    const journal = new SqliteEventJournal(path.join(directory, "workflow.sqlite"));
    expect(surfaceFor(journal).listPods()).toEqual([]);
    journal.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/surfaces/workflow-surface.test.ts -t "lists registered pods"`
Expected: FAIL with `TypeError: surfaceFor(...).listPods is not a function`

- [ ] **Step 3: Add the `PodRegistry`/`PodView` imports to `workflow-surface.ts`**

In `src/surfaces/workflow-surface.ts`, add these two lines to the import block (after the existing `import type { PlanningAuthorityEnvelope } from "../planning/planning-contracts.js";` line, alphabetically near the other domain imports):

```ts
import type { PodView } from "../pods/pod-projection.js";
import { PodRegistry } from "../pods/pod-registry.js";
```

- [ ] **Step 4: Add `listPods()` to the `WorkflowSurface` class**

In `src/surfaces/workflow-surface.ts`, insert immediately after the closing `}` of `listRuns()` (currently lines 331-333), before `private listRunsProjection()`:

```ts
  listPods(): readonly PodView[] {
    return this.guard(() => new PodRegistry(this.journal).list());
  }

```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/surfaces/workflow-surface.test.ts`
Expected: PASS (all tests in the file, including the two new ones)

- [ ] **Step 6: Type-check**

Run: `pnpm check`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/surfaces/workflow-surface.ts tests/surfaces/workflow-surface.test.ts
git commit -m "Add WorkflowSurface.listPods() over the existing PodRegistry"
```

---

### Task 2: Gateway route `GET /api/v1/zentra/pods`

**Files:**
- Modify: `src/gateway/loopback-gateway.ts:384-388`
- Test: `tests/gateway/loopback-gateway.test.ts`

**Interfaces:**
- Consumes: `WorkflowSurface.listPods()` from Task 1 (via `this.workflow!.listPods` through the existing `invoke()` mechanism — no new gateway plumbing needed, `invoke` is already generic over `keyof WorkflowSurface`).
- Produces: `GET /api/v1/zentra/pods` → 200 `PodView[]` (authenticated) / 401 (no bearer token) — consumed by Task 3's `pods-section.ts`.

- [ ] **Step 1: Write the failing test**

In `tests/gateway/loopback-gateway.test.ts`, add `listPods` to the `workflow()` fixture function (after the existing `listRuns` line, around line 461):

```ts
    listPods: vi.fn(() => [{ podId: "pod-1", projectId: "zentra", lifecycle: "registered", revision: 1 }]),
```

Then add a new test inside `describe("LoopbackGateway", () => { ... })`, after the `"maps every workflow route to one shared surface..."` test (after its closing `});` around line 245):

```ts
  it("exposes pods as a read-only, bearer-authenticated route", async () => {
    const surface = workflow();
    const gateway = new LoopbackGateway({ workflow: surface });
    const session = await gateway.start(); gateway.setReadiness("ready");
    try {
      expect((await fetch(`${session.origin}/api/v1/zentra/pods`)).status).toBe(401);
      const auth = await establish(session);
      expect(await apiJson(session, auth, "/pods")).toEqual([
        { podId: "pod-1", projectId: "zentra", lifecycle: "registered", revision: 1 },
      ]);
      expect(surface.listPods).toHaveBeenCalledTimes(1);
      surface.listPods.mockReturnValueOnce([]);
      expect(await apiJson(session, auth, "/pods")).toEqual([]);
    } finally { await gateway.close(); }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/gateway/loopback-gateway.test.ts -t "exposes pods as a read-only"`
Expected: FAIL with a 404 response (`expect(received).toEqual(expected)` on the first `apiJson` call, or a TypeScript error on `listPods` not existing on the mocked surface type — either is the correct failure signal before Step 3)

- [ ] **Step 3: Add the route**

In `src/gateway/loopback-gateway.ts`, insert immediately after the closing `}` of the existing `runs` GET branch (currently lines 386-388), before the `runs` POST branch:

```ts
      if (request.method === "GET" && segments.length === 1 && segments[0] === "pods" && url.search === "") {
        return this.jsonResult(response, await this.invoke("listPods"));
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
git commit -m "Expose GET /api/v1/zentra/pods on the loopback gateway"
```

---

### Task 3: `pods-section.ts` console section

**Files:**
- Create: `src/gateway/console/pods-section.ts`
- Test: `tests/gateway/console/pods-section.test.ts`

**Interfaces:**
- Consumes (at runtime, in the concatenated browser script, from `controls-section.ts`'s shared scope): `$(id)`, `setText(node, value)`, `request(path)`, `value(object, names, fallback)`, `list(result, names)`, `label(value, fallback)`, `badge(text)`, `field(term, description)`, `appendJson(host, label, data)`.
- Produces: `PODS_MARKUP: string`, `PODS_SCRIPT: string` (exported) — consumed by Task 4's `shell.ts` and `console-ui.ts`. At runtime, registers `window.__consoleSections.pods = {render: renderPods, load: loadPods}` — `load` consumed by Task 4's edit to `controls-section.ts`'s `refresh()`.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/console/pods-section.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { PODS_MARKUP, PODS_SCRIPT } from "../../../src/gateway/console/pods-section.js";

describe("pods section", () => {
  it("keeps a two-panel workspace with a list root and a detail root", () => {
    expect(PODS_MARKUP).toContain('id="pods-list"');
    expect(PODS_MARKUP).toContain('id="pod-detail"');
  });

  it("carries the data-screen-label the nav item's label must match", () => {
    expect(PODS_MARKUP).toContain('data-screen-label="Pods"');
  });

  it("fetches pods from the real API, not a static demo dataset", () => {
    expect(PODS_SCRIPT).toContain('request("/api/v1/zentra/pods")');
    expect(PODS_SCRIPT).not.toContain("DEMO_DATA");
  });

  it("registers a load hook and does not self-invoke at script load, unlike the static preview sections", () => {
    expect(PODS_SCRIPT).toContain("window.__consoleSections.pods={render:renderPods,load:loadPods}");
    expect(PODS_SCRIPT.trim().endsWith("load:loadPods};")).toBe(true);
  });

  it("never builds DOM with innerHTML", () => {
    expect(PODS_SCRIPT).not.toContain("innerHTML");
  });

  it("selects a pod on click and renders its detail from already-fetched data, with no per-pod fetch", () => {
    expect(PODS_SCRIPT).toContain('addEventListener("click"');
    expect(PODS_SCRIPT).not.toMatch(/request\([^)]*pods\/[^)]*podId/);
  });

  it("shows an honest empty state distinguishing no-pods from load-failure", () => {
    expect(PODS_SCRIPT).toContain("No pods yet.");
    expect(PODS_SCRIPT).toContain("Pods unavailable.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/gateway/console/pods-section.test.ts`
Expected: FAIL with a module resolution error (`Cannot find module '../../../src/gateway/console/pods-section.js'`)

- [ ] **Step 3: Create `src/gateway/console/pods-section.ts`**

```ts
export const PODS_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Pods"><section class="workspace" aria-label="Pods"><section class="panel"><h2>Pods</h2><div id="pods-list" class="stack"></div></section><section class="panel"><h2>Pod detail</h2><div id="pod-detail"></div></section></section></div>`;

export const PODS_SCRIPT = String.raw`let podsState=[];let podsSelectedId=null;let podsLoadFailed=false;
const loadPods=async()=>{
  try{const result=await request("/api/v1/zentra/pods");podsState=list(result,["pods"]);podsLoadFailed=false}
  catch(error){podsState=[];podsLoadFailed=true}
  if(podsSelectedId&&!podsState.some(pod=>pod.podId===podsSelectedId))podsSelectedId=null;
  renderPods();
};
const podsSelect=(podId)=>{podsSelectedId=podId;renderPods()};
const renderPodsList=()=>{
  const host=$("pods-list");host.replaceChildren();
  if(!podsState.length){const empty=document.createElement("p");empty.className="empty";setText(empty,podsLoadFailed?"Pods unavailable.":"No pods yet.");host.append(empty);return}
  for(const pod of podsState){
    const button=document.createElement("button");button.type="button";button.className="run-card";
    button.dataset.selected=String(pod.podId===podsSelectedId);
    const title=document.createElement("strong");setText(title,pod.podId);
    const meta=document.createElement("span");setText(meta,"Revision "+pod.revision);
    button.append(title,meta,badge(label(pod.lifecycle)));
    button.addEventListener("click",()=>podsSelect(pod.podId));
    host.append(button);
  }
};
const renderPodDetail=()=>{
  const host=$("pod-detail");host.replaceChildren();
  const pod=podsState.find(candidate=>candidate.podId===podsSelectedId);
  if(!pod){const empty=document.createElement("p");empty.className="empty";setText(empty,"Select a pod to inspect its charter, assignments, and evidence.");host.append(empty);return}
  const heading=document.createElement("h3");setText(heading,pod.podId);
  const facts=document.createElement("dl");facts.className="facts";
  const assignmentCount=Object.keys(pod.assignments||{}).length;
  const checkpointCount=Object.keys(pod.checkpoints||{}).length;
  facts.append(
    field("Pod",pod.podId),
    field("Project",pod.projectId),
    field("Lifecycle",label(pod.lifecycle)),
    field("Revision",String(pod.revision)),
    field("Outcome",pod.charter&&pod.charter.outcome||"Unknown"),
    field("Assignments",String(assignmentCount)),
    field("Checkpoints",String(checkpointCount)),
    field("Attention",pod.attention?pod.attention.reason:"None"),
    field("Terminal outcome",pod.terminal?label(pod.terminal.outcome):"Not terminal"),
  );
  host.append(heading,facts);
  appendJson(host,"Charter",pod.charter);
  appendJson(host,"Assignments",pod.assignments);
  appendJson(host,"Checkpoints",pod.checkpoints);
  appendJson(host,"Evidence",pod.evidence);
  appendJson(host,"Attention",pod.attention);
  appendJson(host,"Reconciliation",pod.reconciliation);
};
const renderPods=()=>{renderPodsList();renderPodDetail()};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.pods={render:renderPods,load:loadPods};`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/gateway/console/pods-section.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Type-check**

Run: `pnpm check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/gateway/console/pods-section.ts tests/gateway/console/pods-section.test.ts
git commit -m "Add pods-section.ts: list + click-to-select detail over real pod data"
```

---

### Task 4: Wire Pods into the shell, script bundle, and refresh cycle

**Files:**
- Modify: `src/gateway/console/shell.ts` (imports, `NAV_GROUPS`, section wrapper list)
- Modify: `src/gateway/console/console-ui.ts` (import, `CONSOLE_SCRIPT` concatenation)
- Modify: `src/gateway/console/controls-section.ts:76` (`refresh()`)
- Modify: `tests/gateway/console/shell.test.ts`
- Modify: `tests/gateway/console/console-ui.test.ts`

**Interfaces:**
- Consumes: `PODS_MARKUP`, `PODS_SCRIPT` from Task 3; `window.__consoleSections.pods?.load?.()` (registered by Task 3's `PODS_SCRIPT`).
- Produces: the Pods nav item becomes clickable and shows the wired section; `controls-section.ts`'s `refresh()` now also triggers a pods load on every session-ready and every subsequent refresh cycle.

- [ ] **Step 1: Write the failing tests**

In `tests/gateway/console/shell.test.ts`, replace the existing `"marks only Controls, Overview, and Trail as enabled nav targets"` test (lines 22-29) with:

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

In `tests/gateway/console/console-ui.test.ts`, add `expect(html).toContain('id="pods-list"');` to the existing `"includes every section's markup and preserves controls' DOM ids"` test (after the `id="overview-root"` line), and add a new test after the `"includes the six newly-wired sections' data-screen-label markers"` test:

```ts
  it("includes the Pods section's data-screen-label marker", () => {
    const html = consoleHtml();
    expect(html).toContain('data-screen-label="Pods"');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/gateway/console/shell.test.ts tests/gateway/console/console-ui.test.ts`
Expected: FAIL — the shell test fails because `pods` is still `enabled: false`; the console-ui tests fail because `pods-section.ts` isn't imported/concatenated yet.

- [ ] **Step 3: Wire `shell.ts`**

In `src/gateway/console/shell.ts`, add this import after the existing `import { POLICIES_MARKUP } from "./policies-section.js";` line:

```ts
import { PODS_MARKUP } from "./pods-section.js";
```

Change the `pods` entry in `NAV_GROUPS` (currently `{ id: "pods", label: "Pods", icon: "⬢", enabled: false },`) to:

```ts
    { id: "pods", label: "Pods", icon: "⬢", enabled: true },
```

Add the section wrapper. In the `SHELL_MARKUP` template, immediately before the existing `<section class="section" data-section-id="policies">${POLICIES_MARKUP}</section>` line, insert:

```ts
    <section class="section" data-section-id="pods">${PODS_MARKUP}</section>
```

- [ ] **Step 4: Wire `console-ui.ts`**

In `src/gateway/console/console-ui.ts`, add this import after the existing `import { POLICIES_SCRIPT } from "./policies-section.js";` line:

```ts
import { PODS_SCRIPT } from "./pods-section.js";
```

Change the `CONSOLE_SCRIPT` line from:

```ts
const CONSOLE_SCRIPT = `(()=>{"use strict";${CONTROLS_SCRIPT}\n${TRAIL_SCRIPT}\n${OVERVIEW_SCRIPT}\n${WARNINGS_SCRIPT}\n${SECURITY_SCRIPT}\n${COST_SCRIPT}\n${COMPARE_SCRIPT}\n${IMPORTS_SCRIPT}\n${POLICIES_SCRIPT}\n${SHELL_SCRIPT}})();`;
```

to:

```ts
const CONSOLE_SCRIPT = `(()=>{"use strict";${CONTROLS_SCRIPT}\n${TRAIL_SCRIPT}\n${OVERVIEW_SCRIPT}\n${WARNINGS_SCRIPT}\n${SECURITY_SCRIPT}\n${COST_SCRIPT}\n${COMPARE_SCRIPT}\n${IMPORTS_SCRIPT}\n${POLICIES_SCRIPT}\n${PODS_SCRIPT}\n${SHELL_SCRIPT}})();`;
```

- [ ] **Step 5: Hook `loadPods` into the refresh cycle**

In `src/gateway/console/controls-section.ts`, find the `refresh` function (currently a single line, ends with `...window.__consoleSections.overview?.render?.();window.__consoleSections.shell?.render?.();window.__consoleSections.trail?.load?.()};`). Change the ending from:

```
window.__consoleSections.overview?.render?.();window.__consoleSections.shell?.render?.();window.__consoleSections.trail?.load?.()};
```

to:

```
window.__consoleSections.overview?.render?.();window.__consoleSections.shell?.render?.();window.__consoleSections.trail?.load?.();window.__consoleSections.pods?.load?.()};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/gateway/console/shell.test.ts tests/gateway/console/console-ui.test.ts tests/gateway/console/controls-section.test.ts tests/gateway/console/pods-section.test.ts`
Expected: PASS (all tests in all four files — `controls-section.test.ts` should be unaffected, included here to confirm the `refresh()` edit didn't break anything already asserted there)

- [ ] **Step 7: Type-check and run the full test suite**

Run: `pnpm check`
Expected: no errors

Run: `pnpm exec vitest run tests/gateway`
Expected: PASS (every gateway test, confirming nothing else in the composed console broke)

- [ ] **Step 8: Commit**

```bash
git add src/gateway/console/shell.ts src/gateway/console/console-ui.ts src/gateway/console/controls-section.ts tests/gateway/console/shell.test.ts tests/gateway/console/console-ui.test.ts
git commit -m "Wire Pods into the console shell, script bundle, and refresh cycle"
```

---

### Task 5: Real-browser e2e coverage

**Files:**
- Modify: `tests/ui/console-shell.e2e.test.ts`

**Interfaces:**
- Consumes: `consoleShellWorkflow(root)` (existing helper, returns `{workflow, journal}`), `PodRegistry` (`src/pods/pod-registry.ts`), `charter` (`tests/pods/pod-fixtures.ts`), `ChromiumWorkflowDriver` (existing helper with `.click(selector)`, `.waitFor(expression)`, `.evaluate<T>(expression)`).
- Produces: e2e proof that the Pods nav item is genuinely enabled and renders real registered-pod data end-to-end through the real HTTP route.

- [ ] **Step 1: Write the failing test**

In `tests/ui/console-shell.e2e.test.ts`, add this import near the top, alongside the existing `SqliteEventJournal`/`createLocalWorkflowSurface` imports:

```ts
import { PodRegistry } from "../../src/pods/pod-registry.js";
import { charter } from "../pods/pod-fixtures.js";
```

Add a new test inside `describe.skipIf(acceptanceBrowser === null)("console shell, real browser", () => { ... })`, after the `"renders all six static preview sections..."` test (after its closing `}, 60_000);` around line 340):

```ts
  it("enables the Pods nav item and renders a registered pod's detail on click", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-pods-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    new PodRegistry(fixture.journal).register({ charter: charter({ podId: "pod-e2e" }), correlationId: "trace-e2e" });
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.click('[data-nav-id="pods"]');
      await driver.waitFor(`document.querySelector('[data-section-id="pods"]')?.dataset.active === "true"`);
      await driver.waitFor(`document.getElementById("pods-list")?.textContent.includes("pod-e2e")`);
      await driver.click('#pods-list button.run-card');
      await driver.waitFor(`document.getElementById("pod-detail")?.textContent.includes("Implement the pod aggregate.")`);
      const detailText = await driver.evaluate<string>(`document.getElementById("pod-detail")?.textContent || ""`);
      expect(detailText).toContain("pod-e2e");
      expect(detailText).toContain("Registered");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts -t "enables the Pods nav item"`
Expected: either SKIP (if no canonical headless Chromium is available in this environment — check the run output for a skip notice rather than a pass/fail) or FAIL at the first `waitFor` (nav item still disabled / click has no effect) if Chromium is available.

- [ ] **Step 3: No implementation step — Tasks 1-4 already made this pass**

This task is pure verification of the already-implemented behavior; there is no new source change here.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts`
Expected: PASS on every test in the file (or SKIP if this environment has no canonical Chromium — note which happened)

- [ ] **Step 5: Commit**

```bash
git add tests/ui/console-shell.e2e.test.ts
git commit -m "Add e2e coverage for the Pods nav item and pod detail rendering"
```

---

### Task 6: Full verification, merge, push, and issue tracking

**Files:** none (verification, git, and GitHub issue operations only)

**Interfaces:** none — this task consumes the finished state of Tasks 1-5 and produces the shipped, tracked result.

- [ ] **Step 1: Run the full check and test suite**

Run: `pnpm check`
Expected: no errors

Run: `pnpm test`
Expected: PASS (every test in the repository, not just the ones touched by this plan — this is the project's full regression gate)

- [ ] **Step 2: Build and verify the package**

Run: `pnpm build`
Expected: succeeds with no errors

- [ ] **Step 3: Merge the worktree branch into `main`**

(Exact branch name depends on what `superpowers:using-git-worktrees` created at execution start — substitute it below. This mirrors the existing local-merge convention already used for `worktree-agent-rail-console-static-sections` and `worktree-agent-rail-console-phase2-step1`, not a GitHub PR.)

```bash
git -C /Users/talibilat/Documents/Projects/zentra checkout main
git -C /Users/talibilat/Documents/Projects/zentra merge --no-ff <worktree-branch-name>
```

- [ ] **Step 4: Push `main`**

```bash
git -C /Users/talibilat/Documents/Projects/zentra push origin main
```

- [ ] **Step 5: Open the three follow-up issues for Milestones, GitHub broker, and Journal**

These mirror #121's own scope, each narrowed to one section, per the design spec's decision to split rather than build unevenly-scoped work together.

```bash
gh issue create --title "Agent Rail Console Phase 2, Step 4b: Milestones (real endpoint)" --body "$(cat <<'EOF'
Split off #121, which originally scoped Pods, Milestones, GitHub broker, and Journal together. Step 4a (Pods) shipped separately; see docs/superpowers/specs/2026-08-04-agent-rail-console-phase2-pods-design.md for why the four were split.

## Context
`src/milestones/milestone-registry.ts` already has `list(): readonly MilestoneSummary[]` and `inspect(milestoneId): MilestoneRecord | null` - a real backend already exists, just no HTTP route.

## Scope
- Add a read-only `WorkflowSurface.listMilestones()` (and, unlike Pods, likely a matching `getMilestone(id)` - check whether `MilestoneSummary` is a lighter projection than `MilestoneRecord` before assuming the list alone is enough, the way it was for Pods).
- Add matching `GET /api/v1/zentra/milestones` (and possibly `/milestones/:id`) gateway routes.
- Build the Milestones console section, wired end-to-end.
- Enable the `milestones` nav entry in `shell.ts`.

## Non-goals
- Any mutation capability from the console.
- GitHub broker, Journal - tracked in their own follow-up issues.

## Next step
Needs its own brainstorming -> design spec -> implementation plan cycle before implementation starts, per this project's standard workflow.
EOF
)"

gh issue create --title "Agent Rail Console Phase 2, Step 4c: GitHub broker (real endpoint)" --body "$(cat <<'EOF'
Split off #121, which originally scoped Pods, Milestones, GitHub broker, and Journal together. Step 4a (Pods) shipped separately; see docs/superpowers/specs/2026-08-04-agent-rail-console-phase2-pods-design.md for why the four were split.

## Context
Unlike Pods and Milestones, `src/capsule/github-broker.ts`'s `GitHubEffectBroker` has no listing method at all - it only appends `capsule.github_grant_consumed` / `capsule.github_broker_accepted` / `capsule.github_broker_denied` (and push/PR outcome) events to a per-grant journal stream (see `grantStreamId(grantId)`). A "list recent broker activity" view needs a brand-new read projection, scanning `capsule.github_*` events across all grant streams the way `WorkflowSurface`'s private `listRunsProjection()` scans `run.accepted`/`workflow.run_submitted` today.

## Scope
- Design and add a new read projection over the broker's own journal events (likely a new method on `GitHubEffectBroker` itself, or a small new read-only class alongside it - this is a real design decision, not just wiring).
- Add a matching `GET /api/v1/zentra/github-broker` (or similar) gateway route.
- Build the GitHub broker console section, wired end-to-end.
- Enable the `github` nav entry in `shell.ts`.

## Non-goals
- Any mutation capability from the console (no triggering pushes/PRs from the UI).
- Pods, Milestones, Journal - tracked in their own issues.

## Next step
Needs its own brainstorming -> design spec -> implementation plan cycle before implementation starts, per this project's standard workflow.
EOF
)"

gh issue create --title "Agent Rail Console Phase 2, Step 4d: Journal (real endpoint)" --body "$(cat <<'EOF'
Split off #121, which originally scoped Pods, Milestones, GitHub broker, and Journal together. Step 4a (Pods) shipped separately; see docs/superpowers/specs/2026-08-04-agent-rail-console-phase2-pods-design.md for why the four were split.

## Context
Unlike the other three, "Journal" is ambiguous. `src/journal/journal.ts` is the raw event-storage interface (`EventJournal`), not a domain view - there's no "JournalView" the way there's a `PodView` or `MilestoneSummary`. This needs a scoping decision before design can start: does "Journal" mean a raw event browser (audit-log style, distinct from Trail's structured per-run AgentTrail reasoning trace), or journal-maintenance stats matching the CLI's `journal status`/`journal list`/`journal archive` commands (src/cli/main.ts)? Resolve this with whoever files/prioritizes this issue before brainstorming starts.

## Scope
TBD pending the scoping decision above.

## Non-goals
Pods, Milestones, GitHub broker - tracked in their own issues.

## Next step
Needs a scoping decision, then its own brainstorming -> design spec -> implementation plan cycle before implementation starts, per this project's standard workflow.
EOF
)"
```

- [ ] **Step 6: Close #121 with a summary comment**

```bash
gh issue close 121 --comment "$(cat <<'EOF'
Split into four narrower issues after finding the original scope (Pods, Milestones, GitHub broker, Journal) was uneven in backend readiness - see docs/superpowers/specs/2026-08-04-agent-rail-console-phase2-pods-design.md.

Step 4a (Pods) shipped in this issue's place. Milestones, GitHub broker, and Journal continue as their own follow-ups, each needing its own design cycle before implementation:
- Milestones: see the new "Agent Rail Console Phase 2, Step 4b" issue
- GitHub broker: see the new "Agent Rail Console Phase 2, Step 4c" issue
- Journal: see the new "Agent Rail Console Phase 2, Step 4d" issue
EOF
)"
```

- [ ] **Step 7: Update project memory**

Update `project_agent_rail_console_phase1.md` in the memory directory (`/Users/talibilat/.claude/projects/-Users-talibilat-Documents-Projects-zentra/memory/`) to record: #121 closed and split into #4b/#4c/#4d (Pods/Milestones/GitHub broker/Journal, respectively, using the actual new issue numbers `gh issue create` returned in Step 5); Step 4a (Pods) shipped with its own spec/plan; the same "uneven backend readiness forces a split" lesson that already applies to Trail's sub-steps now also applies here — update the memory's `description` and body accordingly, following the existing file's structure.

