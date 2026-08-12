# Harness Authority and Evidence Generalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the authority and evidence layers downstream of the writer harness-agnostic, so a second `HarnessWriter` can execute end to end without further plumbing changes.

**Architecture:** Move the supervised-report brand out of `OpenCodeWriter` into a shared registry the interface layer owns. Give the durable writer receipt a harness-neutral vocabulary while still accepting OpenCode's existing literals, normalizing at the receipt boundary rather than inside writers. Parameterize the role-capability policy by expected harness so the read-only path stays pinned while the writer path follows the plan. Finish with an acceptance test that drives a fake second writer through the whole path.

**Tech Stack:** TypeScript, Node.js 24, Vitest, Zod.

## Global Constraints

- Every OpenCode path must behave identically. `--harness opencode` end to end must be unchanged. This is a refactor.
- Never use an em dash in code, comments, docs, or commit messages. Use a plain dash.
- Run `pnpm run check` (`tsc --noEmit`) after every task. It must be completely clean at the end of every task in this plan, unlike the Phase 1 plan which deliberately left errors between tasks.
- This project has no lint tooling and no `noUnusedLocals`, so `pnpm run check` will NOT catch an unused import. Verify imports by hand before committing.
- Do NOT run the full `pnpm test` suite during a task; it takes 7 to 10 minutes. Run the focused files named in each task.
- Default to writing no comments. This codebase is deliberately comment-light. Task 2 contains the single sanctioned exception.
- `docs/codebase-map.html` is auto-generated. Never hand-edit it. Regenerate with `pnpm run docs:codebase-map` once, in Task 6.
- Known-failing baseline, not your problem, do not investigate: `tests/capsule/docker-capsule.e2e.test.ts`, `tests/observability/agenttrail-fleet-api.test.ts`, `tests/orchestration/multi-writer-scheduler.e2e.test.ts`, `tests/package/package-e2e.test.ts`, `tests/ui/agenttrail-fleet-browser.e2e.test.ts`, `tests/ui/cross-surface-acceptance.e2e.test.ts`, `tests/gateway/chromium-browser.e2e.test.ts`.
- Under parallel load some timing-sensitive suites (`tests/orchestration/recovery.test.ts`, `tests/soak/soak-harness.test.ts`) show spurious timeouts. If you see one, re-run that file in isolation before concluding you broke something.
- **Stop condition.** If Task 6's acceptance test cannot pass without plumbing changes this plan does not describe, STOP and report it. That means a blocker exists that the design did not find. Do not widen the scope silently. This is the explicit lesson from Phase 1.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/harnesses/writer-brand.ts` (new) | Owns the supervised-report `WeakMap`. Exposes `brandSupervisedReport` and `isSupervisedWriterReport`. |
| `src/harnesses/opencode-writer.ts` | Loses the brand `WeakMap` and `isSupervisedOpenCodeWriterReport`; calls the shared brand instead. Keeps its own `preparedRequests` `WeakSet`. |
| `src/workspaces/path-claims.ts` | Calls the harness-agnostic brand check. Gains the neutral receipt vocabulary and the normalizing function. |
| `src/workers/role-capability-envelope.ts` | `roleModelSupports` and `assertRoleModelCapability` take an expected harness. |
| `src/agents/writer-events.ts` (moved) | Was `src/agents/opencode-writer-events.ts`. Harness-neutral evidence chain. |
| `tests/harnesses/fake-harness-writer.ts` (new) | Minimal second `HarnessWriter` used only by the Task 6 acceptance test. |

---

### Task 1: Shared writer brand registry

**Files:**
- Create: `src/harnesses/writer-brand.ts`
- Create: `tests/harnesses/writer-brand.test.ts`
- Modify: `src/harnesses/opencode-writer.ts`
- Modify: `src/workspaces/path-claims.ts`

**Interfaces:**
- Consumes: `WriterReport`, `WriterDispatchBinding` from `src/harnesses/harness-writer.js`.
- Produces: `brandSupervisedReport(report: WriterReport, binding: WriterDispatchBinding): void` and `isSupervisedWriterReport(report: WriterReport, binding: WriterDispatchBinding): boolean` from `src/harnesses/writer-brand.js`. Task 6's fake writer calls `brandSupervisedReport`.

- [ ] **Step 1: Write the failing test**

Create `tests/harnesses/writer-brand.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { brandSupervisedReport, isSupervisedWriterReport } from "../../src/harnesses/writer-brand.js";
import type { WriterDispatchBinding, WriterReport } from "../../src/harnesses/harness-writer.js";

function binding(digest: string): WriterDispatchBinding {
  return { digest } as WriterDispatchBinding;
}

function report(digest: string): WriterReport {
  return { dispatchBinding: { digest } } as WriterReport;
}

describe("writer brand registry", () => {
  it("recognizes a report it branded for the same binding", () => {
    const target = report("a".repeat(64));
    brandSupervisedReport(target, binding("a".repeat(64)));
    expect(isSupervisedWriterReport(target, binding("a".repeat(64)))).toBe(true);
  });

  it("rejects an unbranded report", () => {
    expect(isSupervisedWriterReport(report("b".repeat(64)), binding("b".repeat(64)))).toBe(false);
  });

  it("rejects a branded report checked against a different binding digest", () => {
    const target = report("c".repeat(64));
    brandSupervisedReport(target, binding("c".repeat(64)));
    expect(isSupervisedWriterReport(target, binding("d".repeat(64)))).toBe(false);
  });

  it("rejects a report whose own dispatchBinding digest disagrees with the binding", () => {
    const target = report("e".repeat(64));
    brandSupervisedReport(target, binding("f".repeat(64)));
    expect(isSupervisedWriterReport(target, binding("f".repeat(64)))).toBe(false);
  });
});
```

The fourth case is the one that matters most: it proves the check is an AND of two independent facts (the brand and the report's self-declared digest), not just a `WeakMap` hit.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/harnesses/writer-brand.test.ts`
Expected: FAIL with a module-not-found error for `src/harnesses/writer-brand.js`.

- [ ] **Step 3: Create the shared brand module**

Create `src/harnesses/writer-brand.ts`:

```ts
import type { WriterDispatchBinding, WriterReport } from "./harness-writer.js";

const supervisedReports = new WeakMap<object, string>();

export function brandSupervisedReport(report: WriterReport, binding: WriterDispatchBinding): void {
  supervisedReports.set(report, binding.digest);
}

export function isSupervisedWriterReport(report: WriterReport, binding: WriterDispatchBinding): boolean {
  return supervisedReports.get(report) === binding.digest && report.dispatchBinding.digest === binding.digest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/harnesses/writer-brand.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Migrate OpenCodeWriter to the shared brand**

Modify `src/harnesses/opencode-writer.ts`.

Delete this line (currently line 42):

```ts
const supervisedReports = new WeakMap<object, string>();
```

Leave `const preparedRequests = new WeakSet<object>();` exactly where it is. That guard is per-writer and stays.

Add to the imports:

```ts
import { brandSupervisedReport } from "./writer-brand.js";
```

Replace the branding call (currently line 127) inside `execute`:

```ts
    supervisedReports.set(completed, prepared.binding.digest);
```

with:

```ts
    brandSupervisedReport(completed, prepared.binding);
```

Delete the whole `isSupervisedOpenCodeWriterReport` function (currently lines 132-137):

```ts
export function isSupervisedOpenCodeWriterReport(
  report: WriterReport,
  binding: WriterDispatchBinding,
): boolean {
  return supervisedReports.get(report) === binding.digest && report.dispatchBinding.digest === binding.digest;
}
```

Do not keep it as a re-export or alias. A second name for the same check invites a caller to reach for the wrong one.

After deleting it, check whether `WriterDispatchBinding` is still referenced in this file (`grep -n "WriterDispatchBinding" src/harnesses/opencode-writer.ts`). It is used by the `OpenCodeWriterDispatchBinding` type alias, so the import stays. Verify rather than assume.

- [ ] **Step 6: Point path-claims at the shared check**

Modify `src/workspaces/path-claims.ts`.

Change the import on line 15 from:

```ts
import { isSupervisedOpenCodeWriterReport } from "../harnesses/opencode-writer.js";
```

to:

```ts
import { isSupervisedWriterReport } from "../harnesses/writer-brand.js";
```

Change the call (currently line 376) from:

```ts
    if (!isSupervisedOpenCodeWriterReport(report, binding)) {
```

to:

```ts
    if (!isSupervisedWriterReport(report, binding)) {
```

- [ ] **Step 7: Confirm no stale references remain**

Run: `grep -rn "isSupervisedOpenCodeWriterReport\|supervisedReports" src tests`
Expected: hits only inside `src/harnesses/writer-brand.ts`. Any other hit is a missed reference; fix it.

- [ ] **Step 8: Verify**

Run: `pnpm run check`
Expected: completely clean, zero errors.

Run: `pnpm vitest run tests/harnesses tests/workspaces tests/orchestration/opencode-multi-file-writer.e2e.test.ts`
Expected: all pass. `tests/orchestration/opencode-multi-file-writer.e2e.test.ts` asserts that a forged report is rejected with `/not issued by the supervised/i`; that test proves the brand still works after the move and must keep passing.

- [ ] **Step 9: Commit**

```bash
git add src/harnesses/writer-brand.ts tests/harnesses/writer-brand.test.ts src/harnesses/opencode-writer.ts src/workspaces/path-claims.ts
git commit -m "Move the supervised writer report brand into a shared registry"
```

---

### Task 2: Neutral receipt vocabulary

**Files:**
- Modify: `src/workspaces/path-claims.ts`
- Create: `tests/workspaces/writer-receipt-vocabulary.test.ts`

**Interfaces:**
- Produces: `normalizeProtocolFailure(value: string | null): "invalid_output_stream" | null` and `normalizeUsageEvidence(value: string): "native" | "fallback" | "none"`, both module-private to `path-claims.ts`. Task 6's fake writer reports neutral values directly, so it exercises the pass-through branch of both.

- [ ] **Step 1: Write the failing test**

Create `tests/workspaces/writer-receipt-vocabulary.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { WriterReceiptBodySchema } from "../../src/workspaces/path-claims.js";

function receiptBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    receiptId: "11111111-1111-4111-8111-111111111111",
    claimId: "claim-1",
    ownerId: "owner-1",
    revision: "a".repeat(40),
    leaseToken: "lease-1",
    dispatchId: "dispatch-1",
    outcome: "completed",
    dispatchBindingDigest: "b".repeat(64),
    eventChain: {
      schemaVersion: 1,
      rawOutputPolicy: "not_retained",
      stdoutBytes: 0,
      stdoutSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      events: [],
      chainSha256: "c".repeat(64),
    },
    usage: {
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0,
    },
    stdoutSha256: "d".repeat(64),
    stderrSha256: "e".repeat(64),
    patchProposalDigest: null,
    startedAt: "2026-08-13T00:00:00.000Z",
    finishedAt: "2026-08-13T00:00:01.000Z",
    ...overrides,
  };
}

describe("writer receipt vocabulary", () => {
  it("accepts the neutral protocol failure value", () => {
    const parsed = WriterReceiptBodySchema.safeParse(
      receiptBody({ protocolFailure: "invalid_output_stream", usageEvidence: "native" }),
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts every neutral usage evidence value", () => {
    for (const usageEvidence of ["native", "fallback", "none"]) {
      const parsed = WriterReceiptBodySchema.safeParse(
        receiptBody({ protocolFailure: null, usageEvidence }),
      );
      expect(parsed.success, usageEvidence).toBe(true);
    }
  });

  it("still accepts pre-Phase-1.5 OpenCode literals so persisted receipts replay", () => {
    const parsed = WriterReceiptBodySchema.safeParse(
      receiptBody({ protocolFailure: "invalid_native_event_stream", usageEvidence: "native_tokens" }),
    );
    expect(parsed.success).toBe(true);
    const legacyUsage = WriterReceiptBodySchema.safeParse(
      receiptBody({ protocolFailure: null, usageEvidence: "legacy_usage" }),
    );
    expect(legacyUsage.success).toBe(true);
  });

  it("rejects a vocabulary value that belongs to neither set", () => {
    const parsed = WriterReceiptBodySchema.safeParse(
      receiptBody({ protocolFailure: "something_else", usageEvidence: "native" }),
    );
    expect(parsed.success).toBe(false);
  });
});
```

If `WriterReceiptBodySchema` is not currently exported from `path-claims.ts`, export it as part of this task. Check with `grep -n "WriterReceiptBodySchema" src/workspaces/path-claims.ts` first; if the declaration lacks `export`, add it.

The eventChain fixture above must satisfy `WriterEventChainSchema`, which validates `chainSha256` against a canonical digest of the chain body. If the empty-chain fixture fails validation for that reason, build a real one instead with `createWriterEventChain("", [])` imported from `../../src/agents/opencode-writer-events.js` and use its output verbatim. Prefer the real constructor over hand-written digests.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/workspaces/writer-receipt-vocabulary.test.ts`
Expected: the neutral-value cases FAIL, because the current schema only accepts `invalid_native_event_stream` and `native_tokens`/`legacy_usage`/`none`. The legacy case and the reject case should already pass.

- [ ] **Step 3: Widen the durable schema**

Modify `src/workspaces/path-claims.ts`. Change these two lines (currently 100-101):

```ts
  protocolFailure: z.literal("invalid_native_event_stream").nullable(),
  usageEvidence: z.enum(["native_tokens", "legacy_usage", "none"]),
```

to:

```ts
  // "invalid_native_event_stream" is retained only so pre-Phase-1.5 receipts still parse.
  // Never write it for new receipts; normalizeProtocolFailure maps it to the neutral value.
  protocolFailure: z.enum(["invalid_output_stream", "invalid_native_event_stream"]).nullable(),
  // "native_tokens" and "legacy_usage" are retained only so pre-Phase-1.5 receipts still parse.
  // Never write them for new receipts; normalizeUsageEvidence maps them to the neutral values.
  usageEvidence: z.enum(["native", "fallback", "none", "native_tokens", "legacy_usage"]),
```

These comments are the single sanctioned exception to the repository's comment-light convention. Without them, "why is this deprecated value still accepted" is unanswerable from the code.

- [ ] **Step 4: Add the normalizing functions**

Add these near the other module-private helpers at the bottom of `src/workspaces/path-claims.ts`:

```ts
function normalizeProtocolFailure(value: string | null): "invalid_output_stream" | null {
  return value === null ? null : "invalid_output_stream";
}

function normalizeUsageEvidence(value: string): "native" | "fallback" | "none" {
  if (value === "native" || value === "native_tokens") return "native";
  if (value === "fallback" || value === "legacy_usage") return "fallback";
  return "none";
}
```

`normalizeProtocolFailure` collapses every non-null failure to the single neutral value deliberately. The durable receipt records that the output stream was unusable; the harness-specific reason stays in the writer's own `WriterReport` where it is accurate and where its tests assert it.

- [ ] **Step 5: Apply the mapping at the receipt boundary**

In `[APPEND_SUPERVISED_RECEIPT]`, change the two fields in the `WriterReceiptBodySchema.parse({...})` call from:

```ts
      protocolFailure: report.protocolFailure, usageEvidence: report.usageEvidence,
```

to:

```ts
      protocolFailure: normalizeProtocolFailure(report.protocolFailure),
      usageEvidence: normalizeUsageEvidence(report.usageEvidence),
```

Do not change `OpenCodeWriter`. It keeps reporting its own accurate values in `WriterReport`; only the durable receipt is normalized.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run tests/workspaces/writer-receipt-vocabulary.test.ts`
Expected: PASS (4 tests).

Run: `pnpm vitest run tests/workspaces tests/harnesses`
Expected: all pass. Any existing test asserting a receipt's `usageEvidence` is `native_tokens` must now expect `native`; update it and say so in your report, since that is an intended vocabulary change rather than a weakened assertion.

- [ ] **Step 7: Verify and commit**

Run: `pnpm run check`
Expected: completely clean.

```bash
git add src/workspaces/path-claims.ts tests/workspaces/writer-receipt-vocabulary.test.ts
git commit -m "Give the durable writer receipt a harness-neutral vocabulary"
```

---

### Task 3: Parameterize the role capability policy

**Files:**
- Modify: `src/workers/role-capability-envelope.ts`
- Modify: `src/orchestration/writer-worktree-capsule.ts:460`
- Modify: `src/agents/opencode-read-only-agent.ts:716`
- Modify: `src/orchestration/installed-milestone.ts:405`
- Modify: `src/milestones/plan-readiness.ts:118-147`
- Create: `tests/workers/role-capability-harness.test.ts`

**Interfaces:**
- Produces: `roleModelSupports(role: GovernedRole, model: {...}, expectedHarness: string): boolean` and `assertRoleModelCapability(role: GovernedRole, model: {...}, expectedHarness: string): void`. Both gain a required third parameter.

- [ ] **Step 1: Write the failing test**

Create `tests/workers/role-capability-harness.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { roleModelSupports, roleToolPermissions } from "../../src/workers/role-capability-envelope.js";

function implementer(harness: string) {
  return {
    harness,
    roles: ["implementer"],
    toolPermissions: [...roleToolPermissions("implementer")],
    network: "denied",
  };
}

describe("roleModelSupports expected harness", () => {
  it("accepts a model whose harness matches the expectation", () => {
    expect(roleModelSupports("implementer", implementer("opencode"), "opencode")).toBe(true);
    expect(roleModelSupports("implementer", implementer("claude_code"), "claude_code")).toBe(true);
  });

  it("rejects a model whose harness differs from the expectation", () => {
    expect(roleModelSupports("implementer", implementer("claude_code"), "opencode")).toBe(false);
    expect(roleModelSupports("implementer", implementer("opencode"), "claude_code")).toBe(false);
  });

  it("still enforces the non-harness policy when the harness matches", () => {
    const wrongRole = { ...implementer("opencode"), roles: ["reviewer"] };
    expect(roleModelSupports("implementer", wrongRole, "opencode")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/workers/role-capability-harness.test.ts`
Expected: FAIL. The two-argument function ignores the third argument, so the `claude_code`/`claude_code` case returns `false` and the `claude_code`/`opencode` case does not fail for the intended reason.

- [ ] **Step 3: Parameterize the policy functions**

Modify `src/workers/role-capability-envelope.ts`. Change:

```ts
export function roleModelSupports(role: GovernedRole, model: {
  readonly harness: string;
  readonly roles: readonly string[];
  readonly toolPermissions: readonly string[];
  readonly network: string;
}): boolean {
  const declaredResearch = (role === "planner" || role === "researcher") && model.network === "declared" &&
    sameSet(model.toolPermissions, roleToolPermissions(role, true));
  const networkDark = model.network === "denied" && sameSet(model.toolPermissions, roleToolPermissions(role));
  return model.harness === "opencode" && model.roles.includes(role) && (declaredResearch || networkDark);
}

export function assertRoleModelCapability(role: GovernedRole, model: {
  readonly harness: string;
  readonly roles: readonly string[];
  readonly toolPermissions: readonly string[];
  readonly network: string;
}): void {
  if (!roleModelSupports(role, model)) throw new Error("model does not match the canonical role capability policy");
}
```

to:

```ts
export function roleModelSupports(role: GovernedRole, model: {
  readonly harness: string;
  readonly roles: readonly string[];
  readonly toolPermissions: readonly string[];
  readonly network: string;
}, expectedHarness: string): boolean {
  const declaredResearch = (role === "planner" || role === "researcher") && model.network === "declared" &&
    sameSet(model.toolPermissions, roleToolPermissions(role, true));
  const networkDark = model.network === "denied" && sameSet(model.toolPermissions, roleToolPermissions(role));
  return model.harness === expectedHarness && model.roles.includes(role) && (declaredResearch || networkDark);
}

export function assertRoleModelCapability(role: GovernedRole, model: {
  readonly harness: string;
  readonly roles: readonly string[];
  readonly toolPermissions: readonly string[];
  readonly network: string;
}, expectedHarness: string): void {
  if (!roleModelSupports(role, model, expectedHarness)) {
    throw new Error("model does not match the canonical role capability policy");
  }
}
```

Making the parameter required rather than defaulted is deliberate: `pnpm run check` will now name every call site, so none can be forgotten.

- [ ] **Step 4: Update the internal caller in the same file**

`buildRoleCapabilityBinding` (around line 178) calls `assertRoleModelCapability(input.role, input.model)`. Read its surrounding signature to find the harness available on `input`. If `input.model.harness` is the only harness in scope, pass `input.model.harness`; that is tautological here but correct, because this function builds a binding from an already-validated model rather than checking a plan's authorization. Note in your report which value you passed and why.

- [ ] **Step 5: Update the read-only path call sites**

These three pass the literal `"opencode"`, making their existing pinned constraint explicit. They must not be loosened.

`src/agents/opencode-read-only-agent.ts:716`, change:

```ts
    model === undefined || !roleModelSupports(role, model) ||
```

to:

```ts
    model === undefined || !roleModelSupports(role, model, "opencode") ||
```

`src/orchestration/installed-milestone.ts:405`, change:

```ts
  const matches = models.models.filter((model) => roleModelSupports(role, model));
```

to:

```ts
  const matches = models.models.filter((model) => roleModelSupports(role, model, "opencode"));
```

This is `exactRole`, which selects the capability for each of the four roles from the model sheet. Passing `"opencode"` here preserves today's behavior exactly. Widening it belongs to Phase 2, when a `claude_code` implementer capability can actually execute.

- [ ] **Step 6: Update the writer path call site**

`src/orchestration/writer-worktree-capsule.ts:460`, change:

```ts
  assertRoleModelCapability("implementer", model);
```

to:

```ts
  assertRoleModelCapability("implementer", model, task.roleAssignment.harness);
```

Pass the task's declared harness, not `model.harness`. Passing `model.harness` would compare the model against itself and assert nothing. Passing the task's harness makes this assert that the model matches what the plan authorized.

**Then move the call so it runs after the authority `if` block, not before it.** `assertAuthority` currently reads:

```ts
  assertRoleModelCapability("implementer", model, task.roleAssignment.harness);
  if (
    task.roleAssignment.role !== "implementer" ||
    !isHarnessId(task.roleAssignment.harness) ||
    task.roleAssignment.harness !== model.harness ||
    ...
  ) {
    throw new Error("writer assignment is outside approved harness authority");
  }
```

Reorder to put the `if` block first and the `assertRoleModelCapability` call immediately after it. Both checks still run and behavior stays strict; only which one fires first changes.

Why this matters: once parameterized, `assertRoleModelCapability` also detects a harness mismatch, and running first it would throw the generic `"model does not match the canonical role capability policy"` instead of the specific `"writer assignment is outside approved harness authority"`. Two existing tests in `tests/orchestration/writer-worktree-capsule.test.ts` assert the specific message on exactly that path:

- `rejects a writer assignment whose declared harness does not match its model capability`
- `rejects a writer assignment on the fixture-only deterministic harness`

Reordering keeps the more diagnostic message on a security-relevant rejection path and leaves both tests passing unmodified, so they keep guarding what they were written to guard. Do not edit those two tests.

`task` is already in scope in `assertAuthority` via the destructuring at the top of the function. Confirm with `grep -n "const { task" src/orchestration/writer-worktree-capsule.ts`.

- [ ] **Step 7: Clean up plan-readiness**

`src/milestones/plan-readiness.ts` lines 118-119 currently read:

```ts
    packet.harness !== "opencode" ||
    context.harness !== "opencode" ||
```

Replace both lines with a single role-dependent check:

```ts
    (packet.role !== "implementer" && packet.harness !== "opencode") ||
```

**Do not simply delete the two lines.** An earlier revision of this plan said to, on the premise that lines 121 and 125 already prove all three harness values equal and so make the literal pin redundant. That premise is true about equality but wrong about what the pin was protecting. The pin was the only thing enforcing "the read-only admission path never admits a non-opencode harness." Deleting it lets a `claude_code` researcher pass admission and then crash inside `OpenCodeReadOnlyAgent.run`'s `assertAssignment` with an uncaught error, instead of producing the clean paused result the caller expects. This was found empirically during implementation by toggling the deletion on and off against `tests/agents/opencode-read-only-program.test.ts`.

The role-dependent check states the real invariant instead: only the implementer role dispatches by harness. Planner, researcher, and reviewer run on the Azure model broker inside a Docker capsule and have no harness CLI, so they must stay on `"opencode"`. The implementer may be any harness.

One check suffices rather than two, because line 121 already enforces `context.harness === packet.harness`. Validator, integrator, and verifier roles are rejected further down at line 143, so the roles reaching this point are exactly planner, researcher, implementer, and reviewer.

Then change line 147 from:

```ts
  if (!roleModelSupports(packet.role, context)) {
```

to:

```ts
  if (!roleModelSupports(packet.role, context, task.roleAssignment.harness)) {
```

`task.roleAssignment.harness` is the right source because the plan is the authority on what harness a task was authorized for. The equality checks above mean passing `packet.harness` or `context.harness` would be equivalent, but sourcing from the plan states the intent.

After this change, verify `pnpm vitest run tests/agents/opencode-read-only-program.test.ts` passes. That file is what caught the original defect, so it is the specific proof the read-only path was not loosened.

- [ ] **Step 8: Verify**

Run: `pnpm run check`
Expected: completely clean. If it names a call site this task did not list, that is a real call site the plan missed; update it and report it.

Run: `pnpm vitest run tests/workers/role-capability-harness.test.ts`
Expected: PASS (3 tests).

Run: `pnpm vitest run tests/workers tests/milestones tests/orchestration tests/agents`
Expected: all pass except the known-failing baseline files.

- [ ] **Step 9: Commit**

```bash
git add src/workers/role-capability-envelope.ts src/orchestration/writer-worktree-capsule.ts src/agents/opencode-read-only-agent.ts src/orchestration/installed-milestone.ts src/milestones/plan-readiness.ts tests/workers/role-capability-harness.test.ts
git commit -m "Take the expected harness in the role capability policy"
```

---

### Task 4: Mechanical harness sites

**Files:**
- Modify: `src/workers/worker-lifecycle.ts:25`
- Modify: `src/routing/outcome-history.ts:132`
- Modify: `src/orchestration/opencode-single-file-tracer-bullet.ts:1118-1132, 219, 1169`
- Modify: `src/orchestration/installed-milestone.ts:76-109, 425`

**Interfaces:**
- Consumes: `HarnessId`, `HARNESS_IDS` from `src/harnesses/harness-id.js`.
- Produces: `createInstalledMilestonePlan` gains a `harness: HarnessId` field on its input, used for the implementer role assignment only.

- [ ] **Step 1: Widen the worker harness enum**

Modify `src/workers/worker-lifecycle.ts`. Add to the imports:

```ts
import { HARNESS_IDS } from "../harnesses/harness-id.js";
```

Change line 25 from:

```ts
export const WorkerHarnessSchema = z.enum(["opencode", "deterministic"]);
```

to:

```ts
export const WorkerHarnessSchema = z.enum([...HARNESS_IDS, "deterministic"]);
```

Deriving from `HARNESS_IDS` rather than repeating the three ids keeps this enum from drifting. `deterministic` stays because it is the fixture-only harness used by tests and is deliberately not a member of `HarnessId`.

If Zod rejects the spread for typing reasons, use `z.enum([...HARNESS_IDS, "deterministic"] as const)` or fall back to an explicit union built from the constant; do not silently hand-write the three ids again.

- [ ] **Step 2: Widen the outcome history query**

Modify `src/routing/outcome-history.ts`. Add to the imports:

```ts
import type { HarnessId } from "../harnesses/harness-id.js";
```

Change line 132 from:

```ts
    readonly harness: "opencode";
```

to:

```ts
    readonly harness: HarnessId;
```

- [ ] **Step 3: Generalize the tracer bullet admission checks**

Modify `src/orchestration/opencode-single-file-tracer-bullet.ts`.

In `assertWriterAdmission` (around line 1118), change:

```ts
  if (task.roleAssignment.role !== "implementer" || task.roleAssignment.harness !== "opencode" ||
    task.roleAssignment.agentId !== request.model.id || task.risk.authority !== "workspace_write" ||
    request.model.harness !== "opencode" || !request.model.roles.includes("implementer") ||
```

to:

```ts
  if (task.roleAssignment.role !== "implementer" ||
    task.roleAssignment.agentId !== request.model.id || task.risk.authority !== "workspace_write" ||
    request.model.harness !== task.roleAssignment.harness || !request.model.roles.includes("implementer") ||
```

This replaces two independent literal pins with the agreement check that actually matters, matching Task 3's pattern.

A few lines below, change the probe expectation from:

```ts
  if (request.probe === null || !isVerifiedHarnessProbeReport(request.probe, {
    harness: "opencode", modelId: request.model.id, model: request.model.model,
```

to:

```ts
  if (request.probe === null || !isVerifiedHarnessProbeReport(request.probe, {
    harness: task.roleAssignment.harness, modelId: request.model.id, model: request.model.model,
```

Then find the two `harness: "opencode"` stampings at approximately lines 219 and 1169 (`grep -n 'harness: "opencode"' src/orchestration/opencode-single-file-tracer-bullet.ts`). Each builds an event payload. Change both to use the resolved harness from the task or model in scope at that point; read the surrounding function to determine which is available and prefer the task's `roleAssignment.harness` when both are. Report which you used for each.

- [ ] **Step 4: Thread the harness through plan creation**

Modify `src/orchestration/installed-milestone.ts`.

Add `harness` to `InstalledMilestonePlanInput`:

```ts
export interface InstalledMilestonePlanInput {
  readonly milestoneId: string;
  readonly projectId: string;
  readonly goal: string;
  readonly file: string;
  readonly forbiddenPaths: readonly string[];
  readonly harness: HarnessId;
  readonly plannerId: string;
  readonly researcherId: string;
  readonly implementerId: string;
  readonly reviewerId: string;
}
```

In `createInstalledMilestonePlan`, change only the implementer task's role assignment from:

```ts
      roleAssignment: { role: "implementer", agentId: input.implementerId, harness: "opencode" },
```

to:

```ts
      roleAssignment: { role: "implementer", agentId: input.implementerId, harness: input.harness },
```

Leave the planner, researcher, and reviewer assignments as `harness: "opencode"`. That is now a truthful statement that those roles run on the Azure broker path, not a placeholder.

At the `createInstalledMilestonePlan({...})` call inside `run()`, add `harness: request.harness,` to the argument object.

At `admission()` around line 425, change the hardcoded `harness: "opencode" as const` to take the resolved harness. Read the function to see whether it already receives the harness or needs a new parameter; if it needs one, add it and pass `request.harness` from the call site.

- [ ] **Step 5: Verify**

Run: `pnpm run check`
Expected: completely clean.

Run: `grep -rn '"opencode"' src/orchestration/installed-milestone.ts src/orchestration/opencode-single-file-tracer-bullet.ts src/routing/outcome-history.ts src/workers/worker-lifecycle.ts`
Expected: the only remaining hits are the three read-only role assignments in `createInstalledMilestonePlan` and the `roleModelSupports(role, model, "opencode")` call from Task 3. Anything else is a missed site; report it.

Run: `pnpm vitest run tests/orchestration tests/routing tests/workers tests/milestones`
Expected: all pass except the known-failing baseline files.

- [ ] **Step 6: Commit**

```bash
git add src/workers/worker-lifecycle.ts src/routing/outcome-history.ts src/orchestration/opencode-single-file-tracer-bullet.ts src/orchestration/installed-milestone.ts
git commit -m "Generalize the remaining hardcoded opencode harness sites"
```

---

### Task 5: Move the writer events module

**Files:**
- Move: `src/agents/opencode-writer-events.ts` to `src/agents/writer-events.ts`
- Move: `tests/agents/opencode-writer-events.test.ts` to `tests/agents/writer-events.test.ts`
- Modify: every importer

**Interfaces:**
- Produces: `WriterEventChain`, `WriterEventChainSchema`, `createWriterEventChain` from `src/agents/writer-events.js`. Same symbols, new path.

- [ ] **Step 1: Move both files with git**

```bash
git mv src/agents/opencode-writer-events.ts src/agents/writer-events.ts
git mv tests/agents/opencode-writer-events.test.ts tests/agents/writer-events.test.ts
```

Use `git mv` so the history is preserved as a rename rather than a delete plus add.

Change nothing inside either file. The symbols were already renamed to harness-neutral names in Phase 1; only the path was left behind.

- [ ] **Step 2: Update every importer**

Run: `grep -rln "opencode-writer-events" src tests`

For each file, change the import path from `opencode-writer-events.js` to `writer-events.js`, adjusting the relative prefix for the importing file's directory. At the time this plan was written the importers were `src/harnesses/harness-writer.ts`, `src/harnesses/opencode-writer.ts`, `src/workspaces/path-claims.ts`, `src/tasks/task-projection.ts`, and `tests/tasks/task-projection.test.ts`, plus the moved test file's own import of the module under test.

Re-run the grep afterward and confirm zero hits.

- [ ] **Step 3: Verify**

Run: `pnpm run check`
Expected: completely clean.

Run: `pnpm vitest run tests/agents tests/tasks tests/workspaces tests/harnesses`
Expected: all pass, same counts as before the move. This is a pure path change.

- [ ] **Step 4: Commit**

```bash
git add -A src/agents src/harnesses src/workspaces src/tasks tests/agents tests/tasks
git commit -m "Move the writer events module off its opencode-specific path"
```

---

### Task 6: Acceptance test with a fake second writer

**Files:**
- Create: `tests/harnesses/fake-harness-writer.ts`
- Create: `tests/harnesses/second-harness-acceptance.test.ts`
- Modify: `docs/codebase-map.html` (regenerated, never hand-edited)

**Interfaces:**
- Consumes: `HarnessWriter`, `WriterRequest`, `WriterReport`, `PreparedWriterRequest`, `WriterDispatchBinding` from `src/harnesses/harness-writer.js`; `brandSupervisedReport` from `src/harnesses/writer-brand.js`; `createWriterEventChain` from `src/agents/writer-events.js`.

This is the acceptance test for the whole phase. It is written last, against finished plumbing.

- [ ] **Step 1: Write the fake writer**

Create `tests/harnesses/fake-harness-writer.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";

import { createWriterEventChain } from "../../src/agents/writer-events.js";
import { brandSupervisedReport } from "../../src/harnesses/writer-brand.js";
import type {
  HarnessWriter,
  PreparedWriterRequest,
  WriterDispatchBinding,
  WriterReport,
  WriterRequest,
} from "../../src/harnesses/harness-writer.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class FakeHarnessWriter implements HarnessWriter {
  private request: WriterRequest | null = null;

  async prepare(request: WriterRequest): Promise<PreparedWriterRequest> {
    this.request = request;
    const body = {
      schemaVersion: 1 as const,
      processIncarnation: randomUUID(),
      executableSha256: sha256("fake-executable"),
      argvSha256: sha256("fake-argv"),
      packetSha256: sha256(JSON.stringify(request.packet)),
      cwdSha256: sha256(request.workspace.path),
      dispatchId: request.dispatchAuthority?.dispatchId ?? null,
      projectId: request.dispatchAuthority?.projectId ?? null,
      claimId: request.dispatchAuthority?.claimId ?? null,
      ownerId: request.dispatchAuthority?.ownerId ?? null,
      revision: request.dispatchAuthority?.revision ?? null,
      leaseToken: request.dispatchAuthority?.leaseToken ?? null,
    };
    const binding: WriterDispatchBinding = Object.freeze({
      ...body,
      digest: sha256(JSON.stringify(body)),
    });
    return Object.freeze({ binding });
  }

  async execute(prepared: PreparedWriterRequest): Promise<WriterReport> {
    if (this.request === null) throw new Error("fake harness writer was not prepared");
    const now = new Date().toISOString();
    const report: WriterReport = Object.freeze({
      outcome: "completed",
      exitCode: 0,
      executable: "/fake/harness",
      modelId: this.request.model.id,
      requestedModelSha256: sha256(this.request.model.model),
      argv: Object.freeze(["<fake-argv>"]),
      cwd: this.request.workspace.path,
      packetSha256: sha256(JSON.stringify(this.request.packet)),
      networkBoundary: Object.freeze({
        modelTools: "denied" as const,
        harnessProviderTransport: "user_os_network_authority" as const,
      }),
      stdoutSha256: sha256(""),
      stderrSha256: sha256(""),
      eventChain: createWriterEventChain("", []),
      rawOutputPolicy: "not_retained",
      protocolFailure: null,
      stdout: "",
      stderr: "",
      startedAt: now,
      finishedAt: now,
      deniedToolRequests: Object.freeze([]),
      usage: Object.freeze({
        inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0,
      }),
      usageEvidence: "native",
      patchProposal: null,
      dispatchBinding: prepared.binding,
    });
    brandSupervisedReport(report, prepared.binding);
    return report;
  }
}
```

Note it reports the neutral `usageEvidence: "native"` and brands through the shared registry. Those two facts are precisely what this phase enabled; before it, neither was possible from outside `opencode-writer.ts`.

If any field above does not match the current `WriterReport` interface, the interface is authoritative. Read `src/harnesses/harness-writer.ts` and fix the fake, do not cast with `as never` to force it through.

- [ ] **Step 2: Write the acceptance test**

Create `tests/harnesses/second-harness-acceptance.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { FakeHarnessWriter } from "./fake-harness-writer.js";
import { HarnessWriterRegistry } from "../../src/harnesses/harness-writer-registry.js";
import { isSupervisedWriterReport } from "../../src/harnesses/writer-brand.js";
import type { WriterRequest } from "../../src/harnesses/harness-writer.js";

function writerRequest(): WriterRequest {
  return {
    taskId: "task-second-harness",
    executable: "/fake/harness",
    model: {
      id: "claude-implementer",
      harness: "claude_code",
      model: "anthropic/claude-sonnet-4",
      roles: ["implementer"],
      specialties: ["coding"],
      costTier: "low",
      contextTokens: 128_000,
      maxConcurrency: 1,
      toolPermissions: ["read_repository", "write_worktree"],
      network: "denied",
      fallbackOrder: [],
      qualityHistory: { successes: 1, attempts: 1 },
    },
    workspace: { path: "/tmp/fake-worktree" },
    packet: {} as never,
    timeoutMs: 1_000,
  } as WriterRequest;
}

describe("a second harness writer", () => {
  it("is resolvable from the registry under its own harness id", () => {
    const writer = new FakeHarnessWriter();
    const registry = new HarnessWriterRegistry({ claude_code: writer });
    expect(registry.get("claude_code")).toBe(writer);
  });

  it("produces a report that the shared brand check accepts", async () => {
    const writer = new FakeHarnessWriter();
    const prepared = await writer.prepare(writerRequest());
    const report = await writer.execute(prepared);
    expect(isSupervisedWriterReport(report, prepared.binding)).toBe(true);
  });

  it("reports the neutral usage vocabulary rather than an OpenCode literal", async () => {
    const writer = new FakeHarnessWriter();
    const prepared = await writer.prepare(writerRequest());
    const report = await writer.execute(prepared);
    expect(report.usageEvidence).toBe("native");
    expect(report.protocolFailure).toBeNull();
  });
});
```

The second case is the one that would have been impossible before this phase: a writer defined entirely outside `opencode-writer.ts` producing a report that the shared supervision check accepts.

- [ ] **Step 3: Run the acceptance test**

Run: `pnpm vitest run tests/harnesses/second-harness-acceptance.test.ts`
Expected: PASS (3 tests).

**If it does not pass because something else in the plumbing still requires `"opencode"`, STOP.** Do not add plumbing changes to make it pass. Report exactly which module blocked it and why. That is the stop condition from the design's Risk section: it means a fourth blocker exists that the design did not find, and the phase needs re-scoping rather than silent widening.

- [ ] **Step 4: Regenerate the codebase map**

Run: `pnpm run docs:codebase-map`

This is the one regeneration for the whole plan, done here because Task 6 adds the last new files. Never hand-edit `docs/codebase-map.html`.

Run: `pnpm vitest run tests/docs/codebase-map.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `pnpm run check`
Expected: completely clean.

Run: `pnpm test`
Expected: only the known-failing baseline files fail. Compare the failing set against the Global Constraints list; anything new must be investigated, and if it is a timing-sensitive file, re-run it in isolation before concluding it is a regression.

- [ ] **Step 6: Commit**

```bash
git add tests/harnesses/fake-harness-writer.ts tests/harnesses/second-harness-acceptance.test.ts docs/codebase-map.html
git commit -m "Prove a second harness writer composes end to end"
```

---

## Self-Review Notes

- **Spec coverage.** Decision 1 (brand registry) is Task 1. Decision 2 (neutral vocabulary) is Task 2. Decision 3 (parameterized role capability) is Task 3. Decision 4 (mechanical sites) is Task 4, and the writer-events move it also names is Task 5. The spec's three-layer testing strategy maps to: behavior preservation (every task's verification step plus Task 6's full run), the fake second writer (Task 6), negative cases (Task 1's unbranded and mismatched-digest cases, Task 3's harness-mismatch cases), and backward compatibility (Task 2's legacy-literal case). The spec's stop condition is in the Global Constraints and repeated at Task 6 Step 3.
- **Refinement found while writing this plan.** The spec said `plan-readiness.ts:118-119` should "become a comparison between the two". Reading the file showed lines 121 and 125 already enforce exactly that, so the correct action is deleting 118-119 as redundant rather than rewriting them. Task 3 Step 7 reflects the code as it actually is.
- **Type consistency.** `brandSupervisedReport` and `isSupervisedWriterReport` are named identically in Tasks 1 and 6. `roleModelSupports(role, model, expectedHarness)` has the same three-parameter shape everywhere it appears. `normalizeProtocolFailure` and `normalizeUsageEvidence` stay module-private to `path-claims.ts` and are referenced only in Task 2.
- **Deliberate ordering.** Task 6 is last because it is the acceptance test for the phase and must run against finished plumbing. Tasks 1 and 2 both touch `path-claims.ts`, so they are sequential rather than parallelizable.
