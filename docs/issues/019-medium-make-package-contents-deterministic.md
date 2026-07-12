# 019 - Make Package Contents Deterministic

Severity: Medium.
Status: Open.
Execution wave: Wave 1, Pod C.
Suggested owner scope: Package files allowlist, deterministic tarball contents, and package-content verification.
Dependencies: Issue 016.
Conflicts and serialization notes: Follow issue 016's production output layout, use the C1 package/build writer, and provide deterministic package-content evidence to issue 024.

## Problem

Package metadata has no files allowlist tied to the production output layout established by issue 016.
Tarball contents therefore depend on working-tree state, ignore rules, and whether test output or internal documents happen to exist.

## Repository Evidence

`package.json:1-37` contains no `files` allowlist and no package-content verification script.
Issue 016 owns the production binary build and output layout that this issue must package deterministically.

## Failure Sequence Or User Impact

Package selection includes whatever nonignored files are present, potentially exposing fixtures, tests, source maps, plans, or stale generated files.
Two nominally identical releases can contain different files or unnecessary internals.

## Acceptance Criteria

- [ ] Add a narrow package `files` allowlist covering issue 016's binary and runtime output, required fixtures, declarations if supported, README, and the license when issue 018 supplies it.
- [ ] Exclude tests, coverage, worktrees, planning documents, local databases, secrets, and stale build output.
- [ ] Define and verify deterministic archive paths, file modes, and package metadata for identical source inputs.

## Required Tests

- [ ] Add a package manifest snapshot or explicit allowlist test over `npm pack --json` output.
- [ ] Add forbidden-file canaries and prove they are absent from the tarball.
- [ ] Build and pack twice from clean state and compare normalized file lists and content digests.

## Final Verification

Run the clean production build and `npm pack --dry-run`.
Inspect every tarball entry and verify each one is required for installation, operation, documentation, or licensing.
Run `pnpm test`, `pnpm check`, and issue 016's tarball installation test.
After issue 018 supplies a human-selected license, run the package-inclusion verification without making issue 018 a prerequisite or creating a dependency cycle.

## Non-Goals

This issue does not publish the package.
This issue does not own or redesign the production binary build from issue 016.
This issue does not ship tests as a supported package API.
This issue does not promise byte-for-byte gzip identity unless timestamps and archive tooling are explicitly normalized.
