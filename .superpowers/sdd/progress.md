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
Task 7: complete (commits c889e16..84b0af2, review found 2 Important, both fixed)
  b2755d5 registered ClaudeCodeWriter and added resolveClaudeCodeAuth(); 84b0af2 closed
  the review findings (test-only, controller verified git diff on src/ is empty).
  IMPORTANT x2 (real): (a) resolveClaudeCodeAuth's boundary behavior - the task's own
  central risk - had ZERO direct coverage. Correct by inspection, but an edit dropping
  the .trim() check would have passed the whole suite, and the consequence is a run that
  gets --bare without a usable key and fails with a confusing "Not logged in".
  (b) the registration test used .not.toThrow(UnregisteredHarnessWriterError), which
  rules out one error class and would report success for any OTHER error from get(), and
  never confirmed a real writer came back.
  Fixed: four boundary tests (unset, "", whitespace, real value) with beforeEach/afterEach
  save-and-restore so no env leaks into the suite, plus toBeInstanceOf assertions for both
  claude_code and opencode. Both proven to discriminate.
  Also renamed a now-stale test title in installed-milestone-harness-selection.test.ts
  that claimed "only opencode is registered by default" - untrue as of this task.
  FULL SUITE: 3386 passed, 19 failed. Six files outside the documented baseline
  (opencode-read-only-capsule, live-daemon, cleanup-failure-store,
  opencode-single-file-tracer-bullet, recovery, repository-runtime) all came back 100%
  green when re-run in isolation - load contention, not regressions, consistent with what
  earlier phases saw. The remainder match the known environmental baseline exactly.
  Codebase map regenerated by command; its test passes.
Task 8: complete (commits 84b0af2..35b4d29). ALL FOUR ASSERTIONS GREEN AGAINST 2.1.207.
  The implementer BLOCKED twice, correctly both times, and each blocker was a real
  PRODUCTION bug that every fixture-based test had passed straight through.

  BLOCKER 1 -> D32 (d76b756). OAuth could not authenticate through ProcessSupervisor at
  all. Controller reproduced independently: under exactly the supervisor's allow-list the
  binary says "Not logged in"; adding USER fixes it, adding LOGNAME does not (macOS
  keychain lookup is by account name). The implementer's own recommendation was to widen
  ProcessSupervisor.ENV_ALLOWLIST - which is precisely what D24 forbids, since that list
  feeds every supervised process including the read-only capsules. It refused to do that
  unilaterally and escalated. Fixed by scoping USER into buildClaudeCodeEnvironment in
  oauth mode only; api_key mode sets --bare and never reads the keychain.

  BLOCKER 2 -> D33 (e993345). mcp__zentra__propose_patch was absent from ALLOWED_TOOLS, so
  --permission-mode default auto-denied it in headless mode. THE WRITER'S ONLY SANCTIONED
  WAY TO MAKE A CHANGE COULD NOT BE USED. Every fixture test in Tasks 3-7 passed while
  this was broken: they asserted the flags were built as specified, and they were - the
  specification was wrong. Only the real binary could show it. Fixed by importing
  PROPOSE_PATCH_TOOL into ALLOWED_TOOLS; --disallowedTools unchanged. Proven to
  discriminate: reverting fails exactly the one new test with the right message.

  *** DISCRIMINATION PROOF FOR ASSERTION 2 PASSED - the phase's central security claim ***
  Removing "--setting-sources", "" from buildClaudeCodeArgv made HOOK_FIRED APPEAR on a
  live run. Restoring it made the marker vanish. The hostile-hook test genuinely detects
  the hole that was live in the approved design, rather than passing for another reason.

  ASSERTION 1 NARROWED, deliberately and documented in the test. The plan wanted both "no
  filesystem change" and "the attempt appears in deniedToolRequests". The second is
  unreachable: --disallowedTools removes the tool from the request sent to the model, so
  the model cannot emit a tool_use for it and there is nothing to deny. Measured three
  ways - instructed to Edit, instructed to run Bash with no sanctioned alternative, and
  the same with the writer's protocol system prompt removed in case that was steering it.
  All three: zero tool_use attempts, empty permission_denials. That is the isolation
  working, not a gap. Both denial channels remain covered by claude-code-stream.test.ts
  against event shapes captured from the real binary. Liveness is asserted via
  usageEvidence "native" and inputTokens > 0 rather than a specific protocolFailure,
  because model behaviour varies - observed runs both declined outright and reached for
  propose_patch and had the proposal rejected as malformed.

  Suite skips visibly with no credentials (5 skipped, named variables in the reason).
  Live run cost roughly $0.10 plus diagnostics. Controller ran this task directly after
  the subagent hit session limits twice.

=== FINAL WHOLE-BRANCH REVIEW ===
Verdict: Needs fixes -> 1 Critical + 3 Important + 5 Minor, all fixed across 6 commits
(212c29a, 722f097, 7f7970b, 26ba069, 8cdfc3e, 8264b2b).

The review found what all eight per-task reviews structurally could not: the adapter was
BLOCKED ON ITS OWN SUCCESS PATH.

CRITICAL - toolCalls violated the writer-receipt event-chain invariant on every
productive run. path-claims.ts:114-117 requires usage.toolCalls to equal the number of
retained chain events with type "tool_use". writer-events.ts built chain events from each
line's TOP-LEVEL type, but Claude Code's top-level types are only system/assistant/user/
result - its tool calls are nested in message.content[]. So observedToolCalls was
structurally always 0 while usage.toolCalls was 1+ for any run that read a file or called
propose_patch. The receipt was rejected, appendSupervisedWriterReceipt threw inside the
capsule, and a successful run's patch proposal would never have been applied.
The reviewer REPRODUCED it rather than asserting it. Controller independently confirmed
the field mismatch before dispatching the fix.
Why no per-task review saw it: OpenCode is consistent by construction, and every test
reaching the receipt path used FakeHarnessWriter, whose toolCalls is hardcoded 0 with an
empty chain. No test drove a real ClaudeCodeWriter report through the receipt seam. One
was added, and it discriminates.
Fixed by teaching createWriterEventChain to retain one event per nested tool_use block,
NOT by counting toolCalls from the chain - that would have made the invariant tautological
and gutted a real check on a writer claiming unbacked usage.

IMPORTANT x3, all fixed:
 - The capsule's three unguarded dispose() calls re-awaited the same rejected promise the
   adapter deliberately swallowed (close() memoizes rejections), so a teardown failure
   displaced the real report or error. This was the deferred Task 2 item that Task 6 only
   half-closed - Task 6 wrapped the adapter's own call and left the capsule's three.
 - closeServer awaited mcp.close() before httpServer.close(), so an mcp.close() rejection
   left the HTTP listener up with a live bearer token, permanently, because the rejection
   was memoized and no later dispose() would retry.
 - unexpected_tool_surface discarded init.unexpectedTools, making the most
   portability-sensitive failure on the branch undiagnosable. DENIED_TOOLS is calibrated
   against one desktop-flavoured 2.1.207 install.

RESIDUAL, accepted, noted for the record: fixing the Critical required widening
EventBodySchema.byteCount from positive to nonnegative, because a line with several
nested tool_use blocks emits one event per block and only the last carries the line's
bytes. Controller verified the validator still holds: total byteCount must equal
stdoutBytes, and the zero-byte sub-events repeat the prior prefixSha256 so chain
continuity is preserved. The one real loss is that the chain no longer proves every event
corresponds to distinct bytes. Bounded, and OpenCode's chains are provably unchanged
since it never emits the nested shape.

=== FINAL FULL-SUITE VERIFICATION (after all review fixes) ===
3413 passed | 11 failed | 8 skipped, across 192 files. pnpm run check clean.

Failing files: docker-capsule.e2e, opencode-read-only-capsule, packaged-browser-security.e2e,
chromium-browser.e2e, agenttrail-fleet-api, multi-writer-scheduler.e2e, recovery,
package-e2e, agenttrail-fleet-browser.e2e.

Isolation-verified rather than assumed, per the standing practice:
 - recovery.test.ts -> 100/100 PASS alone. Load contention.
 - packaged-browser-security.e2e -> 1/1 PASS alone. Load contention.
 - opencode-read-only-capsule -> still 3 failed alone, so investigated properly rather
   than waved through. All three are "real Docker path" tests failing with a hard
   "Test timed out in 120000ms", not an assertion. Docker's daemon is up but had 22
   stopped containers accumulated from this session's repeated runs. Decisively: the file
   references NONE of the modules this branch changed - no writer-events, no
   createWriterEventChain, no dispose, no writer-canonical, no claude-code-*. It exercises
   the read-only capsule path, which is not the writer path. Same failure family as
   docker-capsule.e2e, which is already in the documented baseline.
The remainder match the documented environmental baseline exactly.

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
