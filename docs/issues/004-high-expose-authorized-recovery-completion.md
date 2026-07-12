# 004 - Expose Authorized Recovery Completion

Severity: High.
Status: Open.
Execution wave: Wave 3, Pod G.
Suggested owner scope: Recovery CLI commands, public JSON protocol, and operator documentation.
Dependencies: Issues 003 and 014.
Conflicts and serialization notes: Serialize all `src/cli/main.ts` work with issues 022 and 025.

## Problem

The CLI can classify a task as `record_completion` but offers no effectful command that invokes the existing completion operation.
Operators are told that completion is authorized but cannot apply that authorization through the deployable interface.

## Repository Evidence

`src/cli/main.ts:239-257` defines `recover` as a read-only inspection command and returns only a public decision.
`src/orchestration/recovery.ts:522-570` implements effectful `recordCompletion`, but CLI composition does not expose it as a command.
`README.md:85-96` documents recovery inspection and its exit behavior without an apply workflow.

## Failure Sequence Or User Impact

A restart leaves a task with verified integration or cleanup evidence that recovery classifies as `record_completion`.
The operator runs `zentra recover` and receives a successful classification.
No supported CLI command can append the authorized completion evidence.
The task remains indefinitely nonterminal or requires an unsupported direct library invocation.

## Acceptance Criteria

- [ ] Add an explicit effectful recovery apply command with a distinct name and clear operator intent.
- [ ] The command opens the journal read-write and invokes race-safe completion from issue 003 under the lease rules from issue 014.
- [ ] The command obtains fresh authorization rather than accepting a caller-supplied stale decision.
- [ ] Repeated application is idempotent and emits one bounded JSON result without duplicate terminal events.
- [ ] Unsupported recovery actions fail closed with a stable public error and no mutation.

## Required Tests

- [ ] Add CLI end-to-end tests for authorized application from every supported recovery completion state.
- [ ] Add tests for stale authorization, concurrent applicators, already-completed tasks, unknown tasks, and non-completion decisions.
- [ ] Verify read-only `recover` remains non-effectful.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Run the built and packed CLI through inspect, apply, repeated apply, and status against a real temporary Git repository and SQLite journal.
Verify journal event counts and exact JSON output after each command.

## Non-Goals

This issue does not automatically apply recovery during inspection.
This issue does not retry uncertain Git effects.
This issue does not provide arbitrary event append access.
