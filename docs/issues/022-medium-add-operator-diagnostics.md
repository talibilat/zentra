# 022 - Add Operator Diagnostics

Severity: Medium.
Status: Open.
Execution wave: Wave 3, Pod G.
Suggested owner scope: Public task diagnostic projection, CLI command, sanitization, and bounded operational output.
Dependencies: Issues 003 and 014.
Conflicts and serialization notes: Serialize `src/cli/main.ts` edits with issues 004 and 025 and reuse issue 006 artifact references rather than duplicating evidence payloads.

## Problem

Task status exposes lifecycle and identity fields but not the failed stage, safe reason, validation summary, or retained worktree location needed for remediation.
Operators receive a terminal outcome without enough bounded context to diagnose the failure.

## Repository Evidence

`src/tasks/task-projection.ts:9-17` defines `TaskView` with task, project, title, lifecycle, terminal outcome, stream version, and lease owner only.
`src/cli/main.ts:230-237` returns that task view directly from `task status`.
`src/orchestration/tracer-bullet.ts:449-459` appends stage, reason, and evidence on termination, but the public status projection does not expose a sanitized diagnostic view.

## Failure Sequence Or User Impact

A task fails validation, review, Git, cleanup, or recovery.
The operator runs `task status` and sees only `failed`, `cancelled`, or `timed_out`.
They cannot tell which stage failed, what safe reason was recorded, where retained state lives, or which validation evidence should be inspected.

## Acceptance Criteria

- [ ] Add a diagnostic view or command that reports the latest stage, stable reason code, bounded sanitized message, validation outcome summary, recovery action, and retained worktree identity when safe.
- [ ] Derive diagnostics from validated journal replay rather than mutable in-memory exceptions.
- [ ] Redact secrets, absolute paths not intended for operators, raw environment data, unbounded command output, and internal stack traces.
- [ ] Reference typed artifacts by ID and digest when issue 006 evidence is available.
- [ ] Preserve the existing compact task status contract unless a versioned change is explicitly chosen.

## Required Tests

- [ ] Add CLI end-to-end tests for failures at worker, artifact, focused validation, review, commit, integration, cleanup, and recovery stages.
- [ ] Add output byte-limit, secret-canary, control-character, malformed-event, and missing-worktree tests.
- [ ] Verify diagnostics remain deterministic after process restart.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Exercise the packed CLI against representative failed tasks and verify an operator can identify the next safe action without reading SQLite directly.
Review all output fields for boundedness and redaction.

## Non-Goals

This issue does not expose raw child environments or unlimited stdout and stderr.
This issue does not automatically repair failed tasks.
This issue does not turn internal exception strings into a stable public API without sanitization.
