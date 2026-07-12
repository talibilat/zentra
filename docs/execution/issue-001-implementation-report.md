# Issue 001 Implementation Report

## Status

Implementation and verification complete.

## Root Cause

Project configuration accepted any nonempty validation executable array except obvious shell `-c` wrappers.
The validation runner then forwarded the configured executable directly to the process supervisor.
As a result, configuration could select an unintended executable running with the CLI user's operating-system authority.

## Files Changed

- `src/projects/project-config.ts`
- `src/capabilities/validation-runner.ts`
- `tests/projects/project-config.test.ts`
- `tests/projects/executable-policy-docs.test.ts`
- `tests/capabilities/validation-runner.test.ts`
- `README.md`
- `AGENTS.md`
- `docs/execution/issue-001-implementation-report.md`

## Tests Added

Project configuration tests reject absolute non-allowlisted, relative, dot-segment, trailing-slash, case-variant, symlinked, and `env`-prefixed executable spellings.
Validation runner tests bypass configuration parsing and prove the same spellings are rejected before the process supervisor receives a request.
Replacement regression tests prove that pre-dispatch re-verification fails closed when approved-path content is overwritten and when the pathname is replaced after initial validation.
Regression tests prove approved focused and full validations pass through the same executable policy.
Documentation regression tests require both operator-facing documents to retain the accepted authority and trust-model wording.

## Commands And Results

`pnpm install --frozen-lockfile` reported `Already up to date` and completed in 123 ms without changing `pnpm-lock.yaml`.
`pnpm test` passed with 16 test files and 491 tests in 43.92 seconds.
`pnpm check` exited successfully with no TypeScript diagnostics.
`pnpm build` exited successfully with no TypeScript diagnostics.
`pnpm exec vitest run tests/projects/project-config.test.ts tests/capabilities/validation-runner.test.ts` passed with 2 test files and 66 tests in 2.90 seconds.

## Acceptance Criteria Evidence

The approved identity is the canonical absolute real path of the Node.js executable running Zentra.
Configuration parsing rejects a path unless its spelling equals its filesystem real path and that path equals the approved identity.
At startup, approval records the executable's canonical path, device, inode, size, and SHA-256 content digest.
Immediately before supervisor dispatch, the runner re-resolves the canonical path and re-verifies the file identity and content digest against that approval snapshot.
Tests assert denied identities produce zero supervisor requests.
The full suite exercises the packaged CLI and real focused and full validation paths with the approved executable.
Documentation prohibits hostile repositories and untrusted configuration and limits this MVP to operator-controlled projects.
Repository owner Md Talib explicitly accepted the Trusted-Project MVP authority model on 2026-07-12.

## Security Boundary

Configured validation code runs with the same operating-system authority as the user running the CLI.
The executable allowlist reduces accidental executable substitution but is not a filesystem sandbox.
Neither the allowlist nor `shell: false` restricts what approved Node.js validation code can access with the user's authority.
The supported platform does not provide Zentra with fully atomic execution of the verified file object.
The pre-spawn canonical-path, identity, and content re-verification shrinks but does not eliminate the TOCTOU window between verification and operating-system process creation.
Within Trusted-Project MVP Mode, this residual is accepted as part of the host-user-authority model for owner-controlled projects and is not a claim of absolute replaced-target rejection.

## Remaining Concerns

The Trusted-Project MVP does not support hostile repositories, hostile validation code, untrusted configuration authors, or multi-user operation.
Filesystem isolation would require a separate OS-enforced sandbox or virtual-machine design.
Eliminating the remaining executable replacement race would require a supported-platform design that atomically executes the already verified file object.

## Commit Identity

Branch: `fix/predeploy-a-001`.
Implementation commit: `2e91baf5295f5eea7ffda15a74759d112659a86a` (`2e91baf`).
Commit subject: `fix: enforce canonical validation executables`.
