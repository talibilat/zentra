# 024 - Add CI And Release Package Gates

Severity: Medium.
Status: Open.
Execution wave: Wave 1, Pod C.
Suggested owner scope: GitHub Actions, supported-runtime matrix, package gates, and release workflow protection.
Dependencies: Issues 016, 019, 020, and 021.
Conflicts and serialization notes: C3 begins only after all dependencies are complete, and CI must not publish because issue 017's distribution decision and implementation follow this gate.

## Problem

The repository has no automated CI or release gate proving that a clean supported environment can install, check, test, build, pack, install, and execute the CLI artifact.
Local source-tree verification can pass while the release artifact is missing or broken.

## Repository Evidence

No files exist under `.github/workflows/`.
Local commands now provide `build`, `check`, `test`, `package:verify`, and `package:contents`.
Package end-to-end tests pack the artifact, install it into an empty consumer, load `better-sqlite3`, run CLI help, and execute a SQLite-backed task.
The remaining gap is automated execution on fresh Darwin arm64 runners across Node.js 24, 25, and 26, expected Node.js 27 rejection coverage, artifact retention, and release-job protection.

## Failure Sequence Or User Impact

A change passes on a contributor's existing checkout with cached dependencies and generated `dist` files.
No protected workflow tests a frozen install or clean package.
A release artifact is created with missing files, unsupported runtime behavior, or a nonfunctional binary.

## Acceptance Criteria

- [ ] Add GitHub Actions for frozen dependency installation, type checking, tests, production build, clean pack, tarball installation, and binary execution on the supported platform and Node matrix.
- [ ] Use fresh workspaces and caches keyed by lockfile without allowing caches to supply generated release output.
- [ ] Execute at least one SQLite-backed operational command from the installed tarball.
- [ ] Make all required gates pass before a release job can access publishing credentials or create a release.
- [ ] Use least-privilege workflow permissions, pinned action revisions, concurrency controls, and explicit artifact retention.

## Required Tests

- [ ] Validate workflow syntax and run every job on a pull request or equivalent nonpublishing event.
- [ ] Add a deliberate missing-bin or missing-fixture test change in a temporary branch or fixture and prove the package gate fails.
- [ ] Exercise the Node and platform bounds from issues 020 and 021.

## Final Verification

Observe a clean CI run where every required gate executes rather than being skipped by path filters.
Download the CI-produced tarball, verify its checksum, install it locally, and run its binary.
Confirm release credentials are unavailable to pull-request and untrusted-fork jobs.

## Non-Goals

This issue does not publish a production release.
This issue does not add unsupported operating systems to the matrix.
This issue does not treat source-tree `pnpm start` as package verification.
