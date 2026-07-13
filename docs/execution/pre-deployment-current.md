# Pre-Deployment Remediation - Current Execution Record (Handoff)

This is the authoritative current-session record, rewritten fresh for handoff to a new agent/session.
It supersedes any prior version of this same file and the active-process/current-head sections of `docs/execution/pre-deployment-progress.md` (historical, stale) without rewriting that older file.
Treat `docs/execution/pre-deployment-handoff.md` as the authoritative continuation record for original issue-corpus state and dependency order; this file tracks only live orchestration state.
Completed issue briefs were removed from `docs/issues/` on 2026-07-13 at the user's direction.

The active issue index is `docs/issues/README.md`, while implementation reports remain the audit record for removed briefs.

## Repository State At This Handoff

`main` is at `ad4daca3e6360bf1266af66ef8f1b0f5100ef415` ("docs: retire completed issue briefs"), unchanged and untouched this session (no writer may ever touch `main`). Note this is newer than the `de15cad` recorded in a prior version of this file; `main` advanced via a docs-only commit between sessions.
Integration branch `fix/pre-deployment` is at commit `af8887c` ("merge: integrate reconciled uncertain worktree creation (issue 002)") in worktree `.worktrees/fix-pre-deployment`. It was pushed to `origin/fix/pre-deployment` once at `99bad06` (issue 014 only, at the user's explicit request); commits since then (issue 002) have NOT been pushed yet.
**Nothing in this remediation has been merged into `main` yet**, and the user explicitly deferred that decision - dependent work continues to branch off `fix/pre-deployment` rather than waiting on a main merge. Do not describe issue 002 as "pushed" or "merged into main" until that literally happens through the human-approved integration procedure.

**Correction to a prior version of this file:** issues 020 and 021 (Medium, platform support and Node engine bounds) were found to already be fully implemented and committed (`0effdc0`, `8fd55ec`), including their required tests - they were never actually open work, just not marked closed in `docs/issues/README.md`. Do not assign a writer to redo them. The only genuine remaining gap they feed into is issue 024's real CI matrix (no `.yml` workflow files exist in this repo yet).

Active worktrees:
- `.worktrees/fix-pre-deployment` (branch `fix/pre-deployment`) - the integration steward's worktree only. No implementation writer may edit here.

The `.worktrees/predeploy-e-lease` writer worktree (branch `fix/predeploy-e-lease`) was used this session to rebase the stale issue-014 candidate onto current `fix/pre-deployment`, fix 3 Critical + 1 Important review findings, and land it. It is removed after being confirmed merged (see below); the branch is retained locally (not pushed) as history.

## Orchestration Model (This Session)

**This session's orchestration differs from the `opencode run`/`codex exec` subprocess model described in earlier versions of this file.** Claude Code itself is running as an interactive agent with the `Agent` tool, and used that tool (not external `opencode`/`codex` CLI subprocesses) to spawn writer and reviewer sub-agents, each scoped to a specific git worktree. The steward (this Claude Code session) independently ran `pnpm install`/`check`/`test`/`build` and git operations itself after each sub-agent reported done - the "never trust a writer's own verification claim" discipline from the prior model still applies and was followed: on the issue-014 fix round, an independent re-verification pass caught nothing wrong, but the steward still re-ran the full suite itself rather than accepting the sub-agent's reported test count at face value.

**Stale-branch discovery for issue 014:** the previously-committed `fix/predeploy-e-lease` candidate (`8cc7d0b`) had diverged from an older base than current `fix/pre-deployment`, so a direct diff against the integration branch showed spurious reversions (LICENSE, package.json, docs cleanup) that were not real issue-014 changes. Fixed by rebasing the branch onto current `fix/pre-deployment` before review (clean rebase, no conflicts) - this isolated the diff to just the 5 genuine lease-related files. **Lesson: always rebase/diff a long-lived candidate branch against the current integration tip before reviewing it, don't assume a branch that "has a commit" is still comparable to the current base.**

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

## Completed And Integrated Into `fix/pre-deployment` (commit `48d1434`), This Session

**Issue 014 (cross-process integration lease, High) - the Critical-path prerequisite for issue 002. INTEGRATED.**
Design: durable SQLite-backed lease (new file `src/integration/integration-lease.ts`) keyed by canonical Git common directory plus exact integration ref, stored per-common-directory in a WAL-mode SQLite database. Acquisition is one atomic `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE expires_at <= ?` statement (no read-then-write race). Renewal requires the exact owner token and an unexpired lease; release verifies the owner token; expired leases are safely reclaimable by a new owner. Wraps the full integration critical section in `src/integration/integration-queue.ts`. Different repositories/refs proceed concurrently. The existing expected-old `update-ref` compare-and-swap remains the final defense, unchanged.

First independent review round found 3 Critical + 3 Important findings: (1) lease loss detected only after the critical-section action already completed successfully was being coerced into a false `failed`/`cancelled` terminal outcome, (2) a `finally`-block throw could silently replace a real pending error/evidence from the try block, (3) no `assertLease()` check immediately before the actual `update-ref` git call after a long-running `onPrepared` callback, (4, Important) missing a real two-OS-process end-to-end test as the brief required (only in-process multi-instance tests existed), plus 2 more Important/Minor items on lease-DB placement inside `.git` and unbounded retry backoff left as documented residual risk, out of scope for this round.

Fix round addressed items 1-4: lease-loss-after-success and lease-release failures are now recorded as non-fatal `LeaseAnomaly` diagnostics (`IntegrationQueue.getLeaseAnomalies()`) rather than synthesizing false terminal outcomes; the try-block outcome is captured before any `finally` bookkeeping so a real error/result always survives; `assertLease()` confirmed immediately before the `update-ref` call; a genuine two-process test was added (`tests/integration/fixtures/lease-holder.mjs` spawned via real `execFile`/separate OS processes), which incidentally caught and fixed a real `SQLITE_BUSY` race in first-time database setup between two racing processes.

A second independent verification pass (skeptical re-check against the actual diff, not the fix summary) returned APPROVE: all four items genuinely fixed, no new bugs introduced, full suite green.

Verified by the integration steward independently at each stage (not trusting sub-agent self-reports): rebased-candidate baseline 717/717 tests, post-fix 721/721 tests (5 repeat runs, no flakiness in the new lease tests), post-merge-into-`fix/pre-deployment` 721/721 tests, `pnpm check` clean, `pnpm build` clean at every stage.

**Known pre-existing flake found during merge verification (not caused by issue 014):** `tests/workers/process-supervisor.test.ts` > "gives post-exit timeout precedence over stream and graceful term..." failed once in the full-suite run, passed in 2 subsequent isolated/full reruns. Timing-sensitive, unrelated file (no process-supervisor changes in this merge). Flagged for follow-up per user's engineering-excellence standard; not blocking, not fixed yet.

## Completed And Integrated Into `fix/pre-deployment` (commit `af8887c`), This Session

**Issue 002 (Critical) - Reconcile Uncertain Worktree Creation. INTEGRATED.**
Root cause: `worktree-manager.ts`'s `create()` ran `git worktree add` as one bare effect with no durable evidence; `tracer-bullet.ts`'s setup-stage catch blindly terminalized on any cancellation/timeout regardless of whether Git had actually created the branch/worktree; `recovery.ts` short-circuited any terminal task to a no-op before ever inspecting real Git state - so an interrupted creation could orphan real Git state that recovery could never see.

Fix: a new durable `task.worktree_creation_started` event records exact intended `{taskId, branch, path, base}` before `git worktree add` runs. A new `verifyExactCreation` independently checks real path existence, exact `git worktree list --porcelain` registration, and branch-commit-equals-base-commit before trusting a reported success. Setup-stage interruption no longer blindly terminalizes - the task is left nonterminal for recovery. `recovery.ts` gained a new inspection branch distinguishing no-effect / exact-match / competing-identity / dirty / partial state, reusing the existing `resume_preparation`/`await_reconciliation` vocabulary (no new action needed).

First independent review found one Critical gap and one Important gap: (1) the "exact match, adopt" recovery decision was correctly classified but nothing in the codebase could actually resume a task from it - `TaskService.create()` throws for an already-created task, so the classification was a dead end; (2) the brief's requested "authorize bounded cleanup" alternative path didn't exist at all.

Fix round added: `WorktreeManager.adopt()` (reuses the same exact-match verification as `create()`, never re-runs `git worktree add`) plus a new `TracerBulletOrchestrator.resume()` entry point that adopts and genuinely continues the task through to completion (proven by a real crash/restart/resume test asserting `task.leased` -> `task.started` -> terminal `completed`, not just a decision label); and `RecoveryService.authorizeBoundedCleanup()` (modeled on the existing `recordCompletion` pattern - re-verifies authorization immediately before acting, TOCTOU-safe), gated to only the narrow confirmed-safe case, refusing for any partial/competing/dirty/already-leased state.

Second independent verification pass: APPROVE. One Minor note left as a follow-up, not blocking: `authorizeBoundedCleanup`'s "nothing created yet" vs "exact match" sub-cases aren't explicitly distinguished by its own gating checks - it currently fails safe only incidentally, via `removeUnleased`'s `lstatSync` throwing ENOENT first. No test explicitly covers this. Worth tightening later, not a live bug.

Verified by the integration steward independently at each stage: baseline 735/735 (post-first-fix-round), 743/743 (post-second-fix-round, in the writer worktree and again post-merge into `fix/pre-deployment`), `pnpm check` clean, `pnpm build` clean at every stage. The writer also found and fixed a genuine pre-existing subprocess-heavy test-timeout flakiness issue (raised vitest's default `testTimeout`/`hookTimeout` from 5000ms to 20000ms, unrelated to this fix's logic, confirmed low-risk/test-only).

## Next Actions, In Dependency Order

1. **Issue 003 (High)** - now unblocked: issue 002's `src/orchestration/recovery.ts` edits are reviewed and integrated on top of issue 014. Use one recovery writer or strictly sequential worktrees for every edit to that file.
2. **Issue 004 (High)** - Pod G, after both issue 003 and issue 014 are integrated (014 done). Touches `src/cli/main.ts`, which the earlier CLI-authority fix also touched - read the current integrated `src/cli/main.ts` fully before editing, do not blindly reapply an old diff.
3. Fresh whole-branch specification, code-quality, and security reviews after all of the above integrate, then the full final verification command list from `docs/execution/pre-deployment-handoff.md`'s "Final Verification" section, then `docs/execution/pre-deployment-final-report.md`.
4. Follow up on the process-supervisor flake noted above, and the Minor `authorizeBoundedCleanup` gating note from issue 002's second review (not currently scheduled work, but should not be forgotten).

## Concurrently In Progress (User-Run, Outside This Steward Session)

**Issue 010 (Medium) - Reject Grafts Before Integration Effects.** The user requested a self-contained writer prompt for this (delivered in-conversation, not recorded here verbatim) and is running it themselves in a separate worktree branched from `fix/pre-deployment`, targeting `src/integration/integration-queue.ts` only. No file overlap with issue 002's files (recovery.ts/tracer-bullet.ts/worktree-manager.ts) or with this steward's worktree. When it's ready, it still needs the same independent-review-before-merge gate as everything else in this ledger before landing on `fix/pre-deployment`.

**Issue 028 (Low)** must NOT start until issue 010 is fully integrated - both own `src/integration/integration-queue.ts` and its brief requires serializing with other integration-queue writers.

## Deferred (Medium/Low, Per User Instruction - Do Not Start Without New Instruction)

`better-sqlite3` range/support-evidence mismatch (needed for issue 024), issue 027 (security reporting policy proof - human decision may already be recorded from a prior session, reconfirm before starting), issue 015 (validation invocation ID lifetime - confirmed independent/safe to run in parallel if the user wants it), issue 024 (CI/release package gates, Node 24/25/26 matrix - also the hard prerequisite for issue 017's actual execution; 020/021 already provide its input evidence), issue 017 (distribution model - blocked on 024 regardless of priority), issue 028 (blocked on 010, see above), issue 022 then 025 (Pod G, after 004), issue 007 (task-chain invariants, after all recovery work settles).

Issues 020 and 021 are NOT open work - see the correction note under "Repository State" above.

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
