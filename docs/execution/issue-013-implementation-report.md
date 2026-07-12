# Issue 013 Implementation Report

## Status

Implemented, independently reviewed, remediated, and verified on `fix/predeploy-d-persistence`.

## Root Cause

`readStream`, `readAll`, and append admission called an aggregate `COUNT`/`SUM`/`MAX` query over every matching event before enforcing event-count, per-event, or total-byte limits.
The aggregate therefore made rejection cost proportional to all matching rows.
The journal also opened database sidecars without file-size admission and did not fail closed when a hostile schema omitted the indexes needed to make a limit-plus-one query bounded.

## Files Changed

- `src/journal/sqlite-journal.ts`
- `tests/journal/sqlite-journal.test.ts`
- `docs/execution/issue-013-implementation-report.md`

## Tests Added

- Oversized and exact-limit database, WAL, and shared-memory admission tests.
- SQLite page-count and journal-size pragma assertions.
- Assertions that production stream and global reads contain no aggregate scan, use limit-plus-one, and invoke the operation guard.
- `EXPLAIN QUERY PLAN` assertions against the exact production discovery and materialization SQL.
- A 300,000-event malicious journal rejection test in an isolated Node.js subprocess with wall-time and whole-process peak-RSS budgets.
- A malicious nonmatching schema test that proves missing indexes fail closed before a read.
- A concurrent WAL writer test that proves discovery and materialization observe one read snapshot.
- Exact and one-unit-over boundary tests for event count, per-event bytes, and total materialized bytes.
- A malicious indexed schema with an extra 128 MiB virtual generated column that cannot be evaluated by the journal connection.
- Runtime assertions of the actual stream and global discovery bindings, including the `MAX_JOURNAL_READ_EVENTS + 1` limit.
- Deterministic operation-deadline expiry that proves SQLite invokes the guard and the journal translates the interruption to the public read-limit error.
- A wall-clock rejection test that proves operation deadlines use monotonic time.
- An append-guard interruption test that proves the operation reports an append-specific failure and rolls back without changing existing events or stream version.
- A fail-closed plan test that rejects a superficially indexed stream discovery plan unless it uses the journal-created `(stream_id, stream_version)` index.

## Commands And Results

- Baseline reproduction: a 300,000-event `readAll` prepared the unbounded aggregate and rejected after scanning all rows in 61 ms.
  `/usr/bin/time -l` reported 144,637,952 bytes maximum resident set size and 101,174,032 bytes peak memory footprint for the full setup and rejection process.
- Red test run: `pnpm test -- tests/journal/sqlite-journal.test.ts` exposed six intended gaps, including aggregate SQL in normal and malicious reads, absent file admission, and absent SQLite growth limits.
- Initial focused final run: `pnpm exec vitest run tests/journal/sqlite-journal.test.ts` passed 29 of 29 tests in 876 ms.
- Review-fix red run: `pnpm exec vitest run tests/journal/sqlite-journal.test.ts` failed on generated-column materialization and wall-clock deadline use before the production fix.
- Review-fix focused run: `pnpm exec vitest run tests/journal/sqlite-journal.test.ts` passed 32 of 32 tests in 1.14 seconds.
- Round-2 red run: `pnpm exec vitest run tests/journal/sqlite-journal.test.ts` failed the two intended plan-enforcement and append-interruption tests while the new subprocess resource test passed.
- Round-2 focused run: `pnpm exec vitest run tests/journal/sqlite-journal.test.ts` passed 34 of 34 tests in 988 ms.
- Round-2 full suite: `pnpm test` passed 499 of 499 tests across 15 files in 34.62 seconds.
- Round-2 typecheck: `pnpm check` exited 0.
- Round-2 build: `pnpm build` exited 0.
- Review-fix full suite: `pnpm test` passed 497 of 497 tests across 15 files in 41.38 seconds.
- Typecheck: `pnpm check` exited 0.
- Build: `pnpm build` exited 0.
- Diff hygiene: `git diff --check` exited 0.
- Final benchmark: the same 300,000-event rejection completed its read in 5 ms.
  `/usr/bin/time -l` reported 152,911,872 bytes maximum resident set size and 107,777,024 bytes peak memory footprint for the full database setup and bounded rejection process.
  The round-2 isolated Node.js benchmark completed the malicious read in 5.68 ms and reported 153,157,632 bytes peak RSS through `process.resourceUsage().maxRSS` for the full subprocess.
  The focused test asserts that whole-process peak RSS stays below the documented 192 MiB budget and that the malicious read completes within one second.
- Follow-up fixes address all independent-review findings for explicit materialization projections, monotonic deadlines, malicious generated columns, runtime limit bindings, and deterministic interruption evidence.

## Acceptance Criteria Evidence

- Database files are admitted at 128 MiB, WAL files at 128 MiB, and shared-memory files at 8 MiB.
  Every file is checked before open, after open, and before journal operations.
- Aggregate sizing was replaced by indexed limit-plus-one statements and incremental count, per-event, and total-byte accounting.
- Stream reads require `SEARCH events USING INDEX sqlite_autoindex_events_2` for the unique `(stream_id, stream_version)` plan, and global reads require the `global_position` integer-primary-key search plan.
  The exact production discovery and materialization statements are validated with `EXPLAIN QUERY PLAN` before every operation.
- SQLite lock wait is limited to one second, database growth is limited with `max_page_count`, retained journal size is limited with `journal_size_limit`, and each bounded statement uses a one-second and limit-plus-one connection-local operation guard.
- A schema that cannot provide indexed bounded reads is rejected before data access.
- Discovery and materialization remain inside one SQLite transaction.
  The concurrent-writer test proves both phases replay one consistent snapshot in order.
- Stream and global materialization select only `event_id`, `stream_id`, `stream_version`, `global_position`, `type`, `payload`, `causation_id`, `correlation_id`, and `recorded_at`.
  Extra generated columns are neither evaluated nor materialized.
- Operation deadlines use `process.hrtime.bigint()` and are independent of wall-clock changes.
- Guard interruptions during append are translated to `event journal append limit exceeded`, and the surrounding `BEGIN IMMEDIATE` transaction is rolled back before the error is exposed.
- Existing append, event-count, per-event, total-byte, read-only, persistence, and optimistic-concurrency behavior remains covered by the passing full suite.

## Security Boundary

The change does not expose SQL, shell, subprocess, network, credential, or external-system authority.
All SQL shapes remain internal constants and all caller values remain bound parameters.
The journal fails closed for oversized database sidecars and schemas whose actual production query plans are not bounded by the required indexes.
In-memory journals intentionally skip filesystem admission but retain count, byte, plan, deadline, and row-operation limits.

## Remaining Concerns

`better-sqlite3` exposes no asynchronous statement interrupt or SQLite progress-handler API, so a hard mid-statement time interrupt is not available.
The predictable-failure guarantee for adversarial query work is therefore structural rather than a promise of asynchronous interruption.
Database, WAL, and shared-memory admission limits bound the total data SQLite can scan, while fail-closed production-plan validation and indexed limit-plus-one discovery bound returned rows before materialization.
Connection-local row and monotonic-deadline guards detect work at expression-evaluation boundaries, but they do not defeat the underlying library limitation.
This residual limitation is acceptable for this LOW-severity issue because total scannable data remains admitted and bounded.
An external process can race file growth after a filesystem size check, but the transaction snapshot, required indexed plans, row guard, and deadline preserve the documented structural bounds.
The wall-time threshold is intentionally generous for supported macOS CI variation and is backed by structural SQL and query-plan assertions rather than timing alone.

## Commit Identity

Implementation commit: `40e1666` (`fix: bound SQLite journal read work`).
Initial report commit: `4dc57c1` (`docs: record issue 013 verification`).
Independent-review fix commit: `ac409c9` (`fix: address journal review findings`).
Review-fix report commit: this document's containing commit on `fix/predeploy-d-persistence`.
Round-2 remediation commit: this document's containing commit on `fix/predeploy-d-persistence`.
