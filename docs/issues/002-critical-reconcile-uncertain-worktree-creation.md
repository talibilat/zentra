# 002 - Reconcile Uncertain Worktree Creation

Severity: Critical.
Status: Open.
Execution wave: Wave 2, Pod E.
Suggested owner scope: Worktree preparation, durable task events, and restart recovery.
Dependencies: Reviewed integration of all ready, non-human-blocked Wave 1 prerequisites, including issue 006, and issue 014.
Conflicts and serialization notes: Use the Pod E recovery writer after issue 014 is integrated, complete and integrate all issue 002 edits to `src/orchestration/recovery.ts` before issue 003 begins, and keep worktree ownership separate from issue 010 integration-candidate worktrees.

## Problem

Worktree creation is effectful, but preparation has no durable prepared or observed evidence around `git worktree add`.
Cancellation or timeout can therefore terminalize a task even when Git created the branch or worktree and the caller did not receive a conclusive result.
Recovery then skips the terminal task and cannot reconcile the orphaned state.

## Repository Evidence

`src/workspaces/worktree-manager.ts:105-112` runs `git worktree add -b` as one effect without a durable prepare or observe callback.
`src/orchestration/tracer-bullet.ts:419-445` maps workspace Git termination into a terminal dependency outcome through the generic catch path.
`src/orchestration/recovery.ts:261-268` returns a no-effect `await_reconciliation` decision immediately for every terminal task.

## Failure Sequence Or User Impact

Zentra starts `git worktree add` and receives SIGINT or reaches a timeout after Git creates some or all worktree state.
The tracer appends `cancelled` or `timed_out` because the process result is terminalized as if no uncertain effect remains.
On restart, recovery sees a terminal task and refuses all reconciliation work.
The ticket branch or registered worktree remains orphaned, and a retry can collide with the stale state or conceal an unreviewed effect.

## Acceptance Criteria

- [ ] Worktree creation records durable prepared evidence before invoking Git and durable observed evidence only after exact branch, registration, path, and base facts are inspected.
- [ ] Termination or transport failure after preparation leaves the task nonterminal and explicitly awaiting reconciliation.
- [ ] Recovery distinguishes no effect, fully created exact state, partial state, competing state, and malformed state without automatically retrying uncertain creation.
- [ ] Reconciliation can safely adopt exact intended state or authorize bounded cleanup while preserving conflicting state for an operator.
- [ ] Terminal outcomes are appended only after creation is known not to have occurred or after reconciliation proves a terminal result.

## Required Tests

- [ ] Add real-Git end-to-end tests that interrupt worktree creation before effect, after branch creation, and after registration.
- [ ] Add restart tests for exact adoption, partial-state preservation, conflicting branch identity, and dirty path refusal.
- [ ] Add a regression test proving a terminal task is never used to hide uncertain worktree creation.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Inspect `git worktree list --porcelain`, the ticket ref, the filesystem path, and the journal after every injected interruption point.
Verify that no uncertain creation path automatically retries `git worktree add`.

## Non-Goals

This issue does not change integration candidate creation.
This issue does not delete dirty or conflicting operator state automatically.
This issue does not make all Git operations retryable.
