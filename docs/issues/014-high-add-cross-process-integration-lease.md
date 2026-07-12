# 014 - Add Cross-Process Integration Lease

Severity: High.
Status: Open.
Execution wave: Wave 2, Pod E.
Suggested owner scope: Durable integration lease, canonical repository identity, crash recovery, and multi-process tests.
Dependencies: Reviewed integration of all ready, non-human-blocked Wave 1 prerequisites.
Conflicts and serialization notes: Implement this issue first inside Pod E, serialize `src/integration/integration-queue.ts` edits with issues 010 and 028, and establish the lease boundary before issues 003, 010, and 028 begin.

## Problem

Integration serialization is process-local and keyed only by project ID.
Separate Zentra processes can integrate concurrently into the same physical repository and ref, while different refs or repositories with a reused project ID are unnecessarily conflated inside one process.

## Repository Evidence

`src/integration/integration-queue.ts:22-23` stores process-local promise tails in a module-level `Map`.
`src/integration/integration-queue.ts:95-99` keys serialization with `project.projectId`.
`src/integration/integration-queue.ts:799-819` waits only on promises visible to the current JavaScript process and removes the entry after local completion.
`docs/execution/mvp-final-report.md:92` acknowledges that process-local serialization does not coordinate separate Zentra processes.

## Failure Sequence Or User Impact

Two CLI processes target the same Git common directory and integration ref under the same or different project configuration identities.
Each process sees an empty local lock map and starts source, candidate, validation, and integration work concurrently.
Expected-old `update-ref` prevents one lost update but does not prevent duplicated expensive work, overlapping candidate state, or conflicting recovery ownership.

## Acceptance Criteria

- [ ] Add a durable cross-process lease keyed by canonical Git common directory plus exact full integration ref.
- [ ] Each lease records an unguessable owner token, acquisition time, bounded expiry, and enough process metadata for diagnostics without trusting PID liveness alone.
- [ ] Lease acquisition is atomic, renewal is bounded, release verifies owner identity, and expired leases support safe crash recovery.
- [ ] The lease covers initial Git safety checks, source and candidate work, validation, final safety checks, `update-ref`, and immediate reconciliation.
- [ ] Different canonical repositories or exact refs can proceed concurrently.

## Required Tests

- [ ] Add a two-process end-to-end test proving only one integration critical section runs at a time for the same common directory and ref.
- [ ] Add tests for reused project IDs across repositories and different refs in one repository.
- [ ] Add crash, expiry, stale owner, renewal loss, and release-by-nonowner tests.
- [ ] Verify compare-and-swap remains the final ref-update defense.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Launch two packed CLI processes against the same repository and capture timestamps proving serialized critical sections.
Kill the lease owner mid-operation and verify bounded recovery cannot overlap an unexpired owner or inherit stale authorization.

## Non-Goals

This issue does not create a distributed lock service.
This issue does not serialize unrelated refs or repositories.
This issue does not remove expected-old `update-ref` semantics.
