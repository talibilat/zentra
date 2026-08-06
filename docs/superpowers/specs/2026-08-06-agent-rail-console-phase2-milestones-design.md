# Agent Rail Console, Phase 2 Step 4b: Milestones

Status: Approved design

Date: 2026-08-06

## Context

Issue #122 ("Agent Rail Console Phase 2, Step 4b") is the second of three follow-up issues split off #121, which originally scoped Pods, Milestones, GitHub broker, and Journal together.
Step 4a (Pods) shipped separately; see `docs/superpowers/specs/2026-08-04-agent-rail-console-phase2-pods-design.md` for why the four were split.

Unlike Pods, `src/milestones/milestone-registry.ts`'s `list()` and `inspect()` return genuinely different shapes:
`list()` returns `readonly MilestoneSummary[]`, a lightweight 10-field projection (`milestoneId`, `projectId`, `title`, `lifecycle`, `terminalOutcome`, `streamVersion`, `traceId`, `tracePath`, `taskCount`, `result`).
`inspect(milestoneId)` returns `MilestoneRecord | null`, which extends the much richer `MilestoneView` — plan, tasks, historical tasks, writer ownership, revisions, plan history, authority envelope, attention, replanning attention, capability boundary state, release operation, integration branch preparation.
This means Milestones needs both a list route and a separate detail route, mirroring the existing `listRuns`/`getRun` pattern rather than Pods' list-only pattern (where `PodRegistry.list()` already returns full detail per pod).

A related finding: the CLI's existing `milestone status` command runs its `inspect()` result through `publicMilestoneStatus()`, which truncates the response to a handful of fields when the milestone is `terminal` or `paused`-with-attention, and returns the full record otherwise.
This looks like a workaround for the CLI's own JSON-output byte limits (`MAX_WORKFLOW_DETAIL_JSON_BYTES`), not a statement about what's safe or useful to show — the console has no equivalent size constraint.
Decision: the console's detail route does **not** mirror this truncation; it always returns the full `MilestoneRecord`, matching `getRun`'s and `getPod`'s precedent of returning full detail unconditionally.

## Goal

Wire the Milestones nav item to real data: `GET /api/v1/zentra/milestones` and `GET /api/v1/zentra/milestones/:milestoneId` routes backed by new `WorkflowSurface.listMilestones()`/`getMilestone()` methods, and a `milestones-section.ts` console section showing a list of milestones with click-to-fetch detail, replacing the disabled "Phase 2" nav entry.

## Non-goals

- GitHub broker, Journal — separate follow-up issues (#123, #124).
- Any mutation from the console for milestones (register, admit task, replan, etc.) — read-only, consistent with every other console surface.
- Mirroring the CLI's `publicMilestoneStatus()` truncation — see Context above.
- Trail sub-steps 2/3 — unrelated, tracked separately.
- A response-size ceiling on either route, for the same reasoning already accepted for Pods' `GET /pods` (`docs/superpowers/specs/2026-08-04-agent-rail-console-phase2-pods-design.md`'s Non-goals) — acceptable at realistic local-orchestrator milestone counts, revisit if volume grows.

## Architecture

### Backend: `WorkflowSurface` methods

Add to `src/surfaces/workflow-surface.ts`, next to `listRuns()`/`getRun()`/`listPods()`:

```ts
listMilestones(): readonly MilestoneSummary[] {
  return this.guard(() => new MilestoneRegistry(this.journal).list());
}

getMilestone(milestoneId: string): MilestoneRecord | null {
  return this.guard(() => new MilestoneRegistry(this.journal).inspect(milestoneId));
}
```

`MilestoneRegistry` only needs `journal: EventJournal`, already held as `this.journal` — no change to `WorkflowSurface`'s constructor or `local-workflow.ts`'s construction call, same zero-plumbing story as `listPods`. Both `MilestoneRegistry.list()` and `.inspect()` already enforce their own bounding (`assertBoundedProjectionEntries` in `list()`); no new bounding logic needed. Errors normalize through the existing `guard()`/`normalizeSurfaceError()` path.

### Backend: gateway routes

Add to `routeApi` in `src/gateway/loopback-gateway.ts`, next to the `runs`/`pods` GET branches:

```
GET /api/v1/zentra/milestones              → invoke("listMilestones")        → 200 [MilestoneSummary, ...]
GET /api/v1/zentra/milestones/:milestoneId → invoke("getMilestone", id)      → 200 MilestoneRecord | 404 not_found
```

Both `GET`-only, so no CSRF/origin check applies (those only gate `mutation` requests per the existing check). Auth is the existing bearer-session check shared by every route. The detail route follows the exact structural pattern of the existing `runs/:runId` branch (`segments[0] === "milestones" && segments.length === 2`).

### Frontend: `src/gateway/console/milestones-section.ts`

New file, same `<NAME>_MARKUP`/`<NAME>_SCRIPT` export pair as every other section, reusing Pods' `.workspace[data-columns="2"]` two-panel CSS variant (list + detail) rather than reinventing it.

- **List panel**: cards showing title (bold, primary text), milestoneId (meta line), lifecycle badge, task count — styled with the same `.run-card` class Pods reuses from Controls.
- **`loadMilestones()`**: `request("/api/v1/zentra/milestones")`, stores into local `milestonesState`, hooked into the post-auth `refresh()` cycle exactly like `loadPods` (own async fetch, not self-invoked at script load, to avoid the pre-auth race).
- **`selectMilestone(id)`**: async, `request("/api/v1/zentra/milestones/"+encodeURIComponent(id))`, stores the result, re-renders the detail panel. This is the one real structural difference from Pods: since `list()` only returns `MilestoneSummary`, clicking a card needs an actual network fetch — mirrors **Controls' `selectRun`** pattern, not Pods' pure-client-side-selection.
- **Detail panel**: curated top-level facts via the shared `field()` helper (Milestone, Project, Title, Lifecycle, Terminal outcome, Tasks, Trace ID, Trace path), then the rich nested structures via `appendJson()` blocks — the same "curate the summary, dump the structure" pattern Controls already uses for run detail: Plan, Tasks, Historical tasks, Writer ownership, Revisions, Attention, Replanning attention, Authority envelope, Result, Release operation.
- **Empty/failure states**: list — "No milestones yet." (no data) / "Milestones unavailable." (load failed), same pattern as Pods. Detail — "Select a milestone to inspect its plan, tasks, and history." (nothing selected) / "Milestone detail unavailable." (fetch failed) — both inline in the detail panel, not the global `status()` banner, matching Trail's and Pods' established convention.
- Registers `window.__consoleSections.milestones = {render: renderMilestones, load: loadMilestones}`.

### Wiring changes to existing files

- **`src/gateway/console/controls-section.ts`**: add `window.__consoleSections.milestones?.load?.()` to the existing chain of post-refresh calls in `refresh()`, alongside the `pods?.load?.()` call added in Step 4a.
- **`src/gateway/console/shell.ts`**: import `MILESTONES_MARKUP`/`MILESTONES_SCRIPT`; flip the `milestones` nav item's `enabled` flag to `true`; add `<section class="section" data-section-id="milestones">${MILESTONES_MARKUP}</section>`.
- **`src/gateway/console/console-ui.ts`**: import `MILESTONES_SCRIPT` and concatenate it into `CONSOLE_SCRIPT`.

### Two recurring regressions to fix as part of this work, not discover afterward

Both of these hit this project twice already (once when #120 enabled six nav items, again when #121 Step 4a enabled Pods) — see `project_agent_rail_console_phase1` memory. This step's implementation plan should include them as explicit tasks, not leave them for a whole-branch review to catch:

- Enabling the `milestones` nav item shifts the keyboard Tab order by one. `tests/ui/cross-surface-acceptance.e2e.test.ts`'s hardcoded `focusOrder.slice(0, N)` assertion and `tests/ui/chromium-acceptance.ts`'s matching capture-loop bound both need `N` bumped by 1, with `"button::⊕ Milestones"` inserted into the expected array in nav order (right after `"button::⬢ Pods"`, since Pods is now enabled and Milestones sits immediately after it in `shell.ts`'s `NAV_GROUPS` ZENTRA group — GitHub broker and Journal remain disabled and stay out of the tab order).
- Adding `milestones-section.ts` and its test file requires regenerating `docs/codebase-map.html` via `pnpm docs:codebase-map`.

## Error handling

- Empty milestone list: "No milestones yet." empty state.
- `listMilestones()` failure: inline "Milestones unavailable." in the list panel (local `milestonesLoadFailed` flag, mirrors `podsLoadFailed`/`trailLoadFailed`), not the `status()` banner.
- No milestone selected: "Select a milestone to inspect its plan, tasks, and history." in the detail panel.
- `getMilestone()` failure (transient error, or a 404 if a milestone vanished between the list snapshot and the click — not expected in practice since milestones aren't deleted, but handled defensively): inline "Milestone detail unavailable." in the detail panel, not the `status()` banner.

## Security

No change to the trust boundary. Read-only, same bearer-session auth as every other route. `MilestoneRecord`'s nested structures (plan, tasks, authority envelope) were checked for sensitive fields — they carry task descriptions, file paths, model/role identifiers, and digests, no credentials or tokens, consistent with what's already surfaced elsewhere in the console. Loopback-only, single-user session; no new network egress or subprocess execution.

One caveat on "read-only": `getMilestone()`'s underlying `MilestoneRegistry.inspect()` can, in one specific state — a milestone paused at a capability boundary whose task head has since moved — append a `milestone.capability_boundary_resolved` self-heal event to the journal via `reconcileCapabilityTaskProjection()` as a side effect of the read. This is pre-existing `MilestoneRegistry` behavior (the CLI's `milestone status` command already exercises the same method) and not something introduced by this console surface; the write is bounded and idempotent, a convergent self-heal already accepted elsewhere. `listMilestones()` has no such reconciliation call and remains genuinely pure-read.

## Testing

Test-driven development, per `AGENTS.md`.

- **`tests/surfaces/workflow-surface.test.ts`**: unit tests for `listMilestones()` and `getMilestone()` — zero/one/multiple milestones, a milestone with plan/tasks/writer ownership/attention populated, `getMilestone()` returning `null` for an unknown id.
- **`tests/gateway/loopback-gateway.test.ts`**: route tests for both `GET /api/v1/zentra/milestones` and `GET /api/v1/zentra/milestones/:id` — 200 with data, 401 without a bearer token, 404 for an unknown id, empty-array case for the list route.
- **`tests/gateway/console/milestones-section.test.ts`** (new): markup/structure assertions following the pattern in `pods-section.test.ts` — confirms no self-invocation, confirms both routes are actually fetched (list on load, detail on select), confirms `data-screen-label="Milestones"`.
- **`tests/gateway/console/shell.test.ts`**: flip the `milestones` nav assertion from disabled to enabled.
- **`tests/gateway/console/console-ui.test.ts`**: `data-screen-label="Milestones"` marker present in composed HTML + a dedicated test confirming `MILESTONES_SCRIPT` is concatenated into `CONSOLE_SCRIPT` (mirroring the equivalent Pods test added during Step 4a's final review).
- **`tests/gateway/console/controls-section.test.ts`**: assert `CONTROLS_SCRIPT` contains `window.__consoleSections.milestones?.load?.()`.
- **`tests/ui/cross-surface-acceptance.e2e.test.ts`** + **`tests/ui/chromium-acceptance.ts`**: focus-order assertion and capture-loop bound updated together, per the "recurring regressions" note above.
- **`docs/codebase-map.html`**: regenerated via `pnpm docs:codebase-map` after adding the new files.
- **`tests/ui/console-shell.e2e.test.ts`**: extend with a test that registers a milestone in the e2e's test journal, clicks the Milestones nav item, clicks a milestone card, and asserts real plan/task detail renders in the detail panel — mirroring the Pods e2e test.

## Out of scope

- GitHub broker, Journal — future issues (#123, #124).
- Any mutation capability from the console for milestones.
- CLI-style lifecycle-dependent response truncation — see Context/Non-goals above.
