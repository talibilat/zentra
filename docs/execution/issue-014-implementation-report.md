# Issue 014 Implementation Report

## Design

Integration serialization now uses a durable SQLite lease instead of the process-local `projectTails` map.

`IntegrationQueue` resolves the repository identity with `git rev-parse --path-format=absolute --git-common-dir` and canonicalizes the result with `realpath`.

The lease key is the canonical Git common directory plus the exact full integration ref.

Each Git common directory owns a `.zentra-integration-leases.sqlite` WAL database, so independent Zentra processes targeting the same physical repository observe the same lease rows without a separate lock service.

Lease acquisition is one atomic SQLite `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE expires_at <= ?` statement backed by a composite primary key.

There is no read-then-write acquisition window.

Each row records a random UUID owner token, acquisition and expiry timestamps, PID, and hostname.

PID and hostname are diagnostic metadata only and do not participate in ownership decisions.

Lease durations are positive integer milliseconds bounded at 60 seconds.

The queue uses a 10-second lease, renews every 3 seconds, and retries occupied acquisition every 50 milliseconds until the caller aborts or ownership becomes available.

Renewal requires the exact owner token and an unexpired lease.

Release deletes only a row carrying the exact owner token.

An expired row can be atomically replaced by a new UUID owner, while stale renewals and releases cannot affect that owner.

The lease is acquired before source identity and initial Git safety checks and is retained through candidate creation, validation, final checks, expected-old `update-ref`, immediate reconciliation, and candidate cleanup.

Heartbeat loss aborts cancellable work and prevents the queue from proceeding through later ownership assertions.

The existing `git update-ref --no-deref <ref> <new> <expected-old>` compare-and-swap remains unchanged as the final ref-update defense.

## Test Evidence Added

`tests/integration/integration-lease.test.ts` covers one atomic winner across two SQLite connections, independent repository and ref keys, crash expiry and reclaim, stale-owner renewal, renewal loss, nonowner release rejection, UUID/process metadata, and bounded acquisition and renewal.

The existing real-Git two-`IntegrationQueue` test now exercises two independent queue instances sharing the durable database and proves their full validations do not overlap for the same common directory and ref.

New queue tests use source-read barriers to prove a reused project ID does not block different canonical repositories and different exact refs in one canonical repository.

The existing ref-movement test still proves expected-old `update-ref` rejects a competing integration head after validation.

## Verification Status

This implementation session had no shell or command-execution tool, as specified by the issue handoff.

The tests were therefore authored test-first but could not be executed here to capture RED or GREEN output.

The integration steward must run `pnpm test`, `pnpm check`, and `pnpm build`.

The integration steward must also run the packed two-process timestamp test and kill-owner expiry recovery exercise required by the issue's final verification section.

## Integration Steward Verification

- `pnpm check` - clean, no type errors.
- `pnpm exec vitest run tests/integration/` - 2 files, 63 tests passed, including all 7 new `integration-lease.test.ts` tests (atomic single winner, independent keys, crash expiry/reclaim, stale-owner renewal rejection, renewal loss, nonowner release rejection, bounded acquisition/renewal) and the updated queue tests (single winner per common-directory+ref, no serialization across different repositories or refs).
- `pnpm test` (full suite) - 20 files, 709 tests passed.
