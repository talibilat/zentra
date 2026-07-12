# Issue 016 Implementation Report

## Status

Implemented and verified on `fix/predeploy-c1-package`.

## Root Cause

The package declared `dist/src/cli/main.js` as its binary, but `npm pack` had no lifecycle step that created `dist`.
A clean checkout could therefore produce a tarball with no binary target while package creation still exited successfully.
The general TypeScript build also compiled tests into `dist`, and no package-specific check bound generated output to the source and required worker fixture used to create it.

## Files Changed

- `package.json`
- `tsconfig.build.json`
- `scripts/build-package.mjs`
- `scripts/package-files.mjs`
- `scripts/verify-package.mjs`
- `tests/package/package-e2e.test.ts`
- `docs/execution/issue-016-implementation-report.md`

## Tests Added

- A clean-output package test runs `npm pack` in an isolated source sandbox with no `dist` directory.
- The test inspects the pack result for the executable `dist/src/cli/main.js`, the production manifest, and `fixtures/deterministic-worker.mjs`.
- The generated tarball is installed into an empty temporary consumer project with normal production dependencies.
- The installed binary is checked for its Node.js shebang and executable mode, and a compiled journal module is imported directly as ESM.
- The installed binary runs `--help` and a complete deterministic `task run` against a temporary Git repository and SQLite journal.
- The operational test loads native `better-sqlite3`, resolves the worker fixture from the installed package, runs focused and full validation, invokes an independent reviewer, and verifies the integrated result.
- Negative cases prove package verification fails for a missing binary, a missing bundled fixture, and source changed after the production build.

## Commands And Results

- Baseline reproduction: `rm -rf dist && npm pack --dry-run --json` exited 0 and listed no `dist/src/cli/main.js`.
- Red test run: the initial package test failed because the clean tarball's CLI entry was absent and non-executable.
- Focused package suite: `pnpm exec vitest run tests/package/package-e2e.test.ts` passed 4 of 4 tests.
- Frozen install: `pnpm install --frozen-lockfile` exited 0 with the lockfile already up to date.
- Production build: `pnpm build` exited 0 and emitted the source-only runtime tree under `dist/src`.
- Package verification: `pnpm package:verify` exited 0 for the fresh production output.
- Typecheck: `pnpm check` exited 0.
- Dry run: `npm pack --dry-run --json` exited 0 after running `prepack`, and listed the CLI as mode `0755`, the worker fixture, and the production manifest.
- Real pack: `npm pack --silent --json --pack-destination <temporary-directory>` exited 0 and produced `zentra-0.1.0.tgz`.
- Tar inspection: `tar -tvf <tarball>` confirmed the CLI was executable and all compiled modules, declarations, source maps, manifest, and worker fixture were in the artifact.
- Empty-consumer installation, `zentra --help`, native dependency loading, ESM import, fixture resolution, and deterministic SQLite-backed `task run` passed in the package end-to-end test.
- Full suite: `pnpm test` passed 533 of 533 tests across 17 files in 38.58 seconds.

## Acceptance Criteria Evidence

- `tsconfig.build.json` compiles only `src/**/*.ts` to the deterministic `dist/src` layout while retaining the declarations already intended by the existing TypeScript configuration.
- `scripts/build-package.mjs` removes old output, invokes TypeScript without a shell, marks the declared CLI executable, and writes SHA-256 identities for every build input and output.
- `prepack` runs the production build and package verifier before npm selects tarball contents.
- `scripts/verify-package.mjs` requires regular non-symlink binary and fixture files, the exact shebang and executable mode, unchanged source inputs, and an exact generated-output set.
- Missing or stale package state therefore fails verification, while a normal clean package operation rebuilds and verifies the state before packing.
- The package end-to-end test operates from the installed tarball and does not load runtime files from the Zentra repository.
- The operational installed-package command creates and replays a real SQLite journal and completes the deterministic development tracer bullet.

## Security Boundary

The build invokes TypeScript with `process.execPath`, an argument array, `shell: false`, and a minimal environment containing only standard execution and locale variables when present.
The verifier grants no execution authority and only reads and hashes package-owned build inputs and outputs.
The packaged CLI preserves the existing exact-executable validation policy, minimal worker and validation environments, independent review requirement, and attested fixture lookup.
Installing the package does not grant operational authority.
Configured validations still execute with the operating-system authority of the user running Zentra under the documented Trusted-Project MVP model.

## Remaining Concerns

The tarball still contains source, tests, and internal documentation because issue 019 exclusively owns the `files` allowlist and deterministic package-content reduction.
The package remains `private: true`, and choosing or enabling a distribution channel remains issue 017.
Platform restrictions, the upper Node.js compatibility bound, and license metadata remain owned by issues 020, 021, and 018 respectively.
The package test depends on npm being able to resolve production dependencies, including the native `better-sqlite3` package, from the configured registry or cache.

## Commit Identity

Implementation and report: this document's containing commit on `fix/predeploy-c1-package`.
