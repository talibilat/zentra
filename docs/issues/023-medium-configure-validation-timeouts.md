# 023 - Configure Validation Timeouts

Severity: Medium.
Initial status: Open.
Current disposition: Implemented and verified; see `docs/execution/issue-023-implementation-report.md`.
Execution wave: Wave 1, Pod A.
Suggested owner scope: Project timeout schema, validation runner policy, defaults, maximums, and documentation.
Dependencies: The named-human issue 001 trust-model decision.
Conflicts and serialization notes: After that decision, issue 023 may proceed without waiting for all issue 001 implementation when the approved path leaves timeout work independent, but every shared edit to `src/projects/project-config.ts` or `src/capabilities/validation-runner.ts` must serialize with issue 001.

## Problem

Validation uses a fixed 120-second timeout that cannot reflect the different budgets of focused and full project checks.
Projects with legitimate longer full suites fail, while misconfigured projects can consume the full hard-coded budget for every focused check.

## Repository Evidence

`src/capabilities/validation-runner.ts:98-110` accepts one runner-wide optional timeout and otherwise uses a fixed default.
`src/capabilities/validation-runner.ts:119-142` applies that same runner timeout to either focused or full validation.
`src/projects/project-config.ts:83-93` provides validation commands but no focused or full timeout configuration.

## Failure Sequence Or User Impact

A project has a fast focused check and a full suite that safely needs more than 120 seconds.
Both receive the same fixed budget.
The full suite times out despite normal behavior, or a hung focused command delays every task for two minutes.

## Acceptance Criteria

- [ ] Add separate focused and full validation timeout fields to project configuration.
- [ ] Define secure defaults, minimums, and hard maximums in milliseconds with integer validation.
- [ ] Pass the selected bounded timeout through validation provenance and diagnostics so operators can explain a timeout.
- [ ] Reject invalid, negative, fractional, zero, excessively large, or ambiguous timeout values before any process starts.
- [ ] Keep process termination and descendant confirmation consistent with issue 011.

## Required Tests

- [ ] Add schema boundary tests for defaults, minimums, maximums, and invalid values.
- [ ] Add end-to-end focused and full validation tests with distinct budgets.
- [ ] Add packed CLI tests showing configuration errors occur before journal or Git effects.
- [ ] Add timeout tests that verify terminal outcome, bounded elapsed time, and no surviving process group.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Execute projects using defaults and explicit focused and full values and compare observed elapsed bounds with recorded diagnostics.
Review README examples and security limits for exact agreement with the schema.

## Non-Goals

This issue does not allow unbounded or disabled timeouts.
This issue does not add per-command arbitrary process settings.
This issue does not replace cancellation or output limits.
This issue does not change the CLI worker timeout constant, which is outside the validation-runner timeout evidence.
