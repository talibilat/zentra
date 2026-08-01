# Agent Rail Console, Trail Rebuild Step 1: Events log and inspector

Status: Approved design

Date: 2026-08-01

## Context

Issue #119 ("Agent Rail Console Phase 2, Step 2: Trail rebuild") tracks replacing today's Trail section, which embeds AgentTrail's separate serve-mode Python UI through a full-page iframe (session-cookie handoff in `src/gateway/loopback-gateway.ts`), with native views inside the console shell matching Claude design tool's `Console.dc.html` mockup.

Reading the mockup's actual component logic (not just its markup skeleton) shows its Trail toolbar has four view tabs, not three: Graph, Tree, Swimlane, and Events.
Graph and Tree share a single node-link renderer with two different layout algorithms (radial vs. tree), both already implemented as plain, dependency-free JavaScript inside the mockup itself, ported near-verbatim from AgentTrail's own `web/index.html`.
Swimlane is a per-actor timeline built mostly from CSS positioning.
Events is a filterable flat log with an expandable payload per row.
A right-side inspector panel shows detail for whatever is selected (an event, an agent, or the run itself when nothing is selected), and a bottom scrubber lets the operator move a time horizon backward through the run.

Building all of this in one pass is a large, multi-part engineering effort with very different complexity per view.
This document covers the first and simplest of three sequenced sub-phases:

1. **This spec.** Events log, inspector panel, and the shared Trail chrome (tab bar, filter pills, search, scrubber).
2. Swimlane view. Own spec, own GitHub issue under #119, once this ships.
3. Graph and Tree views (one native node-link renderer, two layouts). Own spec, own GitHub issue under #119, once step 2 ships.

Each later step gets its own GitHub issue, mirroring how #118 spawned #119, #120, and #121.

## Goal

Replace the Trail iframe with a native Events log and inspector that read real AgentTrail data, matching the mockup's visual and interaction design for those two pieces, while the tab bar advertises the full four-tab target with Graph/Tree/Swimlane disabled until their own steps ship.

## Non-goals

- Swimlane, Graph, and Tree views. Their nav tabs render disabled with the same "Phase 2"-style badge treatment `shell.ts` already uses for disabled sidebar items.
- Any warnings-linked inspector content (an agent's "warnings for this agent" cards, or a "Top warnings" panel). Zentra's console has no Warnings section yet; that is issue #120's territory.
- AgentTrail's "Fleet" cross-run comparison view. It is not part of the mockup's Trail section at all.
- Any new mutation command. Every new endpoint in this step is read-only.

## Architecture

### Backend: a new reshaping endpoint

Add `GET /api/v1/zentra/runs/:id/trail` to `src/gateway/loopback-gateway.ts`, alongside the existing `/api/v1/zentra/runs` and `/api/v1/zentra/runs/:id` routes, reusing the same bearer-token and CSRF enforcement, the same `SECURITY_HEADERS`, and the same error-response shape as every other route there.

Server-side, this route calls AgentTrail's existing `/agenttrail/api/v1/runs/:id` (the same data the current iframe already renders, reached the same way the existing proxy already reaches it) and reshapes the response into `{ events: [...], actors: [...] }` for the console's own presentation needs:

- **Elapsed time.** AgentTrail's `run_detail()` already computes `offset_seconds` per event (time since run start). The reshaping layer formats this for display; it does not recompute it.
- **Evidence links.** Each event's `relationships` array (`{ type, event_id }`) becomes the inspector's "evidence links" cards, letting an operator jump from one event to another it references.
- **Actor color and glyph.** AgentTrail's actor records (`id`, `role`, `model`, `status`, `usage`, and so on) carry no display color or glyph. The reshaping layer assigns both deterministically from the actor id (a small hash-to-palette function), reusing the shared design tokens already established in `styles.ts`/`design-tokens.ts`, so the same actor always gets the same color across a session.
- **Payload.** AgentTrail's `_payload_preview()` already redacts and marks evicted/omitted payloads. The reshaping layer passes this through unchanged for display in the inspector's payload block; it performs no additional redaction.
- **Status/failure classification.** Which events count as "failed" (for the "failed only" filter pill and the event row's status rail) is derived from each event's `kind`/`operation` fields via a small, explicit mapping. The exact mapping is implementation detail verified against real captured trace data during TDD, not pinned here.

This reshaping logic lives in its own module so steps 2 and 3 (Swimlane, Graph/Tree) can reuse the same actor/event model instead of re-deriving it from raw AgentTrail JSON three times.

### Frontend: `trail-section.ts` rebuild

Replace the current iframe markup and `applyGatewayChange`-only script with:

- **Tab bar.** Four tabs — Graph, Tree, Swimlane, Events — styled like the mockup. Events is clickable; the other three are disabled with the same badge treatment `shell.ts` uses for disabled sidebar nav items (`<button disabled aria-disabled="true">...<span class="badge">Phase 2</span></button>`), so the console communicates what is coming instead of hiding it.
- **Filter pills.** One pill per actor in the current run, one pill per event-kind prefix (`model.*`, `tool.*`, `change.*`, `verification.*`), and one "failed only" pill, matching the mockup's filter model. Toggling a pill re-filters the visible event list client-side; no new fetch.
- **Search.** The topbar search box added in #118 (`#console-search`, wired to `state.search` but inert until now) becomes functional here: while Trail's Events tab is active, it filters the event list by name, kind, actor, and summary substring match. This resolves the open question the #118 spec deferred ("whether the search box gets wired to filter something... once Trail exists").
- **Scrubber.** A time-horizon slider, defaulting to fully live (all events visible), that trims the visible event list to events at or before the scrubbed offset. A "jump to live" control resets it to the live edge.
- **Event rows.** Each row shows elapsed time, kind, name/summary, and actor, colored per the reshaping layer's palette, with a chevron to expand the row's redacted payload preview inline.
- **Inspector panel.** Shows, in priority order: the selected event's `EVENT` fields block (event id, actor, status, sequence) plus an `EVIDENCE LINKS` block when the event has relationships, plus a `PAYLOAD` block; or, when nothing is selected, a `RUN` summary block (trace id, duration, event count, actor count). Selecting an agent (from Swimlane or Graph, in later steps) is out of scope here since nothing in the Events-only view can select an agent yet.

The existing `applyGatewayChange` degrade/recover handling (`gateway.degraded`, `gateway.backfill_target`, `gateway.recovered`) is preserved unchanged; it continues to show the same status banner, now above the new Events chrome instead of above the iframe, and continues to trigger a refetch of `/api/v1/zentra/runs/:id/trail` on `gateway.recovered` instead of reloading an iframe.

### Live updates

Trail's Events view subscribes to the same `/api/v1/zentra/events` stream every other section already uses and re-fetches `/api/v1/zentra/runs/:id/trail` when the stream signals a change for the active run, the same re-fetch-on-signal pattern Overview and Controls already follow. No new streaming mechanism is introduced.

## Error handling

No new error classes. If the reshaping endpoint's upstream call to AgentTrail fails (process down, timeout, malformed response), it responds `503 { error: "agenttrail_unavailable" }`, the exact string the existing iframe proxy path already uses, so any shared error handling keeps working unchanged. The console shows the same degrade banner it already shows today instead of the event list.

## Security

No change to the trust boundary described in `AGENTS.md` and `SECURITY.md`. The new route is a read-only, reshaped projection of data the operator can already see through the existing iframe. No new subprocess execution, no new file-system access, and no new network egress; it calls the same local AgentTrail address the existing proxy path already calls.

## Testing

Test-driven development, per `AGENTS.md`.

- **Backend:** Vitest tests for the new `/api/v1/zentra/runs/:id/trail` route and its reshaping module, following the pattern in `tests/gateway/*.test.ts` — correct reshaping of a representative AgentTrail `run_detail()` response, `503`/`agenttrail_unavailable` propagation when AgentTrail is down, and bearer/CSRF parity with the existing routes.
- **Frontend:** a new `tests/gateway/console/trail-section.test.ts` asserting the tab bar markup (four tabs, three disabled with the badge), filter-pill construction, and inspector block rendering, following the pattern in `tests/gateway/console/shell.test.ts` and `overview-section.test.ts`.
- **Real-browser e2e:** extend `tests/ui/console-shell.e2e.test.ts` (or `chromium-browser.e2e.test.ts`, whichever already seeds a run with trace events) to assert: the Events tab renders real events from a live seeded run; toggling a filter pill and typing in the topbar search both narrow the visible rows; selecting an event populates the inspector's EVENT/EVIDENCE/PAYLOAD blocks; the degrade banner still renders correctly when AgentTrail is unavailable, proving the chrome restyle did not regress that existing behavior.

## Out of scope

- Swimlane, Graph, and Tree views — each gets its own spec and GitHub issue once this step ships.
- Any warnings-linked inspector content — depends on issue #120's Warnings section existing.
- AgentTrail's Fleet view — not part of Trail in the mockup.
- Any new mutation command.
