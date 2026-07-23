# UI, AgentTrail, And Soak Testing

## Current Connection

The local Zentra UI is connected to AgentTrail.
The 24-hour soak harness is not connected to that live UI.

These paths use different runtime stores.

| Path | Journal | AgentTrail data |
| --- | --- | --- |
| `zentra start` | `<project>/.zentra/events.sqlite` | `<project>/.zentra/traces/*.jsonl` |
| `pnpm soak:run` | `<output>/soak.sqlite` | `<output>/*agenttrail*projection.json` |

`zentra start` supervises the AgentTrail web process.
It embeds that process at `/agenttrail/`.

The soak harness calls `projectAgentTrailFleet` directly.
It writes static projection JSON files.
It does not start the AgentTrail web process.
It does not publish into `.zentra/events.sqlite`.

## Can I Watch The UI During A 24-Hour Run?

You can keep the normal UI open.
It will not show the soak run.
It will show only the project service journal.

Starting a second `zentra` command does not attach the soak.
The soak is a separate process and data root.

Use the soak output files for current monitoring.

## Run The UI

From a trusted Git project:

```bash
zentra start
```

From outside that project:

```bash
zentra start --project /absolute/path/to/project
```

Keep the command running.
Use the printed session URL.

The UI shows:

- Workflow runs and lifecycle state.
- Terminal outcomes.
- Source identity and provenance.
- Analysis rounds and questions.
- Plan DAGs.
- Authority envelopes.
- Readiness and approval state.
- Pending operator decisions.
- Decision history.
- AgentTrail graph, tree, swimlane, sequence, playback, and live event views.

The UI does not show soak SLOs today.

## Run The 24-Hour Soak

The soak runs only from the Zentra source checkout.
Build the exact revision first.

Create a dedicated output directory.
Use a canonical absolute path.

Prepare an Ed25519 private key with mode `0600`.
Keep it outside the output directory.

Compute the trusted public-key digest independently.
The library helper is `trustedSoakPublicKeySha256`.

Run:

```bash
pnpm build
pnpm soak:run -- \
  --profile realtime-24h \
  --output /absolute/canonical/zentra-soak \
  --seed zentra-qualifying-v2 \
  --workers 40 \
  --signing-key /absolute/canonical/operator-soak-ed25519.pem \
  --trusted-public-key-sha256 <64-lowercase-hex-digest>
```

The qualifying profile uses 1,440 real one-minute ticks.
It requires at least 24 hours of wall time.
It also requires 24 hours of monotonic tick time.

Exit codes:

- `0` means every qualification gate passed.
- `1` means the completed run failed a gate.
- `2` means the run was interrupted and is resumable.

Resume with the same build and options:

```bash
pnpm soak:run -- \
  --profile realtime-24h \
  --output /absolute/canonical/zentra-soak \
  --seed zentra-qualifying-v2 \
  --workers 40 \
  --signing-key /absolute/canonical/operator-soak-ed25519.pem \
  --trusted-public-key-sha256 <64-lowercase-hex-digest> \
  --resume
```

## Monitor The Soak Today

The process writes a final JSON line when it stops.
Long-running progress is retained in the output directory.

Important paths:

| Path | Content |
| --- | --- |
| `soak-config.json` | Frozen run configuration. |
| `soak.sqlite` | Authoritative control journal. |
| `checkpoints/report-*.json` | Signed progress checkpoints. |
| `soak-report.json` | Signed running or final report. |
| `agenttrail-control-projection.json` | Final control-fleet projection. |
| `waves/wave-*/three-pod.sqlite` | Per-wave journal. |
| `waves/wave-*/three-pod-conformance-report.json` | Per-wave conformance report. |
| `waves/wave-*/agenttrail-projection.json` | Per-wave AgentTrail fleet projection. |

Real-time checkpoints are written every five ticks.
That is about every five minutes.

The current checkpoint is intentionally small.
It contains:

- Tick number.
- Configuration digest.
- Control stream version.
- Prior event identity.
- Host evidence.
- Checkpoint digest.
- Signature.

The final report contains:

- Qualification status.
- Build and host identity.
- Completed ticks and elapsed time.
- Registered and unique worker counts.
- Production-wave completion.
- Capacity peaks and queue depth.
- Fault outcomes and recovery timing.
- Memory, disk, and process-output peaks.
- Archive, prune, and vacuum evidence.
- Projection lag and rebuild status.
- Attention items and bottlenecks.
- Every SLO result.
- Safety violations.
- Evidence-file digests.
- Journal and AgentTrail digests.
- Public key and report signature.

The control AgentTrail projection is written at full completion.
Per-wave AgentTrail projections appear after each production wave.

## Connect The Soak To The UI

This requires a product change.
Do not point the current UI at `soak.sqlite` directly.
Its APIs expect workflow-run projections, not soak projections.

A clean connection needs these parts:

1. Add a read-only soak projection service.
2. Read `soak.sqlite` through the archived journal adapter.
3. Expose bounded soak status and SLO endpoints.
4. Stream new soak positions through a read-only event endpoint.
5. Render a dedicated soak panel in the operations UI.
6. Convert projectable soak events into AgentTrail JSONL.
7. Serve that trace through a separate AgentTrail instance or trace selector.
8. Keep the soak journal authoritative.
9. Verify resume, archive, prune, and projection-lag behavior end to end.

The first useful UI slice should show:

- Current tick and elapsed time.
- Last signed checkpoint.
- Active operation.
- Worker and capacity counts.
- Queue depth.
- Latest fault and recovery result.
- Memory and disk peaks.
- Projection lag.
- Current SLO pass or fail state.
- Links to per-wave evidence.

This bridge should remain read-only.
It must not grant soak control authority through AgentTrail.
