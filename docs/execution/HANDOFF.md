# Zentra MVP Execution Handoff

This handoff records the current Zentra-only MVP state after Wave 2 integration.
The authoritative implementation specification is `docs/plans/mvp.md`, and the architectural constraints are in `AGENTS.md` and `docs/design/orchestrator.md`.

## Current Branch And Commit

- Integration worktree: `/Users/talibilat/Documents/Projects/zentra/.worktrees/zentra-mvp`.
- Integration branch: `feature/zentra-mvp` at `55633dc`, pushed to `origin/feature/zentra-mvp`.
- `main` remains unchanged and must not receive the MVP branch.
- Repository-local Git identity is configured as `Md Talib / talibilat2019@gmail.com`.

## Completed And Integrated

- Documentation baseline: `823c18a`.
- Task 1 contracts and scaffold: `5bdb0c5`.
- Task 2 durable SQLite journal: `8e62183`, merged at `274773e`.
- Task 4 project registry and worktrees: `33b5ba2`, merged at `c519b36`.
- Task 5 deterministic worker supervision: `eded574`, merged at `23ad815`.
- Task 3 durable task projection: `d889433`, merged at `05b20fa`.
- Task 6 validation and independent review: `e8a558c`, merged at `55633dc`.

## Wave 2 Review Outcomes

Task 3 fixed all blocking findings before integration.
The fixes prevent invalid transitions, invalid creation input, malformed payloads, serialization-changing payloads, and empty task identities from poisoning the durable event stream.
The projection permits reviewer timeout, rejects repeated review requests, and replays the exact JSON-canonical payload written to SQLite.

Task 6 fixed all blocking findings before integration.
The fixes retain actual nonzero validation exit codes, raw JSON validation output, exact command snapshots, framed output digests, and strictly decoded reviewer decisions.
The review gate requires focused validation, binds the decision to the requested independent reviewer, recomputes evidence digests, and rejects stale or inconsistent evidence.
The process supervisor now retains a bounded shared stdout/stderr budget and handles output that exceeds the limit after a provisional successful parent exit.

Independent specification and quality re-reviews reported no unresolved Critical or Important findings for either task.

## Current Verification

- After Task 3 merge at `05b20fa`: 97/97 tests passed, `pnpm check` passed, and `pnpm build` passed.
- After Task 6 merge at `55633dc`: 138/138 tests passed, `pnpm check` passed, and `pnpm build` passed.
- Task 3 branch focused verification: 46/46 tests passed and `pnpm check` passed.
- Task 6 branch verification: 50 focused Task 5/6 tests passed, 92/92 full branch tests passed, and `pnpm check` passed.

## Exact Next Step

Implement Task 7 from `docs/plans/mvp.md` lines 988-1061.
Use real temporary Git repositories and test first.
The integration queue must serialize per project, create a disposable candidate from the current integration head, merge the reviewed source commit only in that candidate, run full validation there, and update the integration branch only with compare-and-swap semantics after validation succeeds.
Conflict, stale review, cancellation, timeout, failed validation, or a changed integration head must leave the integration branch unchanged and preserve the ticket worktree.
Do not automatically retry uncertain Git effects.

After Task 7 passes independent specification and quality review, continue Tasks 8, 9, and 10 sequentially.
Run focused verification and full `pnpm test`, `pnpm check`, and `pnpm build` gates before each integration.

## Active Worktrees

- `.worktrees/zentra-mvp` points to `feature/zentra-mvp` and owns integration plus Tasks 7-10 unless a new task worktree is deliberately created.
- `.worktrees/mvp-task-projection` points to `feature/mvp-task-projection` at `d889433`, is clean, and tracks its pushed remote branch.
- `.worktrees/mvp-validation-review` points to `feature/mvp-validation-review` at `e8a558c`, is clean, and tracks its pushed remote branch.
- `.worktrees/mvp-journal`, `.worktrees/mvp-workspaces`, and `.worktrees/mvp-worker` contain completed clean feature branches.
- Preserve all worktrees until the MVP is complete unless the user explicitly authorizes removal.

## Blockers

None.

## Standing Restrictions

- Do not modify Vox or Zoe.
- Do not add voice, email, meetings, personal tasks, devices, distributed execution, real coding harnesses, or future capability packages.
- Do not merge `feature/zentra-mvp` into `main`.
- Do not force-push, amend commits, delete branches, create a pull request, or create GitHub issues.
- Do not expose a general shell capability or inherit arbitrary parent secrets.
- Do not automatically retry a potentially effectful operation after an uncertain result.
- Preserve failed worktrees and exact blocker evidence.
- Fix every Critical and Important finding before integration.
- Do not claim completion without fresh verification.

## Final Required Evidence

The final report must prove the complete tracer bullet, exact event replay, deterministic cancellation and timeout outcomes, failed-worktree preservation, effect-safe recovery, independent worker and reviewer identities, review evidence bound to the committed diff, candidate-worktree validation, unchanged integration state after candidate failure, serialized integration, reduced child environments, and absence of a general shell capability.
