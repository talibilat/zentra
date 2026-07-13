# Pre-Deployment Remediation - Current Execution Record (Handoff)

This is the authoritative current-session record, rewritten fresh for handoff to a new agent/session.
It supersedes any prior version of this same file and the active-process/current-head sections of `docs/execution/pre-deployment-progress.md` (historical, stale) without rewriting that older file.
Treat `docs/execution/pre-deployment-handoff.md` as the authoritative continuation record for original issue-corpus state and dependency order; this file tracks only live orchestration state.
The issue corpus files under `docs/issues/` are unchanged and untouched - do not delete or renumber any of them, regardless of how much of their work is done. The corpus README documents "exactly 28 issue files" and other docs count on that.

## Repository State At This Handoff

`main` is at `ad4daca3e6360bf1266af66ef8f1b0f5100ef415` ("docs: retire completed issue briefs"), unchanged and untouched this session (no writer may ever touch `main`). Note this is newer than the `de15cad` recorded in a prior version of this file; `main` advanced via a docs-only commit between sessions.
Integration branch `fix/pre-deployment` (local only, not yet pushed to origin, not yet merged to main) is at commit `48d1434` ("merge: integrate cross-process integration lease (issue 014)") in worktree `.worktrees/fix-pre-deployment`.
**Nothing in this remediation has been pushed to origin or merged into `main` yet.** Do not describe any of the work below as "pushed" or "merged" until that literally happens through the human-approved integration procedure.

Active worktrees:
- `.worktrees/fix-pre-deployment` (branch `fix/pre-deployment`) - the integration steward's worktree only. No implementation writer may edit here.

The `.worktrees/predeploy-e-lease` writer worktree (branch `fix/predeploy-e-lease`) was used this session to rebase the stale issue-014 candidate onto current `fix/pre-deployment`, fix 3 Critical + 1 Important review findings, and land it. It is removed after being confirmed merged (see below); the branch is retained locally (not pushed) as history.

## Orchestration Model (This Session)

**This session's orchestration differs from the `opencode run`/`codex exec` subprocess model described in earlier versions of this file.** Claude Code itself is running as an interactive agent with the `Agent` tool, and used that tool (not external `opencode`/`codex` CLI subprocesses) to spawn writer and reviewer sub-agents, each scoped to a specific git worktree. The steward (this Claude Code session) independently ran `pnpm install`/`check`/`test`/`build` and git operations itself after each sub-agent reported done - the "never trust a writer's own verification claim" discipline from the prior model still applies and was followed: on the issue-014 fix round, an independent re-verification pass caught nothing wrong, but the steward still re-ran the full suite itself rather than accepting the sub-agent's reported test count at face value.

**Stale-branch discovery for issue 014:** the previously-committed `fix/predeploy-e-lease` candidate (`8cc7d0b`) had diverged from an older base than current `fix/pre-deployment`, so a direct diff against the integration branch showed spurious reversions (LICENSE, package.json, docs cleanup) that were not real issue-014 changes. Fixed by rebasing the branch onto current `fix/pre-deployment` before review (clean rebase, no conflicts) - this isolated the diff to just the 5 genuine lease-related files. **Lesson: always rebase/diff a long-lived candidate branch against the current integration tip before reviewing it, don't assume a branch that "has a commit" is still comparable to the current base.**

## User Instructions Active This Session (Do Not Relitigate)

- **Priority scope: Critical and High severity only.** Medium and Low issues are explicitly deferred until the user says otherwise. Sequence Critical before High within that scope.
- Issue 017 (High) has a hard technical prerequisite on issue 024 (Medium) and cannot execute without it - stays blocked alongside deferred Medium items; this is a dependency fact, not a priority violation.
- Do not delete any `docs/issues/*.md` issue brief file. Update status in this handoff file instead; the corpus stays exactly 28 files.
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

## Completed And Integrated Into `fix/pre-deployment` (commit `48d1434`), This Session

**Issue 014 (cross-process integration lease, High) - the Critical-path prerequisite for issue 002. INTEGRATED.**
Design: durable SQLite-backed lease (new file `src/integration/integration-lease.ts`) keyed by canonical Git common directory plus exact integration ref, stored per-common-directory in a WAL-mode SQLite database. Acquisition is one atomic `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE expires_at <= ?` statement (no read-then-write race). Renewal requires the exact owner token and an unexpired lease; release verifies the owner token; expired leases are safely reclaimable by a new owner. Wraps the full integration critical section in `src/integration/integration-queue.ts`. Different repositories/refs proceed concurrently. The existing expected-old `update-ref` compare-and-swap remains the final defense, unchanged.

First independent review round found 3 Critical + 3 Important findings: (1) lease loss detected only after the critical-section action already completed successfully was being coerced into a false `failed`/`cancelled` terminal outcome, (2) a `finally`-block throw could silently replace a real pending error/evidence from the try block, (3) no `assertLease()` check immediately before the actual `update-ref` git call after a long-running `onPrepared` callback, (4, Important) missing a real two-OS-process end-to-end test as the brief required (only in-process multi-instance tests existed), plus 2 more Important/Minor items on lease-DB placement inside `.git` and unbounded retry backoff left as documented residual risk, out of scope for this round.

Fix round addressed items 1-4: lease-loss-after-success and lease-release failures are now recorded as non-fatal `LeaseAnomaly` diagnostics (`IntegrationQueue.getLeaseAnomalies()`) rather than synthesizing false terminal outcomes; the try-block outcome is captured before any `finally` bookkeeping so a real error/result always survives; `assertLease()` confirmed immediately before the `update-ref` call; a genuine two-process test was added (`tests/integration/fixtures/lease-holder.mjs` spawned via real `execFile`/separate OS processes), which incidentally caught and fixed a real `SQLITE_BUSY` race in first-time database setup between two racing processes.

A second independent verification pass (skeptical re-check against the actual diff, not the fix summary) returned APPROVE: all four items genuinely fixed, no new bugs introduced, full suite green.

Verified by the integration steward independently at each stage (not trusting sub-agent self-reports): rebased-candidate baseline 717/717 tests, post-fix 721/721 tests (5 repeat runs, no flakiness in the new lease tests), post-merge-into-`fix/pre-deployment` 721/721 tests, `pnpm check` clean, `pnpm build` clean at every stage.

**Known pre-existing flake found during merge verification (not caused by issue 014):** `tests/workers/process-supervisor.test.ts` > "gives post-exit timeout precedence over stream and graceful term..." failed once in the full-suite run, passed in 2 subsequent isolated/full reruns. Timing-sensitive, unrelated file (no process-supervisor changes in this merge). Flagged for follow-up per user's engineering-excellence standard; not blocking, not fixed yet.

## Next Actions, In Dependency Order

1. **Issue 002 (Critical)** - the one remaining Critical item, and the immediate priority per user instruction. Unblocked now that issue 014 is reviewed and integrated. Read `docs/issues/002-critical-reconcile-uncertain-worktree-creation.md` for the exact brief before starting.
2. **Issue 003 (High)** - after issue 002's `src/orchestration/recovery.ts` edits are reviewed and integrated on top of issue 014. Use one recovery writer or strictly sequential worktrees for every edit to that file; do not run 002 and 003 concurrently against the same file.
3. **Issue 004 (High)** - Pod G, after both issue 003 and issue 014 are integrated. Touches `src/cli/main.ts`, which the now-integrated CLI-authority fix also touched - read the current integrated `src/cli/main.ts` fully before editing, do not blindly reapply an old diff.
4. Fresh whole-branch specification, code-quality, and security reviews after all of the above integrate, then the full final verification command list from `docs/execution/pre-deployment-handoff.md`'s "Final Verification" section, then `docs/execution/pre-deployment-final-report.md`.
5. Follow up on the process-supervisor flake noted above (not currently scheduled work, but should not be forgotten).

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
