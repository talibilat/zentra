# Issue 023 Implementation Report

## Status

DONE.

Separate bounded focused and full validation timeouts are configured by each project and recorded in validation diagnostics and durable provenance.

## Root Cause

`ValidationRunner` previously applied one runner-wide 120-second timeout to both focused and full validation.

The project schema had no timeout policy, so configuration parsing could not reject unsafe values or select budgets appropriate to each validation class.

Validation evidence also omitted the selected timeout, which prevented operators from explaining a timed-out result from durable diagnostics.

## Files Changed

- `src/projects/project-config.ts` defines timeout bounds, defaults, strict integer validation, and separate `focusedTimeoutMs` and `fullTimeoutMs` fields.
- `src/capabilities/validation-runner.ts` selects and revalidates the named timeout before effects, sends it to the existing supervisor, and records it in the report and provenance.
- `README.md` documents the exact fields, defaults, inclusive bounds, rejection rules, and recorded evidence.
- Related project, validation, CLI, integration, recovery, review, and workspace tests cover the new project shape and behavior.

## Tests Added

- Schema tests cover omitted defaults, the inclusive `100` ms minimum, the inclusive `1800000` ms maximum, and invalid values.
- Invalid coverage includes below-minimum, over-maximum, negative, zero, fractional, `NaN`, `Infinity`, numeric string, `null`, and boolean values for both timeout fields.
- Runner tests verify focused and full defaults and explicit distinct budgets use the same selection policy.
- Runner tests assert the selected timeout in both report diagnostics and durable provenance.
- A timeout test uses `process.hrtime.bigint()` for monotonic elapsed measurement and verifies `timed_out`, a bounded elapsed interval, and no surviving descendant process.
- CLI tests verify invalid timeout configuration is rejected before journal creation, worktree creation, or Git ref changes.
- Integration timeout coverage now uses the project's full validation timeout instead of a runner-wide override.

## Commands And Results

- `pnpm exec vitest run tests/projects/project-config.test.ts tests/capabilities/validation-runner.test.ts tests/integration/integration-queue.test.ts` passed with 136 tests.
- `pnpm exec vitest run tests/orchestration/cli.test.ts` passed with 62 tests.
- `pnpm exec vitest run tests/orchestration/recovery.test.ts` passed with 56 tests after updating durable report fixtures to include timeout evidence.
- The first full `pnpm test` exposed missing timeout evidence in synthetic recovery fixtures and failed 18 recovery tests.
- The recovery fixture was corrected before final verification.
- Final `pnpm test` passed with 565 tests in 16 files.
- Final `pnpm check` passed.
- Final `pnpm build` passed.
- `git diff --check` passed before the implementation commit.

## Acceptance Criteria Evidence

- Project configuration exposes separate `validations.focusedTimeoutMs` and `validations.fullTimeoutMs` values.
- Focused validation defaults to `30000` ms and full validation defaults to `300000` ms.
- Both values accept only finite integers from `100` through `1800000` ms, inclusive.
- Project parsing rejects invalid or ambiguous timeout values before the CLI creates a journal, worktree, Git ref, or validation process.
- The runner independently validates direct in-memory project values before executable checks, filesystem resolution, invocation reservation, or supervisor dispatch.
- Focused and full validation select their timeout through the same runner policy.
- `ValidationReportSchema` requires matching timeout values in report diagnostics and provenance.
- Timeout provenance participates in the canonical validation digest.
- Existing issue 011 process-group termination and descendant confirmation remain unchanged and are exercised by the validation timeout test.
- The CLI worker timeout constant was not changed.

## Security Boundary

The change does not grant new execution authority or add arbitrary process settings.

Validation commands remain constrained to the approved canonical absolute executable identity, direct argument arrays, `shell: false`, and the supervisor's minimal environment.

The timeout hard maximum prevents project configuration from disabling or effectively unbounding validation deadlines.

The runner revalidates selected timeout values to fail closed if an unparsed or mutated project object reaches the capability boundary.

Configured validation code still runs with the operating-system authority of the Zentra user under the documented Trusted-Project MVP model.

## Remaining Concerns

No issue-specific concerns remain.

The platform-specific process-group behavior remains the existing macOS MVP boundary and was not changed by this issue.

## Commit Identity

Implementation commit: `2c2a713` (`feat: configure validation timeouts`).
