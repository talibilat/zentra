# 021 - Bound Node Engine Compatibility

Severity: Medium.
Status: Open.
Execution wave: Wave 1, Pod C.
Suggested owner scope: Node engine metadata, native dependency compatibility, and runtime CI matrix.
Dependencies: None.
Conflicts and serialization notes: Use the C2 package-metadata writer for `package.json`, serialize shared metadata edits with issue 020, and make issue 024 consume the integrated runtime matrix.

## Problem

The package declares Node 24 or newer without an upper bound, while the current `better-sqlite3` compatibility range does not establish support for Node 27 and later.
Future Node versions can install a package whose native dependency or deprecated APIs have not been validated.

## Repository Evidence

`package.json:16-18` declares `"node": ">=24"`.
`package.json:19-22` depends on `better-sqlite3` 12.x and runtime libraries whose compatibility must be tested against each supported Node major.
`README.md:19-22` repeats an unbounded Node 24-or-newer requirement.

## Failure Sequence Or User Impact

An operator uses a newly released Node major such as Node 27.
Package installation accepts the runtime because no upper bound exists.
The native SQLite addon fails to install or load, or behavior changes outside the tested matrix.

## Acceptance Criteria

- [ ] Set the initial engine range to `>=24 <27` in package metadata and align documentation.
- [ ] Verify the chosen range against current `better-sqlite3` support and actual clean installs.
- [ ] Add CI jobs for every supported Node major and an expected engine-rejection check for the next unsupported major.
- [ ] Require an explicit compatibility issue and successful matrix run before widening the upper bound.

## Required Tests

- [ ] Run frozen clean installs, native addon loading, package installation, CLI help, and the full suite on Node 24, 25, and 26 where available.
- [ ] Add package metadata tests for the exact engine range.
- [ ] Verify strict engine enforcement rejects Node 27 in a controlled environment.

## Final Verification

Run issue 024's CI matrix and inspect each Node version reported by the jobs.
Install the packed tarball under every supported major and execute a SQLite-backed command.
Confirm README and package metadata state the same bounded range.

## Non-Goals

This issue does not promise support for unreleased Node versions.
This issue does not upgrade `better-sqlite3` without compatibility evidence.
This issue does not widen operating-system support.
