# Progress Ledger: claude-code-writer (Phase 2)

Plan: docs/superpowers/plans/2026-08-15-claude-code-writer.md
Spec: docs/superpowers/specs/2026-08-15-claude-code-writer-design.md
Decisions: docs/design/harness-adapters-decision-record.md (D24-D31)
Worktree: /Users/talibilat/Documents/Projects/zentra/.claude/worktrees/claude-code-writer
Branch: worktree-claude-code-writer

NOTE: EnterWorktree branched from origin/main, which did NOT contain Phases 1 and 1.5
(local main was never pushed, 50 commits ahead). Merged local main first. Verified by
src/harnesses/ containing harness-id.ts, harness-writer.ts, writer-brand.ts,
writer-prepared.ts, writer-proposal-mcp-server.ts.

Baseline commit (before Task 1): 63a5d10 (merge of main)
Baseline: pnpm install needed in the fresh worktree; pnpm run check CLEAN afterwards.
Claude Code version verified as 2.1.207, matching the plan's pin.

## Pre-flight plan review

Scanned before dispatching Task 1. One blocker found and corrected in the plan
(not a contradiction the human needed to arbitrate - the spec already mandated
abort-on-unexpected, the plan's deny-list simply could not satisfy it):

1. VERIFIED, plan was untested here: --mcp-config accepts an inline JSON *string*,
   not just a file, and ${VAR} expansion works in that form. Captured
   "Authorization: Bearer INLINE_tok" from a live run. The full flag set parses
   together, including --setting-sources "" alongside the variadic --mcp-config.

2. BLOCKER, corrected: the plan's 6-tool deny-list (Edit, Write, Bash, WebFetch,
   Task, NotebookEdit) leaves 24 tools advertised at init on a 2.1.207 desktop
   build, including CronCreate (schedules recurring execution), EnterWorktree
   (mutates git state), SendMessage, Skill, Workflow, ToolSearch. Task 3's
   abort-on-unexpected check would therefore have fired on EVERY run, making the
   adapter unusable.
   Measured fix: denying all 29 yields a surface of exactly Read, Glob, Grep.
   Plan updated - DENIED_TOOLS extended, a test added asserting the read tools are
   NOT denied, and a global constraint added explaining that the deny-list and the
   surface check are two halves of one control.

## Tasks

Task 1: complete (commits 8ad1f1d..3af13bf, review clean, no fixes needed)
  Controller resolved the reviewer's one warning: commit body correct, zero
  "opencode_writer" references remain in src/ or tests/, git status clean.
Task 2: complete (commits 3af13bf..2b7320e, review found 2 Important, both fixed, re-review approved)
  PLAN DEFECT (mine): the brief's Step 1 test snippet referenced helpers capsuleWith()
  and capsuleRequest() that do not exist in the target file. Implementer built working
  equivalents preserving the intent and reported the deviation. Reviewer confirmed the
  equivalents drive the REAL capsule path, not a stub.
  IMPORTANT x2 (real, caught by reviewer, fixed in 2b7320e): two of the three disposal
  paths shipped with no coverage. Root cause: every pre-existing capsule test uses a
  writer whose dispose() is an inert no-op, so disposal was unobservable and its removal
  would have broken nothing. Untested were (a) the nested AggregateError path where
  recordUncertain also throws, and (b) the finally-wrapped execute-path disposal - which
  is the path that fires on EVERY normal writer run, i.e. the common case.
  Fix added 3 tests, all proven to discriminate. Removing the finally breaks two of them
  simultaneously, which is the correct fan-out rather than three tests hitting one line.
  Implementer also removed 10 pre-existing untracked stray duplicate .ts files that were
  blocking pnpm run check (the same "src 2.ts" pollution from concurrent test runs seen
  in earlier phases). Controller verified no tracked file was lost.
Task 3: complete (commits 2b7320e..590e4c0, review found 1 Critical, fixed, re-review approved)
  CRITICAL (real, caught by reviewer, plan-mandated - the gap was in MY plan's Step 3
  code): disconnectedServers was computed by collecting mcp_servers entries whose status
  was not "connected". With mcp_servers: [] or the key absent, the loop never ran and the
  result read as "no unhealthy server" when the truth was "no server at all". Same
  fail-open pattern the status allow-list exists to prevent, one level up.
  Controller measured the real binary before deciding: with no MCP config, 2.1.207
  reports mcp_servers: [] AND does not advertise the propose tool, so proposeToolPresent
  would have caught it. But that is an undocumented coupling in Claude Code internals,
  not something the module asserts - a future release could advertise the tool while
  reporting no servers.
  Fixed (590e4c0) with a POSITIVE check: new EXPECTED_SERVER_NAME = "zentra" and
  expectedServerConnected, true only when that server is present AND carries the success
  literal. disconnectedServers demoted to diagnostic-only with a comment saying so.
  Discrimination proven: reverting to the old logic fails exactly the 3 new tests and no
  others. 10/10 pass.

  INTERFACE FOR TASK 6 - gate on expectedServerConnected, NEVER on disconnectedServers:
    interface InitInspection {
      readonly unexpectedTools: readonly string[];
      readonly proposeToolPresent: boolean;
      readonly expectedServerConnected: boolean;  // trust signal
      readonly disconnectedServers: readonly string[];  // diagnostic only
    }
  This supersedes the plan's Task 6 code, which gates on disconnectedServers.length > 0.
Task 4: complete (commits 590e4c0..98fabb9, review clean, no fixes needed)
  Both denial channels implemented. Discrimination verified against the actual line
  range the report claimed to delete, and the reported failure is consistent with
  removing only that branch. 16/16 pass. asRecord reused, not duplicated.
Task 5: complete (commits 98fabb9..68a8b1a, review found 1 Important, fixed)
  IMPORTANT (plan-mandated - the hardcode was in MY plan's code block): buildMcpConfig
  hardcoded the MCP server name "zentra" while claude-code-stream.ts separately exported
  EXPECTED_SERVER_NAME = "zentra". Nothing bound them - no import, no test. A rename in
  either file would make expectedServerConnected never true, and since that is the sole
  trust signal, every run would fail closed with no compile error and no failing test to
  explain why. The implementer's stated rationale ("avoid unnecessary coupling") did not
  hold: one module's output IS the other's input.
  Fixed (68a8b1a): imported the constant, used a computed property, added a test binding
  the emitted server key to EXPECTED_SERVER_NAME rather than to a third copy of the
  literal. Discrimination proven by renaming to "zentra_renamed". 27/27 pass.
  Controller verified the diff directly - scoped to exactly the import and the computed
  key, nothing else touched.
  Reviewer note: redaction of the MCP config is belt-and-braces for secrecy, since
  buildMcpConfig never embeds the token - only the unexpanded ${VAR} reference. It IS
  the real mechanism for keeping bulk JSON out of the attested argv.
Task 6: complete (commits 68a8b1a..c889e16, review found 1 Important, fixed)
  Delivered as 3 commits: 73632b4 extracted the shared canonicalization helpers to
  writer-canonical.ts, 894c410 added the adapter, c889e16 closed the review finding.
  Controller supplied a CORRECTION to the brief before dispatch: the plan's Task 6 code
  gated on init.disconnectedServers.length > 0, which Task 3's review had already proven
  fail-open. Implementer gated on !init.expectedServerConnected as instructed.
  IMPORTANT (real, caught by reviewer): the production gate was correct but NO TEST
  DISCRIMINATED IT. Every test built its init event with a helper that always injects a
  {name:"zentra", status} entry, so disconnectedServers.length and !expectedServerConnected
  gave identical verdicts for every scenario exercised. Reverting to the stale fail-open
  form would have passed the entire suite. This is the same "the test certifies the hole"
  pattern that bit Phase 1 and Phase 1.5.
  Fixed (c889e16, test-only, controller verified no src/ file touched): added cases with
  mcp_servers: [] and the key absent while tools still advertises the propose tool.
  Under the stale form exactly the 2 new tests fail and the other 9 pass. 11/11 green.
  Verified by the reviewer against the diff:
   - proposal comes ONLY from server.close(); result.events is never read for it. The
     channel test drives a REAL MCP client over StreamableHTTPClientTransport against the
     live ephemeral server, with a fabricated patch-shaped blob in the event stream that
     must not win. Swapping to extractWriterPatchProposal breaks exactly 2 tests.
   - no socket leak on any path: prepare() catches and closes, execute()'s finally
     disposes, close() memoizes so double-dispose is safe.
   - a throwing dispose() cannot displace a real error - it is caught inside the finally.
   - brandSupervisedReport is called on the single return path, so it covers failure
     outcomes too.
   - helper extraction verbatim apart from generalized error strings; no test asserted
     the old strings, so nothing weakened.
  Implementer also found and fixed 3 latent bugs in MY brief's example test code: a
  missing trailing newline on rawStdout (createWriterEventChain needs it), an invalid
  baseRevision "r1" (fails the writer-patch regex), and a single-MCP-session assumption.
  Reviewer confirmed all three were real and correctly fixed.
Task 7: pending
Task 8: pending

## Minor findings deferred to the final review

- Task 2: a dispose() that THROWS would mask the original error at
  writer-worktree-capsule.ts:216, :219 and the finally at :381-383, via standard JS
  finally-swallowing semantics. Harmless today because both writers' dispose() are
  no-ops that cannot throw. ACTIONABLE IN TASK 6: ClaudeCodeWriter's dispose() closes
  an HTTP server and CAN fail. Task 6 should either wrap dispose() in try/catch so it
  cannot displace a real error, or the final review must decide it is acceptable.
- Task 2: idempotency of dispose() is documented in the interface comment but not
  tested, because both current implementations are no-ops. Task 6 has an explicit
  idempotency test, which closes this.
- Task 2: the three new finally-path tests share ~90% boilerplate. Deliberate, keeps
  each test self-contained. Not a defect.
- Task 4: two code paths are correct by trace but untested - textOf() handling
  tool_result.content as an ARRAY of text blocks rather than a plain string
  (claude-code-stream.ts:163-170), and a permission_denials entry with no tool_input
  (:145-146). Neither was in the brief's test list either, so this is a plan gap, not
  an implementer omission.
- Task 4: no dedup by tool_use_id across the two denial channels. Currently inert
  because the channels are mutually exclusive under 2.1.207 - a structurally removed
  tool never reaches permission_denials, and a permission-layer denial's tool_result
  does not carry the not-enabled marker. If a future release ever emitted both signals
  for one denial, the same attempt would be recorded twice.
- Task 6: claude-code-writer.ts:177 uses a bare console.error to record a dispose()
  teardown failure. It is the ONLY console.* call anywhere under src/ - the codebase
  otherwise routes diagnostics through src/observability/*. A failed MCP socket close is
  therefore invisible to whatever monitors this system. The constructor takes no logger,
  so fixing it properly means widening the constructor. FINAL REVIEW SHOULD TRIAGE.
- Task 6: no test exercises the invalid_output_stream path in this adapter specifically
  (malformed rawStdout). Wiring is identical to the tested OpenCodeWriter pattern and
  createWriterEventChain is tested elsewhere, but it is an untested branch in this file.
