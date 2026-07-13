# Process Supervisor Finding Implementation Report

## Reproduction

The supervisor previously promoted an unconfirmed process-group exit to `descendant_survived` only when the prior decision was `exit`.
When process-group and leader signaling were denied, cancellation therefore returned `cancelled` and timeout returned `timed_out` even though the process remained alive after the forced termination bound.

The regression coverage now exercises both paths with a real waiting child process while intercepting termination signals with `EPERM`.
Each test confirms that the process remains alive and requires the supervisor to return `failed` with the `process group survived bounded termination` diagnostic.

## Fix

`terminateAndSettle` now assigns `descendant_survived` whenever bounded process-group exit confirmation fails, regardless of whether the preceding decision was exit, cancellation, or timeout.
An exit decision retains its observed exit code, while non-exit decisions use a null exit code.
The existing result mapping converts `descendant_survived` to the approved terminal outcome `failed`.
No operation is retried.

## Test Evidence

The cancellation and timeout regression tests were added to `tests/workers/process-supervisor.test.ts`.
Command execution was unavailable in the implementation session; the integration steward ran verification directly in this worktree afterward:

- `pnpm exec vitest run tests/workers/process-supervisor.test.ts` - 32 tests passed, including both new regressions.
- `pnpm test` (full suite) - 19 files, 701 tests passed.
- `pnpm check` - clean, no type errors.

## Commit Identity

Committed by the integration steward as `641ae97` ("fix: surface descendant_survived for any unconfirmed group exit") after the above verification, since Git command execution was unavailable in the implementation session.
