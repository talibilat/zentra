# Agent Rail Console, Phase 2 Step 4d: Journal (maintenance stats)

Status: Approved design

Date: 2026-08-07

## Context

Issue #124 ("Agent Rail Console Phase 2, Step 4d") is the last of four follow-up issues split off #121, which originally scoped Pods, Milestones, GitHub broker, and Journal together.
Steps 4a (Pods), 4b (Milestones), and 4c (GitHub broker) shipped separately.

Unlike the other three, "Journal" was ambiguous: `src/journal/journal.ts`'s `EventJournal` is the raw event-storage interface, not a domain view — there's no `JournalView` the way there's a `PodView` or `MilestoneSummary`.
This needed a scoping decision before design could start.
Two directions exist: a raw event browser (audit-log style, distinct from Trail's structured per-run reasoning trace), or journal-maintenance stats matching the operational concerns the CLI's `journal` command group covers (`archive`, `verify`, `prune-request`, `prune`, `maintain`, `export`, `restore`, `recover`, `inspect-recovery`, `reconcile` — see `src/cli/main.ts`).
The scoping decision: ship maintenance stats first (this step), sequence a raw event browser as a later follow-up, mirroring how Trail split into internal sub-steps rather than separate issues.

Within "maintenance stats," a second scoping question surfaced: `WorkflowSurface` already holds a live `EventJournal` object (in production, a `ProjectingEventJournal` wrapping a `SqliteEventJournal`), which gives free access to the journal's global head position and its one active projection cursor's health (position/lag/replay count) — zero new plumbing, the same "just read `this.journal`" pattern Pods/Milestones/GitHub broker each used.
Separately, the CLI's actual maintenance operations live on `JournalRetentionService` (`src/journal/retention.ts`), which needs to open the raw SQLite file *by path* — archive segment count, retained-through position, and whether a maintenance operation was left interrupted mid-flight are the more operationally interesting "is this journal healthy" signals, but getting them into the console requires threading a new `databasePath` dependency into `WorkflowSurface`.
Decision: include both — retention/recovery health is genuinely what "journal maintenance" means, and the new dependency is a single well-scoped constructor parameter, proportionate to what Milestones (a second route) and GitHub broker (a from-scratch projection) each took on.

## Goal

Wire the Journal nav item to real data: a new `getJournalStatus(journal, databasePath)` read composition in a new `src/journal/journal-status.ts`, a new `metadataSummary()` method on `JournalRetentionService`, a `GET /api/v1/zentra/journal` route backed by a new `WorkflowSurface.getJournalStatus()` method, and a `journal-section.ts` console section rendering a single-panel status dashboard, replacing the disabled "Phase 2" nav entry.

## Non-goals

- Pods, Milestones, GitHub broker — already shipped, tracked in their own issues.
- A raw event browser — sequenced as a later follow-up step per the scoping decision above; out of scope here.
- Any mutation from the console (no triggering archive/prune/maintain/restore/reconcile) — read-only, consistent with every other console surface. `getJournalStatus()` never calls `JournalRetentionService.verify(true)` (which records an audit event) — only the no-argument, non-auditing form of the read paths used.
- A full `verify()`-driven integrity re-check on every console refresh. `verify()` re-reads and re-hashes every archived segment file — appropriate as a one-shot CLI command, not as something polled on every refresh as archives accumulate. `metadataSummary()` (new) exposes the same metadata fields `verify()` touches internally, without the per-segment rescan.
- Trail sub-steps 2/3 — unrelated, tracked separately.

## Architecture

### Backend: `JournalRetentionService.metadataSummary()` in `src/journal/retention.ts`

New method on the existing class, alongside `globalHead()`/`streamHead()`:

```ts
metadataSummary(): {
  readonly globalPosition: number;
  readonly retainedThroughPosition: number;
  readonly archiveHeadPosition: number;
  readonly archiveSegmentCount: number;
  readonly policy: RetentionPolicy;
} {
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

`this.metadata()` (private, existing) is a single bounded DB row read — no archive segment scanning, unlike `verify()`. Read-only; does not open a write transaction or call `this.audit(...)`.

### Backend: `getJournalStatus(journal, databasePath)` in `src/journal/journal-status.ts`

New file — this composes two different domain sources (the live journal object and the retention service), so it does not belong inside `retention.ts` (already 2,554 lines, and this composition is read-side, not retention-internal logic) or `journal.ts` (the generic `EventJournal` interface module, which knows nothing about `ProjectingEventJournal` or retention).

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

export function getJournalStatus(journal: EventJournal, databasePath: string | undefined): JournalStatus {
  const retention = databasePath === undefined ? null : buildRetentionStatus(databasePath);
  const projection = buildProjectionStatus(journal);
  return { retention, projection };
}
```

`buildRetentionStatus(databasePath)` opens `JournalRetentionService.openReadOnly(databasePath)`, calls `.metadataSummary()` and `.inspectRecovery()` (existing method — bounded to at most one in-flight operation's residue check, not a full history scan), and maps the result into the shape above (`recoveryState` is `null` when `inspectRecovery()`'s `outcome` is `"clean"`).

`buildProjectionStatus(journal)` checks `journal instanceof ProjectingEventJournal`; if so, reads `journal.projectionCursorName` (existing public getter) and calls `journal.inspectProjectionCursor(name)` (existing method on `DurablePagedEventJournal`) for `position`/`highWaterPosition`/`lag`/`replayCount`, and `journal.inspectProjectionClaim(name) !== null` for `active`. If the journal is not a `ProjectingEventJournal` (some test/fixture configurations construct `WorkflowSurface` directly against a plain `SqliteEventJournal`), `projection` is `null` — an honest absence, not a fabricated zero, matching the convention Overview set in Phase 2 Step 1 for metrics with no backing data source.

### Backend: `WorkflowSurface` and `LocalWorkflowSurfaceOptions`

`WorkflowSurface`'s constructor gains a new optional trailing parameter, after the existing `projectIdentity?: ProjectIdentity`:

```ts
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

getJournalStatus(): JournalStatus {
  return this.guard(() => getJournalStatus(this.journal, this.databasePath));
}
```

Optional (not required) so existing call sites that construct `WorkflowSurface` without retention concerns are unaffected — `getJournalStatus()` still works, just returns `retention: null`, the same graceful-absence treatment as the projection half.
`LocalWorkflowSurfaceOptions` (`src/surfaces/local-workflow.ts`) gains an optional `databasePath?: string`, threaded through to the `WorkflowSurface` constructor call.
`src/service/start-service.ts` passes `layout.databasePath` (already computed there for `openServiceJournal(layout.databasePath)`, just not currently threaded further) as `databasePath` in the options object it builds for `createLocalWorkflowSurface`.
Test call sites that want real retention data in their assertions (only `workflow-surface.test.ts`, for a `getJournalStatus()` test) pass their existing on-disk `SqliteEventJournal` path; other call sites are unaffected by the new optional parameter.

### Backend: gateway route

```
GET /api/v1/zentra/journal → invoke("getJournalStatus") → 200 JournalStatus
```

`GET`-only, next to the `pods`/`milestones`/`github-broker` GET branches in `routeApi`. No CSRF/origin check (GET-exempt). Same bearer-session auth as every other route. No path parameter, no detail route — `JournalStatus` is already the complete singleton payload.

### Frontend: `src/gateway/console/journal-section.ts`

New file, same `<NAME>_MARKUP`/`<NAME>_SCRIPT` pair. Journal is a project singleton, not a list — this is a single-panel status dashboard, closer to Overview's layout than Pods'/Milestones'/GitHub broker's two-column list+detail. No click-to-select, no second panel, no per-item state.

- **`loadJournalStatus()`**: `request("/api/v1/zentra/journal")`, stores into local state, hooked into the post-auth `refresh()` cycle alongside `pods?.load?.()`/`milestones?.load?.()`/`github?.load?.()`.
- **Retention/recovery card**: rendered only when `status.retention !== null`; curated facts via `field()` — retained-through position, archive head position, archive segment count, retention policy mode — plus a recovery status badge: `label("clean")` when `recoveryOutcome === "clean"`, otherwise a badge built from `recoveryKind`/`recoveryState` (e.g. "Archive interrupted: segment published, manifest missing"). When `status.retention === null`, an inline "Retention status unavailable in this environment." — same honest-absence convention as the projection card below, not a silently-omitted card.
- **Live projection card**: rendered when `status.projection !== null` — cursor name, position, high-water position, lag, replay count, active-claim badge. When `null`, an inline "Projection status unavailable in this environment."
- **Empty/failure state**: if the whole `request()` call fails, inline "Journal status unavailable." in the panel (local `journalLoadFailed` flag) — not the global `status()` banner, matching Pods/Milestones/GitHub broker's convention.
- Registers `window.__consoleSections.journal = {render: renderJournalStatus, load: loadJournalStatus}` — nav id `journal`, matching `shell.ts`'s existing entry `{ id: "journal", label: "Journal", icon: "≣", enabled: false }`, which flips to `enabled: true`.

### Wiring changes to existing files

- **`src/gateway/console/controls-section.ts`**: add `window.__consoleSections.journal?.load?.()` to the existing chain in `refresh()`.
- **`src/gateway/console/shell.ts`**: import `JOURNAL_MARKUP`; flip the `journal` nav item's `enabled` flag to `true`; add `<section class="section" data-section-id="journal">${JOURNAL_MARKUP}</section>`.
- **`src/gateway/console/console-ui.ts`**: import `JOURNAL_SCRIPT` and concatenate it into `CONSOLE_SCRIPT`.

### Recurring regressions, fixed proactively — and codebase-map regen re-verified at the literal last commit

Per the sharpened lesson from Step 4c (GitHub broker): the plan must fix both `tests/ui/cross-surface-acceptance.e2e.test.ts`/`tests/ui/chromium-acceptance.ts` (focus-order bump 16→17, `"button::≣ Journal"` inserted after GitHub broker, before Warning policies) **and** `docs/codebase-map.html` — and the codebase-map regeneration must not just be the plan's last task, but must be re-verified (re-run `pnpm docs:codebase-map` + `tests/docs/codebase-map.test.ts`) as the literal last commit before merge, since Step 4c's own final-review fix pass landed commits *after* its plan's regen task and re-staleified the map a third time.

## Error handling

- Whole-status fetch failure: inline "Journal status unavailable." empty state (local flag), not the global `status()` banner.
- Retention data unavailable (`databasePath` not configured in this environment): inline "Retention status unavailable in this environment." within the retention card's position — the card renders its container but explains the absence rather than fabricating zeros.
- Projection data unavailable (journal isn't a `ProjectingEventJournal`): inline "Projection status unavailable in this environment." within the projection card's position, same treatment.
- No 404 case exists for this route (singleton, no path parameter).

## Security

No change to the trust boundary. Read-only, same bearer-session auth as every other route.
`getJournalStatus()` never calls a mutating retention method (`archive`, `requestPrune`, `prune`, `maintain`, `export`, `restore`, `reconcile`) and calls `verify` nowhere at all — `metadataSummary()` reads already-computed metadata, and `inspectRecovery()` is itself read-only (confirmed by reading its implementation: no `db.transaction`, no `this.audit(...)` call in the "clean" or any "uncertain" branch).
The raw `databasePath` string is a local filesystem path and must never appear in the `JournalStatus` API response — every field in the `retention`/`projection` shapes above is a number, enum, or boolean derived from it, never the path itself.
Loopback-only, single-user session; no new network egress or subprocess execution.

## Testing

Test-driven development, per `AGENTS.md`.

- **`tests/journal/retention.test.ts`** (existing file): add unit tests for `metadataSummary()` — matches `verify()`'s metadata fields without the segment rescan, confirmed by asserting it doesn't touch the filesystem archive segments (e.g. by pointing at a database with a manifest file deliberately deleted, which `verify()` would fail on but `metadataSummary()` would not, since it never reads segment files).
- **`tests/journal/journal-status.test.ts`** (new file): unit tests for `getJournalStatus()`. Cases: `databasePath` undefined → `retention: null`; clean recovery; each of the four `inspectRecovery()` attention states (archive/maintenance/restore/prune, per the four branches in `inspectRecovery()`'s implementation) → non-null `recoveryKind`/`recoveryState`; journal is a `ProjectingEventJournal` with a real cursor → non-null `projection` with correct position/lag/replayCount/active; journal is a plain `SqliteEventJournal` (not wrapped) → `projection: null`.
- **`tests/surfaces/workflow-surface.test.ts`**: test for `getJournalStatus()` threading `databasePath` through to the composed result, and a test confirming `databasePath` omitted still returns a valid `JournalStatus` with `retention: null`.
- **`tests/gateway/loopback-gateway.test.ts`**: route test for `GET /api/v1/zentra/journal` — 200 with the status, 401 without a bearer token.
- **`tests/gateway/console/journal-section.test.ts`** (new): markup/structure assertions matching the established pattern — no self-invocation, fetches the real route, no `innerHTML`, honest unavailable states for both the retention and projection cards, single-panel layout (no second `.workspace[data-columns="2"]` panel).
- **`tests/gateway/console/shell.test.ts`**, **`console-ui.test.ts`**, **`controls-section.test.ts`**: wiring assertions matching the established pattern (nav enabled, `data-screen-label="Journal"` present, script concatenated, refresh hook present).
- **`tests/ui/cross-surface-acceptance.e2e.test.ts`** + **`tests/ui/chromium-acceptance.ts`**: focus-order bump, per Architecture above.
- **`docs/codebase-map.html`**: regenerated as the plan's last task, and re-verified fresh as the literal last commit before merge.
- **`tests/ui/console-shell.e2e.test.ts`**: e2e test that seeds real archive/recovery state directly into the e2e fixture's on-disk journal (via a real `JournalRetentionService` call against the fixture's database, or by seeding an interrupted-operation row directly, matching the fixture's existing direct-seeding conventions) and asserts the console renders it end-to-end.

## Out of scope

- Pods, Milestones, GitHub broker — already shipped.
- A raw event browser — sequenced as a later follow-up step.
- Any mutation capability from the console for journal maintenance.
- A `GET /journal/:id` detail route — singleton, not a list.
