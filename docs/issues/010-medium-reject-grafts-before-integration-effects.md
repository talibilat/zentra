# 010 - Reject Grafts Before Integration Effects

Severity: Medium.
Status: Open.
Execution wave: Wave 2, Pod E.
Suggested owner scope: Git object-substitution checks and integration critical section.
Dependencies: Reviewed integration of all ready, non-human-blocked Wave 1 prerequisites and issue 014.
Conflicts and serialization notes: A separate integration writer may begin after issue 014 is reviewed and integrated, but no issue 010 `src/integration/integration-queue.ts` edit may overlap any issue 014 edit to that file.

## Problem

Integration does not establish that Git grafts and replacement objects are absent at the beginning of the integration critical section and immediately before the compare-and-swap ref update.
A late check in tracer receipt validation cannot undo an update that has already used substituted object history.

## Repository Evidence

`src/integration/integration-queue.ts:96-109` enters a process-local project lock and begins source and integration work without calling `assertNoGitObjectSubstitution`.
`src/integration/integration-queue.ts:539-554` performs `git update-ref` without an immediately preceding graft and replacement-object check.
`src/orchestration/tracer-bullet.ts:341-355` validates the completed receipt only after `integrate` may already have updated the integration ref.
`src/orchestration/tracer-bullet.ts:702` contains an object-substitution assertion in receipt validation, which is too late to prevent the effect.

## Failure Sequence Or User Impact

Git graft or replacement configuration changes commit ancestry as observed by integration.
Zentra reads source or candidate history and validates a result under the substituted graph.
The queue updates the integration ref.
Tracer validation later detects substitution, but the protected ref has already moved.

## Acceptance Criteria

- [ ] Call `assertNoGitObjectSubstitution` under the integration lease before reading source, integration, or candidate commit identities.
- [ ] Call it again immediately before `update-ref` while the same lease remains held.
- [ ] Resolve checks against the canonical Git common directory and fail closed on unreadable, malformed, grafted, or replaced state.
- [ ] No source, candidate, merge, validation, callback, or ref-update effect occurs after a failed initial check.
- [ ] No ref update occurs after a failed final check.

## Required Tests

- [ ] Add real-Git integration tests with replacement refs and graft files present before integration starts.
- [ ] Add a race test that introduces substitution after candidate validation but before `update-ref`.
- [ ] Assert the integration ref, ticket worktree, and journal completion evidence remain unchanged on rejection.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Trace the integration critical section and verify both assertions execute while the issue 014 lease is held.
Inspect the integration ref after every adversarial test and confirm no update occurred.

## Non-Goals

This issue does not make repositories with grafts or replacement objects supported.
This issue does not rely on a post-effect validation as rollback.
This issue does not replace atomic expected-old ref updates.
