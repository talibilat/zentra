# Issue 020 Implementation Report

## Status

Implemented and focused verification passed on `fix/predeploy-c2-metadata`.

## Supported Boundary

The MVP package now selects only npm platform `darwin` and architecture `arm64`.
This is narrower than a generic macOS claim because all currently available local conformance evidence was produced on Apple Silicon.
The implementation does not claim Intel macOS, Linux, Windows, or untested macOS releases.

The observed verification host is macOS 26.6 arm64.
That exact observation is documented as evidence rather than converted into an unsupported macOS version range.

## Implementation

- Added `os: ["darwin"]` and `cpu: ["arm64"]` to source and packed npm metadata.
- Added a dedicated metadata test without changing issue 012's `tests/package/package-e2e.test.ts`.
- Added a real packed install that loads `better-sqlite3` and runs CLI help on the supported host.
- Added a controlled npm Linux-target simulation that must return `EBADPLATFORM` and leave Zentra uninstalled.
- Updated installation guidance and added the release support policy with explicit widening gates.

## TDD Evidence

Before metadata was added, `pnpm exec vitest run tests/package/package-metadata.test.ts` failed three intended assertions.
Source and packed metadata returned no `os` value, and npm successfully installed the tarball under the simulated Linux target.
The supported Darwin arm64 packed-install, native-addon load, and CLI help test already passed in that red run.

## Verification

- `pnpm exec vitest run tests/package/package-metadata.test.ts` passed 4 of 4 tests.
- `pnpm check` passed with no diagnostics.
- The supported package test performed a clean tarball install, loaded `better-sqlite3` 12.11.1, opened an in-memory SQLite database, and ran packed CLI help on Node 24.2.0, macOS 26.6 arm64.
- The controlled unsupported-target test passed packed metadata to npm 11.8.0's own `npm-install-checks` implementation with Linux arm64 and observed code `EBADPLATFORM`, required OS `darwin`, and required CPU `arm64`.

Final complete-suite, production-build, package verification, package-content, and packed-smoke evidence is recorded after issue 021 in this branch's final verification pass.
