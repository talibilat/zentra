# Agent Rail Console, Phase One Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `src/gateway/operations-ui.ts` with a new sidebar-shell console matching the `Console.dc.html` design, carrying the existing goal/ticket/run/decision controls into it unchanged, and restyling the AgentTrail evidence view to sit inside the new shell instead of a boxed iframe panel.

**Architecture:** Plain TypeScript module composition under `src/gateway/console/`, one file per concern, concatenated by a top-level `console-ui.ts` into the single hash-verified HTML string the gateway already serves. No bundler, no new dependency, no new build step. Every existing DOM id and script behavior the current browser test suite asserts against (`#goal-form`, `#tickets-form`, `#run-detail .fact dd`, `#cancel-run`, `[data-action=...]`, and so on) is preserved exactly.

**Tech Stack:** TypeScript 5.9 (compiled via the existing `tsc` build), Vitest, real-Chromium E2E via `tests/ui/chromium-acceptance.ts`.

## Global Constraints

- Node.js `>=24 <27`, pnpm 10, TDD for every behavioral change (`AGENTS.md`).
- No general shell capability; no new subprocess, filesystem, or network surface (`AGENTS.md`, spec Security section).
- The served page must remain fully self-contained: no CDN fonts, no external requests. The gateway's Content-Security-Policy for `/` is `default-src 'none'; ...; style-src 'unsafe-inline'` (`src/gateway/loopback-gateway.ts:220`), which blocks any `@font-face`/CDN font load outright — font tokens are CSS `font-family` names with system fallbacks only, never a `<link>` to `fonts.googleapis.com`.
- Never commit, push, or file issues unless the user explicitly requests it (`AGENTS.md`).
- Keep implementation on the isolated worktree already created (`worktree-agent-rail-console`).
- One sentence per physical line in any new or substantially edited Markdown.
- Reference spec: `docs/superpowers/specs/2026-07-22-agent-rail-console-design.md`.

---

## File Map

```text
src/gateway/
  operations-ui.ts                    # deleted at the end of Task 8
  console/
    design-tokens.ts                  # new: shared CSS custom properties
    pending-submissions.ts            # new: extracted from operations-ui.ts, unchanged behavior
    controls-section.ts               # new: ported goal/ticket/run/attention/decision UI
    trail-section.ts                  # new: restyled AgentTrail iframe chrome
    overview-section.ts               # new: metrics + narrative for the selected run
    shell.ts                          # new: sidebar nav, header, frame, session handoff, SSE
    console-ui.ts                     # new: composes the above into consoleHtml()
  loopback-gateway.ts                 # modified: serve consoleHtml() instead of operationsHtml()
tests/gateway/
  operations-ui.test.ts               # deleted, superseded by console/*.test.ts below
  console/
    pending-submissions.test.ts       # new: moved assertions from operations-ui.test.ts
    design-tokens.test.ts             # new: palette and no-external-font assertions
    controls-section.test.ts          # new: moved script-content assertions
    trail-section.test.ts             # new: restyled chrome assertions
    overview-section.test.ts          # new: mount-point assertions
    shell.test.ts                     # new: nav composition and handoff-ownership assertions
    console-ui.test.ts                # new: composition and CSP-digest assertions
tests/ui/
  chromium-acceptance.ts              # unmodified — selectors preserved, so existing helpers keep working
  console-shell.e2e.test.ts           # new: sidebar nav, Overview real data, Trail live SSE after restyle
tests/gateway/chromium-browser.e2e.test.ts        # unmodified, must stay green
tests/conformance/packaged-browser-security.e2e.test.ts  # unmodified, must stay green
```

---

### Task 1: Extract pending-submission tracking into its own module

**Files:**
- Create: `src/gateway/console/pending-submissions.ts`
- Modify: `src/gateway/operations-ui.ts:1-36` (remove the extracted code, import it back in)
- Test: `tests/gateway/console/pending-submissions.test.ts`
- Delete (after this task, these three `it` blocks move out of): `tests/gateway/operations-ui.test.ts:1-40`

**Interfaces:**
- Produces: `BrowserPendingSubmissionCommands` (class, same public API: `reserve`, `acknowledge`, `size` getter), `isProvenPreEffectBrowserSubmissionError(code: unknown): boolean`, `MAX_PENDING_BROWSER_SUBMISSIONS` (const, value `32`). Every later task that touches submission dispatch imports these from `./pending-submissions.js`, not from `operations-ui.js`.

This is a pure extraction: the class and function move verbatim from `src/gateway/operations-ui.ts:5-36` into the new file, with no behavior change. The existing tests are the safety net — run them before and after, both green, using the new import path.

- [ ] **Step 1: Create the new file with the extracted code**

```typescript
// src/gateway/console/pending-submissions.ts
const MAX_PENDING_BROWSER_SUBMISSIONS = 32;

export function isProvenPreEffectBrowserSubmissionError(code: unknown): boolean {
  return code === "invalid_transition" || code === "digest_mismatch";
}

export class BrowserPendingSubmissionCommands {
  private readonly pending = new Map<string, string>();

  constructor(private readonly createId: () => string) {}

  reserve(submission: Readonly<Record<string, unknown>>, actor: Readonly<Record<string, string>>): {
    readonly key: string;
    readonly commandId: string;
  } {
    const source = submission["kind"] === "inline_goal"
      ? { kind: "inline_goal", goal: String(submission["goal"] ?? "") }
      : { kind: "ticket_directory", directoryPath: String(submission["directoryPath"] ?? "") };
    const key = JSON.stringify({ schemaVersion: 1, source, actor: { actorId: actor["actorId"], channel: actor["channel"] } });
    if (key.length > 24 * 1024) throw new Error("pending_submission_key_too_large");
    const existing = this.pending.get(key);
    if (existing !== undefined) return { key, commandId: existing };
    if (this.pending.size >= MAX_PENDING_BROWSER_SUBMISSIONS) throw new Error("pending_submission_limit");
    const commandId = this.createId();
    this.pending.set(key, commandId);
    return { key, commandId };
  }

  acknowledge(command: { readonly key: string; readonly commandId: string }): void {
    if (this.pending.get(command.key) === command.commandId) this.pending.delete(command.key);
  }

  get size(): number { return this.pending.size; }
}
```

- [ ] **Step 2: Point `operations-ui.ts` at the extracted module**

Replace `src/gateway/operations-ui.ts:1-36` (the `createHash` import through the closing brace of `BrowserPendingSubmissionCommands`) with:

```typescript
import { createHash } from "node:crypto";

import { BrowserPendingSubmissionCommands, isProvenPreEffectBrowserSubmissionError } from "./console/pending-submissions.js";
```

Leave the rest of `operations-ui.ts` (the `OPERATIONS_SCRIPT` template literal and everything after) unchanged for now; it references `BrowserPendingSubmissionCommands.toString()` and `isProvenPreEffectBrowserSubmissionError.toString()` at what is now line ~7-8, which still works identically against the imported symbols.

- [ ] **Step 3: Move the three extraction-relevant tests to the new location**

Create `tests/gateway/console/pending-submissions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  BrowserPendingSubmissionCommands,
  isProvenPreEffectBrowserSubmissionError,
} from "../../../src/gateway/console/pending-submissions.js";

describe("browser pending submission tracking", () => {
  it("keys pending identities by canonical submission and actor while bounding unresolved entries", () => {
    let next = 0;
    const pending = new BrowserPendingSubmissionCommands(() => `command-${++next}`);
    const actor = { actorId: "zentra-local-operator", channel: "ui" };
    const original = pending.reserve({ kind: "inline_goal", goal: "Original" }, actor);

    expect(pending.reserve({ goal: "Original", kind: "inline_goal" }, actor)).toEqual(original);
    expect(pending.reserve({ kind: "inline_goal", goal: "Edited" }, actor).commandId).not.toBe(original.commandId);
    expect(pending.reserve({ kind: "inline_goal", goal: "Original" }, { ...actor, actorId: "other" }).commandId)
      .not.toBe(original.commandId);
    expect(pending.size).toBe(3);
    for (let index = 0; index < 29; index++) pending.reserve({ kind: "inline_goal", goal: `Bounded ${index}` }, actor);
    expect(() => pending.reserve({ kind: "inline_goal", goal: "One too many" }, actor)).toThrow("pending_submission_limit");
    expect(() => new BrowserPendingSubmissionCommands(() => "unused").reserve(
      { kind: "inline_goal", goal: "x".repeat(25 * 1024) }, actor,
    )).toThrow("pending_submission_key_too_large");
  });

  it("classifies only typed pre-effect validation and digest failures as safe to clear", () => {
    expect(isProvenPreEffectBrowserSubmissionError("invalid_transition")).toBe(true);
    expect(isProvenPreEffectBrowserSubmissionError("digest_mismatch")).toBe(true);
    expect(isProvenPreEffectBrowserSubmissionError("internal")).toBe(false);
    expect(isProvenPreEffectBrowserSubmissionError("unavailable")).toBe(false);
    expect(isProvenPreEffectBrowserSubmissionError("uncertain")).toBe(false);
  });
});
```

Delete the two corresponding `it` blocks from `tests/gateway/operations-ui.test.ts` (the `"keys pending identities..."` and `"classifies only typed pre-effect..."` blocks currently at lines 18-40).

- [ ] **Step 4: Run both test files and confirm green**

Run: `pnpm vitest run tests/gateway/console/pending-submissions.test.ts tests/gateway/operations-ui.test.ts`
Expected: all tests PASS, including the remaining `"creates one command identity per form submission..."` test in `operations-ui.test.ts`, which still passes because `OPERATIONS_SCRIPT` is untouched.

- [ ] **Step 5: Type-check and commit**

Run: `pnpm check`
Expected: no errors.

```bash
git add src/gateway/console/pending-submissions.ts src/gateway/operations-ui.ts tests/gateway/console/pending-submissions.test.ts tests/gateway/operations-ui.test.ts
git commit -m "Extract browser pending-submission tracking into its own module"
```

---

### Task 2: Add shared design tokens

**Files:**
- Create: `src/gateway/console/design-tokens.ts`
- Test: `tests/gateway/console/design-tokens.test.ts`

**Interfaces:**
- Produces: `CONSOLE_DESIGN_TOKENS: string` — a CSS block defining custom properties, consumed by `shell.ts` (Task 5) inside a `<style>` tag. `CONSOLE_FONT_STACK_SANS: string` and `CONSOLE_FONT_STACK_MONO: string` — `font-family` values consumed by every section file.

Colors are taken directly from `Console.dc.html`'s `<style>` block, which is identical to the palette already shipped in `agenttrail/upstream/src/agent_tail/web/index.html:9-22` (`--run:#33c9ff`, `--ok:#37e39b`, `--warn:#ffb454` in AgentTrail's naming; `--wa`/`--er`/`--ac`/`--or` in the mock's shorthand naming). This task adopts AgentTrail's existing variable names for consistency between the Trail section and the embedded AgentTrail page.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/gateway/console/design-tokens.test.ts
import { describe, expect, it } from "vitest";

import { CONSOLE_DESIGN_TOKENS, CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "../../../src/gateway/console/design-tokens.js";

describe("console design tokens", () => {
  it("defines the AgentTrail-matching color palette", () => {
    for (const token of ["--bg:#0a0e17", "--panel:#111725", "--run:#33c9ff", "--ok:#37e39b", "--warn:#ffb454", "--err:#ff5d6c", "--accent:#7aa2ff", "--orch:#b18cff"]) {
      expect(CONSOLE_DESIGN_TOKENS).toContain(token);
    }
  });

  it("never references an external font host", () => {
    expect(CONSOLE_DESIGN_TOKENS).not.toMatch(/https?:\/\//);
    expect(CONSOLE_FONT_STACK_SANS).not.toMatch(/https?:\/\//);
    expect(CONSOLE_FONT_STACK_MONO).not.toMatch(/https?:\/\//);
    expect(CONSOLE_FONT_STACK_SANS).toContain("system-ui");
    expect(CONSOLE_FONT_STACK_MONO).toContain("monospace");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/gateway/console/design-tokens.test.ts`
Expected: FAIL with "Cannot find module '../../../src/gateway/console/design-tokens.js'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/gateway/console/design-tokens.ts
export const CONSOLE_FONT_STACK_SANS = `"IBM Plex Sans",system-ui,sans-serif`;
export const CONSOLE_FONT_STACK_MONO = `"IBM Plex Mono",ui-monospace,monospace`;

export const CONSOLE_DESIGN_TOKENS = `
:root{
  --bg:#0a0e17;--panel:#111725;--panel2:#0d1320;--stage:#080b12;--line:#1e2940;
  --text:#e6edf7;--dim:#8896ad;--faint:#5a6883;
  --run:#33c9ff;--ok:#37e39b;--warn:#ffb454;--err:#ff5d6c;--accent:#7aa2ff;--orch:#b18cff;
}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/gateway/console/design-tokens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/design-tokens.ts tests/gateway/console/design-tokens.test.ts
git commit -m "Add shared design tokens for the Agent Rail console"
```

---

### Task 3: Port the existing controls (goal/ticket/run/attention/decision UI)

**Files:**
- Create: `src/gateway/console/controls-section.ts`
- Test: `tests/gateway/console/controls-section.test.ts`
- Modify (reference only, not edited): `src/gateway/operations-ui.ts` — the source of the ported markup and script

**Interfaces:**
- Consumes: `BrowserPendingSubmissionCommands`, `isProvenPreEffectBrowserSubmissionError` from `./pending-submissions.js` (Task 1).
- Produces: `CONTROLS_MARKUP: string` (the `<section class="intake">...` through the closing `</section>` of the workspace, plus the `<template>` elements — i.e., everything currently inside `<main id="workspace">...</main>` in `operations-ui.ts:139-143`, minus the `<section id="agenttrail" ...>` evidence block, which moves to `trail-section.ts` in Task 4). `CONTROLS_SCRIPT: string` (the full behavior script currently exported as `OPERATIONS_SCRIPT` in `operations-ui.ts:38-128`, verbatim). Every DOM id referenced by `tests/ui/chromium-acceptance.ts` and `tests/conformance/packaged-browser-security.e2e.test.ts` — `#goal-form`, `#tickets-form`, `#goal`, `#ticket-path`, `#runs`, `#run-detail`, `#cancel-run`, `#attention`, `#decision`, `#decision-history`, `.run-card`, `.attention-card`, `[data-action]` forms, `#plan-digest`, `#plan-reason`, `#question-reason`, `#decision-option` — is preserved character-for-character.

This is a near-verbatim port. `OPERATIONS_SCRIPT` in `operations-ui.ts` already handles the AgentTrail iframe status relay (`applyGatewayChange`, `#agenttrail-status`, `#agenttrail-frame`) as part of the same script; that logic stays in `CONTROLS_SCRIPT` unchanged in this task (the shell in Task 5 still needs it to drive the Trail section's status indicator), and `trail-section.ts` in Task 4 only supplies the markup frame it targets.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/gateway/console/controls-section.test.ts
import { describe, expect, it } from "vitest";

import { CONTROLS_MARKUP, CONTROLS_SCRIPT } from "../../../src/gateway/console/controls-section.js";

describe("controls section", () => {
  it("preserves every DOM id the browser test suite depends on", () => {
    for (const id of ['id="goal-form"', 'id="tickets-form"', 'id="goal"', 'id="ticket-path"', 'id="runs"', 'id="run-detail"', 'id="cancel-run"', 'id="attention"', 'id="decision"', 'id="decision-history"']) {
      expect(CONTROLS_MARKUP).toContain(id);
    }
  });

  it("creates one command identity per form submission and suppresses duplicate dispatch while pending", () => {
    expect(CONTROLS_SCRIPT).toContain('if(form.dataset.submitting==="true")return');
    expect(CONTROLS_SCRIPT).toContain('form.dataset.submitting="true"');
    expect(CONTROLS_SCRIPT).toContain("pendingSubmissions.reserve(submission,UI_ACTOR)");
    expect(CONTROLS_SCRIPT).toContain("commandId:command.commandId");
    expect(CONTROLS_SCRIPT).toContain('delete form.dataset.submitting');
  });

  it("does not embed the AgentTrail evidence frame markup, which now lives in trail-section.ts", () => {
    expect(CONTROLS_MARKUP).not.toContain('id="agenttrail-frame"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/gateway/console/controls-section.test.ts`
Expected: FAIL with "Cannot find module '../../../src/gateway/console/controls-section.js'"

- [ ] **Step 3: Write the implementation**

Create `src/gateway/console/controls-section.ts` by copying `OPERATIONS_SCRIPT` from `operations-ui.ts:38-128` verbatim into a new export named `CONTROLS_SCRIPT`, and copying the markup currently inside `<main id="workspace">` from `operations-ui.ts:139-143` verbatim into a new export named `CONTROLS_MARKUP`, with one deletion: remove the `<section id="agenttrail" ...>...</section>` block (the AgentTrail evidence panel, including its `<iframe id="agenttrail-frame" ...>`) from the end of line 141 through the end of line 141 in the source — that markup moves to `trail-section.ts` in Task 4.

```typescript
// src/gateway/console/controls-section.ts
import { createHash } from "node:crypto";

import { BrowserPendingSubmissionCommands, isProvenPreEffectBrowserSubmissionError } from "./pending-submissions.js";

export const CONTROLS_SCRIPT = String.raw`(()=>{
"use strict";
const state={bearer:"",csrf:"",runs:[],selected:null,attention:[],history:[],decision:null,sourceTexts:{},cursor:0,connected:false};
const MAX_SOURCE_DISPLAY_CHARS=65536;
const MAX_PENDING_BROWSER_SUBMISSIONS=32;
const BrowserPendingSubmissionCommands=${BrowserPendingSubmissionCommands.toString()};
const isProvenPreEffectBrowserSubmissionError=${isProvenPreEffectBrowserSubmissionError.toString()};
const pendingSubmissions=new BrowserPendingSubmissionCommands(()=>crypto.randomUUID());
const UI_ACTOR={actorId:"zentra-local-operator",channel:"ui"};
const $=(id)=>document.getElementById(id);
/* ... the remainder of this template literal is copied verbatim from
   src/gateway/operations-ui.ts lines 48-127 (renderRuns through the
   $("decision").addEventListener block), with no changes.
   The final line calling void handoff() and the closing })(); are
   REMOVED here — the shell in Task 5 owns page-level handoff and
   calls this section's own init hook instead. See Step 3a below. */
})();`;

export const CONTROLS_MARKUP = `<section class="intake" aria-label="Run intake"><form id="goal-form" class="panel"><h2>Inline goal</h2><label class="field-label" for="goal">Goal</label><textarea id="goal" name="goal" required maxlength="20000" placeholder="Describe one measurable outcome"></textarea><p><button class="primary" type="submit">Submit goal</button></p></form><form id="tickets-form" class="panel"><h2>Ticket folder</h2><label class="field-label" for="ticket-path">Project-relative folder</label><div class="form-row"><div><input id="ticket-path" name="path" required maxlength="1024" placeholder="tickets/release-42"></div><button class="primary" type="submit">Submit tickets</button></div><p class="empty">The configured workflow validates path authority and bounded source ingestion.</p></form></section>
<section class="workspace" aria-label="Run operations"><section class="panel"><h2>Runs</h2><div id="runs" class="stack"></div></section><section class="panel"><h2>Run, source, analysis, and readiness</h2><div id="run-detail"></div><p><button id="cancel-run" class="danger" type="button" disabled>Cancel run</button></p></section><section class="panel"><h2>Pending attention</h2><div id="attention" class="stack" aria-live="polite"></div><div id="decision"></div><h3>Decision history</h3><div id="decision-history" aria-label="Resolved decision history"></div></section></section>
<template id="question-actions"><div class="decision-actions"><form data-action="answer"><label class="field-label" for="decision-option">Answer</label><select id="decision-option" name="optionId" required><option value="">Choose an answer</option></select><button class="primary" type="submit">Submit answer</button></form><form data-action="reject-question"><label class="field-label" for="question-reason">Rejection reason</label><input id="question-reason" name="reason" required maxlength="2000"><button class="danger" type="submit">Reject question</button></form></div></template>
<template id="plan-actions"><div class="decision-actions"><p id="digest-help">Type both complete digests below to confirm this exact plan and authority envelope.</p><p>Plan digest</p><p class="digest" data-plan-digest></p><p>Envelope digest</p><p class="digest" data-envelope-digest></p><div class="actions"><form data-action="approve-plan"><label class="field-label" for="plan-digest">Exact plan digest</label><input id="plan-digest" name="planDigest" required autocomplete="off" spellcheck="false" aria-describedby="digest-help"><label class="field-label" for="envelope-digest">Exact envelope digest</label><input id="envelope-digest" name="envelopeDigest" required autocomplete="off" spellcheck="false" aria-describedby="digest-help"><button class="primary" type="submit">Approve exact plan</button></form><form data-action="reject-plan"><label class="field-label" for="plan-reason">Rejection reason</label><input id="plan-reason" name="reason" required maxlength="2000"><button class="danger" type="submit">Reject plan</button></form></div></div></template>`;
```

- [ ] **Step 3a: Adjust the ported script's page-lifecycle boundary**

In the copied script body, the original `handoff()` function (session establishment) and the trailing `void handoff();` call move to `shell.ts` in Task 5, since the shell now owns the single page-level session for every section, not just Controls. Replace the trailing `void handoff();` line in the copied script with `window.__consoleSections=window.__consoleSections||{};window.__consoleSections.controls={refresh,connect};` so `shell.ts` can invoke this section's `refresh`/`connect` after it completes the session handoff. Keep every other line, including the `handoff` function body itself, unchanged for now — Task 5 removes the now-unused `handoff` function body from this file once the shell's copy is proven equivalent by the Task 5 tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/gateway/console/controls-section.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/controls-section.ts tests/gateway/console/controls-section.test.ts
git commit -m "Port existing goal/ticket/run/decision controls into the console shell"
```

---

### Task 4: Build the restyled Trail section

**Files:**
- Create: `src/gateway/console/trail-section.ts`
- Test: `tests/gateway/console/trail-section.test.ts`

**Interfaces:**
- Produces: `TRAIL_MARKUP: string`, `TRAIL_SCRIPT: string`. `TRAIL_MARKUP` contains the `#agenttrail-status` and `#agenttrail-frame` elements moved out of `operations-ui.ts:141` (deleted from `CONTROLS_MARKUP` in Task 3), restyled to match `Console.dc.html`'s `data-screen-label="Trail"` section (full-height flush frame instead of a bordered `.panel` box; see `Console.dc.html` lines 155-156 for the outer container: `flex:1;min-height:0;display:flex;flex-direction:column`). `TRAIL_SCRIPT` contains the `applyGatewayChange` function moved verbatim from `CONTROLS_SCRIPT` (Task 3), since that is Trail-specific status handling, not general controls behavior — remove it from `CONTROLS_SCRIPT` in this task's Step 3b.

The embedded AgentTrail page itself (the iframe's `src="/agenttrail/"` target) is untouched: same gateway proxy route (`src/gateway/loopback-gateway.ts:203`), same session-cookie handoff, same SSE-driven `gateway.degraded`/`gateway.backfill_target`/`gateway.recovered` signaling. Only the frame around it changes.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/gateway/console/trail-section.test.ts
import { describe, expect, it } from "vitest";

import { TRAIL_MARKUP, TRAIL_SCRIPT } from "../../../src/gateway/console/trail-section.js";

describe("trail section", () => {
  it("still embeds the AgentTrail evidence frame at its existing gateway route", () => {
    expect(TRAIL_MARKUP).toContain('id="agenttrail-frame"');
    expect(TRAIL_MARKUP).toContain('id="agenttrail-status"');
  });

  it("uses a flush full-height frame instead of a bordered panel, matching Console.dc.html's Trail layout", () => {
    expect(TRAIL_MARKUP).toMatch(/data-screen-label="Trail"/);
    expect(TRAIL_MARKUP).not.toContain('class="panel evidence"');
  });

  it("still relays gateway degrade/recover signals to the status indicator and reloads the frame on recovery", () => {
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.degraded"');
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.backfill_target"');
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.recovered"');
    expect(TRAIL_SCRIPT).toContain('$("agenttrail-frame").contentWindow?.location.reload()');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/gateway/console/trail-section.test.ts`
Expected: FAIL with "Cannot find module '../../../src/gateway/console/trail-section.js'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/gateway/console/trail-section.ts
export const TRAIL_MARKUP = `<div style="flex:1;min-height:0;display:flex;flex-direction:column" data-screen-label="Trail">
  <div id="agenttrail-status" class="agenttrail-status" data-tone="ok" role="status" aria-live="polite">AgentTrail is live and read-only.</div>
  <iframe id="agenttrail-frame" class="agenttrail-frame" title="AgentTrail evidence views" style="flex:1;min-height:0;border:0"></iframe>
</div>`;

export const TRAIL_SCRIPT = String.raw`const applyGatewayChange=(change)=>{const node=$("agenttrail-status");if(change.type==="gateway.degraded"){node.dataset.tone="error";setText(node,"AgentTrail unavailable. Zentra controls remain available while recovery is verified.")}if(change.type==="gateway.backfill_target"){node.dataset.tone="waiting";setText(node,"AgentTrail replacement is backfilling durable evidence.")}if(change.type==="gateway.recovered"){node.dataset.tone="ok";setText(node,"AgentTrail recovered from durable evidence and is live.");$("agenttrail-frame").contentWindow?.location.reload()}};`;
```

- [ ] **Step 3b: Remove the moved logic from `controls-section.ts`**

In `src/gateway/console/controls-section.ts`, delete the `applyGatewayChange` function definition from `CONTROLS_SCRIPT` (it now lives only in `trail-section.ts`), and delete the `#agenttrail-status`/`#agenttrail-frame` references from anywhere else in `CONTROLS_SCRIPT` that are not already gone. Re-run `tests/gateway/console/controls-section.test.ts` (Task 3) to confirm it is still green after this deletion, since none of its assertions reference `applyGatewayChange`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/gateway/console/trail-section.test.ts tests/gateway/console/controls-section.test.ts`
Expected: both PASS

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/trail-section.ts src/gateway/console/controls-section.ts tests/gateway/console/trail-section.test.ts
git commit -m "Restyle the Trail section chrome to match Console.dc.html"
```

---

### Task 5: Build the Overview section

**Files:**
- Create: `src/gateway/console/overview-section.ts`
- Test: `tests/gateway/console/overview-section.test.ts`

**Interfaces:**
- Consumes: `WorkflowRunSummary`, `WorkflowRunDetail` types from `src/surfaces/workflow-surface.ts` (already defined at lines 130-140 and 228-239) — no new backend method, per the design spec's Overview section.
- Produces: `OVERVIEW_MARKUP: string`, `renderOverview(run: WorkflowRunSummary | null, detail: WorkflowRunDetail | null): DocumentFragment` (a DOM-builder function, following the exact idiom `renderRuns`/`renderAttention` already use in the ported `CONTROLS_SCRIPT` — direct `document.createElement` calls, no template engine). This function is called from `shell.ts` (Task 6) whenever the selected run changes.

Overview shows run identity, lifecycle, and terminal outcome (available on `WorkflowRunSummary`), plus a narrative list built from the run's own attention/decision history (`WorkflowRunDetail.attention`, already returned by `getRun`) rather than a new aggregate endpoint, matching the design spec's explicit "no bespoke Overview endpoint" decision.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/gateway/console/overview-section.test.ts
import { describe, expect, it } from "vitest";

import { OVERVIEW_MARKUP } from "../../../src/gateway/console/overview-section.js";

describe("overview section", () => {
  it("declares its content region for the shell to mount into", () => {
    expect(OVERVIEW_MARKUP).toContain('data-screen-label="Overview"');
    expect(OVERVIEW_MARKUP).toContain('id="overview-root"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/gateway/console/overview-section.test.ts`
Expected: FAIL with "Cannot find module '../../../src/gateway/console/overview-section.js'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/gateway/console/overview-section.ts
export const OVERVIEW_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Overview" id="overview-root"></div>`;

export const OVERVIEW_SCRIPT = String.raw`const renderOverview=()=>{
  const host=$("overview-root");if(!host)return;host.replaceChildren();
  const run=currentRun();
  if(!run){const empty=document.createElement("p");empty.className="empty";setText(empty,"Select a run to see its overview.");host.append(empty);return}
  const heading=document.createElement("h1");setText(heading,value(run,["title","goal","summary"],value(run,["runId","id"],"Run")));
  const badgeEl=badge(label(String(value(run,["lifecycle","state","status"],"unknown"))));
  const head=document.createElement("div");head.style.cssText="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap";head.append(heading,badgeEl);
  const narrativeHeading=document.createElement("h2");setText(narrativeHeading,"What happened");
  const narrativeList=document.createElement("div");
  for(const item of state.selected?.attention||[]){
    const row=document.createElement("p");
    setText(row,value(item,["title","question","kind"],"Decision")+": "+label(String(value(item,["status","state"],"pending"))));
    narrativeList.append(row);
  }
  if((state.selected?.attention||[]).length===0){const empty=document.createElement("p");empty.className="empty";setText(empty,"No attention history yet for this run.");narrativeList.append(empty)}
  host.append(head,narrativeHeading,narrativeList);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.overview={render:renderOverview};`;
```

- [ ] **Step 3a: Wire `renderOverview` to actually run when the selection changes**

Without this step, `renderOverview` is defined but never called, and Overview would show stale or empty content whenever the selected run changes. In `src/gateway/console/controls-section.ts`, find the `selectRun` function inside `CONTROLS_SCRIPT` (ported from `operations-ui.ts:113`, currently ending in `...renderDecision();if(announce)status(...)`), and add a call to the Overview hook right after `renderDecision();`:

```javascript
const selectRun=async(id,announce=true,decisionId=null)=>{const base="/api/v1/zentra/runs/"+encodeURIComponent(id);state.selected=await request(base);state.attention=list(state.selected,["attention"]).filter(item=>item.status==="pending");state.history=list(state.selected,["decisions"]).filter(item=>item.status!=="pending");renderRuns();renderRun();renderAttention();renderHistory();state.decision=decisionId?await request("/api/v1/zentra/decisions/"+encodeURIComponent(decisionId)).catch(()=>null):null;renderDecision();window.__consoleSections.overview?.render?.();if(announce)status("Loaded run "+id+".","ok")};
```

Also add the same call at the end of `refresh()` (immediately before its closing brace), since `refresh()` re-renders Runs/attention on the SSE change tick even when the selected run id does not change:

```javascript
const refresh=async()=>{const interaction=captureInteraction();const result=await request("/api/v1/zentra/runs");state.runs=list(result,["runs","items"]);renderRuns();if(state.selected){const id=value(currentRun(),["runId","id"]);await selectRun(id,false,interaction.decisionId)}else if(state.runs.length){await selectRun(value(state.runs[0],["runId","id"]),false,interaction.decisionId)}restoreInteraction(interaction);window.__consoleSections.overview?.render?.()};
```

Note `refresh()` already calls `selectRun`, which now also calls the Overview hook — the extra call in `refresh()` only matters for the zero-runs case where `selectRun` is never reached. Add a test to `tests/gateway/console/controls-section.test.ts` (Task 3's file) confirming the wiring survives:

```typescript
it("notifies the Overview section whenever the selected run changes", () => {
  expect(CONTROLS_SCRIPT).toContain("window.__consoleSections.overview?.render?.()");
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/gateway/console/overview-section.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/overview-section.ts tests/gateway/console/overview-section.test.ts
git commit -m "Add the Overview section, composed from existing run data"
```

---

### Task 6: Build the sidebar shell

**Files:**
- Create: `src/gateway/console/shell.ts`
- Test: `tests/gateway/console/shell.test.ts`

**Interfaces:**
- Consumes: `CONTROLS_MARKUP`/`CONTROLS_SCRIPT` (Task 3), `TRAIL_MARKUP`/`TRAIL_SCRIPT` (Task 4), `OVERVIEW_MARKUP`/`OVERVIEW_SCRIPT` (Task 5), `CONSOLE_DESIGN_TOKENS`/`CONSOLE_FONT_STACK_SANS`/`CONSOLE_FONT_STACK_MONO` (Task 2).
- Produces: `SHELL_MARKUP: string`, `SHELL_SCRIPT: string`. `SHELL_SCRIPT` owns the single page-level `handoff()` (moved from `operations-ui.ts:121`, unchanged body) and the SSE `connect()`/`synchronize()` loop (moved from `operations-ui.ts:118-120`, unchanged body), and after establishing a session, calls `window.__consoleSections.controls.connect()` (the hook Task 3 Step 3a exposed) so Controls keeps working exactly as before.

The sidebar has four groups matching `Console.dc.html` lines 856-859 (`OBSERVE`, `ANALYZE`, `ZENTRA`, `CONFIG`), plus one additional group, `OPERATE`, containing a single `Controls` item — the carried-over functionality from Task 3, not part of the literal mock (see the design spec's frontend-composition correction). Only `Overview`, `Trail`, and `Controls` are enabled navigation targets in this phase; the other nine items (`Warnings`, `Security`, `Cost`, `Compare runs`, `Imports`, `Pods`, `Milestones`, `GitHub broker`, `Journal`, `Warning policies`) render as disabled entries with a "Phase 2" badge, so the full information architecture is visible immediately without claiming functionality that does not exist yet.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/gateway/console/shell.test.ts
import { describe, expect, it } from "vitest";

import { SHELL_MARKUP, SHELL_SCRIPT } from "../../../src/gateway/console/shell.js";

describe("console shell", () => {
  it("renders all twelve mock nav items plus the carried-over Controls entry, grouped correctly", () => {
    const groups: Record<string, readonly string[]> = {
      OPERATE: ["Controls"],
      OBSERVE: ["Overview", "Trail", "Warnings", "Security", "Cost"],
      ANALYZE: ["Compare runs", "Imports"],
      ZENTRA: ["Pods", "Milestones", "GitHub broker", "Journal"],
      CONFIG: ["Warning policies"],
    };
    for (const [group, items] of Object.entries(groups)) {
      expect(SHELL_MARKUP).toContain(group);
      for (const item of items) expect(SHELL_MARKUP).toContain(item);
    }
  });

  it("marks only Controls, Overview, and Trail as enabled nav targets", () => {
    for (const enabled of ["data-nav-id=\"controls\"", "data-nav-id=\"overview\"", "data-nav-id=\"trail\""]) {
      expect(SHELL_MARKUP).toContain(enabled);
    }
    expect(SHELL_MARKUP).toContain('data-nav-id="pods" disabled');
    expect(SHELL_MARKUP).toContain('data-nav-id="milestones" disabled');
    expect(SHELL_MARKUP).toContain('data-nav-id="journal" disabled');
  });

  it("owns the single page-level session handoff and wires Controls' connect hook after it", () => {
    expect(SHELL_SCRIPT).toContain("async function handoff()");
    expect(SHELL_SCRIPT).toContain("window.__consoleSections.controls.connect()");
  });

  it("never loads a font from an external host", () => {
    expect(SHELL_MARKUP).not.toMatch(/fonts\.googleapis\.com/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/gateway/console/shell.test.ts`
Expected: FAIL with "Cannot find module '../../../src/gateway/console/shell.js'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/gateway/console/shell.ts
import { CONSOLE_DESIGN_TOKENS, CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";
import { CONTROLS_MARKUP } from "./controls-section.js";
import { TRAIL_MARKUP } from "./trail-section.js";
import { OVERVIEW_MARKUP } from "./overview-section.js";

interface NavItem { readonly id: string; readonly label: string; readonly enabled: boolean; }
interface NavGroup { readonly label: string; readonly items: readonly NavItem[]; }

const NAV_GROUPS: readonly NavGroup[] = [
  { label: "OPERATE", items: [{ id: "controls", label: "Controls", enabled: true }] },
  { label: "OBSERVE", items: [
    { id: "overview", label: "Overview", enabled: true },
    { id: "trail", label: "Trail", enabled: true },
    { id: "warnings", label: "Warnings", enabled: false },
    { id: "security", label: "Security", enabled: false },
    { id: "cost", label: "Cost", enabled: false },
  ] },
  { label: "ANALYZE", items: [
    { id: "compare", label: "Compare runs", enabled: false },
    { id: "imports", label: "Imports", enabled: false },
  ] },
  { label: "ZENTRA", items: [
    { id: "pods", label: "Pods", enabled: false },
    { id: "milestones", label: "Milestones", enabled: false },
    { id: "github", label: "GitHub broker", enabled: false },
    { id: "journal", label: "Journal", enabled: false },
  ] },
  { label: "CONFIG", items: [{ id: "policies", label: "Warning policies", enabled: false }] },
];

function renderNav(): string {
  return NAV_GROUPS.map((group) => {
    const items = group.items.map((item) => item.enabled
      ? `<button type="button" class="nav-item" data-nav-id="${item.id}">${item.label}</button>`
      : `<button type="button" class="nav-item" data-nav-id="${item.id}" disabled aria-disabled="true"><span>${item.label}</span><span class="badge">Phase 2</span></button>`
    ).join("");
    return `<div class="nav-group-label">${group.label}</div>${items}`;
  }).join("");
}

export const SHELL_MARKUP = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Zentra Agent Rail Console</title>
<style>
${CONSOLE_DESIGN_TOKENS}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:${CONSOLE_FONT_STACK_SANS}}
.shell{display:flex;width:100vw;height:100vh}
.sidebar{width:216px;flex:none;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--line);overflow-y:auto}
.nav-group-label{font:600 9px ${CONSOLE_FONT_STACK_MONO};color:var(--faint);letter-spacing:1.4px;padding:12px 10px 5px}
.nav-item{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border:none;border-radius:7px;cursor:pointer;font:500 12.5px ${CONSOLE_FONT_STACK_SANS};text-align:left;background:transparent;color:var(--dim)}
.nav-item[data-active=true]{background:rgba(122,162,255,.13);color:var(--accent)}
.nav-item:disabled{cursor:not-allowed;opacity:.55}
.nav-item .badge{font:600 9px ${CONSOLE_FONT_STACK_MONO};background:var(--warn);color:#0a0e17;border-radius:8px;padding:1px 7px}
.content{flex:1;min-width:0;display:flex;flex-direction:column}
.section{display:none}
.section[data-active=true]{display:flex;flex:1;min-height:0;flex-direction:column}
</style></head><body>
<div class="shell" data-ready="false">
  <aside class="sidebar" role="navigation" aria-label="Console sections">${renderNav()}</aside>
  <div class="content">
    <p id="status" role="status" aria-live="polite">Establishing secure local session.</p>
    <section class="section" data-section-id="controls">${CONTROLS_MARKUP}</section>
    <section class="section" data-section-id="overview">${OVERVIEW_MARKUP}</section>
    <section class="section" data-section-id="trail">${TRAIL_MARKUP}</section>
  </div>
</div>
</body></html>`;

export const SHELL_SCRIPT = String.raw`
const setActiveSection=(id)=>{
  for(const button of document.querySelectorAll(".nav-item")) button.dataset.active=String(button.dataset.navId===id);
  for(const section of document.querySelectorAll(".section")) section.dataset.active=String(section.dataset.sectionId===id);
};
for(const button of document.querySelectorAll(".nav-item:not(:disabled)")){
  button.addEventListener("click",()=>setActiveSection(button.dataset.navId));
}
setActiveSection("controls");
async function handoff(){
  const fragment=location.hash;history.replaceState(null,"","/");document.documentElement.dataset.location=location.href;
  const token=fragment.startsWith("#token=")?decodeURIComponent(fragment.slice(7)):"";
  if(!token){status("This page needs a fresh one-time launch link.","error");return}
  try{
    const session=await fetch("/api/v1/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token}),credentials:"same-origin",cache:"no-store"});
    const result=await session.json();if(!session.ok)throw new Error(result.error||"session_failed");
    window.__consoleSections=window.__consoleSections||{};
    window.__consoleSections.controls?.setSession?.(result.bearerToken,result.csrfToken);
    document.querySelector(".shell").dataset.ready="true";document.documentElement.dataset.ready="true";
    await window.__consoleSections.controls?.connect?.();
  }catch(error){status("Session unavailable: "+error.message+".","error")}
}
void handoff();`;
```

- [ ] **Step 3a: Wire `controls-section.ts`'s exposed hook to accept the session from the shell**

In `src/gateway/console/controls-section.ts`, change the `window.__consoleSections.controls={refresh,connect}` line from Task 3 Step 3a to also accept the bearer/csrf tokens the shell now owns:

```javascript
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.controls={
  refresh,
  connect,
  setSession:(bearer,csrf)=>{state.bearer=bearer;state.csrf=csrf}
};
```

Delete the now-dead `handoff` function body from `CONTROLS_SCRIPT` entirely (it is fully superseded by `SHELL_SCRIPT`'s copy) and delete its `void handoff();` call site.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/gateway/console/shell.test.ts tests/gateway/console/controls-section.test.ts`
Expected: both PASS

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/shell.ts src/gateway/console/controls-section.ts tests/gateway/console/shell.test.ts
git commit -m "Add the console sidebar shell and move session handoff to it"
```

---

### Task 7: Compose the full console document

**Files:**
- Create: `src/gateway/console/console-ui.ts`
- Test: `tests/gateway/console/console-ui.test.ts`

**Interfaces:**
- Consumes: `SHELL_MARKUP`, `SHELL_SCRIPT` (Task 6), `CONTROLS_SCRIPT` (Task 3), `TRAIL_SCRIPT` (Task 4), `OVERVIEW_SCRIPT` (Task 5).
- Produces: `consoleHtml(): string`, `CONSOLE_SCRIPT_SHA256: string` — the direct replacements for `operationsHtml()` and `OPERATIONS_SCRIPT_SHA256` that `loopback-gateway.ts` currently imports from `operations-ui.js` (Task 8 wires this in).

The composed script is the concatenation of `CONTROLS_SCRIPT`, `TRAIL_SCRIPT`, `OVERVIEW_SCRIPT`, and `SHELL_SCRIPT`, in that order — Controls/Trail/Overview must define their functions and event listeners before the shell's `handoff()` runs and calls into `window.__consoleSections.controls.connect()`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/gateway/console/console-ui.test.ts
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { consoleHtml, CONSOLE_SCRIPT_SHA256 } from "../../../src/gateway/console/console-ui.js";

describe("composed console document", () => {
  it("embeds a single inline script whose digest matches the exported CSP hash", () => {
    const html = consoleHtml();
    const match = /<script>([\s\S]*)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const digest = createHash("sha256").update(match![1]!, "utf8").digest("base64");
    expect(digest).toBe(CONSOLE_SCRIPT_SHA256);
  });

  it("includes every section's markup and preserves controls' DOM ids", () => {
    const html = consoleHtml();
    expect(html).toContain('id="goal-form"');
    expect(html).toContain('id="agenttrail-frame"');
    expect(html).toContain('id="overview-root"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/gateway/console/console-ui.test.ts`
Expected: FAIL with "Cannot find module '../../../src/gateway/console/console-ui.js'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/gateway/console/console-ui.ts
import { createHash } from "node:crypto";

import { SHELL_MARKUP, SHELL_SCRIPT } from "./shell.js";
import { CONTROLS_SCRIPT } from "./controls-section.js";
import { TRAIL_SCRIPT } from "./trail-section.js";
import { OVERVIEW_SCRIPT } from "./overview-section.js";

const CONSOLE_SCRIPT = `(()=>{"use strict";${CONTROLS_SCRIPT}\n${TRAIL_SCRIPT}\n${OVERVIEW_SCRIPT}\n${SHELL_SCRIPT}})();`;

export const CONSOLE_SCRIPT_SHA256 = createHash("sha256").update(CONSOLE_SCRIPT, "utf8").digest("base64");

export function consoleHtml(): string {
  return SHELL_MARKUP.replace("</body></html>", `<script>${CONSOLE_SCRIPT}</script></body></html>`);
}
```

Note: `CONTROLS_SCRIPT` as ported in Task 3 is itself wrapped in its own `(()=>{"use strict"; ... })();` IIFE. Before this task, unwrap that outer IIFE from `CONTROLS_SCRIPT` in `controls-section.ts` (delete the leading `(()=>{\n"use strict";` and trailing `\n})();`), since `console-ui.ts` now supplies the single top-level IIFE for the whole composed script. Re-run Task 3's and Task 6's tests after this edit to confirm both still pass, since neither asserts on the outer-IIFE wrapper text.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/gateway/console/console-ui.test.ts tests/gateway/console/controls-section.test.ts tests/gateway/console/shell.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/console-ui.ts src/gateway/console/controls-section.ts tests/gateway/console/console-ui.test.ts
git commit -m "Compose the console shell and sections into one served document"
```

---

### Task 8: Wire the gateway to serve the new console and delete the old page

**Files:**
- Modify: `src/gateway/loopback-gateway.ts:17` (import), `src/gateway/loopback-gateway.ts:220-224` (`serveUi`)
- Delete: `src/gateway/operations-ui.ts`
- Delete: `tests/gateway/operations-ui.test.ts` (fully superseded by `tests/gateway/console/*.test.ts` from Tasks 1 and 3)
- Test: extend `tests/gateway/service-events.test.ts` or the nearest existing gateway-serving test (whichever already exercises `GET /` — confirm with `grep -rn "serveUi\|GET.*'/'\|pathname === \"/\"" tests/gateway/*.test.ts` before editing) to assert the response now contains `Zentra Agent Rail Console` instead of `Zentra Operations`.

**Interfaces:**
- Consumes: `consoleHtml`, `CONSOLE_SCRIPT_SHA256` from `./console/console-ui.js`.

- [ ] **Step 1: Write the failing assertion**

In whichever existing test file already sends `GET /` against a running `LoopbackGateway` (found via the grep above), change the assertion from expecting `"Zentra Operations"` (or similar operations-ui-specific text) to:

```typescript
expect(body).toContain("Zentra Agent Rail Console");
expect(response.headers["content-security-policy"]).toContain(`sha256-${CONSOLE_SCRIPT_SHA256}`);
```

adding `import { CONSOLE_SCRIPT_SHA256 } from "../../src/gateway/console/console-ui.js";` to that file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run <that test file>`
Expected: FAIL — the page still says "Zentra Operations" and the CSP still references `OPERATIONS_SCRIPT_SHA256`.

- [ ] **Step 3: Update the gateway**

In `src/gateway/loopback-gateway.ts:17`, replace:

```typescript
import { OPERATIONS_SCRIPT_SHA256, operationsHtml } from "./operations-ui.js";
```

with:

```typescript
import { CONSOLE_SCRIPT_SHA256, consoleHtml } from "./console/console-ui.js";
```

In `serveUi()` (`src/gateway/loopback-gateway.ts:220-224`), replace both identifiers:

```typescript
private serveUi(response: ServerResponse): void {
  if (this.readiness !== "ready") return this.respond(response, 503, { error: "service_unavailable", status: this.readiness });
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("content-security-policy", `default-src 'none'; connect-src 'self'; frame-src 'self'; script-src 'sha256-${CONSOLE_SCRIPT_SHA256}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
  response.end(consoleHtml());
}
```

- [ ] **Step 4: Delete the superseded files**

```bash
git rm src/gateway/operations-ui.ts tests/gateway/operations-ui.test.ts
```

- [ ] **Step 5: Run the full gateway and console test suites**

Run: `pnpm vitest run tests/gateway tests/surfaces`
Expected: all PASS. If any other test file still imports from `../../src/gateway/operations-ui.js`, fix its import to the new `console/*.js` location before proceeding — search with `grep -rl "gateway/operations-ui" tests src`.

- [ ] **Step 6: Type-check**

Run: `pnpm check`
Expected: no errors, confirming no other file still references the deleted `operations-ui.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/gateway/loopback-gateway.ts
git commit -m "Serve the new Agent Rail console in place of the operations page"
```

---

### Task 9: Real-browser verification that existing flows and Trail's live SSE both survived

**Files:**
- Create: `tests/ui/console-shell.e2e.test.ts`
- Reference (unmodified, must still pass as-is): `tests/gateway/chromium-browser.e2e.test.ts`, `tests/conformance/packaged-browser-security.e2e.test.ts`, `tests/ui/chromium-acceptance.ts`

**Interfaces:**
- Consumes: `ChromiumWorkflowDriver` from `tests/ui/chromium-acceptance.ts` (`submitGoal`, `selectRun`, `cancelRun`, `answerPendingQuestion` — all unchanged, since Task 3 preserved every selector they depend on), `workflowAcceptanceFixture` or equivalent gateway-plus-workflow test fixture already used by `tests/gateway/chromium-browser.e2e.test.ts` (read that file's setup before writing this test, to reuse its exact fixture-construction pattern rather than inventing a new one).

This task is the design spec's required proof that the Trail restyle did not break live AgentTrail updates, and that Controls still works end to end through the new shell.

- [ ] **Step 1: Write the test**

This reuses the exact fixture-construction pattern from `tests/gateway/chromium-browser.e2e.test.ts:175-229` (`realBrowserWorkflow`), simplified to a plain inline-goal run instead of a hostile ticket-directory fixture, since Task 9 only needs a working run to select, not a security-hardening scenario (that is already covered by the existing file, which Task 9 leaves untouched).

```typescript
// tests/ui/console-shell.e2e.test.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LoopbackGateway } from "../../src/gateway/loopback-gateway.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { resolveProjectRevision } from "../../src/runs/project-revision.js";
import { ServiceLifecycleService } from "../../src/runs/service-lifecycle.js";
import { createLocalWorkflowSurface } from "../../src/surfaces/local-workflow.js";
import type { WorkflowSurface } from "../../src/surfaces/workflow-surface.js";
import { seedAgentTrailReady } from "../fixtures/service-ready.js";
import { ChromiumWorkflowDriver, acceptanceBrowser } from "./chromium-acceptance.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function consoleShellWorkflow(root: string): Promise<{ readonly workflow: WorkflowSurface; readonly journal: SqliteEventJournal }> {
  execFileSync("/usr/bin/git", ["init", root], { env: { HOME: root }, stdio: "ignore" });
  execFileSync("/usr/bin/git", ["config", "user.name", "Zentra Browser Test"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["config", "user.email", "zentra@example.invalid"], { cwd: root, env: { HOME: root } });
  writeFileSync(path.join(root, "README.md"), "console shell fixture\n");
  execFileSync("/usr/bin/git", ["add", "README.md"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["commit", "-m", "fixture"], { cwd: root, env: { HOME: root }, stdio: "ignore" });
  const journal = new SqliteEventJournal(path.join(root, "workflow.sqlite"));
  const process = { pid: 123, processIncarnation: `process-v2:${"d".repeat(64)}` };
  const lifecycle = new ServiceLifecycleService(journal);
  const starting = lifecycle.start({
    serviceId: "zentra-console-shell-test", process, address: { host: "127.0.0.1", port: 43_220 },
    tokenExpiresAt: "2026-07-20T13:00:00.000Z", observation: "performed", commandId: "service-start",
  });
  const agentTrail = seedAgentTrailReady(journal, { serviceId: "zentra-console-shell-test", serviceStartingEventId: starting.eventId });
  const serviceReadyEventId = lifecycle.ready({
    serviceId: "zentra-console-shell-test", process, address: { host: "127.0.0.1", port: 43_220 },
    runtimeSchemaVersion: 1, journalSchemaVersion: 2, tokenExpiresAt: "2026-07-20T13:00:00.000Z",
    observation: "performed", commandId: "service-ready", causationId: agentTrail.agentTrailReadyEventId, ...agentTrail,
  }).eventId;
  const workflow = await createLocalWorkflowSurface({
    journal, process, serviceReadyEventId, projectRoot: root, projectRevision: await resolveProjectRevision(root),
  });
  return { workflow, journal };
}

describe.skipIf(acceptanceBrowser === null)("console shell, real browser", () => {
  it("submits a goal through the Controls section inside the new shell and shows it under the run detail", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      const runId = await driver.submitGoal("Prove the console shell still submits goals");
      expect(runId).toMatch(/^run-/);
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("switches to the Trail nav item and confirms the restyled chrome still targets the embedded AgentTrail route", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-trail-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.click('[data-nav-id="trail"]');
      await driver.waitFor(`document.querySelector('[data-section-id="trail"]')?.dataset.active === "true"`);
      const frameSrc = await driver.evaluate<string>(`document.getElementById("agenttrail-frame")?.getAttribute("src") || ""`);
      expect(frameSrc).toBe("/agenttrail/");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
});
```

`ChromiumWorkflowDriver` in `tests/ui/chromium-acceptance.ts` does not yet expose `click`/`waitFor`/`evaluate` as public methods — check that file's current visibility (`private readonly cdp`, and the module-level `click`/`waitFor`/`evaluate` helper functions it already uses internally, e.g. inside `submitGoal`). If they are private, add three small public passthrough methods to `ChromiumWorkflowDriver` in this step (`async click(selector: string)`, `async waitFor(expression: string)`, `async evaluate<T>(expression: string): Promise<T>`), delegating to the existing private `this.cdp` and the file's existing module-level `click`/`waitFor`/`evaluate` functions, following the exact pattern `submitGoal`/`selectRun` already use. This is an additive, backward-compatible change — no existing test that uses `ChromiumWorkflowDriver` is affected.

- [ ] **Step 2: Run the new test**

Run: `pnpm vitest run tests/ui/console-shell.e2e.test.ts`
Expected: PASS. If it fails, the failure is diagnostic (a real selector or flow break introduced by Tasks 3-8), not a placeholder to paper over — fix the underlying section file, not the test.

- [ ] **Step 3: Run the full existing browser suite to confirm nothing else broke**

Run: `pnpm vitest run tests/gateway/chromium-browser.e2e.test.ts tests/conformance/packaged-browser-security.e2e.test.ts tests/ui`
Expected: all PASS, unmodified.

- [ ] **Step 4: Commit**

```bash
git add tests/ui/console-shell.e2e.test.ts
git commit -m "Add real-browser coverage for the new console shell"
```

---

### Task 10: Full suite, type-check, and final review pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: all PASS.

- [ ] **Step 2: Run the full type-check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 3: Confirm no dangling references to the deleted file**

Run: `grep -rl "operations-ui" src tests docs 2>/dev/null`
Expected: no output (or only this plan file and the design spec, which reference it historically).

- [ ] **Step 4: Manually verify in a real browser**

Start the gateway locally (however the project's existing manual-verification path works — check `pnpm start -- --help` or the CLI's `milestone run`/service-start command), open the session URL, and confirm: the sidebar shows all twelve mock items plus Controls, Controls/Overview/Trail are clickable and Warnings/Security/Cost/etc. are visibly disabled with a "Phase 2" badge, a goal submission still works, and the Trail section still shows live AgentTrail data.

- [ ] **Step 5: Final commit**

```bash
git status
```

If Steps 1-4 required any fixes, commit them now with a message describing what the fix addressed. If everything was already green, no commit is needed for this task.
