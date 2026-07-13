# Reviewer Cleanup Implementation Report

## Reproduction

The regression test starts a reviewer that emits a protocol-valid approval after spawning a same-process-group descendant that remains alive with closed standard streams.
The test denies the adapter's negative-PID `SIGKILL` while allowing process-group existence probes, reproducing a surviving descendant after forced termination is attempted.
Before the fix, `finish()` sent `SIGKILL` and immediately accepted the valid decision without proving the process group was absent.
The test requires a typed `ReviewerExecutionError` with the canonical `failed` outcome, confirms that group `SIGKILL` was attempted, and confirms that the simulated surviving descendant remained observable until test cleanup.

## Fix

Reviewer settlement now polls the owned process group with signal `0` after `SIGKILL`.
Only `ESRCH` is accepted as proof that the process group and its contained descendants are absent.
The adapter waits for that proof for a bounded one-second interval before resolving or rejecting the reviewer execution.
If absence cannot be confirmed, it rejects with `failed` and does not parse or accept the review decision.
Existing cancellation, timeout, and execution failures retain their canonical outcomes only after process-group absence has been confirmed.

## Residual Risk

The exit check covers process-group membership only; a descendant that re-detaches into a new session can escape it, which is accepted outside the Trusted-Project MVP threat model because, like the exact-executable allowlist, this mechanism is not a sandbox against deliberate actions by an already-trusted executable.

## Test Evidence

The writer session that authored this fix had no command-execution tool available and explicitly declined to claim verification results.
The integration steward (this orchestration process) ran the following directly in this worktree after the writer finished:

- `pnpm exec vitest run tests/reviews/` - 2 files, 59 tests passed, including the new surviving-descendant regression.
- `pnpm test` (full suite) - 19 files, 701 tests passed.
- `pnpm check` - clean, no type errors.
