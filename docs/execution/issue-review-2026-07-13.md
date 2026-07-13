# Pre-Deployment Issue Review

Date: 2026-07-13.

Scope: Review of the local pre-deployment issue corpus and current Git worktree state.

## Current Baseline

`main` includes the verified remediation integration branch through `9080a43`.

An isolated `fix/predeploy-e-lease` worktree contains a committed issue 014 candidate at `8cc7d0b`.

That candidate has not yet received the independent review and integration evidence required for closure.

The lease worktree contains an untracked `opencode.jsonc` file.

It must be inspected and handled by its owner before that worktree is reused or removed.

## Issue Status Summary

Closed or dispositioned with recorded implementation evidence: 001, 006, 008, 009, 011, 012, 013, 016, 018, 019, 023, and 026.

Issue 005 remains an explicitly deferred post-MVP enhancement and is excluded from deployment closure.

The remaining deployment corpus is 002, 003, 004, 007, 010, 014, 015, 017, 018, 022, 024, 025, 027, and 028.

Issue 017 has its distribution decision recorded, but must wait for issue 024.

Issue 027 has its private GitHub vulnerability-reporting route recorded and can proceed once its policy and private-route receipt verification are coordinated with the owner.

Issue 024 must precede issue 017 and must provide clean Darwin arm64 evidence on Node.js 24, 25, and 26.

Issues 002, 003, 004, 007, 010, 022, 025, and 028 remain ordered behind issue 014 and the recovery or CLI serialization constraints documented in their briefs.

## Priority Assessment

The first technical priority is issue 014, because it establishes the cross-process integration lease required by later recovery and integration work.

Its current isolated candidate should be reviewed and reproduced from the current remediation base rather than accepted solely because a commit exists.

The second technical priority is issue 015, because issue 001 has settled its validation authority boundary and issue 015 is independent of the issue 014 integration-queue changes.

Issue 015 is small, has a narrow ownership boundary, and reduces unbounded process-lifetime state without delaying the lease critical path.

The seven unresolved review findings recorded in the handoff remain mandatory remediation work.

They should be reproduced and assigned in isolated worktrees before release-gate or distribution work proceeds.

## Next Two Assignments

| Order | Issue | Scope | Estimated elapsed time | Dependency and completion condition |
| --- | --- | --- | --- | --- |
| 1 | 014 - Cross-process integration lease | Reproduce the two-process failure, independently review the existing candidate, correct any findings, then run focused two-process and full verification. | 8-12 hours | Start from the reviewed remediation base. Integrate only after independent specification, quality, and security review. |
| 2 | 015 - Bound validation invocation ID lifetime | Add active-only registry cleanup, concurrency and stress coverage, then run focused and full verification. | 3-5 hours | Issue 001 is already settled. Keep `validation-runner.ts` ownership isolated from any future shared validation configuration edits. |

These estimates include implementation, focused tests, full suite, review-fix time, and integration-ready evidence.

They exclude waiting for owner decisions, external GitHub Actions queue time, and any newly discovered Critical or Important findings.
