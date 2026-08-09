# Agent Rail Console Phase 2, Step 4e: Journal raw event browser

Status: Approved design (autonomous — see Process note)

Date: 2026-08-10

## Process note

Built without an interactive design-review dialogue with the user, under the same active session goal as #125/#126. Design decisions below that would normally go through `AskUserQuestion` are made directly, with rationale recorded inline, so they remain auditable and reversible on review.

## Context

Issue #127 is the deliberately-deferred second half of #124's "Journal" scope: #124 shipped `getJournalStatus()`, a maintenance/health dashboard (retention/archive/recovery state, live projection-cursor health) — it never exposes the underlying event stream itself. This step is a raw event browser: audit-log style access to the durable `EventJournal`'s full event history across every stream, distinct from Trail (scoped to one run's AgentTrail evidence) and distinct from #124's status dashboard (aggregated health, not individual events).

`src/journal/journal.ts` already provides the read primitives (`iterateAllEvents`, `readAllPageCompatible`, `StoredEvent`) — no domain projection exists yet for browsing/filtering/paging raw events for console consumption. `StoredEvent` (`src/contracts/event.ts`) is already camelCase and console-appropriate: `eventId`, `streamId`, `type`, `payload`, `causationId`, `correlationId`, `streamVersion`, `globalPosition`, `recordedAt`.

**Architecturally new territory for this console**: every prior section loads its full bounded dataset in one request (a run's events, the pod/milestone/broker-activity list, journal status). The full journal has no such bound — it grows indefinitely over the life of the project. This is the first section that needs real pagination, not client-side filtering over an already-fully-loaded list.

## Goal

A read-only, paged, filterable browser over every event in the durable journal, added as a second view within the existing Journal nav item (alongside #124's status dashboard), reusing the console's established list+detail visual language.

## Non-goals

- Journal maintenance stats — already shipped in #124, unaffected by this step.
- Any mutation from the console.
- Trail's own per-run event view — already shipped (#119/#125/#126), unrelated scope.
- Full-text search across event payloads — filtering here is limited to stream-id prefix and event-type prefix (see Architecture); a payload search would need its own indexing strategy and is a plausible future step, not this one.

## Architecture

### Backend: `listJournalEvents(journal, options)` in a new `src/journal/journal-events.ts`

```ts
export interface JournalEventPage {
  readonly events: readonly StoredEvent[];
  readonly nextPosition: number;
  readonly hasMore: boolean;
}

export interface JournalEventQuery {
  readonly afterPosition?: number;
  readonly streamPrefix?: string;
  readonly typePrefix?: string;
  readonly limit?: number;
}

export function listJournalEvents(journal: EventJournal, query: JournalEventQuery): JournalEventPage
```

**Pagination and filtering, combined carefully**: the journal can be arbitrarily large, and a filter (e.g. a rare event type) can be arbitrarily sparse within it — an unbounded "keep scanning until `limit` matches are found" loop would be an unbounded-latency request. Instead, each call scans a **bounded window of raw events** (reusing `iterateAllEvents`'s existing paging under the hood, capped at 1,000 raw events per call — the same `CONSUMER_PAGE_LIMITS.maxEvents` bound `journal.ts` already uses elsewhere), collects up to `limit` (default 50, capped at 200) filtered matches within that window, and returns `nextPosition`/`hasMore` reflecting **where the raw scan stopped**, not how many matches were found. Consequence, documented explicitly because it's a real UX case, not an edge case to hide: a page can legitimately return zero matching events with `hasMore: true` (the window scanned found no matches in that range but more of the journal remains unscanned) — the console must render this as "no matching events in this range" with a way to keep scanning, not as "end of results."

Filtering: `streamPrefix` matches `event.streamId.startsWith(streamPrefix)`; `typePrefix` matches `event.type.startsWith(typePrefix)` (mirrors Trail's existing kind-prefix filter semantics). Both optional; omitting both returns every event in scan order.

### Backend: `WorkflowSurface.listJournalEvents(query)`

```ts
listJournalEvents(query: JournalEventQuery): JournalEventPage {
  return this.guard(() => listJournalEvents(this.journal, query));
}
```

Reads `this.journal` directly — no new dependency, unlike #124's `databasePath` (that was needed for retention/archive metadata specifically; raw event iteration only needs the journal object already injected).

### Backend: gateway route

```
GET /api/v1/zentra/journal/events?afterPosition=<n>&streamPrefix=<s>&typePrefix=<s>&limit=<n> → invoke("listJournalEvents", query) → 200 JournalEventPage
```

Nested under `journal` (matching Milestones' `/milestones/:id` nesting precedent for a section with more than one route), distinct from the pre-existing `GET /api/v1/zentra/events` route (the console shell's own live SSE synchronization stream — a completely different protocol and purpose; naming this `journal/events` avoids any confusion with that unrelated, already-taken path). GET-only, same bearer-session auth as every route, no CSRF check (GET-exempt). Query parameters are all optional; absent `afterPosition` defaults to 0, absent `limit` defaults to 50.

### Frontend: extend `journal-section.ts` with a second view

Add a tab switcher within the Journal screen — "Status" (the existing #124 dashboard) and "Events" (new) — reusing Trail's exact `data-trail-view`-style tab pattern (already established, well-precedented in this same codebase) rather than inventing a new switching mechanism. A new `journalActiveView` state variable (default `"status"`) tracks which view renders into a shared container.

- **Filter inputs**: unlike Trail's actor/kind pills (a small, enumerable per-run set), stream ids and event types across the whole journal are not a small enumerable set — two plain text inputs (stream prefix, type prefix) instead of pill buttons, with a debounced or explicit "Apply" trigger (explicit button, avoiding a new debounce-timer pattern this console doesn't otherwise use). Changing a filter resets pagination (starts a fresh scan from position 0).
- **List panel**: one compact row per event — global position, stream id, event type, recorded-at timestamp — matching the visual density of Trail's event rows, not Pods'/Milestones' card style (this is a denser, more log-like dataset).
- **Load more**: a button at the bottom of the list appending the next page's events to the existing list (not replacing it) and updating the stored `nextPosition`/`hasMore` — the first genuine pagination affordance in this console; every prior list-view section loads its complete dataset in one request.
- **Detail panel**: click a row to select it; shows the full `StoredEvent` via `appendJson`, matching every other section's raw-payload-dump convention (Pods/Milestones/GitHub broker all do this for their own detail payloads).
- **Empty/loading states**: "No matching events in this range." for a zero-match, `hasMore: true` page (see Architecture); "No events found." only when a page returns zero matches AND `hasMore: false`; "Journal events unavailable." for a fetch failure.

## Error handling

Fetch failure at any point (initial load or "Load more") shows an inline failure message in the events panel, not the global status banner — matching every other section. A failed "Load more" leaves the already-loaded rows in place (does not clear existing results).

## Security

Read-only — `listJournalEvents` never calls any mutating journal method, only `iterateAllEvents`/paging reads. Event `payload`s are dumped raw via `appendJson`, matching the same convention already used for Pods/Milestones/GitHub-broker detail payloads — no new payload-sensitivity concern beyond what those sections already accepted, since this reads the exact same events those domain-specific projections already read from (this view is a lower-level, cross-stream lens on the identical data, not a new data source). Loopback-only, single-user session, no new network egress or subprocess execution.

## Testing

- `tests/journal/journal-events.test.ts` (new): unit tests for `listJournalEvents` — no filter (returns everything in scan order), `streamPrefix` filter, `typePrefix` filter, both combined, the zero-match-with-`hasMore:true` case, `limit` capping, pagination continuation (`afterPosition` from a prior page's `nextPosition` picks up where the previous call left off without duplicating or skipping events).
- `tests/surfaces/workflow-surface.test.ts`: `listJournalEvents` threading test.
- `tests/gateway/loopback-gateway.test.ts`: route test — 200 with a page, 401 unauthenticated, query parameter parsing (defaults when absent).
- `tests/gateway/console/journal-section.test.ts` (extend): markup/script assertions for the new Events tab, filter inputs, Load-more wiring, honest empty states, exactly the expected number of `request(...)` calls for the new load-more pattern (more than one is expected and correct here, unlike every prior section — this needs its own test framing, not a copy of the "exactly one fetch" assertion pattern other sections use).
- `tests/ui/console-shell.e2e.test.ts` (extend): real-browser case seeding several journal events directly, switching to the Events tab, asserting real events render, applying a filter, clicking Load more, clicking a row to see detail.
- Codebase-map: regenerate as the literal last commit before merge — confirmed necessary on every step in this series so far, no exceptions.

## Out of scope

- Payload full-text search.
- Any mutation capability.
- Trail's own per-run event view — unrelated, already shipped.
