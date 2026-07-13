# 013 - Bound SQLite Read Work Before Aggregate Scan

Severity: Low.
Status: Open.
Execution wave: Wave 1, Pod D.
Suggested owner scope: SQLite journal admission limits, bounded queries, and malicious database tests.
Dependencies: None.
Conflicts and serialization notes: This pod exclusively owns `src/journal/sqlite-journal.ts` during Wave 1.

## Problem

Journal reads run unbounded aggregate scans before enforcing event-count and byte limits.
A malicious or unexpectedly large SQLite database can consume excessive CPU and I/O before Zentra discovers that the result exceeds configured limits.

## Repository Evidence

`src/journal/sqlite-journal.ts:185-215` calls `readSize` before selecting rows for both stream and global reads.
`src/journal/sqlite-journal.ts:219-227` computes `COUNT`, `SUM`, and `MAX` across every matching event without a query-work cap.
`src/journal/sqlite-journal.ts:235-245` enforces limits only after the aggregate query has completed.

## Failure Sequence Or User Impact

An operator opens a database containing millions of events or oversized WAL state.
Zentra executes full aggregate scans to calculate exact counts and byte totals.
The process stalls or exhausts operational budgets before returning the intended read-limit error.

## Acceptance Criteria

- [ ] Reject database, WAL, and shared-memory files that exceed documented safe size limits before expensive reads.
- [ ] Bound event discovery with limit-plus-one queries and incremental byte accounting rather than an unbounded full aggregate.
- [ ] Ensure appropriate indexes support stream-version and global-position bounded reads.
- [ ] Apply SQLite progress, operation, or equivalent interruption limits so adversarial query work fails predictably.
- [ ] Preserve transactional consistency and existing event-count, per-event, and total-materialized-byte guarantees.

## Required Tests

- [ ] Add a large malicious database test that exceeds count limits and completes within a bounded duration and memory budget.
- [ ] Add oversized database and WAL admission tests.
- [ ] Add query-plan or index assertions for stream and global reads.
- [ ] Preserve boundary tests at exactly each configured limit and one unit over it.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Benchmark rejected large reads and record bounded wall time and memory use on the supported platform.
Verify normal journals still replay in order within one consistent snapshot.

## Non-Goals

This issue does not turn SQLite into an untrusted multi-tenant service.
This issue does not remove materialized-byte limits.
This issue does not add journal compaction or archival.
