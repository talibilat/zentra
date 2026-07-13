# Pre-Deployment Remediation Handoff

## Status

**NOT DEPLOYABLE.**

The reviewed integration baseline is commit `9b825646fc0a3a41aa1092f4e03bd7a052f7d4a9` on `fix/pre-deployment`.
This handoff branch starts at that exact commit, and the handoff commit will be merged to `main` before remediation continues.
Do not deploy, publish, tag, or create a release until every remaining finding and final deployment gate below has fresh evidence.

Use the issue corpus index at [`docs/issues/README.md`](../issues/README.md) and the execution rules at [`docs/issues/CLAUDE_EXECUTION_PROMPT.txt`](../issues/CLAUDE_EXECUTION_PROMPT.txt) rather than copying issue details into new plans.
The historical progress ledger is [`docs/execution/pre-deployment-progress.md`](pre-deployment-progress.md), but its active-process and current-head sections are stale and must not be treated as current state.

## Integrated State

Issues **001, 006, 008, 009, 011, 012, 013, 016, 019, 023, and 026** are integrated and closed with their issue briefs and reports as evidence.
The implementation reports are [`001`](issue-001-implementation-report.md), [`006`](issue-006-implementation-report.md), [`009`](issue-009-implementation-report.md), [`011`](issue-011-implementation-report.md), [`012`](issue-012-implementation-report.md), [`013`](issue-013-implementation-report.md), [`016`](issue-016-implementation-report.md), [`019`](issue-019-implementation-report.md), [`023`](issue-023-implementation-report.md), and [`026`](issue-026-implementation-report.md).
Issue 008 was closed by the deterministic not-reproduced evidence in [`docs/execution/issue-008-reproduction-report.md`](issue-008-reproduction-report.md).

Issues **020 and 021 have integrated implementation but do not yet have complete acceptance evidence**.
Their reports are [`docs/execution/issue-020-implementation-report.md`](issue-020-implementation-report.md) and [`docs/execution/issue-021-implementation-report.md`](issue-021-implementation-report.md).
Node.js 25 and 26 clean-install and runtime evidence belongs to issue 024's Darwin arm64 matrix, and `package.json` still declares the consumer dependency as `better-sqlite3: ^12.0.0` while the support evidence covers the locked `12.11.1` release.
Do not mark 020 or 021 accepted until issue 024 supplies the runtime matrix and a reviewed dependency-range decision binds consumer installation to supported `better-sqlite3` evidence.

The remaining deployment corpus is **002, 003, 004, 007, 010, 014, 015, 017, 018, 022, 024, 025, 027, and 028**.
Issue **005** is a deferred post-MVP enhancement and is excluded from deployment closure by [`docs/issues/005-deferred-safe-nested-relative-paths.md`](../issues/005-deferred-safe-nested-relative-paths.md).

## Human Decisions

The recorded issue 001 decision is **Trusted-Project MVP Mode** for owner-controlled projects, with host-user authority and the residual replaced-executable TOCTOU accepted by Md Talib on 2026-07-12.
The authoritative boundary is recorded in [`AGENTS.md`](../../AGENTS.md) and [`docs/execution/issue-001-implementation-report.md`](issue-001-implementation-report.md).

The recorded issue 017 decision is **GitHub release tarballs with checksums and no npm publication**.
Implement it only after issue 024 as required by [`docs/issues/017-high-decide-and-enable-distribution-model.md`](../issues/017-high-decide-and-enable-distribution-model.md).

The recorded issue 027 decision is **GitHub private vulnerability reporting for `talibilat/zentra` as the monitored private intake route**.
The writer must still prove the route can receive a harmless test report and satisfy [`docs/issues/027-low-add-security-reporting-policy.md`](../issues/027-low-add-security-reporting-policy.md).

The recorded issue 018 license choice is **MIT**, with SPDX identifier `MIT`.
Before an issue 018 writer starts, Md Talib must explicitly supply the exact copyright year and exact holder string for the canonical `Copyright (c) <year> <holder>` line.
No exact holder/year pair is currently recorded, and an agent must not infer one.
See [`docs/issues/018-high-add-license.md`](../issues/018-high-add-license.md).

## Unresolved Review Findings

These inherited findings are still evidenced at `9b82564`, are not waived, and require fresh reproductions, dedicated fixes, and independent reviews.

- Caller-selected reviewer executable authority remains in `src/cli/main.ts`, where `--reviewer-executable` and arbitrary reviewer arguments select a host executable without the validation executable policy or a project-owned authority boundary.
- Reviewer descendant cleanup remains in `src/reviews/reviewer-adapter.ts`, where settlement sends `SIGKILL` but does not prove the owned process group and descendants are absent before accepting success.
- Package-verifier descendant cleanup remains in `scripts/verify-package-contents.mjs`, where synchronous `npm pack` and tar subprocess timeout handling does not prove lifecycle descendants are gone.
- ProcessSupervisor surviving-descendant outcome precedence remains in `src/workers/process-supervisor.ts`, where failure to confirm group exit becomes `descendant_survived` only when the prior decision is `exit`, allowing cancellation or timeout to hide a surviving process group.
- The artifact and CLI bound mismatch remains across `src/cli/main.ts`, `src/workspaces/git-client.ts`, `src/contracts/artifact.ts`, and tracer tests because CLI content can consume the full 1 MiB limit before Git diff framing and replaced content expand the retained patch beyond the 1 MiB capture/artifact boundary.
- The README reviewer-option mismatch remains in `README.md` and `src/cli/main.ts` because the README says callers cannot select reviewer executables while `task run` exposes reviewer executable and argument options.
- The `better-sqlite3` range and support-evidence mismatch remains in `package.json`, `pnpm-lock.yaml`, `tests/package/package-metadata.test.ts`, and `docs/release/support-policy.md` because the consumer range floats across 12.x while runtime evidence names locked `12.11.1` and Node.js 25/26 have not run.

None of these findings is accepted risk merely because an earlier scoped metadata gate passed or an abandoned review branch contained a candidate fix.
Fresh agents must reproduce and review the current integrated code rather than cherry-picking unreviewed or reverted fixes.

## Next Order

Follow this exact dependency-respecting order.

1. Merge this handoff commit into `main`, verify `main` contains integration commit `9b82564` plus this document, and push `main` only through the human-approved integration procedure.
2. Reconcile and remove completed remediation worktrees and branches only after their commits are confirmed on `main` and `origin`; preserve any worktree with uncertain, dirty, or unintegrated state.
3. Obtain the exact issue 018 MIT holder/year decision from Md Talib and record it before launching the 018 writer.
4. Reproduce and remediate the seven unresolved review findings above in isolated branches, with test-driven fixes and fresh specification, quality, and security review as applicable.
5. Complete issue 018 and issue 027 in nonoverlapping worktrees, and complete the `better-sqlite3` dependency-range follow-up needed for issue 021 acceptance.
6. Implement issue 024, including clean Darwin arm64 jobs on Node.js 24, 25, and 26, then close the remaining acceptance evidence for 020 and 021.
7. Implement issue 017 from the recorded GitHub-release-tarball decision only after issue 024 is reviewed and integrated.
8. Implement issue 015, whose issue 001 dependency is already settled.
9. Implement issue 014 first in Wave 2 and integrate it before any issue that consumes lease identity or edits its integration critical section.
10. Implement issue 002 and then issue 003 with one recovery writer or strictly sequential recovery worktrees.
11. After 014, implement issue 010 and then issue 028 with strictly serialized ownership of `src/integration/integration-queue.ts`; these may overlap the 002/003 sequence only when owned files and logical reviews remain independent.
12. After 003 and 014, use one serialized CLI owner for issue 004, then 022, then 025 because all three edit `src/cli/main.ts`.
13. Implement issue 007 only after all Wave 2 and Wave 3 recovery behavior has settled.
14. Run fresh whole-branch reviews, final verification, and the deployment gate without waiving any unresolved Critical or Important finding.

The exact briefs are [`002`](../issues/002-critical-reconcile-uncertain-worktree-creation.md), [`003`](../issues/003-high-make-recovery-completion-race-safe.md), [`004`](../issues/004-high-expose-authorized-recovery-completion.md), [`007`](../issues/007-medium-centralize-task-chain-invariants.md), [`010`](../issues/010-medium-reject-grafts-before-integration-effects.md), [`014`](../issues/014-high-add-cross-process-integration-lease.md), [`015`](../issues/015-low-bound-process-lifetime-registries.md), [`017`](../issues/017-high-decide-and-enable-distribution-model.md), [`018`](../issues/018-high-add-license.md), [`022`](../issues/022-medium-add-operator-diagnostics.md), [`024`](../issues/024-medium-add-ci-and-release-package-gates.md), [`025`](../issues/025-low-preserve-signal-exit-codes.md), [`027`](../issues/027-low-add-security-reporting-policy.md), and [`028`](../issues/028-low-persist-and-bound-integration-cleanup-failures.md).

## Worktree Discipline

Create every writer branch and isolated worktree from the latest reviewed integration head, record ownership before editing, and never use `main` or the integration worktree for implementation.
Keep at most four writers active and serialize every shared file exactly as required by the issue index.
Keep each writer worktree until independent review, reviewed integration, and post-integration verification succeed.
After success, confirm the commit is reachable from the integration branch and `origin`, then remove the completed worktree and local branch; remove remote implementation branches only with explicit human authorization.
After this handoff is merged, remove `docs/pre-deployment-handoff` and `.worktrees/predeploy-handoff` only after both local and remote reachability are confirmed.

## Current Evidence

At integration commit `9b82564`, the recorded gate passed **700 tests**, `pnpm check`, `pnpm build`, `pnpm package:verify`, and `pnpm package:contents`.
The package-content gate verified 71 deterministic files across clean packs under umasks `022` and `077`.
This evidence describes the current baseline only and does not satisfy the remaining issue acceptance criteria or final deployment gate.

## Final Verification

Run all issue-specific commands from the linked briefs, then run the following from a clean checkout with Node.js 24 or newer and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm check
pnpm build
pnpm package:verify
pnpm package:contents
pnpm exec vitest run tests/package/package-metadata.test.ts tests/package/package-e2e.test.ts
npm pack --dry-run --json
pnpm audit --prod
git diff --check
```

Issue 024 must additionally produce clean nonpublishing Darwin arm64 CI evidence for Node.js 24, 25, and 26, retain the exact tarball and checksum, install that tarball into an empty consumer, load `better-sqlite3`, run CLI help, and complete one deterministic SQLite-backed task.
Run fresh whole-branch specification, code-quality, and security reviews after all integrations and resolve every Critical and Important finding.

## Deployment Gate

Deployment remains blocked until all 3 Critical, 7 High, and 9 Medium findings are closed with evidence, all 8 Low findings are closed or explicitly accepted by a named human, and issue 005 remains excluded.
The issue 018 holder/year decision must be recorded, issues 020 and 021 must have complete acceptance evidence, all inherited findings above must be resolved, and no unresolved Critical or Important review finding may remain.
The final clean package must pass frozen installation, tests, type checking, production build, deterministic packing, empty-consumer installation, supported-runtime execution, vulnerability audit, and Git diff checks.
Only then create `docs/execution/pre-deployment-final-report.md` with exact commits, commands, CI runs, package checksum, decisions, accepted Low risks, and final Git state.

## First Actions For The Next Agent

1. Confirm `git status --short --branch`, `git worktree list --porcelain`, `git branch --all --verbose --no-abbrev`, and `git log --oneline --decorate -20` agree with this handoff.
2. Confirm the handoff commit and `9b82564` are reachable from the new execution base before cleaning any branch or worktree.
3. Read [`AGENTS.md`](../../AGENTS.md), [`docs/issues/README.md`](../issues/README.md), and the exact issue brief before taking ownership.
4. Ask Md Talib only for the unresolved issue 018 year and holder string, without reopening the recorded MIT, 001, 017, or 027 decisions.
5. Start with E2E reproductions of the unresolved reviewer authority and descendant-cleanup findings, then assign isolated remediation worktrees without exceeding the writer cap.
6. Update a new current execution record rather than rewriting this handoff, the historical progress ledger, issue briefs, or historical implementation reports.

## Suggested Skills

`using-superpowers` is automatic.
Use `using-git-worktrees`, `systematic-debugging`, `test-driven-development`, `subagent-driven-development`, `requesting-code-review`, `verification-before-completion`, `no-mistakes`, and `finishing-a-development-branch` at their applicable stages.
