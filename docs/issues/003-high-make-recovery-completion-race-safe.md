# 003 - Make Recovery Completion Race-Safe

Severity: High.
Status: Open.
Execution wave: Wave 2, Pod E.
Suggested owner scope: Recovery authorization, journal concurrency, and integration lease enforcement.
Dependencies: Reviewed integration of all ready, non-human-blocked Wave 1 prerequisites and integrated issues 014 and 002.
Conflicts and serialization notes: Use the same Pod E recovery writer as issue 002, or a new strictly sequential recovery worktree, only after issue 002 recovery edits are reviewed and integrated on top of issue 014.

## Problem

Recovery completion can append terminal evidence after the Git facts that authorized completion have become stale.
Some branches re-inspect, but the inspection and append are not protected by one fresh authorization or lease immediately before every effectful append.

## Repository Evidence

`src/orchestration/recovery.ts:522-537` calls `inspect`, then rereads the journal and derives a receipt without holding an authorization lease over current Git state.
`src/orchestration/recovery.ts:539-570` appends cleanup or completion events across several branches, while only the `cleanup_started` branch performs an extra inspection.
`tests/orchestration/recovery.test.ts:1372-1374` already exercises competing completion callers, which demonstrates that concurrency is an expected boundary rather than an impossible state.

## Failure Sequence Or User Impact

Recovery inspects an integration ref and workspace and decides that completion is authorized.
Another process changes relevant Git or lease state after inspection but before the append.
The first process appends `task.completed` from stale evidence.
The journal now asserts completion even though current repository state no longer satisfies the completion invariant.

## Acceptance Criteria

- [ ] Every recovery completion path obtains a fresh, single-use authorization tied to exact journal version, canonical Git common directory, exact integration ref, and inspected Git identities.
- [ ] Authorization is validated under the applicable lease immediately before each effectful append.
- [ ] Journal compare-and-swap prevents two callers from consuming the same authorization.
- [ ] A changed ref, worktree fact, stream version, lease owner, or expired authorization fails closed without appending completion.
- [ ] Repeated application after successful completion is idempotent and returns the existing terminal view.

## Required Tests

- [ ] Add deterministic concurrency tests that pause between inspection, authorization, and append while another caller changes Git or journal state.
- [ ] Add two-process tests when issue 014's durable lease is available.
- [ ] Cover `cleanup_started`, `cleanup_observed`, `cleanup_reconciled`, `cleanup_completed`, `integration_prepared`, and `integration_observed` completion paths.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Run the recovery race suite repeatedly and verify exactly one valid completion with no stale append.
Review each `recordCompletion` append site and show the immediately preceding fresh authorization check.

## Non-Goals

This issue does not add a general automatic recovery retry loop.
This issue does not authorize completion from approximate Git state.
This issue does not replace issue 014's cross-process integration serialization.
