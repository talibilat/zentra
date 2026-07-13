# Issue 012 Implementation Report

## Status

Implemented and verified on `fix/predeploy-fixture-012`.

## Root Cause

The bundled fixture resolver checked the expected pathname, read and hashed its contents, and returned the same pathname.
Worker authority validation later reopened that pathname, and the process supervisor reopened it again for execution.
A replacement, rename, or hard-link write between attestation and process spawn could therefore change the executed bytes without changing the path passed through the system.

## Files Changed

- `src/fixtures/bundled-fixtures.ts`
- `src/cli/main.ts`
- `src/orchestration/tracer-bullet.ts`
- `tests/fixtures/bundled-fixtures.test.ts`
- `tests/orchestration/tracer-bullet.test.ts`
- `tests/package/package-e2e.test.ts`
- `docs/execution/issue-012-implementation-report.md`

## Implementation

The resolver opens the expected source fixture with `O_RDONLY | O_NOFOLLOW`, compares the opened descriptor's device and inode with the earlier non-symlink `lstat`, and reads the source bytes through that descriptor.
It computes SHA-256 from that one in-memory byte buffer.
Only an exact digest match may be materialized.

The resolver creates a fresh unpredictable directory with `mkdtemp` below the operating-system temporary directory and explicitly sets it to mode `0700`.
It creates the execution file inside that owned directory with `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW`, writes the exact buffer that was hashed, flushes the descriptor, and explicitly sets the completed file to mode `0500`.
The private file is a new inode rather than a link or reopened source pathname.
The directory is inaccessible to repository content running without the operator's operating-system identity, and the file has no write bits.

On macOS, `mkdtemp` provides an atomically reserved directory name and `O_EXCL` atomically reserves the private destination pathname.
The destination is not exposed to worker execution until all bytes are written, flushed, closed, and made read-execute only.
Node.js invokes the private pathname as the script argument to the canonical Node.js executable with an argument array and `shell: false` in the existing process supervisor.

The resolver returns a fixture lease containing the private execution path and an idempotent cleanup operation.
The CLI retains that lease for the complete task run and removes its directory in a `finally` block.
Cleanup uses recursive forced removal with at most three retries and a 25 millisecond retry delay, so normal completion, denial, cancellation, timeout, and thrown failures have bounded cleanup.

The source and installed layouts share this resolver and private-copy path.
The orchestrator now validates the worker script against the private path supplied by CLI composition instead of independently resolving the mutable package source again.

## Tests Added

- Source-layout and built-layout cases require a distinct private path, a `0700` parent directory, and a `0500` execution file.
- Source-layout and built-layout tests interpose `mkdtempSync`, replace the source after digest acceptance but before private materialization begins, and prove the accepted buffer is materialized and executed.
- Deterministic replacement and rename races mutate the source immediately after resolution, execute the private script, and prove the unattested marker is not executed.
- A hard-link test modifies the source inode through another name after attestation and proves the private execution inode and bytes remain unchanged.
- The existing symlink test proves an expected-path symlink fails closed even when its target contains valid bytes.
- A source permission test proves an unreadable fixture fails closed.
- Cleanup testing proves the executable and private directory are removed and repeated cleanup is safe.
- The installed-tarball end-to-end test directs temporary materialization into an isolated temporary root, executes a complete packaged task, and proves no fixture directory remains afterward.
- A fresh Node process replaces the installed resolver's `mkdtempSync` binding before module import, mutates the packed source at the materialization boundary, and proves only accepted bytes are copied and executed.
- The installed resolver is exercised through ten source-replacement attempts, and every private fixture executes attested behavior without emitting the unattested marker.

## Reviewer Follow-Up

The independent reviewer found that the original race tests replaced source bytes only after `resolveBundledFixture` returned.
Those tests proved post-resolution immutability but did not deterministically exercise the interval after digest acceptance and before private materialization.

The follow-up uses filesystem interposition rather than a production test hook.
`mkdtempSync` is the first private-materialization filesystem operation after the digest comparison succeeds.
The interposed implementation replaces the source before delegating to the real `mkdtempSync`, so the replacement occurs precisely before directory creation and destination writing.
The tests then inspect and execute the private file to prove it contains the previously accepted buffer rather than the replacement.

Vitest performs this interposition for exact source and built resolver layouts.
The installed-tarball test performs the same interposition in a fresh Node process using `syncBuiltinESMExports` before importing the installed resolver.
Both paths restore the real filesystem binding, clean the private `0700` directory, and restore packed source bytes even if an assertion fails.

## Commands And Results

- Red fixture test: `pnpm vitest run tests/fixtures/bundled-fixtures.test.ts` failed 6 tests against the pathname-returning resolver.
- Focused fixture test after implementation: `pnpm vitest run tests/fixtures/bundled-fixtures.test.ts` passed 11 of 11 tests.
- Focused fixture, CLI, and orchestrator suites: `pnpm vitest run tests/fixtures/bundled-fixtures.test.ts tests/orchestration/cli.test.ts tests/orchestration/tracer-bullet.test.ts` passed 137 of 137 tests.
- Typecheck during implementation: `pnpm check` passed.
- Installed package suite: `pnpm vitest run tests/package/package-e2e.test.ts` passed 7 of 7 tests.
- Full suite: `pnpm test` passed 557 of 557 tests across 17 files.
- Final typecheck: `pnpm check` passed.
- Production build: `pnpm build` passed.
- Installed replacement stress coverage: the package end-to-end test replaced the installed source after each of ten attestations, all ten private copies executed successfully, no unattested marker appeared, and every private executable directory was absent after cleanup.
- Post-merge baseline: `pnpm test -- tests/package/package-e2e.test.ts` passed 689 of 689 tests across 18 files after integrating `fix/pre-deployment`.
- Deterministic source and built interposition: `pnpm vitest run tests/fixtures/bundled-fixtures.test.ts` passed 13 of 13 tests.
- Deterministic installed-package interposition: `pnpm vitest run tests/package/package-e2e.test.ts` passed 16 of 16 tests.
- Focused fixture, tracer, and package suites: `pnpm vitest run tests/fixtures/bundled-fixtures.test.ts tests/orchestration/tracer-bullet.test.ts tests/package/package-e2e.test.ts` passed 104 of 104 tests.
- Merged typecheck: `pnpm check` passed.
- Final merged suite: `pnpm test` passed 691 of 691 tests across 18 files.
- Final production package build: `pnpm build` passed.
- Package verification: `pnpm run package:verify` passed.
- Package contents: `pnpm run package:contents` verified 71 deterministic package files across clean packs with umasks `022` and `077`.

## Acceptance Criteria Evidence

- Execution receives the private copied path whose bytes came from the same buffer used for SHA-256 attestation.
- Source replacement cannot change the open descriptor bytes already read, and replacement after reading cannot change the separate private inode.
- Symlink substitution is rejected by both pathname checks and `O_NOFOLLOW`.
- Rename substitution between `lstat` and `open` is rejected by device and inode comparison, while a rename after descriptor opening cannot redirect the descriptor.
- Hard-link writes after attestation affect the source inode but not the separately created private inode.
- The unpredictable owned directory is mode `0700`, the completed executable is mode `0500`, and destination creation is exclusive and non-symlink-following.
- Source and packaged layouts differ only in locating the expected source file and use identical descriptor reading, digest checking, private materialization, execution, and cleanup.

## Security Boundary

This mechanism binds execution to attested fixture bytes under the Trusted-Project MVP authority model.
It prevents repository-controlled source pathname mutation from changing the private execution material after attestation.
It is not a filesystem sandbox against another malicious process already running with the same operating-system user identity, because that identity can change permissions on files it owns.
No shell capability, inherited arbitrary environment, additional reviewer authority, or executable cache is introduced.

## Remaining Concerns

An uncatchable process termination or host crash can prevent the CLI `finally` block from running and may leave an isolated `0700` temporary directory for operating-system temporary-file cleanup.
Normal process outcomes use bounded synchronous cleanup and leave no fixture executable behind.

## Commit Identity

- Branch: `fix/predeploy-fixture-012`.
- Implementation commit: this document's containing commit.
