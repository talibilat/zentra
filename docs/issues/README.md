# Active Pre-Deployment Issue Corpus

This directory contains the 10 unresolved deployment findings and the one deferred enhancement.

Completed issue briefs were removed on 2026-07-13 after their reviewed implementation and verification evidence was integrated into `main`.

The retained implementation reports in `docs/execution/` preserve the audit trail for completed issues.

## Remaining Deployment Findings

- High: [003 - Make Recovery Completion Race-Safe](003-high-make-recovery-completion-race-safe.md), [004 - Expose Authorized Recovery Completion](004-high-expose-authorized-recovery-completion.md), and [017 - Decide And Enable Distribution Model](017-high-decide-and-enable-distribution-model.md)
- Medium: [007 - Centralize Task Chain Invariants](007-medium-centralize-task-chain-invariants.md), [020 - Restrict Unsupported Platform Installation](020-medium-restrict-unsupported-platform-installation.md), [021 - Bound Node Engine Compatibility](021-medium-bound-node-engine-compatibility.md), [022 - Add Operator Diagnostics](022-medium-add-operator-diagnostics.md), and [024 - Add CI And Release Package Gates](024-medium-add-ci-and-release-package-gates.md)
- Low: [025 - Preserve Signal Exit Codes](025-low-preserve-signal-exit-codes.md) and [028 - Persist And Bound Integration Cleanup Failures](028-low-persist-and-bound-integration-cleanup-failures.md)

## Deferred Enhancement

- [005 - Deferred Safe Nested Relative Paths](005-deferred-safe-nested-relative-paths.md)

## Current Ordering

Issue 003 is unblocked by completed issues 002 and 014.

Issue 028 is unblocked by completed issues 010 and 014.

Issues 004, 022, and 025 share `src/cli/main.ts` and must be serialized after issues 003 and 014.

Issue 007 waits until the recovery changes settle.

Issue 024 requires completed acceptance evidence for issues 020 and 021, and issue 017 follows issue 024.

Issue 005 is excluded from deployment closure.
