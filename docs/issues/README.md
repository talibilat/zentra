# Active Pre-Deployment Issue Corpus

This directory contains the 15 unresolved deployment findings and the one deferred enhancement.

Completed issue briefs were removed on 2026-07-13 after their reviewed implementation and verification evidence was integrated into `main`.

The retained implementation reports in `docs/execution/` preserve the audit trail for completed issues.

## Remaining Deployment Findings

- Critical: [002 - Reconcile Uncertain Worktree Creation](002-critical-reconcile-uncertain-worktree-creation.md)
- High: [003 - Make Recovery Completion Race-Safe](003-high-make-recovery-completion-race-safe.md), [004 - Expose Authorized Recovery Completion](004-high-expose-authorized-recovery-completion.md), [014 - Add Cross-Process Integration Lease](014-high-add-cross-process-integration-lease.md), and [017 - Decide And Enable Distribution Model](017-high-decide-and-enable-distribution-model.md)
- Medium: [007 - Centralize Task Chain Invariants](007-medium-centralize-task-chain-invariants.md), [010 - Reject Grafts Before Integration Effects](010-medium-reject-grafts-before-integration-effects.md), [020 - Restrict Unsupported Platform Installation](020-medium-restrict-unsupported-platform-installation.md), [021 - Bound Node Engine Compatibility](021-medium-bound-node-engine-compatibility.md), [022 - Add Operator Diagnostics](022-medium-add-operator-diagnostics.md), and [024 - Add CI And Release Package Gates](024-medium-add-ci-and-release-package-gates.md)
- Low: [015 - Bound Validation Invocation ID Lifetime](015-low-bound-process-lifetime-registries.md), [025 - Preserve Signal Exit Codes](025-low-preserve-signal-exit-codes.md), [027 - Add Security Reporting Policy](027-low-add-security-reporting-policy.md), and [028 - Persist And Bound Integration Cleanup Failures](028-low-persist-and-bound-integration-cleanup-failures.md)

## Deferred Enhancement

- [005 - Deferred Safe Nested Relative Paths](005-deferred-safe-nested-relative-paths.md)

## Current Ordering

Issue 014 remains the prerequisite for issues 002, 003, 010, and 028.

Issue 002 precedes issue 003.

Issues 004, 022, and 025 share `src/cli/main.ts` and must be serialized after issues 003 and 014.

Issue 007 waits until the recovery changes settle.

Issue 024 requires completed acceptance evidence for issues 020 and 021, and issue 017 follows issue 024.

Issue 005 is excluded from deployment closure.
