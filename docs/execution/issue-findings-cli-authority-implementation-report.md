# CLI Authority And Artifact Bound Remediation Report

Date: 2026-07-13

## Scope

This change addresses the pre-deployment findings for caller-selected reviewer execution authority and the mismatch between CLI content, Git diff capture, and retained patch artifact limits.

The implementation changed only the assigned CLI, Git client, artifact contract, README, their existing tests, and this required report.

## Finding 1: Reviewer Authority

### Reproduction

The prior `task run` command accepted `--reviewer-executable`, repeated `--reviewer-argument` values, and `--reviewer-id` directly from the caller.

Those values were passed to `ProcessReviewerAdapter`, which allowed the caller to choose a host executable and arbitrary argv without a project-owned authority boundary or the canonical executable identity policy used for validations.

The new CLI regression test supplies the former reviewer options and requires `INVALID_COMMAND` before the event journal or worktree exists.

The test was authored before the production correction.

This tool session has no command-execution facility, so the RED result could not be executed and observed here.

### Fix

The CLI no longer declares reviewer executable, argument, or identity options.

Commander therefore rejects attempts to provide any of those former options before entering the task action.

Task execution now uses one fixed reviewer identity and fixed reviewer source owned by the CLI.

The reviewer subprocess executable is `APPROVED_VALIDATION_EXECUTABLE`, the canonical absolute Node.js identity approved by project validation policy.

Immediately before constructing the reviewer adapter, the CLI calls `assertApprovedValidationExecutableIdentity` to revalidate the executable's canonical path and recorded file identity.

Reviewer argv is fixed internally and cannot be influenced by the caller.

The deterministic reviewer continues to deny the existing authentication-bypass tracer case and approves other valid deterministic evidence.

Existing CLI and package end-to-end inputs were updated to exercise task execution without external reviewer configuration.

## Finding 2: Retained Artifact Bound

### Reproduction

The prior CLI accepted 1,048,576 bytes of replacement content, which consumed the entire nominal patch budget before Git added diff headers, hunk framing, and removed content.

The artifact schema also bounded JavaScript character count rather than UTF-8 byte count, so a multibyte string could exceed 1 MiB while satisfying the schema.

One new CLI regression test supplies exactly 1,048,576 bytes and requires rejection before journal or worktree effects because no capacity remains for Git framing.

One new artifact-contract regression test supplies 600,000 two-byte characters and requires rejection because the retained diff is 1,200,000 UTF-8 bytes.

Both tests were authored before their production corrections.

This tool session has no command-execution facility, so their RED results could not be executed and observed here.

### Fix

`src/contracts/artifact.ts` now exports one `MAX_RETAINED_ARTIFACT_BYTES` constant equal to 1 MiB.

Patch diffs and retained validation streams are validated with `Buffer.byteLength(..., "utf8")` rather than character count.

`src/workspaces/git-client.ts` uses the same exported boundary for captured Git streams.

The worktree inspection path already rejects every truncated Git diff, so no partial over-limit diff can become patch evidence.

`src/cli/main.ts` now limits replacement content to 522,240 UTF-8 bytes.

That limit reserves 4 KiB for fixed Git headers and a second content-sized allowance for the worst case in which Git adds a prefix byte to every one-byte line.

The complete generated diff remains the final authority for replaced-content expansion because Git capture measures headers, hunk framing, additions, and removals together and fails closed at the shared 1 MiB boundary.

README documentation now states both the content limit and complete-diff behavior.

## Verification Status

The implementation session had no shell or command-execution tool and did not claim any test, type-check, build, or commit result.
The integration steward ran verification directly in this worktree afterward:

- `pnpm check` - clean, no type errors.
- `pnpm test` (full suite) - 19 files, 703 tests passed (701 baseline plus the 2 new regressions in this change).

No push or merge was attempted.
