# Harness Generalization Design

Date: 2026-07-28

Status: Proposed

## Context

Zentra currently executes all writer, reviewer, validation, and milestone roles through OpenCode.

This is Phase 1 of a four-phase initiative to let Zentra also run tasks through Claude Code and OpenAI Codex, chosen per project via `zentra.project.json`, with their own subscription credentials rather than Zentra's model broker.

The later phases are Claude Code adapter (Phase 2), Codex adapter (Phase 3), and extending the reviewer/validation/milestone roles to the newly generalized harness selection (Phase 4).

The contract layer already anticipates multiple harnesses.

`HarnessSchema` in `src/contracts/milestone.ts` already enumerates `["opencode", "claude_code", "codex", "deterministic"]`, and `src/contracts/planning-contracts.ts`, `src/contracts/replanning.ts`, and `src/policy/model-sheet.ts` already accept the full set.

The runtime layer has not caught up.

About ten call sites still hardcode or narrow to the literal `"opencode"`, which means a `claude_code` or `codex` role assignment would either be rejected, silently dropped, or fail to type-check today even though the contracts already allow it.

## Decision

Phase 1 closes the gap between the contract layer and the runtime layer.

It widens every runtime type, schema, and gate that is narrower than the canonical `Harness` union so the codebase is internally consistent, and it consolidates the scattered `=== "opencode"` execution-support checks into one shared predicate.

Phase 1 makes no behavioral change.

Every code path that only has a real execution implementation for OpenCode today continues to accept only OpenCode, and every existing test continues to pass without its assertions changing.

The only externally visible change is that types no longer lie about what the contracts already allow, and one central place exists for Phase 2 and Phase 3 to add `claude_code` and `codex` support without another multi-file search.

## Implementation

**Widen narrowed types and schemas:**

- `src/workers/worker-lifecycle.ts:25` — `WorkerHarnessSchema` currently is `z.enum(["opencode", "deterministic"])`. Import and use the canonical `HarnessSchema` from `src/contracts/milestone.ts` instead of redeclaring a narrower one.
- `src/routing/model-router.ts:14` — `RouteApprovedModelRequest.harness` is typed as the literal `"opencode"`. Change it to the `Harness` type exported from `src/contracts/milestone.ts`.
- `src/routing/routing-events.ts:11` — `harness: z.literal("opencode")`. Change to `HarnessSchema`.
- `src/orchestration/multi-writer-scheduler.ts:243` already casts `model.harness as "opencode" | "claude_code" | "codex" | "deterministic"` to work around the narrower upstream type. Once the upstream types are widened, this cast is removed.

**Stop hardcoding the harness at role-assignment construction:**

- `src/orchestration/installed-milestone.ts` hardcodes `harness: "opencode"` for the planner, researcher, implementer, and reviewer role assignments (lines 74, 85, 96, 107, plus the fixture-shaped assignment near line 416-419). Each of these becomes a parameter the caller supplies rather than a literal, with `"opencode"` as the only value passed in today.
- `src/cli/main.ts` hardcodes `harness: "opencode"` in three role-assignment construction sites (lines 752, 763, 867). Same treatment: accept the value instead of hardcoding it, still `"opencode"` in every current caller.

Neither of these sites reads from `zentra.project.json` yet.

That plumbing is Phase 2 work, once there is an actual second harness and a config shape to select it from.

Phase 1 only makes the call sites capable of receiving something other than `"opencode"` instead of foreclosing it in the type.

**Consolidate the execution-support gate:**

The following locations each independently check whether a harness equals the literal `"opencode"` to decide whether real execution support exists for it:

- `src/milestones/milestone-projection.ts:494` and `:536`
- `src/milestones/plan-readiness.ts:118-119`
- `src/orchestration/writer-worktree-capsule.ts:466`
- `src/workers/role-capability-envelope.ts:165`
- `src/observability/agent-tail.ts:291`, `:303`, `:1630`, `:1637`

Introduce one shared predicate, `hasExecutionSupport(harness: Harness): boolean`, in a single new module (`src/contracts/harness-support.ts`), returning `true` only for `"opencode"` today.

Replace all eight call sites with calls to this predicate.

Phase 2 adds `"claude_code"` to this one function; Phase 3 adds `"codex"`.

No other file changes for those phases as a result of this particular gate.

**Generalize the capsule attestation event shape:**

- `src/capsule/capsule-events.ts:58` — `"capsule.harness_attested"` currently is `z.object({ harness: z.literal("opencode"), version: z.literal("1.18.3"), executableSha256: HexDigestSchema })`. Change `harness` to `HarnessSchema` and `version` to a bounded, non-empty string instead of a literal, since Claude Code and Codex will have their own independent version strings in Phase 2/3.
- `src/capsule/docker-capsule.ts:205-213` constructs this event with a hardcoded `harness: "opencode"`. It keeps doing exactly that in Phase 1; only the schema shape changes to permit other harnesses in a future phase, since this file does not yet attest anything but OpenCode's capsule.

## Data Flow

1. A role assignment is constructed (CLI submission or installed-milestone construction) with a `harness` value drawn from the canonical `Harness` union, currently always `"opencode"`.
2. The value flows through routing (`model-router.ts`, `routing-events.ts`) and worker lifecycle (`worker-lifecycle.ts`) without being narrowed or cast along the way.
3. At each point where Zentra must decide whether real execution support exists for the assigned harness, the code calls the single shared `hasExecutionSupport` predicate instead of comparing to the literal `"opencode"` directly.
4. Capsule attestation records the harness and its version using the generalized event shape, still only ever populated for OpenCode in Phase 1.

## Tests

`pnpm test`, `pnpm check`, and `pnpm build` must pass with no changes to existing test assertions, since this phase changes types and consolidates checks without changing behavior.

Add a focused unit test for `hasExecutionSupport` asserting it returns `true` for `"opencode"` and `false` for `"claude_code"`, `"codex"`, and `"deterministic"`.

Add a focused test at one representative consolidated gate (for example `plan-readiness.ts`) confirming a `claude_code` role assignment is still rejected the same way an unsupported harness was rejected before this refactor, so widening the type does not silently open a gap ahead of Phase 2.

Add a type-level check (a `.test-d.ts` or an existing type-check path) confirming `RouteApprovedModelRequest.harness` now accepts all four `Harness` values, since this file previously could not even express a non-opencode request.

## Non-Goals

This phase does not invoke the Claude Code or Codex CLIs, parse their output, or add any process-spawn logic for them.

This phase does not add a capsule or credential profile for Claude Code or Codex, and does not touch the Docker capsule conformance harness in `src/conformance/three-pod-installed.ts` or the mitm-proxy egress checks in `docker-capsule.ts`.

This phase does not add a `harnesses` section, default-model selection, or any other new key to `zentra.project.json`.

This phase does not change which harness actually executes any role; every role assignment produced by Zentra continues to be `"opencode"` until Phase 2 lands.
