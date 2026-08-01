# Agent Rail Console, Phase 2 Step 3: Warnings, Security, Cost, Compare, Imports, Warning Policies

Status: Approved design

Date: 2026-08-01

## Context

Issue #120 ("Agent Rail Console Phase 2, Step 3") tracks the six of the mockup's twelve nav sections whose underlying concepts exist only in the vendored Python `agent_tail` package: Warnings, Security, Cost, Compare runs, Imports, and Warning policies.
None of these has a TypeScript equivalent or an HTTP surface in Zentra's own console today; each one's real backend needs its own future data-model and API design, out of scope here.

Reading each section's actual markup and component logic in the Claude design-tool mockup (`Console.dc.html`) shows all six share one shape: a heading, then cards, tables, or lists rendered from a small in-memory data object, with no complex rendering algorithm (unlike Trail's node-link graph layout).
Sizes range from roughly 2,600 to 5,100 characters of markup per section — comparable to each other, unlike Trail's Events/Swimlane/Graph split, which was justified by wildly uneven complexity.
This step therefore covers all six sections in a single spec and plan, rather than decomposing further.

## Goal

Match `Console.dc.html`'s visual design for these six sections, built in Zentra's existing framework-free console pattern, showing clearly-labeled static example data — since no real backend exists yet for any of these six concepts — with every control that implies a real backend action rendered visibly but disabled, matching the "Phase 2" treatment already established for Trail's not-yet-built tabs.

## Non-goals

- Any real backend, data model, or API for Warnings, Security, Cost, Compare, Imports, or Warning policies. Each is future work, to be separately designed once there is a real need to wire it live.
- Trail's remaining sub-steps (Swimlane, Graph/Tree) and Pods/Milestones/GitHub broker/Journal (#121) — unrelated tickets.
- Any functioning mutation: acknowledging or suppressing a warning, importing a session, toggling a policy rule, or picking runs to compare. All of these render disabled.
- Tying this content to the currently-selected real run. See Architecture.

## Architecture

### One file per section, following the established pattern

Six new files under `src/gateway/console/`: `warnings-section.ts`, `security-section.ts`, `cost-section.ts`, `compare-section.ts`, `imports-section.ts`, `policies-section.ts`.
Each exports a `<NAME>_MARKUP` and `<NAME>_SCRIPT` pair, following `overview-section.ts`'s exact conventions: DOM built via `document.createElement`/`setText`, never `innerHTML`; any font-stack interpolation (`CONSOLE_FONT_STACK_MONO`/`CONSOLE_FONT_STACK_SANS`) isolated into single-quoted one-line constants, never inlined into a double-quoted JS string — the discipline established after Trail's step-1 near-miss with this exact bug class.

`console-ui.ts` concatenates all six new scripts into the existing IIFE, alongside `CONTROLS_SCRIPT`, `TRAIL_SCRIPT`, and `OVERVIEW_SCRIPT`. `shell.ts` flips these six nav items' `enabled` flag from `false` to `true` in `NAV_GROUPS` (`warnings`, `security`, `cost`, `compare`, `imports`, `policies` — the exact six ids already present and currently disabled) and embeds each section's markup into its own `<section data-section-id="...">` wrapper, matching the existing pattern for `controls`/`overview`/`trail`.

### Static, not run-scoped

Unlike Overview and Trail, these six sections do not read from `state.selected` or fetch anything — there is no real per-run backend behind any of them.
Each section's script defines its own small, explicitly-named hardcoded dataset inline (e.g. `const WARNINGS_DEMO_DATA=[...]`, with a comment marking it as placeholder content, not real data), adapted from the mockup's own demo values.
The content is identical regardless of which run is selected, or whether any run is selected at all — rendering it as if it belonged to "the current run" would be dishonest given no such data exists.
Each section's heading area carries a small inline note making this explicit to the operator, in the same honest-labeling spirit as Overview's `—` / "Available in a later phase" placeholders from Phase 2 Step 1: something like "Preview — static example data, not yet wired to a real backend for this concept."

### Disabled interactive elements

Every control in the mockup that implies a real backend action renders visibly, styled disabled (dimmed, `cursor:not-allowed`, no click handler attached), rather than omitted or silently non-functional:

- **Warnings.** Each warning card's "Open evidence →", "Acknowledge", and "Suppress in policy" buttons.
- **Security.** The taint-chain node buttons (`{{c.open}}` in the mockup) — rendered as static chain segments, not clickable.
- **Cost.** The actor-row click-through and hunk-row "open" action.
- **Compare.** No functioning run picker. The section shows one fixed, illustrative example comparison (adapted from the mockup's own `compare-run-a.jsonl` vs `compare-run-b.jsonl` demo values) rather than a working "pick two runs" control, since there is no real cross-run diff capability behind it at all yet.
- **Imports.** Each adapter card's "Import example session" button.
- **Warning policies.** Each policy row's suppress/un-suppress toggle button.

This mirrors the disabled-with-badge convention `shell.ts` already uses for not-yet-built nav items, applied here to individual controls within an otherwise-enabled section rather than to the whole nav entry.

## Error handling

None needed. No network calls, no new failure modes — every value is a static, in-memory literal.

## Security

No change to the trust boundary. No new network egress, no new subprocess execution, no new mutation capability. Purely additive, client-side-only markup and static data.

## Testing

Test-driven development, per `AGENTS.md`.

- **Unit:** one test file per new section (`tests/gateway/console/warnings-section.test.ts` etc.), asserting the markup contains the section's key structural elements and the "static example data" note, and that every action-implying control carries `disabled`/no click handler — following the exact assertion style already established in `tests/gateway/console/overview-section.test.ts` and `trail-section.test.ts`.
- **`shell.test.ts`:** update the existing nav-rendering assertions for these six ids from disabled-with-"Phase 2"-badge to enabled, matching the flipped `enabled` flags.
- **`console-ui.test.ts`:** confirm the concatenated script still parses (the `node:vm` syntax guard added during Trail step 1 already covers this for the whole document) and that each new section's `data-screen-label` is present in the composed HTML.
- **Real-browser e2e:** extend `tests/ui/console-shell.e2e.test.ts` with one test that clicks each of the six newly-enabled nav items in turn and asserts the section's heading renders and is non-empty, plus one assertion that a representative disabled control (e.g. a Warnings card's "Acknowledge" button) is genuinely inert — clicking it produces no visible state change.

## Out of scope

- Real backend, data model, or API for any of the six concepts.
- Trail sub-steps 2/3 and #121 (Pods/Milestones/GitHub broker/Journal).
- Any functioning mutation from these six sections.
