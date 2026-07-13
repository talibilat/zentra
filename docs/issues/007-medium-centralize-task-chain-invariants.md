# 007 - Centralize Task Chain Invariants

Severity: Medium.
Status: Open.
Execution wave: Wave 4, Pod I.
Suggested owner scope: Pure event-chain validation, task projection, and recovery reconstruction.
Dependencies: All recovery changes in Waves 2 and 3.
Conflicts and serialization notes: Begin only after issues 002, 003, and 004 settle, and avoid changing externally visible lifecycle behavior during extraction.

## Problem

Task projection and recovery independently encode ordering, uniqueness, payload consistency, and completion invariants.
Duplicated invariant logic can drift so one path accepts a stream that the other rejects or interprets differently.

## Repository Evidence

`src/tasks/task-projection.ts:29-248` defines transitions, single-occurrence rules, receipt snapshots, cleanup ordering, and completion requirements inside projection.
`src/orchestration/recovery.ts:1091-1353` independently reconstructs the task chain and validates event order and payload schemas for recovery.
`src/orchestration/recovery.ts:245-249` first projects through `TaskService` and then relies on its separate reconstructed chain, demonstrating two validators on one stream.

## Failure Sequence Or User Impact

A new event or invariant is added to projection but not to recovery, or vice versa.
A malformed or newly valid stream passes one path and fails the other.
Status and recovery then disagree about the same task, potentially authorizing an effect from a chain that projection would not safely represent.

## Acceptance Criteria

- [ ] Extract one pure event-chain validator that owns event order, occurrence counts, payload schemas, cross-event identity consistency, and lifecycle derivation.
- [ ] Task projection and recovery consume the same validated chain result without duplicating invariant decisions.
- [ ] The validator returns typed, immutable facts needed by both callers and performs no I/O.
- [ ] Existing valid journals retain identical public task views and recovery decisions.
- [ ] Invalid chains fail with deterministic bounded errors before any recovery effect is authorized.

## Required Tests

- [ ] Move the full projection and recovery malformed-chain matrix to direct validator tests.
- [ ] Add parity tests proving projection and recovery accept and reject the same generated event chains.
- [ ] Add regression tests for every integration preparation, observation, cleanup, reconciliation, and completion ordering rule.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Search production code and confirm transition and cross-event invariant tables have one authoritative implementation.
Replay representative existing journals and compare task views and recovery classifications before and after extraction.

## Non-Goals

This issue does not redesign the event vocabulary.
This issue does not migrate or rewrite stored events.
This issue does not weaken validation to preserve malformed historical streams unless a concrete persisted compatibility requirement is documented.
