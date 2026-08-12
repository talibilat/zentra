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

## Standing practices adopted

- **Escalate plan gaps, do not improvise.** Twice an implementer stopped on a gap the plan did not anticipate (D10, and the swallowed `UnregisteredHarnessWriterError`). Both were correct calls and produced better outcomes than guessing.
- **Prove a regression test discriminates.** Every fix for a review finding was verified by reverting the fix and observing the test fail, then restoring. A test that passes for the wrong reason is worse than no test.
- **Verify failures rather than assume flakiness.** Rising failure counts were traced to specific causes (load contention, `dist/` pollution) with isolation runs before being dismissed.
- **Treat an unexpected blocker as a stop condition.** Recorded in the Phase 1.5 risk section: if the acceptance test cannot pass without further plumbing changes, stop and re-scope rather than widening the phase silently.
