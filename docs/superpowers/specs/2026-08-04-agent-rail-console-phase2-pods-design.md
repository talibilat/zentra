# Agent Rail Console, Phase 2 Step 4a: Pods

Status: Approved design

Date: 2026-08-04

## Context

Issue #121 ("Agent Rail Console Phase 2, Step 4") originally scoped four nav sections together: Pods, Milestones, GitHub broker, Journal.
Unlike Step 3's six sections (#120), these four each have a real backend registry already (`src/pods/pod-registry.ts`, `src/milestones/milestone-registry.ts`, `src/capsule/github-broker.ts`, `src/journal/journal.ts`), but they are uneven in how ready that backend is to expose over HTTP:

- **Pods** and **Milestones** already have clean `list()`/`inspect()` read methods returning full projections.
- **GitHub broker** has no listing method at all — `GitHubEffectBroker` only appends grant/push/PR events to a per-grant journal stream. A "list recent broker activity" view needs a new read projection built from scratch, scanning `capsule.github_*` events across streams (the pattern `listRunsProjection()` already uses for `run.accepted`/`workflow.run_submitted`).
- **Journal** is ambiguous. Issue #121 names `journal.ts`, which is the raw event-storage interface, not a domain view. It could mean a raw event browser or journal-maintenance stats (matching the CLI's `journal status`/`journal list` commands) — an open question, not a build-ready scope.

This unevenness mirrors what forced Trail's step (#119) to split into 3 internal sub-steps once its actual complexity surfaced.
Rather than build unevenly-scoped work in one pass, this spec covers **Pods only** — the cleanest, lowest-risk slice — as Step 4a.
Milestones, GitHub broker, and Journal become their own follow-up issues once #121 closes, each getting its own brainstorm → design → plan cycle when picked up, per this project's standard workflow.

## Goal

Wire the Pods nav item to real data: a `GET /api/v1/zentra/pods` route backed by a new `WorkflowSurface.listPods()` method, and a `pods-section.ts` console section showing a list of registered pods with click-to-select detail, replacing the disabled "Phase 2" nav entry.

## Non-goals

- Milestones, GitHub broker, Journal — separate follow-up issues, opened once this ships.
- Any mutation from the console for pods (register, admit, start, cancel, etc.) — read-only, consistent with every other console surface.
- A `GET /pods/:podId` detail route. `PodRegistry.list()` already calls `inspect()` per pod internally, so the list response already contains full `PodView` detail for every pod — a separate detail fetch would just refetch data the list call already returned. Add it later only if something needs a single pod without the full list (e.g. a deep link).
- Trail sub-steps 2/3 — unrelated, tracked separately.
- A response-size ceiling on `GET /pods`. Unlike `sourceTextResult()`, this route returns the full `PodView[]` with no truncation. Acceptable at realistic local-orchestrator pod counts, but a known limitation worth revisiting if pod volume grows.

## Architecture

### Backend: `WorkflowSurface.listPods()`

Add to `src/surfaces/workflow-surface.ts`, next to `listRuns()`/`getRun()`:

```ts
listPods(): readonly PodView[] {
  return this.guard(() => new PodRegistry(this.journal).list());
}
```

`PodRegistry` only needs `journal: EventJournal`, which `WorkflowSurface` already holds as `this.journal` — no change to `WorkflowSurface`'s constructor, `LocalWorkflowSurfaceOptions`, or `local-workflow.ts`'s construction call. `PodRegistry.list()` already enforces `assertBoundedProjectionEntries`, so no new bounding logic is needed. Errors normalize through the existing `guard()`/`normalizeSurfaceError()` path, same as every other `WorkflowSurface` method.

### Backend: gateway route

Add to `routeApi` in `src/gateway/loopback-gateway.ts`, next to the `runs` GET branch:

```
GET /api/v1/zentra/pods → invoke("listPods") → 200 [PodView, ...]
```

`GET`-only, so no CSRF/origin check applies (those only gate `mutation` requests per the existing check). Auth is the existing bearer-session check shared by every route.

### Frontend: `src/gateway/console/pods-section.ts`

New file, same `<NAME>_MARKUP`/`<NAME>_SCRIPT` export pair as every other section. Interaction pattern mirrors Controls' run-list + detail (not Cost/Warnings' flat table), because pods are structurally the same shape as runs: a list of durable entities, each with sub-state worth drilling into.

- `loadPods()`: calls `request("/api/v1/zentra/pods")`, stores the result in a local `podsState`, calls `renderPods()`. Follows **Trail's** `load` pattern (own async fetch, hooked into the post-auth refresh cycle), not Cost/Warnings' self-invoking-at-script-load pattern — Pods needs a real authenticated fetch, and self-invoking at load would race the session handoff in `shell.ts`'s `handoff()` (fire before `state.bearer` is set, fail with 401).
- `renderPods()`: left column of pod cards (podId, lifecycle badge, revision) styled like `renderRuns()`'s `.run-card` markup; clicking a card selects it and renders detail on the right — charter tasks, assignments table, checkpoints, evidence, attention, and cancellation/reconciliation state when present. All from the already-fetched full `PodView`, no further network call.
- Registers `window.__consoleSections.pods = {render: renderPods, load: loadPods}`.
- Empty state ("No pods yet.") follows the same pattern `renderRuns()` uses for zero runs.

### Wiring changes to existing files

- **`src/gateway/console/controls-section.ts`**: add `window.__consoleSections.pods?.load?.()` to the existing chain of post-refresh calls in `refresh()` (next to `overview?.render?.()`, `shell?.render?.()`, `trail?.load?.()`) — the established extension point every prior real-data section already hooks into.
- **`src/gateway/console/shell.ts`**: import `PODS_MARKUP`/`PODS_SCRIPT`; flip the `pods` nav item's `enabled` flag to `true` (drops the "Phase 2" badge); add `<section class="section" data-section-id="pods">${PODS_MARKUP}</section>` alongside the other section wrappers.
- **`src/gateway/console/console-ui.ts`**: import `PODS_SCRIPT` and concatenate it into `CONSOLE_SCRIPT`.

## Error handling

- Empty pod list: "No pods yet." empty state, same convention as `renderRuns()`.
- `listPods()` failure (500 `internal`, or any other `WorkflowSurfaceError` code): `loadPods()`'s `catch` sets a local `podsLoadFailed` flag (mirroring Trail's `trailLoadFailed`) and clears `podsState`, rather than raising through the shared `status()` banner. `renderPodsList()` then renders an inline "Pods unavailable." empty-state message in place of the list, same pattern as Trail's "Trace evidence unavailable." No new error UI beyond that inline message.
- No 404 case exists for this route (list-only, no `:podId` param).

## Security

No change to the trust boundary. Read-only, same bearer-session auth as every other route. `PodLease`/`PodWorkspaceLease` (returned as part of `PodView`) were checked for sensitive fields — they carry filesystem paths, git branches, and commit SHAs, no credentials or tokens — consistent with paths already surfaced elsewhere in the console (Cost, Trail). This is a loopback-only, single-user session; no new network egress or subprocess execution.

## Testing

Test-driven development, per `AGENTS.md`.

- **`tests/surfaces/workflow-surface.test.ts`**: unit tests for `listPods()` against journal fixtures — zero pods, one pod, multiple pods, and a pod with checkpoints/assignments/attention populated, asserting the returned shape matches `PodView`.
- **`tests/gateway/loopback-gateway.test.ts`**: route test for `GET /api/v1/zentra/pods` — 200 with the list, 401 without a bearer token, empty-array case.
- **`tests/gateway/console/pods-section.test.ts`** (new): markup/structure assertions following the pattern in `overview-section.test.ts` and `trail-section.test.ts`.
- **`tests/gateway/console/shell.test.ts`**: update the existing `pods` nav-rendering assertion from disabled-with-badge to enabled.
- **`tests/gateway/console/console-ui.test.ts`**: confirm the concatenated script still parses under the `node:vm` syntax guard, and that `pods-section.ts`'s `data-screen-label` is present in the composed HTML.
- **`tests/ui/console-shell.e2e.test.ts`**: extend with a test that registers a pod in the e2e's test journal, clicks the Pods nav item, asserts it renders (no longer disabled), and that clicking a pod card renders its detail.

## Out of scope

- Milestones, GitHub broker, Journal — future issues.
- Any mutation capability from the console for pods.
- `GET /pods/:podId` — add only if a real need for single-pod fetch without the list arises.
