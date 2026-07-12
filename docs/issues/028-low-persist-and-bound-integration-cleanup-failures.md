# 028 - Persist And Bound Integration Cleanup Failures

Severity: Low.
Status: Open.
Execution wave: Wave 2, Pod F, after integration lease semantics.
Suggested owner scope: Integration cleanup-failure retention, durable evidence, bounded storage, acknowledgement, and restart behavior.
Dependencies: Issue 014.
Conflicts and serialization notes: Begin after issue 014 defines durable lease identity and ownership, and serialize `src/integration/integration-queue.ts` changes with other integration-queue writers.

## Problem

Integration cleanup failures are retained only in an unbounded in-memory array.
Long-running processes accumulate stale records, while process restarts erase actionable failures before an operator can inspect or acknowledge them.

## Repository Evidence

`src/integration/integration-queue.ts:77-87` stores cleanup failures in an instance array and returns the complete accumulated list.
`src/integration/integration-queue.ts:711-723` appends every cleanup failure without durable retention, acknowledgement, or eviction semantics.

## Failure Sequence Or User Impact

An integration cleanup fails after an effect that requires operator attention.
The process retains the failure indefinitely in memory or exits and loses it entirely.
Later task evidence can include unrelated historical failures, while a restarted operator process has no durable record to reconcile.

## Acceptance Criteria

- [ ] Persist actionable cleanup failures as durable evidence bound to the exact task, canonical repository, integration ref, and issue 014 lease identity.
- [ ] Define hard count and byte bounds with deterministic retention behavior that does not silently discard unacknowledged failures before the documented bound is reached.
- [ ] Support explicit acknowledgement with actor, time, and disposition evidence.
- [ ] Restore unacknowledged actionable failures after restart without treating stale lease ownership as current authority.
- [ ] Expose only cleanup failures relevant to the current task or lease when building task evidence and diagnostics.

## Required Tests

- [ ] Add restart tests proving unacknowledged cleanup failures remain visible and acknowledged failures retain durable disposition evidence.
- [ ] Add count, byte, eviction, and long-loop tests proving memory and durable storage remain within documented bounds.
- [ ] Add task, repository, ref, and lease-scoping tests that exclude unrelated historical failures from current evidence.
- [ ] Add stale-owner tests proving restart recovery does not inherit expired lease authority.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Force an integration cleanup failure, restart the process, and verify the same bounded durable record remains actionable.
Acknowledge the failure and verify later task evidence excludes it while preserving its durable disposition history.

## Non-Goals

This issue does not change validation invocation ID lifetime, which belongs to issue 015.
This issue does not create a general-purpose incident-management or metrics system.
This issue does not let cleanup-failure evidence grant or transfer integration lease authority.
