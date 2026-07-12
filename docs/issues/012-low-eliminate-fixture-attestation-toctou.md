# 012 - Eliminate Fixture Attestation TOCTOU

Severity: Low.
Status: Open.
Execution wave: Wave 1, Fixture Integrity pod.
Suggested owner scope: Bundled fixture loading, immutable execution material, and macOS filesystem semantics.
Dependencies: Issues 009 and 016.
Conflicts and serialization notes: Run after issue 009 establishes reviewer composition and issue 016 establishes the packaged fixture layout.

## Problem

Fixture attestation hashes a pathname and later returns that pathname for execution.
An attacker with write access can replace the file between verification and process spawn, creating a time-of-check to time-of-use gap.

## Repository Evidence

`src/fixtures/bundled-fixtures.ts:38-56` verifies file type, canonical path, and SHA-256, then returns the canonical path.
`src/cli/main.ts:319-333` later passes the returned fixture paths into worker and reviewer adapters.
`src/reviews/reviewer-adapter.ts:101-118` executes the reviewer path in a later supervisor call rather than executing bytes bound to the attestation.

## Failure Sequence Or User Impact

Zentra reads and hashes a valid bundled fixture.
Another actor replaces the fixture at the same canonical path before spawn.
The supervisor executes the replacement while the system treats it as attested code.

## Acceptance Criteria

- [ ] Execution uses immutable private copied bytes or a descriptor-bound mechanism that refers to the exact bytes that were hashed.
- [ ] The selected mechanism is documented for macOS, including atomicity, permissions, cleanup, and executable invocation behavior.
- [ ] Private copies are created under an owned `0700` directory and are not writable by untrusted repository content.
- [ ] Replacement, symlink, hard-link, and rename races cannot substitute executed bytes after attestation.
- [ ] Packaged and source-layout fixture resolution use the same byte-binding guarantee.

## Required Tests

- [ ] Add a deterministic race test that replaces the source pathname immediately after hashing and proves only attested bytes execute or execution fails closed.
- [ ] Add symlink, hard-link, permission, rename, and cleanup tests on macOS.
- [ ] Add packed-tarball execution coverage for the selected mechanism.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build` on macOS.
Run the installed tarball while repeatedly attempting fixture replacement and verify no unattested marker executes.
Review temporary files and directories for private permissions and bounded cleanup.

## Non-Goals

This issue does not make mutable development fixtures trusted merely because they are in the repository.
This issue does not introduce a general executable cache.
This issue does not replace content-aware review from issue 009.
