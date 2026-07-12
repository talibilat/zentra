# Issue 011 Implementation Report

## Status

Implemented and verified on macOS with Node.js `v24.2.0` and pnpm `10.0.0`.
The supervisor now requires the leader result, bounded output processing, and confirmed absence of the owned process group before reporting `completed`.

## Root Cause

The supervisor killed the detached process group only after timeout, cancellation, or output-limit decisions.
After a normal leader exit, it waited for stream closure or a one-second stream grace and then settled without terminating the process group or proving that same-group descendants had exited.
Consequently, a successful leader could leave descendants running after Zentra reported completion.

## Files Changed

- `src/workers/process-supervisor.ts`
- `tests/workers/process-supervisor.test.ts`
- `tests/workers/fixtures/spawn-grandchild.mjs`
- `tests/workers/fixtures/success-with-live-descendant.mjs`
- `tests/workers/fixtures/success-with-inherited-streams.mjs`
- `tests/workers/fixtures/success-with-term-resistant-descendant.mjs`
- `tests/workers/fixtures/success-with-escaped-session.mjs`
- `docs/execution/issue-011-implementation-report.md`

## Tests Added

- A successful leader leaves a live same-group descendant, and the test captures its PID and proves it is absent before the supervisor promise resolves.
- A successful leader leaves inherited stdout and stderr open, and the test proves stream flushing is bounded before descendant termination.
- A same-group descendant ignores `SIGTERM`, and the test proves bounded escalation to `SIGKILL` and confirmed process absence.
- A zero-length forced-confirmation bound exercises the fail-closed `descendant_survived` result.
- A descendant deliberately creates a new session, and the test records the unsupported macOS process-group escape boundary while cleaning up the escaped process.
- Cancellation, timeout, and output-limit tests capture descendant PIDs and assert that each PID is absent immediately after the supervisor promise resolves.

## Commands And Results

- `pnpm install --frozen-lockfile`: passed, reported `Already up to date` and `Done in 120ms`; `pnpm-lock.yaml` remained unchanged.
- `pnpm exec vitest run tests/workers/process-supervisor.test.ts --reporter=verbose`: passed, 1 file and 19 tests.
- `pnpm exec vitest run tests/workers/process-supervisor.test.ts tests/capabilities/validation-runner.test.ts tests/reviews/deterministic-reviewer-adapter.test.ts tests/reviews/review-gate.test.ts --reporter=verbose`: passed, 4 files and 79 tests in 1.43 seconds.
- `pnpm test`: passed, 15 files and 482 tests in 35.29 seconds.
- `pnpm check`: passed with exit code 0 and no TypeScript diagnostics.
- `pnpm build`: passed with exit code 0 and no TypeScript diagnostics.
- `git diff --check`: passed with no output.

## Acceptance Criteria Evidence

- Leader exit starts at most the configured bounded stream-flush grace, after which normal exits terminate the owned group with `SIGTERM` and bounded `SIGKILL` escalation.
- Early stream closure may begin termination before the grace expires because no remaining stream output needs flushing.
- The supervisor polls the process group and treats only `ESRCH` as proof of absence.
- The supervisor settles successfully only after group absence is confirmed.
- Failure to confirm group absence within the forced termination bound changes the result to `failed` with `process group survived bounded termination` evidence.
- Successful fixtures emit valid JSON-line protocol output, exit with code zero, and have no same-group descendant alive when `execute` resolves.
- Validation and reviewer adapter tests pass against the changed supervisor behavior.

## Security Boundary

The supported containment boundary is the detached process group created for the leader on macOS.
Same-group descendants are terminated and their absence is confirmed before completion.
A descendant that deliberately creates a new session and process group escapes that ownership mechanism and cannot be discovered from the original process-group identifier.
The macOS escaped-session fixture documents this unsupported boundary by proving the escaped PID remains alive after the original group is gone, then explicitly kills it during test cleanup.
This implementation does not claim containment of privileged processes, deliberate session escapes, Linux, or Windows without separate ownership mechanisms and platform conformance tests.

## Remaining Concerns

- Deliberate process-group or session escape remains outside the macOS containment guarantee.
- Linux and Windows behavior remains unsupported until platform-specific conformance tests and ownership mechanisms are defined.
- Process-group identity is represented by the original leader PID, as provided by the macOS process-group API.

## Commit Identity

Implementation commit: `102095a92691ef9c5bb06bc81bdada508c0137c0` (`fix: terminate worker descendants after leader exit`).
Author: `Md Talib <talibilat2019@gmail.com>`.
Branch: `fix/predeploy-a-011`.
