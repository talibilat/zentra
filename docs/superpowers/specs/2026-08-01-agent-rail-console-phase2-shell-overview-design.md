# Agent Rail Console, Phase 2 Step 1: shell restyle and real Overview

## Context

Claude's design tool produced `Console.dc.html`, a full visual redesign of the Agent Rail Console covering all 12 nav sections (Controls stays separate).
It renders through Claude's own "dc-runtime" (`support.js`), which lazy-loads React, ReactDOM, and Babel from `unpkg.com` at page load.
Zentra's real console is a single hash-pinned inline script with zero external network calls, by design, for a local trusted-project tool (`SECURITY.md`).
All data in the mockup comes from one hardcoded `DATA.runs['demo-run']` object embedded in its component script. Nothing in it is live.

This is the design for the first of four sequenced sub-projects that bring the mockup's visuals into the real console:

1. **This spec.** Shell chrome restyle (nav, topbar) and a real-data Overview section.
2. Trail rebuild: native graph/swimlane/event-log views replacing today's AgentTrail iframe, plus a new endpoint exposing per-run events and actors.
3. Warnings, Security, Cost, Compare runs, Imports, Warning policies: visually complete, wired to hardcoded data matching the mockup, since no backend for any of these concepts exists in this codebase (only in the vendored, separately-served Python `agent_tail` package).
4. Pods, Milestones, GitHub broker, Journal: new read-only routes over the existing internal registries (`pod-registry.ts`, `milestone-registry.ts`, `github-broker.ts`, `journal.ts`), wired for real.

Each later phase gets its own spec once this one ships.

## Goal

Match `Console.dc.html`'s sidebar, topbar, and Overview section pixel-for-pixel, implemented in Zentra's existing framework-free console pattern (no CDN dependency), with Overview showing real run data everywhere real data exists and an honest "not yet available" placeholder everywhere it doesn't.

## Non-goals

- Trail, Warnings, Security, Cost, Compare, Imports, Pods, Milestones, GitHub broker, and Warning policies sections are out of scope. Their nav entries stay disabled with the existing "Phase 2" badge treatment, just restyled to the mockup's icons and grouping.
- No new backend endpoints. Overview reads only what `controls-section.ts` already fetches (`/api/v1/zentra/runs`, `/api/v1/zentra/runs/:id`).
- No change to Controls' own markup, behavior, or its left-column run list.

## Current state

`src/gateway/console/shell.ts` already defines the correct 12-item nav structure and grouping (`OPERATE` / `OBSERVE` / `ANALYZE` / `ZENTRA` / `CONFIG`), confirmed by the existing test `tests/gateway/console/shell.test.ts`.
Controls, Overview, and Trail are enabled; the other 9 are disabled with a "Phase 2" badge.
What's missing is the mockup's visual polish: nav icons, spacing, active-state styling, group label treatment, and a topbar (run switcher, search box, live badge) that doesn't exist yet.
`overview-section.ts` is 21 lines: a heading, a state badge, and a flat list of pending attention items. No metrics tiles, no outcome panel, no narrative timeline.

All three files (`shell.ts`, `controls-section.ts`, `overview-section.ts`, plus the not-yet-built other sections) are concatenated into one IIFE by `console-ui.ts` and share one JS scope. `overview-section.ts` already reads `state`, `currentRun()`, `value()`, and `label()` from `controls-section.ts` this way. The new topbar's run switcher reuses this same mechanism instead of introducing a second source of truth for the run list.

## Design

### Nav restyle

Update `renderNav()` in `shell.ts` to emit the mockup's icon glyphs (`◉ ⬡ △ ⛨ ◔ ⑂ ⇥ ⬢ ⊕ ⎇ ≣ ⚙`) and match its spacing, active-state background, and group-label typography. The enabled/disabled logic and the three enabled ids (`controls`, `overview`, `trail`) don't change. Disabled items keep the existing badge, restyled to the mockup's badge chip (rounded, `--warn` background).

### Topbar

New shared chrome above `<div class="content">`, rendered once, visible regardless of active section (matches the mockup, where the header sits outside the per-section `sc-if` blocks):

- **Run switcher**: a button showing the current run's title and state dot, opening a dropdown ("RUNS ON THIS MACHINE") listing `state.runs`. Clicking a row calls the existing `selectRun(id)` from `controls-section.ts`. No new fetch; this is a second view onto data Controls already loads.
- **Search box**: rendered per the mockup's styling, wired to a `state.search` field for forward compatibility, but inert. It has nothing to filter until Trail (phase 2) exists. Documented in code as a placeholder, not silently doing nothing without explanation.
- **Live badge**: shows connection state, reusing `state.connected` already tracked by `controls-section.ts`'s `connect()` loop.

### Overview section rebuild

Rebuilding `overview-section.ts` to match the mockup's layout: header (title, state badge), metrics tile row, two-column body (narrative + outcome/warnings sidebar).

**Real, wired to existing data:**
- Header title and state badge: same source as today (`value(run, ["title","goal","summary"])`, lifecycle state).
- "What happened" narrative: built from `state.selected.attention` (pending) and `state.history` (resolved decisions), sorted chronologically, richer than today's flat list but same source data. Each row is inert (no jump-to-Trail-event action) since there's no Trail event view to jump to yet.
- "Observed outcome" panel: lifecycle state, terminal outcome, readiness, and approval state, all already present in `state.selected` per `controls-section.ts`'s existing `renderRun()`.

**Honest placeholder, no fabricated numbers:**
- The five metric tiles (Agents, Events, Tokens, Cost, Warnings): render as `—` with a small "available in a later phase" caption instead of a mockup-matching number. Confirmed with the user over faking the mockup's demo figures (`48.2k tok`, `$0.84`), since this is a real dashboard, not a demo.
- "Top warnings" panel: renders an explicit "Warning triage lands in a later phase" empty state rather than the mockup's fake warning cards.

### Error handling

No new network calls, so no new failure modes. The topbar run switcher and Overview both read from state that `controls-section.ts`'s existing `refresh()` / `selectRun()` already populate and already handle fetch failures for (via `status()` and the existing try/catch in `submitRun`/`selectRun`). Overview continues using the existing `value()`/`label()` fallback helpers, which already degrade gracefully on missing fields.

### Testing

Extend the existing suites rather than add new ones:
- `tests/gateway/console/shell.test.ts`: add assertions for the new nav icon glyphs and topbar markup (run switcher, search box, live badge present in `SHELL_MARKUP`).
- `tests/gateway/console/console-ui.test.ts`: verify the concatenated script still exposes `window.__consoleSections.overview.render` and that the topbar's run-switcher click path calls the existing `selectRun`.
- `tests/ui/console-shell.e2e.test.ts`: extend the real-journal Chromium fixture to assert Overview renders real narrative/outcome data for a seeded run, and that the five metric tiles show the placeholder state, not fabricated numbers.

## Open questions carried into later phases

- Whether the search box gets wired to filter something in Overview too, once Trail (phase 2) exists, or stays Trail-only. Deferred to the phase 2 spec.
- Exact layout for the "Top warnings" panel once phase 3 lands real hardcoded data. Deferred to the phase 3 spec.
