# Issue 011 Implementation Report

## Status

Implemented, independently reviewed, corrected, and verified on macOS with Node.js `v24.2.0` and pnpm `10.0.0`.
The supervisor now requires successful leader exit, valid caller-declared invocation-specific protocol output, bounded output processing, and confirmed absence of the owned process group before reporting `completed`.

## Root Cause

The supervisor killed the detached process group only after timeout, cancellation, or output-limit decisions.
After a normal leader exit, it waited for stream closure or a one-second stream grace and then settled without terminating the process group or proving that same-group descendants had exited.
Consequently, a successful leader could leave descendants running after Zentra reported completion.
Later review found that protocol selection was inferred from the user-controlled `taskId` and executable arguments, allowing a worker named `validation` or invoked with `-e` to bypass `artifact.ready` validation.

## Files Changed

- `src/workers/process-supervisor.ts`
- `src/workers/worker-adapter.ts`
- `src/orchestration/tracer-bullet.ts`
- `src/capabilities/validation-runner.ts`
- `tests/support/deterministic-reviewer-adapter.ts`
- `tests/workers/process-supervisor.test.ts`
- `tests/orchestration/recovery.test.ts`
- `tests/workers/fixtures/spawn-grandchild.mjs`
- `tests/workers/fixtures/success-with-live-descendant.mjs`
- `tests/workers/fixtures/success-with-inherited-streams.mjs`
- `tests/workers/fixtures/success-with-term-resistant-descendant.mjs`
- `tests/workers/fixtures/success-with-escaped-session.mjs`
- `tests/workers/fixtures/waiting-leader.mjs`
- `docs/execution/issue-011-implementation-report.md`

## Independent Review Fixes

- Process exit success and protocol completion are separate conditions.
- Worker invocations require exactly one strict `artifact.ready` event, reviewer invocations require exactly one strict review decision, and validation invocations retain their exit-status protocol.
- Stream, graceful-termination, and forced-termination deadlines use `process.hrtime.bigint()` rather than wall-clock time.
- Invalid, negative, non-finite, or timer-overflow duration values are rejected.
- Group and leader signal denial cannot prevent settlement because absence confirmation is bounded and only `ESRCH` proves absence.
- Cancellation, timeout, and output-limit decisions override an unsettled successful exit and begin forced termination immediately.

## Round Three Review Fixes

- Reviewer completion now uses the exported `ReviewDecisionSchema`, exactly matching the downstream reviewer adapter's strict validation and rejecting impossible calendar dates before the supervisor can report `completed`.
- The inherited-stream regression fixture records monotonic timestamps from the leader's `exit` hook and the descendant's `SIGTERM` hook.
- The stream-grace assertion now measures termination from observed leader exit, excluding process spawn and fixture startup latency, and checks both the configured lower bound and bounded forced-termination window.

## Round Four Review Fixes

- `ProcessSupervisor.execute()` now requires an explicit `worker`, `validation`, or `reviewer` invocation kind from its trusted caller.
- Protocol selection no longer reads `taskId` or executable arguments.
- The tracer bullet passes `worker`, the validation runner passes `validation`, and the supervised deterministic reviewer adapter passes `reviewer`.
- Production `ProcessReviewerAdapter` continues to validate its separate stdin-based reviewer protocol directly and does not call `ProcessSupervisor`.
- A worker named `validation` and a worker invoked through Node `-e` both fail without exactly one valid `artifact.ready` event.

## Tests Added

- Successful leaders leave live same-group descendants, and the tests capture each PID while `execute()` is pending, prove the promise remains pending while the PID exists, and prove absence before resolution.
- A successful leader leaves inherited stdout and stderr open, and the test proves descendant termination starts no earlier than the configured stream grace after leader exit and remains inside the bounded termination window.
- A same-group descendant ignores `SIGTERM`, and the test proves bounded escalation to `SIGKILL`, pending-promise behavior, and confirmed process absence.
- A zero-length forced-confirmation bound exercises the fail-closed `descendant_survived` result.
- A descendant deliberately creates a new session, and the test records the unsupported macOS process-group escape boundary while cleaning up the escaped process.
- Cancellation, timeout, and output-limit tests capture descendant PIDs and assert that each PID is absent immediately after the supervisor promise resolves.
- Invalid worker protocol output after exit code zero maps to `failed`, while valid validation output maps to `completed`.
- Denied process-group signaling and denied group-plus-leader signaling both settle within a fixed upper bound, with tests treating only `ESRCH` as process absence.
- Post-exit cancellation and timeout bypass the stream and graceful-termination windows.
- Invalid supervisor and request duration values are rejected.
- An impossible reviewer calendar date that the downstream schema rejects cannot produce a supervisor `completed` result.
- Conflicting `taskId`, executable arguments, and explicit invocation kinds prove that user-controlled request data cannot select the protocol.
- Reviewer and validation invocations continue to enforce their caller-declared protocols.

## Commands And Results

- `pnpm install --frozen-lockfile`: passed, reported `Already up to date` and `Done in 120ms`; `pnpm-lock.yaml` remained unchanged.
- The initial focused regression run failed four new tests for invalid protocol acceptance, denied leader signaling, post-exit cancellation precedence, and invalid durations, confirming the review findings before implementation.
- The round-three focused regression run failed the new invalid-calendar-date test against the previous implementation because the supervisor reported `completed`, while the synchronized stream-grace test passed.
- The round-four focused regression run failed all four discriminator tests against the previous implementation in the expected directions: two worker bypasses and one reviewer spoof reported `completed`, while a validation invocation was incorrectly rejected.
- `pnpm exec vitest run tests/workers/process-supervisor.test.ts --reporter=verbose`: passed, 1 file and 31 tests.
- `pnpm exec vitest run tests/orchestration/tracer-bullet.test.ts --reporter=verbose`: passed, 1 file and 68 tests.
- `pnpm exec vitest run tests/capabilities/validation-runner.test.ts --reporter=verbose`: passed, 1 file and 22 tests.
- `pnpm exec vitest run tests/reviews/deterministic-reviewer-adapter.test.ts --reporter=verbose`: passed, 1 file and 29 tests.
- `pnpm exec vitest run tests/workers/process-supervisor.test.ts tests/capabilities/validation-runner.test.ts tests/reviews/deterministic-reviewer-adapter.test.ts tests/reviews/review-gate.test.ts --reporter=verbose`: passed, 4 files and 86 tests.
- `pnpm exec vitest run tests/workers/process-supervisor.test.ts --reporter=verbose -t "descendant|stream|termination|deadline|abort|timeout|output|protocol|duration|signaling"`: passed, 1 file with 16 selected tests and 10 skipped tests.
- `pnpm test`: passed, 16 files and 545 tests in 46.19 seconds.
- `pnpm check`: passed with exit code 0 and no TypeScript diagnostics.
- `pnpm build`: passed with exit code 0 and no TypeScript diagnostics.
- `git diff --check`: passed with no output.

## Acceptance Criteria Evidence

- Leader exit starts at most the configured bounded stream-flush grace, after which normal exits terminate the owned group with `SIGTERM` and bounded `SIGKILL` escalation.
- Early stream closure may begin termination before the grace expires because no remaining stream output needs flushing.
- The supervisor polls the process group and treats only `ESRCH` as proof of absence.
- The supervisor settles successfully only after group absence is confirmed.
- Failure to confirm group absence within the forced termination bound changes the result to `failed` with `process group survived bounded termination` evidence.
- A zero exit becomes `completed` only when the decoder for that invocation accepts its protocol output.
- The invocation kind is a required typed argument supplied separately from the process request and is never inferred from user-controlled request fields.
- Reviewer output is accepted by the same exported strict schema used by the downstream reviewer adapter.
- Successful worker fixtures emit one valid `artifact.ready` JSON line, exit with code zero, and have no same-group descendant alive when `execute` resolves.
- Cancellation and timeout supersede an unsettled exit and immediately enter forced cleanup instead of consuming remaining stream or graceful-termination grace.
- Monotonic stream and termination deadlines remain bounded across wall-clock changes.
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

Initial implementation commit: `102095a92691ef9c5bb06bc81bdada508c0137c0` (`fix: terminate worker descendants after leader exit`).
Independent review fix commit: `d453bab209dc51e8bd57cc61ef11747a013b89ee` (`fix: harden worker completion supervision`).
Round three review fix commit: `ef2d8577f2e493d326098cc52f1167d458e4cc78` (`fix: align supervisor protocol validation`).
Pre-round-four integration sync commit: `d4eb289` (`merge: sync fix/pre-deployment into 011 branch before coordinated protocol-discriminator fix`).
Round four review fix commit: `cbfde0f9e044460804d72ec736b0756bb72618d4` (`fix: require explicit supervisor protocols`).
Author: `Md Talib <talibilat2019@gmail.com>`.
Branch: `fix/predeploy-a-011`.
