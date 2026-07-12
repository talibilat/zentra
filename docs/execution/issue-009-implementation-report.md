# Issue 009 Implementation Report

## Status

Implemented and verified.

The deployable CLI now denies task execution when no content-aware reviewer is configured.
A configured reviewer receives bounded review evidence over standard input and must return one bounded, schema-valid decision bound to the exact evidence digests.
Independent review findings have been addressed on top of the original implementation.

## Root Cause

The deployable CLI previously selected the bundled deterministic reviewer unconditionally.
That reviewer received only identities and digests, so it could approve based on identity separation without inspecting the diff or validation evidence.

## Files Changed

- `src/cli/main.ts` adds explicit reviewer process configuration, deny-by-default behavior, and production wiring that no longer resolves the deterministic reviewer fixture.
- `src/reviews/reviewer-adapter.ts` adds the bounded standard-input reviewer protocol, process containment, strict decision validation, evidence digest verification, and exit-based bounded settlement.
- `src/fixtures/bundled-fixtures.ts` exposes only the deterministic worker fixture and cannot resolve the identity-only reviewer.
- `tests/fixtures/content-aware-reviewer.mjs` provides a test-only reviewer that inspects diff content and validation evidence.
- `tests/fixtures/deterministic-reviewer.mjs` and `tests/support/deterministic-reviewer-adapter.ts` contain the identity-only reviewer support used by legacy orchestration tests under test-only paths.
- `tests/reviews/deterministic-reviewer-adapter.test.ts` covers the content-aware protocol and fail-closed cases.
- `tests/orchestration/cli.test.ts` covers missing configuration, configured review, adversarial denial, and built CLI wiring.

## Tests Added

- Exact diff and validation evidence are delivered through standard input rather than command-line arguments.
- Oversized reviewer input is rejected before process execution.
- Evidence digest mismatch fails closed.
- A correct diff digest paired with an incorrect validation digest fails closed.
- Reviewer timeout fails closed with the typed `timed_out` outcome.
- Reviewer timeout settles within a measured upper bound even when a detached descendant retains inherited output pipes.
- Reviewer success settles after a bounded stream-flush grace period when a detached descendant retains inherited output pipes.
- Early standard-input closure and zero-exit reviewers that do not consume the complete request fail closed.
- Malformed output fails closed.
- Output truncation fails closed.
- Multiple decisions fail closed.
- Matching worker and reviewer identities fail closed before reviewer execution.
- A dangerous authentication-bypass diff is denied despite successful focused validation.
- Missing CLI reviewer configuration records `denied` without creating a worktree, commit, or integration branch.
- The built production CLI does not reference the deterministic reviewer adapter or fixture.

## Commands And Results

- `pnpm install --frozen-lockfile`: passed with `Already up to date` and `Done in 113ms`.
- `shasum -a 256 pnpm-lock.yaml` before and after installation: unchanged at `90b4d829baf7d6ca730bfac365df0b8feffdef040b7291bb079d3a4228509afc`.
- `git diff --exit-code -- pnpm-lock.yaml`: passed with no lockfile changes.
- `pnpm test`: passed, 15 test files and 493 tests.
- `pnpm check`: passed with TypeScript reporting no errors.
- `pnpm build`: passed with TypeScript reporting no errors.
- `pnpm exec vitest run tests/fixtures/bundled-fixtures.test.ts tests/reviews/deterministic-reviewer-adapter.test.ts tests/reviews/review-gate.test.ts tests/orchestration/cli.test.ts`: passed, 4 test files and 120 tests.
- `pnpm pack --pack-destination /var/folders/10/9mqn0tw54gg6j709prq0ytv40000gn/T/opencode`: passed and produced `zentra-0.1.0.tgz` for package inspection.
- Production source and built-source inspection: passed and found neither `deterministic-reviewer.mjs` nor `DeterministicReviewerAdapter` under `src/` or `dist/src/`.

## Acceptance Criteria Evidence

- Missing reviewer configuration creates a terminal `denied` task before worker or worktree setup.
- The reviewer request contains the exact diff, complete validation report, and their canonical SHA-256 digests in one bounded JSON standard-input payload.
- Reviewer command-line arguments contain only operator-configured process arguments and never review evidence.
- Reviewer decisions use explicit `approve` or `deny` values and include reviewer identity, both evidence digests, timestamp, and bounded reason.
- Strict Zod parsing rejects unknown, missing, or incorrectly typed decision fields.
- Aggregate standard output and standard error are bounded, and timeout, cancellation, nonzero exit, standard-input failure, incomplete input delivery, excessive output, malformed JSON, multiple decisions, identity mismatch, and digest mismatch all reject the review.
- Reviewer execution settles from process `exit`, with a 100 millisecond stream-flush grace deadline covering success, timeout, cancellation, output-limit, standard-input, stream, and spawn failures.
- The adversarial CLI test proves that successful focused validation does not override a content-based denial.
- Production CLI composition has no deterministic reviewer fallback and requires explicit reviewer executable and identity configuration.
- Production source has no identity-only reviewer adapter, fixture registry entry, resolver name, or fixture file.

## Security Boundary

Reviewer reasoning grants no execution authority.
The reviewer can return only one bounded decision, and the existing review gate independently checks approval, identity separation, validation success, and evidence digests before integration.
The reviewer process uses `shell: false`, an executable and argument array, a minimal allowlisted environment, bounded input and output, a fixed timeout, and process-group termination.
No worktree path, inherited arbitrary secret, or general shell capability is provided by the reviewer protocol.

## Remaining Concerns

The identity-only adapter and fixture now exist only under `tests/`, and shipped production code cannot resolve, import, or select them.
Final physical exclusion of test fixtures from the published tarball is enforced by issue 019's `files` allowlist.
That tarball exclusion is verified at the combined issue 016/019 package gate rather than by issue 009.

## Commit Identity

- Branch: `fix/predeploy-b-review-artifacts`.
- Implementation commit: `e0347429a8b9fd69aa6cbf283c3388c864ec742c` (`fix: require content-aware independent review`).
- Initial report commit: `0efdc61d2f396514a7af34e668334e07dffcb6b3` (`docs: report issue 009 implementation`).
- Independent-review fix commit: `4ca3fbf446932397acfda8c4dbf2ff30719cebcb` (`fix: harden reviewer process settlement`).
- Final report update: the commit containing this revision.
