# 011 - Terminate Descendants After Successful Parent Exit

Severity: High.
Initial status: Open.
Current disposition: Implemented and verified; see `docs/execution/issue-011-implementation-report.md`.
Execution wave: Wave 1, Pod A.
Suggested owner scope: Process supervision, process-group termination, stream grace, and child-lifetime tests.
Dependencies: None.
Conflicts and serialization notes: Issue 011 exclusively owns `src/workers/process-supervisor.ts`, and any later issue 001 or 023 edit to that file must wait until issue 011 is reviewed and integrated.

## Problem

The supervisor can report a successful completed result after the leader exits while descendants remain alive.
The stream grace timer bounds waiting but does not terminate the process group on a normal leader exit or prove that descendants are gone.

## Repository Evidence

`src/workers/process-supervisor.ts:85-98` kills the process group only for non-exit decisions.
`src/workers/process-supervisor.ts:145-159` records a normal exit and settles after close or a one-second stream grace without group termination confirmation.
`docs/execution/HANDOFF.md:49` explicitly treats an escaped descendant as outside the current containment guarantee.

## Failure Sequence Or User Impact

A worker, reviewer, or validation leader spawns a long-lived descendant and exits with code zero.
The supervisor records the leader's successful exit and returns `completed` after streams close or the grace timer fires.
The descendant continues reading, writing, consuming resources, or holding repository state after Zentra believes execution ended.

## Acceptance Criteria

- [ ] After a leader exits, allow only a bounded stream-flush grace and then terminate the owned process group even when the leader exit was successful.
- [ ] Confirm group termination before reporting `completed`.
- [ ] Report failure when an owned same-group descendant survives the bounded termination sequence.
- [ ] Define and document the platform boundary for descendants that deliberately escape the process group.
- [ ] Successful completion means the leader succeeded, protocol output is valid, and no owned descendant remains.

## Required Tests

- [ ] Add an end-to-end fixture whose successful parent leaves a same-group child running and assert that child is terminated before completion.
- [ ] Add fixtures for inherited open streams, a descendant ignoring graceful termination, and bounded forced termination.
- [ ] Add an escaped-session descendant test that verifies the documented fail-closed or unsupported boundary on macOS.
- [ ] Re-run worker, reviewer, validation, cancellation, timeout, and output-limit tests.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build` on macOS.
Capture descendant PIDs in tests and verify they no longer exist before the supervisor promise resolves.
Review all successful child-process call sites and confirm none can outlive a reported completion inside the supported group boundary.

## Non-Goals

This issue does not claim containment of privileged processes or descendants that escape every supported OS ownership mechanism.
This issue does not add Linux or Windows support without platform conformance tests.
This issue does not remove bounded output or timeout behavior.
