# Agent Rail Console, Phase 2 Step 4c: GitHub broker

Status: Approved design

Date: 2026-08-06

## Context

Issue #123 ("Agent Rail Console Phase 2, Step 4c") is the third of three follow-up issues split off #121, which originally scoped Pods, Milestones, GitHub broker, and Journal together.
Steps 4a (Pods) and 4b (Milestones) shipped separately; see `docs/superpowers/specs/2026-08-04-agent-rail-console-phase2-pods-design.md` for why the four were split.

Unlike Pods and Milestones, `src/capsule/github-broker.ts`'s `GitHubEffectBroker` has no listing method at all.
It only appends events to a per-grant journal stream (`grantStreamId(grantId)` → `github-grant:<grantId>`): `capsule.github_grant_consumed`, `capsule.github_broker_accepted`, `capsule.github_broker_denied`, `capsule.github_broker_observed`, `capsule.github_broker_reconciled` (see `src/capsule/capsule-events.ts` for exact payload shapes).
Each stream carries enough data to reconstruct one grant's full lifecycle: which operation (`push` or `create_pull_request`), the repository, operation-specific fields (target ref/source commit for a push; head ref/base/draft for a PR), and — once reconciled — the final outcome (`completed`/`failed`/`uncertain`) plus the observed remote OID or PR number.

`GitHubEffectBroker`'s constructor needs a `CapsulePolicy`, a `GitHubCredentialProvider`, and a `GitHubRepositoryLeaseStore` — none of which a read-only list needs, unlike `PodRegistry`/`MilestoneRegistry`, which only need the journal.
Constructing a full broker just to read would require `WorkflowSurface` to also construct or receive credentials and lease-store dependencies it has no other use for.

## Goal

Wire the GitHub broker nav item to real data: a new `listGitHubBrokerActivity(journal)` read projection in `github-broker.ts`, a `GET /api/v1/zentra/github-broker` route backed by a new `WorkflowSurface.listGitHubBrokerActivity()` method, and a `github-broker-section.ts` console section showing broker activity with click-to-select detail, replacing the disabled "Phase 2" nav entry.

## Non-goals

- Pods, Milestones, Journal — tracked in their own issues (#121 shipped, #124 still open).
- Any mutation from the console (no triggering pushes/PRs, no re-running reconciliation) — read-only, consistent with every other console surface.
- A separate detail route. Each grant stream's total event payload is small (a handful of scalar fields, no large nested structure like Milestones' plan/tasks) — the list response contains everything meaningful per entry. Matches Pods' YAGNI reasoning, not Milestones'.
- Adding a `list()` method to `GitHubEffectBroker` itself, or constructing a full broker instance for reads — see Context above for why.
- Trail sub-steps 2/3 — unrelated, tracked separately.
- A response-size ceiling on `GET /api/v1/zentra/github-broker` — same accepted reasoning as Pods'/Milestones' non-goals.

## Architecture

### Backend: `listGitHubBrokerActivity(journal)` in `src/capsule/github-broker.ts`

New exported function, co-located with the domain module that already knows the `capsule.github_*` event-type names and payload shapes — not duplicated into `workflow-surface.ts`:

```ts
export interface GitHubBrokerActivity {
  readonly grantId: string;
  readonly requestId: string;
  readonly operation: "push" | "create_pull_request";
  readonly repository: string;
  readonly status: "denied" | "accepted" | "observed_denied" | "observed_uncertain" | "completed" | "failed" | "uncertain";
  readonly detail: Readonly<Record<string, unknown>>;
}

export function listGitHubBrokerActivity(journal: EventJournal): readonly GitHubBrokerActivity[] {
  // scans all github-grant:* streams via iterateAllEvents (mirrors listRunsProjection()'s
  // scanning approach), folds each stream's events into one GitHubBrokerActivity per
  // grantId keyed by the furthest-along event, applies assertBoundedProjectionEntries
}
```

Folding logic per stream, in event-type precedence order (each later event supersedes the status derived from earlier ones):
1. `capsule.github_broker_denied` alone → `status: "denied"`, `detail` from the action payload.
2. `capsule.github_grant_consumed` + `capsule.github_broker_accepted` → `status: "accepted"`, `detail` from the accepted action payload.
3. ...then `capsule.github_broker_observed` → `status: "observed_denied"` or `"observed_uncertain"` per its `outcome` field, `detail` merged with `target`.
4. ...then `capsule.github_broker_reconciled` → `status` from its `outcome` field (`completed`/`failed`/`uncertain`), `detail` merged with `observedRemoteOid` (push) or `observedNumber` (PR).

`WorkflowSurface` method, next to `listPods()`/`listMilestones()`:

```ts
listGitHubBrokerActivity(): readonly GitHubBrokerActivity[] {
  return this.guard(() => listGitHubBrokerActivity(this.journal));
}
```

Zero new plumbing — `journal` is already `this.journal`. Errors normalize through the existing `guard()`/`normalizeSurfaceError()` path.

### Backend: gateway route

```
GET /api/v1/zentra/github-broker → invoke("listGitHubBrokerActivity") → 200 [GitHubBrokerActivity, ...]
```

`GET`-only, next to the `pods`/`milestones` GET branches in `routeApi`. No CSRF/origin check (GET-exempt). Same bearer-session auth as every other route.

### Frontend: `src/gateway/console/github-broker-section.ts`

New file, same `<NAME>_MARKUP`/`<NAME>_SCRIPT` pair, reusing Pods' `.workspace[data-columns="2"]` two-panel CSS variant. Mirrors Pods' pure-client-side-selection pattern (list already contains full detail, no second fetch on click) — not Milestones' click-to-fetch pattern.

- **List panel**: cards showing an operation badge (`Push`/`Create pull request`), repository, a status badge, grantId as meta line.
- **`loadGitHubBrokerActivity()`**: `request("/api/v1/zentra/github-broker")`, stores into local state, hooked into the post-auth `refresh()` cycle alongside `pods?.load?.()`/`milestones?.load?.()`.
- **Detail panel**: click a card to select it (no fetch); curated facts via `field()` (Grant ID, Request ID, Operation, Repository, Status, plus operation-specific fields pulled from `detail`: Target ref/Source commit for push, Head ref/Base/Draft for PR), then `appendJson(host, "Detail", activity.detail)` for the full raw payload including reconciled fields.
- **Empty state**: "No GitHub broker activity yet." — same convention as Pods'.
- Registers `window.__consoleSections.github = {render: renderGitHubBroker, load: loadGitHubBrokerActivity}` — nav id `github`, matching `shell.ts`'s existing `{ id: "github", label: "GitHub broker", icon: "⎇", enabled: false }` entry (file name uses the fuller `github-broker-section.ts` to match the domain module `github-broker.ts`, even though the nav id and section-id stay `github`).

### Wiring changes to existing files

- **`src/gateway/console/controls-section.ts`**: add `window.__consoleSections.github?.load?.()` to the existing chain in `refresh()`, alongside `pods?.load?.()`/`milestones?.load?.()`.
- **`src/gateway/console/shell.ts`**: import `GITHUB_BROKER_MARKUP`; flip the `github` nav item's `enabled` flag to `true`; add `<section class="section" data-section-id="github">${GITHUB_BROKER_MARKUP}</section>`.
- **`src/gateway/console/console-ui.ts`**: import `GITHUB_BROKER_SCRIPT` and concatenate it into `CONSOLE_SCRIPT`.

### Two recurring regressions, fixed proactively — codebase-map regen strictly last

Per the sharpened lesson from Step 4b (Milestones): the plan's implementation must fix both `tests/ui/cross-surface-acceptance.e2e.test.ts`/`tests/ui/chromium-acceptance.ts` (focus-order bump, `"button::⎇ GitHub broker"` inserted after Milestones, before Warning policies) **and** `docs/codebase-map.html` — but the codebase-map regeneration must be the strictly-last task in the plan, after every other file-touching task including the e2e test task, not merely "early." Milestones' plan put it before the e2e task and the map went stale a second time as a direct result.

## Error handling

- Empty activity list: "No GitHub broker activity yet." empty state.
- `listGitHubBrokerActivity()` failure: inline "GitHub broker activity unavailable." in the list panel (local `githubLoadFailed` flag), not the global `status()` banner — same convention as Pods/Milestones/Trail.
- No 404 case exists for this route (list-only, no path parameter).

## Security

No change to the trust boundary. Read-only, same bearer-session auth as every other route. The event payloads (`GitHubActionSchema` and friends in `capsule-events.ts`) were checked for sensitive fields — they carry repository names, git refs, commit SHAs, and SHA-256 digests of PR titles/bodies (not the raw title/body text), no credentials or tokens. `GitHubEffectBroker` itself never writes tokens/credentials into journal events (`GitHubCredentialProvider.resolve()` results stay in-process, passed directly to `git`/`gh` subprocess environments, never persisted to the journal) — confirmed by reading every `capsule.github_*` schema in `capsule-events.ts`. Loopback-only, single-user session; no new network egress or subprocess execution — `listGitHubBrokerActivity()` only reads the journal, never touches `git`/`gh`.

## Testing

Test-driven development, per `AGENTS.md`.

- **`tests/capsule/github-broker-activity.test.ts`** (new file, keeping `github-broker.test.ts` at its current 399 lines focused on the broker's write-side behavior): unit tests for `listGitHubBrokerActivity()`. Seed fixtures by appending `capsule.github_*` events directly to a `SqliteEventJournal` via `journal.append(...)` — mirroring the existing `appendCompletedPush()` helper pattern already in `github-broker.test.ts`, not by driving the full `GitHubEffectBroker` (which would require mocking `runProcess`/credentials/policy for no benefit to a read-path test). Cases: zero grants, a denied grant (only `_broker_denied`), an accepted-but-not-yet-observed grant, an observed-uncertain grant, a fully reconciled push (`completed`), a fully reconciled PR (`completed`), a reconciled-failed grant, and multiple independent grant streams listed together.
- **`tests/gateway/loopback-gateway.test.ts`**: route test for `GET /api/v1/zentra/github-broker` — 200 with the list, 401 without a bearer token, empty-array case.
- **`tests/gateway/console/github-broker-section.test.ts`** (new): markup/structure assertions matching `pods-section.test.ts`'s style — no self-invocation, fetches the real route, no `innerHTML`, no second per-item fetch.
- **`tests/gateway/console/shell.test.ts`**, **`console-ui.test.ts`**, **`controls-section.test.ts`**: wiring assertions matching Pods'/Milestones' pattern (nav enabled, `data-screen-label="GitHub broker"` present, script concatenated, refresh hook present).
- **`tests/ui/cross-surface-acceptance.e2e.test.ts`** + **`tests/ui/chromium-acceptance.ts`**: focus-order bump, per Architecture above.
- **`docs/codebase-map.html`**: regenerated as the strictly-last task in the implementation plan.
- **`tests/ui/console-shell.e2e.test.ts`**: e2e test that seeds broker activity directly into the e2e fixture's journal (same direct-`journal.append` approach as the unit tests, not a full broker drive) and asserts the console renders it end-to-end, including a click-to-select detail assertion.

## Out of scope

- Pods, Milestones — already shipped.
- Journal (#124) — future issue, still needs a scoping decision.
- Any mutation capability from the console for GitHub broker activity.
- A `GET /github-broker/:grantId` detail route — see Non-goals above.
