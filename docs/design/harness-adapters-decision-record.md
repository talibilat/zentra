# Harness Adapters - Decision Record

Living record of every decision taken while designing and building multi-harness support (OpenCode, Claude Code, Codex).
Decisions made in conversation are captured here so the reasoning survives the chat that produced it.

Related documents:

- `docs/superpowers/specs/2026-08-09-codex-claude-code-harness-adapters-design.md` - Phase 1 design
- `docs/superpowers/plans/2026-08-09-harness-adapter-shared-plumbing.md` - Phase 1 plan
- `docs/superpowers/specs/2026-08-13-harness-authority-evidence-design.md` - Phase 1.5 design

Phases: Phase 1 (shared plumbing, merged as PR #128), Phase 1.5 (authority and evidence layers, designed), Phase 2 (`ClaudeCodeWriter`), Phase 3 (`CodexWriter`).

---

## D1. Writers must be denied filesystem access, not asked to avoid it

**Date:** 2026-08-09 (Phase 1 design)

**Decision.** For every harness, hard-deny the built-in mutation, shell, and network tools at the harness's own tool-permission layer, and expose exactly one Zentra-owned MCP tool (`propose_patch`) as the model's only way to express a change.

**Alternative rejected.** Let the harness write directly into its disposable worktree using its normal edit tools, then diff the worktree afterward and build the proposal from what actually changed. This was easier to achieve uniformly across CLIs and would have avoided depending on per-tool permission granularity.

**Why.** Zentra's existing guarantee is enforced, not promised: `OpenCodeWriter` sets `permission: { edit: "deny", bash: "deny", webfetch: "deny", task: "deny" }`, so the model physically cannot touch disk.
Write-then-diff would have replaced an enforced boundary with an isolation-plus-cleanup boundary, weakening `shellAuthority: "none"` and `patchProtocol.mutationTools: "denied"` from facts into descriptions.

**Consequence.** Required verifying that both target CLIs actually support hard tool denial before committing (see D2, D3).

---

## D2. Claude Code can meet that bar

**Date:** 2026-08-09 (research finding, not a judgement call)

**Finding.** `--disallowedTools Edit Write NotebookEdit Bash WebFetch WebSearch Task` is enforced by Claude Code itself, not by the model, and a bare tool name removes the tool from the model's context entirely.
`--mcp-config` with `--strict-mcp-config` loads only Zentra's server.
`--output-format json` gives a structured result.

**Caveat recorded.** There is no "must call this tool" primitive. A model may legitimately answer without calling `propose_patch`, so a `null` proposal is a valid outcome rather than an error.

---

## D3. Codex cannot fully meet that bar; neutered `apply_patch` accepted

**Date:** 2026-08-09

**Decision.** Accept that Codex's `apply_patch` tool remains visible to the model, and neuter it via `sandbox_mode = "read-only"` plus `approval_policy = "never"` so every write attempt through it fails closed.

**Alternative rejected.** Hold Codex to a stricter bar, which in practice meant deprioritizing the Codex adapter until OpenAI ships a real removal switch, or running Codex inside an additional OS-level sandbox.

**Why.** `features.shell_tool = false` does structurally remove the shell tool, but `apply_patch` is wired to model metadata rather than a user-facing toggle, and OpenAI closed the request to make it removable as "not planned" (openai/codex#8161).
The outcome that matters is that no unauthorized write can succeed, and read-only plus never-approve achieves that.
The residual difference is that the model can see a tool it can never use.

**Consequence.** Documented as a known platform limitation to revisit if OpenAI adds a real toggle.

---

## D4. Writer role only; planner, researcher, and reviewer stay on the Azure broker

**Date:** 2026-08-09

**Decision.** Harness adapters cover the implementer/writer role only.

**Why.** Tracing the four milestone roles showed only the writer ever dispatches by harness.
Planner, researcher, and reviewer run through an Azure OpenAI `ModelBroker` inside a Docker read-only capsule; their `harness` field is set but never consulted to choose an execution path.
There is no dispatch point there to plug into.

**Alternative rejected.** Also route those roles through the harness CLIs. That would mean replacing a working mechanism with a new execution path, roughly doubling the project.

**Consequence.** `docker-capsule.ts` and the read-only agent stay OpenCode-specific by design, and this later explained why three of Phase 1's reported blockers were false alarms (see D13).

---

## D5. One design doc, phased implementation

**Date:** 2026-08-09

**Decision.** A single design covering the shared abstraction, then phased implementation: plumbing first, then each writer.

**Alternative rejected.** Pilot Claude Code end to end as its own smaller project before designing anything for Codex.

**Why.** Both adapters follow nearly the same shape once the security model is settled, so designing them together avoided discovering the shared abstraction twice.

**Retrospect.** The phasing was right; the plumbing phase's scope was wrong (see D14).

---

## D6. Generic CLI flags, accepting a breaking change

**Date:** 2026-08-09

**Decision.** Rename `--opencode`, `--opencode-home`, `--opencode-sha256`, `--opencode-version` to `--harness-executable`, `--harness-home`, `--harness-sha256`, `--harness-version`, plus a new required `--harness <id>`.

**Alternative rejected.** Keep the OpenCode flags and add parallel `--codex-*` and `--claude-code-*` families.

**Why.** One flag family avoids a combinatorial explosion as harnesses are added, and matches the goal of selecting a harness at execution time without manual adjustment.
The blast radius was small: only `docs/commands.md` documented the old names outside the CLI itself.

**Consequence.** Three test files also referenced the old flags and had to be updated; the Phase 1 plan failed to list them, caught during execution.

---

## D7. Ephemeral in-process loopback MCP server, one per task

**Date:** 2026-08-09

**Decision.** Host `propose_patch` over MCP streamable HTTP bound to `127.0.0.1` on an OS-assigned port, started by the orchestrator immediately before spawning the harness and torn down when it exits. Random per-task bearer token, single use, reusing the existing `PatchProposalBodySchema`.

**Alternatives rejected.** A stdio server spawned by the harness (making it an unsupervised grandchild process and requiring a file handoff to return the result), and one long-lived server multiplexing concurrent tasks by correlation ID (cross-task isolation risk for no real benefit, since Zentra already spawns one harness process per task).

**Why.** In-process capture keeps Zentra's supervised child count at exactly one and removes a serialization boundary. Per-task scoping matches how dispatch bindings, worktree leases, and capability envelopes are already scoped.

---

## D8. Shared `HarnessWriter` interface and a registry

**Date:** 2026-08-09

**Decision.** Introduce a `HarnessWriter` interface (`prepare`/`execute`) that all writers implement, plus a `HarnessWriterRegistry` keyed by `HarnessId`.

**Alternative rejected.** Three unrelated classes with `switch (harness)` at each call site.

**Why.** This is what actually delivers "routes to the correct harness without manual adjustments"; with switches, every caller must be kept in sync by hand.

---

## D9. Accept the MCP SDK's 86 transitive dependencies

**Date:** 2026-08-11 (Phase 1, Task 8)

**Decision.** Depend on `@modelcontextprotocol/sdk`.

**Context.** It pulls 86 packages, including both Express and Hono, into a project that previously had exactly three runtime dependencies and has explicit supply-chain controls (`package:verify`, a `files` whitelist, SECURITY.md, executable attestation).

**Alternative rejected.** Hand-roll the streamable-HTTP MCP server surface (initialize, tools/list, tools/call) to keep the dependency count at three.

**Why.** This server sits on the writer security boundary. Owning protocol correctness (handshake, session handling, SSE framing, future spec changes) permanently is a larger risk than the dependency count.

---

## D10. `eventChain` stays on the shared report, renamed harness-neutral

**Date:** 2026-08-12 (Phase 1, Task 4; plan gap found during execution)

**Problem.** The Phase 1 plan's shared `WriterReport` omitted `eventChain`, which `path-claims.ts` and `writer-worktree-capsule.ts` both consume directly. The task could not compile as written. The implementer stopped and escalated rather than improvising.

**Decision.** Rename `OpenCodeWriterEventChain` and friends to `WriterEventChain` and carry `eventChain` on the shared type.

**Alternatives rejected.** Keep the OpenCode-named type in the shared interface (leaves a knowingly wrong name that Phase 2 must fix anyway), or redesign it as a neutral tool-evidence structure (a real schema change to durable receipts, breaking Task 4's no-behavior-change constraint).

**Why.** The structure is already harness-agnostic - a hash-chained record of newline-delimited output, which fits Claude Code's `stream-json` and Codex's `--json` equally. Only the name said OpenCode. A symbol rename changes no persisted field names or shapes.

---

## D11. Seven pre-existing test failures accepted as out of scope

**Date:** 2026-08-11 (Phase 1 baseline)

**Decision.** After investigating, treat the remaining environmental failures as an accepted baseline exclusion and hold new work to the rest of the suite.

**Why.** Investigation fixed one (Docker Desktop was not running) and established three unrelated root causes for the rest: missing OpenCode credentials, inherent wall-clock and browser timing flakiness, and a pre-existing policy `denied` outcome. None touch model sheets, routing, writer/attestation/probe code, or CLI flags.

**Discipline applied.** Every later failure was checked against this list rather than assumed. When the count rose mid-execution, the causes were traced to load contention and to `dist/` pollution from concurrent runs, both proven by isolation runs, not waved through.

---

## D12. Merge locally and open a PR, without pushing `main`

**Date:** 2026-08-12 (Phase 1 completion)

**Decision.** Push the branch and open PR #128, merge the branch into local `main`, and do not push `main`.

**Why.** Local `main` carries the work so follow-on phases can build on it, while the PR stays open as the reviewable record. Pushing `main` would auto-close the PR as already merged.

---

## D13. Three of the nine reported Phase 1 blockers do not affect the writer path

**Date:** 2026-08-13 (Phase 1.5 design)

**Correction.** The Phase 1 final review reported that projections would silently lose durable evidence for a second harness. Reading the code established otherwise:

- The `milestone-projection.ts` skips sit in observers that only ever see events from `opencode-read-only-agent.ts`, whose schemas pin `harness: z.literal("opencode")`. That is the out-of-scope read-only path (see D4).
- The `agent-tail.ts` checks select a richer parse and fall back to a generic schema; they do not drop events.
- `task-projection.ts`, which handles the writer's own `task.writer_completed`, has no harness filter at all.

**Why recorded.** So Phase 2 does not re-investigate them, and so the record shows the original claim was corrected rather than quietly dropped.

---

## D14. Phase 1 did not meet its stated goal; Phase 1.5 exists to close the gap

**Date:** 2026-08-13

**Finding.** Phase 1's design promised Phase 2 could add `ClaudeCodeWriter` without touching the plumbing again. It cannot. The plan enumerated the modules it renamed but never examined the authority and evidence layers downstream of the writer.

**Most consequential instance.** `roleModelSupports` pins `model.harness === "opencode"` and is called one line above the guard Phase 1's Task 3 widened, which makes that widening inert.

**Why it happened.** The Phase 1 design was written from a trace of the writer's own module and its direct callers, not from a trace of the full execution path through admission, capability policy, and receipt append.

---

## D15. Report branding moves to a shared registry

**Date:** 2026-08-13 (Phase 1.5)

**Decision.** Move the supervised-report `WeakMap` out of `opencode-writer.ts` into a shared `writer-brand.ts` owned by the interface layer, exposing `brandSupervisedReport` and a harness-agnostic `isSupervisedWriterReport`.

**Alternatives rejected.** Make branding a `HarnessWriter` method so each writer owns its own store (spreads a security-critical check across N implementations), or replace object-identity branding with an HMAC token (serializable across processes, but a large change to a security mechanism solving a problem we do not have).

**Why.** The security property is unchanged - still module-private `WeakMap` identity plus digest comparison. Only ownership moves. `OpenCodeWriter` keeps its own prepare-to-execute `WeakSet`, which is genuinely per-writer.

---

## D16. Neutral receipt vocabulary, old literals still accepted

**Date:** 2026-08-13 (Phase 1.5)

**Decision.** Give `WriterReceiptBodySchema` harness-neutral values for `protocolFailure` and `usageEvidence`, retaining OpenCode's three existing literals purely so previously-persisted receipts still parse. Writers keep reporting their own accurate values; a pure function normalizes at the receipt boundary.

**Alternatives rejected.** An additive union with one literal per harness (would require editing the shared durable schema for every harness added - the exact coupling this phase removes), and an open bounded string (loses closed-set validation on durable data).

**Why.** Adding a harness must never touch this schema again. Journals are replayable, so backward compatibility is a requirement rather than a nicety.

---

## D17. `roleModelSupports` takes the expected harness

**Date:** 2026-08-13 (Phase 1.5)

**Decision.** Parameterize as `roleModelSupports(role, model, expectedHarness)`. Read-only callers pass the literal `"opencode"`; the writer path passes `task.roleAssignment.harness`.

**Alternatives rejected.** Remove the harness check and let callers assert it separately (fails by omission - exactly how the inert-widening bug arose), or split into two near-identical functions (duplication that drifts).

**Why.** Three of its five callers serve the read-only path and must stay pinned, so a global widening was not acceptable. Forcing each caller to state its expectation removes a hidden global assumption.

---

## D18. Plan-readiness expresses the read-only pin role-dependently, not as a blanket literal

**Date:** 2026-08-13 (Phase 1.5 implementation)

**Problem.** The Phase 1.5 plan told the implementer to delete two literal `"opencode"` pins in `src/milestones/plan-readiness.ts`, on the premise that neighbouring equality checks already proved all three harness values equal and so made the pins redundant.

**Finding.** That premise was true about equality and wrong about what the pins protected. They were the only thing enforcing "the read-only admission path never admits a non-opencode harness." An implementer proved it empirically by toggling the deletion against `tests/agents/opencode-read-only-program.test.ts`: with the pins gone, a `claude_code` researcher passed admission and then crashed inside `OpenCodeReadOnlyAgent.run` with an uncaught error instead of producing the clean paused result. They refused to commit and escalated.

**Decision.** Replace the pins with a role-dependent check rather than deleting them:

```ts
((packet.role !== "implementer" || !isHarnessId(packet.harness)) && packet.harness !== "opencode") ||
```

**Why.** This states the real invariant: only the implementer role dispatches by harness, and it may be any *executable* harness. Planner, researcher, and reviewer have no harness CLI and stay on OpenCode.

**Note.** The `!isHarnessId(...)` clause was added later, during the final whole-branch review. The first version of this fix admitted a `deterministic` implementer, because `HarnessSchema` accepts that fixture-only value while `isHarnessId` deliberately does not.

---

## D19. `assertRoleModelCapability` runs after the authority block, not before it

**Date:** 2026-08-13 (Phase 1.5 implementation)

**Decision.** In `assertAuthority` (`src/orchestration/writer-worktree-capsule.ts`), the authority `if` block runs first and `assertRoleModelCapability` immediately after.

**Why.** Once parameterized, `assertRoleModelCapability` also detects a harness mismatch. Running first, it threw the generic `"model does not match the canonical role capability policy"` where the specific `"writer assignment is outside approved harness authority"` had been. Two existing tests assert the specific message on that security-relevant rejection path. Reordering keeps the diagnostic message and leaves both tests passing unmodified, so they keep guarding what they were written to guard.

**Alternative rejected.** Update the two tests to expect the generic message. That trades a specific diagnostic for a generic one on a rejection path, and edits tests that were not in the task's scope.

---

## D20. `exactRole` widened for the implementer rather than staying pinned

**Date:** 2026-08-14 (Phase 1.5 final review)

**Problem.** Two tasks in the same phase left `src/orchestration/installed-milestone.ts` internally contradictory, which no single-task review could see. One pinned `exactRole` to `"opencode"` justified by "preserves today's behavior exactly, widening belongs to Phase 2." The other then made `createInstalledMilestonePlan` stamp the implementer with the selected harness. Since `exactRole` runs before the writer is resolved, `--harness codex` began failing with a generic `plan_not_ready` or a cardinality throw, where before this branch it failed cleanly at `writers.get` with `UnregisteredHarnessWriterError`. A diagnostic regression on an operator-facing path.

**Decision.** Make the expected harness role-dependent: `role === "implementer" ? harness : "opencode"`.

**Alternatives rejected.** Keep the pin and add an early guard rejecting non-OpenCode harnesses (honors the plan's stated scope, but leaves a blocker Phase 2 must remove and adds a guard Phase 2 then deletes), or leave it and document the degraded error (ships a confusing operator-facing failure, and discovering plumbing gaps late is what this phase existed to prevent).

**Why.** The pin's stated justification no longer held. Widening removes the last writer-path pin, is what Phase 2 needs anyway, and is safe today because an unregistered harness still fails one step later at `writers.get` with the correct error. The harness-selection test now reaches that error *after* capability selection succeeds, which is a stronger assertion than before.

---

## D21. `normalizeUsageEvidence` fails closed on an unrecognized value

**Date:** 2026-08-14 (Phase 1.5 final review)

**Decision.** Throw on an unrecognized `usageEvidence` rather than mapping it to `"none"`.

**Why.** `"none"` is a meaningful value distinct from "unrecognized", and `WriterReport.usageEvidence` is an open `string`. A Phase 2 writer with a typo would have silently degraded the durable evidence of record with nothing failing anywhere. Failing closed matches this codebase's style.

**Not changed.** `normalizeProtocolFailure` still collapses any non-null value to a single neutral one. That collapse is semantically total - any non-null value means the output stream was unusable - and the harness-specific reason remains in the writer's own report.

---

## D22. The prepare-to-execute guard is shared as a factory, not a single registry

**Date:** 2026-08-14 (issue #133)

**Problem.** `OpenCodeWriter` guards prepare-to-execute with a module-private `WeakSet`: `prepare` adds the object, `execute` refuses anything absent and deletes it so it is single-use. That mechanism is not expressed in the `HarnessWriter` interface, so nothing forced a second writer to implement it, and the fake writer used as Phase 2's reference example omitted it.

**Decision.** Add `createPreparedWriterRegistry()`, which returns its own `{ mark, consume }` pair. Each writer holds an instance.

**Alternative rejected.** A single shared `WeakSet`, mirroring how the report brand was shared in D15. That would let one writer's `execute` accept another writer's prepared object, which then gets cast to the wrong internal shape. The report brand can be globally shared because it is checked by shared code; this guard cannot, because each writer's prepared shape is its own.

**Also rejected.** Expressing it in the `HarnessWriter` interface. Stronger, but it constrains every writer's prepared-request shape and moves a security-critical check into a contract each implementation must satisfy correctly.

---

## D23. The journal keeps the harness-native protocol failure; the receipt keeps the neutral one

**Date:** 2026-08-14 (issue #134)

**Problem.** D16 normalized the durable receipt's vocabulary, but `task.writer_completed` journals `protocolFailure` raw. For OpenCode a single run emits `invalid_native_event_stream` in one durable event and `invalid_output_stream` in the other.

**Decision.** Keep the split deliberately, and bound the journaled field to a lowercase token of at most 64 characters, throwing on anything else.

**Why not normalize both.** `WriterReport.rawOutputPolicy` is `not_retained`, so the writer's own report never persists. The journal event is the only durable record of what actually went wrong. Normalizing it would permanently discard the harness-specific reason, leaving a future `ClaudeCodeWriter` failure indistinguishable from a `CodexWriter` failure in the forensic record.

**Why bound it.** `WriterReport.protocolFailure` is an open `string`, so without a bound a future harness could land an arbitrary unbounded value in the journal. Throwing matches D21 and the codebase's fail-closed style: an out-of-vocabulary reason is a writer bug that should surface rather than be quietly recorded.

**Consequence.** The two durable sinks intentionally disagree. That is now documented at the call site so it reads as a decision rather than an oversight.

---

## D24. The writer subprocess must scrub the parent Claude Code session's environment

**Date:** 2026-08-15 (issue #131)

**Problem.** Found empirically, by accident, against Claude Code 2.1.207.
A live `claude -p` run launched with `--allowedTools "Read"` was asked to write a file.
It called `Write`, the tool returned `File created successfully`, the file appeared on disk, `is_error` was `false`, and `permission_denials` was `[]`.
The allow-list appeared to provide no enforcement whatsoever.

It does enforce.
The confound was inherited environment.
Zentra was itself running inside a Claude Code session, and the child inherited `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`, which let it delegate the permission decision back to the parent session, where it was auto-approved.
Unsetting `CLAUDECODE`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, and `CLAUDE_CODE_ENTRYPOINT` and re-running the identical command blocked the write, created no file, and populated `permission_denials` correctly.

**Scope correction.** The reproduction above was a bare shell invocation, not a run through Zentra.
`ProcessSupervisor` already builds the child environment from a five-entry allow-list (`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`) plus the caller's explicit map, so no `CLAUDE_CODE_*` variable reaches a supervised writer today.
**This is not a live hole in Zentra.** Recording it anyway, because it converts that allow-list from hygiene into a load-bearing security control and because of what it implies below.

**Decision.** The `ProcessSupervisor` environment allow-list must not grow to carry harness credentials, and `ClaudeCodeWriter` passes `HOME` explicitly as `OpenCodeWriter` already does.

**Why this needs saying.** `ClaudeCodeWriter` has to authenticate, and the obvious ways to do that both reopen this exact hole.
Adding `ANTHROPIC_*` or `CLAUDE_*` to the shared allow-list would pass through whatever the parent session happens to hold, including the delegation socket.
Letting `HOME` default to the operator's real home directory would hand the child `~/.claude/settings.json`, which can define hooks that execute arbitrary commands, defeating the tool restrictions entirely.

**Consequence.** Credentials reach the child only through the caller's explicit environment map, under a name Zentra chooses, and `HOME` points at a dedicated harness home rather than the operator's.
Subtracting a known-bad list is never sufficient here: the variable set is undocumented and version-dependent, so a future release adding a delegation channel would reopen the hole silently.

---

## D25. Deny-list for removal, allow-list for evidence, and both are required

**Date:** 2026-08-15 (issue #131)

**Problem.** The two flags were assumed to be alternatives. Measured against 2.1.207 in a clean environment, they do different things and each is individually insufficient.

`--disallowedTools` removes the tool structurally.
It disappears from the `system:init` event's `tools` array, and an attempted call fails with `No such tool available: Write. Write exists but is not enabled in this context.`
But `permission_denials` stays **empty**, so the attempt leaves no trace in the result summary.

`--allowedTools` does not remove anything.
Every built-in stays advertised in `system:init`.
A call to a non-allowed tool is denied at the permission layer and **is** recorded in `permission_denials`, with `tool_name`, `tool_use_id`, and the complete `tool_input`.

**Decision.** Apply both. The deny-list provides structural removal; the allow-list provides the audit trail.
`deniedToolRequests` is assembled from two sources: `permission_denials` in the result event, and `tool_use_error` results in the stream whose text matches the not-enabled-in-this-context form.

**Consequence.** Structural removal alone would have made breach attempts invisible in the durable receipt, which defeats the purpose of recording them.

---

## D26. The tool surface is enumerated and verified, not assumed

**Date:** 2026-08-15 (issue #131)

**Problem.** The design's deny-list was `Edit`, `Write`, `Bash`, `WebFetch`, `Task`.
Enumerating `system:init` on 2.1.207 with that exact deny-list still advertised `NotebookEdit`, which writes files, alongside `Skill`, `Workflow`, `EnterWorktree`, `ExitWorktree`, `SendMessage`, `RemoteTrigger`, and `CronCreate`.
`NotebookEdit` alone defeats the model: it modifies files on disk without passing through `propose_patch`.

The advertised set also varied run to run under identical flags, because tools move between loaded and deferred.

**Decision.** `ClaudeCodeWriter` reads the `tools` array from the `system:init` event and compares it against an expected allow-set.
Anything unexpected aborts the run before the first turn.

**Why not just extend the deny-list.** A hardcoded list is a snapshot of one version.
Both CLIs ship near-daily, and a release adding a file-mutating tool would silently break the model with no failing test.
Verifying the actual surface converts an assumption into an assertion that fails loudly.

---

## D27. Claude Code does not fail closed on an unreachable MCP server

**Date:** 2026-08-15 (issue #131)

**Problem.** The spec left open whether `-p` fails closed when `--mcp-config` points at a server that cannot be reached, since Codex has an explicit `required = true` and Claude Code's equivalent was unconfirmed.

Measured against a dead endpoint at `http://127.0.0.1:59999/mcp` with `--strict-mcp-config`: the run completed with `is_error: false`, `subtype: "success"`, `terminal_reason: "completed"`, and exit code 0.
With `--output-format json` there is no signal at all that the server failed.

There is a signal, but only in the stream. `--output-format stream-json --verbose` emits a `system:init` event carrying `mcp_servers: [{"name": "zentra", "status": "failed"}]`.

**Decision.** `ClaudeCodeWriter` uses `stream-json`, not `json`, and gates on the init event: every configured MCP server must report connected, and `mcp__zentra__propose_patch` must be present in the advertised tool list, or the run aborts before the first turn.

**Why this matters beyond a health check.** Without it, an unreachable server yields a successful run with no patch proposed, which is byte-identical to a run where the model legitimately decided no change was needed.
A broken capsule would be indistinguishable from a clean no-op, and the failure mode is silent in exactly the direction that loses work.

---

## D28. `--strict-mcp-config` suppresses user MCP servers but nothing else

**Date:** 2026-08-15 (issue #131)

**Problem.** Whether `--strict-mcp-config` is sufficient isolation for the capsule.

Measured: without it, the child inherited the host user's MCP servers, and `mcp__headroom__*` tools appeared in the advertised list.
With it, those disappeared.
But the non-MCP extras above were unaffected, and running with a scrubbed `HOME` pointing at an empty directory did not remove them either, so they are neither user configuration nor environment-derived.

**Decision.** Set `--strict-mcp-config` and treat it as covering MCP servers only.
Isolation of the rest is D24's environment allow-list plus D26's surface verification.

**Consequence.** No single flag isolates the capsule. The three mechanisms are independent and all are load-bearing.

---

## D29. Hooks execute outside the tool-permission model, and the worktree is a hook source

**Date:** 2026-08-15 (issue #131)

**Problem.** Found while looking for a way to make a writable OAuth harness home safe.
A `PreToolUse` hook placed in a project-level `.claude/settings.json` executed `touch HOOK_FIRED` during a run whose only tool call was a `Read` that was **denied**.
`Bash` was never invoked and never needed to be.

The writer's cwd is the worktree under edit.
Any repository carrying a `.claude/settings.json` would therefore have obtained arbitrary command execution inside the writer capsule, bypassing `propose_patch`, the deny-list, and the entire permission model.

**This was a live hole in the design as approved.** It is unrelated to authentication and would have applied to both modes.

**Decision.** `--setting-sources ""` on every invocation, in both auth modes.
Verified to block the hook while leaving OAuth working.

**Alternative rejected.** `--setting-sources user`, which also blocked the hook.
It still loads settings from the harness home, so it would make every future change to that home a security question.
The empty list removes the category.

**Consequence.** The live adversarial test (#132) carries a hostile-hook worktree as a permanent regression test, and it must be proven to fail when the flag is dropped.

---

## D30. `--bare` and OAuth are mutually exclusive; OAuth is still the default

**Date:** 2026-08-15 (issue #131)

**Problem.** `--bare` structurally disables hooks, LSP, plugin sync, auto-memory, keychain reads, and CLAUDE.md auto-discovery.
It is by far the strongest isolation available, and it would have made D26 and D29 belt-and-braces rather than load-bearing.

It also makes OAuth impossible.
Its help text states auth is then strictly `ANTHROPIC_API_KEY` or `apiKeyHelper`, and a live run with valid OAuth credentials and `--bare` fails with `Not logged in`.

**Decision.** Support both modes, OAuth default, chosen by the user against the recommendation below.
OAuth mode reconstructs isolation from `--setting-sources ""` plus surface verification. API-key mode adds `--bare`.

**Recommendation that was not taken, recorded because it may matter later.** API-key default, because `--bare` also permits a fully inert harness home, and an inert home supports a much stronger claim: that nothing in it can execute.
OAuth requires the home to stay writable for token refresh, so that claim is unavailable.

**Residual risk accepted.** `--setting-sources ""` governs settings files only.
Plugins remain possible in OAuth mode but are caught by D26, since they surface as tools.
Auto-memory and CLAUDE.md discovery remain active and are context injection rather than code execution.

---

## D31. `PreparedWriterRequest.dispose()` is required, not optional

**Date:** 2026-08-15 (issue #131)

**Problem.** The `propose_patch` MCP server must start in `prepare()`, because its URL carries a dynamic port and `argvSha256` must attest the argv that actually ran.
But `beginDispatch()` runs between `prepare()` and `execute()` in `writer-worktree-capsule.ts` and throws on a claim conflict.
On that path the server is stranded, still listening and still serving `propose_patch` to any holder of the bearer token.

**Decision.** Add a required `dispose(): Promise<void>` to `PreparedWriterRequest`.
The capsule calls it on every path that does not reach `execute()`; `execute()` calls it in a `finally`.

**Why required rather than optional.** D22 and Phase 1.5 both established that an optional security obligation is one an implementation forgets: that is precisely how `FakeHarnessWriter` shipped without the `preparedRequests` guard, leaving the reference example missing one of the three mechanisms.

**Alternative rejected.** Starting the server in `execute()` and moving the URL into a config file.
That removes the leak but drops the endpoint out of the attested argv, weakening the dispatch binding to avoid a lifecycle problem that is solvable directly.

**Cost accepted.** A breaking change to a shared interface, touching every writer and test double. The package is private with no external consumers.

---

## Standing practices adopted

- **Escalate plan gaps, do not improvise.** Twice an implementer stopped on a gap the plan did not anticipate (D10, and the swallowed `UnregisteredHarnessWriterError`). Both were correct calls and produced better outcomes than guessing.
- **Prove a regression test discriminates.** Every fix for a review finding was verified by reverting the fix and observing the test fail, then restoring. A test that passes for the wrong reason is worse than no test.
- **Verify failures rather than assume flakiness.** Rising failure counts were traced to specific causes (load contention, `dist/` pollution) with isolation runs before being dismissed.
- **Treat an unexpected blocker as a stop condition.** Recorded in the Phase 1.5 risk section: if the acceptance test cannot pass without further plumbing changes, stop and re-scope rather than widening the phase silently.
- **A clean type check does not prove a complete commit.** One Phase 1.5 task edited a file, saw `pnpm run check` pass, and committed without staging it, so that commit did not compile from a clean checkout. Check `git status` before committing, not just the build.
- **A test that asserts a value the same commit hardcodes proves nothing.** Phase 1.5's acceptance test initially read back a literal its own fake writer had set. Drive the value through the production seam that transforms it, and prove the test discriminates by reverting the transformation.
- **Single-task reviews cannot see cross-task contradictions.** Phase 1.5's most serious finding was two tasks disagreeing inside one file, each individually correct and approved. The whole-branch review is where that surfaces, so it needs the branch diff rather than a summary.
