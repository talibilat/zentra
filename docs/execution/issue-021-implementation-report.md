# Issue 021 Implementation Report

## Status

Package metadata and local Node.js 24 verification completed on `fix/predeploy-c2-metadata`.
Node.js 25 and 26 runtime verification remains pending issue 024's Darwin arm64 CI matrix.

## Runtime Boundary

The exact package engine range is now `>=24 <27`.
This selects Node.js 24, 25, and 26 while rejecting Node.js 27 and later until a separate compatibility issue provides evidence to widen the range.

## Native Dependency Evidence

The frozen lockfile selects `better-sqlite3` 12.11.1.
The installed package and lockfile both declare Node.js support as `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`.
The dedicated metadata test passes versions 24.0.0, 25.0.0, and 26.0.0 through npm 11.8.0's own engine checker against that dependency manifest and verifies that 27.0.0 returns `EBADENGINE`.

Package metadata establishes declared compatibility but does not replace clean installation and runtime testing.
The implementation host provides Node.js 24.2.0 only, so this report does not invent Node.js 25 or 26 execution results.

## Implementation

- Changed the Zentra package engine from unbounded `>=24` to exact `>=24 <27`.
- Added source and packed metadata assertions in the dedicated package metadata suite.
- Added a controlled Node.js 27 simulation that launches canonical Node and npm, runs a real `npm install --engine-strict`, requires `EBADENGINE`, and confirms that Zentra was not installed.
- Updated README installation prerequisites and the release support policy.
- Documented the exact Node.js 24/25/26 matrix that issue 024 must implement without adding a CI workflow in this issue.
- Required an explicit compatibility issue and successful full matrix before widening the upper bound.

## TDD Evidence

Before the engine metadata changed, `pnpm exec vitest run tests/package/package-metadata.test.ts` failed three intended assertions.
Source and packed metadata returned `>=24` instead of `>=24 <27`, and npm's engine checker accepted Node.js 27 for the packed package.
The native dependency compatibility assertion already passed in that red run.

## Node Major Availability

- Node.js 24.2.0 is installed locally and receives clean-install and runtime verification.
- Node.js 25 is unavailable on the implementation host.
- Node.js 26 is unavailable on the implementation host.
- Node.js 27 is represented only by controlled strict-engine simulation and is not claimed as an installed runtime.

## Verification

- `pnpm exec vitest run tests/package/package-metadata.test.ts` passed 8 of 8 tests.
- `pnpm exec vitest run tests/package/package-metadata.test.ts tests/package/package-e2e.test.ts` passed 24 of 24 package tests.
- The package smoke test packed from clean output, installed into an empty consumer, loaded `better-sqlite3`, opened an in-memory SQLite database, ran CLI help, and completed a SQLite-backed task through the packed CLI.
- `pnpm test` passed 692 of 692 tests across 19 files in 45.43 seconds.
- `pnpm check` passed with no diagnostics.
- `pnpm build` passed.
- `pnpm package:verify` passed against fresh production output.
- `pnpm package:contents` passed with 71 deterministic package files across clean packs under umasks `022` and `077`.
- `brew list --versions node node@24 node@25 node@26` reported only Node.js 24.2.0 installations; no Node.js 25 or 26 installation was available.
- `git diff --check` passed before final commit.

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

The report-only follow-up commit `a2c40d0` passed `no-mistakes` run `01KXDQ5VD3167AQKYC33XY4DHH`.
That run completed scoped review, tests, lint, and push, while document, rebase, PR, and CI remained skipped.
Its follow-up review also surfaced `review-004`, error, in unchanged `src/workers/process-supervisor.ts`, concerning surviving process groups after cancellation or timeout.
That newly surfaced inherited finding was not modified, waived, or accepted as a risk in this metadata branch and requires dedicated remediation triage before final whole-branch review.
