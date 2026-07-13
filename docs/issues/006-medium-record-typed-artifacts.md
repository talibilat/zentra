# 006 - Record Typed Artifacts

Severity: Medium.
Status: Open.
Execution wave: Wave 1, Pod B.
Suggested owner scope: Artifact contracts, task events, tracer evidence, integration receipts, and replay tests.
Dependencies: Issue 009.
Conflicts and serialization notes: Implement after issue 009 and preserve artifact path semantics that a future issue 005 enhancement can extend.

## Problem

The repository defines a typed artifact schema but the tracer stores a raw patch object inside a validation event and does not persist typed patch or integration receipt artifact events.
Consumers therefore cannot enumerate or replay artifacts through a stable artifact contract.

## Repository Evidence

`src/contracts/artifact.ts:3-10` defines artifact identity, task identity, kind, path, digest, and creation time for four artifact kinds.
`src/orchestration/tracer-bullet.ts:188-193` embeds `{ patch, diffSha256 }` in `task.validation_started` rather than appending a typed patch artifact event.
`src/orchestration/tracer-bullet.ts:357-365` and `src/orchestration/tracer-bullet.ts:413-417` persist receipt payloads in lifecycle events without a typed integration receipt artifact record.

## Failure Sequence Or User Impact

A consumer replays a task and asks for the patch, validation report, review report, and integration receipt artifacts.
The journal contains lifecycle-specific payload shapes rather than one validated artifact stream or event contract.
The consumer must know internal event payload details and cannot reliably verify artifact identity, location, digest, or kind.

## Acceptance Criteria

- [ ] Define explicit artifact-recorded event schemas for patch, validation report, review report, and integration receipt evidence.
- [ ] Persist stable artifact IDs, task IDs, kinds, safe logical paths, content digests, and creation timestamps at the point each artifact becomes durable.
- [ ] Bind artifact digests to the exact evidence consumed by validation, review, commit, integration, and completion.
- [ ] Rebuild an artifact view from journal replay without reading mutable worktree files.
- [ ] Reject duplicate identities, contradictory digests, out-of-order artifacts, and lifecycle events that reference missing artifacts.

## Required Tests

- [ ] Add contract tests for every artifact kind and malformed payload.
- [ ] Add tracer replay tests that enumerate all expected artifacts after completion and after each failure stage.
- [ ] Add tampered-journal tests for digest contradiction, missing artifact references, duplicate IDs, and invalid ordering.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Execute one complete tracer task and show that replay alone returns typed artifacts whose digests match the reviewed diff and completed receipt.
Confirm no artifact event depends on a mutable temporary path remaining present.

## Non-Goals

This issue does not introduce remote blob storage.
This issue does not persist unbounded stdout, stderr, or diff content.
This issue does not replace lifecycle events with artifacts.
