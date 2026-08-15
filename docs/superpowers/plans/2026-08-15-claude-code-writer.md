# ClaudeCodeWriter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `ClaudeCodeWriter`, the first concrete harness runtime adapter, so `--harness claude_code` executes a real writer whose only way to change a file is the Zentra-owned `propose_patch` MCP tool.

**Architecture:** A `HarnessWriter` implementation that starts an ephemeral loopback MCP server in `prepare()`, spawns `claude` through the existing `ProcessSupervisor` with an isolation flag set measured against 2.1.207, verifies the advertised tool surface and MCP health from the `system:init` event before trusting the run, and takes its patch proposal from the MCP server rather than from model output.

**Tech Stack:** TypeScript (ESM, `exactOptionalPropertyTypes`), vitest, zod, `@modelcontextprotocol/sdk`, Node `child_process` via `ProcessSupervisor`.

**Spec:** `docs/superpowers/specs/2026-08-15-claude-code-writer-design.md`
**Decisions:** `docs/design/harness-adapters-decision-record.md`, D24 through D31

## Global Constraints

- Never use the em dash. Use a plain dash instead. Applies to code comments, commit messages, and docs.
- Never add an agent name as commit co-author.
- Never hand-edit `docs/codebase-map.html`. Regenerate with `pnpm run docs:codebase-map`.
- `pnpm run check` (tsc `--noEmit`) must pass before every commit. A clean check does not prove a complete commit: run `git status` and confirm nothing needed is unstaged.
- Every regression test must be proven to discriminate. Revert the fix, observe the test fail, restore. A test that passes for the wrong reason is worse than no test.
- All new `protocolFailure` values are lowercase tokens matching `/^[a-z0-9][a-z0-9_]{0,63}$/`, so `boundedProtocolFailure` accepts them.
- Do not extend `WriterReceiptBodySchema`'s `protocolFailure` enum. `normalizeProtocolFailure` collapses every non-null value to `invalid_output_stream` by design (D23).
- Measured facts in this plan are pinned to Claude Code **2.1.207**. If the installed version differs, stop and report rather than adapting silently.
- Test baseline: roughly 6 to 8 files fail for environmental reasons (no OpenCode credentials, Docker, browser and clock drift). Verify any new failure in isolation before calling it a regression.

## Stop Conditions

Report and stop rather than widening scope if:

- the isolation profile cannot block the hostile-hook test (Task 7), meaning `--setting-sources` is not the control it appeared to be
- surface verification cannot be made stable because the advertised tool set varies for reasons unrelated to configuration
- `dispose()` cannot be threaded through the capsule without changing the dispatch-authority sequence

## File Structure

| File | Responsibility |
| --- | --- |
| `src/workers/worker-adapter.ts` | Widen `InvocationKind` to a harness-neutral name |
| `src/harnesses/harness-writer.ts` | Add required `dispose()` to `PreparedWriterRequest` |
| `src/harnesses/writer-prepared.ts` | Unchanged; each writer keeps its own registry |
| `src/harnesses/claude-code-stream.ts` | Parse the `stream-json` event stream. Pure functions, no I/O |
| `src/harnesses/claude-code-invocation.ts` | Build argv, env, and the MCP config string. Pure functions, no I/O |
| `src/harnesses/claude-code-writer.ts` | The adapter: lifecycle, supervision, report assembly |
| `src/orchestration/writer-worktree-capsule.ts` | Call `dispose()` on every non-execute path |
| `src/orchestration/installed-milestone.ts` | Register the writer |

Stream parsing and invocation building are separate from the adapter so they can be unit tested without a subprocess, and so the adapter file stays small enough to reason about whole.

---

### Task 1: Rename `InvocationKind` to a harness-neutral value

`ClaudeCodeWriter` must not pass `"opencode_writer"`. The kind selects protocol validation, and both writers want the same behavior: none.

**Files:**
- Modify: `src/workers/worker-adapter.ts:20`
- Modify: `src/workers/process-supervisor.ts:400`
- Modify: `src/harnesses/opencode-writer.ts:114`
- Test: `tests/workers/process-supervisor.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `InvocationKind` includes `"harness_writer"` and no longer includes `"opencode_writer"`

- [ ] **Step 1: Find every use**

```bash
grep -rn '"opencode_writer"' src/ tests/
```

Expected: three in `src/` (the type, the switch case, the call site) plus any in `tests/`. Record the list; all must change.

- [ ] **Step 2: Widen the type**

In `src/workers/worker-adapter.ts:20`:

```ts
export type InvocationKind = "worker" | "validation" | "reviewer" | "harness_writer";
```

- [ ] **Step 3: Update the switch**

In `src/workers/process-supervisor.ts`, change `case "opencode_writer":` to `case "harness_writer":`.

The switch is exhaustive over `InvocationKind`, so `pnpm run check` fails if any case is missed. That is the intended safety net.

- [ ] **Step 4: Update the call site**

In `src/harnesses/opencode-writer.ts:114`, change the third argument of `this.supervisor.execute(...)` from `"opencode_writer"` to `"harness_writer"`.

- [ ] **Step 5: Update tests and verify**

Replace `"opencode_writer"` with `"harness_writer"` in any test found in Step 1.

```bash
pnpm run check && pnpm vitest run tests/workers/process-supervisor.test.ts
```

Expected: check clean, tests pass.

- [ ] **Step 6: Confirm nothing was missed**

```bash
grep -rn "opencode_writer" src/ tests/ ; echo "exit=$?"
```

Expected: `exit=1` (no matches).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "Rename the writer invocation kind to harness_writer

Both writers want the same protocol validation, which is none. The
OpenCode-specific name would have forced ClaudeCodeWriter to either lie
about what it is or add a duplicate case."
```

---

### Task 2: Add required `dispose()` to `PreparedWriterRequest`

Per D31. The MCP server starts in `prepare()`, but `beginDispatch()` can throw before `execute()` runs, stranding a listening socket that still serves `propose_patch`.

**Files:**
- Modify: `src/harnesses/harness-writer.ts:67-69`
- Modify: `src/harnesses/opencode-writer.ts` (no-op implementation)
- Modify: `src/orchestration/writer-worktree-capsule.ts:179-223`
- Modify: `tests/harnesses/fake-harness-writer.ts`
- Test: `tests/orchestration/writer-worktree-capsule.test.ts`

**Interfaces:**
- Consumes: `InvocationKind` from Task 1
- Produces: `PreparedWriterRequest { readonly binding: WriterDispatchBinding; dispose(): Promise<void> }`

- [ ] **Step 1: Write the failing test**

In `tests/orchestration/writer-worktree-capsule.test.ts`, add a test that `dispose()` is called when `beginDispatch` throws. Follow the file's existing capsule-construction helper rather than building a request from scratch.

```ts
it("disposes the prepared request when beginDispatch throws", async () => {
  let disposed = 0;
  const writer: HarnessWriter = {
    async prepare() {
      return { binding: testBinding(), dispose: async () => { disposed += 1; } };
    },
    async execute() {
      throw new Error("execute must not run when beginDispatch throws");
    },
  };
  const capsule = capsuleWith(writer, {
    beginDispatch() { throw new Error("claim conflict"); },
  });

  await expect(capsule.run(capsuleRequest())).rejects.toThrow("claim conflict");
  expect(disposed).toBe(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm vitest run tests/orchestration/writer-worktree-capsule.test.ts -t "disposes the prepared request"
```

Expected: FAIL. Either a type error on the missing `dispose`, or `disposed` is 0.

- [ ] **Step 3: Add `dispose` to the interface**

In `src/harnesses/harness-writer.ts`:

```ts
export interface PreparedWriterRequest {
  readonly binding: WriterDispatchBinding;
  /**
   * Releases resources the writer acquired during prepare(). The capsule calls
   * this on every path that does not reach execute(); execute() calls it in a
   * finally. Required rather than optional because a writer holding a live MCP
   * server must not be able to forget it (D31).
   */
  dispose(): Promise<void>;
}
```

- [ ] **Step 4: Implement the no-op in `OpenCodeWriter`**

In `src/harnesses/opencode-writer.ts`, add to the frozen `prepared` object literal:

```ts
      dispose: async () => {},
```

`InternalPreparedOpenCodeWriterRequest` inherits the member from `PreparedOpenCodeWriterRequest`, so no separate declaration is needed.

- [ ] **Step 5: Call it from the capsule**

In `src/orchestration/writer-worktree-capsule.ts`, wrap the `beginDispatch` block so every throwing path disposes. The existing block already catches to call `recordUncertain`; add disposal to both throw sites.

Immediately before each `throw error;` and `throw new AggregateError(...)` inside that block, add:

```ts
        await preparedWriter.dispose();
```

Then in the `try` that wraps `execute`, add a `finally`:

```ts
    try {
      await request.observer?.onWriterStarted?.({ lease, modelId: request.model.id });
      const writer = await this.writer.execute(preparedWriter, request.signal);
      // ... existing body unchanged ...
    } finally {
      await preparedWriter.dispose();
    }
```

`dispose()` must be idempotent, because `execute()` also disposes internally. Task 5 makes the `ClaudeCodeWriter` implementation idempotent; the OpenCode no-op already is.

- [ ] **Step 6: Update `FakeHarnessWriter`**

In `tests/harnesses/fake-harness-writer.ts`, add `dispose: async () => {}` to the object returned by `prepare`. Per D22's lesson, the reference example must carry every obligation a real writer carries, so also add a comment noting that a real writer releases resources here.

- [ ] **Step 7: Verify the test passes**

```bash
pnpm run check && pnpm vitest run tests/orchestration/writer-worktree-capsule.test.ts
```

Expected: check clean, all tests pass including the new one.

- [ ] **Step 8: Prove the test discriminates**

Remove the `await preparedWriter.dispose();` line from the `beginDispatch` catch block. Re-run the new test.

Expected: FAIL with `disposed` equal to 0. Restore the line and confirm it passes again.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "Require dispose() on PreparedWriterRequest

The propose_patch MCP server must start in prepare() so its URL is covered
by argvSha256, but beginDispatch() can throw between prepare() and execute()
and strand a listening socket still serving propose_patch to a valid bearer
token. Required rather than optional because Phase 1.5 showed an optional
security obligation is one an implementation forgets."
```

---

### Task 3: Parse the `system:init` event

The gate that makes every later security claim checkable. Pure functions, no I/O.

**Files:**
- Create: `src/harnesses/claude-code-stream.ts`
- Test: `tests/harnesses/claude-code-stream.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `EXPECTED_TOOLS: ReadonlySet<string>`
  - `interface InitInspection { readonly unexpectedTools: readonly string[]; readonly proposeToolPresent: boolean; readonly disconnectedServers: readonly string[] }`
  - `function inspectInitEvent(events: readonly unknown[]): InitInspection | null`

- [ ] **Step 1: Write the failing tests**

Create `tests/harnesses/claude-code-stream.test.ts`. These fixtures are the real shapes captured from 2.1.207.

```ts
import { describe, expect, it } from "vitest";

import { inspectInitEvent } from "../../src/harnesses/claude-code-stream.js";

const PROPOSE_TOOL = "mcp__zentra__propose_patch";

function initEvent(tools: readonly string[], servers: readonly { name: string; status: string }[]): unknown {
  return { type: "system", subtype: "init", tools, mcp_servers: servers };
}

describe("inspectInitEvent", () => {
  it("accepts the expected surface with a connected server", () => {
    const result = inspectInitEvent([
      initEvent(["Read", "Glob", "Grep", PROPOSE_TOOL], [{ name: "zentra", status: "connected" }]),
    ]);
    expect(result).toEqual({ unexpectedTools: [], proposeToolPresent: true, disconnectedServers: [] });
  });

  it("tolerates a missing read tool", () => {
    const result = inspectInitEvent([
      initEvent(["Read", PROPOSE_TOOL], [{ name: "zentra", status: "connected" }]),
    ]);
    expect(result?.unexpectedTools).toEqual([]);
    expect(result?.proposeToolPresent).toBe(true);
  });

  it("reports a file-mutating tool that survived the deny-list", () => {
    const result = inspectInitEvent([
      initEvent(["Read", "NotebookEdit", PROPOSE_TOOL], [{ name: "zentra", status: "connected" }]),
    ]);
    expect(result?.unexpectedTools).toEqual(["NotebookEdit"]);
  });

  it("reports a failed MCP server", () => {
    const result = inspectInitEvent([
      initEvent(["Read", PROPOSE_TOOL], [{ name: "zentra", status: "failed" }]),
    ]);
    expect(result?.disconnectedServers).toEqual(["zentra"]);
  });

  it("treats an unknown server status as disconnected", () => {
    const result = inspectInitEvent([
      initEvent(["Read", PROPOSE_TOOL], [{ name: "zentra", status: "degraded" }]),
    ]);
    expect(result?.disconnectedServers).toEqual(["zentra"]);
  });

  it("reports the propose tool missing", () => {
    const result = inspectInitEvent([
      initEvent(["Read", "Glob"], [{ name: "zentra", status: "connected" }]),
    ]);
    expect(result?.proposeToolPresent).toBe(false);
  });

  it("returns null when no init event is present", () => {
    expect(inspectInitEvent([{ type: "assistant" }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest run tests/harnesses/claude-code-stream.test.ts
```

Expected: FAIL, cannot resolve `../../src/harnesses/claude-code-stream.js`.

- [ ] **Step 3: Implement**

Create `src/harnesses/claude-code-stream.ts`:

```ts
/** The only tools a Zentra writer may be offered. Anything else aborts the run (D26). */
export const PROPOSE_PATCH_TOOL = "mcp__zentra__propose_patch";
export const EXPECTED_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", PROPOSE_PATCH_TOOL]);

/**
 * The literal Claude Code reports for a healthy MCP server. Checked as an
 * allow-list rather than denying "failed", so an unrecognized third state
 * reads as unhealthy instead of failing open (spec, "One unconfirmed literal").
 */
const CONNECTED_STATUS = "connected";

export interface InitInspection {
  readonly unexpectedTools: readonly string[];
  readonly proposeToolPresent: boolean;
  readonly disconnectedServers: readonly string[];
}

export function inspectInitEvent(events: readonly unknown[]): InitInspection | null {
  for (const event of events) {
    const record = asRecord(event);
    if (record === null || record["type"] !== "system" || record["subtype"] !== "init") continue;
    const tools = asStringArray(record["tools"]);
    const servers = Array.isArray(record["mcp_servers"]) ? record["mcp_servers"] : [];
    const disconnected: string[] = [];
    for (const entry of servers) {
      const server = asRecord(entry);
      if (server === null) continue;
      if (server["status"] !== CONNECTED_STATUS) {
        disconnected.push(typeof server["name"] === "string" ? server["name"] : "unknown");
      }
    }
    return {
      unexpectedTools: tools.filter((tool) => !EXPECTED_TOOLS.has(tool)),
      proposeToolPresent: tools.includes(PROPOSE_PATCH_TOOL),
      disconnectedServers: disconnected,
    };
  }
  return null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
```

- [ ] **Step 4: Verify they pass**

```bash
pnpm run check && pnpm vitest run tests/harnesses/claude-code-stream.test.ts
```

Expected: check clean, 7 tests pass.

- [ ] **Step 5: Prove the fail-closed check discriminates**

Change `server["status"] !== CONNECTED_STATUS` to `server["status"] === "failed"`. Re-run.

Expected: FAIL on "treats an unknown server status as disconnected". This proves the allow-list is doing the work and a deny-list would fail open. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/harnesses/claude-code-stream.ts tests/harnesses/claude-code-stream.test.ts
git commit -m "Inspect the Claude Code init event for tool surface and MCP health

An unreachable MCP server does not fail the run and produces no signal at
all under --output-format json, so the init event is the only place this can
be caught. The connected status is checked as an allow-list because an
unknown third state must read as unhealthy."
```

---

### Task 4: Parse usage, tool calls, and denied tool requests

Both denial channels, per D25.

**Files:**
- Modify: `src/harnesses/claude-code-stream.ts`
- Test: `tests/harnesses/claude-code-stream.test.ts`

**Interfaces:**
- Consumes: Task 3's module
- Produces:
  - `function parseClaudeCodeUsage(events: readonly unknown[]): { readonly usage: WriterUsage; readonly evidence: "native" | "none" }`
  - `function parseDeniedToolRequests(events): readonly { readonly tool: string; readonly path: string | null }[]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/harnesses/claude-code-stream.test.ts`. The `result` fixture is the shape captured from 2.1.207.

```ts
import { parseClaudeCodeUsage, parseDeniedToolRequests } from "../../src/harnesses/claude-code-stream.js";

const resultEvent = {
  type: "result",
  subtype: "success",
  is_error: false,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 27127,
    cache_read_input_tokens: 512,
    output_tokens: 43,
  },
  permission_denials: [
    { tool_name: "Write", tool_use_id: "toolu_01", tool_input: { file_path: "/w/notes.txt", content: "x" } },
  ],
};

describe("parseClaudeCodeUsage", () => {
  it("maps the native usage block", () => {
    const { usage, evidence } = parseClaudeCodeUsage([resultEvent]);
    expect(evidence).toBe("native");
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 43,
      reasoningTokens: 0,
      cacheReadTokens: 512,
      cacheWriteTokens: 27127,
      toolCalls: 0,
    });
  });

  it("counts tool_use blocks", () => {
    const assistant = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: {} }, { type: "text", text: "hi" }] },
    };
    expect(parseClaudeCodeUsage([assistant, resultEvent]).usage.toolCalls).toBe(1);
  });

  it("reports no evidence when the result carries no usage", () => {
    const { usage, evidence } = parseClaudeCodeUsage([{ type: "result", subtype: "success" }]);
    expect(evidence).toBe("none");
    expect(usage.inputTokens).toBe(0);
  });
});

describe("parseDeniedToolRequests", () => {
  it("records a permission-layer denial with its path", () => {
    expect(parseDeniedToolRequests([resultEvent])).toEqual([{ tool: "Write", path: "/w/notes.txt" }]);
  });

  it("records a structurally removed tool from its tool_use_error", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }] } },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "t1",
            is_error: true,
            content: "<tool_use_error>Error: No such tool available: Write. Write exists but is not enabled in this context.</tool_use_error>",
          }],
        },
      },
    ];
    expect(parseDeniedToolRequests(events)).toEqual([{ tool: "Write", path: null }]);
  });

  it("does not record an ordinary tool error as a denial", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "File not found" }] },
      },
    ];
    expect(parseDeniedToolRequests(events)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest run tests/harnesses/claude-code-stream.test.ts
```

Expected: FAIL, the two functions are not exported.

- [ ] **Step 3: Implement**

Add this import to the **top** of `src/harnesses/claude-code-stream.ts`, alongside the existing declarations rather than mid-file:

```ts
import type { WriterUsage } from "./harness-writer.js";
```

Then append the rest:

```ts
/**
 * Claude Code emits this when a tool was structurally removed by
 * --disallowedTools. Unlike a permission-layer denial it never reaches
 * permission_denials, so the stream is the only record of the attempt (D25).
 */
const NOT_ENABLED_MARKER = "is not enabled in this context";

const MAX_TOKENS = 2_000_000;

export function parseClaudeCodeUsage(events: readonly unknown[]): {
  readonly usage: WriterUsage;
  readonly evidence: "native" | "none";
} {
  let toolCalls = 0;
  let evidence: "native" | "none" = "none";
  let usage: Omit<WriterUsage, "toolCalls"> = {
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  };
  for (const event of events) {
    const record = asRecord(event);
    if (record === null) continue;
    for (const block of contentBlocks(record)) {
      if (block["type"] === "tool_use") toolCalls += 1;
    }
    if (record["type"] !== "result") continue;
    const block = asRecord(record["usage"]);
    if (block === null) continue;
    if (evidence === "native") throw new Error("Claude Code writer stream contains more than one result usage block");
    evidence = "native";
    usage = {
      inputTokens: tokenCount(block["input_tokens"], "input_tokens"),
      outputTokens: tokenCount(block["output_tokens"], "output_tokens"),
      reasoningTokens: 0,
      cacheReadTokens: tokenCount(block["cache_read_input_tokens"], "cache_read_input_tokens"),
      cacheWriteTokens: tokenCount(block["cache_creation_input_tokens"], "cache_creation_input_tokens"),
    };
  }
  if (!Number.isSafeInteger(toolCalls) || toolCalls > 100_000) {
    throw new Error("Claude Code writer tool usage exceeds bounded range");
  }
  return { usage: { ...usage, toolCalls }, evidence };
}

export function parseDeniedToolRequests(
  events: readonly unknown[],
): readonly { readonly tool: string; readonly path: string | null }[] {
  const denied: { tool: string; path: string | null }[] = [];
  const toolNamesById = new Map<string, string>();
  for (const event of events) {
    const record = asRecord(event);
    if (record === null) continue;
    for (const block of contentBlocks(record)) {
      if (block["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string") {
        toolNamesById.set(block["id"], block["name"]);
        continue;
      }
      if (block["type"] !== "tool_result" || block["is_error"] !== true) continue;
      if (!textOf(block["content"]).includes(NOT_ENABLED_MARKER)) continue;
      const id = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "";
      denied.push({ tool: toolNamesById.get(id) ?? "unknown", path: null });
    }
    if (record["type"] !== "result" || !Array.isArray(record["permission_denials"])) continue;
    for (const entry of record["permission_denials"]) {
      const denial = asRecord(entry);
      if (denial === null) continue;
      const input = asRecord(denial["tool_input"]);
      const path = input === null ? null : input["file_path"];
      denied.push({
        tool: typeof denial["tool_name"] === "string" ? denial["tool_name"] : "unknown",
        path: typeof path === "string" ? path : null,
      });
    }
  }
  return denied;
}

function contentBlocks(record: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[] {
  const message = asRecord(record["message"]);
  const content = message === null ? undefined : message["content"];
  if (!Array.isArray(content)) return [];
  return content.map(asRecord).filter((block): block is Readonly<Record<string, unknown>> => block !== null);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry) => {
    const block = asRecord(entry);
    return block !== null && typeof block["text"] === "string" ? block["text"] : "";
  }).join("");
}

function tokenCount(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_TOKENS) {
    throw new Error(`Claude Code writer ${label} must be a nonnegative bounded safe integer`);
  }
  return value;
}
```

- [ ] **Step 4: Verify they pass**

```bash
pnpm run check && pnpm vitest run tests/harnesses/claude-code-stream.test.ts
```

Expected: check clean, all tests pass.

- [ ] **Step 5: Prove the second denial channel discriminates**

Delete the `tool_use_error` branch (the three lines from `if (block["type"] !== "tool_result"` through the `denied.push` above the `result` handling). Re-run.

Expected: FAIL on "records a structurally removed tool". This proves `permission_denials` alone does not cover structural removal, which is the whole reason both flags are applied. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/harnesses/claude-code-stream.ts tests/harnesses/claude-code-stream.test.ts
git commit -m "Parse Claude Code usage and both denial channels

--disallowedTools removes a tool but leaves permission_denials empty, while
--allowedTools keeps it advertised and records the full tool_input. Neither
channel alone captures every breach attempt, so deniedToolRequests reads
both."
```

---

### Task 5: Build the invocation

Argv, environment, and MCP config. Pure functions so the isolation flags are unit-testable without spawning anything.

**Files:**
- Create: `src/harnesses/claude-code-invocation.ts`
- Test: `tests/harnesses/claude-code-invocation.test.ts`

**Interfaces:**
- Consumes: `WriterRequest` from `harness-writer.ts`
- Produces:
  - `interface ClaudeCodeAuth { readonly mode: "oauth" | "api_key"; readonly apiKey?: string }`
  - `function buildClaudeCodeArgv(input: { packet: string; model: string; mcpConfig: string; auth: ClaudeCodeAuth }): readonly string[]`
  - `function buildClaudeCodeEnvironment(input: { home?: string; mcpToken: string; auth: ClaudeCodeAuth }): Readonly<Record<string, string>>`
  - `function buildMcpConfig(url: string, tokenEnvVar: string): string`
  - `function redactClaudeCodeArgv(argv: readonly string[]): readonly string[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/harnesses/claude-code-invocation.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildClaudeCodeArgv,
  buildClaudeCodeEnvironment,
  buildMcpConfig,
  redactClaudeCodeArgv,
} from "../../src/harnesses/claude-code-invocation.js";

const base = { packet: '{"brief":"x"}', model: "claude-haiku-4-5-20251001", mcpConfig: '{"mcpServers":{}}' };

describe("buildClaudeCodeArgv", () => {
  it("carries every isolation flag", () => {
    const argv = buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } });
    expect(argv).toContain("--setting-sources");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("--verbose");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
  });

  it("denies every known mutating tool including NotebookEdit", () => {
    const argv = buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } });
    const denied = argv[argv.indexOf("--disallowedTools") + 1]!.split(",");
    for (const tool of ["Edit", "Write", "Bash", "WebFetch", "Task", "NotebookEdit"]) {
      expect(denied).toContain(tool);
    }
  });

  it("adds --bare only in api_key mode", () => {
    expect(buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } })).not.toContain("--bare");
    expect(buildClaudeCodeArgv({ ...base, auth: { mode: "api_key", apiKey: "k" } })).toContain("--bare");
  });

  it("puts the packet last", () => {
    const argv = buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } });
    expect(argv[argv.length - 1]).toBe(base.packet);
  });
});

describe("buildClaudeCodeEnvironment", () => {
  it("carries the MCP token and no credential in oauth mode", () => {
    const env = buildClaudeCodeEnvironment({ home: "/h", mcpToken: "tok", auth: { mode: "oauth" } });
    expect(env["ZENTRA_WRITER_MCP_TOKEN"]).toBe("tok");
    expect(env["HOME"]).toBe("/h");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("carries the key in api_key mode", () => {
    const env = buildClaudeCodeEnvironment({ mcpToken: "tok", auth: { mode: "api_key", apiKey: "sk-x" } });
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-x");
  });

  it("never forwards a parent Claude Code delegation variable", () => {
    const env = buildClaudeCodeEnvironment({ mcpToken: "tok", auth: { mode: "oauth" } });
    for (const key of Object.keys(env)) {
      expect(key.startsWith("CLAUDE_CODE_")).toBe(false);
      expect(key).not.toBe("CLAUDECODE");
    }
  });
});

describe("buildMcpConfig", () => {
  it("references the token by env var rather than inlining it", () => {
    const config = buildMcpConfig("http://127.0.0.1:1/mcp", "ZENTRA_WRITER_MCP_TOKEN");
    expect(config).toContain("${ZENTRA_WRITER_MCP_TOKEN}");
    expect(JSON.parse(config).mcpServers.zentra.type).toBe("http");
  });
});

describe("redactClaudeCodeArgv", () => {
  it("removes the packet, the model, and the MCP config", () => {
    const argv = buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } });
    const redacted = redactClaudeCodeArgv(argv);
    expect(redacted).not.toContain(base.packet);
    expect(redacted).not.toContain(base.model);
    expect(redacted).not.toContain(base.mcpConfig);
    expect(redacted[redacted.length - 1]).toBe("<writer-task-packet>");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest run tests/harnesses/claude-code-invocation.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `src/harnesses/claude-code-invocation.ts`:

```ts
/**
 * Tools denied structurally. NotebookEdit is on this list because it writes
 * files and survived the originally specified deny-list (D26). The list is a
 * floor, not the security boundary: inspectInitEvent is what actually holds,
 * because a future release could add a mutating tool this list does not name.
 */
const DENIED_TOOLS = ["Edit", "Write", "Bash", "WebFetch", "Task", "NotebookEdit"] as const;
const ALLOWED_TOOLS = ["Read", "Glob", "Grep"] as const;

const PROTOCOL_INSTRUCTIONS = [
  "You are a Zentra writer. You cannot modify any file directly.",
  "The only way to express a change is the propose_patch tool.",
  "Call it at most once, with the complete set of file operations.",
  "If no change is needed, say so and make no call.",
].join(" ");

export interface ClaudeCodeAuth {
  readonly mode: "oauth" | "api_key";
  readonly apiKey?: string;
}

export function buildClaudeCodeArgv(input: {
  readonly packet: string;
  readonly model: string;
  readonly mcpConfig: string;
  readonly auth: ClaudeCodeAuth;
}): readonly string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", input.model,
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", input.mcpConfig,
    "--disallowedTools", DENIED_TOOLS.join(","),
    "--allowedTools", ALLOWED_TOOLS.join(","),
    "--permission-mode", "default",
    "--append-system-prompt", PROTOCOL_INSTRUCTIONS,
    ...(input.auth.mode === "api_key" ? ["--bare"] : []),
    input.packet,
  ];
}

export function buildClaudeCodeEnvironment(input: {
  readonly home?: string;
  readonly mcpToken: string;
  readonly auth: ClaudeCodeAuth;
}): Readonly<Record<string, string>> {
  if (input.auth.mode === "api_key" && (input.auth.apiKey ?? "") === "") {
    throw new Error("Claude Code writer api_key mode requires a key");
  }
  return {
    ...(input.home === undefined ? {} : { HOME: input.home }),
    ZENTRA_WRITER_MCP_TOKEN: input.mcpToken,
    ...(input.auth.mode === "api_key" ? { ANTHROPIC_API_KEY: input.auth.apiKey! } : {}),
  };
}

export function buildMcpConfig(url: string, tokenEnvVar: string): string {
  return JSON.stringify({
    mcpServers: { zentra: { type: "http", url, headers: { Authorization: `Bearer \${${tokenEnvVar}}` } } },
  });
}

export function redactClaudeCodeArgv(argv: readonly string[]): readonly string[] {
  const retained = [...argv.slice(0, -1), "<writer-task-packet>"];
  for (const [flag, placeholder] of [
    ["--model", "<approved-model>"],
    ["--mcp-config", "<writer-mcp-config>"],
    ["--append-system-prompt", "<writer-protocol>"],
  ] as const) {
    const index = retained.indexOf(flag);
    if (index !== -1 && retained[index + 1] !== undefined) retained[index + 1] = placeholder;
  }
  return retained;
}
```

- [ ] **Step 4: Verify they pass**

```bash
pnpm run check && pnpm vitest run tests/harnesses/claude-code-invocation.test.ts
```

Expected: check clean, all tests pass.

- [ ] **Step 5: Prove the isolation flag is load-bearing**

Remove `"--setting-sources", "",` from the argv. Re-run.

Expected: FAIL on "carries every isolation flag". This is the unit-level guard for the hostile-hook hole; Task 7 proves it end to end. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/harnesses/claude-code-invocation.ts tests/harnesses/claude-code-invocation.test.ts
git commit -m "Build the Claude Code invocation with its isolation profile

--setting-sources \"\" is the control that stops a .claude/settings.json in
the worktree from executing hooks, and it is the one combination that blocks
them while leaving OAuth working. --bare would be stronger but cannot
coexist with OAuth, so it applies only in api_key mode."
```

---

### Task 6: The `ClaudeCodeWriter` adapter

**Files:**
- Create: `src/harnesses/claude-code-writer.ts`
- Test: `tests/harnesses/claude-code-writer.test.ts`

**Interfaces:**
- Consumes: Tasks 2 through 5, `startWriterProposalMcpServer`, `createPreparedWriterRegistry`, `brandSupervisedReport`, `createWriterEventChain`
- Produces: `class ClaudeCodeWriter implements HarnessWriter`, constructed as `new ClaudeCodeWriter(supervisor, auth)`

- [ ] **Step 1: Write the failing tests**

Create `tests/harnesses/claude-code-writer.test.ts`. Use a stub `WorkerAdapter` returning canned events; do not spawn a process. Model the request on the helpers already used by `tests/harnesses/second-harness-acceptance.test.ts`.

A helper that drives the real adapter with a scripted supervisor:

```ts
import { describe, expect, it } from "vitest";

import { ClaudeCodeWriter } from "../../src/harnesses/claude-code-writer.js";
import type { WorkerAdapter, WorkerResult } from "../../src/workers/worker-adapter.js";

const PROPOSE_TOOL = "mcp__zentra__propose_patch";

function init(tools: readonly string[], status = "connected"): unknown {
  return { type: "system", subtype: "init", tools, mcp_servers: [{ name: "zentra", status }] };
}

const OK_RESULT = { type: "result", subtype: "success", is_error: false, permission_denials: [] };

/** Supervisor that replays canned events and optionally calls the live MCP server first. */
function scriptedSupervisor(
  events: readonly unknown[],
  onExecute?: (argv: readonly string[], env: Readonly<Record<string, string>>) => Promise<void>,
): WorkerAdapter {
  return {
    async execute(request): Promise<WorkerResult> {
      await onExecute?.(request.args, request.environment ?? {});
      const rawStdout = events.map((event) => JSON.stringify(event)).join("\n");
      return {
        outcome: "completed", exitCode: 0, events, stdout: rawStdout, rawStdout, stderr: "",
      };
    },
  };
}
```

Then the cases. Build the `WriterRequest` with the same helper `tests/harnesses/second-harness-acceptance.test.ts` uses, so the packet and workspace lease are realistic.

```ts
it("fails with mcp_server_unavailable when the init event reports a failed server", async () => {
  const writer = new ClaudeCodeWriter(
    scriptedSupervisor([init(["Read", PROPOSE_TOOL], "failed"), OK_RESULT]),
    { mode: "oauth" },
  );
  const prepared = await writer.prepare(writerRequest());
  const report = await writer.execute(prepared, new AbortController().signal);
  expect(report.outcome).toBe("failed");
  expect(report.protocolFailure).toBe("mcp_server_unavailable");
});

it("fails with unexpected_tool_surface when NotebookEdit is advertised", async () => {
  const writer = new ClaudeCodeWriter(
    scriptedSupervisor([init(["Read", "NotebookEdit", PROPOSE_TOOL]), OK_RESULT]),
    { mode: "oauth" },
  );
  const prepared = await writer.prepare(writerRequest());
  const report = await writer.execute(prepared, new AbortController().signal);
  expect(report.outcome).toBe("failed");
  expect(report.protocolFailure).toBe("unexpected_tool_surface");
});

it("fails when the propose tool is absent", async () => {
  const writer = new ClaudeCodeWriter(
    scriptedSupervisor([init(["Read", "Glob"]), OK_RESULT]),
    { mode: "oauth" },
  );
  const prepared = await writer.prepare(writerRequest());
  const report = await writer.execute(prepared, new AbortController().signal);
  expect(report.protocolFailure).toBe("mcp_server_unavailable");
});
```

The channel assertion. The supervisor calls the live MCP server over HTTP while also emitting a patch-shaped blob in assistant text, so the test fails if the adapter ever reads proposals from the stream:

```ts
it("takes the patch proposal from the MCP server, not the event stream", async () => {
  const fabricated = {
    type: "assistant",
    message: { content: [{ type: "text", text: JSON.stringify({
      kind: "zentra.patch_proposal", proposalId: "FABRICATED", baseRevision: "r1", operations: [],
    }) }] },
  };
  const writer = new ClaudeCodeWriter(
    scriptedSupervisor([init(["Read", PROPOSE_TOOL]), fabricated, OK_RESULT], async (argv, env) => {
      await callProposePatch(mcpUrlFrom(argv), env["ZENTRA_WRITER_MCP_TOKEN"]!, {
        proposalId: "GENUINE", baseRevision: "r1",
        operations: [{ path: "a.txt", expectedSha256: null, content: "x", contentSha256: sha256("x") }],
      });
    }),
    { mode: "oauth" },
  );
  const prepared = await writer.prepare(writerRequest());
  const report = await writer.execute(prepared, new AbortController().signal);
  expect(report.patchProposal?.proposalId).toBe("GENUINE");
});

it("rejects a second propose_patch call and keeps the first", async () => {
  let secondResponse: unknown;
  const writer = new ClaudeCodeWriter(
    scriptedSupervisor([init(["Read", PROPOSE_TOOL]), OK_RESULT], async (argv, env) => {
      const url = mcpUrlFrom(argv);
      const token = env["ZENTRA_WRITER_MCP_TOKEN"]!;
      const operations = [{ path: "a.txt", expectedSha256: null, content: "x", contentSha256: sha256("x") }];
      await callProposePatch(url, token, { proposalId: "FIRST", baseRevision: "r1", operations });
      secondResponse = await callProposePatch(url, token, { proposalId: "SECOND", baseRevision: "r1", operations });
    }),
    { mode: "oauth" },
  );
  const prepared = await writer.prepare(writerRequest());
  const report = await writer.execute(prepared, new AbortController().signal);
  expect(JSON.stringify(secondResponse)).toContain("already been called once");
  expect(report.patchProposal?.proposalId).toBe("FIRST");
});

it("fails with invalid_patch_proposal when the proposal is malformed", async () => {
  const writer = new ClaudeCodeWriter(
    scriptedSupervisor([init(["Read", PROPOSE_TOOL]), OK_RESULT], async (argv, env) => {
      await callProposePatch(mcpUrlFrom(argv), env["ZENTRA_WRITER_MCP_TOKEN"]!, {
        proposalId: "BAD",
        baseRevision: "r1",
        // contentSha256 deliberately does not match content, so
        // buildWriterPatchProposal rejects it inside the server.
        operations: [{ path: "a.txt", expectedSha256: null, content: "x", contentSha256: sha256("different") }],
      });
    }),
    { mode: "oauth" },
  );
  const prepared = await writer.prepare(writerRequest());
  const report = await writer.execute(prepared, new AbortController().signal);
  expect(report.outcome).toBe("failed");
  expect(report.protocolFailure).toBe("invalid_patch_proposal");
  expect(report.patchProposal).toBeNull();
});

it("closes the MCP server when execute completes", async () => {
  const writer = new ClaudeCodeWriter(
    scriptedSupervisor([init(["Read", PROPOSE_TOOL]), OK_RESULT]), { mode: "oauth" },
  );
  const prepared = await writer.prepare(writerRequest());
  const url = mcpUrlFrom(preparedArgv(prepared));
  await writer.execute(prepared, new AbortController().signal);
  await expect(fetch(url, { method: "POST" })).rejects.toThrow();
});

it("is idempotent when dispose is called twice", async () => {
  const writer = new ClaudeCodeWriter(
    scriptedSupervisor([init(["Read", PROPOSE_TOOL]), OK_RESULT]), { mode: "oauth" },
  );
  const prepared = await writer.prepare(writerRequest());
  await prepared.dispose();
  await expect(prepared.dispose()).resolves.toBeUndefined();
});

it("refuses a request it did not prepare", async () => {
  const writer = new ClaudeCodeWriter(
    scriptedSupervisor([init(["Read", PROPOSE_TOOL]), OK_RESULT]), { mode: "oauth" },
  );
  const foreign = { binding: testBinding(), dispose: async () => {} };
  await expect(writer.execute(foreign, new AbortController().signal))
    .rejects.toThrow("was not prepared by this trusted adapter");
});
```

`mcpUrlFrom(argv)` reads the `--mcp-config` JSON out of argv and returns `mcpServers.zentra.url`. `callProposePatch` performs a minimal MCP `tools/call` POST with the bearer header. The socket assertion uses a rejected `fetch` rather than checking a flag, so it proves the port actually stopped accepting.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest run tests/harnesses/claude-code-writer.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

First extract the shared helpers so they are not duplicated. Create `src/harnesses/writer-canonical.ts` exporting `canonicalDirectory`, `canonicalExecutable`, `sha256`, and `sha256File`, moved verbatim from `opencode-writer.ts:419-446`, with the error messages generalized from "OpenCode writer" to "harness writer". Update `OpenCodeWriter` to import them and delete its local copies.

Then create `src/harnesses/claude-code-writer.ts`:

```ts
import { randomUUID } from "node:crypto";

import { createWriterEventChain, type WriterEventChain } from "../agents/writer-events.js";
import type { WorkerAdapter } from "../workers/worker-adapter.js";
import { brandSupervisedReport } from "./writer-brand.js";
import { createPreparedWriterRegistry } from "./writer-prepared.js";
import { canonicalDirectory, canonicalExecutable, sha256, sha256File } from "./writer-canonical.js";
import {
  buildClaudeCodeArgv, buildClaudeCodeEnvironment, buildMcpConfig, redactClaudeCodeArgv,
  type ClaudeCodeAuth,
} from "./claude-code-invocation.js";
import { inspectInitEvent, parseClaudeCodeUsage, parseDeniedToolRequests } from "./claude-code-stream.js";
import { startWriterProposalMcpServer, type EphemeralWriterProposalServer } from "./writer-proposal-mcp-server.js";
import type {
  HarnessWriter, PreparedWriterRequest, WriterReport, WriterRequest,
} from "./harness-writer.js";

interface InternalPrepared extends PreparedWriterRequest {
  readonly request: WriterRequest;
  readonly executable: string;
  readonly cwd: string;
  readonly packet: string;
  readonly argv: readonly string[];
  readonly server: EphemeralWriterProposalServer;
}

const preparedRequests = createPreparedWriterRegistry();

export class ClaudeCodeWriter implements HarnessWriter {
  constructor(
    private readonly supervisor: WorkerAdapter,
    private readonly auth: ClaudeCodeAuth,
  ) {}

  async prepare(request: WriterRequest): Promise<PreparedWriterRequest> {
    const executable = canonicalExecutable(request.executable);
    const executableSha256 = await sha256File(executable);
    if (request.expectedExecutableSha256 !== undefined && executableSha256 !== request.expectedExecutableSha256) {
      throw new Error("Claude Code writer executable changed after capability probe");
    }
    const cwd = canonicalDirectory(request.workspace.path);
    if (cwd !== request.workspace.path) throw new Error("Claude Code writer workspace must be canonical");
    const packet = JSON.stringify(request.packet);

    // Started here, not in execute(), because the URL carries a dynamic port and
    // argvSha256 must attest the argv that actually ran (D31).
    const server = await startWriterProposalMcpServer();
    try {
      const argv = buildClaudeCodeArgv({
        packet,
        model: request.model.model,
        mcpConfig: buildMcpConfig(server.url, server.bearerTokenEnvVar),
        auth: this.auth,
      });
      const bindingBody = {
        schemaVersion: 1 as const,
        processIncarnation: randomUUID(),
        executableSha256,
        argvSha256: sha256(JSON.stringify(argv)),
        packetSha256: sha256(packet),
        cwdSha256: sha256(cwd),
        dispatchId: request.dispatchAuthority?.dispatchId ?? null,
        projectId: request.dispatchAuthority?.projectId ?? null,
        claimId: request.dispatchAuthority?.claimId ?? null,
        ownerId: request.dispatchAuthority?.ownerId ?? null,
        revision: request.dispatchAuthority?.revision ?? null,
        leaseToken: request.dispatchAuthority?.leaseToken ?? null,
      };
      const prepared: InternalPrepared = Object.freeze({
        request, executable, cwd, packet, argv, server,
        binding: Object.freeze({ ...bindingBody, digest: sha256(JSON.stringify(bindingBody)) }),
        // close() memoizes into `shutdown`, so this is already idempotent.
        dispose: async () => { await server.close(); },
      });
      preparedRequests.mark(prepared);
      return prepared;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  async execute(rawPrepared: PreparedWriterRequest, signal: AbortSignal): Promise<WriterReport> {
    if (!preparedRequests.consume(rawPrepared)) {
      throw new Error("Claude Code writer request was not prepared by this trusted adapter");
    }
    const prepared = rawPrepared as InternalPrepared;
    const { request, executable, cwd, packet, argv, server } = prepared;
    const startedAt = new Date().toISOString();
    try {
      const result = await this.supervisor.execute({
        taskId: request.taskId,
        executable,
        args: argv,
        cwd,
        timeoutMs: request.timeoutMs,
        environment: buildClaudeCodeEnvironment({
          ...(request.home === undefined ? {} : { home: canonicalDirectory(request.home) }),
          mcpToken: server.bearerTokenValue,
          auth: this.auth,
        }),
      }, signal, "harness_writer");

      let eventChain: WriterEventChain;
      let protocolFailure: string | null = null;
      try {
        eventChain = createWriterEventChain(result.rawStdout, result.events);
      } catch {
        eventChain = createWriterEventChain(result.rawStdout, []);
        protocolFailure = "invalid_output_stream";
      }

      if (protocolFailure === null && result.outcome === "completed") {
        const init = inspectInitEvent(result.events);
        if (init === null || !init.proposeToolPresent || init.disconnectedServers.length > 0) {
          protocolFailure = "mcp_server_unavailable";
        } else if (init.unexpectedTools.length > 0) {
          protocolFailure = "unexpected_tool_surface";
        }
      }

      // Closing collects the proposal. It never transits model output, so a
      // fabricated patch-shaped blob in the text cannot produce one.
      const outcome = await server.close();
      if (protocolFailure === null && outcome.protocolFailure) protocolFailure = "invalid_patch_proposal";

      const parsed = protocolFailure === null
        ? parseClaudeCodeUsage(result.events)
        : { usage: EMPTY_USAGE, evidence: "none" as const };

      const report: WriterReport = Object.freeze({
        outcome: protocolFailure !== null && result.outcome === "completed" ? "failed" : result.outcome,
        exitCode: result.exitCode,
        executable,
        modelId: request.model.id,
        requestedModelSha256: sha256(request.model.model),
        argv: Object.freeze(redactClaudeCodeArgv(argv)),
        cwd,
        packetSha256: sha256(packet),
        networkBoundary: Object.freeze({
          modelTools: request.packet.securityBoundary.modelToolNetwork,
          harnessProviderTransport: request.packet.securityBoundary.harnessProviderTransport,
        }),
        stdoutSha256: eventChain.stdoutSha256,
        stderrSha256: sha256(result.stderr),
        eventChain,
        rawOutputPolicy: "not_retained",
        protocolFailure,
        stdout: result.rawStdout,
        stderr: result.stderr,
        startedAt,
        finishedAt: new Date().toISOString(),
        deniedToolRequests: Object.freeze(
          protocolFailure === "invalid_output_stream" ? [] : parseDeniedToolRequests(result.events),
        ),
        usage: Object.freeze(parsed.usage),
        usageEvidence: parsed.evidence,
        patchProposal: protocolFailure === null ? outcome.proposal : null,
        dispatchBinding: prepared.binding,
      });
      brandSupervisedReport(report, prepared.binding);
      return report;
    } finally {
      await prepared.dispose();
    }
  }
}

const EMPTY_USAGE = {
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0,
};
```

Note `brandSupervisedReport` is not optional: without it the report never clears the supervised-receipt gate and the dispatch fails downstream with a confusing error.

- [ ] **Step 4: Verify they pass**

```bash
pnpm run check && pnpm vitest run tests/harnesses/claude-code-writer.test.ts
```

Expected: check clean, all tests pass.

- [ ] **Step 5: Prove the proposal channel discriminates**

Change the adapter to read `extractWriterPatchProposal(result.events)` instead of the server outcome. Re-run.

Expected: FAIL on "takes the patch proposal from the MCP server", because the fabricated text blob would be accepted. Restore.

- [ ] **Step 6: Verify no socket leaks**

```bash
pnpm vitest run tests/harnesses/claude-code-writer.test.ts --reporter=verbose
```

Expected: the run exits without hanging. A hang means a server was not closed.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "Add the ClaudeCodeWriter runtime adapter

The patch proposal comes from the MCP server's close() outcome rather than
the event stream, so a model that emits a patch-shaped blob in its text
cannot produce one. The init event is checked for MCP health and tool
surface before the run is trusted."
```

---

### Task 7: Register the writer and prove it end to end

**Files:**
- Modify: `src/orchestration/installed-milestone.ts:156`
- Test: `tests/harnesses/claude-code-registration.test.ts`

**Interfaces:**
- Consumes: Task 6's `ClaudeCodeWriter`
- Produces: `--harness claude_code` resolves to a registered writer

- [ ] **Step 1: Write the failing test**

Assert that the default registry resolves `claude_code` without throwing `UnregisteredHarnessWriterError`, and still resolves `opencode`.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm vitest run tests/harnesses/claude-code-registration.test.ts
```

Expected: FAIL with `no writer is registered for harness "claude_code"`.

- [ ] **Step 3: Register**

In `src/orchestration/installed-milestone.ts:156`:

```ts
    this.writers = options.writers ?? new HarnessWriterRegistry({
      opencode: new OpenCodeWriter(this.worker),
      claude_code: new ClaudeCodeWriter(this.worker, resolveClaudeCodeAuth()),
    });
```

Add `resolveClaudeCodeAuth()` reading `ANTHROPIC_API_KEY` from Zentra's own environment and returning `{ mode: "api_key", apiKey }` when set, `{ mode: "oauth" }` otherwise. OAuth is the default per D30.

- [ ] **Step 4: Verify it passes**

```bash
pnpm run check && pnpm vitest run tests/harnesses/claude-code-registration.test.ts
```

Expected: check clean, tests pass.

- [ ] **Step 5: Run the whole suite**

```bash
pnpm vitest run 2>&1 | tail -30
```

Expected: no new failures beyond the documented environmental baseline. Verify any new failure in isolation before treating it as a regression.

- [ ] **Step 6: Regenerate the codebase map**

```bash
pnpm run docs:codebase-map && pnpm vitest run tests/docs/codebase-map.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "Register ClaudeCodeWriter for --harness claude_code

OAuth is the default; an ANTHROPIC_API_KEY in Zentra's environment selects
api_key mode, which also enables --bare."
```

---

### Task 8: The live adversarial test (#132)

The only task that proves the security claim against the real binary.

**Files:**
- Create: `tests/harnesses/claude-code-live.e2e.test.ts`
- Modify: `docs/` operator documentation for the new env vars

**Interfaces:**
- Consumes: everything above
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write the gate**

```ts
const LIVE = process.env["ZENTRA_LIVE_CLAUDE_CODE_E2E"] === "1";
const EXECUTABLE = process.env["ZENTRA_LIVE_CLAUDE_CODE_EXECUTABLE"];
const HOME = process.env["ZENTRA_LIVE_CLAUDE_CODE_HOME"];

describe.skipIf(!LIVE || EXECUTABLE === undefined)("Claude Code live writer", () => {
  it("reports that it ran rather than skipping silently", () => {
    expect(LIVE).toBe(true);
  });
  // ...
});
```

When the suite is skipped, print one line naming the variables required, so an empty run cannot be mistaken for a passing one.

- [ ] **Step 2: Assertion 1, no direct filesystem change**

Dispatch a writer told to edit a tracked file directly. Assert the worktree is byte-identical afterwards (compare a digest of the file before and after), and that `deniedToolRequests` is non-empty.

- [ ] **Step 3: Assertion 2, the hostile hook does not fire**

This is the regression test for D29.

```ts
it("does not execute a hook planted in the worktree", async () => {
  const marker = join(worktree, "HOOK_FIRED");
  await mkdir(join(worktree, ".claude"), { recursive: true });
  await writeFile(join(worktree, ".claude", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `touch ${marker}` }] }] },
  }));

  await runWriter({ brief: "Read README.md and summarize it." });

  expect(existsSync(marker)).toBe(false);
});
```

- [ ] **Step 4: Prove assertion 2 discriminates**

Remove `"--setting-sources", "",` from `buildClaudeCodeArgv` and re-run only this test.

Expected: FAIL, `HOOK_FIRED` exists. Restore and confirm it passes.

This step is mandatory. Without it the test proves nothing, and this is the one hole that was live in the approved design.

- [ ] **Step 5: Assertion 3, a legitimate proposal arrives**

Dispatch a writer asked to make a small real change. Assert `patchProposal` is non-null and its operations name the expected path.

- [ ] **Step 6: Assertion 4, an unreachable MCP server aborts**

Point the config at `http://127.0.0.1:59999/mcp`. Assert `outcome` is `"failed"` and `protocolFailure` is `"mcp_server_unavailable"`.

Note the trap this guards: without the gate the run reports `is_error: false`, `subtype: "success"`, and exit 0, which is indistinguishable from a legitimate no-op.

- [ ] **Step 7: Run live**

```bash
ZENTRA_LIVE_CLAUDE_CODE_E2E=1 \
ZENTRA_LIVE_CLAUDE_CODE_EXECUTABLE="$(command -v claude)" \
ZENTRA_LIVE_CLAUDE_CODE_HOME="$HOME" \
pnpm vitest run tests/harnesses/claude-code-live.e2e.test.ts
```

Expected: all four assertions pass. Pin Haiku and keep prompts minimal to bound cost.

- [ ] **Step 8: Document the variables**

Document `ZENTRA_LIVE_CLAUDE_CODE_E2E`, `_EXECUTABLE`, `_HOME`, `_API_KEY`, `_SHA256`, `_VERSION`, and state that the suite skips without them. Record that these are pinned to Claude Code 2.1.207 and that a version change requires re-measuring, not just re-running.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "Add the live adversarial Claude Code writer test

Four assertions against the real binary. The hostile-hook case is the
regression test for the hole found on 2026-08-15: a .claude/settings.json
in the worktree obtained arbitrary command execution inside the capsule,
during a run whose only tool call was denied."
```

---

## Final Whole-Branch Review

Single-task reviews cannot see cross-task contradictions. Phase 1.5's most serious finding was two individually-approved tasks disagreeing inside one file.

- [ ] Review the full branch diff, not a summary of it
- [ ] Confirm `--harness claude_code` produces a sensible error when the executable is missing, and that it is not worse than before the branch
- [ ] Confirm the OpenCode path is behaviorally unchanged
- [ ] Confirm no `dispose()` path can leave a listening socket, including when `execute()` throws
- [ ] Confirm every new `protocolFailure` value passes `boundedProtocolFailure` and that none was added to the receipt enum
- [ ] `pnpm run check`, full `pnpm vitest run`, `git status` clean
- [ ] Regenerate the codebase map
