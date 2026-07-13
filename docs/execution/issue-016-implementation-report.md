# Issue 016 Implementation Report

## Status

Implemented and verified on `fix/predeploy-c1-package`.

## Root Cause

The package declared `dist/src/cli/main.js` as its binary, but `npm pack` had no lifecycle step that created `dist`.
A clean checkout could therefore produce a tarball with no binary target while package creation still exited successfully.
The general TypeScript build also compiled tests into `dist`, and no package-specific check bound generated output to the source and required worker fixture used to create it.
The first implementation hard-coded that binary path and omitted `package.json` and inherited `tsconfig.json` from its input hashes.
Its negative tests invoked the verifier directly, so they did not prove the real npm pack lifecycle failed closed when package metadata declared an executable the build did not emit.

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
- A negative lifecycle case changes `package.json#bin` to an output the build does not emit, runs the real `npm pack`, requires a clear failure, and proves no tarball was created.
- Direct negative cases prove package verification fails for a missing binary, a missing bundled fixture, and stale package metadata, inherited TypeScript configuration, or source after the production build.

## Commands And Results

- Baseline reproduction: `rm -rf dist && npm pack --dry-run --json` exited 0 and listed no `dist/src/cli/main.js`.
- Red test run: the initial package test failed because the clean tarball's CLI entry was absent and non-executable.
- Blocking-review red test: changing `package.json#bin` to a nonexistent output still let `npm pack` create `zentra-0.1.0.tgz`, while edits to `package.json` and `tsconfig.json` passed verification.
- Focused package suite after the fix: `pnpm exec vitest run tests/package/package-e2e.test.ts` passed 7 of 7 tests.
- Frozen install: `pnpm install --frozen-lockfile` exited 0 with the lockfile already up to date.
- Production build: `pnpm build` exited 0 and emitted the source-only runtime tree under `dist/src`.
- Package verification: `pnpm package:verify` exited 0 for the fresh production output.
- Typecheck: `pnpm check` exited 0.
- Dry run: `npm pack --dry-run --json` exited 0 after running `prepack`, and listed the CLI as mode `0755`, the worker fixture, and the production manifest.
- Real pack: `npm pack --silent --json --pack-destination <temporary-directory>` exited 0 and produced a 304,799-byte `zentra-0.1.0.tgz` with 195 entries.
- Tar inspection: `tar -tvf <tarball> package/package.json package/dist/src/cli/main.js package/dist/package-manifest.json package/fixtures/deterministic-worker.mjs` confirmed package metadata, the manifest, and worker fixture were present and the CLI had mode `0755`.
- Empty-consumer installation, `zentra --help`, native dependency loading, ESM import, fixture resolution, and deterministic SQLite-backed `task run` passed in the package end-to-end test.
- Full suite after the blocking-review fixes: `pnpm test` passed 536 of 536 tests across 17 files in 58.17 seconds.

## Acceptance Criteria Evidence

- `tsconfig.build.json` compiles only `src/**/*.ts` to the deterministic `dist/src` layout while retaining the declarations already intended by the existing TypeScript configuration.
- `scripts/package-files.mjs` derives every required executable from `package.json#bin` and rejects package-external targets instead of duplicating the CLI path.
- `scripts/build-package.mjs` removes old output, invokes TypeScript without a shell, requires every declared binary to be emitted, marks each executable, and writes SHA-256 identities for every build input and output.
- `prepack` runs the production build and package verifier before npm selects tarball contents.
- `scripts/verify-package.mjs` requires regular non-symlink binary and fixture files, the exact shebang and executable mode, unchanged build inputs, and an exact generated-output set.
- Build inputs include `package.json`, `pnpm-lock.yaml`, both TypeScript configurations, package scripts, fixtures, and all source files.
- Missing or stale package state therefore fails verification, while a normal clean package operation rebuilds and verifies the state before packing.
- A declared bin target not emitted by the production build stops `npm pack` with a clear error before npm can create a tarball.
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

- Initial implementation and report: `95681ec`.
- Blocking-review code and test fixes: `307d131`.
- Updated verification report: this document's containing commit on `fix/predeploy-c1-package`.
