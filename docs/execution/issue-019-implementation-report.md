# Issue 019 Implementation Report

## Status

Implemented and verified on `fix/predeploy-c1-files-019`.

## Root Cause

The package had no `files` allowlist, so npm selected package contents from the working tree and ignore rules after the issue 016 production build.
The resulting tarball included source, tests, package scripts, agent instructions, and internal planning and execution documents that were not needed to install or run Zentra.
There was also no package-content gate proving that independent clean builds produced the same archive paths, modes, package metadata, and file contents.
The initial package-content gate ran both packs under the same ambient umask and therefore could not detect that newly emitted files inherited restrictive modes such as `0600` under umask `077`.

## Files Changed

- `package.json`
- `scripts/build-package.mjs`
- `scripts/verify-package-contents.mjs`
- `docs/execution/issue-019-implementation-report.md`

## Changes Made

`package.json#files` now allows only `dist/`, `fixtures/deterministic-worker.mjs`, `README.md`, and prospective `LICENSE`, in addition to npm's mandatory `package.json` entry.
The allowlist follows issue 016's production output layout without changing its build or verifier behavior.
The production tree includes emitted JavaScript, declarations, source maps, and `dist/package-manifest.json`.
Source maps are intentional package output because issue 016's production build inherits `sourceMap: true` from `tsconfig.json`.
The new `package:contents` script creates two independent clean source sandboxes, runs the real `npm pack` lifecycle in each, and verifies the selected and extracted archive contents.
The package build now explicitly sets every packaged regular file to mode `0644`, then sets each declared executable to `0755`, so npm does not inherit archive entry modes from the caller's umask.
This mode normalization does not change issue 016's output paths, content digests, clean-build behavior, or package verification semantics.

## Tests Added

The package-content verifier compares the explicit `npm pack --json` file manifest with the complete generated production tree and required package files.
It requires the CLI binary, production manifest, declarations, runtime fixture, README, package metadata, and a prospective LICENSE fixture to be present.
It seeds forbidden canaries for tests, coverage, `.worktrees`, `docs/execution`, `docs/issues`, `.env`, a local database, an unintended fixture source map, and stale generated output.
It proves those canaries are absent after the real clean-build package lifecycle.
It packs once under umask `022` and once under umask `077`, extracts both tarballs while preserving their header modes, and compares normalized file paths, modes, SHA-256 content digests, and complete package metadata.
Archive timestamps are deliberately omitted from the normalized comparison, so this check does not promise byte-for-byte gzip identity.

## Commands And Results

- Red package-content run before the allowlist: `pnpm package:contents` failed because npm included source, scripts, internal documents, and every seeded forbidden canary.
- Red review-fix reproduction: `umask 077 && pnpm package:contents` failed because generated regular files were archived as `0600` instead of `0644`.
- Red cross-umask test before mode normalization: `pnpm package:contents` failed because the synthetic LICENSE created under umask `077` was archived as `0600`.
- Package-content verification: `pnpm package:contents` passed with 71 deterministic files in clean packs under umasks `022` and `077`, including the synthetic prospective LICENSE.
- Restrictive-caller verification: `umask 077 && pnpm package:contents` passed with the same 71 deterministic files and normalized modes.
- Clean production build: `pnpm build` passed.
- Production output verification: `pnpm package:verify` passed.
- Package dry run: `npm pack --dry-run` passed with 70 entries because issue 018 has not yet supplied LICENSE.
- Typecheck: `pnpm check` passed.
- Full suite: `pnpm test` passed 552 of 552 tests across 17 files in 38.44 seconds.
- Issue 016 tarball installation test: `tests/package/package-e2e.test.ts` passed all 7 tests, including installation into an empty consumer and a SQLite-backed CLI task from the installed tarball.
- Diff validation: `git diff --check` passed.

## Acceptance Criteria Evidence

The allowlist contains only issue 016's production output, its required runtime fixture, package documentation, and prospective licensing material.
Tests, coverage, worktrees, planning documents, local databases, secrets, source files, package scripts, and stale pre-build output are absent from the package.
The clean prepack lifecycle removes stale `dist` state before selecting the allowlisted production tree.
The verifier binds the npm manifest to every generated production file and verifies that `dist/src/cli/main.js` is mode `0755` while all other archive files are mode `0644`.
Clean builds under umasks `022` and `077` must produce identical normalized archive paths, modes, SHA-256 content digests, and complete package metadata.
README and the deterministic worker fixture are present in the current tarball, and a synthetic LICENSE proves issue 018's future file will be included without creating that file or adding license metadata in this issue.

## Remaining Concerns

Issue 018 still owns selecting and adding the repository LICENSE and package license metadata.
The determinism check requires the system `tar` executable to extract locally generated npm tarballs.
The verifier intentionally normalizes timestamps and does not assert byte-for-byte gzip identity.

## Commit Identity

Branch: `fix/predeploy-c1-files-019`.
Initial implementation commit: `b534e17`.
Blocking review-fix commit: this document's containing commit.
