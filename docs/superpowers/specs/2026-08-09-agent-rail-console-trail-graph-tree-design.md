# Agent Rail Console Trail Rebuild, Sub-step 3: Graph/Tree view

Status: Approved design (autonomous — see Process note)

Date: 2026-08-09

## Process note

Built without an interactive design-review dialogue, under the same active session goal as #125 (Swimlane). No Claude-design-tool mockup file is reachable in this environment. Unlike Swimlane, a real reference implementation exists: AgentTrail's own `agenttrail/upstream/src/agent_tail/web/index.html` (the vendored Python package's bundled dashboard) has a complete, mature Graph/Tree node-link renderer (`buildForest`/`radialLayout`/`treeLayout`/`renderNodeLink`, roughly lines 1085-1450 of that file) — the original #119 spec called this "transliteration not design work." That held for the pure layout math. It did not hold for the whole feature: the mockup's node rendering also draws live warning badges per node (`warningsForActor`), dims nodes matching a search query, supports pan/zoom/fit-view, "focus subtree," and a dense-mode "show N of M agents" cutoff with client-side status derivation (`actorStatus()`) computed from raw event history. Scoping decisions below explain what ports as-is, what's simplified, and why, so they remain auditable.

## Context

Issue #126 is the last of Trail's three internal sub-steps (see #119; sub-step 1 shipped, sub-step 2 shipped as #125). Trail's tab bar already renders disabled "Graph" and "Tree" buttons. `trail-reshape.ts`'s `TrailEvent`/`TrailActor` still lack fields this view needs: per-event `span_id`/`parent_span_id` (present in the raw payload's `_event_message()`, unused so far) and per-actor `parent_id`/`child_ids` (present in the raw payload's `run_detail()` actor entries, unused so far — `TrailActor` currently has `id`/`role`/`color`/`glyph`/`model`/`status`/`usage` from #125).

## Goal

Enable Graph and Tree as one shared node-link renderer, two layouts (radial vs. hierarchical), showing real actor nodes connected by real parent/child spawn edges, reusing Trail's existing chrome (filter pills, scrubber, topbar search, inspector) rather than duplicating it — matching the precedent set by both #125 and the original #119 sub-step 1.

## Non-goals, and why

- **Live warning badges per node** (`warningsForActor` in the mockup). Requires a `TrailWarning` read model with per-actor, per-time-horizon filtering that doesn't exist in this codebase — the exact same "concept exists only in the vendored Python package with no TS equivalent" boundary #120 already drew for the Warnings/Security/Cost sections (see project memory). Out of scope here for the identical reason.
- **Client-side actor status derivation** (`actorStatus()`, deriving "running"/"done"/"error"/"stalled" from raw event history). Unnecessary — #125 already added `TrailActor.status` sourced directly from AgentTrail's own server-computed `actor.status` field. Reuse it as-is; do not reimplement the derivation.
- **The "message" link overlay** (a second edge type sourced from `run_detail()`'s separate `links`/`unresolved_endpoints` fields, layered over spawn edges in the mockup's Graph view). Requires reshaping a new raw field (`links: {source_actor_id, target_actor_id, type, event_id}[]`) this codebase has never touched. Spawn edges (parent → child, already available via the new `parentId`/`childIds` actor fields) give a genuine, useful hierarchical graph on their own. Message-link overlay is a plausible future extension, not core to a v1.
- **Pan/zoom/fit-view drag interactions.** Neither Events nor Swimlane has pan/zoom (both are plain scrollable containers) — matching that precedent keeps the interaction model consistent across all three enabled Trail views. The layout container is simply wide/tall and scrolls.
- **Dense-mode "show N of M" cutoff and focus-subtree.** Real UX value for very large runs, but added complexity for a v1; every actor renders. Worth revisiting if a real run with dozens of actors proves this necessary.
- **A separate actor-detail inspector panel.** The mockup's node click opens actor-level detail (spawn tree, usage, warnings) — but Trail's existing inspector (`renderTrailInspectorEvent`/`renderTrailInspectorDefault`) is event-scoped, and adding a third inspector mode is a meaningfully separate feature. Instead: clicking a node sets `trailFilterActor` (the exact same actor-filter-pill state Events and Swimlane already read via `trailVisibleEvents()`), so a node click filters every view to that actor's events — a real, useful, and already-shared piece of state, not a new one.

## Architecture

### `trail-reshape.ts`: extend `TrailEvent` and `TrailActor`

```ts
export interface TrailEvent {
  readonly id: string;
  readonly offsetSeconds: number;
  readonly kind: string;
  readonly name: string;
  readonly summary: string;
  readonly actorId: string;
  readonly failed: boolean;
  readonly sequence: number | null;
  readonly evidence: readonly TrailEvidenceLink[];
  readonly payload: unknown;
  readonly spanId: string | null;
  readonly parentSpanId: string | null;
}

export interface TrailActor {
  readonly id: string;
  readonly role: string | null;
  readonly color: string;
  readonly glyph: string;
  readonly model: string | null;
  readonly status: string;
  readonly usage: TrailActorUsage;
  readonly parentId: string | null;
  readonly childIds: readonly string[];
}
```

`reshapeTrail()` reads `event["span_id"]`/`event["parent_span_id"]` (string or `null`) and `actor["parent_id"]` (string or `null`) / `actor["child_ids"]` (string array, defaulting to `[]`, filtered to strings). Purely additive — every existing consumer of `TrailEvent`/`TrailActor` is unaffected.

### `trail-section.ts`: layout + node-link rendering

Ported from the mockup, adapted to this codebase's camelCase field names and existing helper conventions:

- **`buildForest(actors)`**: same algorithm as the mockup's `buildForest` — a `childrenMap`/`roots`/`depth` structure derived from `parentId`/`childIds`, with roots being actors whose `parentId` is either `null` or points at an actor not present in the current actor list (defensive, matches the mockup's `byId.has(...)` guard).
- **`radialLayout(forest)`** / **`treeLayout(forest)`**: ported near-verbatim (pure functions, no DOM, no backend dependency — genuinely "transliteration not design work" for this part, per the original #119 note).
- **Node rendering**: one button per actor at its computed position — circle (regular actor) or rounded-square (depth-0/orchestrator, matching the mockup's visual distinction), using `actor.color`/`actor.glyph` (already computed by `reshapeTrail()`), a status-derived border/glow color reusing the existing `var(--ok)`/`var(--err)`/`var(--warn)` convention (map `actor.status` to one of these three the same way `trailKindColor`-adjacent logic elsewhere in this file already maps strings to the existing palette — do not invent a new color system).
- **Edge rendering**: one SVG layer, one path per `(parentId, id)` pair among currently-positioned actors — straight line for Graph (radial), smooth curve for Tree (matches the mockup's bezier-vs-straight distinction), reusing `var(--line)` for the default edge color.
- **Selection/filtering**: clicking a node toggles `trailFilterActor` exactly like clicking an actor filter pill does today (same toggle-off-if-already-selected behavior) and calls `renderTrailView()` — no new state variable.
- **Tab switching**: extends the `trailActiveView` state #125 introduced (`"events" | "swimlane"`) to a third value `"graph"`/`"tree"` — two views, one shared renderer function parameterized by which layout to use, mirroring the mockup's `selectedView === 'graph' ? radialLayout(...) : treeLayout(...)` branch. Both tabs become enabled (remove `disabled`/`aria-disabled`/the Phase 2 badge from both), completing the tab bar — this is the last of the four tabs.
- **Empty/failure states**: identical wording and placement to Events/Swimlane, for the same three conditions.

### Markup changes

Both Graph and Tree tab buttons lose `disabled`/`aria-disabled="true"`/the trailing badge, matching the exact enabled-button shape used for Events/Swimlane. No other markup structural change — node-link rendering targets the same shared `#trail-events` container.

## Error handling

Identical to Events/Swimlane — no new error paths; Graph/Tree consumes the same `trailEvents`/`trailActors` state already loaded by `loadTrail()`.

## Security

No change to the trust boundary. Purely client-side rendering over data already fetched by the existing route.

## Testing

- `tests/gateway/console/trail-reshape.test.ts` (extend): unit tests for `spanId`/`parentSpanId`/`parentId`/`childIds` mapping, including absence defaults.
- `tests/gateway/console/trail-section.test.ts` (extend): `buildForest`/`radialLayout`/`treeLayout` unit-style tests calling the functions directly with small fixture forests (this file already reads `TRAIL_SCRIPT` as a string for most tests — these layout functions are pure enough to warrant direct execution via a small harness, see Task 2's brief for the exact approach); markup assertions that both tabs are enabled; script assertions that node click sets `trailFilterActor` via the existing pill-toggle pattern, not new state.
- `tests/ui/console-shell.e2e.test.ts` (extend): real-browser case seeding a run with a parent/child actor pair, switching to Graph, asserting two nodes and one edge render, clicking a node, asserting the actor filter pill state updates (e.g. via the existing filtered event count changing) — then switching to Tree and confirming the same data renders in the other layout.
- Codebase-map: re-verify freshness as the literal last commit before merge (no exceptions, per the standing lesson — confirmed again during #125's fix pass that even edit-only changes stale it).

## Out of scope

- Warning badges, message-link overlay, pan/zoom, dense-mode, focus-subtree, actor-detail inspector — see Non-goals above.
- Sequence view — not one of this console's four Trail tabs (the mockup has 5 views; Zentra's `NAV_GROUPS`/tab bar only ever specified Events/Graph/Tree/Swimlane).
