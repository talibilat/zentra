# Issue 019 Implementation Report

## Status

Implemented and verified on `fix/predeploy-c1-files-019`.

## Root Cause

The package had no `files` allowlist, so npm selected package contents from the working tree and ignore rules after the issue 016 production build.
The resulting tarball included source, tests, package scripts, agent instructions, and internal planning and execution documents that were not needed to install or run Zentra.
There was also no package-content gate proving that independent clean builds produced the same archive paths, modes, package metadata, and file contents.
The initial package-content gate ran both packs under the same ambient umask and therefore could not detect that newly emitted files inherited restrictive modes such as `0600` under umask `077`.
The first mode-normalization fix checked paths with `existsSync` and then called `chmodSync`, which followed a packaged symlink and changed its external target before package verification rejected the symlink.
The package-content verifier also resolved bare `npm` and `tar` names through ambient `PATH` and allowed `spawnSync` to inherit the complete parent environment, including behavior-changing npm configuration.
The subsequent final-component checks still followed symlinked ancestor directories in package inputs and outputs.
As a result, a symlinked `fixtures/` directory could escape the package root, have its external fixture mode changed, and then be omitted from a successfully produced tarball.
The production verifier had the same ancestor traversal weakness and could read required runtime output through a symlinked directory outside the package root.

## Files Changed

- `package.json`
- `scripts/build-package.mjs`
- `scripts/package-files.mjs`
- `scripts/verify-package.mjs`
- `scripts/verify-package-contents.mjs`
- `tests/package/package-e2e.test.ts`
- `docs/execution/issue-019-implementation-report.md`

## Changes Made

`package.json#files` now allows only `dist/`, `fixtures/deterministic-worker.mjs`, `README.md`, and prospective `LICENSE`, in addition to npm's mandatory `package.json` entry.
The allowlist follows issue 016's production output layout without changing its build or verifier behavior.
The production tree includes emitted JavaScript, declarations, source maps, and `dist/package-manifest.json`.
Source maps are intentional package output because issue 016's production build inherits `sourceMap: true` from `tsconfig.json`.
The new `package:contents` script creates two independent clean source sandboxes, runs the real `npm pack` lifecycle in each, and verifies the selected and extracted archive contents.
The package build now explicitly sets every packaged regular file to mode `0644`, then sets each declared executable to `0755`, so npm does not inherit archive entry modes from the caller's umask.
Package path validation is centralized in `scripts/package-files.mjs` for build inputs, generated outputs, package metadata, the runtime fixture, declared binaries, and the production manifest.
Every validation starts at the package root, uses `lstatSync` on each relative path component, rejects symlink and non-directory ancestors, requires final files to be regular non-symlink files, and confirms the canonical target remains within the canonical package root.
Recursive input and output walks validate directories and entries before `readdirSync`, and digest generation validates each file again before `readFileSync`.
The build validates its source/configuration inputs before invoking TypeScript and validates the complete packaged path set before changing any mode.
The verifier validates the manifest, runtime fixture, binaries, build inputs, and build outputs before reading their contents.
All required package paths fail closed when absent, while the prospective `LICENSE` remains the only optional path.
This preflight prevents an invalid later path from causing partial mode changes and preserves the existing actionable missing-binary failure.
The verifier derives npm from the canonical Node installation, resolves both npm and `/usr/bin/tar` to canonical absolute regular executable files, and invokes canonical npm through canonical Node so no shebang lookup can substitute Node.
Every verifier subprocess uses an executable plus argument array with `shell: false`, a fixed minimal environment, isolated npm home, cache, user configuration, and global configuration, and a 120-second timeout.
Subprocess failures now report the full quoted executable and argument vector, exit or signal status, and captured tool output.
The npm `prepack` lifecycle invokes the two Node scripts directly so deterministic verification does not require ambient pnpm resolution.
This mode normalization does not change issue 016's output paths, content digests, clean-build behavior, or package verification semantics.

## Tests Added

The package-content verifier compares the explicit `npm pack --json` file manifest with the complete generated production tree and required package files.
It requires the CLI binary, production manifest, declarations, runtime fixture, README, package metadata, and a prospective LICENSE fixture to be present.
It seeds forbidden canaries for tests, coverage, `.worktrees`, `docs/execution`, `docs/issues`, `.env`, a local database, an unintended fixture source map, and stale generated output.
It proves those canaries are absent after the real clean-build package lifecycle.
It packs once under umask `022` and once under umask `077`, extracts both tarballs while preserving their header modes, and compares normalized file paths, modes, SHA-256 content digests, and complete package metadata.
Archive timestamps are deliberately omitted from the normalized comparison, so this check does not promise byte-for-byte gzip identity.
The package E2E suite replaces the required runtime fixture with a symlink to an external `0600` file and proves that packaging fails without changing the target mode or producing a tarball.
It also replaces the complete `fixtures/` ancestor with a symlink to an external directory and proves `npm pack` fails, the external fixture remains `0600`, and no tarball is produced.
A standalone verifier regression replaces `dist/src/cli/` with a symlink to an external output directory and proves verification rejects the ancestor before reading the CLI.
Focused verifier tests prepend fake npm and tar executables to ambient `PATH` and prove neither is invoked.
Another focused test sets ambient `npm_config_ignore_scripts=true` and proves the verifier strips it rather than bypassing the clean build and packaging stale output.

## Commands And Results

- Red package-content run before the allowlist: `pnpm package:contents` failed because npm included source, scripts, internal documents, and every seeded forbidden canary.
- Red review-fix reproduction: `umask 077 && pnpm package:contents` failed because generated regular files were archived as `0600` instead of `0644`.
- Red cross-umask test before mode normalization: `pnpm package:contents` failed because the synthetic LICENSE created under umask `077` was archived as `0600`.
- Red external-symlink reproduction: the package E2E regression observed the external target change from mode `0600` to `0644` before package verification rejected the symlink.
- Red symlinked-ancestor reproduction: `npm pack` succeeded, omitted `fixtures/deterministic-worker.mjs`, changed the external target from mode `0600` to `0644`, and produced `zentra-0.1.0.tgz`.
- Red verifier-ancestor reproduction: standalone package verification followed a symlinked `dist/src/cli/` ancestor and failed incidentally during a read instead of rejecting the path component.
- Red ambient-PATH reproduction: the verifier selected a fake `npm` prepended to `PATH` and failed with the fake executable's exit status.
- Red inherited-environment reproduction: ambient `npm_config_ignore_scripts=true` bypassed prepack and caused the verifier to detect `dist/stale-output.js` in the package.
- Package-content verification: `pnpm package:contents` passed with 71 deterministic files in clean packs under umasks `022` and `077`, including the synthetic prospective LICENSE.
- Restrictive-caller verification: `umask 077 && pnpm package:contents` passed with the same 71 deterministic files and normalized modes.
- Clean production build: `pnpm build` passed.
- Production output verification: `pnpm package:verify` passed.
- Package dry run: `npm pack --dry-run` passed with 70 entries because issue 018 has not yet supplied LICENSE.
- Typecheck: `pnpm check` passed.
- Full suite: `pnpm test` passed 557 of 557 tests across 17 files in 40.36 seconds.
- Issue 016 tarball installation and package-security tests: `pnpm exec vitest run tests/package/package-e2e.test.ts` passed all 12 tests in 14.60 seconds.
- Diff validation: `git diff --check` passed.

## Acceptance Criteria Evidence

The allowlist contains only issue 016's production output, its required runtime fixture, package documentation, and prospective licensing material.
Tests, coverage, worktrees, planning documents, local databases, secrets, source files, package scripts, and stale pre-build output are absent from the package.
The clean prepack lifecycle removes stale `dist` state before selecting the allowlisted production tree.
The verifier binds the npm manifest to every generated production file and verifies that `dist/src/cli/main.js` is mode `0755` while all other archive files are mode `0644`.
The build and verifier reject packaged symlinks in final paths and every ancestor before any relevant chmod or read, so an external target is neither mode-modified, read as trusted package content, nor silently omitted from a successful package.
Canonical npm and tar resolution, explicit argv execution, isolated npm configuration, and a minimal environment make tool selection independent of ambient `PATH` and parent secrets or npm settings.
Clean builds under umasks `022` and `077` must produce identical normalized archive paths, modes, SHA-256 content digests, and complete package metadata.
README and the deterministic worker fixture are present in the current tarball, and a synthetic LICENSE proves issue 018's future file will be included without creating that file or adding license metadata in this issue.

## Remaining Concerns

Issue 018 still owns selecting and adding the repository LICENSE and package license metadata.
The determinism check requires canonical `/usr/bin/tar` to resolve to an executable regular file for extracting locally generated npm tarballs.
The verifier intentionally normalizes timestamps and does not assert byte-for-byte gzip identity.

## Commit Identity

Branch: `fix/predeploy-c1-files-019`.
Initial implementation commit: `b534e17`.
Mode-normalization review-fix commit: `c7d21c2`.
Security review-fix commit: `49b9627`.
Ancestor-containment review-fix commit: this document's containing commit.
