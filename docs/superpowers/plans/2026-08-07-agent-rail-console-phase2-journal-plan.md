# Agent Rail Console Phase 2 Step 4d (Journal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the disabled "Journal" nav item to real journal-maintenance data: retention/recovery health from `JournalRetentionService`, plus the live AgentTrail projection cursor's health from the already-injected `EventJournal`, composed into one `JournalStatus` read model behind `GET /api/v1/zentra/journal`, rendered as a single-panel status dashboard.

**Architecture:** A new lightweight `metadataSummary()` method on `JournalRetentionService` (no expensive per-segment rescan); a new composition module `src/journal/journal-status.ts` that reads both the retention service (opened read-only by database path) and the live journal object (projection cursor health, when the journal is a `ProjectingEventJournal`); a new optional `databasePath` dependency threaded through `WorkflowSurface` → `LocalWorkflowSurfaceOptions` → `start-service.ts`; one new GET route; one new console section file.

**Tech Stack:** TypeScript, `better-sqlite3` (via existing `SqliteEventJournal`/`JournalRetentionService`), Vitest, the existing framework-free console template-literal pattern.

## Global Constraints

- Read-only everywhere: `getJournalStatus()` never calls a mutating retention method (`archive`, `requestPrune`, `prune`, `maintain`, `export`, `restore`, `reconcile`) and never calls `verify()` (which performs a full per-segment rescan unsuitable for a polled console route) — only the new `metadataSummary()` and the existing `inspectRecovery()`, both confirmed read-only.
- The raw `databasePath` string must never appear in the `JournalStatus` API response — every field is a number, enum, or boolean derived from it, never the path itself.
- Both halves of `JournalStatus` (`retention`, `projection`) are independently nullable and must render an honest "unavailable" message when `null`, never a fabricated zero — matches the convention Overview set in Phase 2 Step 1.
- `databasePath` is an **optional** trailing parameter at every layer (`WorkflowSurface` constructor, `LocalWorkflowSurfaceOptions`) — existing call sites that don't supply it are unaffected; `getJournalStatus()` still returns a valid result with `retention: null`.
- Codebase-map regeneration (`pnpm docs:codebase-map`) must be the plan's last content task (Task 9), and must be re-verified fresh as the literal last commit before merge — re-run it after any later fix-pass commit, not just once per the plan.
- Enabling the `journal` nav item shifts the console's keyboard Tab order by one; both `tests/ui/cross-surface-acceptance.e2e.test.ts` and `tests/ui/chromium-acceptance.ts` need their hardcoded focus-order bound bumped and the new button inserted in nav order (Task 8).
- Full spec: `docs/superpowers/specs/2026-08-07-agent-rail-console-phase2-journal-design.md`.

---

### Task 1: `JournalRetentionService.metadataSummary()`

**Files:**
- Modify: `src/journal/retention.ts`
- Test: `tests/retention/journal-retention.test.ts`

**Interfaces:**
- Consumes: `this.metadata()` (private, existing) and `this.policy()` (public, existing) on `JournalRetentionService`.
- Produces: `JournalRetentionService.metadataSummary(): { globalPosition: number; retainedThroughPosition: number; archiveHeadPosition: number; archiveSegmentCount: number; policy: RetentionPolicy }` — consumed by Task 2.

- [ ] **Step 1: Write the failing test**

Add to `tests/retention/journal-retention.test.ts`, inside the existing `describe("JournalRetentionService", ...)` block (after the `"retains forever by default and never deletes during archive or maintenance"` test, which already demonstrates the `fixture()`/`archive()` pattern this test extends):

```ts
  it("summarizes journal metadata without rescanning archived segments", () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 12, maxEvents: 12 });

    const summary = retention.metadataSummary();
    expect(summary).toEqual({
      globalPosition: 24,
      retainedThroughPosition: 0,
      archiveHeadPosition: 12,
      archiveSegmentCount: 1,
      policy: { mode: "retain_forever", automaticDeletion: false },
    });

    // Corrupt the archived segment file metadataSummary() must NOT read, to prove it never
    // rescans archive segments the way verify() does (verify() would fail against this corruption).
    const archiveRoot = `${databasePath}.archives`;
    const segmentFile = readdirSync(archiveRoot).find((name) => name.endsWith(".events.jsonl"));
    if (segmentFile === undefined) throw new Error("expected an archived segment file");
    writeFileSync(path.join(archiveRoot, segmentFile), "corrupted");
    expect(() => retention.metadataSummary()).not.toThrow();
    expect(retention.metadataSummary()).toEqual(summary);
    expect(() => retention.verify()).toThrow();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/retention/journal-retention.test.ts -t "summarizes journal metadata"`
Expected: FAIL with `retention.metadataSummary is not a function`

- [ ] **Step 3: Implement `metadataSummary()`**

In `src/journal/retention.ts`, add the new method immediately after the existing `policy()` method (around line 234, right before `archive(input: {...`):

```ts
  metadataSummary(): {
    readonly globalPosition: number;
    readonly retainedThroughPosition: number;
    readonly archiveHeadPosition: number;
    readonly archiveSegmentCount: number;
    readonly policy: RetentionPolicy;
  } {
    this.assertIdentities();
    const metadata = this.metadata();
    return {
      globalPosition: metadata.globalPosition,
      retainedThroughPosition: metadata.retainedThroughPosition,
      archiveHeadPosition: metadata.archiveHeadPosition,
      archiveSegmentCount: metadata.archiveSegmentCount,
      policy: this.policy(),
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/retention/journal-retention.test.ts -t "summarizes journal metadata"`
Expected: PASS

- [ ] **Step 5: Run the full retention test file to confirm no regressions**

Run: `pnpm exec vitest run tests/retention/journal-retention.test.ts`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/journal/retention.ts tests/retention/journal-retention.test.ts
git commit -m "Add JournalRetentionService.metadataSummary() for cheap read-only stats"
```

---

### Task 2: `getJournalStatus()` composition

**Files:**
- Create: `src/journal/journal-status.ts`
- Test: `tests/journal/journal-status.test.ts`

**Interfaces:**
- Consumes: `JournalRetentionService.openReadOnly(databasePath)`, `.metadataSummary()` (Task 1), `.inspectRecovery()` (existing) from `src/journal/retention.ts`; `EventJournal`, `isDurablePagedEventJournal` from `src/journal/journal.js`; `ProjectingEventJournal` from `src/journal/projecting-journal.js`.
- Produces:
  ```ts
  export interface JournalProjectionStatus {
    readonly cursorName: string;
    readonly position: number;
    readonly highWaterPosition: number;
    readonly lag: number;
    readonly replayCount: number;
    readonly active: boolean;
  }
  export interface JournalStatus {
    readonly retention: {
      readonly globalPosition: number;
      readonly retainedThroughPosition: number;
      readonly archiveHeadPosition: number;
      readonly archiveSegmentCount: number;
      readonly policyMode: "retain_forever";
      readonly recoveryOutcome: "clean" | "uncertain";
      readonly recoveryKind: "archive" | "prune" | "maintenance" | "restore" | null;
      readonly recoveryState: string | null;
    } | null;
    readonly projection: JournalProjectionStatus | null;
  }
  export function getJournalStatus(journal: EventJournal, databasePath: string | undefined): JournalStatus
  ```
  Consumed by Task 3 (`WorkflowSurface.getJournalStatus()`).

- [ ] **Step 1: Write the failing test**

Create `tests/journal/journal-status.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getJournalStatus } from "../../src/journal/journal-status.js";
import { JournalRetentionService } from "../../src/journal/retention.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { readonly directory: string; readonly databasePath: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-journal-status-"));
  directories.push(directory);
  const databasePath = path.join(directory, "journal.sqlite");
  const journal = new SqliteEventJournal(databasePath);
  journal.append("stream-a", 0, [{
    streamId: "stream-a", type: "test.event", payload: {}, causationId: null, correlationId: "journal-status-test",
  }]);
  journal.close();
  return { directory, databasePath };
}

describe("getJournalStatus", () => {
  it("returns retention: null when no database path is configured", () => {
    const { databasePath } = fixture();
    const journal = new SqliteEventJournal(databasePath);
    try {
      const status = getJournalStatus(journal, undefined);
      expect(status.retention).toBeNull();
    } finally {
      journal.close();
    }
  });

  it("reports clean retention status with no archives yet", () => {
    const { databasePath } = fixture();
    const journal = new SqliteEventJournal(databasePath);
    try {
      const status = getJournalStatus(journal, databasePath);
      expect(status.retention).toEqual({
        globalPosition: 1,
        retainedThroughPosition: 0,
        archiveHeadPosition: 0,
        archiveSegmentCount: 0,
        policyMode: "retain_forever",
        recoveryOutcome: "clean",
        recoveryKind: null,
        recoveryState: null,
      });
    } finally {
      journal.close();
    }
  });

  it("reports an interrupted archive operation needing attention", () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 1, maxEvents: 1, crashPoint: "after_segment" });
    const journal = new SqliteEventJournal(databasePath);
    try {
      const status = getJournalStatus(journal, databasePath);
      expect(status.retention?.recoveryOutcome).toBe("uncertain");
      expect(status.retention?.recoveryKind).toBe("archive");
      expect(status.retention?.recoveryState).toBe("segment_only_orphan");
    } finally {
      journal.close();
    }
  });

  it("returns projection: null for a plain journal that is not a ProjectingEventJournal", () => {
    const { databasePath } = fixture();
    const journal = new SqliteEventJournal(databasePath);
    try {
      const status = getJournalStatus(journal, undefined);
      expect(status.projection).toBeNull();
    } finally {
      journal.close();
    }
  });

  it("reports live projection cursor health for a ProjectingEventJournal", () => {
    const { databasePath } = fixture();
    const inner = new SqliteEventJournal(databasePath);
    const projected = new ProjectingEventJournal(inner, { append: () => {} }, "journal-status-test-cursor");
    try {
      const status = getJournalStatus(projected, undefined);
      expect(status.projection).toEqual({
        cursorName: "journal-status-test-cursor",
        position: 1,
        highWaterPosition: 1,
        lag: 0,
        replayCount: 0,
        active: false,
      });
    } finally {
      inner.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/journal/journal-status.test.ts`
Expected: FAIL — `Cannot find module '../../src/journal/journal-status.js'`

- [ ] **Step 3: Implement `src/journal/journal-status.ts`**

```ts
import { isDurablePagedEventJournal, type EventJournal } from "./journal.js";
import { ProjectingEventJournal } from "./projecting-journal.js";
import { JournalRetentionService } from "./retention.js";

export interface JournalProjectionStatus {
  readonly cursorName: string;
  readonly position: number;
  readonly highWaterPosition: number;
  readonly lag: number;
  readonly replayCount: number;
  readonly active: boolean;
}

export interface JournalStatus {
  readonly retention: {
    readonly globalPosition: number;
    readonly retainedThroughPosition: number;
    readonly archiveHeadPosition: number;
    readonly archiveSegmentCount: number;
    readonly policyMode: "retain_forever";
    readonly recoveryOutcome: "clean" | "uncertain";
    readonly recoveryKind: "archive" | "prune" | "maintenance" | "restore" | null;
    readonly recoveryState: string | null;
  } | null;
  readonly projection: JournalProjectionStatus | null;
}

export function getJournalStatus(journal: EventJournal, databasePath: string | undefined): JournalStatus {
  return {
    retention: databasePath === undefined ? null : buildRetentionStatus(databasePath),
    projection: buildProjectionStatus(journal),
  };
}

function buildRetentionStatus(databasePath: string): JournalStatus["retention"] {
  const retention = JournalRetentionService.openReadOnly(databasePath);
  const summary = retention.metadataSummary();
  const recovery = retention.inspectRecovery();
  return {
    globalPosition: summary.globalPosition,
    retainedThroughPosition: summary.retainedThroughPosition,
    archiveHeadPosition: summary.archiveHeadPosition,
    archiveSegmentCount: summary.archiveSegmentCount,
    policyMode: summary.policy.mode,
    recoveryOutcome: recovery.outcome,
    recoveryKind: recovery.kind,
    recoveryState: recovery.outcome === "clean" ? null : recovery.state,
  };
}

function buildProjectionStatus(journal: EventJournal): JournalProjectionStatus | null {
  if (!(journal instanceof ProjectingEventJournal) || !isDurablePagedEventJournal(journal)) return null;
  const cursorName = journal.projectionCursorName;
  const cursor = journal.inspectProjectionCursor(cursorName);
  if (cursor === null) return null;
  return {
    cursorName,
    position: cursor.position,
    highWaterPosition: cursor.highWaterPosition,
    lag: cursor.lag,
    replayCount: cursor.replayCount,
    active: journal.inspectProjectionClaim(cursorName) !== null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/journal/journal-status.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/journal/journal-status.ts tests/journal/journal-status.test.ts
git commit -m "Add getJournalStatus() composing retention and live projection health"
```

---

### Task 3: `WorkflowSurface.getJournalStatus()` and `databasePath` threading

**Files:**
- Modify: `src/surfaces/workflow-surface.ts`
- Modify: `src/surfaces/local-workflow.ts`
- Modify: `src/service/start-service.ts`
- Test: `tests/surfaces/workflow-surface.test.ts`

**Interfaces:**
- Consumes: `getJournalStatus`, `type JournalStatus` from Task 2's `src/journal/journal-status.js`.
- Produces: `WorkflowSurface.getJournalStatus(): JournalStatus` — consumed by Task 4 (gateway route). `LocalWorkflowSurfaceOptions.databasePath?: string` — consumed by Task 8 (e2e fixture).

- [ ] **Step 1: Write the failing test**

Add to `tests/surfaces/workflow-surface.test.ts`, near the file's other single-purpose surface tests (the file already has a `surfaceFor(journal, submitter?)` helper at line ~511 that constructs a bare `WorkflowSurface` from a `SqliteEventJournal`; extend it to accept an optional `databasePath` for this test only, or construct `WorkflowSurface` directly):

```ts
describe("getJournalStatus", () => {
  it("returns a JournalStatus with retention data when databasePath is supplied", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-workflow-surface-journal-"));
    try {
      const databasePath = path.join(directory, "events.sqlite");
      const journal = new SqliteEventJournal(databasePath);
      const runs = new RunService(journal);
      const attention = new AttentionService(journal);
      const planning = new PlanningCoordinator(journal, runs, attention, []);
      const surface = new WorkflowSurface(
        journal, runs, attention, planning,
        { submit: () => { throw new Error("not used"); } },
        { advance: () => { throw new Error("not used"); } },
        undefined, undefined, databasePath,
      );
      const status = surface.getJournalStatus();
      expect(status.retention).not.toBeNull();
      expect(status.retention?.recoveryOutcome).toBe("clean");
      journal.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns retention: null when databasePath is omitted", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-workflow-surface-journal-"));
    try {
      const journal = new SqliteEventJournal(path.join(directory, "events.sqlite"));
      const surface = surfaceFor(journal);
      const status = surface.getJournalStatus();
      expect(status.retention).toBeNull();
      journal.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
```

(`mkdtempSync`, `rmSync`, `path`, `tmpdir` are already imported at the top of this test file for its other fixtures — reuse the existing imports, do not re-import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/surfaces/workflow-surface.test.ts -t "getJournalStatus"`
Expected: FAIL with `surface.getJournalStatus is not a function`

- [ ] **Step 3: Add the import and method to `WorkflowSurface`**

In `src/surfaces/workflow-surface.ts`, add the import immediately after the existing `"../journal/journal.js"` import block (after line 41, before the `milestone-registry.js` import on line 42):

```ts
import { getJournalStatus, type JournalStatus } from "../journal/journal-status.js";
```

Change the constructor (around line 315-325) to add the new optional trailing parameter:

```ts
export class WorkflowSurface<TResult = unknown> {
  constructor(
    private readonly journal: EventJournal,
    private readonly runs: RunService,
    private readonly attentionService: AttentionService,
    private readonly planningCoordinator: PlanningCoordinator,
    private readonly submitter: RunSubmitter<TResult>,
    private readonly runAdvancer: RunAdvancer,
    private readonly artifactTextReader?: IntakeArtifactTextReader,
    private readonly projectIdentity?: ProjectIdentity,
    private readonly databasePath?: string,
  ) {}
```

Add the new method next to `getMilestone()` (or any other single-item getter — exact neighboring location does not matter, only that it lives among the other public read methods):

```ts
  getJournalStatus(): JournalStatus {
    return this.guard(() => getJournalStatus(this.journal, this.databasePath));
  }
```

- [ ] **Step 4: Thread `databasePath` through `LocalWorkflowSurfaceOptions`**

In `src/surfaces/local-workflow.ts`, add to the `LocalWorkflowSurfaceOptions` interface (after the existing `readonly afterSubmissionReserved?: ...` field, around line 57):

```ts
  readonly databasePath?: string;
```

Change the closing arguments of the `new WorkflowSurface(...)` call (around line 161-164) from:

```ts
    options.runAdvancer ?? unavailableAdvancer,
    artifacts,
    project,
  );
```

to:

```ts
    options.runAdvancer ?? unavailableAdvancer,
    artifacts,
    project,
    options.databasePath,
  );
```

- [ ] **Step 5: Thread `layout.databasePath` through `start-service.ts`**

In `src/service/start-service.ts`, add `databasePath: layout.databasePath,` to the `workflowOptions` object literal (around line 450-458):

```ts
    const workflowOptions: LocalWorkflowSurfaceOptions = {
      journal,
      process: claim,
      serviceReadyEventId: ready.eventId,
      projectRoot: layout.projectRoot,
      projectRevision,
      traceProjectionFailed: () => journal.projectionFailed || sink!.streamFailed === true,
      runAdvancer,
      databasePath: layout.databasePath,
    };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm exec vitest run tests/surfaces/workflow-surface.test.ts`
Expected: all tests pass, including the two new ones

- [ ] **Step 7: Run the full local-workflow and start-service test suites to confirm no regressions from the constructor signature change**

Run: `pnpm exec vitest run tests/surfaces/local-workflow.e2e.test.ts tests/conformance/first-delivery.test.ts`
Expected: all pass (these exercise `createLocalWorkflowSurface`/`start-service.ts` without needing to know about the new optional parameter)

- [ ] **Step 8: Commit**

```bash
git add src/surfaces/workflow-surface.ts src/surfaces/local-workflow.ts src/service/start-service.ts tests/surfaces/workflow-surface.test.ts
git commit -m "Thread optional databasePath into WorkflowSurface and add getJournalStatus()"
```

---

### Task 4: Gateway route

**Files:**
- Modify: `src/gateway/loopback-gateway.ts`
- Test: `tests/gateway/loopback-gateway.test.ts`

**Interfaces:**
- Consumes: `WorkflowSurface.getJournalStatus()` (Task 3) via the existing generic `this.invoke("getJournalStatus")` mechanism.
- Produces: `GET /api/v1/zentra/journal` — consumed by Task 5 (`journal-section.ts`).

- [ ] **Step 1: Write the failing test**

Add to `tests/gateway/loopback-gateway.test.ts`, next to the existing `github-broker` route test (find it via the existing `listGitHubBrokerActivity` mock in the `workflow()` fixture and its matching route test):

```ts
  it("exposes journal status as a read-only, bearer-authenticated route", async () => {
    const status = { retention: null, projection: null };
    const gateway = new LoopbackGateway({ workflow: workflow({ getJournalStatus: () => status }) });
    const session = await gateway.start();
    try {
      const auth = await establishSession(session);
      const response = await fetch(`${session.origin}/api/v1/zentra/journal`, {
        headers: { authorization: `Bearer ${auth.bearerToken}`, accept: "application/json" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(status);
      const unauthenticated = await fetch(`${session.origin}/api/v1/zentra/journal`, { headers: { accept: "application/json" } });
      expect(unauthenticated.status).toBe(401);
    } finally {
      await gateway.close();
    }
  });
```

(Add `getJournalStatus: () => status` matching the existing `workflow({...})` fixture's mock-object pattern — read the file's existing `github-broker` route test immediately above this insertion point to match its exact `establishSession`/`workflow()` helper calls, which this test reuses verbatim.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/gateway/loopback-gateway.test.ts -t "journal status"`
Expected: FAIL with a 404/unhandled-route response instead of 200

- [ ] **Step 3: Add the route**

In `src/gateway/loopback-gateway.ts`, add immediately after the existing `github-broker` GET branch (after line 401):

```ts
      if (request.method === "GET" && segments.length === 1 && segments[0] === "journal" && url.search === "") {
        return this.jsonResult(response, await this.invoke("getJournalStatus"));
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/gateway/loopback-gateway.test.ts -t "journal status"`
Expected: PASS

- [ ] **Step 5: Run the full gateway test file to confirm no regressions**

Run: `pnpm exec vitest run tests/gateway/loopback-gateway.test.ts`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/gateway/loopback-gateway.ts tests/gateway/loopback-gateway.test.ts
git commit -m "Add GET /api/v1/zentra/journal route"
```

---

### Task 5: `journal-section.ts`

**Files:**
- Create: `src/gateway/console/journal-section.ts`
- Test: `tests/gateway/console/journal-section.test.ts`

**Interfaces:**
- Consumes: `GET /api/v1/zentra/journal` (Task 4); shared console helpers already in scope at runtime (`$`, `setText`, `request`, `field`, `badge`, `label`) — defined once in `controls-section.ts`, available to every later-concatenated section script, same as every prior section.
- Produces: `JOURNAL_MARKUP`, `JOURNAL_SCRIPT` — consumed by Task 6 (wiring into `shell.ts`/`console-ui.ts`).

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/console/journal-section.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { JOURNAL_MARKUP, JOURNAL_SCRIPT } from "../../../src/gateway/console/journal-section.js";

describe("journal section", () => {
  it("is a single-panel status dashboard, not a two-column list+detail layout", () => {
    expect(JOURNAL_MARKUP).not.toContain('data-columns="2"');
    expect(JOURNAL_MARKUP).toContain('data-screen-label="Journal"');
  });

  it("fetches status from the real API, not a static demo dataset", () => {
    expect(JOURNAL_SCRIPT).toContain('request("/api/v1/zentra/journal")');
    expect(JOURNAL_SCRIPT).not.toContain("DEMO_DATA");
    const requestCalls = JOURNAL_SCRIPT.match(/request\(/g) ?? [];
    expect(requestCalls.length).toBe(1);
  });

  it("registers a load hook and does not self-invoke at script load", () => {
    expect(JOURNAL_SCRIPT).toContain("window.__consoleSections.journal={render:renderJournalStatus,load:loadJournalStatus}");
    expect(JOURNAL_SCRIPT.trim().endsWith("load:loadJournalStatus};")).toBe(true);
  });

  it("never builds DOM with innerHTML", () => {
    expect(JOURNAL_SCRIPT).not.toContain("innerHTML");
  });

  it("shows honest unavailable states for the whole fetch, retention, and projection independently", () => {
    expect(JOURNAL_SCRIPT).toContain("Journal status unavailable.");
    expect(JOURNAL_SCRIPT).toContain("Retention status unavailable in this environment.");
    expect(JOURNAL_SCRIPT).toContain("Projection status unavailable in this environment.");
  });

  it("renders recovery outcome and the retention/archive facts", () => {
    for (const term of ["Retained through", "Archive head", "Archive segments", "Retention policy", "Recovery"]) {
      expect(JOURNAL_SCRIPT).toContain(term);
    }
  });

  it("renders the live projection cursor facts", () => {
    for (const term of ["Cursor", "Lag", "Replay count"]) {
      expect(JOURNAL_SCRIPT).toContain(term);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/gateway/console/journal-section.test.ts`
Expected: FAIL — `Cannot find module '../../../src/gateway/console/journal-section.js'`

- [ ] **Step 3: Implement `src/gateway/console/journal-section.ts`**

```ts
export const JOURNAL_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Journal"><section class="panel"><h2>Retention and recovery</h2><div id="journal-retention"></div></section><section class="panel" style="margin-top:16px"><h2>Live projection</h2><div id="journal-projection"></div></section></div>`;

export const JOURNAL_SCRIPT = String.raw`let journalStatus=null;let journalLoadFailed=false;
const loadJournalStatus=async()=>{
  try{journalStatus=await request("/api/v1/zentra/journal");journalLoadFailed=false}
  catch{journalStatus=null;journalLoadFailed=true}
  renderJournalStatus();
};
const renderJournalRetention=()=>{
  const host=$("journal-retention");host.replaceChildren();
  if(journalLoadFailed){const empty=document.createElement("p");empty.className="empty";setText(empty,"Journal status unavailable.");host.append(empty);return}
  const retention=journalStatus&&journalStatus.retention;
  if(!retention){const empty=document.createElement("p");empty.className="empty";setText(empty,"Retention status unavailable in this environment.");host.append(empty);return}
  const facts=document.createElement("dl");facts.className="facts";
  facts.append(
    field("Retained through",String(retention.retainedThroughPosition)),
    field("Archive head",String(retention.archiveHeadPosition)),
    field("Archive segments",String(retention.archiveSegmentCount)),
    field("Retention policy",label(retention.policyMode)),
    field("Recovery",retention.recoveryOutcome==="clean"?"Clean":label(retention.recoveryKind)+": "+label(retention.recoveryState)),
  );
  host.append(facts);
};
const renderJournalProjection=()=>{
  const host=$("journal-projection");host.replaceChildren();
  if(journalLoadFailed)return;
  const projection=journalStatus&&journalStatus.projection;
  if(!projection){const empty=document.createElement("p");empty.className="empty";setText(empty,"Projection status unavailable in this environment.");host.append(empty);return}
  const facts=document.createElement("dl");facts.className="facts";
  facts.append(
    field("Cursor",projection.cursorName),
    field("Position",String(projection.position)),
    field("Lag",String(projection.lag)),
    field("Replay count",String(projection.replayCount)),
    field("Active",projection.active?"Yes":"No"),
  );
  host.append(facts);
};
const renderJournalStatus=()=>{renderJournalRetention();renderJournalProjection()};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.journal={render:renderJournalStatus,load:loadJournalStatus};`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/gateway/console/journal-section.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/journal-section.ts tests/gateway/console/journal-section.test.ts
git commit -m "Add journal-section.ts single-panel status dashboard"
```

---

### Task 6: Wire Journal into shell/console-ui/refresh

**Files:**
- Modify: `src/gateway/console/shell.ts`
- Modify: `src/gateway/console/console-ui.ts`
- Modify: `src/gateway/console/controls-section.ts`
- Test: `tests/gateway/console/shell.test.ts`
- Test: `tests/gateway/console/console-ui.test.ts`
- Test: `tests/gateway/console/controls-section.test.ts`

**Interfaces:**
- Consumes: `JOURNAL_MARKUP`, `JOURNAL_SCRIPT` from Task 5.
- Produces: nothing new — this task only wires existing exports into the shell.

- [ ] **Step 1: Write the failing tests**

In `tests/gateway/console/shell.test.ts`:
- Change line 23's enabled-nav-ids test to add `"data-nav-id=\"journal\""` to the array, and add `expect(SHELL_MARKUP).not.toContain('data-nav-id="journal" disabled');`.
- Remove the now-obsolete `expect(SHELL_MARKUP).toContain('data-nav-id="journal" disabled');` assertion at line 29.

The full edited test (replacing the existing one at lines 22-30):

```ts
  it("marks Controls, Overview, Trail, Pods, Milestones, GitHub broker, and Journal as enabled nav targets", () => {
    for (const enabled of ["data-nav-id=\"controls\"", "data-nav-id=\"overview\"", "data-nav-id=\"trail\"", "data-nav-id=\"pods\"", "data-nav-id=\"milestones\"", "data-nav-id=\"github\"", "data-nav-id=\"journal\""]) {
      expect(SHELL_MARKUP).toContain(enabled);
    }
    expect(SHELL_MARKUP).not.toContain('data-nav-id="pods" disabled');
    expect(SHELL_MARKUP).not.toContain('data-nav-id="milestones" disabled');
    expect(SHELL_MARKUP).not.toContain('data-nav-id="github" disabled');
    expect(SHELL_MARKUP).not.toContain('data-nav-id="journal" disabled');
  });
```

In `tests/gateway/console/console-ui.test.ts`, add (matching the existing `id="github-broker-list"` markup-inclusion test and `GITHUB_BROKER_SCRIPT` concatenation test as models):

```ts
  it("includes the Journal section markup", () => {
    const html = consoleHtml();
    expect(html).toContain('id="journal-retention"');
    expect(html).toContain('id="journal-projection"');
  });

  it("concatenates JOURNAL_SCRIPT into the composed document", () => {
    const html = consoleHtml();
    expect(html).toContain("window.__consoleSections.journal={render:renderJournalStatus,load:loadJournalStatus}");
  });
```

In `tests/gateway/console/controls-section.test.ts`, add (matching the existing `window.__consoleSections.github?.load?.()` test):

```ts
  it("hooks Journal's load into refresh", () => {
    expect(CONTROLS_SCRIPT).toContain("window.__consoleSections.journal?.load?.()");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/gateway/console/shell.test.ts tests/gateway/console/console-ui.test.ts tests/gateway/console/controls-section.test.ts`
Expected: the new/modified assertions FAIL (journal nav item still disabled, markup/script not wired)

- [ ] **Step 3: Wire `shell.ts`**

In `src/gateway/console/shell.ts`:
- Add `import { JOURNAL_MARKUP } from "./journal-section.js";` after the existing `github-broker-section.js` import (line 13).
- Change line 35 from `{ id: "journal", label: "Journal", icon: "≣", enabled: false },` to `{ id: "journal", label: "Journal", icon: "≣", enabled: true },`.
- Add `<section class="section" data-section-id="journal">${JOURNAL_MARKUP}</section>` after the `github` section wrapper (after line 162, before line 163's `policies` section wrapper).

- [ ] **Step 4: Wire `console-ui.ts`**

In `src/gateway/console/console-ui.ts`:
- Add `import { JOURNAL_SCRIPT } from "./journal-section.js";` after the existing `github-broker-section.js` import (line 15).
- Change the `CONSOLE_SCRIPT` template (line 17) to insert `${JOURNAL_SCRIPT}` between `${GITHUB_BROKER_SCRIPT}` and `${SHELL_SCRIPT}`:

```ts
const CONSOLE_SCRIPT = `(()=>{"use strict";${CONTROLS_SCRIPT}\n${TRAIL_SCRIPT}\n${OVERVIEW_SCRIPT}\n${WARNINGS_SCRIPT}\n${SECURITY_SCRIPT}\n${COST_SCRIPT}\n${COMPARE_SCRIPT}\n${IMPORTS_SCRIPT}\n${POLICIES_SCRIPT}\n${PODS_SCRIPT}\n${MILESTONES_SCRIPT}\n${GITHUB_BROKER_SCRIPT}\n${JOURNAL_SCRIPT}\n${SHELL_SCRIPT}})();`;
```

- [ ] **Step 5: Wire `controls-section.ts`**

In `src/gateway/console/controls-section.ts`, change the end of `refresh()`'s hook chain from:

```ts
window.__consoleSections.pods?.load?.();window.__consoleSections.milestones?.load?.();window.__consoleSections.github?.load?.()};
```

to:

```ts
window.__consoleSections.pods?.load?.();window.__consoleSections.milestones?.load?.();window.__consoleSections.github?.load?.();window.__consoleSections.journal?.load?.()};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/gateway/console/shell.test.ts tests/gateway/console/console-ui.test.ts tests/gateway/console/controls-section.test.ts`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add src/gateway/console/shell.ts src/gateway/console/console-ui.ts src/gateway/console/controls-section.ts tests/gateway/console/shell.test.ts tests/gateway/console/console-ui.test.ts tests/gateway/console/controls-section.test.ts
git commit -m "Wire Journal section into shell, console-ui, and refresh cycle"
```

---

### Task 7: Fix focus-order regression

**Files:**
- Modify: `tests/ui/chromium-acceptance.ts`
- Modify: `tests/ui/cross-surface-acceptance.e2e.test.ts`

**Interfaces:**
- Consumes: nothing new — this task only fixes a hardcoded assertion that Task 6's nav change breaks.
- Produces: nothing new.

- [ ] **Step 1: Confirm the regression**

Run: `pnpm exec vitest run tests/ui/cross-surface-acceptance.e2e.test.ts`
Expected: FAIL — `focusOrder.slice(0, 16)` no longer matches the expected array, because the newly enabled Journal button shifts every subsequent Tab-order entry by one.

- [ ] **Step 2: Bump the capture-loop bound**

In `tests/ui/chromium-acceptance.ts`, change line 167 from:

```ts
    for (let index = 0; index < 16; index += 1) {
```

to:

```ts
    for (let index = 0; index < 17; index += 1) {
```

- [ ] **Step 3: Bump the assertion array**

In `tests/ui/cross-surface-acceptance.e2e.test.ts`, change:

```ts
    expect(browserResult.focusOrder.slice(0, 16)).toEqual([
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
      "button::⎇ GitHub broker",
      "button::⚙ Warning policies",
```

to:

```ts
    expect(browserResult.focusOrder.slice(0, 17)).toEqual([
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
      "button::⎇ GitHub broker",
      "button::≣ Journal",
      "button::⚙ Warning policies",
```

(leave every other line in the array — `expect.stringMatching(...)`, `"textarea:goal:Goal"`, etc. — unchanged; only the slice bound and the two lines above change)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/ui/cross-surface-acceptance.e2e.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/ui/chromium-acceptance.ts tests/ui/cross-surface-acceptance.e2e.test.ts
git commit -m "Fix focus-order assertions for the newly enabled Journal nav item"
```

---

### Task 8: e2e coverage

**Files:**
- Modify: `tests/ui/console-shell.e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7, exercised end-to-end through a real browser.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

In `tests/ui/console-shell.e2e.test.ts`, change the `consoleShellWorkflow` helper's `createLocalWorkflowSurface` call (around line 127-129) to pass `databasePath`, so the e2e fixture's journal actually has retention data available:

```ts
  const workflow = await createLocalWorkflowSurface({
    journal, process, serviceReadyEventId, projectRoot: root, projectRevision: await resolveProjectRevision(root),
    databasePath: path.join(root, "workflow.sqlite"),
  });
```

Add a new test, alongside the existing `"enables the GitHub broker nav item and renders real broker activity on click"` test (use it as the structural model — same `consoleShellWorkflow`/`LoopbackGateway`/`ChromiumWorkflowDriver` setup):

```ts
  it("enables the Journal nav item and renders real retention and recovery status", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-journal-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.click('[data-nav-id="journal"]');
      await driver.waitFor(`document.querySelector('[data-section-id="journal"]')?.dataset.active === "true"`);
      await driver.waitFor(`document.getElementById("journal-retention")?.textContent.includes("Clean")`);
      const retentionText = await driver.evaluate<string>(`document.getElementById("journal-retention")?.textContent || ""`);
      expect(retentionText).toContain("Retain Forever");
      // consoleShellWorkflow's journal is a plain SqliteEventJournal, not wrapped in a
      // ProjectingEventJournal, so the honest-unavailable path for the projection card is
      // itself the real end-to-end behavior being proven here, not a compromise.
      const projectionText = await driver.evaluate<string>(`document.getElementById("journal-projection")?.textContent || ""`);
      expect(projectionText).toContain("Projection status unavailable in this environment.");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts -t "Journal nav item"`
Expected: FAIL — Journal nav item is still disabled / section not active (if run before Task 6-7 land; if run after, this step is a formality confirming green — since Tasks 1-7 are already committed by this point in execution order, treat this as the integration proof, and if it fails, diagnose against the wiring from Tasks 3-7 rather than assuming the test itself is wrong)

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts -t "Journal nav item"`
Expected: PASS

- [ ] **Step 4: Run the full e2e file to confirm no regressions**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts`
Expected: all tests pass, including the pre-existing GitHub broker/Milestones/Pods e2e tests (unaffected by the `databasePath` addition, since it's optional and additive)

- [ ] **Step 5: Commit**

```bash
git add tests/ui/console-shell.e2e.test.ts
git commit -m "Add e2e coverage for the Journal nav item and real retention status rendering"
```

---

### Task 9: Regenerate codebase map (strictly last)

**Files:**
- Modify: `docs/codebase-map.html`

**Interfaces:**
- Consumes: every file created/modified in Tasks 1-8.
- Produces: nothing new — this task exists solely to keep the generated inventory in sync.

- [ ] **Step 1: Confirm the map is stale**

Run: `pnpm exec vitest run tests/docs/codebase-map.test.ts`
Expected: FAIL — the map doesn't yet reflect `src/journal/journal-status.ts`, `src/gateway/console/journal-section.ts`, and their test files, all created in Tasks 2 and 5.

- [ ] **Step 2: Regenerate**

Run: `pnpm docs:codebase-map`

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm exec vitest run tests/docs/codebase-map.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add docs/codebase-map.html
git commit -m "Regenerate codebase map for the Journal section"
```

**Note for whoever executes Task 10:** if any fix-pass commits land after this task (e.g. from a final whole-branch review), re-run Steps 1-4 again as the literal last commit before merge — this exact staleness has bitten every one of the three prior steps in this series (#120, #121 Step 4a, and #121 Step 4c) at least once, and #121 Step 4c specifically from a post-plan fix pass landing after this task.

---

### Task 10: Verify, merge, push, close #124

This task is executed by the controller directly (not dispatched to a subagent), matching the pattern used for Steps 4a/4b/4c's final task.

- [ ] **Step 1:** Run the full test suite solo — `pnpm test` — with no other concurrent subagents/test runs active. Compare the failure set against the documented ~8-9 pre-existing environmental baseline (Docker Desktop unavailable, package e2e, AgentTrail fleet byte-eviction timing, real-Git orchestration — see project memory). Spot-check any failure outside that baseline in isolation before treating it as a real regression.
- [ ] **Step 2:** Run `pnpm build`. Must be clean.
- [ ] **Step 3:** Dispatch a final whole-branch code review (most capable available model) covering the full diff from this plan's base commit through Task 9's regeneration commit. Address Critical/Important findings with a fix subagent, re-review, and re-run Task 9's Steps 1-4 if the fix pass touches any mapped file.
- [ ] **Step 4:** Use superpowers:finishing-a-development-branch to merge the branch to `main` and push to `origin`.
- [ ] **Step 5:** `gh issue close 124` with a comment summarizing what shipped and linking the spec/plan.
- [ ] **Step 6:** Update project memory (`project_agent_rail_console_phase1.md` and `MEMORY.md`) to reflect Step 4d shipped, and record any new lessons the final review surfaces — in particular, whether the `databasePath`-optional threading pattern introduced here is worth calling out for the still-unscoped raw-event-browser follow-up.
