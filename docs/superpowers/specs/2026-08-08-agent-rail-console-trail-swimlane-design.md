# Agent Rail Console Trail Rebuild, Sub-step 2: Swimlane view

Status: Approved design (autonomous — see Process note)

Date: 2026-08-08

## Process note

This spec was produced without an interactive design-review dialogue with the user. The user set a session goal ("open the required tickets and continue working until phase two is fully implemented") that explicitly directs continuous autonomous progress rather than per-step approval. Design decisions below that would normally go through `AskUserQuestion` are instead made directly, with rationale recorded inline, so they remain auditable and reversible if the user disagrees on review. No Claude-design-tool mockup file (`Console.dc.html`/`support.js`) is reachable from this environment — this design is derived from the existing Trail Events view's established conventions and standard swimlane/timeline visualization semantics, not transcribed from a mockup the way sub-step 1 was.

## Context

Issue #125 is the third of Trail's three internal sub-steps (see #119, closed with sub-step 1 shipped and sub-steps 2/3 explicitly deferred). Trail's tab bar already renders a disabled "Swimlane" button (`src/gateway/console/trail-section.ts:9`) with the same "Phase 2" badge treatment used elsewhere in the sidebar.

`trail-reshape.ts`'s `TrailActor` interface (`id`, `role`, `color`, `glyph`) deliberately omits fields Swimlane needs. The raw AgentTrail `run_detail()` payload (`agenttrail/upstream/src/agent_tail/serve.py:513-532`) already includes, per actor: `model` (string or null, via `_actor_model()`), `status` (string), and `usage` (`{input_tokens, output_tokens, total_tokens, cost_usd}`, each `{available: boolean, value: number | null}`, via `_usage_summary()`). No backend/AgentTrail change is needed — this is purely a reshape-layer extension plus new frontend rendering.

## Goal

A native Swimlane view: one horizontal lane per actor, events plotted as markers along a shared time axis, reusing every piece of chrome the Events view already built (tab bar, filter pills, scrubber, topbar search, inspector panel) rather than duplicating it.

## Non-goals

- Graph/Tree view — tracked separately in #126.
- Any backend/AgentTrail change — all needed data already exists in the raw payload.
- A new inspector — clicking a Swimlane marker reuses the exact same `renderTrailInspectorEvent` the Events view already uses.

## Architecture

### `trail-reshape.ts`: extend `TrailActor`

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

`reshapeTrail()`'s actor-mapping loop reads `actor["model"]` (string or `null`), `actor["status"]` (string, default `"unknown"`), and `actor["usage"]` (object, each of the four metrics mapped from the raw snake_case keys to the fields above, defaulting to `{available: false, value: null}` if a key is missing — matches the existing "honest absence" convention this project uses everywhere else). This is purely additive to `TrailActor`; the Events view's existing consumption of `id`/`role`/`color`/`glyph` is unaffected.

### `trail-section.ts`: Swimlane rendering

- **Lane order:** actors sorted by their earliest event's `offsetSeconds` (first-appearance order) — the natural reading order for a timeline, and stable across re-renders since it derives from data, not insertion order.
- **Lane header:** actor glyph/color badge (existing), actor id, role (if present), a status badge (`label(actor.status)` reusing the existing `label()`-style helper), and model name (if non-null) — matches the fields the original Trail deferral note called out as needed.
- **Lane track:** one horizontal track per actor; event markers (small circles, reusing the existing failed/ok color convention — `var(--err)`/`var(--ok)`, the same colors the Events view's row-rail already uses) positioned left-to-right by `offsetSeconds` scaled against `trailMaxOffset()` (the full run duration), not the scrubbed horizon (`trailMaxOffset() × trailScrubT`). **Revised during implementation review:** scaling against the live horizon would make every marker's absolute position shift as the scrubber moves, sliding markers out from under the cursor mid-drag — scaling against the fixed run duration keeps each marker's position stable and lets the visible portion of the track (left of the current scrub position) simply grow as the horizon advances, matching how a real timeline scrubber should feel. `trailVisibleEvents()`'s horizon filter still determines *which* events appear at all — Swimlane obeys the same scrubber-driven visibility, just not scrubber-driven marker position.
- **Filtering:** Swimlane renders from the exact same `trailVisibleEvents()` array the Events view already computes (actor filter pill, kind filter pill, failed-only pill, topbar search substring match, scrubber horizon) — grouped by `actorId` instead of listed linearly. No new filter state, no duplicated filtering logic.
- **Selection:** clicking a marker sets `trailSelectedEvent` (the same module-level variable the Events view uses) and calls `renderTrailView()` — the inspector panel updates identically regardless of which view (Events or Swimlane) made the selection. A selected marker gets a visible ring/border, mirroring the Events view's selected-row treatment.
- **Empty/failure states:** identical wording to the Events view ("Select a run to see its trail." / "Trace evidence unavailable." / "No events match the current filters.") for the same three conditions, rendered once above the lane area rather than per-lane.
- **Tab switching:** `data-trail-view="swimlane"` becomes enabled (remove `disabled`/`aria-disabled`/the "Phase 2" badge, matching exactly how sub-step 1 enabled "Events" originally — see `trail-section.ts:10` for the enabled-button markup shape to copy). A new `trailActiveView` state variable (default `"events"`) tracks which of Events/Swimlane is showing; clicking a tab button sets it and calls `renderTrailView()`, which now renders either the events list or the swimlane lanes into the shared `#trail-events` container depending on `trailActiveView` (Graph/Tree stay disabled, unaffected).

### Markup changes

`TRAIL_MARKUP`'s Swimlane tab button (`trail-section.ts:9`) loses `disabled`/`aria-disabled="true"`/the trailing `<span class="badge">Phase 2</span>`, matching the exact enabled-button shape already used for the Events tab (`trail-section.ts:10`). No other markup structural change — the swimlane lanes render into the existing `#trail-events` container (same container the Events list already uses), keeping the inspector/scrubber/filter-pill chrome shared rather than duplicated per view.

## Error handling

Identical to the Events view — no new error paths, since Swimlane consumes the exact same `trailEvents`/`trailActors` state the Events view already loads via `loadTrail()`.

## Security

No change to the trust boundary. Purely a client-side reshape/render addition over data already fetched by the existing `GET /api/v1/zentra/runs/:id/trail` route.

## Testing

- `tests/gateway/console/trail-reshape.test.ts` (existing file — extend): unit tests for the extended `TrailActor` mapping — model present/null, each usage metric present/absent, status default.
- `tests/gateway/console/trail-section.test.ts` (existing file — extend): markup assertions that the Swimlane tab is no longer disabled: script-string assertions for lane-grouping logic, marker click wiring, and that Swimlane reuses `trailVisibleEvents()`/`renderTrailInspectorEvent` rather than duplicating filtering/inspector logic.
- `tests/ui/console-shell.e2e.test.ts` (existing file — extend): a real-browser e2e case seeding a multi-actor run, switching to Swimlane, asserting lanes render per actor and clicking a marker opens the same inspector the Events view uses.
- Codebase-map: no new files in this step (only two existing files change), but re-verify freshness as the literal last commit before merge per the standing lesson from #123/#124 — an edit-only fix can still stale the map.

## Out of scope

- Graph/Tree — #126.
- Any AgentTrail/backend change.
