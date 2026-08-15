# Harness Authority and Evidence Generalization (Phase 1.5) - Design

## Context

Phase 1 (`2026-08-09-codex-claude-code-harness-adapters-design.md`, merged as PR #128) generalized Zentra's writer-harness plumbing: a shared `HarnessId`, a `HarnessWriter` interface, `HarnessWriterRegistry`, generalized attestation and probe, the `propose_patch` MCP server, and a generic `--harness` CLI surface.

Its stated goal was that Phase 2 could add `ClaudeCodeWriter` without touching that plumbing again.
That goal was not met.
A final whole-branch review traced the real writer execution path and found further modules that still hard-require `"opencode"`, none of which the Phase 1 spec examined.
This phase closes that gap so a second writer can actually execute end to end.

## What is actually blocking, and what is not

The Phase 1 review reported nine blockers.
Reading the code for this design established that three of them do not affect the writer path:

- `src/milestones/milestone-projection.ts:494,536` skip payloads whose `harness` is not `"opencode"`, but those two observers only ever see events emitted by `src/agents/opencode-read-only-agent.ts`, whose payload schemas pin `harness: z.literal("opencode")` (`src/agents/opencode-agent-events.ts:33,56,70`). That path is the Azure-broker read-only capsule serving planner, researcher, and reviewer, which is out of scope.
- `src/observability/agent-tail.ts` branches on `harness === "opencode"` to choose a richer parse, then falls back to a generic schema. It does not drop events.
- `src/tasks/task-projection.ts`, which handles the writer's own `task.writer_completed`, has no harness filter at all and is already harness-agnostic.

The writer's evidence path is therefore sound.
The genuine blockers are two design problems, one policy function, and four mechanical sites.

## Decisions

### 1. Report branding moves to a shared registry

**Problem.** `path-claims.ts` proves a writer report came from a real supervised run by calling `isSupervisedOpenCodeWriterReport`, whose `WeakMap` is module-private to `src/harnesses/opencode-writer.ts`.
A second `HarnessWriter` has no way to brand its report, so `src/workspaces/path-claims.ts:375` rejects it.
The `HarnessWriter` interface does not express branding at all.

**Decision.** A new module, `src/harnesses/writer-brand.ts`, owns the `WeakMap`:

- `brandSupervisedReport(report, binding)` - called by a writer's `execute()` immediately before returning.
- `isSupervisedWriterReport(report, binding)` - harness-agnostic replacement for `isSupervisedOpenCodeWriterReport`, with an identical body: a `WeakMap` identity lookup and `report.dispatchBinding.digest === binding.digest`.

The security property is deliberately unchanged.
It remains object identity in a module-private `WeakMap`, unforgeable by construction, paired with a digest comparison.
Only ownership moves, from one concrete writer to the shared layer that every writer and `path-claims.ts` already depend on.

`OpenCodeWriter` keeps its own `preparedRequests` `WeakSet` (the prepare-to-execute guard) where it is.
That guard is genuinely per-writer: it protects that writer's own prepared-request shape, and each future writer will have its own.
Only the report brand is shared, because only the report crosses into shared code.

`isSupervisedOpenCodeWriterReport` is deleted rather than kept as an alias.
Leaving a second name for the same check invites a future caller to reach for the wrong one.

### 2. Neutral receipt vocabulary, old literals still accepted

**Problem.** `WriterReceiptBodySchema` (`src/workspaces/path-claims.ts:100-101`) hardcodes OpenCode's vocabulary into a durable, persisted schema:

```ts
protocolFailure: z.literal("invalid_native_event_stream").nullable(),
usageEvidence: z.enum(["native_tokens", "legacy_usage", "none"]),
```

Both names describe OpenCode mechanisms specifically.
Phase 1's widening of `WriterReport` to `string | null` also removed the compile-time agreement between a writer's failure vocabulary and this schema, so a mismatch is now only a runtime Zod error.

**Rejected alternative.** Adding each harness's own literals to the union would require editing this shared durable schema for every harness added, which is precisely the coupling this phase exists to remove.

**Decision.** Define harness-neutral values going forward and retain OpenCode's existing literals solely for backward compatibility:

```ts
protocolFailure: z.enum(["invalid_output_stream", "invalid_native_event_stream"]).nullable(),
usageEvidence: z.enum(["native", "fallback", "none", "native_tokens", "legacy_usage"]),
```

New writes use only the neutral values.
The three OpenCode literals stay accepted so previously-persisted receipts and archived journals still parse; replay and retention are first-class in this codebase, so this is a real requirement rather than a hypothetical one.

Translation happens at the receipt boundary in `path-claims.ts`, not inside the writers.
`OpenCodeWriter` continues reporting `invalid_native_event_stream`, `native_tokens`, and `legacy_usage` in its own `WriterReport`, because those accurately describe what OpenCode did and its tests assert them.
A small pure function normalizes to the durable vocabulary on the way into the receipt: `native_tokens` to `native`, `legacy_usage` to `fallback`, `invalid_native_event_stream` to `invalid_output_stream`, and `none` unchanged.

That placement is what makes adding a harness never touch the durable schema again.
A future writer reports whatever is true for its own protocol, and only the normalizing function knows how to map it.

The two deprecated-but-accepted literals carry a short comment stating they exist for pre-Phase-1.5 receipts and must not be used for new writes.
This deliberately breaks the repository's comment-light convention, because "why is this value still here" is not answerable from the code alone.

### 3. Role capability takes the expected harness

**Problem.** `roleModelSupports` (`src/workers/role-capability-envelope.ts:165`) returns `model.harness === "opencode" && ...`.
It is called from `assertRoleModelCapability` at `src/orchestration/writer-worktree-capsule.ts:460`, one line above the guard Phase 1's Task 3 widened.
Any non-OpenCode capability therefore dies one line earlier, which makes that widening inert.

Widening the function globally is not acceptable: three of its five callers serve the read-only path, which runs on the Azure broker and must stay pinned.

**Decision.** Change the signature to take the harness the caller expects: `roleModelSupports(role, model, expectedHarness)`, with the internal check becoming `model.harness === expectedHarness`.
`assertRoleModelCapability` takes and forwards the same parameter.

Call sites split by path:

- Read-only path - `src/agents/opencode-read-only-agent.ts:716`, `src/orchestration/installed-milestone.ts:405`, and `src/milestones/plan-readiness.ts:147` pass the literal `"opencode"`. This makes their existing constraint explicit rather than inherited from a hidden global assumption, and provably does not loosen them.
- Writer path - `src/orchestration/writer-worktree-capsule.ts:460` passes `task.roleAssignment.harness`, not `model.harness`, so the call asserts that the model matches the harness the plan authorized. Passing `model.harness` would be tautological.

Combined with the `task.roleAssignment.harness !== model.harness` comparison added by Phase 1's final fix, the plan's harness, the model's harness, and the capability policy must all agree.

`src/milestones/plan-readiness.ts:118-119` separately hardcodes `packet.harness !== "opencode"` and `context.harness !== "opencode"`.
Those become a comparison between the two, since the invariant that matters there is that packet and context agree, not that either is specifically OpenCode.

Forcing every caller to state its expectation is the point.
The alternative of removing the harness check and asking callers to assert it separately fails by omission, which is exactly how the inert-widening bug arose in Phase 1.

### 4. Mechanical sites

No design decisions; listed so none is silently dropped.

- `src/workers/worker-lifecycle.ts:25` - `WorkerHarnessSchema = z.enum(["opencode", "deterministic"])` widens to all three harnesses plus `deterministic`. It must keep `deterministic`, the fixture-only harness that is deliberately not a member of `HarnessId`. Derive the enum from `HARNESS_IDS` plus `deterministic` explicitly, so the relationship is visible rather than two hand-maintained lists that can drift.
- `src/routing/outcome-history.ts:132` - `readonly harness: "opencode"` widens to `HarnessId`. This is the literal Task 2 missed inside its own subsystem.
- `src/orchestration/opencode-single-file-tracer-bullet.ts:1118-1132` - `assertWriterAdmission`'s two `!== "opencode"` checks become a comparison between the task's harness and the model's harness, matching decision 3's pattern. The `harness: "opencode"` stampings at `:219` and `:1169` take the resolved harness.
- `src/orchestration/installed-milestone.ts:76-109` - `createInstalledMilestonePlan` stamps `harness: "opencode"` on all four role assignments. The implementer's takes the selected harness. Planner, researcher, and reviewer keep `"opencode"`, which is now a truthful statement about the Azure path they run on rather than a placeholder. `admission()` at `:425` takes the resolved harness.

Also in scope, carried from Phase 1's deferred list: `src/harnesses/harness-writer.ts` imports `WriterEventChain` from `../agents/opencode-writer-events.js`.
Phase 1 renamed the symbols but left the module path saying "opencode".
Since this phase already touches the evidence layer, move that file to `src/agents/writer-events.ts` here rather than letting it linger.

## Out of scope

The Docker read-only capsule (`src/capsule/docker-capsule.ts`, `src/capsule/capsule-events.ts`) and everything serving planner, researcher, and reviewer.
These are genuinely OpenCode-specific: `docker-capsule.ts` hardcodes `/usr/local/bin/opencode` and pins `OPENCODE_VERSION`.
Those roles execute through the Azure `ModelBroker` inside a Docker container, not through a harness CLI, so they have no harness to dispatch.

`ClaudeCodeWriter` and `CodexWriter` themselves remain Phase 2 and Phase 3.

## Testing

This phase enables something that does not exist yet, so the obvious tests are vacuous.
Three layers that are not:

1. **Behavior preservation.** The existing suite is the primary gate. Every OpenCode path must behave identically and `--harness opencode` must work end to end unchanged. This is a refactor, and the 3300-plus passing tests are what prove it.
2. **A fake second writer.** The one test that actually proves the objective: a minimal `HarnessWriter` registered under `claude_code` that brands through the shared registry and returns a report using neutral vocabulary. Drive it through `WriterWorktreeCapsule` into a `path-claims` receipt append and assert the receipt lands. That path fails at branding today and must succeed after this phase. Without this test, "Phase 2 can now plug in" is an unverified claim, which is the mistake Phase 1 made.
3. **Negative cases.** An unbranded report is still rejected. A task whose declared harness disagrees with its model is still rejected. A `deterministic` harness is still refused by the writer path. The read-only path still refuses a non-`opencode` capability.

**Backward compatibility.** One test parses a receipt containing the three deprecated literals and confirms it still validates.
Persisted journals are replayable in this codebase, so this is a requirement rather than a hypothetical.

## Delivery

Single phase, sequenced so enabling changes land before their consumers:

1. Brand registry (decision 1) and neutral vocabulary with its normalizing function (decision 2).
2. Parameterized role capability (decision 3), the change that de-inerts Phase 1's Task 3.
3. Mechanical sites (decision 4) and the writer-events file move.
4. The fake-second-writer test proving the whole thing composes.

Step 4 comes last deliberately.
It is the acceptance test for the phase and should be written against finished plumbing rather than grown alongside it.

## Risk

Steps 1 and 2 touch a durable schema and a security check in the same phase.
If the fake-writer test cannot be made to pass without further plumbing changes, that is the signal that a fourth blocker exists that this design did not find.
The correct response is to stop and re-scope rather than widen the phase silently.
That is Phase 1's lesson, and it is recorded here so the implementer treats an unexpected blocker as a stop condition rather than an invitation to improvise.
