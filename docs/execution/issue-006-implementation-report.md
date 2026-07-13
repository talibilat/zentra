# Issue 006 Implementation Report

## Status

Implemented and verified.

The tracer now records patch, focused-validation, independent-review, and integration-receipt artifacts as explicit typed journal events.
Artifact replay is independent of mutable worktree and candidate paths.

## Root Cause

The artifact contract previously described only common metadata.
The tracer embedded worker patch metadata, validation reports, review decisions, and integration receipts exclusively in lifecycle events.
Consumers therefore had no validated artifact stream and had to understand lifecycle-specific payloads.

## Files Changed

- `src/contracts/artifact.ts` defines strict kind-specific artifact-recorded schemas, safe logical paths, exact evidence digest calculation, and the pure `projectArtifacts` replay projection.
- `src/orchestration/tracer-bullet.ts` records each artifact when its bounded evidence becomes durable.
- `src/tasks/task-projection.ts` treats artifact events as lifecycle-neutral while validating the artifact projection during every task replay.
- `tests/contracts/artifact.test.ts` covers every artifact kind, malformed metadata, replay, duplicates, digest contradiction, missing references, and invalid ordering.
- `tests/orchestration/tracer-bullet.test.ts` verifies artifact enumeration and digest binding across completion and worker, validation, review, commit, and integration failure boundaries.

## Artifact Contract

Patch artifacts retain the reviewed diff digest, changed logical path, and changed-file content digest without retaining unbounded diff bytes.
Validation report artifacts retain the bounded validation report and use the same canonical digest consumed by independent review.
Review report artifacts retain the issue 009 content-aware decision and digest the exact bounded decision bytes consumed by commit and integration.
Integration receipt artifacts retain the bounded queue receipt and digest the exact receipt bytes used by integration observation and completion.

Artifact IDs are stable UUIDs persisted in the journal event.
Artifact paths are safe logical paths under `artifacts/` and do not identify temporary worktrees or integration candidates.
Artifact creation timestamps are persisted ISO timestamps created immediately before the event append.

## Replay Validation

`projectArtifacts` rebuilds artifact metadata and retained evidence exclusively from stored events.
Replay rejects malformed event payloads, unsafe paths, duplicate artifact IDs, duplicate artifact kinds, contradictory evidence digests, invalid artifact ordering, events after terminalization, and lifecycle evidence without the required prior artifact.
Replay also binds the review artifact to the exact patch and focused-validation artifacts and binds the integration receipt to the exact review artifact.
Legacy streams without artifact events remain readable, while any stream that enters artifact mode is validated strictly.

## Tests Added

- Contract acceptance for patch, validation report, review report, and integration receipt events.
- Rejection of absolute paths, traversal paths, malformed digests, and empty identities.
- Journal-only artifact reconstruction after successful cleanup removes the ticket worktree.
- Duplicate identity, contradictory digest, missing artifact reference, and out-of-order artifact rejection.
- Completion evidence proving the patch digest equals the content-aware review diff digest.
- Completion evidence proving the integration receipt digest equals the exact completed receipt bytes.
- Failure-stage artifact enumeration for worker cancellation, validation failure, review denial or rejection, commit termination, and integration failure.

## Commands And Results

- `pnpm exec vitest run tests/contracts/artifact.test.ts tests/orchestration/tracer-bullet.test.ts`: passed, 2 test files and 81 tests.
- `pnpm test`: passed, 17 test files and 558 tests.
- `pnpm check`: passed with no TypeScript errors.
- `pnpm build`: passed.

## Acceptance Criteria Evidence

- Four explicit artifact-recorded event schemas use strict kind-specific payload contracts.
- Stable IDs, task IDs, kinds, safe logical paths, SHA-256 digests, and creation timestamps are persisted at each durable evidence boundary.
- Validation uses the patch diff digest as its subject, review uses the exact patch and validation digests, commit uses the reviewed patch digest, and integration and completion use the exact recorded review and receipt evidence.
- `projectArtifacts(journal.readStream(taskId))` enumerates all artifacts after the worktree has been removed.
- Tampered replay fails closed for identity, digest, order, and missing-reference violations with deterministic bounded errors.

## Security Boundary

No remote blob storage or general shell capability was introduced.
No unbounded diff, standard output, or standard error content was added to the journal.
Artifact paths are logical identifiers and do not grant filesystem authority.
Lifecycle events remain intact for recovery and audit behavior.

## Remaining Concerns

The MVP retains bounded validation, review, and receipt evidence directly in artifact events.
Patch diff bytes remain intentionally absent, so the patch artifact proves integrity and provenance but does not provide blob retrieval.
A future artifact store can extend the safe logical path semantics without changing artifact identity or digest behavior.

## Commit Identity

- Branch: `fix/predeploy-b-artifacts`.
- Implementation and report: the commit containing this report.
