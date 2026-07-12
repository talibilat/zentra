# 020 - Restrict Unsupported Platform Installation

Severity: Medium.
Status: Open.
Execution wave: Wave 1, Pod C.
Suggested owner scope: Platform support policy, package metadata, installation docs, and conformance gates.
Dependencies: None.
Conflicts and serialization notes: Use the C2 package-metadata writer for every shared package file, and make issue 024 consume the integrated platform policy after issues 020 and 021 are complete.

## Problem

The README presents installation without a platform restriction even though supervision and Git behavior are currently macOS-first and unverified elsewhere.
Package metadata allows installation on unsupported operating systems.

## Repository Evidence

`README.md:19-33` gives platform-neutral installation and execution instructions.
`package.json:1-37` has no `os` restriction or platform support metadata.
`docs/execution/mvp-final-report.md:87-94` states that macOS is the first supported supervision and Git target and that Linux and Windows conformance remain future work.

## Failure Sequence Or User Impact

An operator installs Zentra on Linux or Windows because package and README metadata imply support.
Process groups, signals, path rules, filesystem permissions, Git behavior, or native dependencies behave differently.
The CLI fails unpredictably or reports guarantees that were never tested on that platform.

## Acceptance Criteria

- [ ] Declare macOS-only support for the MVP in package metadata, README installation prerequisites, and release documentation.
- [ ] Fail unsupported installation or startup with a clear message before operational effects.
- [ ] State supported architecture and macOS version bounds if the native dependency or process model requires them.
- [ ] Widen support only after platform-specific process, signal, filesystem, Git, SQLite, packaging, and native-addon conformance tests pass.

## Required Tests

- [ ] Add metadata validation for the selected `os` and optional `cpu` constraints.
- [ ] Add a supported macOS packed-install test.
- [ ] Add CI or controlled simulation that proves unsupported platforms reject installation or startup clearly.

## Final Verification

Inspect package metadata and the packed tarball on macOS.
Attempt installation in an unsupported-platform environment and verify the documented rejection.
Run `pnpm test`, `pnpm check`, and all macOS conformance tests.

## Non-Goals

This issue does not implement Linux or Windows support.
This issue does not claim all macOS versions or architectures are supported without evidence.
This issue does not hide platform restrictions solely in internal documentation.
