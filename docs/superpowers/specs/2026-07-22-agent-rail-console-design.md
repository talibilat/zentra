# Agent Rail Console, Phase One

Status: Approved design

Date: 2026-07-22

## Problem Statement

Zentra's only browser surface today is the Operations Console (`src/gateway/operations-ui.ts`), a single hand-written page covering goal and ticket intake, the run list, run detail, and pending-attention decisions.
It embeds AgentTrail's separate serve-mode UI through an iframe for trace evidence.

A new visual design was produced in a Claude Design project ("UI update for dual repositories", project id `2f77cd19-3dec-4e22-96bc-9677b83fd480`, file `Console.dc.html`).
That design describes a thirteen-section operator console: Overview, Console, Milestones, Pods, Journal, Cost, Security, Policies, GitHub broker, Imports, Compare, Trail, and Warnings.
Only one of those sections, Trail, currently has a matching backend surface, because AgentTrail's serve mode was already built and shipped in a prior milestone.
The remaining sections describe real Zentra subsystems (`src/milestones`, `src/pods`, `src/journal`, `src/capsule/github-broker.ts`, `src/policy`) that have no browser-facing API today.

Building all thirteen sections with real data in one pass is not achievable responsibly in one iteration.
This spec covers phase one only.
Later phases are separate specs, decomposed the same way this one was.

## Scope

Phase one delivers five sections against real Zentra data:

- Overview (aggregated summary, no new endpoint)
- Milestones (new read endpoints)
- Pods (new read endpoints)
- Journal (existing event-change endpoint, new browsing UI)
- Trail (visual restyle only, existing backend untouched)

Out of scope for phase one: Cost, Security, Policies, GitHub broker, Imports, Compare, and Warnings.
These sections are deferred to future specs once their backend data model and API surface are separately designed.
No new mutation commands are introduced in phase one.
Every new endpoint is read-only.

## Architecture

### Frontend composition

Replace `src/gateway/operations-ui.ts` with a `src/gateway/console/` directory, one file per concern:

- `styles.ts` exports the shared design tokens (colors, fonts, spacing) taken from `Console.dc.html`, matching the palette AgentTrail's own UI already uses (`--run:#33c9ff`, `--ok:#37e39b`, `--warn:#ffb454`, `--err:#ff5d6c`).
- `shell.ts` exports the sidebar navigation, page frame, session handoff, and SSE connection logic, adapted from the corresponding parts of `operations-ui.ts`.
- `overview.ts`, `milestones.ts`, `pods.ts`, `journal.ts`, `trail.ts` each export their own markup, styles, and behavior as plain string constants and DOM-builder functions, following the existing pattern in `operations-ui.ts` (for example `renderRuns`, `renderAttention`).
- A top-level `console-ui.ts` imports all section modules and composes the final HTML document and its SHA-256 digest, the same way `operations-ui.ts` exports `OPERATIONS_SCRIPT_SHA256` today.

This is plain TypeScript module composition compiled through the existing `tsc` build.
No new build script, no bundler, and no new dependency is introduced.
The browser still receives one self-contained page with no external requests, preserving the current security and offline posture.

### Backend additions

Extend `WorkflowSurface` (`src/surfaces/workflow-surface.ts`) with four new read-only methods, following the exact pattern `listRuns()` and `getRun()` already establish (fold over `iterateAllEvents`/`readStreamEvents`, wrap in `guard()`, return through `json()` for deep-frozen immutable output):

- `listMilestones(): readonly WorkflowMilestoneSummary[]`
- `getMilestone(milestoneId: string): WorkflowMilestoneDetail | null`
- `listPods(runId?: string): readonly WorkflowPodSummary[]`
- `getPod(podId: string): WorkflowPodDetail | null`

These project existing durable state from `src/milestones/milestone-projection.ts` and `src/pods/pod-projection.ts` into view types, the same relationship `WorkflowRunSummary` already has to `RunView`.
No new event types and no new journal streams are introduced; these methods only read what milestone and pod execution already write.

Add matching routes to `src/gateway/loopback-gateway.ts`, alongside the existing `/api/v1/zentra/runs` and `/api/v1/zentra/runs/:id` routes:

- `GET /api/v1/zentra/milestones`
- `GET /api/v1/zentra/milestones/:id`
- `GET /api/v1/zentra/pods`
- `GET /api/v1/zentra/pods/:id`

Every route reuses the existing bearer-token and CSRF enforcement, the existing `SECURITY_HEADERS`, and the existing `WorkflowSurfaceError` to HTTP status mapping.
No new authentication or authorization mechanism is introduced.

The Journal section needs no new backend method.
It is a browsing UI over the existing `getChanges(afterPosition, limit)` projection, already exposed at `/api/v1/zentra/events`, which every other section already polls for live updates.
`getChanges` only pages forward from a given position; it has no reverse-iteration mode.
The Journal screen therefore lets the operator step forward through history starting from position zero, independent of the live tail the shell already follows, and adds client-side filtering (by event type, stream id, or correlation id) over the pages it fetches.
Whether that requires its own cursor state separate from the shell's live-follow cursor is an implementation-planning decision, not a design decision; either way, no new backend method is introduced.

### Live updates

Milestones and pods are themselves projections of the same durable event journal Runs is projected from.
New sections do not need a new streaming mechanism.
They subscribe to the same `/api/v1/zentra/events` Server-Sent-Events stream the shell already connects on page load, and re-fetch their own list when the stream signals a change, exactly as `refresh()` does for Runs today.

### Trail

No backend change.
AgentTrail's serve-mode process (`agenttrail/upstream/src/agent_tail/serve.py`) and its existing graph, tree, swimlane, and sequence views remain untouched, still reached through the existing session-cookie handoff in `loopback-gateway.ts`.
Only the surrounding chrome changes: the Trail section in the new console shell restyles the header, sidebar entry, and frame around the embedded view to match `Console.dc.html`, replacing the current boxed-iframe presentation.
The gateway's existing degrade/recover signaling (`gateway.degraded`, `gateway.backfill_target`, `gateway.recovered`) is preserved unchanged.

## Section Behavior

**Overview.**
A landing screen combining counts and latest status already available from Runs, plus the new Milestones and Pods lists, fetched and combined client-side.
No new aggregate endpoint, to avoid a bespoke projection that duplicates data three other endpoints already expose.

**Milestones.**
List view showing milestone id, lifecycle state, owning run, and plan revision, backed by `listMilestones()`.
Detail view showing the full plan DAG, stop-and-ask state, and terminal outcome when present, backed by `getMilestone()`.

**Pods.**
List view showing pod id, lifecycle, owning milestone, and budget usage, backed by `listPods()`.
Detail view showing assignment history, charter, lease, and evidence, backed by `getPod()`.

**Journal.**
Paged, filterable view over the same durable event stream every other section already reads, using the existing `getChanges` cursor semantics.
Read-only; no new event types.

**Trail.**
Same AgentTrail evidence as today, restyled to sit inside the new console shell instead of a boxed iframe panel.

## Error Handling

Phase one introduces no new error classes.
The new `WorkflowSurface` methods reuse `WorkflowSurfaceError` and its existing codes (`not_found`, `unavailable`, `internal`, and so on) through the existing `guard()`/`normalizeSurfaceError()` path.
Because every new endpoint is read-only, none of the idempotency or digest-confirmation machinery `answerQuestion`/`approvePlan` require applies yet; that only becomes relevant when a later phase adds actions to Milestones or Pods.

## Security

No change to the trust boundary described in `AGENTS.md`.
All new routes are read-only projections of data the operator already has access to through the CLI.
No new subprocess execution, no new file-system access, and no new network egress is introduced by this phase.

## Testing

Test-driven development, per `AGENTS.md`.

- Backend: Vitest unit tests for each new `WorkflowSurface` method, following the pattern in the existing surface tests, and Vitest tests for each new gateway route, following `tests/gateway/*.test.ts`.
- Frontend: extend the existing real-browser acceptance pattern (`tests/gateway/chromium-browser.e2e.test.ts`, `tests/ui/cross-surface-acceptance.e2e.test.ts`) to load the new console shell, navigate to each of the five phase-one sections, and assert real data renders from a live gateway and workflow surface, not mocked responses.
- A dedicated assertion that the Trail section still receives live AgentTrail SSE updates after the chrome restyle, so the visual change is proven not to have broken the existing live-evidence behavior.

## Out of Scope

- Cost, Security, Policies, GitHub broker, Imports, Compare, and Warnings sections. Each needs its own data-model and API design before implementation, deferred to future specs.
- Any new mutation command (starting or cancelling a milestone or pod from the UI, for example).
- Reimplementing AgentTrail's graph, tree, swimlane, or sequence rendering logic; phase one only restyles the chrome around it.
- A bespoke Overview aggregate endpoint; phase one composes the Overview screen from existing per-section data client-side.
