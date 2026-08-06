# Agent Rail Console Phase 2 Step 4c (GitHub broker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the GitHub broker nav item in the Agent Rail Console to real data — a new `listGitHubBrokerActivity(journal)` read projection in `github-broker.ts`, a `GET /api/v1/zentra/github-broker` route backed by `WorkflowSurface.listGitHubBrokerActivity()`, and a `github-broker-section.ts` console section with list + click-to-select detail — replacing the disabled "Phase 2" placeholder.

**Architecture:** `listGitHubBrokerActivity(journal)` scans all `github-grant:*` streams for `capsule.github_*` events (mirroring `listRunsProjection()`'s scanning approach) and folds each stream into one `GitHubBrokerActivity` entry keyed by its furthest-along event. This lives as a plain exported function in `github-broker.ts`, not a `GitHubEffectBroker` method, because the broker's constructor needs credentials/policy/lease dependencies a read-only list has no use for. The console section mirrors Pods' pure-client-side-selection pattern (the list already contains full detail per entry, no second fetch needed).

**Tech Stack:** TypeScript (Node, ESM), Vitest, the existing framework-free console template-literal pattern, Playwright-driven Chromium for e2e.

## Global Constraints

- No mutation capability from the console — read-only, per the spec's non-goals.
- No `GET /github-broker/:grantId` detail route — the list response already contains everything meaningful per entry (small payloads, unlike Milestones), per the spec's YAGNI reasoning.
- DOM must be built via `document.createElement`/`setText`, never `innerHTML`.
- `data-screen-label` on the section's markup must exactly match `"GitHub broker"` (the nav item's `label` in `shell.ts`).
- The new read projection must NOT construct a `GitHubEffectBroker` instance, and must NOT add a method to that class — it's a standalone function taking only `journal: EventJournal`.
- Codebase-map regeneration (`pnpm docs:codebase-map`) must be the **strictly last task** in this plan, after every other file-touching task including the e2e test task (Task 6) — not merely "early." This is a sharpened lesson from Step 4b (Milestones), where placing it before the e2e task left the map stale a second time because the e2e task edits a mapped file (`tests/ui/console-shell.e2e.test.ts`).
- Test-driven development: write the failing test before the implementation, for every task.

---

### Task 1: `listGitHubBrokerActivity()` — projection function + `WorkflowSurface` method

**Files:**
- Modify: `src/capsule/github-broker.ts` (imports at top; new exported function + interface at end of file)
- Modify: `src/surfaces/workflow-surface.ts:41` (new import), `src/surfaces/workflow-surface.ts:348` (insert after `getMilestone()`, before `private listRunsProjection()`)
- Test: `tests/capsule/github-broker-activity.test.ts` (new file), `tests/surfaces/workflow-surface.test.ts`

**Interfaces:**
- Consumes: `EventJournal`, `iterateAllEvents`, `assertBoundedProjectionEntries` (`src/journal/journal.js`, already imported in `github-broker.ts` for `readStreamEvents`/`EventJournal`, need to add the other two to that same import line).
- Produces: `export interface GitHubBrokerActivity {...}` and `export function listGitHubBrokerActivity(journal: EventJournal): readonly GitHubBrokerActivity[]` from `src/capsule/github-broker.ts` — consumed by Task 2's `WorkflowSurface` method and Task 3's console section. `WorkflowSurface.listGitHubBrokerActivity(): readonly GitHubBrokerActivity[]` — consumed by Task 2's gateway route.

- [ ] **Step 1: Write the failing tests**

Create `tests/capsule/github-broker-activity.test.ts`:

```ts
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { listGitHubBrokerActivity } from "../../src/capsule/github-broker.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const pushAction = {
  operation: "push" as const, repository: "talibilat/zentra", targetRef: "refs/heads/zentra/pr-grant",
  sourceCommit: "1".repeat(40), expectedOldOid: "0".repeat(40), force: false as const,
};
const prAction = {
  operation: "create_pull_request" as const, repository: "talibilat/zentra", pushGrantId: "push-grant", headRef: "zentra/pr-grant",
  headCommit: "1".repeat(40), base: "main",
  titleSha256: createHash("sha256").update("Title").digest("hex"),
  bodySha256: createHash("sha256").update("Body").digest("hex"), draft: false,
};

function appendDenied(journal: SqliteEventJournal, grantId: string): void {
  const actionDigest = createHash("sha256").update(JSON.stringify(pushAction), "utf8").digest("hex");
  journal.append(`github-grant:${grantId}`, 0, [{
    streamId: `github-grant:${grantId}`, type: "capsule.github_broker_denied",
    payload: { requestId: grantId, grantId, policyDigest: "a".repeat(64), actionDigest, ...pushAction },
    causationId: null, correlationId: grantId,
  }]);
}

function appendAccepted(journal: SqliteEventJournal, grantId: string, action: typeof pushAction | typeof prAction): void {
  const actionDigest = createHash("sha256").update(JSON.stringify(action), "utf8").digest("hex");
  const common = { requestId: grantId, grantId, actionDigest };
  journal.append(`github-grant:${grantId}`, 0, [{
    streamId: `github-grant:${grantId}`, type: "capsule.github_grant_consumed",
    payload: { ...common, audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", policyDigest: "a".repeat(64) },
    causationId: null, correlationId: grantId,
  }, {
    streamId: `github-grant:${grantId}`, type: "capsule.github_broker_accepted",
    payload: { ...common, policyDigest: "a".repeat(64), ...action }, causationId: null, correlationId: grantId,
  }]);
}

function appendObservedUncertain(journal: SqliteEventJournal, grantId: string, action: typeof pushAction): void {
  appendAccepted(journal, grantId, action);
  const actionDigest = createHash("sha256").update(JSON.stringify(action), "utf8").digest("hex");
  journal.append(`github-grant:${grantId}`, 2, [{
    streamId: `github-grant:${grantId}`, type: "capsule.github_broker_observed",
    payload: { requestId: grantId, grantId, actionDigest, operation: "push", repository: action.repository, target: action.targetRef, outcome: "uncertain" },
    causationId: null, correlationId: grantId,
  }]);
}

function appendReconciledCompleted(journal: SqliteEventJournal, grantId: string, action: typeof pushAction): void {
  appendObservedUncertain(journal, grantId, action);
  const actionDigest = createHash("sha256").update(JSON.stringify(action), "utf8").digest("hex");
  journal.append(`github-grant:${grantId}`, 3, [{
    streamId: `github-grant:${grantId}`, type: "capsule.github_broker_reconciled",
    payload: { requestId: grantId, grantId, actionDigest, ...action, attempt: 1, outcome: "completed", observedRemoteOid: action.sourceCommit },
    causationId: null, correlationId: grantId,
  }]);
}

describe("listGitHubBrokerActivity", () => {
  it("returns an empty list when no broker activity exists", () => {
    const journal = new SqliteEventJournal(":memory:");
    expect(listGitHubBrokerActivity(journal)).toEqual([]);
  });

  it("lists a denied grant", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendDenied(journal, "denied-grant");
    const activity = listGitHubBrokerActivity(journal);
    expect(activity).toEqual([{
      grantId: "denied-grant", requestId: "denied-grant", operation: "push", repository: "talibilat/zentra",
      status: "denied", detail: expect.objectContaining({ targetRef: pushAction.targetRef }),
    }]);
  });

  it("lists an accepted-but-not-yet-observed grant", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendAccepted(journal, "accepted-grant", pushAction);
    const activity = listGitHubBrokerActivity(journal);
    expect(activity).toEqual([expect.objectContaining({ grantId: "accepted-grant", status: "accepted" })]);
  });

  it("lists an observed-uncertain grant", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendObservedUncertain(journal, "observed-grant", pushAction);
    const activity = listGitHubBrokerActivity(journal);
    expect(activity).toEqual([expect.objectContaining({ grantId: "observed-grant", status: "observed_uncertain" })]);
  });

  it("lists a fully reconciled completed push", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendReconciledCompleted(journal, "push-grant", pushAction);
    const activity = listGitHubBrokerActivity(journal);
    expect(activity).toEqual([expect.objectContaining({
      grantId: "push-grant", operation: "push", repository: "talibilat/zentra", status: "completed",
      detail: expect.objectContaining({ observedRemoteOid: pushAction.sourceCommit }),
    })]);
  });

  it("lists a fully reconciled completed pull request", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendAccepted(journal, "pr-grant", prAction);
    const actionDigest = createHash("sha256").update(JSON.stringify(prAction), "utf8").digest("hex");
    journal.append("github-grant:pr-grant", 2, [{
      streamId: "github-grant:pr-grant", type: "capsule.github_broker_reconciled",
      payload: { requestId: "pr-grant", grantId: "pr-grant", actionDigest, ...prAction, attempt: 1, outcome: "completed", observedNumber: 42 },
      causationId: null, correlationId: "pr-grant",
    }]);
    const activity = listGitHubBrokerActivity(journal);
    expect(activity).toEqual([expect.objectContaining({
      grantId: "pr-grant", operation: "create_pull_request", repository: "talibilat/zentra", status: "completed",
      detail: expect.objectContaining({ observedNumber: 42 }),
    })]);
  });

  it("lists a reconciled-failed grant", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendAccepted(journal, "failed-grant", pushAction);
    const actionDigest = createHash("sha256").update(JSON.stringify(pushAction), "utf8").digest("hex");
    journal.append("github-grant:failed-grant", 2, [{
      streamId: "github-grant:failed-grant", type: "capsule.github_broker_reconciled",
      payload: { requestId: "failed-grant", grantId: "failed-grant", actionDigest, ...pushAction, attempt: 1, outcome: "failed", observedRemoteOid: null },
      causationId: null, correlationId: "failed-grant",
    }]);
    const activity = listGitHubBrokerActivity(journal);
    expect(activity).toEqual([expect.objectContaining({ grantId: "failed-grant", status: "failed" })]);
  });

  it("lists multiple independent grant streams together", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendDenied(journal, "grant-a");
    appendAccepted(journal, "grant-b", pushAction);
    const activity = listGitHubBrokerActivity(journal);
    expect(activity.map((entry) => entry.grantId)).toEqual(["grant-a", "grant-b"]);
  });
});
```

Add to `tests/surfaces/workflow-surface.test.ts`, inside the existing `describe("WorkflowSurface", () => { ... })` block, right after the `getMilestone` tests added for Step 4b:

```ts
  it("lists github broker activity via listGitHubBrokerActivity", () => {
    const directory = temporaryDirectory();
    const journal = new SqliteEventJournal(path.join(directory, "workflow.sqlite"));
    const actionDigest = "a".repeat(64);
    journal.append("github-grant:grant-1", 0, [{
      streamId: "github-grant:grant-1", type: "capsule.github_broker_denied",
      payload: {
        requestId: "grant-1", grantId: "grant-1", policyDigest: "a".repeat(64), actionDigest,
        operation: "push", repository: "talibilat/zentra", targetRef: "refs/heads/zentra/grant-1",
        sourceCommit: "1".repeat(40), expectedOldOid: "0".repeat(40), force: false,
      },
      causationId: null, correlationId: "grant-1",
    }]);

    const activity = surfaceFor(journal).listGitHubBrokerActivity();

    expect(activity).toEqual([expect.objectContaining({ grantId: "grant-1", status: "denied", operation: "push" })]);
    journal.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/capsule/github-broker-activity.test.ts tests/surfaces/workflow-surface.test.ts -t "github"`
Expected: FAIL — `tests/capsule/github-broker-activity.test.ts` fails with `Cannot find module`-style errors (the export doesn't exist yet); the `workflow-surface.test.ts` case fails with `surfaceFor(...).listGitHubBrokerActivity is not a function`.

- [ ] **Step 3: Add `iterateAllEvents`/`assertBoundedProjectionEntries` to the existing journal import in `github-broker.ts`**

In `src/capsule/github-broker.ts`, change:

```ts
import { readStreamEvents, type EventJournal } from "../journal/journal.js";
```

to:

```ts
import { assertBoundedProjectionEntries, iterateAllEvents, readStreamEvents, type EventJournal } from "../journal/journal.js";
```

- [ ] **Step 4: Add `GitHubBrokerActivity` and `listGitHubBrokerActivity` to `github-broker.ts`**

Append to the end of `src/capsule/github-broker.ts` (after the existing `withRepositoryLock` function):

```ts

export interface GitHubBrokerActivity {
  readonly grantId: string;
  readonly requestId: string;
  readonly operation: "push" | "create_pull_request";
  readonly repository: string;
  readonly status: "denied" | "accepted" | "observed_denied" | "observed_uncertain" | "completed" | "failed" | "uncertain";
  readonly detail: Readonly<Record<string, unknown>>;
}

export function listGitHubBrokerActivity(journal: EventJournal): readonly GitHubBrokerActivity[] {
  const streams = new Map<string, { readonly grantId: string; readonly events: { readonly type: string; readonly payload: Record<string, unknown> }[] }>();
  for (const event of iterateAllEvents(journal)) {
    if (!event.streamId.startsWith("github-grant:") || !event.type.startsWith("capsule.github_")) continue;
    const grantId = event.streamId.slice("github-grant:".length);
    let stream = streams.get(grantId);
    if (stream === undefined) {
      stream = { grantId, events: [] };
      streams.set(grantId, stream);
      assertBoundedProjectionEntries(streams.size, "github broker activity list");
    }
    stream.events.push({ type: event.type, payload: event.payload as Record<string, unknown> });
  }
  const activity: GitHubBrokerActivity[] = [];
  for (const stream of streams.values()) {
    const denied = stream.events.find((event) => event.type === "capsule.github_broker_denied");
    const accepted = stream.events.find((event) => event.type === "capsule.github_broker_accepted");
    const observed = stream.events.find((event) => event.type === "capsule.github_broker_observed");
    const reconciled = stream.events.find((event) => event.type === "capsule.github_broker_reconciled");
    const action = accepted ?? denied;
    if (action === undefined) continue;
    const operation = action.payload.operation as "push" | "create_pull_request";
    const repository = action.payload.repository as string;
    const requestId = action.payload.requestId as string;
    if (reconciled !== undefined) {
      activity.push({
        grantId: stream.grantId, requestId, operation, repository,
        status: reconciled.payload.outcome as "completed" | "failed" | "uncertain",
        detail: { ...action.payload, ...reconciled.payload },
      });
    } else if (observed !== undefined) {
      activity.push({
        grantId: stream.grantId, requestId, operation, repository,
        status: observed.payload.outcome === "denied" ? "observed_denied" : "observed_uncertain",
        detail: { ...action.payload, ...observed.payload },
      });
    } else if (accepted !== undefined) {
      activity.push({ grantId: stream.grantId, requestId, operation, repository, status: "accepted", detail: action.payload });
    } else {
      activity.push({ grantId: stream.grantId, requestId, operation, repository, status: "denied", detail: action.payload });
    }
  }
  return activity.sort((a, b) => a.grantId.localeCompare(b.grantId));
}
```

- [ ] **Step 5: Add the `WorkflowSurface` import and method**

In `src/surfaces/workflow-surface.ts`, add this line to the import block, immediately after the existing `import { assertBoundedProjectionEntries, ... } from "../journal/journal.js";`-style imports — specifically, add it alphabetically near the top with the other domain imports (after the `capsule` prefix would sort, i.e. before `journal`):

```ts
import { listGitHubBrokerActivity, type GitHubBrokerActivity } from "../capsule/github-broker.js";
```

Insert immediately after the closing `}` of `getMilestone()` (currently lines 346-348), before the blank line and `private listRunsProjection()`:

```ts
  listGitHubBrokerActivity(): readonly GitHubBrokerActivity[] {
    return this.guard(() => listGitHubBrokerActivity(this.journal));
  }

```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/capsule/github-broker-activity.test.ts tests/surfaces/workflow-surface.test.ts`
Expected: PASS (all tests in both files)

- [ ] **Step 7: Type-check**

Run: `pnpm check`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/capsule/github-broker.ts src/surfaces/workflow-surface.ts tests/capsule/github-broker-activity.test.ts tests/surfaces/workflow-surface.test.ts
git commit -m "Add listGitHubBrokerActivity() read projection and WorkflowSurface method"
```

---

### Task 2: Gateway route `GET /api/v1/zentra/github-broker`

**Files:**
- Modify: `src/gateway/loopback-gateway.ts:398` (insert after the `milestones/:milestoneId` GET branch)
- Test: `tests/gateway/loopback-gateway.test.ts`

**Interfaces:**
- Consumes: `WorkflowSurface.listGitHubBrokerActivity()` from Task 1, via the existing generic `invoke()` mechanism.
- Produces: `GET /api/v1/zentra/github-broker` → 200 `GitHubBrokerActivity[]` (authenticated) / 401 (no bearer token) — consumed by Task 3's `github-broker-section.ts`.

- [ ] **Step 1: Write the failing test**

In `tests/gateway/loopback-gateway.test.ts`, add to the `workflow()` fixture function, immediately after the existing `listMilestones`/`getMilestone` lines:

```ts
    listGitHubBrokerActivity: vi.fn(() => [{ grantId: "grant-1", requestId: "grant-1", operation: "push", repository: "talibilat/zentra", status: "completed", detail: {} }]),
```

Add a new test inside `describe("LoopbackGateway", () => { ... })`, immediately after the `"exposes milestones as read-only, bearer-authenticated list and detail routes"` test:

```ts
  it("exposes github broker activity as a read-only, bearer-authenticated route", async () => {
    const surface = workflow();
    const gateway = new LoopbackGateway({ workflow: surface });
    const session = await gateway.start(); gateway.setReadiness("ready");
    try {
      expect((await fetch(`${session.origin}/api/v1/zentra/github-broker`)).status).toBe(401);
      const auth = await establish(session);
      expect(await apiJson(session, auth, "/github-broker")).toEqual([
        { grantId: "grant-1", requestId: "grant-1", operation: "push", repository: "talibilat/zentra", status: "completed", detail: {} },
      ]);
      expect(surface.listGitHubBrokerActivity).toHaveBeenCalledTimes(1);
      surface.listGitHubBrokerActivity.mockReturnValueOnce([]);
      expect(await apiJson(session, auth, "/github-broker")).toEqual([]);
    } finally { await gateway.close(); }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/gateway/loopback-gateway.test.ts -t "exposes github broker activity"`
Expected: FAIL with a 404 response (or a TypeScript error on `listGitHubBrokerActivity` not existing on the mocked surface type).

- [ ] **Step 3: Add the route**

In `src/gateway/loopback-gateway.ts`, insert immediately after the closing `}` of the existing `milestones/:milestoneId` GET branch (currently lines 395-398), before the `runs` POST branch:

```ts
      if (request.method === "GET" && segments.length === 1 && segments[0] === "github-broker" && url.search === "") {
        return this.jsonResult(response, await this.invoke("listGitHubBrokerActivity"));
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
git commit -m "Expose GET /api/v1/zentra/github-broker on the loopback gateway"
```

---

### Task 3: `github-broker-section.ts` console section

**Files:**
- Create: `src/gateway/console/github-broker-section.ts`
- Test: `tests/gateway/console/github-broker-section.test.ts`

**Interfaces:**
- Consumes (at runtime, in the concatenated browser script, from `controls-section.ts`'s shared scope): `$`, `setText`, `request`, `list`, `label`, `badge`, `field`, `appendJson` (same shared helpers Pods/Milestones already use).
- Produces: `GITHUB_BROKER_MARKUP: string`, `GITHUB_BROKER_SCRIPT: string` (exported) — consumed by Task 4's `shell.ts`/`console-ui.ts`. At runtime, registers `window.__consoleSections.github = {render: renderGitHubBroker, load: loadGitHubBrokerActivity}` — `load` consumed by Task 4's edit to `controls-section.ts`'s `refresh()`.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/console/github-broker-section.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { GITHUB_BROKER_MARKUP, GITHUB_BROKER_SCRIPT } from "../../../src/gateway/console/github-broker-section.js";

describe("github broker section", () => {
  it("keeps a two-panel workspace with a list root and a detail root", () => {
    expect(GITHUB_BROKER_MARKUP).toContain('id="github-broker-list"');
    expect(GITHUB_BROKER_MARKUP).toContain('id="github-broker-detail"');
  });

  it("reuses the shared two-column workspace variant", () => {
    expect(GITHUB_BROKER_MARKUP).toContain('data-columns="2"');
  });

  it("carries the data-screen-label the nav item's label must match", () => {
    expect(GITHUB_BROKER_MARKUP).toContain('data-screen-label="GitHub broker"');
  });

  it("fetches activity from the real API, not a static demo dataset", () => {
    expect(GITHUB_BROKER_SCRIPT).toContain('request("/api/v1/zentra/github-broker")');
    expect(GITHUB_BROKER_SCRIPT).not.toContain("DEMO_DATA");
  });

  it("registers a load hook and does not self-invoke at script load", () => {
    expect(GITHUB_BROKER_SCRIPT).toContain("window.__consoleSections.github={render:renderGitHubBroker,load:loadGitHubBrokerActivity}");
    expect(GITHUB_BROKER_SCRIPT.trim().endsWith("load:loadGitHubBrokerActivity};")).toBe(true);
  });

  it("never builds DOM with innerHTML", () => {
    expect(GITHUB_BROKER_SCRIPT).not.toContain("innerHTML");
  });

  it("selects an activity entry on click without a second network fetch", () => {
    expect(GITHUB_BROKER_SCRIPT).toContain('addEventListener("click"');
    const requestCalls = GITHUB_BROKER_SCRIPT.match(/request\(/g) ?? [];
    expect(requestCalls.length).toBe(1);
  });

  it("shows an honest empty state", () => {
    expect(GITHUB_BROKER_SCRIPT).toContain("No GitHub broker activity yet.");
    expect(GITHUB_BROKER_SCRIPT).toContain("GitHub broker activity unavailable.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/gateway/console/github-broker-section.test.ts`
Expected: FAIL with a module resolution error (`Cannot find module '../../../src/gateway/console/github-broker-section.js'`)

- [ ] **Step 3: Create `src/gateway/console/github-broker-section.ts`**

```ts
export const GITHUB_BROKER_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="GitHub broker"><section class="workspace" data-columns="2" aria-label="GitHub broker"><section class="panel"><h2>GitHub broker</h2><div id="github-broker-list" class="stack"></div></section><section class="panel"><h2>Activity detail</h2><div id="github-broker-detail"></div></section></section></div>`;

export const GITHUB_BROKER_SCRIPT = String.raw`let githubBrokerState=[];let githubBrokerLoadFailed=false;let githubBrokerSelectedId=null;
const loadGitHubBrokerActivity=async()=>{
  try{const result=await request("/api/v1/zentra/github-broker");githubBrokerState=list(result,["activity"]);githubBrokerLoadFailed=false}
  catch{githubBrokerState=[];githubBrokerLoadFailed=true}
  if(githubBrokerSelectedId&&!githubBrokerState.some(entry=>entry.grantId===githubBrokerSelectedId))githubBrokerSelectedId=null;
  renderGitHubBroker();
};
const githubBrokerSelect=(grantId)=>{githubBrokerSelectedId=grantId;renderGitHubBroker()};
const githubBrokerOperationLabel=(operation)=>operation==="create_pull_request"?"Create pull request":"Push";
const renderGitHubBrokerList=()=>{
  const host=$("github-broker-list");host.replaceChildren();
  if(!githubBrokerState.length){const empty=document.createElement("p");empty.className="empty";setText(empty,githubBrokerLoadFailed?"GitHub broker activity unavailable.":"No GitHub broker activity yet.");host.append(empty);return}
  for(const entry of githubBrokerState){
    const button=document.createElement("button");button.type="button";button.className="run-card";
    button.dataset.selected=String(entry.grantId===githubBrokerSelectedId);
    const title=document.createElement("strong");setText(title,entry.repository);
    const meta=document.createElement("span");setText(meta,githubBrokerOperationLabel(entry.operation)+" · "+entry.grantId);
    button.append(title,meta,badge(label(entry.status)));
    button.addEventListener("click",()=>githubBrokerSelect(entry.grantId));
    host.append(button);
  }
};
const renderGitHubBrokerDetail=()=>{
  const host=$("github-broker-detail");host.replaceChildren();
  const entry=githubBrokerState.find(candidate=>candidate.grantId===githubBrokerSelectedId);
  if(!entry){const empty=document.createElement("p");empty.className="empty";setText(empty,"Select an activity entry to inspect its detail.");host.append(empty);return}
  const heading=document.createElement("h3");setText(heading,entry.repository);
  const facts=document.createElement("dl");facts.className="facts";
  facts.append(
    field("Grant ID",entry.grantId),
    field("Request ID",entry.requestId),
    field("Operation",githubBrokerOperationLabel(entry.operation)),
    field("Repository",entry.repository),
    field("Status",label(entry.status)),
  );
  host.append(heading,facts);
  appendJson(host,"Detail",entry.detail);
};
const renderGitHubBroker=()=>{renderGitHubBrokerList();renderGitHubBrokerDetail()};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.github={render:renderGitHubBroker,load:loadGitHubBrokerActivity};`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/gateway/console/github-broker-section.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Type-check**

Run: `pnpm check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/gateway/console/github-broker-section.ts tests/gateway/console/github-broker-section.test.ts
git commit -m "Add github-broker-section.ts: list + click-to-select detail over real broker activity"
```

---

### Task 4: Wire GitHub broker into the shell, script bundle, and refresh cycle

**Files:**
- Modify: `src/gateway/console/shell.ts` (imports, `NAV_GROUPS`, section wrapper list)
- Modify: `src/gateway/console/console-ui.ts` (import, `CONSOLE_SCRIPT` concatenation)
- Modify: `src/gateway/console/controls-section.ts:76` (`refresh()`)
- Modify: `tests/gateway/console/shell.test.ts`
- Modify: `tests/gateway/console/console-ui.test.ts`
- Modify: `tests/gateway/console/controls-section.test.ts`

**Interfaces:**
- Consumes: `GITHUB_BROKER_MARKUP`, `GITHUB_BROKER_SCRIPT` from Task 3; `window.__consoleSections.github?.load?.()` (registered by Task 3's `GITHUB_BROKER_SCRIPT`).
- Produces: the GitHub broker nav item becomes clickable and shows the wired section; `controls-section.ts`'s `refresh()` now also triggers a github-broker-activity load on every session-ready and every subsequent refresh cycle.

- [ ] **Step 1: Write the failing tests**

In `tests/gateway/console/shell.test.ts`, replace the existing test (currently titled `"marks Controls, Overview, Trail, Pods, and Milestones as enabled nav targets"`, lines 22-29):

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

with:

```ts
  it("marks Controls, Overview, Trail, Pods, Milestones, and GitHub broker as enabled nav targets", () => {
    for (const enabled of ["data-nav-id=\"controls\"", "data-nav-id=\"overview\"", "data-nav-id=\"trail\"", "data-nav-id=\"pods\"", "data-nav-id=\"milestones\"", "data-nav-id=\"github\""]) {
      expect(SHELL_MARKUP).toContain(enabled);
    }
    expect(SHELL_MARKUP).not.toContain('data-nav-id="pods" disabled');
    expect(SHELL_MARKUP).not.toContain('data-nav-id="milestones" disabled');
    expect(SHELL_MARKUP).not.toContain('data-nav-id="github" disabled');
    expect(SHELL_MARKUP).toContain('data-nav-id="journal" disabled');
  });
```

In `tests/gateway/console/console-ui.test.ts`, add `expect(html).toContain('id="github-broker-list"');` to the existing `"includes every section's markup and preserves controls' DOM ids"` test (after the `id="milestones-list"` line), and add two new tests after the existing `"includes the Milestones section's data-screen-label marker"`-style tests:

```ts
  it("includes the GitHub broker section's data-screen-label marker", () => {
    const html = consoleHtml();
    expect(html).toContain('data-screen-label="GitHub broker"');
  });

  it("concatenates GITHUB_BROKER_SCRIPT into the composed document", () => {
    const html = consoleHtml();
    expect(html).toContain("window.__consoleSections.github={render:renderGitHubBroker,load:loadGitHubBrokerActivity}");
  });
```

In `tests/gateway/console/controls-section.test.ts`, add a new test after the existing `"reloads the Milestones section on refresh"` test:

```ts
  it("reloads the GitHub broker section on refresh", () => {
    expect(CONTROLS_SCRIPT).toContain("window.__consoleSections.github?.load?.()");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/gateway/console/shell.test.ts tests/gateway/console/console-ui.test.ts tests/gateway/console/controls-section.test.ts`
Expected: FAIL — the shell test fails because `github` is still `enabled: false`; the console-ui tests fail because `github-broker-section.ts` isn't imported/concatenated yet; the controls-section test fails because the hook doesn't exist yet.

- [ ] **Step 3: Wire `shell.ts`**

In `src/gateway/console/shell.ts`, add this import after the existing `import { MILESTONES_MARKUP } from "./milestones-section.js";` line:

```ts
import { GITHUB_BROKER_MARKUP } from "./github-broker-section.js";
```

Change the `github` entry in `NAV_GROUPS` (currently `{ id: "github", label: "GitHub broker", icon: "⎇", enabled: false },`) to:

```ts
    { id: "github", label: "GitHub broker", icon: "⎇", enabled: true },
```

Add the section wrapper. In the `SHELL_MARKUP` template, immediately after the existing `<section class="section" data-section-id="milestones">${MILESTONES_MARKUP}</section>` line, insert:

```ts
    <section class="section" data-section-id="github">${GITHUB_BROKER_MARKUP}</section>
```

- [ ] **Step 4: Wire `console-ui.ts`**

In `src/gateway/console/console-ui.ts`, add this import after the existing `import { MILESTONES_SCRIPT } from "./milestones-section.js";` line:

```ts
import { GITHUB_BROKER_SCRIPT } from "./github-broker-section.js";
```

Change the `CONSOLE_SCRIPT` line from:

```ts
const CONSOLE_SCRIPT = `(()=>{"use strict";${CONTROLS_SCRIPT}\n${TRAIL_SCRIPT}\n${OVERVIEW_SCRIPT}\n${WARNINGS_SCRIPT}\n${SECURITY_SCRIPT}\n${COST_SCRIPT}\n${COMPARE_SCRIPT}\n${IMPORTS_SCRIPT}\n${POLICIES_SCRIPT}\n${PODS_SCRIPT}\n${MILESTONES_SCRIPT}\n${SHELL_SCRIPT}})();`;
```

to:

```ts
const CONSOLE_SCRIPT = `(()=>{"use strict";${CONTROLS_SCRIPT}\n${TRAIL_SCRIPT}\n${OVERVIEW_SCRIPT}\n${WARNINGS_SCRIPT}\n${SECURITY_SCRIPT}\n${COST_SCRIPT}\n${COMPARE_SCRIPT}\n${IMPORTS_SCRIPT}\n${POLICIES_SCRIPT}\n${PODS_SCRIPT}\n${MILESTONES_SCRIPT}\n${GITHUB_BROKER_SCRIPT}\n${SHELL_SCRIPT}})();`;
```

- [ ] **Step 5: Hook `loadGitHubBrokerActivity` into the refresh cycle**

In `src/gateway/console/controls-section.ts`, find the `refresh` function (ends with `...window.__consoleSections.pods?.load?.();window.__consoleSections.milestones?.load?.()};`). Change the ending from:

```
window.__consoleSections.pods?.load?.();window.__consoleSections.milestones?.load?.()};
```

to:

```
window.__consoleSections.pods?.load?.();window.__consoleSections.milestones?.load?.();window.__consoleSections.github?.load?.()};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/gateway/console/shell.test.ts tests/gateway/console/console-ui.test.ts tests/gateway/console/controls-section.test.ts tests/gateway/console/github-broker-section.test.ts`
Expected: PASS (all tests in all four files)

- [ ] **Step 7: Type-check and run the full gateway test directory**

Run: `pnpm check`
Expected: no errors

Run: `pnpm exec vitest run tests/gateway`
Expected: PASS (every gateway test, confirming nothing else in the composed console broke)

- [ ] **Step 8: Commit**

```bash
git add src/gateway/console/shell.ts src/gateway/console/console-ui.ts src/gateway/console/controls-section.ts tests/gateway/console/shell.test.ts tests/gateway/console/console-ui.test.ts tests/gateway/console/controls-section.test.ts
git commit -m "Wire GitHub broker into the console shell, script bundle, and refresh cycle"
```

---

### Task 5: Fix the stale keyboard-focus-order assertion this nav change causes

**Files:**
- Modify: `tests/ui/chromium-acceptance.ts:167`
- Modify: `tests/ui/cross-surface-acceptance.e2e.test.ts:139-155`

**Interfaces:** none — this task fixes one known-recurring test regression caused by Task 4's nav change.

Enabling the `github` nav item shifts the console's keyboard Tab order by one. This bug class has hit this project three times now (see `project_agent_rail_console_phase1` memory) — fix it now, not as an afterthought.

- [ ] **Step 1: Fix the stale keyboard-focus-order assertion**

In `tests/ui/chromium-acceptance.ts`, find `for (let index = 0; index < 15; index += 1) {` and change `15` to `16`.

In `tests/ui/cross-surface-acceptance.e2e.test.ts`, find:

```ts
    expect(browserResult.focusOrder.slice(0, 15)).toEqual([
      "button::▶ Controls",
      "button::◉ Overview",
      "button::⬡ Trail",
      "button::△ Warnings",
      "button::⛨ Security",
      "button::◔ Cost",
      "button::⑂ Compare runs",
      "button::⇥ Imports",
      "button::⬢ Pods",
      "button::⊕ Milestones",
      "button::⚙ Warning policies",
      expect.stringMatching(/^button:run-switcher-button:tickets/u),
      "textarea:goal:Goal",
      "button::Submit goal",
      "input:ticket-path:Project-relative folder",
    ]);
```

Change `.slice(0, 15)` to `.slice(0, 16)`, and insert `"button::⎇ GitHub broker",` as a new line immediately after `"button::⊕ Milestones",` and immediately before `"button::⚙ Warning policies",` (Journal remains disabled and stays out of the tab order).

- [ ] **Step 2: Verify the fix**

Run: `pnpm exec vitest run tests/ui/cross-surface-acceptance.e2e.test.ts`
Expected: PASS (if this environment has no canonical headless Chromium, it will SKIP instead — note which happened)

- [ ] **Step 3: Commit**

```bash
git add tests/ui/chromium-acceptance.ts tests/ui/cross-surface-acceptance.e2e.test.ts
git commit -m "Fix stale keyboard-focus-order assertion after enabling GitHub broker nav item (widen shared capture loop to 16)"
```

---

### Task 6: Real-browser e2e coverage

**Files:**
- Modify: `tests/ui/console-shell.e2e.test.ts`

**Interfaces:**
- Consumes: `consoleShellWorkflow(root)` (existing helper, returns `{workflow, journal}` — `journal` is a real `SqliteEventJournal`), `ChromiumWorkflowDriver` (existing helper).
- Produces: e2e proof that the GitHub broker nav item is genuinely enabled and renders real broker activity end-to-end through the real HTTP route.

- [ ] **Step 1: Write the failing test**

In `tests/ui/console-shell.e2e.test.ts`, add this import near the top, alongside the existing `PodRegistry`/`MilestoneRegistry` imports:

```ts
import { createHash } from "node:crypto";
```

Add a new test inside `describe.skipIf(acceptanceBrowser === null)("console shell, real browser", () => { ... })`, after the `"enables the Milestones nav item and renders a registered milestone's plan on click"` test:

```ts
  it("enables the GitHub broker nav item and renders real broker activity on click", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-github-broker-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const action = {
      operation: "push" as const, repository: "talibilat/zentra", targetRef: "refs/heads/zentra/grant-e2e",
      sourceCommit: "1".repeat(40), expectedOldOid: "0".repeat(40), force: false as const,
    };
    const actionDigest = createHash("sha256").update(JSON.stringify(action), "utf8").digest("hex");
    const common = { requestId: "grant-e2e", grantId: "grant-e2e", actionDigest };
    fixture.journal.append("github-grant:grant-e2e", 0, [{
      streamId: "github-grant:grant-e2e", type: "capsule.github_grant_consumed",
      payload: { ...common, audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", policyDigest: "a".repeat(64) },
      causationId: null, correlationId: "grant-e2e",
    }, {
      streamId: "github-grant:grant-e2e", type: "capsule.github_broker_accepted",
      payload: { ...common, policyDigest: "a".repeat(64), ...action }, causationId: null, correlationId: "grant-e2e",
    }, {
      streamId: "github-grant:grant-e2e", type: "capsule.github_broker_reconciled",
      payload: { ...common, ...action, attempt: 1, outcome: "completed", observedRemoteOid: action.sourceCommit },
      causationId: null, correlationId: "grant-e2e",
    }]);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.click('[data-nav-id="github"]');
      await driver.waitFor(`document.querySelector('[data-section-id="github"]')?.dataset.active === "true"`);
      await driver.waitFor(`document.getElementById("github-broker-list")?.textContent.includes("talibilat/zentra")`);
      await driver.click('#github-broker-list button.run-card');
      await driver.waitFor(`document.getElementById("github-broker-detail")?.textContent.includes("grant-e2e")`);
      const detailText = await driver.evaluate<string>(`document.getElementById("github-broker-detail")?.textContent || ""`);
      expect(detailText).toContain("Push");
      expect(detailText).toContain("Completed");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts -t "enables the GitHub broker nav item"`
Expected: either SKIP (if no canonical headless Chromium is available in this environment) or FAIL at the first `waitFor` (nav item still disabled / click has no effect) if Chromium is available.

- [ ] **Step 3: No implementation step — Tasks 1-5 already made this pass**

This task is pure verification of the already-implemented behavior; there is no new source change here.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts`
Expected: PASS on every test in the file (or SKIP if this environment has no canonical Chromium — note which happened)

- [ ] **Step 5: Commit**

```bash
git add tests/ui/console-shell.e2e.test.ts
git commit -m "Add e2e coverage for the GitHub broker nav item and activity detail rendering"
```

---

### Task 7: Regenerate the codebase map (strictly last)

**Files:**
- Modify: `docs/codebase-map.html` (regenerated, not hand-edited)

**Interfaces:** none.

This task exists solely to close the recurring codebase-map staleness bug — and it runs **after Task 6**, deliberately, because Task 6 edits `tests/ui/console-shell.e2e.test.ts`, a file the map indexes. Running this any earlier (as Step 4b/Milestones did, placing it before its own e2e task) leaves the map stale a second time.

- [ ] **Step 1: Regenerate**

Run: `pnpm docs:codebase-map`

- [ ] **Step 2: Verify**

Run: `pnpm exec vitest run tests/docs/codebase-map.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add docs/codebase-map.html
git commit -m "Regenerate codebase map after GitHub broker console section"
```

---

### Task 8: Full verification, merge, push, and issue tracking

**Files:** none (verification, git, and GitHub issue operations only)

**Interfaces:** none — this task consumes the finished state of Tasks 1-7 and produces the shipped, tracked result.

- [ ] **Step 1: Run the full check and test suite**

Run: `pnpm check`
Expected: no errors

Run: `pnpm test`
Expected: PASS (every test in the repository). Expect roughly 8-9 pre-existing environmental failures unrelated to this work (Docker Desktop unavailable, npm-pack/install e2e, AgentTrail fleet byte-eviction timing, and other heavy real-subprocess/real-browser tests that flake under concurrent load but pass in isolation). Verify any failure beyond that known baseline by re-running the specific file in isolation (`pnpm exec vitest run <file>`) before treating it as a real regression from this branch. If the failure count balloons across files with zero connection to this branch's diff on successive full-suite runs (rather than staying stable), check for orphaned child processes (`ps aux`) and system load (`uptime`) before concluding anything about the code — this happened during Step 4b's verification and was environmental, not a regression.

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

- [ ] **Step 5: Close #123**

```bash
gh issue close 123 --comment "Shipped: listGitHubBrokerActivity() (new function in github-broker.ts, not a GitHubEffectBroker method), GET /api/v1/zentra/github-broker, and github-broker-section.ts wired into the console shell. See docs/superpowers/specs/2026-08-06-agent-rail-console-phase2-github-broker-design.md and docs/superpowers/plans/2026-08-06-agent-rail-console-phase2-github-broker-plan.md."
```

- [ ] **Step 6: Update project memory**

Update `project_agent_rail_console_phase1.md` in the memory directory (`/Users/talibilat/.claude/projects/-Users-talibilat-Documents-Projects-zentra/memory/`) to record: #123 (Step 4c, GitHub broker) shipped, with its merge commit SHA; that the read projection lives in `github-broker.ts` as a plain function rather than a class method (confirming the design decision and why); that codebase-map regeneration was correctly sequenced as the strictly-last task this time (confirming the Step 4b lesson actually worked when applied); and any other findings worth carrying into #124 (Journal). Update the memory's `description` and `MEMORY.md`'s index line accordingly, following the existing file's structure.
