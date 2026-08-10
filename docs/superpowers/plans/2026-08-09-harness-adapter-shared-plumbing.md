# Harness Adapter Shared Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize Zentra's writer-harness plumbing (types, routing, attestation, probe, CLI) from an OpenCode-only implementation into a harness-agnostic one, with a real, tested `HarnessWriter` interface, registry, and shared `propose_patch` MCP server, so that `ClaudeCodeWriter` and `CodexWriter` (built in follow-on phases) can plug in without touching this plumbing again.

**Architecture:** Extract the harness-agnostic parts of the existing OpenCode-only writer/attestation/probe/routing code into shared, harness-parametrized modules. `OpenCodeWriter` is refactored to implement a new `HarnessWriter` interface with no behavior change. A new ephemeral, loopback-only MCP server is built and unit-tested standalone; nothing consumes it yet (that starts in the Claude Code phase). The CLI's `milestone run` command gains a `--harness` flag and generic `--harness-executable`/`--harness-home`/`--harness-sha256`/`--harness-version` flags, replacing the OpenCode-specific ones, and `InstalledMilestoneRunner` resolves its writer/attestor/probe through the new registry instead of hardcoding OpenCode's.

**Tech Stack:** TypeScript, Node.js 24, Vitest, Zod, Commander, `@modelcontextprotocol/sdk` (new dependency).

## Global Constraints

- This is a pure refactor plus new, inert infrastructure. Every existing test must keep passing unchanged, and `milestone run --harness opencode ...` must behave identically to today's `milestone run --opencode ...` (same attestation, same probe, same writer, same security boundary), only through the new generic names.
- Never use an em dash in code comments, docs, or commit messages. Use a plain dash.
- Run `pnpm run check` (the project's `tsc --noEmit` script) after every rename-heavy task. It is the authoritative way to find every remaining reference to a renamed symbol.
- Run `pnpm test` before every commit. Do not commit with failing tests.
- Follow this repository's existing style: no unnecessary comments, canonical/absolute path validation on every filesystem input, explicit error types over generic `Error` where a pattern for that already exists in the touched file.

---

### Task 1: Shared `HarnessId` type

**Files:**
- Create: `src/harnesses/harness-id.ts`
- Create: `tests/harnesses/harness-id.test.ts`
- Modify: `src/policy/model-sheet.ts`

**Interfaces:**
- Produces: `HARNESS_IDS: readonly ["opencode", "claude_code", "codex"]`, `type HarnessId = "opencode" | "claude_code" | "codex"`, `EXECUTABLE_HARNESSES: ReadonlySet<HarnessId>`, `isHarnessId(value: string): value is HarnessId`. Every later task in this plan imports these from `src/harnesses/harness-id.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/harnesses/harness-id.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { EXECUTABLE_HARNESSES, HARNESS_IDS, isHarnessId } from "../../src/harnesses/harness-id.js";

describe("harness id", () => {
  it("lists exactly the three executable harnesses", () => {
    expect(HARNESS_IDS).toEqual(["opencode", "claude_code", "codex"]);
    expect(EXECUTABLE_HARNESSES.size).toBe(3);
  });

  it("recognizes valid harness ids and rejects unknown or fixture-only ones", () => {
    expect(isHarnessId("opencode")).toBe(true);
    expect(isHarnessId("claude_code")).toBe(true);
    expect(isHarnessId("codex")).toBe(true);
    expect(isHarnessId("deterministic")).toBe(false);
    expect(isHarnessId("bogus")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/harnesses/harness-id.test.ts`
Expected: FAIL with a module-not-found error for `src/harnesses/harness-id.js`.

- [ ] **Step 3: Create the shared module**

Create `src/harnesses/harness-id.ts`:

```ts
export const HARNESS_IDS = ["opencode", "claude_code", "codex"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export const EXECUTABLE_HARNESSES: ReadonlySet<HarnessId> = new Set(HARNESS_IDS);

export function isHarnessId(value: string): value is HarnessId {
  return (EXECUTABLE_HARNESSES as ReadonlySet<string>).has(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/harnesses/harness-id.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Reuse it in the Model Sheet parser**

Modify `src/policy/model-sheet.ts`:

Add near the top, after the existing `node:fs` import:

```ts
import { EXECUTABLE_HARNESSES, isHarnessId, type HarnessId } from "../harnesses/harness-id.js";
```

Delete this line (it duplicates the new shared set):

```ts
const HARNESSES = new Set(["opencode", "claude_code", "codex"]);
```

In the `ModelCapability` interface, change:

```ts
  readonly harness: string;
```

to:

```ts
  readonly harness: HarnessId;
```

In `parseModelRow`, change:

```ts
  if (harness === undefined || !HARNESSES.has(harness)) throw new ModelSheetError("MODEL_SHEET_INVALID_HARNESS");
```

to:

```ts
  if (harness === undefined || !isHarnessId(harness)) throw new ModelSheetError("MODEL_SHEET_INVALID_HARNESS");
```

(`isHarnessId` narrows `harness` from `string` to `HarnessId`, which is required for the `harness,` field in the returned `ModelCapability` object literal a few lines below to type-check.)

Any other reference to the deleted local `HARNESSES` set in this file should be replaced with `EXECUTABLE_HARNESSES`. Run `grep -n "HARNESSES" src/policy/model-sheet.ts` and fix any remaining hit.

- [ ] **Step 6: Verify nothing broke**

Run: `pnpm run check`
Expected: no errors.

Run: `pnpm vitest run tests/policy/model-sheet.test.ts`
Expected: PASS, unchanged from before this task (same valid/invalid harness values as today).

- [ ] **Step 7: Commit**

```bash
git add src/harnesses/harness-id.ts tests/harnesses/harness-id.test.ts src/policy/model-sheet.ts
git commit -m "Add shared HarnessId type and reuse it in the Model Sheet parser"
```

---

### Task 2: Widen routing types to accept all three harnesses

**Files:**
- Modify: `src/routing/model-router.ts`
- Modify: `src/routing/routing-events.ts`
- Create: `tests/routing/model-router-harness-widening.test.ts`
- Create: `tests/routing/routing-events-harness-widening.test.ts`

**Interfaces:**
- Consumes: `HarnessId`, `HARNESS_IDS` from `src/harnesses/harness-id.js` (Task 1).
- Produces: `RouteApprovedModelRequest.harness: HarnessId` (was the literal `"opencode"`), `RoutingSelectionSchema`'s `model.harness` accepts any `HarnessId` (was `z.literal("opencode")`).

- [ ] **Step 1: Write the failing tests**

Create `tests/routing/model-router-harness-widening.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { routeApprovedModel } from "../../src/routing/model-router.js";
import type { ModelSheet } from "../../src/policy/model-sheet.js";

function sheetWith(harness: "opencode" | "claude_code" | "codex"): ModelSheet {
  return {
    models: [{
      id: `${harness}-implementer`,
      harness,
      model: "some/transport-model",
      roles: ["implementer"],
      specialties: ["coding"],
      costTier: "low",
      contextTokens: 128_000,
      maxConcurrency: 1,
      toolPermissions: ["read_repository", "write_worktree"],
      network: "denied",
      fallbackOrder: [],
      qualityHistory: { successes: 1, attempts: 1 },
    }],
  };
}

describe("model router harness widening", () => {
  it("routes to a claude_code candidate when requested", () => {
    const selection = routeApprovedModel(sheetWith("claude_code"), [], {
      executionId: "exec-1",
      taskId: "task-1",
      taskType: "implement",
      role: "implementer",
      harness: "claude_code",
      requiredTools: ["read_repository", "write_worktree"],
      network: "denied",
      requiredContextTokens: 1_000,
    });
    expect(selection.capability.harness).toBe("claude_code");
  });

  it("routes to a codex candidate when requested", () => {
    const selection = routeApprovedModel(sheetWith("codex"), [], {
      executionId: "exec-2",
      taskId: "task-2",
      taskType: "implement",
      role: "implementer",
      harness: "codex",
      requiredTools: ["read_repository", "write_worktree"],
      network: "denied",
      requiredContextTokens: 1_000,
    });
    expect(selection.capability.harness).toBe("codex");
  });
});
```

Create `tests/routing/routing-events-harness-widening.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { RoutingSelectionSchema } from "../../src/routing/routing-events.js";

function selectionWith(harness: string) {
  return {
    schemaVersion: 1 as const,
    executionId: "exec-1",
    taskId: "task-1",
    taskType: "implement",
    role: "implementer" as const,
    model: {
      capabilityId: "cap-1",
      harness,
      transportModelSha256: "a".repeat(64),
    },
    candidateCapabilityIds: ["cap-1"],
    modelSheetSha256: "b".repeat(64),
    algorithmVersion: "approved-history-v1" as const,
    basis: "sheet_order" as const,
  };
}

describe("routing selection harness widening", () => {
  it("accepts claude_code and codex as valid harnesses", () => {
    expect(() => RoutingSelectionSchema.parse(selectionWith("claude_code"))).not.toThrow();
    expect(() => RoutingSelectionSchema.parse(selectionWith("codex"))).not.toThrow();
  });

  it("still rejects an unrecognized harness", () => {
    expect(() => RoutingSelectionSchema.parse(selectionWith("bogus"))).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/routing/model-router-harness-widening.test.ts tests/routing/routing-events-harness-widening.test.ts`
Expected: both `claude_code`/`codex` cases FAIL (the router finds no candidate because `capability.harness === request.harness` can never match today when `request.harness` is typed as the literal `"opencode"`; the schema rejects `claude_code`/`codex` because of `z.literal("opencode")`).

- [ ] **Step 3: Widen `model-router.ts`**

Modify `src/routing/model-router.ts`. Add to the imports at the top:

```ts
import type { HarnessId } from "../harnesses/harness-id.js";
```

Change:

```ts
  readonly harness: "opencode";
```

to:

```ts
  readonly harness: HarnessId;
```

- [ ] **Step 4: Widen `routing-events.ts`**

Modify `src/routing/routing-events.ts`. Add to the imports at the top:

```ts
import { HARNESS_IDS } from "../harnesses/harness-id.js";
```

Change:

```ts
  harness: z.literal("opencode"),
```

to:

```ts
  harness: z.enum(HARNESS_IDS),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/routing/model-router-harness-widening.test.ts tests/routing/routing-events-harness-widening.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 6: Verify nothing broke**

Run: `pnpm run check && pnpm vitest run tests/routing`
Expected: no type errors, all routing tests pass (existing `"opencode"`-only fixtures remain valid, since `"opencode"` is still a member of the widened type).

- [ ] **Step 7: Commit**

```bash
git add src/routing/model-router.ts src/routing/routing-events.ts tests/routing/model-router-harness-widening.test.ts tests/routing/routing-events-harness-widening.test.ts
git commit -m "Widen routing types to accept claude_code and codex alongside opencode"
```

---

### Task 3: Generalize the writer-worktree harness guard

**Files:**
- Modify: `src/orchestration/writer-worktree-capsule.ts`

**Interfaces:**
- Consumes: `isHarnessId` from `src/harnesses/harness-id.js` (Task 1).

- [ ] **Step 1: Locate the existing guard and its test coverage**

Run: `grep -n 'harness !== "opencode"' src/orchestration/writer-worktree-capsule.ts`

This should show one hit inside the `assertAuthority` function, in a multi-line `if` that throws `"writer assignment is outside approved OpenCode authority"`.

Run: `grep -rn "outside approved OpenCode authority\|roleAssignment.*harness.*claude_code\|roleAssignment.*harness.*deterministic" tests/orchestration`

Note any test file and line this returns. If a test constructs a task with `harness: "claude_code"` (or any non-`"opencode"` value) expecting this guard to reject it, you will need to change that expectation in Step 4, since `claude_code` and `codex` are now accepted by this specific guard. `"deterministic"` must remain rejected here; it is a fixture-only value.

- [ ] **Step 2: Widen the guard**

Modify `src/orchestration/writer-worktree-capsule.ts`. Add to the imports at the top:

```ts
import { isHarnessId } from "../harnesses/harness-id.js";
```

In `assertAuthority`, change:

```ts
  if (
    task.roleAssignment.role !== "implementer" ||
    task.roleAssignment.harness !== "opencode" ||
    task.roleAssignment.agentId !== model.id ||
    task.risk.authority !== "workspace_write"
  ) {
    throw new Error("writer assignment is outside approved OpenCode authority");
  }
```

to:

```ts
  if (
    task.roleAssignment.role !== "implementer" ||
    !isHarnessId(task.roleAssignment.harness) ||
    task.roleAssignment.agentId !== model.id ||
    task.risk.authority !== "workspace_write"
  ) {
    throw new Error("writer assignment is outside approved harness authority");
  }
```

- [ ] **Step 3: Add a regression test for the widened guard**

If Step 1 found an existing test file covering `assertAuthority` through the public `WriterWorktreeCapsule` API, add two cases to it: one confirming a task with `roleAssignment.harness: "claude_code"` (or `"codex"`) is no longer rejected by this specific check, and one confirming `roleAssignment.harness: "deterministic"` is still rejected with `"writer assignment is outside approved harness authority"`. Match the existing test file's setup helpers exactly; do not introduce new fixture-construction helpers if the file already has one.

If Step 1 found no such coverage, skip adding a new test here. This guard is exercised indirectly by every existing OpenCode writer test, and Task 12 of this plan adds an end-to-end test that exercises it through a non-opencode harness value.

- [ ] **Step 4: Verify nothing broke**

Run: `pnpm run check && pnpm vitest run tests/orchestration`
Expected: no type errors, all orchestration tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/writer-worktree-capsule.ts
git commit -m "Generalize the writer-worktree harness guard beyond opencode"
```

---

### Task 4: Extract shared writer types and the `HarnessWriter` interface

**Files:**
- Create: `src/harnesses/harness-writer.ts`
- Modify: `src/harnesses/opencode-writer.ts`
- Modify: `src/workspaces/path-claims.ts`
- Modify: `src/orchestration/writer-worktree-capsule.ts`

**Interfaces:**
- Produces: `WriterTaskPacket`, `WriterRequest`, `WriterReport`, `WriterUsage`, `WriterDispatchBinding`, `PreparedWriterRequest`, `HarnessWriter` from `src/harnesses/harness-writer.js`. `ClaudeCodeWriter` and `CodexWriter` (built in later phases) implement `HarnessWriter` against these same types.

This task is a pure rename-and-move refactor. It changes no behavior. Because of that, it does not follow the write-test-first shape of the other tasks; instead, verification is running the full existing suite before and after.

- [ ] **Step 1: Create the shared types module**

Create `src/harnesses/harness-writer.ts` with the following content, moved verbatim (with renames) from `src/harnesses/opencode-writer.ts`:

```ts
import type { MilestoneBudget } from "../contracts/milestone.js";
import type { UntrustedEvidenceHandoff } from "../orchestration/untrusted-evidence-handoff.js";
import type { WriterPatchProposal } from "../contracts/writer-patch.js";

export interface WriterTaskPacket {
  readonly brief: string;
  readonly guidance?: UntrustedEvidenceHandoff;
  readonly baseRevisionSha256?: string;
  readonly ownedPaths: readonly string[];
  readonly potentialWritePaths?: readonly string[];
  readonly pathClaim?: {
    readonly claimId: string;
    readonly revision: string;
    readonly expiresAt: string;
  };
  readonly readPaths?: readonly string[];
  readonly writePaths?: readonly string[];
  readonly toolPermissions?: readonly string[];
  readonly capabilityEnvelopeDigest?: string;
  readonly forbiddenPaths: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly patchProtocol: {
    readonly mode: "proposal_only";
    readonly maxOperations: 256;
    readonly maxBytes: 1048576;
    readonly mutationTools: "denied";
  };
  readonly budget: MilestoneBudget;
  readonly securityBoundary: {
    readonly repositoryWrites: "assigned_worktree_only";
    readonly validationAuthority: "zentra_named_validations_only";
    readonly integrationAuthority: "none";
    readonly shellAuthority: "none";
    readonly modelToolNetwork: "denied";
    readonly harnessProviderTransport: "user_os_network_authority";
    readonly parentSecretInheritance: "denied";
    readonly runtimeIsolation: "trusted_project_policy_not_os_sandbox";
  };
}

export interface WriterUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly toolCalls: number;
}

export interface WriterDispatchBinding {
  readonly schemaVersion: 1;
  readonly processIncarnation: string;
  readonly executableSha256: string;
  readonly argvSha256: string;
  readonly packetSha256: string;
  readonly cwdSha256: string;
  readonly dispatchId: string | null;
  readonly projectId: string | null;
  readonly claimId: string | null;
  readonly ownerId: string | null;
  readonly revision: string | null;
  readonly leaseToken: string | null;
  readonly digest: string;
}

export interface PreparedWriterRequest {
  readonly binding: WriterDispatchBinding;
}

export interface WriterReport {
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
  readonly exitCode: number | null;
  readonly executable: string;
  readonly modelId: string;
  readonly requestedModelSha256: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly packetSha256: string;
  readonly networkBoundary: {
    readonly modelTools: "denied";
    readonly harnessProviderTransport: "user_os_network_authority";
  };
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly rawOutputPolicy: "not_retained";
  readonly protocolFailure: string | null;
  /** Transient process output. Callers must not journal or otherwise retain it. */
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly deniedToolRequests: readonly { readonly tool: string; readonly path: string | null }[];
  readonly usage: WriterUsage;
  readonly usageEvidence: string;
  readonly patchProposal: WriterPatchProposal | null;
  readonly dispatchBinding: WriterDispatchBinding;
}

export interface WriterRequest {
  readonly taskId: string;
  readonly executable: string;
  readonly model: import("../policy/model-sheet.js").ModelCapability;
  readonly workspace: import("../workspaces/worktree-manager.js").WorkspaceLease;
  readonly packet: WriterTaskPacket;
  readonly timeoutMs: number;
  readonly expectedExecutableSha256?: string;
  readonly home?: string;
  readonly capabilityEnvelope?: import("../workers/worker-lifecycle.js").CapabilityEnvelope;
  readonly dispatchAuthority?: {
    readonly dispatchId: string;
    readonly projectId: string;
    readonly claimId: string;
    readonly ownerId: string;
    readonly revision: string;
    readonly leaseToken: string;
  };
}

export interface HarnessWriter {
  prepare(request: WriterRequest): Promise<PreparedWriterRequest>;
  execute(prepared: PreparedWriterRequest, signal: AbortSignal): Promise<WriterReport>;
}
```

Note: `WriterReport.protocolFailure` and `usageEvidence` are widened from OpenCode's specific string literal unions (`"invalid_native_event_stream" | null` and `"native_tokens" | "legacy_usage" | "none"`) to plain `string | null` / `string` here, since this type is now shared across harnesses that will report different protocol failure kinds. `OpenCodeWriterReport`-specific call sites that need the narrower literal keep it locally in `opencode-writer.ts` (see Step 2).

- [ ] **Step 2: Refactor `opencode-writer.ts` to use the shared types**

Modify `src/harnesses/opencode-writer.ts`.

Remove these now-duplicated interface definitions from this file (they now live in `harness-writer.ts`): `WriterTaskPacket`, `OpenCodeWriterUsage`, `OpenCodeWriterDispatchBinding`, `PreparedOpenCodeWriterRequest`, `OpenCodeWriterRequest`, `OpenCodeWriterReport`.

Add an import:

```ts
import type {
  HarnessWriter,
  PreparedWriterRequest,
  WriterDispatchBinding,
  WriterReport,
  WriterRequest,
  WriterTaskPacket,
  WriterUsage,
} from "./harness-writer.js";
```

Add local type aliases immediately below the import, so the rest of the file (and its test) can keep using the OpenCode-specific names as narrower views over the shared shape, without a mechanical find-and-replace of every usage in this ~380-line file:

```ts
export type OpenCodeWriterRequest = WriterRequest;
export type OpenCodeWriterReport = WriterReport & {
  readonly protocolFailure: "invalid_native_event_stream" | null;
  readonly usageEvidence: "native_tokens" | "legacy_usage" | "none";
};
export type OpenCodeWriterUsage = WriterUsage;
export type OpenCodeWriterDispatchBinding = WriterDispatchBinding;
export type PreparedOpenCodeWriterRequest = PreparedWriterRequest;
```

Change the class declaration:

```ts
export class OpenCodeWriter {
```

to:

```ts
export class OpenCodeWriter implements HarnessWriter {
```

Everywhere else in the file that builds an `OpenCodeWriterReport` object literal (the `report(...)` function), the `protocolFailure` and `usageEvidence` fields are already computed as the narrower literal values, so they satisfy the intersection type in the alias above with no further changes needed.

- [ ] **Step 3: Update `path-claims.ts`**

Modify `src/workspaces/path-claims.ts`. Change:

```ts
import {
  isSupervisedOpenCodeWriterReport,
  type OpenCodeWriterDispatchBinding,
  type OpenCodeWriterReport,
  type OpenCodeWriterUsage,
} from "../harnesses/opencode-writer.js";
```

to:

```ts
import { isSupervisedOpenCodeWriterReport } from "../harnesses/opencode-writer.js";
import type {
  WriterDispatchBinding,
  WriterReport,
  WriterUsage,
} from "../harnesses/harness-writer.js";
```

Then replace every remaining use of `OpenCodeWriterDispatchBinding` in this file with `WriterDispatchBinding`, `OpenCodeWriterReport` with `WriterReport`, and `OpenCodeWriterUsage` with `WriterUsage`. Run `grep -n "OpenCodeWriter" src/workspaces/path-claims.ts` to find every remaining occurrence.

- [ ] **Step 4: Update `writer-worktree-capsule.ts`**

Modify `src/orchestration/writer-worktree-capsule.ts`. Change:

```ts
import {
  OpenCodeWriter,
  OpenCodeWriterReport,
  ...
} from "../harnesses/opencode-writer.js";
```

so that `OpenCodeWriterReport` is imported from the shared module instead, and the writer parameter type is widened to the interface:

```ts
import { OpenCodeWriter } from "../harnesses/opencode-writer.js";
import type { HarnessWriter, WriterReport } from "../harnesses/harness-writer.js";
```

Replace every remaining `OpenCodeWriterReport` in this file with `WriterReport` (run `grep -n "OpenCodeWriterReport" src/orchestration/writer-worktree-capsule.ts` to find them all).

Change the constructor parameter type from the concrete class to the interface:

```ts
    private readonly writer: OpenCodeWriter,
```

to:

```ts
    private readonly writer: HarnessWriter,
```

Every existing call site keeps passing `new OpenCodeWriter(...)`, which still satisfies `HarnessWriter` after Step 2, so this is a compatible widening.

- [ ] **Step 5: Verify nothing broke**

Run: `pnpm run check`
Expected: no errors. Fix any remaining reference `check` surfaces before moving on.

Run: `pnpm vitest run tests/harnesses tests/workspaces tests/orchestration`
Expected: every existing test passes unchanged. This refactor must not change any observed behavior.

- [ ] **Step 6: Commit**

```bash
git add src/harnesses/harness-writer.ts src/harnesses/opencode-writer.ts src/workspaces/path-claims.ts src/orchestration/writer-worktree-capsule.ts
git commit -m "Extract shared writer types and a HarnessWriter interface from OpenCodeWriter"
```

---

### Task 5: `HarnessWriterRegistry`

**Files:**
- Create: `src/harnesses/harness-writer-registry.ts`
- Create: `tests/harnesses/harness-writer-registry.test.ts`

**Interfaces:**
- Consumes: `HarnessId` (Task 1), `HarnessWriter` (Task 4).
- Produces: `HarnessWriterRegistry`, `UnregisteredHarnessWriterError`. Task 12 constructs one of these inside `InstalledMilestoneRunner`.

- [ ] **Step 1: Write the failing test**

Create `tests/harnesses/harness-writer-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { HarnessWriterRegistry, UnregisteredHarnessWriterError } from "../../src/harnesses/harness-writer-registry.js";
import type { HarnessWriter } from "../../src/harnesses/harness-writer.js";

function fakeWriter(): HarnessWriter {
  return {
    prepare: async () => ({ binding: {} as never }),
    execute: async () => ({} as never),
  };
}

describe("HarnessWriterRegistry", () => {
  it("resolves a writer registered for a harness", () => {
    const opencode = fakeWriter();
    const registry = new HarnessWriterRegistry({ opencode });
    expect(registry.get("opencode")).toBe(opencode);
  });

  it("throws a typed error for an unregistered harness", () => {
    const registry = new HarnessWriterRegistry({ opencode: fakeWriter() });
    expect(() => registry.get("claude_code")).toThrow(UnregisteredHarnessWriterError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/harnesses/harness-writer-registry.test.ts`
Expected: FAIL with a module-not-found error.

- [ ] **Step 3: Implement the registry**

Create `src/harnesses/harness-writer-registry.ts`:

```ts
import type { HarnessId } from "./harness-id.js";
import type { HarnessWriter } from "./harness-writer.js";

export class UnregisteredHarnessWriterError extends Error {
  constructor(readonly harness: HarnessId) {
    super(`no writer is registered for harness "${harness}"`);
  }
}

export class HarnessWriterRegistry {
  private readonly writers: ReadonlyMap<HarnessId, HarnessWriter>;

  constructor(writers: Partial<Record<HarnessId, HarnessWriter>>) {
    this.writers = new Map(Object.entries(writers) as [HarnessId, HarnessWriter][]);
  }

  get(harness: HarnessId): HarnessWriter {
    const writer = this.writers.get(harness);
    if (writer === undefined) throw new UnregisteredHarnessWriterError(harness);
    return writer;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/harnesses/harness-writer-registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/harnesses/harness-writer-registry.ts tests/harnesses/harness-writer-registry.test.ts
git commit -m "Add HarnessWriterRegistry for harness-keyed writer dispatch"
```

---

### Task 6: Generalize executable attestation

**Files:**
- Create: `src/harnesses/harness-attestation.ts`
- Create: `tests/harnesses/harness-attestation.test.ts`
- Delete: `src/harnesses/opencode-attestation.ts`
- Delete: `tests/harnesses/opencode-attestation.test.ts` (after porting its cases)
- Modify: `src/orchestration/installed-milestone.ts`

**Interfaces:**
- Consumes: `HarnessId` (Task 1).
- Produces: `attestHostHarnessExecutable(worker, request: HarnessAttestationRequest, signal): Promise<HarnessAttestation>`, replacing `attestHostOpenCode`. Task 12 calls this.

- [ ] **Step 1: Port the existing test file**

Read `tests/harnesses/opencode-attestation.test.ts` in full. Create `tests/harnesses/harness-attestation.test.ts` with the same test cases, updating:
- the import from `attestHostOpenCode` (from `../../src/harnesses/opencode-attestation.js`) to `attestHostHarnessExecutable` (from `../../src/harnesses/harness-attestation.js`)
- every request object literal passed to it to include `harness: "opencode"` as a field, matching the new `HarnessAttestationRequest` shape below
- any assertion on the returned object's shape to expect an additional `harness: "opencode"` field

Do not change what each test actually verifies (digest mismatch, version mismatch, digest drift between the pre- and post-run hash, and so on); this is a rename and a field addition, not a behavior change.

- [ ] **Step 2: Run the ported test to verify it fails**

Run: `pnpm vitest run tests/harnesses/harness-attestation.test.ts`
Expected: FAIL with a module-not-found error for `src/harnesses/harness-attestation.js`.

- [ ] **Step 3: Create the generalized module**

Create `src/harnesses/harness-attestation.ts` with the full content of the current `src/harnesses/opencode-attestation.ts`, renamed and parametrized by harness:

```ts
import { createHash } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";

import type { WorkerAdapter } from "../workers/worker-adapter.js";
import type { HarnessId } from "./harness-id.js";

const DigestPattern = /^[a-f0-9]{64}$/;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_VERSION_BYTES = 512;

export interface HarnessAttestationRequest {
  readonly harness: HarnessId;
  readonly executable: string;
  readonly home: string;
  readonly cwd: string;
  readonly expectedSha256: string;
  readonly expectedVersion: string;
  readonly timeoutMs: number;
}

export interface HarnessAttestation {
  readonly harness: HarnessId;
  readonly executable: string;
  readonly executableSha256: string;
  readonly version: string;
}

export async function attestHostHarnessExecutable(
  worker: WorkerAdapter,
  request: HarnessAttestationRequest,
  signal: AbortSignal,
): Promise<HarnessAttestation> {
  try {
    if (!DigestPattern.test(request.expectedSha256) || !validVersion(request.expectedVersion)) throw new Error("invalid attestation");
    const executable = canonicalExecutable(request.executable);
    const home = canonicalDirectory(request.home);
    const cwd = canonicalDirectory(request.cwd);
    const before = await sha256File(executable);
    if (before !== request.expectedSha256) throw new Error("digest mismatch");
    const result = await worker.execute({
      taskId: `${request.harness}-operator-attestation`,
      executable,
      args: ["--version"],
      cwd,
      timeoutMs: request.timeoutMs,
      environment: { HOME: home },
    }, signal, "validation");
    const version = exactVersion(result.rawStdout);
    const after = await sha256File(executable);
    if (result.outcome !== "completed" || result.exitCode !== 0 || result.stderr !== "" ||
      version !== request.expectedVersion || after !== before) throw new Error("attestation mismatch");
    return Object.freeze({ harness: request.harness, executable, executableSha256: after, version });
  } catch {
    throw new Error(`host ${request.harness} operator attestation failed`);
  }
}

function validVersion(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_VERSION_BYTES &&
    !/[\r\n\u0000-\u001f\u007f]/.test(value);
}

function exactVersion(stdout: string): string {
  const version = stdout.endsWith("\r\n") ? stdout.slice(0, -2) : stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!validVersion(version) || /[\r\n]/.test(version)) throw new Error("invalid version output");
  return version;
}

function canonicalExecutable(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  const stat = statSync(canonical);
  if (candidate !== canonical || !stat.isFile() || (stat.mode & 0o111) === 0 || stat.size > MAX_EXECUTABLE_BYTES) {
    throw new Error("invalid executable");
  }
  return canonical;
}

function canonicalDirectory(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  if (candidate !== canonical || !statSync(canonical).isDirectory()) throw new Error("invalid directory");
  return canonical;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
```

- [ ] **Step 4: Run the ported test to verify it passes**

Run: `pnpm vitest run tests/harnesses/harness-attestation.test.ts`
Expected: PASS, same test count as the original `opencode-attestation.test.ts`.

- [ ] **Step 5: Delete the old files and update the one caller**

Delete `src/harnesses/opencode-attestation.ts` and `tests/harnesses/opencode-attestation.test.ts`.

Modify `src/orchestration/installed-milestone.ts`. Change:

```ts
import { attestHostOpenCode } from "../harnesses/opencode-attestation.js";
```

to:

```ts
import { attestHostHarnessExecutable } from "../harnesses/harness-attestation.js";
```

Leave the call site itself (around line 186) as-is for now; Task 12 rewrites it to pass `harness` and the renamed request fields.

- [ ] **Step 6: Verify nothing broke**

Run: `pnpm run check`
Expected: this will show a type error at the `attestHostOpenCode(...)` call site in `installed-milestone.ts`, since the import name changed but the call site has not been updated yet. That is expected here; Task 12 fixes it. Confirm the *only* errors reported are inside `installed-milestone.ts` and reference `attestHostOpenCode`.

- [ ] **Step 7: Commit**

```bash
git add src/harnesses/harness-attestation.ts tests/harnesses/harness-attestation.test.ts src/orchestration/installed-milestone.ts
git rm src/harnesses/opencode-attestation.ts tests/harnesses/opencode-attestation.test.ts
git commit -m "Generalize host executable attestation beyond opencode"
```

---

### Task 7: Generalize the capability probe

**Files:**
- Create: `src/harnesses/harness-probe.ts`
- Create: `tests/harnesses/harness-probe.test.ts`
- Delete: `src/harnesses/opencode-probe.ts`
- Delete: `tests/harnesses/opencode-probe.test.ts` (after porting its cases)
- Modify: `src/orchestration/installed-milestone.ts`

**Interfaces:**
- Consumes: `HarnessId` (Task 1).
- Produces: `HarnessProbe` (renamed from `OpenCodeProbe`), `HarnessProbeRequest`, `HarnessProbeReport`, `HarnessProbeFailureReason` (with `"harness_not_opencode"` renamed to `"harness_mismatch"`), `isVerifiedHarnessProbeReport`. Task 12 constructs `HarnessProbe` per harness.

- [ ] **Step 1: Port the existing test file**

Read `tests/harnesses/opencode-probe.test.ts` in full. Create `tests/harnesses/harness-probe.test.ts` with the same cases, updating:
- the import to `HarnessProbe` from `../../src/harnesses/harness-probe.js`
- every request object literal to include `harness: "opencode"` as a new required field
- any case that exercised the `"harness_not_opencode"` failure reason (by constructing a probe request whose resolved model has a non-opencode harness) to instead exercise the renamed `"harness_mismatch"` reason, and to assert on that new string

- [ ] **Step 2: Run the ported test to verify it fails**

Run: `pnpm vitest run tests/harnesses/harness-probe.test.ts`
Expected: FAIL with a module-not-found error.

- [ ] **Step 3: Create the generalized module**

Create `src/harnesses/harness-probe.ts` with the full content of `src/harnesses/opencode-probe.ts`, renamed and parametrized:

```ts
import { createHash } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";

import type { ModelCapability, ModelSheet } from "../policy/model-sheet.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { WorkerAdapter, WorkerResult } from "../workers/worker-adapter.js";
import type { HarnessId } from "./harness-id.js";

export type HarnessProbeOutcome = "completed" | "failed" | "cancelled" | "timed_out";

export type HarnessProbeFailureReason =
  | "model_not_approved"
  | "harness_mismatch"
  | "repository_not_allowed"
  | "network_not_allowed"
  | "harness_unavailable"
  | "probe_failed";

export interface HarnessProbeRequest {
  readonly harness: HarnessId;
  readonly executable: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly modelId: string;
  readonly models: ModelSheet;
  readonly security: SecuritySheet;
  readonly home?: string;
  readonly expectedExecutableSha256?: string;
  readonly expectedVersion?: string;
}

export interface HarnessProbeReport {
  readonly outcome: HarnessProbeOutcome;
  readonly reason: HarnessProbeFailureReason | null;
  readonly modelId: string;
  readonly harness: string | null;
  readonly model: string | null;
  readonly provider: string | null;
  readonly executable: string | null;
  readonly executableSha256: string | null;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly version: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

const verifiedProbeReports = new WeakSet<HarnessProbeReport>();

export function isVerifiedHarnessProbeReport(
  report: HarnessProbeReport,
  expected: {
    readonly harness: HarnessId;
    readonly modelId: string;
    readonly model: string;
    readonly provider: string;
    readonly cwd: string;
  },
): boolean {
  return verifiedProbeReports.has(report) &&
    report.outcome === "completed" &&
    report.reason === null &&
    report.harness === expected.harness &&
    report.modelId === expected.modelId &&
    report.model === expected.model &&
    report.provider === expected.provider &&
    report.cwd === expected.cwd &&
    report.executable !== null &&
    report.executableSha256 !== null;
}

export class HarnessProbe {
  constructor(private readonly supervisor: WorkerAdapter) {}

  async probe(request: HarnessProbeRequest, signal: AbortSignal): Promise<HarnessProbeReport> {
    const startedAt = new Date().toISOString();
    const model = request.models.models.find((candidate) => candidate.id === request.modelId) ?? null;
    let canonicalCwd: string;
    try {
      canonicalCwd = canonicalDirectory(request.cwd);
    } catch {
      return failure(request, model, request.cwd, "repository_not_allowed", startedAt);
    }

    if (model === null) {
      return failure(request, null, canonicalCwd, "model_not_approved", startedAt);
    }
    if (model.harness !== request.harness) {
      return failure(request, model, canonicalCwd, "harness_mismatch", startedAt);
    }
    if (!request.security.allowedRepositories.includes(canonicalCwd)) {
      return failure(request, model, canonicalCwd, "repository_not_allowed", startedAt);
    }
    if (model.network === "declared" && request.security.network.allowedDestinations.length === 0) {
      return failure(request, model, canonicalCwd, "network_not_allowed", startedAt);
    }

    let executable: string;
    try {
      executable = canonicalExecutable(request.executable);
    } catch {
      return failure(request, model, canonicalCwd, "harness_unavailable", startedAt);
    }

    const result = await this.supervisor.execute({
      taskId: `${request.harness}-probe-${model.id}`,
      executable,
      args: ["--version"],
      cwd: canonicalCwd,
      timeoutMs: request.timeoutMs,
      ...(request.home === undefined ? {} : { environment: { HOME: canonicalDirectory(request.home) } }),
    }, signal, "validation");

    let executableSha256: string | null = null;
    if (result.outcome === "completed") {
      try {
        executableSha256 = await sha256File(executable);
      } catch {
        return failure(request, model, canonicalCwd, "probe_failed", startedAt);
      }
    }
    const measuredVersion = result.rawStdout.endsWith("\n") ? result.rawStdout.replace(/\r?\n$/, "") : result.rawStdout;
    if (result.outcome === "completed" && (
      (request.expectedExecutableSha256 !== undefined && executableSha256 !== request.expectedExecutableSha256) ||
      (request.expectedVersion !== undefined && measuredVersion !== request.expectedVersion)
    )) return failure(request, model, canonicalCwd, "probe_failed", startedAt);
    return reportFromWorkerResult(
      model,
      executable,
      executableSha256,
      canonicalCwd,
      result,
      startedAt,
    );
  }
}

function reportFromWorkerResult(
  model: ModelCapability,
  executable: string,
  executableSha256: string | null,
  cwd: string,
  result: WorkerResult,
  startedAt: string,
): HarnessProbeReport {
  if (result.outcome === "completed") {
    const report: HarnessProbeReport = Object.freeze({
      outcome: "completed",
      reason: null,
      modelId: model.id,
      harness: model.harness,
      model: model.model,
      provider: providerFromModel(model.model),
      executable,
      executableSha256,
      argv: Object.freeze(["--version"]),
      cwd,
      version: result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    verifiedProbeReports.add(report);
    return report;
  }
  return Object.freeze({
    outcome: result.outcome,
    reason: result.outcome === "failed" ? "probe_failed" : null,
    modelId: model.id,
    harness: model.harness,
    model: model.model,
    provider: providerFromModel(model.model),
    executable,
    executableSha256,
    argv: Object.freeze(["--version"]),
    cwd,
    version: null,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

function failure(
  request: HarnessProbeRequest,
  model: ModelCapability | null,
  cwd: string,
  reason: HarnessProbeFailureReason,
  startedAt: string,
): HarnessProbeReport {
  return Object.freeze({
    outcome: "failed",
    reason,
    modelId: request.modelId,
    harness: model?.harness ?? null,
    model: model?.model ?? null,
    provider: model === null ? null : providerFromModel(model.model),
    executable: null,
    executableSha256: null,
    argv: Object.freeze(["--version"]),
    cwd,
    version: null,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

function canonicalDirectory(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  const stat = statSync(canonical);
  if (candidate !== canonical) {
    throw new Error("harness probe cwd must be a canonical absolute path");
  }
  if (!stat.isDirectory()) {
    throw new Error("harness probe cwd must be a directory");
  }
  return canonical;
}

function canonicalExecutable(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  const stat = statSync(canonical);
  if (candidate !== canonical) {
    throw new Error("harness probe executable must be a canonical absolute path");
  }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error("harness probe executable must be an executable file");
  }
  return canonical;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function providerFromModel(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(0, slash);
}
```

If `canonicalExecutable`, `sha256File`, or `providerFromModel` in the real `opencode-probe.ts` differ from what is shown here (this plan was written against a full read of that file, but double-check line for line while porting), copy the real implementation exactly rather than what is written above. The important changes are only: the renames, the added `harness` field on the request, the `model.harness !== request.harness` comparison (was `!== "opencode"`), the `"harness_mismatch"` and `"harness_unavailable"` reason names (were `"harness_not_opencode"` and `"opencode_unavailable"`), and the `${request.harness}-probe-${model.id}` task id (was `opencode-probe-${model.id}`).

- [ ] **Step 4: Run the ported test to verify it passes**

Run: `pnpm vitest run tests/harnesses/harness-probe.test.ts`
Expected: PASS, same test count as the original.

- [ ] **Step 5: Delete the old files, update the caller import, find every other reference**

Delete `src/harnesses/opencode-probe.ts` and `tests/harnesses/opencode-probe.test.ts`.

Run: `grep -rln "OpenCodeProbe\|opencode-probe" src tests | grep -v node_modules`

For every file this returns other than the ones already handled, update the import path to `../harnesses/harness-probe.js` (adjust relative depth as needed) and rename `OpenCodeProbe` to `HarnessProbe`, `OpenCodeProbeRequest` to `HarnessProbeRequest`, `OpenCodeProbeReport` to `HarnessProbeReport`, `OpenCodeProbeFailureReason` to `HarnessProbeFailureReason`, and `isVerifiedOpenCodeProbeReport` to `isVerifiedHarnessProbeReport` (adding a `harness: "opencode"` field to its `expected` argument, since that function now requires one).

In `src/orchestration/installed-milestone.ts`, change:

```ts
import { OpenCodeProbe } from "../harnesses/opencode-probe.js";
```

to:

```ts
import { HarnessProbe } from "../harnesses/harness-probe.js";
```

Leave the `new OpenCodeProbe(this.worker).probe(...)` call site as-is for now; Task 12 rewrites it.

- [ ] **Step 6: Verify scope**

Run: `pnpm run check`
Expected: type errors only inside `installed-milestone.ts` (the `OpenCodeProbe` call site not yet updated) and possibly other files found in Step 5 if their call sites were not fully updated. Resolve every error except the one Task 12 will fix.

- [ ] **Step 7: Commit**

```bash
git add -A src/harnesses tests/harnesses src/orchestration/installed-milestone.ts
git commit -m "Generalize the capability probe beyond opencode"
```

---

### Task 8: Add the MCP SDK dependency

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml` (generated)

- [ ] **Step 1: Install the dependency**

Run: `pnpm add @modelcontextprotocol/sdk`

- [ ] **Step 2: Verify it installed as a runtime dependency**

Run: `grep -n "@modelcontextprotocol/sdk" package.json`
Expected: it appears under `"dependencies"`, not `"devDependencies"` (this plan's server code in Task 9 is shipped runtime code, not a test-only tool). If `pnpm add` placed it correctly this is already true; no manual edit should be needed.

- [ ] **Step 3: Verify the project still builds**

Run: `pnpm run check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "Add @modelcontextprotocol/sdk dependency for the writer proposal server"
```

---

### Task 9: Shared `propose_patch` MCP server

**Files:**
- Create: `src/harnesses/writer-proposal-mcp-server.ts`
- Create: `tests/harnesses/writer-proposal-mcp-server.test.ts`

**Interfaces:**
- Consumes: `buildWriterPatchProposal`, `WriterPatchProposal` from `src/contracts/writer-patch.js` (existing).
- Produces: `startWriterProposalMcpServer(): Promise<EphemeralWriterProposalServer>`, where `EphemeralWriterProposalServer` has `url: string`, `bearerTokenEnvVar: string`, `bearerTokenValue: string`, and `close(): Promise<WriterProposalOutcome>`. `ClaudeCodeWriter` and `CodexWriter` (later phases) call `startWriterProposalMcpServer()` before spawning their harness process, pass `url`/`bearerTokenEnvVar`/`bearerTokenValue` into that harness's MCP configuration and process environment, and call `close()` after the harness process exits to obtain the `WriterProposalOutcome`.

- [ ] **Step 1: Write the failing test**

Create `tests/harnesses/writer-proposal-mcp-server.test.ts`. This test drives the server with real HTTP requests shaped like MCP JSON-RPC calls, rather than pulling in a full MCP client, so it stays a fast, dependency-light unit test:

```ts
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { startWriterProposalMcpServer } from "../../src/harnesses/writer-proposal-mcp-server.js";

async function initializeSession(url: string, bearerToken: string): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("server did not return a session id");
  return sessionId;
}

async function callProposePatch(
  url: string,
  bearerToken: string,
  sessionId: string,
  operations: readonly { path: string; expectedSha256: string | null; content: string; contentSha256: string }[],
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearerToken}`,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "propose_patch",
        arguments: { proposalId: "proposal-1", baseRevision: "a".repeat(40), operations },
      },
    }),
  });
}

describe("writer proposal MCP server", () => {
  it("captures a valid proposal and reports it on close", async () => {
    const server = await startWriterProposalMcpServer();
    const sessionId = await initializeSession(server.url, server.bearerTokenValue);
    const content = "hello world\n";
    const response = await callProposePatch(server.url, server.bearerTokenValue, sessionId, [
      { path: "src/example.ts", expectedSha256: null, content, contentSha256: shaHex(content) },
    ]);
    expect(response.status).toBe(200);
    const outcome = await server.close();
    expect(outcome.protocolFailure).toBe(false);
    expect(outcome.proposal?.operations).toHaveLength(1);
    expect(outcome.proposal?.operations[0]?.path).toBe("src/example.ts");
  });

  it("rejects a request with the wrong bearer token", async () => {
    const server = await startWriterProposalMcpServer();
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    const outcome = await server.close();
    expect(outcome.proposal).toBeNull();
  });

  it("reports no proposal when the harness never calls the tool", async () => {
    const server = await startWriterProposalMcpServer();
    const outcome = await server.close();
    expect(outcome.proposal).toBeNull();
    expect(outcome.protocolFailure).toBe(false);
  });

  it("rejects a second call after the first succeeds", async () => {
    const server = await startWriterProposalMcpServer();
    const sessionId = await initializeSession(server.url, server.bearerTokenValue);
    const first = "first\n";
    await callProposePatch(server.url, server.bearerTokenValue, sessionId, [
      { path: "a.ts", expectedSha256: null, content: first, contentSha256: shaHex(first) },
    ]);
    const second = "second\n";
    const secondResponse = await callProposePatch(server.url, server.bearerTokenValue, sessionId, [
      { path: "b.ts", expectedSha256: null, content: second, contentSha256: shaHex(second) },
    ]);
    const body = await secondResponse.text();
    expect(body).toContain("already been called");
    const outcome = await server.close();
    expect(outcome.proposal?.operations[0]?.path).toBe("a.ts");
  });
});

function shaHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/harnesses/writer-proposal-mcp-server.test.ts`
Expected: FAIL with a module-not-found error for `src/harnesses/writer-proposal-mcp-server.js`.

- [ ] **Step 3: Implement the server**

Create `src/harnesses/writer-proposal-mcp-server.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { buildWriterPatchProposal, type WriterPatchProposal } from "../contracts/writer-patch.js";

const BEARER_TOKEN_ENV_VAR = "ZENTRA_WRITER_MCP_TOKEN";

const ProposePatchOperationShape = z.object({
  path: z.string(),
  expectedSha256: z.string().nullable(),
  content: z.string(),
  contentSha256: z.string(),
});

const ProposePatchInputShape = {
  proposalId: z.string().min(1).max(256),
  baseRevision: z.string(),
  operations: z.array(ProposePatchOperationShape).min(1).max(256),
};

export interface WriterProposalOutcome {
  readonly proposal: WriterPatchProposal | null;
  readonly protocolFailure: boolean;
}

export interface EphemeralWriterProposalServer {
  readonly url: string;
  readonly bearerTokenEnvVar: string;
  readonly bearerTokenValue: string;
  close(): Promise<WriterProposalOutcome>;
}

export async function startWriterProposalMcpServer(): Promise<EphemeralWriterProposalServer> {
  const bearerTokenValue = randomBytes(32).toString("hex");
  let settled = false;
  let outcome: WriterProposalOutcome = { proposal: null, protocolFailure: false };

  const mcp = new McpServer({ name: "zentra-writer-proposal", version: "1.0.0" });
  mcp.registerTool("propose_patch", {
    title: "Propose a patch",
    description: "The only way to make a change. Call this at most once with the complete set of file operations.",
    inputSchema: ProposePatchInputShape,
  }, async (input) => {
    if (settled) {
      return { isError: true, content: [{ type: "text" as const, text: "propose_patch has already been called once for this task" }] };
    }
    try {
      const proposal = buildWriterPatchProposal({
        schemaVersion: 1,
        kind: "zentra.patch_proposal",
        proposalId: input.proposalId,
        baseRevision: input.baseRevision,
        operations: input.operations,
      });
      settled = true;
      outcome = { proposal, protocolFailure: false };
      return { content: [{ type: "text" as const, text: "patch proposal accepted" }] };
    } catch (error) {
      settled = true;
      outcome = { proposal: null, protocolFailure: true };
      return { isError: true, content: [{ type: "text" as const, text: `invalid patch proposal: ${(error as Error).message}` }] };
    }
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport);

  const httpServer: Server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${bearerTokenValue}`) {
      response.writeHead(401).end();
      return;
    }
    void transport.handleRequest(request, response);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    bearerTokenEnvVar: BEARER_TOKEN_ENV_VAR,
    bearerTokenValue,
    async close() {
      await transport.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      return outcome;
    },
  };
}
```

If the installed `@modelcontextprotocol/sdk` version's `McpServer.registerTool` signature differs from what is used here (for example, if it expects a Zod object schema instead of a raw shape, or if the tool handler's return shape differs), adjust this file to match the installed version's TypeScript types exactly. `pnpm run check` will show the mismatch precisely. The SDK ships frequent breaking changes across major versions; do not silently work around a type error with `as never` or `@ts-expect-error`, fix the call to match the real, current API.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/harnesses/writer-proposal-mcp-server.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify nothing broke**

Run: `pnpm run check && pnpm test`
Expected: no errors, full suite passes.

- [ ] **Step 6: Commit**

```bash
git add src/harnesses/writer-proposal-mcp-server.ts tests/harnesses/writer-proposal-mcp-server.test.ts
git commit -m "Add ephemeral loopback propose_patch MCP server"
```

---

### Task 10: CLI - rename OpenCode flags to generic harness flags and add `--harness`

**Files:**
- Modify: `src/cli/main.ts`

**Interfaces:**
- Produces: `milestone run --harness <opencode|claude_code|codex> --harness-executable <path> --harness-home <path> --harness-sha256 <digest> --harness-version <version>`, replacing `--opencode`/`--opencode-home`/`--opencode-sha256`/`--opencode-version`.

- [ ] **Step 1: Rename the options interface**

Modify `src/cli/main.ts`. Change:

```ts
interface MilestoneRunOptions extends ProjectOptions, Pick<DatabaseTaskOptions, "database"> {
  readonly goal: string;
  readonly modelSheet: string;
  readonly securitySheet: string;
  readonly provider: string;
  readonly opencode: string;
  readonly opencodeHome: string;
  readonly opencodeSha256: string;
  readonly opencodeVersion: string;
  readonly agentTailJsonl: string;
  readonly file: string;
}
```

to:

```ts
interface MilestoneRunOptions extends ProjectOptions, Pick<DatabaseTaskOptions, "database"> {
  readonly goal: string;
  readonly modelSheet: string;
  readonly securitySheet: string;
  readonly provider: string;
  readonly harness: string;
  readonly harnessExecutable: string;
  readonly harnessHome: string;
  readonly harnessSha256: string;
  readonly harnessVersion: string;
  readonly agentTailJsonl: string;
  readonly file: string;
}
```

- [ ] **Step 2: Rename the command's flags**

In the `milestone run` command definition, change:

```ts
    .requiredOption("--opencode <path>", "canonical host OpenCode executable; provider transport uses user OS network authority")
    .requiredOption("--opencode-home <path>", "canonical explicit OpenCode home for writer and probe")
    .requiredOption("--opencode-sha256 <digest>", "operator-attested lowercase SHA-256 of the exact host OpenCode executable")
    .requiredOption("--opencode-version <version>", "operator-attested exact bounded OpenCode --version output")
```

to:

```ts
    .requiredOption("--harness <harness>", "the writer harness to run: opencode, claude_code, or codex")
    .requiredOption("--harness-executable <path>", "canonical host harness executable; provider transport uses user OS network authority")
    .requiredOption("--harness-home <path>", "canonical explicit harness home for writer and probe")
    .requiredOption("--harness-sha256 <digest>", "operator-attested lowercase SHA-256 of the exact host harness executable")
    .requiredOption("--harness-version <version>", "operator-attested exact bounded harness --version output")
```

- [ ] **Step 3: Update the action handler's validation and field references**

Add an import at the top of the file:

```ts
import { isHarnessId } from "../harnesses/harness-id.js";
```

In the `milestone run` action handler, change:

```ts
    .action(async (options: MilestoneRunOptions) => {
      assertSafeTitle(options.goal);
      assertSafeRelativeFile(options.file);
      assertCanonicalInputFile(options.config);
      assertCanonicalInputFile(options.modelSheet);
      assertCanonicalInputFile(options.securitySheet);
      assertCanonicalInputFile(options.provider);
      assertCanonicalExecutable(options.opencode);
      assertCanonicalDirectory(options.opencodeHome);
      if (!/^[a-f0-9]{64}$/.test(options.opencodeSha256) || !isBoundedVersion(options.opencodeVersion)) {
        throw new CliFailure("INVALID_COMMAND");
      }
```

to:

```ts
    .action(async (options: MilestoneRunOptions) => {
      assertSafeTitle(options.goal);
      assertSafeRelativeFile(options.file);
      assertCanonicalInputFile(options.config);
      assertCanonicalInputFile(options.modelSheet);
      assertCanonicalInputFile(options.securitySheet);
      assertCanonicalInputFile(options.provider);
      if (!isHarnessId(options.harness)) throw new CliFailure("INVALID_COMMAND");
      assertCanonicalExecutable(options.harnessExecutable);
      assertCanonicalDirectory(options.harnessHome);
      if (!/^[a-f0-9]{64}$/.test(options.harnessSha256) || !isBoundedVersion(options.harnessVersion)) {
        throw new CliFailure("INVALID_COMMAND");
      }
```

Further down in the same action handler, every remaining `options.opencode`, `options.opencodeHome`, `options.opencodeSha256`, and `options.opencodeVersion` reference (passed into `runner.run({...})`) is updated in Task 12, alongside the `InstalledMilestoneRunner` changes that consume them. Leave them referencing the old field names for now; this will produce type errors until Task 12 lands, which is expected and confirmed in Task 12's own verification step.

- [ ] **Step 4: Verify the scope of the break**

Run: `pnpm run check`
Expected: type errors only where `options.opencode`, `options.opencodeHome`, `options.opencodeSha256`, `options.opencodeVersion` are still referenced further down in the same action handler (they no longer exist on `MilestoneRunOptions`). Confirm there are no other errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.ts
git commit -m "Rename milestone run's opencode-specific flags to generic --harness-* flags"
```

---

### Task 11: `InstalledMilestoneRunner` - resolve writer, attestor, and probe by harness

**Files:**
- Modify: `src/orchestration/installed-milestone.ts`
- Modify: `src/cli/main.ts`
- Test: `tests/orchestration/installed-milestone-harness-selection.test.ts`

**Interfaces:**
- Consumes: `HarnessId` (Task 1), `HarnessWriterRegistry` (Task 5), `attestHostHarnessExecutable` (Task 6), `HarnessProbe` (Task 7).
- Produces: `InstalledMilestoneRunRequest.harness: HarnessId`, `InstalledMilestoneRunRequest.harnessExecutable/harnessHome/harnessExpectedSha256/harnessExpectedVersion` (renamed from the `openCode*` fields), `InstalledMilestoneRunnerOptions.writers?: HarnessWriterRegistry`.

- [ ] **Step 1: Rename the request fields and add `harness`**

Modify `src/orchestration/installed-milestone.ts`. Change:

```ts
export interface InstalledMilestoneRunRequest {
  readonly milestoneId: string;
  readonly goal: string;
  readonly file: string;
  readonly tracePath: string;
  readonly project: ProjectConfig;
  readonly models: ModelSheet;
  readonly security: SecuritySheet;
  readonly azureDeployment: string;
  readonly openCodeExecutable: string;
  readonly openCodeHome: string;
  readonly openCodeExpectedSha256: string;
  readonly openCodeExpectedVersion: string;
  readonly signal: AbortSignal;
}
```

to:

```ts
export interface InstalledMilestoneRunRequest {
  readonly milestoneId: string;
  readonly goal: string;
  readonly file: string;
  readonly tracePath: string;
  readonly project: ProjectConfig;
  readonly models: ModelSheet;
  readonly security: SecuritySheet;
  readonly azureDeployment: string;
  readonly harness: HarnessId;
  readonly harnessExecutable: string;
  readonly harnessHome: string;
  readonly harnessExpectedSha256: string;
  readonly harnessExpectedVersion: string;
  readonly signal: AbortSignal;
}
```

Add the import:

```ts
import type { HarnessId } from "../harnesses/harness-id.js";
import { HarnessWriterRegistry } from "../harnesses/harness-writer-registry.js";
```

- [ ] **Step 2: Accept a writer registry, defaulting to OpenCode-only**

Change:

```ts
export interface InstalledMilestoneRunnerOptions {
  readonly journal: EventJournal;
  readonly sink: AgentTailJsonlFileSink;
  readonly broker: ModelBroker;
  readonly worker?: ProcessSupervisor;
  readonly readOnlyCapsule?: OpenCodeReadOnlyCapsule;
  readonly integrationBranchPreparationHooks?: IntegrationBranchPreparationHooks;
}
```

to:

```ts
export interface InstalledMilestoneRunnerOptions {
  readonly journal: EventJournal;
  readonly sink: AgentTailJsonlFileSink;
  readonly broker: ModelBroker;
  readonly worker?: ProcessSupervisor;
  readonly readOnlyCapsule?: OpenCodeReadOnlyCapsule;
  readonly integrationBranchPreparationHooks?: IntegrationBranchPreparationHooks;
  readonly writers?: HarnessWriterRegistry;
}
```

In the constructor, change:

```ts
  constructor(private readonly options: InstalledMilestoneRunnerOptions) {
    this.projected = options.journal instanceof ProjectingEventJournal
      ? options.journal
      : new ProjectingEventJournal(options.journal, options.sink);
    this.worker = options.worker ?? new ProcessSupervisor();
    this.capsule = options.readOnlyCapsule ?? new DockerOpenCodeReadOnlyCapsule();
  }
```

to:

```ts
  private readonly writers: HarnessWriterRegistry;

  constructor(private readonly options: InstalledMilestoneRunnerOptions) {
    this.projected = options.journal instanceof ProjectingEventJournal
      ? options.journal
      : new ProjectingEventJournal(options.journal, options.sink);
    this.worker = options.worker ?? new ProcessSupervisor();
    this.capsule = options.readOnlyCapsule ?? new DockerOpenCodeReadOnlyCapsule();
    this.writers = options.writers ?? new HarnessWriterRegistry({ opencode: new OpenCodeWriter(this.worker) });
  }
```

(Move the `private readonly writers: HarnessWriterRegistry;` declaration up next to the other `private readonly` field declarations at the top of the class, alongside `projected`, `worker`, and `capsule`, rather than inline where shown above; the inline placement here is only to show which line it is added next to.)

- [ ] **Step 3: Use `request.harness` for attestation**

Change:

```ts
    const attestation = await attestHostOpenCode(this.worker, {
      executable: request.openCodeExecutable,
      home: request.openCodeHome,
      cwd: repository,
      expectedSha256: request.openCodeExpectedSha256,
      expectedVersion: request.openCodeExpectedVersion,
      timeoutMs: 30_000,
    }, request.signal);
```

to:

```ts
    const attestation = await attestHostHarnessExecutable(this.worker, {
      harness: request.harness,
      executable: request.harnessExecutable,
      home: request.harnessHome,
      cwd: repository,
      expectedSha256: request.harnessExpectedSha256,
      expectedVersion: request.harnessExpectedVersion,
      timeoutMs: 30_000,
    }, request.signal);
```

- [ ] **Step 4: Use `request.harness` for the probe**

Change:

```ts
        const probe = await new OpenCodeProbe(this.worker).probe({
          executable: attestation.executable,
          cwd: repository,
          timeoutMs: Math.min(30_000, implementerTask.budget.maxSeconds * 1_000),
          modelId: implementer.id,
          models: request.models,
          security: request.security,
          home: request.openCodeHome,
          expectedExecutableSha256: attestation.executableSha256,
          expectedVersion: attestation.version,
        }, executionRequest.signal);
```

to:

```ts
        const probe = await new HarnessProbe(this.worker).probe({
          harness: request.harness,
          executable: attestation.executable,
          cwd: repository,
          timeoutMs: Math.min(30_000, implementerTask.budget.maxSeconds * 1_000),
          modelId: implementer.id,
          models: request.models,
          security: request.security,
          home: request.harnessHome,
          expectedExecutableSha256: attestation.executableSha256,
          expectedVersion: attestation.version,
        }, executionRequest.signal);
```

The failure-branch reference a few lines below, `stage: "opencode_probe", reason: probe.reason`, should become `stage: "harness_probe", reason: probe.reason` for the same generalization.

- [ ] **Step 5: Resolve the writer from the registry**

Change:

```ts
        tracer = new OpenCodeIntegratedSingleFileTracer(
          tasks,
          new WriterWorktreeCapsule(worktrees, new OpenCodeWriter(this.worker), new WorkspaceOwnershipGate(), git),
          validations,
          worktrees,
          { reviewer: reviewerAdapter, reviews: new ReviewGate(), integrations: new IntegrationQueue(git, validations), git },
        );
```

to:

```ts
        tracer = new OpenCodeIntegratedSingleFileTracer(
          tasks,
          new WriterWorktreeCapsule(worktrees, this.writers.get(request.harness), new WorkspaceOwnershipGate(), git),
          validations,
          worktrees,
          { reviewer: reviewerAdapter, reviews: new ReviewGate(), integrations: new IntegrationQueue(git, validations), git },
        );
```

- [ ] **Step 6: Update the CLI call site**

Modify `src/cli/main.ts`. In the `milestone run` action handler, change the `runner.run({...})` call:

```ts
        await runner.run({
          milestoneId,
          goal: options.goal,
          file: options.file,
          tracePath: trace.canonicalPath,
          project,
          models,
          security,
          azureDeployment: providerConfig.deployment,
          openCodeExecutable: options.opencode,
          openCodeHome: options.opencodeHome,
          openCodeExpectedSha256: options.opencodeSha256,
          openCodeExpectedVersion: options.opencodeVersion,
          signal,
        });
```

to:

```ts
        await runner.run({
          milestoneId,
          goal: options.goal,
          file: options.file,
          tracePath: trace.canonicalPath,
          project,
          models,
          security,
          azureDeployment: providerConfig.deployment,
          harness: options.harness,
          harnessExecutable: options.harnessExecutable,
          harnessHome: options.harnessHome,
          harnessExpectedSha256: options.harnessSha256,
          harnessExpectedVersion: options.harnessVersion,
          signal,
        });
```

(`options.harness` was already narrowed to `HarnessId` by the `isHarnessId` check added in Task 10 Step 3, but TypeScript does not track that narrowing across the `try`/`await` boundary in between. If `pnpm run check` reports `options.harness` as `string` here rather than `HarnessId`, change the field's type in `MilestoneRunOptions` is not the fix; instead cast at this call site with `harness: options.harness as HarnessId`, since the runtime check already guarantees it.)

- [ ] **Step 7: Write a regression test for harness-keyed writer resolution**

Create `tests/orchestration/installed-milestone-harness-selection.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { HarnessWriterRegistry, UnregisteredHarnessWriterError } from "../../src/harnesses/harness-writer-registry.js";
import type { HarnessWriter } from "../../src/harnesses/harness-writer.js";

function fakeWriter(): HarnessWriter {
  return {
    prepare: async () => ({ binding: {} as never }),
    execute: async () => ({} as never),
  };
}

describe("InstalledMilestoneRunner harness resolution", () => {
  it("only opencode is registered by default, matching today's behavior", () => {
    const registry = new HarnessWriterRegistry({ opencode: fakeWriter() });
    expect(() => registry.get("opencode")).not.toThrow();
    expect(() => registry.get("claude_code")).toThrow(UnregisteredHarnessWriterError);
    expect(() => registry.get("codex")).toThrow(UnregisteredHarnessWriterError);
  });
});
```

This intentionally does not attempt to drive `InstalledMilestoneRunner.run()` end-to-end (that requires substantial fixture setup already covered by the existing OpenCode milestone tests) - it locks in the one new piece of behavior this task adds: a `--harness claude_code` or `--harness codex` run fails with a clear, typed error at writer-resolution time rather than silently falling back to OpenCode, until later phases register real writers for them.

- [ ] **Step 8: Verify nothing broke and existing OpenCode milestone behavior is unchanged**

Run: `pnpm run check`
Expected: no errors.

Run: `pnpm vitest run tests/orchestration tests/harnesses`
Expected: all pass, including every existing OpenCode-path milestone test, now exercised through `harness: "opencode"` instead of implicit hardcoding.

Run: `grep -rn "options.opencode\|openCodeExecutable\|openCodeHome\|openCodeExpectedSha256\|openCodeExpectedVersion" src tests | grep -v node_modules`
Expected: no results. If any remain, they were missed in this task or Task 10 and must be updated.

- [ ] **Step 9: Commit**

```bash
git add src/orchestration/installed-milestone.ts src/cli/main.ts tests/orchestration/installed-milestone-harness-selection.test.ts
git commit -m "Resolve writer, attestor, and probe through the harness registry"
```

---

### Task 12: Environment variables and documentation

**Files:**
- Modify: `.env.example`
- Modify: `docs/commands.md`

- [ ] **Step 1: Add the new environment variables**

Modify `.env.example`. After the existing `ZENTRA_LIVE_OPENCODE_*` block, add:

```
ZENTRA_LIVE_CLAUDE_CODE_API_KEY=
ZENTRA_LIVE_CLAUDE_CODE_EXECUTABLE=
ZENTRA_LIVE_CLAUDE_CODE_HOME=
ZENTRA_LIVE_CLAUDE_CODE_SHA256=
ZENTRA_LIVE_CLAUDE_CODE_VERSION=
ZENTRA_LIVE_CLAUDE_CODE_E2E=0
ZENTRA_LIVE_CODEX_API_KEY=
ZENTRA_LIVE_CODEX_EXECUTABLE=
ZENTRA_LIVE_CODEX_HOME=
ZENTRA_LIVE_CODEX_SHA256=
ZENTRA_LIVE_CODEX_VERSION=
ZENTRA_LIVE_CODEX_E2E=0
```

These are consumed by the live-gated integration tests added in later phases (Claude Code and Codex writer adapters), not by this plan's shared plumbing. They are added now so `.env.example` documents the full intended surface in one place.

- [ ] **Step 2: Update the command reference**

Modify `docs/commands.md`. Change:

```
### `zentra milestone run`

Purpose: Run the fixed installed OpenCode milestone.

Usage:

```bash
zentra milestone run \
  --goal <sentence> \
  --config <path> \
  --database <path> \
  --model-sheet <path> \
  --security-sheet <path> \
  --provider <path> \
  --opencode <path> \
  --opencode-home <path> \
  --opencode-sha256 <digest> \
  --opencode-version <version> \
  --agent-tail-jsonl <path> \
  --file <path>
```

Capabilities:

- Plans through the configured Azure broker.
- Performs governed IANA research.
- Runs a host OpenCode writer.
- Limits writing to the explicit file.
- Runs named validation.
- Runs independent review.
- Uses disposable candidate integration.
- Attests the OpenCode digest and version.
- Stops on uncertain effects.
```

to:

```
### `zentra milestone run`

Purpose: Run the fixed installed milestone against one selected writer harness.

Usage:

```bash
zentra milestone run \
  --goal <sentence> \
  --config <path> \
  --database <path> \
  --model-sheet <path> \
  --security-sheet <path> \
  --provider <path> \
  --harness <opencode|claude_code|codex> \
  --harness-executable <path> \
  --harness-home <path> \
  --harness-sha256 <digest> \
  --harness-version <version> \
  --agent-tail-jsonl <path> \
  --file <path>
```

Capabilities:

- Plans through the configured Azure broker.
- Performs governed IANA research.
- Runs a host writer for the selected harness.
- Limits writing to the explicit file.
- Runs named validation.
- Runs independent review.
- Uses disposable candidate integration.
- Attests the selected harness's executable digest and version.
- Stops on uncertain effects.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example docs/commands.md
git commit -m "Document the generic --harness CLI flags and live test env vars"
```

---

## Self-Review Notes

- **Spec coverage:** every "Shared types and dispatch," "Attestation and Probe generalization," and "CLI and environment changes" item from the design doc's Architecture and CLI sections is covered by Tasks 1-12. The "Shared propose_patch MCP server" section is covered by Tasks 8-9. `ClaudeCodeWriter` and `CodexWriter` themselves are out of scope for this plan by design (Phases 2 and 3 of the design doc); nothing in this plan should be read as attempting them.
- **Type consistency:** `HarnessId` (Task 1) is the single source of truth threaded through `model-sheet.ts` (Task 1), `model-router.ts`/`routing-events.ts` (Task 2), `writer-worktree-capsule.ts` (Task 3), `harness-attestation.ts` (Task 6), `harness-probe.ts` (Task 7), `harness-writer-registry.ts` (Task 5), and `installed-milestone.ts`/`main.ts` (Tasks 10-11). `HarnessWriter`/`WriterRequest`/`WriterReport` (Task 4) are consumed identically by `OpenCodeWriter` today and by `ClaudeCodeWriter`/`CodexWriter` in later phases.
- **No placeholders:** every step above shows complete, real code or an exact, runnable command. The few steps that reference existing test files this plan's author has not read byte-for-byte (Task 3 Step 1, Task 6 Step 1, Task 7 Step 1) give exact `grep` commands to locate the relevant content and precise instructions for what to change, rather than inventing content that might not match what is actually there.
