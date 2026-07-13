# Pre-Deployment Issue Corpus

This corpus contains exactly 28 issue files: 27 deployment findings and one deferred enhancement.
The deployment findings comprise 3 Critical, 7 High, 9 Medium, and 8 Low issues.
Issue 005 is the deferred enhancement and is excluded from deployment closure.
Each linked issue is self-contained and assigns an execution wave, owner scope, dependencies, serialization constraints, acceptance criteria, tests, verification, and non-goals.

The issue statuses, Problem sections, and Repository Evidence sections preserve the pre-deployment audit snapshot at commit `f54ba31`; they are not claims about the current tree.
Completed remediation evidence is recorded in the matching `docs/execution/issue-*-implementation-report.md` files.
Issue 024 remains open because the repository still has no automated CI or release workflow.

Use `CLAUDE_EXECUTION_PROMPT.txt` for the detailed remediation waves and ownership model.

Use `CLAUDE_OPENCODE_ORCHESTRATOR_PROMPT.txt` when Claude Code must act only as the orchestrator and every implementation and review agent must run through OpenCode.

## Execution Model

Reserve `fix/pre-deployment` and its worktree exclusively for reviewed integration and progress-document edits by the integration steward.
No implementation writer may edit files in the integration worktree.
Each active writer gets one unique implementation branch and one unique Git worktree.
One branch cannot be checked out in multiple worktrees.
Every stage creates its writer branch and worktree from the current reviewed `fix/pre-deployment` head and records the stage, owner, branch, worktree, and owned files before edits begin.
Keep each writer branch and worktree until its changes are independently reviewed, integrated into `fix/pre-deployment`, and reviewed in the integration worktree.
Remove a writer branch and worktree only after that reviewed integration succeeds.
Worktree isolation does not remove logical dependencies or permit concurrent edits to overlapping files.
Changes with overlapping file ownership must be serialized even when their conceptual tasks are otherwise independent.
Use at most four concurrent writer agents.
Reviewer and tester agents may bring the total active agent count to 8-10 without exceeding four writers.
An agent must not answer the human decisions required by issues 001, 017, 018, or 027.

## Wave 1

Wave 1 uses staged readiness rather than treating every listed issue as an immediate parallel writer.

### Pod A: Execution Containment

- [001 - Contain Configured Validation Execution](001-critical-contain-configured-validation-execution.md)
- [011 - Terminate Descendants After Successful Parent Exit](011-high-terminate-descendants-after-successful-parent-exit.md)
- [023 - Configure Validation Timeouts](023-medium-configure-validation-timeouts.md)

Only issue 011 may implement immediately.
Issue 001 remains blocked until a named human selects Contained Mode or Trusted-Project MVP Mode.
Issue 023 waits for that decision, but it need not wait for all issue 001 implementation when the approved path leaves timeout work independent.
Every issue 023 edit shared with issue 001 in validation configuration or runner code must be strictly serialized.

### Pod B: Reviewer And Artifacts

- [009 - Require Content-Aware Independent Review](009-high-require-content-aware-independent-review.md)
- [006 - Record Typed Artifacts](006-medium-record-typed-artifacts.md)

Pod B uses one immediate writer and implements issue 009 before issue 006.
Issue 006 must consume the exact review evidence contract established by issue 009.

### Pod C0: Deprecation Reproduction

- [008 - Trace URL Parse Deprecation](008-low-trace-url-parse-deprecation.md)

C0 runs `node --trace-deprecation dist/src/cli/main.js --help` and records either a reproduced or not-reproduced outcome.
A reproduced outcome retains the stack, Node version, lockfile state, responsible dependency, and call path before permitting focused remediation.
A not-reproduced outcome retains the exact command, Node version, lockfile state, and clean standard error, then closes or explicitly dispositions issue 008 without dependency changes.

### Pod C1: Package Foundation

- [016 - Build And Test Publishable CLI Package](016-critical-build-and-test-publishable-cli-package.md)
- [019 - Make Package Contents Deterministic](019-medium-make-package-contents-deterministic.md)

C1 starts after C0 records either deterministic evidence outcome.
C1 uses one package/build writer and implements issue 016 before issue 019.
Issue 016 owns the production binary build and output layout, while issue 019 owns the deterministic package contents and `files` allowlist.

### Pod C2: Metadata And Policy

- [018 - Add License](018-high-add-license.md)
- [020 - Restrict Unsupported Platform Installation](020-medium-restrict-unsupported-platform-installation.md)
- [021 - Bound Node Engine Compatibility](021-medium-bound-node-engine-compatibility.md)
- [026 - Update Stale Execution Documents](026-low-update-stale-execution-documents.md)
- [027 - Add Security Reporting Policy](027-low-add-security-reporting-policy.md)

C2 starts after C1 and uses one package-metadata writer for overlapping package files.
Documentation-only work may proceed in parallel only when files do not overlap.
Issue 018 remains blocked on a human license decision.
Issue 027 remains blocked on a human-approved private reporting route.
Issue 021 is independently implementable within C2 but remains a hard prerequisite of issue 024.

### Pod C3: CI Gate

- [024 - Add CI And Release Package Gates](024-medium-add-ci-and-release-package-gates.md)

C3 starts only after issues 016, 019, 020, and 021 are complete.

### Pod C4: Distribution

- [017 - Decide And Enable Distribution Model](017-high-decide-and-enable-distribution-model.md)

C4 starts only after a named human selects the distribution model and issues 016, 019, and 024 are complete.

### Fixture Integrity Pod

- [012 - Eliminate Fixture Attestation TOCTOU](012-low-eliminate-fixture-attestation-toctou.md)

Fixture Integrity runs after issues 009 and 016 establish reviewer composition and package layout.

### Pod D: Persistence Bounds

- [013 - Bound SQLite Read Work Before Aggregate Scan](013-low-bound-sqlite-read-work-before-aggregate-scan.md)

Pod D owns the SQLite journal and may proceed independently in Wave 1.

## Wave 2

Wave 2 may begin after all ready, non-human-blocked Wave 1 implementation is reviewed and integrated.
Issues 001, 017, 018, and 027 remain named deployment blockers but do not block unrelated later engineering.
If the issue 001 trust-model decision affects issue 023, issue 023 waits while other ready Wave 1 work and unrelated later work continue.

### Pod E: Git And Recovery Consistency

- [014 - Add Cross-Process Integration Lease](014-high-add-cross-process-integration-lease.md)
- [002 - Reconcile Uncertain Worktree Creation](002-critical-reconcile-uncertain-worktree-creation.md)
- [003 - Make Recovery Completion Race-Safe](003-high-make-recovery-completion-race-safe.md)
- [010 - Reject Grafts Before Integration Effects](010-medium-reject-grafts-before-integration-effects.md)

Issue 014 is the first implementation inside Pod E after reviewed integration of all ready, non-human-blocked Wave 1 prerequisites.
Issue 002 begins after issue 014 is reviewed and integrated.
Issues 002 and 003 use one recovery writer or strictly sequential worktrees for every edit to `src/orchestration/recovery.ts`.
Issue 003 begins only after issue 002 recovery edits are reviewed and integrated on top of issue 014.
Issue 010 may use a separate integration writer after issue 014 is reviewed and integrated.
No issue 010 edit to `src/integration/integration-queue.ts` may overlap an issue 014 edit to that file.

### Pod F: Process-State Cleanup

- [015 - Bound Validation Invocation ID Lifetime](015-low-bound-process-lifetime-registries.md)
- [028 - Persist And Bound Integration Cleanup Failures](028-low-persist-and-bound-integration-cleanup-failures.md)

Issue 015 starts after issue 001 settles validation invocation semantics.
Issue 028 starts after issue 014 establishes integration lease identity and ownership.

## Wave 3

Wave 3 begins after the named Wave 2 blockers are complete.

### Pod G: Recovery CLI And Diagnostics

- [004 - Expose Authorized Recovery Completion](004-high-expose-authorized-recovery-completion.md)
- [022 - Add Operator Diagnostics](022-medium-add-operator-diagnostics.md)
- [025 - Preserve Signal Exit Codes](025-low-preserve-signal-exit-codes.md)

Pod G starts after issues 003 and 014.
All three issues modify `src/cli/main.ts` and must be serialized or implemented by one CLI owner.

## Wave 4

### Pod I: Invariant Centralization

- [007 - Centralize Task Chain Invariants](007-medium-centralize-task-chain-invariants.md)

Issue 007 starts only after recovery changes settle so the shared validator captures the final event chain rather than forcing concurrent recovery refactors.

## Deferred Enhancements

- [005 - Deferred Safe Nested Relative Paths](005-deferred-safe-nested-relative-paths.md)

Root-level-only operation is documented MVP behavior.
Issue 005 is not part of active Wave 3 execution or the deployment closure gate.

## Completion Rule

Deployment closure requires evidence for 3 Critical, 7 High, 9 Medium, and 8 Low findings, with Low findings either resolved or explicitly accepted by a named human.
Final deployment requires each human decision for issues 001, 017, 018, and 027 or a named explicit accepted-risk record that states the deployment disposition.
Issue 005 is excluded because it is a deferred post-MVP enhancement.
Every deployment finding remains open until its acceptance criteria, required tests, and final verification have evidence or its Low risk is explicitly accepted.
A severity does not override dependencies, human decisions, or serialization notes.
Reviewers must reject changes that satisfy a local test while leaving the documented end-to-end failure sequence possible.
