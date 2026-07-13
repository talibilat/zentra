# 008 - Trace URL Parse Deprecation

Severity: Low.
Initial status: Needs reproduction.
Current disposition: Closed as not reproduced; see `docs/execution/issue-008-reproduction-report.md`.
Execution wave: Wave 1, Pod C.
Suggested owner scope: CLI dependency tracing before any dependency remediation is proposed.
Dependencies: None.
Conflicts and serialization notes: C0 captures one of the two deterministic evidence outcomes below, and C1 may start after either outcome is recorded.

## Problem

CLI help emits Node's `DEP0169` warning for deprecated `url.parse` usage.
The responsible dependency has not been identified, so a production command produces avoidable warning output and may break under future Node versions.

## Repository Evidence

`package.json:19-28` declares the runtime and development dependency set from which the deprecated call must originate.
`pnpm-lock.yaml:399` records Commander 14.0.3, while the lockfile must be traced rather than assuming Commander is responsible.
Running the built CLI help with `--trace-deprecation` is required to obtain the exact stack because no repository source directly calls `url.parse`.

## Failure Sequence Or User Impact

An operator runs `zentra --help` on the supported Node runtime.
Node writes a deprecation warning and stackless notice to standard error.
The warning undermines clean CLI output and can become a runtime failure after the deprecated API is removed.

## Acceptance Criteria

Exactly one of the following deterministic outcomes must be retained as issue evidence.

### Reproduced Outcome

- [ ] Run `node --trace-deprecation dist/src/cli/main.js --help` before making edits and retain the complete deprecation stack, Node version, and lockfile state.
- [ ] Identify and retain the responsible dependency version and exact call path without speculative upgrades.
- [ ] Only after that evidence exists, permit a focused upgrade, replacement, patch, or removal of the responsible dependency.
- [ ] Record the focused resolution in operator or release documentation if it constrains supported dependency versions.

### Not-Reproduced Outcome

- [ ] Retain the exact command, Node version, complete lockfile state or digest, and clean standard-error output.
- [ ] Close the issue or record an explicit named disposition of `not reproduced` without changing dependencies or the lockfile.
- [ ] Release C1 to begin after the evidence and disposition are recorded.

## Required Tests

- [ ] For a reproduced outcome, preserve the pre-edit trace, Node version, lockfile state, responsible dependency version, and call path.
- [ ] For a reproduced outcome, add a built or packed CLI test that asserts no `DEP0169` output after the focused remediation.
- [ ] For a reproduced outcome, run representative operational commands and preserve command parsing and help behavior.
- [ ] For a not-reproduced outcome, repeat the exact command from a clean build and retain clean standard error without dependency changes.

## Final Verification

Run `node --trace-deprecation dist/src/cli/main.js --help` from the clean built CLI and retain the Node version and lockfile state.
For a reproduced outcome, retain the trace and responsible call path, apply only the focused remediation, and run `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm check`, and `pnpm build`.
For a reproduced outcome, run the traced command and installed tarball binary and verify standard error is empty.
For a not-reproduced outcome, retain clean standard error, verify the dependency and lockfile state did not change, and record closure or explicit disposition.

## Non-Goals

This issue does not suppress process warnings globally.
This issue does not hide unrelated deprecations without fixing their cause.
This issue does not perform broad dependency upgrades unrelated to the traced stack.
This issue does not authorize any dependency upgrade before the source package and call path are captured in a reproduced outcome.
This issue does not authorize dependency or lockfile changes for a not-reproduced outcome.
