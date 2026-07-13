# Issue 006 Implementation Report

## Status

Retry 1 implemented and verified.

The tracer now records patch, focused-validation, independent-review, and integration-receipt artifacts as explicit typed journal events.
Artifact replay is independent of mutable worktree and candidate paths.
The implementation was recovered after integration commit `55076c2` was reverted by `57d812c`, then corrected for the omitted delete-all-artifact-events review finding.
The prior report overstated completion because artifact markers and their artifacts were still separate writes, task replay tolerated marker-only tails, success lifecycle events accepted unsuccessful evidence, failed final receipts could replace prepared provenance, and prototype-named artifact IDs were not retained safely.
Retry 1 resolves those remaining defects without changing the journal adapter, recovery service, or integration queue.

## Root Cause

The artifact contract previously described only common metadata.
The tracer embedded worker patch metadata, validation reports, review decisions, and integration receipts exclusively in lifecycle events.
Consumers therefore had no validated artifact stream and had to understand lifecycle-specific payloads.

The recovered replay projection enabled strict lifecycle-reference validation only after it encountered a surviving artifact event.
Deleting every artifact event therefore left artifact mode disabled and incorrectly returned an empty artifact view.
Because stream versions are immutable journal identities, deleted events leave a version gap that now activates strict artifact replay and exposes the first missing lifecycle dependency.

Issue 023 also added bounded validation timeout evidence after the original issue 006 branch diverged.
The recovered artifact schema now accepts the current bounded timeout fields, requires top-level and provenance timeout values to agree, and preserves the canonical validation digest consumed by review.

The remaining atomicity defect came from appending `task.artifact_recording`, the typed artifact, and its consuming lifecycle event independently.
That design required task replay to tolerate an otherwise invalid pending marker and exposed partial protocol states after process interruption.
The replay defects came from checking evidence shape and digest without requiring successful outcomes at success-only lifecycle boundaries, deriving failed final receipt provenance from the final receipt itself, and assigning arbitrary artifact IDs into ordinary objects.

## Files Changed

- `src/contracts/artifact.ts` defines strict kind-specific artifact-recorded schemas, safe logical paths, exact evidence digest calculation, and the pure `projectArtifacts` replay projection.
- `src/orchestration/tracer-bullet.ts` records each artifact when its bounded evidence becomes durable.
- `src/tasks/task-projection.ts` treats artifact events as lifecycle-neutral while validating the artifact projection during every task replay.
- `src/tasks/task-service.ts` validates a complete nonempty prospective event batch and passes it to one existing journal transaction.
- `tests/contracts/artifact.test.ts` covers every artifact kind, malformed metadata, replay, duplicates, digest contradiction, missing references, and invalid ordering.
- `tests/orchestration/tracer-bullet.test.ts` verifies artifact enumeration and digest binding across completion and worker, validation, review, commit, and integration failure boundaries.

## Artifact Contract

Patch artifacts retain the exact bounded inspected diff bytes, the independently recomputed diff digest, changed logical path, and changed-file content digest.
Validation report artifacts retain the bounded validation report and use the same canonical digest consumed by independent review.
Review report artifacts retain the issue 009 content-aware decision and digest the exact bounded decision bytes consumed by commit and integration.
Integration receipt artifacts retain the bounded queue receipt and digest the exact receipt bytes used by integration observation and completion.

Artifact IDs are stable UUIDs persisted in the journal event.
Artifact paths are safe logical paths under `artifacts/` and do not identify temporary worktrees or integration candidates.
Artifact creation timestamps are persisted ISO timestamps created immediately before the event append.

## Replay Validation

`projectArtifacts` rebuilds artifact metadata and retained evidence exclusively from stored events.
Replay hashes the retained exact patch diff bytes and rejects the artifact if either `artifact.sha256` or `evidence.diffSha256` contradicts that independently computed digest.
Replay rejects malformed event payloads, unsafe paths, duplicate artifact IDs, duplicate artifact kinds, contradictory evidence digests, invalid artifact ordering, events after terminalization, and lifecycle evidence without the required prior artifact.
Replay also rejects a lifecycle stream after every artifact event has been deleted because the retained immutable stream versions reveal the removed records.
Replay also binds the review artifact to the exact patch and focused-validation artifacts and binds the integration receipt to the exact review artifact.
Identity, path, timestamp, command, output, diff, review, and receipt strings now have explicit contract bounds.
Malformed payload and duplicate-identity failures use fixed deterministic messages without raw Zod diagnostics or attacker-controlled identity interpolation.
Contiguous legacy streams without artifact events remain readable, while streams containing artifact events or deleted-event version gaps are validated strictly.

Every newly recorded artifact is preceded by a `task.artifact_recording` marker that binds protocol version, artifact identity, kind, and digest.
The marker, exact marked artifact, and consuming lifecycle event are validated prospectively and committed in one `EventJournal.append` transaction.
Both task and artifact replay fail closed on marker-only tails and markers followed by any nonmatching event.

Lifecycle replay now requires `task.review_requested.validation`, `task.review_approved.review`, `task.integration_started.review`, and `task.integration_prepared.receipt` rather than validating those properties only when present.
Focused validation provenance must name the exact patch digest, review evidence must use the requested reviewer, and receipt evidence must match the stream task, created project, integration source, retained review, candidate result, and full-validation subject.

Integration receipt artifacts now distinguish optional `prepared` and `final` phases.
The recoverable pre-CAS completed receipt is recorded as prepared evidence, while a deterministic post-preparation CAS failure records a final failed receipt that changes only the outcome and retains the prepared task, project, source, base, result, review, and validation provenance.
Successful integration retains the prepared receipt as the exact final receipt only after queue provenance and Git state are verified.
Legacy pre-CAS receipt events without an explicit phase are inferred as prepared only when a later matching `task.integration_prepared` event proves that historical meaning.

Validation artifact evidence now enforces the canonical outcome and exit-code combinations and requires `finishedAt` not to precede `startedAt`.
Historical reports that predate timeout fields remain accepted, while reports that contain timeout fields must retain matching bounded top-level and provenance values.

## Tests Added

- Contract acceptance for patch, validation report, review report, and integration receipt events.
- Rejection of absolute paths, traversal paths, malformed digests, and empty identities.
- Kind-specific malformed evidence rejection for patch, validation report, review report, and integration receipt events.
- Rejection of oversized identity and retained evidence strings.
- Rejection when both recorded patch digest fields are forged but contradict the retained diff bytes.
- Bounded deterministic replay errors for malformed payloads and duplicate identities.
- Journal-only artifact reconstruction after successful cleanup removes the ticket worktree.
- Duplicate identity, contradictory digest, missing artifact reference, and out-of-order artifact rejection.
- Completion evidence proving the patch digest equals the content-aware review diff digest.
- Completion evidence proving the integration receipt digest equals the exact completed receipt bytes.
- Failure-stage artifact enumeration for worker cancellation, validation failure, review denial or rejection, commit termination, and integration failure.
- End-to-end deletion of every `artifact.*_recorded` event followed by replay rejection for the missing patch artifact.
- Acceptance and bounded mismatch rejection for issue 023 validation timeout evidence.
- Crash-after-append deletion tests for patch, validation, review, and integration-receipt artifacts.
- Missing-property tamper tests for every evidence-bearing lifecycle event.
- Substitution tests for focused subject, requested reviewer, receipt task, project, source, result, and full-validation provenance.
- A real-Git tracer test where the integration ref moves after preparation and CAS returns a final terminal failure.
- Malformed validation tests for outcome and exit-code contradictions, reversed timestamps, and historical timeout omission.
- Nonempty `TaskService.appendBatch` coverage for one journal call, `append` delegation, and complete prospective rollback when a later event is invalid.
- Tracer coverage proving patch, validation, review, prepared-receipt, and terminal artifact boundaries use one three-event batch.
- Replay rejection for marker-only and nontrailing markers, unsuccessful focused validation, denied success-boundary reviews, and every prepared-receipt success predicate.
- Prepared-to-final provenance substitution rejection and safe retention of `__proto__`, `constructor`, and `prototype` artifact IDs.

## Commands And Results

- `pnpm exec vitest run tests/orchestration/tracer-bullet.test.ts -t "rejects replay when every typed artifact event is deleted"` before the fix: failed, 1 failed and 68 skipped, because replay did not throw.
- `pnpm exec vitest run tests/orchestration/tracer-bullet.test.ts -t "rejects replay when every typed artifact event is deleted"` after the fix: passed, 1 passed and 68 skipped.
- `pnpm exec vitest run tests/contracts/artifact.test.ts tests/orchestration/tracer-bullet.test.ts` after initial recovery: failed, 35 of 89 tests, exposing incompatibility with issue 023 timeout-bearing validation reports.
- `pnpm exec vitest run tests/contracts/artifact.test.ts tests/orchestration/tracer-bullet.test.ts` after timeout schema alignment: passed, 2 test files and 89 tests.
- `pnpm exec vitest run tests/contracts/artifact.test.ts tests/orchestration/tracer-bullet.test.ts` after final contract coverage: passed, 2 test files and 90 tests.
- `pnpm test`: passed, 18 test files and 594 tests.
- `pnpm check`: passed with no TypeScript errors.
- `pnpm build`: passed.
- `git diff --check`: passed with no output.
- `pnpm exec vitest run tests/contracts/artifact.test.ts tests/orchestration/tracer-bullet.test.ts` after the independent-review fixes: passed, 2 test files and 114 tests.
- `pnpm test` after the independent-review fixes: passed, 18 test files and 618 tests.
- `pnpm check` after the independent-review fixes: passed with no TypeScript errors.
- `pnpm build` after the independent-review fixes: passed.
- `git diff --check` after the independent-review fixes: passed with no output.
- `pnpm exec vitest run tests/tasks/task-projection.test.ts tests/contracts/artifact.test.ts tests/orchestration/tracer-bullet.test.ts` after Retry 1: passed, 3 test files and 206 tests.
- `pnpm test` after Retry 1: passed, 18 test files and 643 tests.
- `pnpm check` after Retry 1: passed with no TypeScript errors.
- `pnpm build` after Retry 1: passed.
- `git diff --check` after Retry 1: passed with no output.

## Acceptance Criteria Evidence

- Four explicit artifact-recorded event schemas use strict kind-specific payload contracts.
- Stable IDs, task IDs, kinds, safe logical paths, SHA-256 digests, and creation timestamps are persisted at each durable evidence boundary.
- Validation uses the patch diff digest as its subject, review uses the exact patch and validation digests, commit uses the reviewed patch digest, and integration and completion use the exact recorded review and receipt evidence.
- `projectArtifacts(journal.readStream(taskId))` enumerates all artifacts after the worktree has been removed.
- Tampered replay fails closed for identity, digest, order, individual missing-reference violations, and deletion of all artifact events with deterministic bounded errors.
- Changing both recorded patch digest fields cannot defeat replay because the retained exact diff bytes provide an independent digest source.
- Each marker, artifact, and consuming lifecycle event is one prospective-validated journal transaction, so no marker-only protocol state is emitted by the tracer.
- Prepared integration evidence remains restart-recoverable, while final failed CAS evidence is exact, typed, terminal, and cannot alter prepared provenance beyond the terminal outcome.
- Validation, review, and receipt artifacts are bound through the full task, project, identity, digest, commit, result, and validation-provenance chain.
- Artifact evidence maps retain arbitrary valid IDs without object-prototype key loss.

## Required Test Review

- Contract tests accept all four artifact kinds and reject malformed metadata and kind-specific evidence.
- Tracer replay enumerates the expected artifacts after completion and after worker, validation, review, commit, and integration failure boundaries.
- Tampered replay covers contradictory digests, missing references, duplicate identities, invalid ordering, and deletion of every artifact event.

## Self-Review

The earlier report's statement that no standards or specification findings remained was incorrect because the atomicity and replay defects listed above were still present.
Retry 1 reviewed the worktree diff against `AGENTS.md`, the approved orchestrator design, the MVP plan, and every issue 006 acceptance criterion.
The review found one private-helper interface smell where a required consuming event was optional; the helper now requires that boundary event directly.
No standards or specification findings remain after that correction.
The implementation keeps the event journal authoritative, keeps projections rebuildable, introduces no shell or external authority, and changes only the explicitly allowed production, test, and report paths.
The four schemas, durable metadata, exact digest bindings, journal-only projection, atomic fail-closed replay checks, required malformed and failure-stage tests, and explicit delete-all tamper test are present.
No remote blob store was added, bounded retained evidence remains bounded, and lifecycle events were not replaced.

## Security Boundary

No remote blob storage or general shell capability was introduced.
Retained diff, standard output, standard error, identity, path, command, and explanatory text fields are explicitly bounded by the artifact contract.
Artifact paths are logical identifiers and do not grant filesystem authority.
Lifecycle events remain intact for recovery and audit behavior.

## Remaining Concerns

The MVP retains bounded patch, validation, review, and receipt evidence directly in artifact events.
A patch artifact can retain at most the Git client's 1 MiB capture ceiling, while the journal event limit remains 8 MiB.
A future artifact store can extend the safe logical path semantics without changing artifact identity or digest behavior.

## Commit Identity

- Branch: `fix/predeploy-b-artifacts-recovery`.
- Initial implementation: `66c5e1c` (`feat: record typed task artifacts`).
- Blocking review fixes: `929a636` (`fix: bind patch artifacts to retained diff`).
- Original report update: `90d0b48` (`docs: record issue 006 review fixes`).
- Original integration: `55076c2` (`merge: integrate issue 006 - typed artifact recording with journal replay`).
- Safety revert: `57d812c` (`Revert "merge: integrate issue 006 - typed artifact recording with journal replay"`).
- Recovery: `e237ee0` (`Reapply "merge: integrate issue 006 - typed artifact recording with journal replay"`).
- Delete-all replay and timeout compatibility fix: `984ae1d` (`fix: reject deleted artifact event streams`).
- Recovery report update: the commit containing this report.
- Independent-review hardening: `afa8773` (`fix: harden artifact evidence replay`).
- Automated gate scope restoration: `dd2e9d5` and `679de5c` revert the gate's generated out-of-scope documentation and reviewer-containment commits without rewriting branch history.
- Retry 1 atomicity and replay correction: the commit containing this report.
