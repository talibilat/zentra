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
- Added a controlled Linux-target simulation that launches canonical Node and npm, must return `EBADPLATFORM`, and leaves Zentra uninstalled.
- Updated installation guidance and added the release support policy with explicit widening gates.

## TDD Evidence

Before metadata was added, `pnpm exec vitest run tests/package/package-metadata.test.ts` failed three intended assertions.
Source and packed metadata returned no `os` value, and npm successfully installed the tarball under the simulated Linux target.
The supported Darwin arm64 packed-install, native-addon load, and CLI help test already passed in that red run.

## Verification

- `pnpm exec vitest run tests/package/package-metadata.test.ts` passed 4 of 4 tests.
- `pnpm check` passed with no diagnostics.
- The supported package test performed a clean tarball install, loaded `better-sqlite3` 12.11.1, opened an in-memory SQLite database, and ran packed CLI help on Node 24.2.0, macOS 26.6 arm64.
- The controlled unsupported-target test preloaded canonical npm 11.8.0 with Linux arm64 runtime identifiers, ran a real strict install of the packed package, observed `EBADPLATFORM` with required OS `darwin` and actual OS `linux`, and confirmed that `node_modules/zentra` was not created.

Final complete-suite, production-build, package verification, package-content, and packed-smoke evidence is recorded after issue 021 in this branch's final verification pass.

## Inherited Review Findings

The scoped `no-mistakes` review reported three findings in files that are unchanged by `49d6378...HEAD`:

- `review-001`, error, `src/cli/main.ts`: caller-selected reviewer executables and arguments can select a shell or another host executable.
- `review-002`, error, `src/reviews/reviewer-adapter.ts`: reviewer settlement does not confirm that its owned process group disappeared before accepting success.
- `review-003`, warning, `scripts/verify-package-contents.mjs`: synchronous package verification timeout handling does not confirm termination of `npm pack` lifecycle descendants.

The controller confirmed that all three findings are pre-existing and outside issues 020 and 021.
They are deferred to dedicated remediation branches before final whole-branch review.
They were not modified in this metadata branch, waived, or accepted as risks.

## Scoped Gate Outcome

`no-mistakes` run `01KXDNHVN2FNH80Y99V0ZS7FCY` completed with outcome `passed` after the controller authorized approval of this scoped review step only.
Its test, document, lint, and push steps completed.
Rebase was skipped to preserve reviewed base `49d6378`, and PR and CI were skipped because no PR was requested and issue 024 owns CI.
The pipeline push produced remote commit `be6bca0` before this report-only follow-up.
