# Zoe Plan And Ticket Governance

> This document is imported as a process reference from the Zoe planning corpus.
> Zentra should adapt its readiness gates and ticket paths after the local MVP proves the core task lifecycle.
> When this reference conflicts with the approved Zentra design or MVP plan, the Zentra documents govern.

## Purpose

This document defines the mandatory plan schema, conservative readiness decisions, measurable ticket decomposition, and publication controls for the Zoe future corpus.

Plans describe coherent future outcomes across the full phased destination, while ticket plans exist only when implementation can proceed without inventing material product, architecture, security, data, or validation requirements.

Readiness is an evidence-backed decision rather than a measure of a plan's importance or ambition.

## Required Plan Template

Every file under `future/plans/` must use this exact structure and preserve the field names and heading order.

```markdown
# NNN: Plan Title

- Horizon: immediate | near | mid | far | frontier
- Status: proposed | accepted | superseded
- Ticket readiness: research | design-needed | blocked | ticket-ready | scheduled
- Depends on: plan links or `none`
- Unlocks: plan links or `none`
- Related risks: risk identifiers or `none`

## Future Outcome
## Why This Matters
## Current Evidence
## Conceptual Increments
## Security And Privacy
## User Experience
## State And Data
## Failure Modes
## Validation
## Success Signals
## Ticket Readiness
## Open Questions
## Later Opportunities
```

Each section must contain a concrete statement, and `none` is permitted only where the template explicitly permits it and the absence is accurate.

`Current Evidence` must distinguish verified repository evidence, supported inference, and future direction.

When current implementation evidence does not exist, `Current Evidence` must explicitly state that the plan is vision-led and must not imply that target controls mitigate current Earshot behavior.

`Conceptual Increments` describes outcome-bearing increments rather than a horizontal inventory of components.

`Validation` must name an end-to-end path and the evidence needed to support a completion claim.

`Ticket Readiness` must state the current readiness state, explain why every stricter state is not yet justified, and identify the evidence or decision required for the next transition.

Plan status and ticket readiness are independent, so an accepted plan is not automatically `ticket-ready` and a scheduled plan remains subject to demotion when its basis changes.

## Readiness States

### `research`

Use `research` when the problem, evidence, feasibility, external contract, or safety model is not understood well enough to fix the implementation boundary.

A `research` plan may be strategically accepted, but it cannot have a ticket plan or imply implementation approval.

### `design-needed`

Use `design-needed` when the outcome is clear but material product, architecture, interface, ownership, security, privacy, data, failure, or validation decisions remain open.

A `design-needed` plan cannot be decomposed into implementation tickets because doing so would invent or prematurely freeze requirements.

### `blocked`

Use `blocked` when the plan is understood well enough to identify a prerequisite, but that prerequisite is absent, unstable, unverified, or unresolved.

The plan must name the exact blocking plan, contract, research result, decision, or external capability and the observable evidence that removes the block.

### `ticket-ready`

Use `ticket-ready` only when implementation can be decomposed without inventing requirements into measurable vertical slices or, only when a safe tracer bullet is impossible, into a narrowly approved horizontal prerequisite recorded in the source plan.

Measurable vertical slices remain the required default and preference.

The horizontal-prerequisite path is valid only when the source-plan decision contains the impossibility justification, smallest prerequisite boundary, measurable standalone acceptance, end-to-end verification evidence, and exact later vertical slice unlocked required by the tracer-bullet policy.

The outcome and boundaries must be approved, required predecessors must be complete or expose stable contracts, security and privacy constraints must be explicit, interfaces and data ownership must be sufficiently clear, important failure modes must be understood, measurable acceptance criteria must be writable, and an end-to-end verification path must exist.

No unresolved question may remain if its answer could materially change ticket scope, order, authority, data handling, rollback, or verification.

A ticket plan may be created only after the `ticket-ready` decision record is complete.

### `scheduled`

Use `scheduled` only when a `ticket-ready` plan has an approved measurable ticket plan and that work has been assigned to an explicit execution phase.

Scheduling does not mean that GitHub issues have been filed, implementation has started, or completion evidence exists.

## Readiness Decision Record

Every source plan must record its latest readiness assessment under its `Ticket Readiness` section.

### Established Readiness Reviewer Role

`Zoe corpus reviewer` is an established role fulfilled by a named human or an explicitly assigned agent instance performing corpus review.

The role is responsible for checking readiness-gate evidence against the cited source artifacts, retaining the reviewer's identity and review date, and producing auditable review output.

When separation between reviewer and approving owner is required, the `Zoe corpus reviewer` cannot self-approve a plan's transition to `ticket-ready` as its approving owner.

The assessment must use the following auditable gate evidence structure.

```markdown
### Readiness Gate Evidence

| Gate | Result | Exact evidence or concrete disposition | Reviewer or owner | Review date |
| --- | --- | --- | --- | --- |
| Outcome and boundaries approved | pass or fail | Exact evidence link or concrete disposition | Name or established role | YYYY-MM-DD |
| Predecessors complete or contracts stable | pass or fail | Exact evidence link or concrete disposition | Name or established role | YYYY-MM-DD |
| Interfaces and data ownership clear | pass or fail | Exact evidence link or concrete disposition | Name or established role | YYYY-MM-DD |
| Security and privacy constraints explicit | pass or fail | Exact evidence link or concrete disposition | Name or established role | YYYY-MM-DD |
| Important failure modes understood | pass or fail | Exact evidence link or concrete disposition | Name or established role | YYYY-MM-DD |
| Measurable acceptance criteria writable | pass or fail | Exact evidence link or concrete disposition | Name or established role | YYYY-MM-DD |
| End-to-end verification path exists | pass or fail | Exact evidence link or concrete disposition | Name or established role | YYYY-MM-DD |
| Delivery decomposition valid | pass or fail | Exact evidence for measurable vertical slices or the approved source-plan horizontal-prerequisite exception | Name or established role | YYYY-MM-DD |
| Material questions resolved | pass or fail | Exact evidence link or concrete disposition | Name or established role | YYYY-MM-DD |
```

Every gate must be marked `pass` or `fail`, and blank, unknown, partial, assumed, or inherited results are prohibited.

Evidence must identify exact plan sections, audit or risk records, approved decisions, stable contract records, validation designs, or other reviewable artifacts, while a failed gate must state the concrete unresolved disposition and what evidence would change it to `pass`.

The reviewer or owner and review date identify the real person or established role that evaluated that gate and the date of that evaluation, even when the result is `fail`.

Gate reviewers do not become approving owners merely by recording evidence.

A source plan can transition to `ticket-ready` only when every gate records `pass`, the delivery-decomposition gate proves either measurable vertical slices or the complete narrowly approved horizontal-prerequisite exception, and the following decision record is complete.

```markdown
- Approving owner: Name or role
- Decision date: YYYY-MM-DD
- Material questions resolved: Links or concise resolutions
- Execution phase: Required only for `scheduled`
```

The approving owner must be a real accountable person or established role with authority over the plan boundary, and the decision date must be the actual decision date.

`Material questions resolved` must link to or concisely record the disposition of every question that could alter ticket decomposition.

At `ticket-ready`, the `Execution phase` field must state that assignment is not required until scheduling and must not invent a phase.

At `scheduled`, the `Execution phase` field must name a real phase in the approved execution sequence.

Plans in `research`, `design-needed`, or `blocked` do not require an approving owner or decision date because no readiness approval has occurred.

Those fields become mandatory only when the plan transitions to `ticket-ready`, and they must never be populated with invented people, roles, dates, or administrative stand-ins.

## Readiness Transitions

Readiness may advance only one evidence-supported decision at a time, but it may move backward immediately when evidence, dependencies, or assumptions become invalid.

`research` may move to `design-needed` when evidence establishes a coherent outcome and boundary but material design decisions remain.

`research` or `design-needed` may move to `blocked` when a specific unmet prerequisite prevents further defensible progress.

`blocked` may return to `research` or `design-needed` only after evidence proves the named blocker is removed and the remaining uncertainty matches that state.

`research`, `design-needed`, or `blocked` may move to `ticket-ready` only after the source plan is assessed, every readiness gate records `pass`, the decomposition path is valid under the vertical default or narrow horizontal-prerequisite exception, and the approving owner, decision date, and material-question resolutions are recorded.

After the source plan becomes `ticket-ready`, a measurable ticket plan may be created from the approved outcome, boundaries, gate evidence, and decision record.

The ticket plan must then be reviewed for measurable tracer bullets or properly linked approved horizontal-prerequisite tickets, exact dependencies, risk links, security boundaries, acceptance criteria, end-to-end verification, retained evidence, failure and rollback behavior, documentation effects, and capabilities unlocked.

`ticket-ready` may move to `scheduled` only when the source plan remains `ticket-ready`, the measurable ticket plan has been reviewed and explicitly approved, and an execution phase is assigned and recorded in the source plan.

The lifecycle order is therefore source-plan assessment, `ticket-ready` decision, ticket-plan creation, ticket-plan review and approval, execution-phase assignment, and source-plan transition to `scheduled`.

A ticket plan is not required for transition to `ticket-ready` and is required for transition to `scheduled`.

Any state must be demoted when a predecessor becomes unstable, a material question reopens, an external contract proves unsupported, a security boundary weakens, or the verification path can no longer establish the outcome.

Demotion to `blocked` names a concrete prerequisite, demotion to `design-needed` names a material decision, and demotion to `research` names the missing evidence or feasibility result.

Superseding a plan stops readiness advancement for that plan and transfers no readiness decision automatically to its successor.

## Architecture Governance

Every plan and ticket must preserve the phased developer-agent wedge while remaining compatible with Zoe's broader communications, meetings, personal operations, device, cloud, and life or work destination.

Later breadth cannot block the wedge unless a documented dependency names the approving owner, security rationale, measurable exit criteria, and wedge behavior that cannot otherwise be delivered.

Compatibility harnesses must operate inside network-dark constrained capsules with reduced environments, isolated or overlay workspaces, no raw credentials, no direct network egress, bounded resources, and end-to-end cancellation.

Inference from a capsule must cross the credentialless local model-transport interface through a separately constrained model transport runner.

The native harness and compatibility harnesses remain unprivileged requesters and cannot own policy-decision, approval-attestation, grant-issuance, secret-release, model-transport, or host-effect execution authority.

Policy, approval, grant issuance, secret release, model transport, and host-effect execution remain pairwise-separated authority domains, and no component may combine two authority classes.

Typed patches, named test results, and evidence artifacts may enter Zoe's evidence store only through policy-admitted Level 2 ingestion with redaction, size, type, provenance, and cancellation-state validation.

Evidence ingestion receives no action grant because it changes neither a host workspace nor an external system.

Applying a patch, running a host test, copying an artifact to the host, or causing any other host-visible or external effect is a separate Level 3 or Level 4 action through a constrained capability runner.

Verification evidence must establish the relevant authority separation, ingestion boundary, cancellation behavior, terminal outcome, and failure-closed behavior rather than relying on a generated claim.

## Required Ticket-Plan Template

Every ticket in an approved ticket plan must use this exact structure and preserve the field names and order.

```markdown
### Ticket N: Measurable Vertical Slice

- Outcome: User-visible or system-verifiable result.
- Dependencies: Exact prior tickets or plans.
- Risks: Exact `RISK-###` identifiers.
- Security boundary: Authority and data constraints.
- Acceptance criteria: Observable pass conditions.
- Verification: Exact end-to-end path and evidence to retain.
- Failure and rollback: Expected safe behavior.
- Documentation: Exact files or `none` with reason.
- Unlocks: Exact next ticket or capability.
```

Each ticket must be the smallest coherent tracer bullet that crosses the real interfaces needed to produce its stated user-visible or system-verifiable result.

Acceptance criteria must identify observable states, thresholds, outputs, denials, or retained artifacts that can be checked without interpreting implementation intent.

Verification must exercise the exact end-to-end path, include relevant failure and cancellation behavior, and name durable evidence sufficient to support the outcome claim.

Dependencies must name exact prior tickets or plans rather than broad phases, and risks must use exact identifiers from `future/RISK_REGISTER.md` when applicable.

The security boundary must identify the requester, each authority owner involved, data that crosses each boundary, and the denied or failure-closed behavior.

Failure and rollback must preserve evidence, avoid automatic repetition of uncertain effects, and require a new classified action when cleanup or compensation needs authority.

## Tracer-Bullet Policy

Ticket plans must deliver vertical progress through Zoe's actual journey and must not decompose work into horizontal infrastructure tickets that leave unused schemas, stores, brokers, runners, adapters, or UI shells.

A safe tracer bullet should connect the minimum required observation or request, policy and authority decisions, execution or preparation boundary, outcome, and retained verification evidence.

Horizontal infrastructure is permitted only when a safe tracer bullet is impossible because the missing prerequisite itself must be established and verified before any end-to-end effect can be allowed.

The exception must be approved and recorded in the source plan's readiness decision under `Ticket Readiness` before the ticket plan is created.

That source-plan decision must state why every candidate tracer bullet would be unsafe or misleading, identify the smallest prerequisite boundary, define measurable standalone acceptance and end-to-end verification evidence, and name the exact later vertical slice it unlocks.

Every affected horizontal-prerequisite ticket must use `Dependencies` to link the exact source-plan exception decision and must restate its standalone acceptance criteria, end-to-end verification evidence, and exact vertical slice unlocked in the corresponding required ticket fields.

Convenience, team specialization, anticipated reuse, or architectural neatness is not sufficient justification for a horizontal ticket.

## Publication Policy

The future corpus may prepare approved ticket plans but cannot create GitHub issues without explicit user instruction.

No readiness state, execution-phase assignment, or ticket-plan approval implicitly authorizes issue publication.

Until explicit publication instruction is given, every ticket-plan index row must report GitHub issue status as `not filed` and must contain no issue identifier or issue URL.

Publication authorization is valid only when the instruction names the exact ticket-plan path or paths, exact ticket set and requested operation, exact target repository, and one execution.

An instruction that is stale relative to the approved ticket plan, omits any scope element, uses broad language such as publishing all ready work, or was already consumed does not authorize publication or any extra issue operation.

Every additional ticket, retry, repository, or create, close, reopen, edit, or transfer operation requires fresh explicit authorization with the same scope.

Later issue publication must preserve source plan links, exact risk links, dependencies, measurable acceptance criteria, the end-to-end verification path, and the evidence that execution must retain.

Publication must not widen scope, weaken authority boundaries, replace exact dependencies with labels, or convert unresolved questions into implementation assumptions.

## Publication Authorization Receipts

Every future issue operation requires a durable authorization and receipt record before any external call.

The receipt path convention is `future/ticket-plans/receipts/YYYY-MM-DD/<authorization-identity>--<execution-identity>.md`, where the date is the authorization decision date and both identities are immutable filesystem-safe identifiers.

No receipt is created during Task 6.

Every receipt must use this exact required field structure.

```markdown
# Issue Publication Receipt: Execution Identity

- Receipt path: Exact repository-relative receipt path
- Authorization identity: Immutable unique authorization identifier
- Authorizer: Name or established role
- Decision timestamp: ISO 8601 timestamp with timezone
- Target repository: Exact owner and repository name
- Ticket-plan paths: Exact repository-relative paths
- Ticket set: Exact ticket identifiers in ticket-plan order
- Operation: Exact create, close, reopen, edit, or transfer operation
- Execution identity: Immutable unique execution identifier
- Request fingerprint: Digest of repository, paths, ticket set, operation, and approved issue content
- Current state: authorized | consumed | started | reconciled | failed | recovery-required

## State History

| Timestamp | Prior state | New state | Actor | Durable evidence |
| --- | --- | --- | --- | --- |

## External Markers

- Pre-operation state evidence: Exact GitHub query evidence
- Request marker: Exact durable marker written before the external call
- Response identifiers: Exact returned issue identifiers and canonical URLs or `none` with reason
- Reconciliation evidence: Exact GitHub query evidence or `none` before reconciliation
- Index update evidence: Exact index revision or `none` before reconciliation
- Failure or uncertainty: Exact error and uncertainty boundary or `none`
- Recovery authorization: Fresh authorization identity or `none` when no retry is authorized
```

The receipt must be durably persisted in `authorized` state before the publication executor can begin.

The authorization scope in the receipt must exactly match the explicit human instruction, approved ticket-plan content, repository, ticket set, operation, and one execution.

The request fingerprint makes a stale or changed ticket plan ineligible for execution under that authorization.

Before the external call, the executor must durably append the irreversible `consumed` transition and then the `started` transition with the request marker.

The `consumed` transition occurs before, or in the same local durable transaction as, recording `started`, and it always precedes the external call.

No transition returns a receipt from `consumed`, `started`, `reconciled`, `failed`, or `recovery-required` to `authorized`, and no authorization identity or execution identity can be reused.

The allowed state transitions are `authorized` to `consumed` or `failed`, `consumed` to `started` or `recovery-required`, `started` to `reconciled`, `failed`, or `recovery-required`, and `recovery-required` to `reconciled` or `failed` after read-only reconciliation.

`authorized` means scope validation passed but the one-use authorization has not been consumed.

`consumed` means reuse is permanently prohibited whether or not an external effect occurred.

`started` means the durable request marker exists and the external operation may have begun.

`reconciled` means GitHub state, response identifiers, canonical URLs, and the local index agree with durable receipt evidence.

`failed` means durable evidence proves the operation cannot continue and records whether GitHub effects are absent or already reconciled.

`recovery-required` means a crash, timeout, partial response, or uncertain external result prevents the local index from proving a complete operation.

A crash after consumption, a missing response, or any uncertain or partial result must transition the receipt to `recovery-required` when execution resumes.

Recovery performs read-only GitHub queries using the target repository, request marker, ticket identities, content fingerprints, and any returned identifiers before any new external operation.

Recovery must record the observed GitHub state and transition the receipt to `reconciled` or `failed` only when the uncertainty is resolved.

The consumed authorization never permits a retry, compensation, or completion call, so every further external operation requires a fresh receipt with a fresh explicit authorization identity and execution identity.

## Issue Status Grammar And Reconciliation

The GitHub issue status column accepts only `not filed`, `filed: <canonical issue URL list>`, `closed: <canonical issue URL list>`, or `recovery required: <receipt path>`.

A canonical issue URL list contains one or more canonical URLs separated by comma followed by one space, with no other delimiter.

URLs appear in exact ticket-plan order, and each ticket appears once.

The `filed` prefix means every listed issue exists and is open or otherwise not closed, while the `closed` prefix means every listed issue is closed.

A canonical issue URL must use HTTPS, identify the authorized repository, identify one numeric issue, resolve successfully, and match the issue returned by the authorized operation.

GitHub and the local corpus cannot be updated atomically across systems.

After an external operation, receipt-driven reconciliation must prove the complete GitHub result before all affected index rows are updated together in one local change to `filed` or `closed`.

If a crash, partial operation, or uncertain result prevents that proof, every affected row must use `recovery required: <receipt path>` and must not list an inferred issue result.

The recovery status remains until read-only reconciliation completes, the receipt records `reconciled` or `failed`, and one local index change records the proven controlled status.

Status validation must reject noncanonical URLs, repository mismatches, duplicate URLs, missing issues, wrong URL order, noncanonical delimiters, unrecognized prefixes, receipt paths outside the convention, missing receipts, receipt scope mismatches, and a `filed` or `closed` value unsupported by the reconciled target issue state.

After publication, the ticket plan remains the governance source and any material issue change requires the corresponding readiness and dependency records to be reviewed.
