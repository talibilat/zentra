# 025 - Preserve Signal Exit Codes

Severity: Low.
Status: Open.
Execution wave: Wave 3, Pod G.
Suggested owner scope: CLI signal tracking, JSON cancellation output, and process exit semantics.
Dependencies: Issues 003 and 014.
Conflicts and serialization notes: Serialize `src/cli/main.ts` edits with issues 004 and 022.

## Problem

SIGINT and SIGTERM both abort the operation but ultimately return the generic exit code `1`.
Shells and process supervisors cannot distinguish user interruption from termination or ordinary command failure.

## Repository Evidence

`src/cli/main.ts:99-110` installs one shared abort callback for both SIGINT and SIGTERM and does not retain which signal arrived.
`src/cli/main.ts:128-136` returns the command's generic nonzero code or `1` for caught failures.
`README.md:130-136` promises canonical cancelled JSON with only a generic nonzero exit code.

## Failure Sequence Or User Impact

An operator or service sends SIGINT or SIGTERM to an active CLI command.
The task records or reports cancellation correctly in JSON.
The process exits `1` instead of conventional `130` for SIGINT or `143` for SIGTERM.
Automation misclassifies interruption as an ordinary operational failure and cannot apply signal-specific policy.

## Acceptance Criteria

- [ ] Track the first received termination signal without losing the shared abort behavior.
- [ ] Preserve the existing bounded JSON cancellation result when a known result can be emitted safely.
- [ ] Return exit code `130` for SIGINT and `143` for SIGTERM.
- [ ] Ignore or deterministically handle subsequent different signals without changing an already selected exit meaning.
- [ ] Remove signal listeners in every completion and error path.

## Required Tests

- [ ] Add spawned built-CLI tests that send real SIGINT and SIGTERM and assert JSON, standard-error placement, journal outcome, and exact exit codes.
- [ ] Add tests for a signal before result creation, during child execution, and near successful completion.
- [ ] Add a multiple-signal test and verify no duplicate output or event append.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Invoke the packed CLI from a shell, send each signal, and inspect `$?` for `130` and `143`.
Verify recovery still classifies any uncertain effect instead of forcing a cancelled terminal event.

## Non-Goals

This issue does not convert uncertain Git effects into ordinary cancellation.
This issue does not suppress JSON cancellation evidence.
This issue does not define exit codes for signals other than SIGINT and SIGTERM.
