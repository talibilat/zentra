# Issue 103 Production Soak Harness

Date: 2026-07-22

## Boundary

`src/soak/soak-harness.ts` runs retained production conformance rather than a modeled queue simulation.
Each production wave invokes the same installed three-pod composition used by issue 101.
That composition traverses `JournalScheduler`, `DaemonScheduler`, `PodCoordinator`, `PathClaimService`, supervised deterministic provider processes, trusted patch application, `RepositoryOrchestrator`, `IntegrationQueue`, and AgentTrail fleet projection against a disposable real Git repository.
The soak control journal additionally dispatches one real supervised process for each of 20-40 unique registered worker identities through a 12-slot `JournalScheduler` and `DaemonScheduler` fleet probe.

## Profiles

The `ci` profile advances exactly 1,440 virtual ticks of 60 seconds each and runs two complete issue-101 production waves.
The `process` profile runs eight ticks, one complete production wave, 20 unique scheduler workers, and the complete real process fault boundary.
The `realtime-24h` profile is valid only with `realTime=true`, exactly 1,440 ticks, exactly 60,000 milliseconds per tick, and exactly 86,400,000 milliseconds of configured duration.
Only that profile can set `qualifying=true`.
Qualification additionally requires retained wall elapsed time and the sum of per-tick monotonic elapsed time to each reach at least 24 hours.
Accelerated profiles can prove behavior but can never constitute 24-hour qualification evidence.

## Durability

Every production wave, maintenance action, cursor rebuild, process fault batch, and periodic report checkpoint has a durable `soak.operation_intended` event before its effect and one `soak.operation_observed` event afterward.
Every tick is committed only after scheduled operations and its periodic report checkpoint settle.
An effect published before process death is recognized from its retained child report, archive anchor, prune audit event, maintenance audit event, or checkpoint file and is observed as recovered rather than repeated.
The abrupt crash test kills four separate harness processes with `SIGKILL` after production-wave, archive, prune, and vacuum effects.
Fresh processes resume the same run and prove zero repeated effects.

The control journal is read and digested in bounded pages.
Tick events retain only one bounded sample and never embed accumulated state or prior samples.
Periodic signed checkpoint reports are immutable bounded files under `checkpoints/`.
Archive segments are limited to 2,000 events, below the hard 10,000-event range.

## Real Faults

Worker, daemon, sidecar, and service crash fixtures terminate themselves with `SIGKILL` and are followed by separately supervised replacement processes.
A real validator process delays before returning green evidence.
A real in-flight worker is cancelled through `AbortSignal` and process-group termination.
The process supervisor proves its output byte limit with a child attempting oversized output.
A bounded real disk-pressure file is written and retained with its byte size and SHA-256.
The issue-101 wave performs real path-claim contention, real Git conflict and replacement, worker-effect reconciliation, cancellation, candidate validation, serialized integration, and main-ref preservation.
The control projection intentionally lags a durable cursor and rebuilds it in bounded pages before prune.
Archive, explicit prune, WAL checkpoint, backup, and bounded vacuum use `JournalRetentionService` directly.

## Measurements And SLOs

Each tick samples actual process RSS, heap usage, filesystem used bytes, retained scheduler queue evidence, process output bytes, PID, wall time, and monotonic elapsed time.
The report streams aggregates from paged journal history rather than retaining sample arrays.
Capacity peaks come from scheduler resource acquisition and release events plus issue-101 wave reports.
Worker uniqueness comes from actual master scheduler task inputs and is cross-checked through the control AgentTrail projection.

SLO results retain observed values, limits, pass/fail decisions, and exact evidence event IDs.
They cover tick completeness, bounded capacities, queue depth, recovery deadlines, all configured fault outcomes, every production boundary, 20-40 unique scheduler workers, RSS, heap, process output, disk pressure, host continuity, security, and qualifying elapsed time.
Safety evaluation derives duplicate trusted patch or integration effects, green candidate evidence, serialized integration capacity, main-ref identity, provider secret/tool denials, scheduler-to-writer dispatch authority, AgentTrail warning authority, shell use, and secret inheritance from retained evidence.

## Signatures And Digests

The harness never generates or trusts its own signing identity.
The operator supplies a canonical mode-`0600` Ed25519 private key and a separately trusted SHA-256 digest of its public key.
The frozen configuration retains that trusted digest.
The final report contains the public key, report digest, and signature.

`verifySoakReport` does not trust digest fields from the report.
It rereads the authoritative journal in bounded pages, recomputes the journal digest, recomputes every retained evidence-file digest, recomputes all AgentTrail projection file digests, recomputes archive segment and manifest digests, checks the externally supplied public-key digest, rebuilds the unsigned report digest, and then verifies the Ed25519 signature.

## Verification Profiles

```bash
pnpm exec vitest run tests/soak/soak-harness.test.ts
pnpm check
pnpm build
pnpm docs:codebase-map
```

The focused suite includes the accelerated 1,440-tick two-wave profile, a four-point real `SIGKILL` crash matrix, a short real-process profile, strict real-time schema validation, and post-signing report tamper rejection.

## Qualifying Run

Prepare a dedicated canonical output directory and a preconfigured Ed25519 key outside that output directory.
Compute and independently record the public-key SHA-256 with `trustedSoakPublicKeySha256` before launch.
Build the exact source revision first.

```bash
pnpm build
pnpm soak:run -- \
  --profile realtime-24h \
  --output /absolute/canonical/zentra-soak-103-qualifying \
  --seed issue-103-qualifying-v2 \
  --workers 40 \
  --signing-key /absolute/canonical/operator-soak-ed25519.pem \
  --trusted-public-key-sha256 <independently-recorded-64-hex-digest>
```

The frozen config path is `/absolute/canonical/zentra-soak-103-qualifying/soak-config.json`.
The periodic checkpoint directory is `/absolute/canonical/zentra-soak-103-qualifying/checkpoints`.
The final report path is `/absolute/canonical/zentra-soak-103-qualifying/soak-report.json`.
The authoritative journal path is `/absolute/canonical/zentra-soak-103-qualifying/soak.sqlite`.

Resume the exact run after interruption with the same build, directory, seed, worker count, key, and trusted digest.

```bash
pnpm soak:run -- \
  --profile realtime-24h \
  --output /absolute/canonical/zentra-soak-103-qualifying \
  --seed issue-103-qualifying-v2 \
  --workers 40 \
  --signing-key /absolute/canonical/operator-soak-ed25519.pem \
  --trusted-public-key-sha256 <independently-recorded-64-hex-digest> \
  --resume
```

Exit code `0` means every SLO passed and, for the real-time profile, both elapsed-time gates passed.
Exit code `1` means a completed run failed qualification.
Exit code `2` means a valid interrupted run wrote a signed running report and remains resumable.

No uninterrupted wall-clock 24-hour run is claimed by this implementation.
