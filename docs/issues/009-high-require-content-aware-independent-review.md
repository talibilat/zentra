# 009 - Require Content-Aware Independent Review

Severity: High.
Status: Open.
Execution wave: Wave 1, Pod B.
Suggested owner scope: Reviewer protocol, CLI reviewer configuration, review evidence, and fail-closed defaults.
Dependencies: None.
Conflicts and serialization notes: Implement and integrate issue 009 before issue 006, use one Pod B writer for shared tracer evidence files, and serialize any shared CLI composition file with the active packaging writer.

## Problem

The deployable CLI uses fixed worker and reviewer identities and a bundled reviewer that approves solely because those identities differ.
The reviewer process receives hashes and identities but not the bounded diff or validation evidence needed to assess content.

## Repository Evidence

`src/reviews/reviewer-adapter.ts:101-118` invokes the reviewer with only diff digest, validation digest, worker ID, and reviewer ID.
`fixtures/deterministic-reviewer.mjs:54-64` approves when worker and reviewer identities differ and does not inspect code or validation content.
`src/cli/main.ts:28-30` fixes the worker and reviewer identities, and `src/cli/main.ts:324-335` always composes the bundled deterministic reviewer for task execution.

## Failure Sequence Or User Impact

A worker produces a dangerous or incorrect diff that still passes focused validation.
The bundled reviewer receives valid digests and two different fixed identities.
It approves without reading the diff or validation evidence.
Zentra presents the result as independently reviewed and proceeds toward integration despite no substantive review.

## Acceptance Criteria

- [ ] The deployable CLI defaults to deny when no content-aware reviewer is configured.
- [ ] The independently identified reviewer receives the bounded exact diff and bounded validation evidence through standard input rather than command-line arguments.
- [ ] The reviewer returns an explicit content-based decision bound to the exact diff and validation evidence digests.
- [ ] Reviewer output is strictly bounded, schema validated, single-decision, and fails closed on timeout, truncation, malformed content, or evidence-digest mismatch.
- [ ] The deterministic identity-only reviewer remains test-only and cannot be selected accidentally in a production package.

## Required Tests

- [ ] Add CLI end-to-end tests proving missing reviewer configuration denies execution before commit or integration.
- [ ] Add reviewer protocol tests for actual diff inspection, stdin bounds, evidence-digest mismatch, timeout, malformed output, and same-identity denial.
- [ ] Add an adversarial diff that passes focused validation but is denied by a configured content-aware reviewer.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Inspect the packed tarball and verify the production CLI cannot silently use the deterministic reviewer fixture.
Run a complete task with no reviewer and with a configured reviewer and verify deny-by-default and content-bound approval behavior.

## Non-Goals

This issue does not prescribe a particular model vendor or review implementation.
This issue does not let reviewer reasoning grant execution authority beyond returning a bounded decision.
This issue does not remove digest verification or worker-reviewer identity separation.
Authenticated external reviewer protocols, cryptographic challenges, signing, and broader anti-replay design are separate future work and are not acceptance scope for this issue.
