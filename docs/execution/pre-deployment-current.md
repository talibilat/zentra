# Pre-Deployment Remediation - Current Execution Record (Handoff)

This is the authoritative current-session record, rewritten fresh for handoff to a new agent/session.
It supersedes any prior version of this same file and the active-process/current-head sections of `docs/execution/pre-deployment-progress.md` (historical, stale) without rewriting that older file.
Treat `docs/execution/pre-deployment-handoff.md` as the authoritative continuation record for original issue-corpus state and dependency order; this file tracks only live orchestration state.
Completed issue briefs were removed from `docs/issues/` on 2026-07-13 at the user's direction.

The active issue index is `docs/issues/README.md`, while implementation reports remain the audit record for removed briefs.

## Repository State At This Handoff

`main` remains at `de15cadbb84873f53c18861267d91f3554356737`, unchanged and untouched this session (no writer may ever touch `main`).
Integration branch `fix/pre-deployment` (local only, not yet pushed to origin, not yet merged to main) is at commit `fe30073` in worktree `.worktrees/fix-pre-deployment`.
**Nothing in this remediation has been pushed to origin or merged into `main` yet.** Do not describe any of the work below as "pushed" or "merged" until that literally happens through the human-approved integration procedure.

Active worktrees:
- `.worktrees/fix-pre-deployment` (branch `fix/pre-deployment`) - the integration steward's worktree only. No implementation writer may edit here.
- `.worktrees/predeploy-e-lease` (branch `fix/predeploy-e-lease`, commit `8cc7d0b`) - issue 014's implementation, committed, verified by the integration steward (`pnpm check` clean, 709/709 tests), independent review in progress (see below). Not yet merged into `fix/pre-deployment`. Keep this worktree until that review completes and the merge succeeds.

All other writer worktrees used earlier this session (issue 018, and the four Wave-Now finding fixes) have been removed after their commits were confirmed reachable from `fix/pre-deployment` and their branches deleted locally (none were ever pushed to origin, so no remote branch deletion was needed or performed).

## Orchestration Model

Claude Code acts as orchestrator/integration steward only, per `docs/issues/CLAUDE_OPENCODE_ORCHESTRATOR_PROMPT.txt`. All implementation, TDD, and review work runs through separate `opencode run` processes, one per writer worktree, each with a scoped per-worktree `opencode.jsonc` permission profile (edit allowed for writers, denied for reviewers; bash restricted to an explicit safe allowlist for git/pnpm/node when the tool works at all; push, force, reset --hard, clean, destructive checkout, branch -D, merge, sudo, npm publish, and network fetch always denied; `task` and `webfetch` always denied). `--auto` is never used.

**Critical operational finding:** this OpenCode installation exposes no shell/command-execution tool to agents in this session (confirmed by direct tool-list introspection: only `read`, `glob`, `grep`, `list`, `edit`/`apply_patch`, `todowrite`, `skill` are available). Every writer therefore edits files and writes tests but cannot run them. **The integration steward runs `pnpm install`, `pnpm test`, `pnpm check`, `pnpm build`, `pnpm package:verify`, `pnpm package:contents`, and all git operations (add/commit) directly in each writer's worktree after the writer reports done.** Writers correctly declined to fabricate verification results once this was discovered - trust that behavior, but always independently re-run verification yourself; do not accept a writer's own claim of passing tests.

**Stall pattern observed repeatedly:** OpenCode writers/reviewers given open-ended "decide whether X is in scope, reason about Y" prompts have stalled multiple times - 15-28 minutes elapsed, near-zero CPU growth (well under 1 second of CPU time added per 5 minutes of wall clock), zero file changes. This is empirically distinct from normal slow-but-working sessions (which show real CPU usage and/or file changes within a few minutes). **Detection rule: if CPU time has grown less than ~1 second over a 5-minute window and no new file changes have appeared, treat it as stalled.** Recovery: killing the process is safe as long as `git status` shows no edits yet (nothing partial to lose); relaunch with a short, concrete, sometimes literally-copy-pasteable instruction instead of an open-ended one. Every relaunch following this pattern finished in 1-10 minutes.

**Codex trial in progress:** the user asked to trial `codex exec -s workspace-write -m gpt-5.6 -c model_reasoning_effort=medium` for the next task (issue 002) once it's unblocked, to compare speed against OpenCode. `codex` is installed at `/opt/homebrew/bin/codex` (codex-cli 0.142.4) and its `workspace-write` sandbox mode should allow it to run its own shell commands, unlike the current OpenCode setup - this may resolve the verification-gap problem above for future writers if it proves reliable. Compare elapsed wall-clock time for issue 002 against the times recorded in the ledger below before deciding whether to switch entirely.

## User Instructions Active This Session (Do Not Relitigate)

- **Priority scope: Critical and High severity only.** Medium and Low issues are explicitly deferred until the user says otherwise. Sequence Critical before High within that scope.
- Issue 017 (High) has a hard technical prerequisite on issue 024 (Medium) and cannot execute without it - stays blocked alongside deferred Medium items; this is a dependency fact, not a priority violation.
- Keep active and deferred `docs/issues/*.md` briefs until their work is completed or explicitly retired.
- User wants updates roughly every 5 minutes during active work, or at every milestone (writer done, review blocks, integration lands), whichever is more frequent.
- Avoid deep unbounded investigation into non-blocking discrepancies (a real instance this session: ~25 minutes spent root-causing why a package file count didn't change with/without a LICENSE file, which turned out to be pre-existing correct behavior, not a bug). Note a discrepancy and move on unless it looks like a real correctness/security risk.

## Human Decisions Recorded This Session

Issue 018: MIT copyright line confirmed by Md Talib as `Copyright (c) 2026 Md Talib`. Year `2026`, holder `Md Talib`, recorded verbatim, not inferred. No other human decision (001, 017, 027) was reopened or answered by an agent.

## Completed And Integrated Into `fix/pre-deployment` (commit `fe30073`)

All of the following are committed, independently reviewed (fresh reviewer per item, no self-review), and merged. The integrated result was re-verified as a whole: `pnpm check` clean, `pnpm test` passing (706 tests after the four Wave-Now fixes, 706+ after 018 - see individual counts below), `pnpm build` + `pnpm package:verify` + `pnpm package:contents` clean (71 deterministic files).

1. **ProcessSupervisor outcome-precedence fix** (High-tied, issue 011 area). Reviewed: APPROVE, no findings. Commits `641ae97`/`4658ee6`.
2. **Package-verifier descendant cleanup fix** (Critical-tied, issue 016 area). Review found an Important finding (a descendant that re-detaches into its own session escapes process-group-based confirmation); resolved by explicitly documenting it as an accepted residual risk outside the Trusted-Project MVP threat model, consistent with AGENTS.md's existing posture on the exact-executable allowlist, rather than adding unproven detection complexity. Commits `1a2a838`/`863b4f0`.
3. **Reviewer descendant cleanup fix** (High-tied, issue 009 area). Same class of finding, same resolution approach. Commits `4231946`/`8733602`.
4. **CLI reviewer-authority removal + unified UTF-8-byte artifact bound** (High-tied, issue 009 area; also closes the README reviewer-option mismatch). Removed `--reviewer-executable`/`--reviewer-argument`/`--reviewer-id`; CLI now uses one fixed reviewer identity through the same canonical-executable policy already enforced for validations. Unified the CLI content limit, Git capture limit, and retained-artifact schema under one `MAX_RETAINED_ARTIFACT_BYTES` constant measured in UTF-8 bytes, not characters. Reviewed: APPROVE, no findings. Commit `2867156`.
5. **Issue 018 (License, High)** - root `LICENSE` (MIT, `Copyright (c) 2026 Md Talib`), `package.json` `license: "MIT"` field, and required SPDX metadata tests (source + packed-tarball assertions). Reviewed: APPROVE. Commit `d402c5e`.

These five items close all 4 originally-listed unresolved review findings from `docs/execution/pre-deployment-handoff.md`, plus issue 018 in full.

## In Progress - Not Yet Integrated

**Issue 014 (cross-process integration lease, High) - the Critical-path prerequisite for issue 002.**
Implemented in worktree `.worktrees/predeploy-e-lease`, branch `fix/predeploy-e-lease`, commit `8cc7d0b`.
Design: durable SQLite-backed lease (new file `src/integration/integration-lease.ts`) keyed by canonical Git common directory plus exact integration ref, stored per-common-directory in a WAL-mode SQLite database. Acquisition is one atomic `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE expires_at <= ?` statement (no read-then-write race). Renewal requires the exact owner token and an unexpired lease; release verifies the owner token; expired leases are safely reclaimable by a new owner. Wraps the full integration critical section in `src/integration/integration-queue.ts` (previously guarded only by the process-local `projectTails` map). Different repositories/refs proceed concurrently. The existing expected-old `update-ref` compare-and-swap remains the final defense, unchanged.
Verified by the integration steward: `pnpm check` clean; `pnpm exec vitest run tests/integration/` - 63 tests passed (7 new lease tests plus updated queue tests proving single-winner-per-key and no cross-repo/ref serialization); `pnpm test` full suite - 709 tests passed.
**Independent review is currently in progress** (`docs/execution/opencode-logs/review-issue-014.log`, launched checking: atomic acquisition, owner-token-gated renewal/release, no dual-ownership possibility, update-ref CAS still intact, no scope creep). Check this log first. If approved, merge `fix/predeploy-e-lease` into `fix/pre-deployment`, re-verify the combined result, then remove the writer worktree/branch.
If the review process shows the stall pattern described above, kill and relaunch with a shorter, more targeted prompt (fewer checklist items per message).

## Next Actions, In Dependency Order

1. Resolve issue 014's pending review (see above) and integrate.
2. **Issue 002 (Critical)** - the one remaining Critical item, and the immediate priority per user instruction. Hard dependency: begins only after issue 014 is reviewed and integrated (not just implemented). Read `docs/issues/002-critical-reconcile-uncertain-worktree-creation.md` for the exact brief before starting. Trial `codex exec` for this one per the user's request (see Codex trial note above); compare timing to the OpenCode timings recorded here.
3. **Issue 003 (High)** - after issue 002's `src/orchestration/recovery.ts` edits are reviewed and integrated on top of issue 014. Use one recovery writer or strictly sequential worktrees for every edit to that file; do not run 002 and 003 concurrently against the same file.
4. **Issue 004 (High)** - Pod G, after both issue 003 and issue 014 are integrated. Touches `src/cli/main.ts`, which the now-integrated CLI-authority fix also touched - read the current integrated `src/cli/main.ts` fully before editing, do not blindly reapply an old diff.
5. Fresh whole-branch specification, code-quality, and security reviews after all of the above integrate, then the full final verification command list from `docs/execution/pre-deployment-handoff.md`'s "Final Verification" section, then `docs/execution/pre-deployment-final-report.md`.

## Deferred (Medium/Low, Per User Instruction - Do Not Start Without New Instruction)

`better-sqlite3` range/support-evidence mismatch (needed for issue 021 acceptance and issue 024), issue 027 (security reporting policy proof), issue 015 (process lifetime registries), issue 024 (CI/release package gates, Node 24/25/26 matrix - also the hard prerequisite for issue 017's actual execution), issue 017 (distribution model - blocked on 024 regardless of priority), issue 010 then 028 (integration-queue.ts, after 014), issue 022 then 025 (Pod G, after 004), issue 007 (task-chain invariants, after all recovery work settles), closing out issues 020/021's acceptance evidence (needs 024).

## Timing Reference (For Comparing Future Agent/Tool Choices)

Actual wall-clock time per item this session (includes any stalls/retries encountered):
- ProcessSupervisor fix: ~10 min.
- Package-verifier fix: ~45 min (included a 25-min OpenCode stall and a ~25-min orchestrator-side investigation into a non-bug - both avoidable, see lessons above).
- Reviewer-cleanup fix: ~35 min (included a 25-min OpenCode stall).
- CLI-authority fix (3 findings, 4 files): ~30 min, no stall.
- Issue 018: ~45 min total across LICENSE/package.json (one stall, ~25 min) and the follow-up SPDX test (one stall, ~15 min, resolved fast once given literal code to insert).
- Issue 014 (large feature: new lease subsystem, crash recovery, multi-process tests): implementation itself took ~15 min with no stall once given a concrete, bulleted, file-anchored brief instead of an open-ended one.

## Next Update

Due at the next writer/review completion, any integration, or after 5 minutes of no milestone (per current user instruction), whichever is first.
