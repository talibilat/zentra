# 015 - Bound Validation Invocation ID Lifetime

Severity: Low.
Status: Open.
Execution wave: Wave 2, Pod F.
Suggested owner scope: Validation-runner invocation ID lifetime and active or durable uniqueness semantics.
Dependencies: Issue 001.
Conflicts and serialization notes: Start after the human-selected validation trust model establishes the invocation boundary, and keep integration cleanup-failure work in issue 028.

## Problem

The validation runner retains every accepted invocation ID for the process lifetime.
Long-running processes therefore accumulate memory, while the implementation does not state whether uniqueness is only active-process uniqueness or a durable cross-restart guarantee.

## Repository Evidence

`src/capabilities/validation-runner.ts:74-75` declares a module-level `usedInvocationIds` set.
`src/capabilities/validation-runner.ts:124-132` adds every accepted invocation ID and never removes it.

## Failure Sequence Or User Impact

A long-running Zentra process executes many sequential validations.
Every invocation ID remains reachable after its validation has terminated.
Memory grows without a configured bound, and an undocumented lifetime policy can either reject safe reuse forever or remove IDs without meeting an intended durable uniqueness guarantee.

## Acceptance Criteria

- [ ] Track only active in-process validation invocation IDs unless durable uniqueness is explicitly required and implemented in bounded storage.
- [ ] Remove active IDs in a `finally` path after every completion, cancellation, timeout, spawn error, or thrown exception.
- [ ] If durable uniqueness is required, define its retention window, restart behavior, storage bound, and collision semantics explicitly.
- [ ] Preserve rejection of concurrent duplicate invocation IDs while the first invocation is active.

## Required Tests

- [ ] Add stress tests with many sequential successful and failed validations and assert registry size returns to zero or its documented bound.
- [ ] Add concurrent duplicate-invocation tests while the first invocation is active.
- [ ] Add restart and retention-bound tests if durable uniqueness is selected.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Run a long-loop process test and record stable registry counts and bounded heap behavior.
Verify active duplicates still fail and completed invocation IDs follow the selected active-only or durable policy.

## Non-Goals

This issue does not weaken active duplicate-invocation protection.
This issue does not govern integration cleanup-failure retention, which belongs to issue 028.
This issue does not create a general metrics system.
