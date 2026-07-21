# Issue 101 Three-Pod Conformance Report

Date: 2026-07-21

Platform: Darwin arm64

## Scope

The repeatable fixture is `runInstalledThreePodConformance` in `src/conformance/three-pod-installed.ts`.
Both tests in `tests/conformance/three-pod` invoke that same composition, and the packaged test invokes it from an installed tarball.
One authoritative SQLite journal retains exactly three durable pods, four simultaneously overlapping deterministic OpenCode proposal providers, the production trusted patch applier, durable path claims, scheduler resources, repository admissions, integration units, decisions, and outcomes.
The deterministic provider is explicitly attested by `OpenCodeProbe` and traverses the same read-only proposal and trusted-apply production boundaries as OpenCode.

## Measured Gates

| Measure | Expected | Retained evidence |
| --- | ---: | --- |
| Durable pods | 3 | Two `completed`, one `cancelled` |
| Concurrent writer capacity | 4 | Four provider barrier arrivals before any provider completes |
| Heavy validation capacity | 2 | Three real validations queue, peak at two, and retain backpressure before the second wave |
| Review capacity | 2 | Three independent reviews queue, peak at two, and retain backpressure before the second wave |
| Integration capacity | 1 | Concurrent ready units queue and integrate in serialized one-slot waves |
| Verified integration units | 6 | Green, coupled, corrected, conflict-replacement, and cancellation-race units reach `accepted` |
| Durable ownership conflicts | 1 | Contended fifth claim is denied before provider launch |
| Writer checkpoints | 10 | Four simultaneous writers plus conflict, replacement, coupled members, correction, and cancellation-race assignments |
| Worker heartbeats | At least 4 | Incarnation-bound scheduler heartbeat events |
| Cancellation | 1 | One scheduler task and one pod retain `cancelled` evidence |
| Duplicate recovered effects | 0 | Recovered writer has exactly one terminal outcome event |
| AgentTrail event comparison | 100% | Every projected event ID, global position, and journal digest matches |
| Evidence completeness | 100% required types | Canonical report rejects missing required evidence |

The report computes verified throughput, task wait samples including blocked work that never dispatched, conflict rate, backpressure observations, configured and peak capacities, per-assignment evidence, per-unit evidence, and causation completeness from that journal.
Measurements remain data rather than hard-coded claims in `buildThreePodConformanceReport`.
Each run writes `three-pod-conformance-report.json` beside its authoritative database.
Queue waits use retained wall-clock submission and resource-acquisition/start timestamps.
Backpressured validation, review, and integration waves must retain nonzero waits, and throughput must have a nonzero plausible elapsed duration and rate.

## Recovery

The runner starts one daemon incarnation, binds worker incarnations, records heartbeats and checkpoints, and injects a process failure after the supervised receipt and trusted patch effect but before scheduler acknowledgement.
A replacement daemon takes the durable lease, marks the old incarnation stale, reconciles the retained worker effect, and records one terminal observation without redispatch.
The conflict source uses pod B revision 2 with a fresh charter, parent grant, lease, workspace, assignment, scheduler grant and dispatch, claim, supervised proposal, trusted patch, receipt, checkpoint, validation, review, and admission.
After the conflict is observed, pod A revision 2 receives another independently issued authority chain and produces the corrected replacement through the same bounded production path.
No completed assignment, scheduler dispatch, path claim, worktree mutation, branch reset, or direct write authority is reused for conflict or replacement work.
The runner rejects a stale approval digest, approves the exact replacement admission, integrates it, and records final acceptance.
Two fresh revision-bound writers retain non-green candidate validation independently, form one tightly coupled unit, and pass only as a combined integration candidate.
Final acceptance rejects that unit, then another fresh assignment, scheduler dispatch, claim, supervised proposal, trusted patch, checkpoint, validation, review, and correction admission produces the accepted correction.
A final fresh unit races integration against a second `RepositoryOrchestrator` cancellation instance; cancellation remains blocked until the winning compare-and-swap commits, and the journal retains commit-before-cancellation order.
The installed package test projects every projectable event from the same database, compares every event identity, position, and digest through the packaged AgentTrail API, compares fleet state, and verifies the exported Markdown timeline.

## Security

The writer provider receives read permission only and explicit denials for edit, wildcard tools, and shell.
The trusted patch applier alone mutates claimed worktree paths.
The secret canary is absent from all six provider environments.
An overlapping claim is denied before provider launch.
Pod workspace branches remain ticket refs and never target `main` or the dedicated integration ref.
The repository scheduler keeps integration capacity at one.
AgentTrail warnings remain advisory with no authority.
Exact decision digests reject stale replans and final acceptance requires the committed unit.
Potentially effectful uncertain work is reconciled and never automatically redispatched.
Repository admission rejects active claims unless the exact completed worker receipt, dispatch binding, patch proposal, per-file trusted application, checkpoint usage, checkpoint diff, and source paths all match the admitted commit.
Scheduled writer claims use the exact scheduler `DispatchIntent.dispatchId`; standalone writers require explicit `unscheduled` authority and cannot satisfy repository admission.

## Commands

```bash
pnpm check
pnpm exec vitest run tests/conformance/three-pod
pnpm build
pnpm package:verify
pnpm agenttrail:verify
pnpm docs:codebase-map
```
