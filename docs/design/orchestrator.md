# General Agent Orchestrator Design

Date: 2026-07-11

Status: Approved design

## Purpose

This document defines a standalone orchestration platform for coordinating agent work across software-development projects.

The platform begins with software development and may later execute Zoe workflows for communication, meetings, personal operations, and devices.

Zoe is the first major client of the platform, not the owner of its generic scheduling and execution machinery.

## Product Decision

The platform uses a general orchestration kernel with a software-development capability package first.

It will not use a development-specific kernel that must later be replaced.

It will not implement every future Zoe workflow package in its first versions.

Every general abstraction must be exercised by the first software-development workflow.

## Product Boundary

### The Orchestrator Owns

- Goals, workflows, tasks, dependencies, and terminal outcomes.
- Agent and worker registration.
- Capability declarations and requests.
- Scheduling, leases, cancellation, and recovery.
- Resource, time, token, and cost budgets.
- Policy evaluation and approval requests.
- Artifact identity, provenance, and retention.
- Evidence collection and completion decisions.
- Project registration and project-specific adapters.
- Pod lifecycle and file ownership.
- Worktree creation and cleanup through the development package.
- Review assignment and integration queues.
- Quiet notifications and human escalation.

### Zoe Owns

- Voice interaction and wake behavior.
- Personal memory and context.
- User-facing personality and conversation.
- Attention preferences and personal routines.
- Email, meeting, calendar, contact, and personal-operation semantics.
- Translation between natural-language goals and typed orchestrator requests.

### Project Repositories Own

- Product source code and tests.
- Domain-specific plans and requirements.
- Project validation commands.
- Protected paths and ownership policy.
- Release and deployment rules.
- Project-specific secrets and capability allowlists.

## Core Principle

The orchestrator coordinates authority but does not possess unrestricted authority.

Reasoning does not grant execution permission.

Installing a plugin does not grant permission.

Receiving a message does not grant permission.

Human approval authorizes one exact, expiring operation rather than a reusable shell or standing privilege.

## Core Domain Model

### Goal

A goal is a user-desired outcome.

It contains identity, source identity, project or domain scope, policy context, budget, deadline, and success evidence requirements.

Examples include fixing a test failure, preparing a release, drafting an email, or scheduling a meeting.

### Workflow

A workflow is a versioned dependency graph for accomplishing a goal.

It contains tasks, transitions, gates, cancellation behavior, and completion rules.

The kernel does not assume that every workflow is a software-development pipeline.

### Task

A task is one schedulable unit of work.

A task contains:

- Stable identity.
- Goal and workflow identity.
- Inputs and expected outputs.
- Required capabilities.
- Dependencies.
- Budget and deadline.
- Retry and cancellation policy.
- Acceptance criteria.
- Evidence requirements.
- Current lifecycle state.
- Canonical terminal outcome.

### Agent

An agent is a reasoning participant with declared capabilities and limits.

An agent may plan, research, implement, test, review, integrate, summarize, or perform another declared role.

An agent's role does not grant direct host or external-system authority.

### Worker

A worker is the supervised process or remote node that hosts an agent or bounded capability runner.

Workers declare platform, available resources, isolation properties, supported harnesses, and health.

### Capability

A capability is one typed operation that policy may authorize.

Initial development capabilities include reading approved repository paths, creating worktrees, applying reviewed patches, running named validations, reading diffs, and submitting review artifacts.

Future capabilities may include reading one email thread, sending one approved message, creating one calendar event, or changing one approved device setting.

### Artifact

An artifact is a typed output with identity, provenance, sensitivity, retention, integrity, and validation state.

Development artifacts include patches, diffs, test reports, review reports, build artifacts, and integration receipts.

Future artifacts include email drafts, meeting transcripts, summaries, calendar proposals, forms, and device-action proposals.

### Evidence

Evidence is retained proof supporting a claim about task or workflow state.

Examples include test output, a build result, a review decision, an integrated commit, a delivery receipt, or a device acknowledgement.

Completion requires domain-appropriate evidence.

### Policy

Policy determines whether a typed operation may proceed under the current identity, project, data, budget, risk, and environment context.

Hard-denied actions cannot be enabled by approval, configuration, plugin behavior, or model output.

### Approval

Approval is a human decision bound to an exact action packet.

The packet includes identity, operation, target, inputs, expected effect, proposed state change, risk, mitigation or rollback, expiration, and single-use identity.

### Grant

A grant is an audience-bound, expiring, single-use authorization issued after policy and approval conditions are satisfied.

Grant consumption is immutable.

Execution lease state is separate from grant consumption.

### Lease

A lease is temporary ownership of a task, workspace, artifact, or capability execution.

It includes owner, scope, start time, expiry, heartbeat, cancellation state, and recovery behavior.

### Budget

A budget limits tokens, money, time, CPU, memory, network, retries, concurrent tools, and external effects.

Budgets are enforced by the orchestrator and constrained runners, not by agent promises.

### Event

An event is a versioned, append-only record of an accepted state transition or observation.

Events include identity, causation, correlation, provenance, timestamp, sensitivity, and payload schema version.

### Terminal Outcome

Every task reaches exactly one terminal outcome:

- `completed`
- `cancelled`
- `denied`
- `timed out`
- `failed`

Blocked, interrupted, awaiting approval, and process exited are lifecycle states or causes rather than terminal outcomes.

## Architecture

```text
CLI / Zoe / Issue Trackers / APIs
                |
                v
        Orchestrator API
                |
                v
       Durable Event Journal
                |
      +---------+----------+
      |                    |
      v                    v
Dependency Scheduler   Policy Plane
      |                    |
      v                    v
Pod Manager          Approval And Grants
      |
      v
Workspace And Worker Manager
      |
      v
Agents And Capability Runners
      |
      v
Artifacts, Tests, And Reviews
      |
      v
Integration Queues
      |
      v
Verified Project State
```

## Kernel Components

### Orchestrator API

The API accepts typed goals, status queries, cancellation, approvals, denials, project registration, and evidence retrieval.

Natural-language interpretation remains outside the kernel.

### Durable Event Journal

The event journal is the source of truth for workflow, task, lease, approval, grant, execution, artifact, and evidence transitions.

Indexes and dashboards are rebuildable projections.

### Dependency Scheduler

The scheduler selects work whose hard dependencies, readiness gates, policies, budgets, ownership constraints, and execution resources are satisfied.

Agent availability alone is not sufficient to make work ready.

### Pod Manager

The pod manager creates temporary outcome-oriented teams.

Each pod receives one charter, one measurable outcome, approved tickets, explicit ownership, budgets, and completion evidence requirements.

### Project Registry

The project registry stores repository identity, default and integration branches, validation commands, protected paths, issue tracker, policies, secret references, and package configuration.

### Workspace Manager

The development package uses the workspace manager to create, inspect, preserve, and remove isolated Git worktrees.

Write access is granted per ticket and path ownership contract.

### Agent Registry

The registry records agent role, harness, version, streaming, cancellation, session, approval, token, and tool-event capabilities.

Unsupported versions fail closed.

### Policy Plane

The policy plane evaluates typed action requests.

It does not issue grants, attest approvals, release secrets, or execute effects.

### Approval Broker

The approval broker presents an exact action packet and records the human decision.

It does not issue grants or execute the action.

### Grant Issuer

The grant issuer creates one-use, audience-bound authorization after policy and approval conditions pass.

### Secret Broker

The secret broker retains raw credentials behind handle-based operations.

Agents, plugins, and general workers do not receive reusable raw credentials.

### Capability Runners

Runners execute one bounded capability in a constrained environment.

They cannot choose policy, issue grants, or expand scope.

### Artifact Store

The artifact store retains typed outputs with provenance, sensitivity, integrity, retention, and validation metadata.

### Evidence Service

The evidence service records test, review, integration, delivery, and completion evidence.

It does not decide policy or execute effects.

### Resource Governor

The resource governor enforces concurrency, token, cost, time, CPU, memory, disk, network, retry, and external-effect limits.

### Notification Service

The notification service groups, deduplicates, ranks, and delivers attention items.

Individual agents do not independently interrupt the user.

### Integration Queue

Each project has an ordered integration queue.

The queue rebases, checks conflicts, runs focused and required full validation, integrates accepted changes, and retains post-integration evidence.

## Authority Separation

The following authorities remain pairwise separated:

- Work proposal.
- Policy decision.
- Approval attestation.
- Grant issuance.
- Secret release.
- Model transport.
- Host or external effect execution.
- Evidence retention.

No component may combine two high-risk authorities merely for convenience.

## Software-Development Package

The first capability package provides:

- Repository and project adapters.
- Git worktree lifecycle.
- Branch and diff inspection.
- File ownership and conflict detection.
- Ticket and issue import.
- Agent harness adapters.
- Named test, lint, build, and documentation checks.
- Code and specification review coordination.
- Integration queues.
- Pull request or local merge evidence.

## Pods

A pod is a temporary team responsible for one measurable outcome.

Typical roles include pod lead, research or design agent, implementation agent, test agent, and independent reviewer.

Researchers and reviewers normally use read-only access.

Implementation agents receive isolated worktrees and exclusive file ownership.

The integration controller alone updates the shared integration branch.

## Pod Lifecycle

```text
queued
  -> researching
  -> design ready
  -> ticket ready
  -> implementing
  -> testing
  -> reviewing
  -> integration ready
  -> merged
  -> verified
  -> closed
```

Pods may also become blocked, cancelled, superseded, or failed.

## Pod Charter

Every pod charter defines:

- Outcome.
- Source plans and tickets.
- Hard dependencies.
- Owned paths.
- Forbidden changes.
- Required capabilities.
- Acceptance criteria.
- Evidence requirements.
- Security boundary.
- Time, token, cost, and retry budgets.
- Escalation conditions.
- Completion and cleanup rules.

## Initial Development Workflow

The first end-to-end workflow is:

```text
Import one approved coding ticket
  -> Verify dependencies and policy
  -> Create one worktree
  -> Dispatch one implementation agent
  -> Run one focused validation
  -> Dispatch one independent reviewer
  -> Produce an integration-ready artifact
  -> Integrate through one queue
  -> Run post-integration verification
  -> Record evidence and terminal outcome
```

This workflow exercises every core abstraction without requiring broad personal-assistant scope.

## Initial Deployment

The first version is local-first and single-user.

It uses:

- One machine.
- One managed repository.
- A local daemon and CLI.
- SQLite or an equivalent embedded durable journal.
- Git worktrees.
- Existing coding harness adapters.
- Four to eight active agents.
- One integration queue.
- Explicit file ownership.
- Strict time, token, and cost budgets.
- No distributed cluster.
- No plugin marketplace.
- No autonomous external personal actions.

## Scaling Path

### Milestone 1: One Agent

Prove durable task state, one worktree, agent execution, cancellation, evidence, and restart recovery.

### Milestone 2: One Pod

Prove role separation, handoffs, ownership, testing, review, and integration.

### Milestone 3: Three Pods

Use eight to twelve agents to prove dependency scheduling, parallel worktrees, resource limits, and conflict prevention.

### Milestone 4: Multiple Projects

Add project isolation, per-project policy, per-project secret references, fair scheduling, and independent integration queues.

### Milestone 5: Twenty Agents

Prove backpressure, cost control, duplicate-work detection, quiet notifications, recovery, and review capacity.

### Milestone 6: Forty Agents

Prove worker failure isolation, high-volume event processing, integration throughput, human attention protection, and optional distributed execution.

### Milestone 7: Zoe Workflow Packages

Add communication, meetings, personal operations, and devices one package at a time.

Each package must satisfy the same capability, policy, approval, evidence, budget, cancellation, and recovery contracts.

## Future Capability Packages

### Communication

The communication package may read approved message scope, classify messages, draft replies, request approval, send approved messages, and retain delivery evidence.

### Meetings

The meeting package may prepare agendas, coordinate schedules, capture consent, transcribe approved meetings, extract proposed decisions, confirm ownership, and send approved follow-up.

### Personal Operations

The personal-operations package may research options, prepare forms, plan travel, manage subscriptions, coordinate household tasks, and request approval for consequential actions.

### Devices

The device package may inspect approved state, propose bounded changes, request local confirmation, execute constrained operations, verify acknowledgement, and reverse changes when possible.

## Concurrency Model

A fleet of 20 to 40 registered agents does not imply 20 to 40 concurrent writers.

Initial operating limits should be:

| Resource | Initial Limit |
| --- | ---: |
| Registered agents | 20-40 |
| Concurrent reasoning agents | 12-20 |
| Concurrent writers | 4-8 |
| Concurrent heavy validations | 2-4 |
| Integration operations | 1 |
| High-risk operations without approval | 0 |

Limits increase only after retained evidence demonstrates safe throughput.

## Scheduling Rules

A task may run only when:

- Every hard dependency is complete or contract-stable.
- Required decisions are approved.
- File and artifact ownership is available.
- Required capability and platform support exists.
- Policy permits the request.
- Budget and execution resources are available.
- The assigned workspace is valid.
- Acceptance and evidence requirements are explicit.

## Failure And Recovery

Worker failure preserves the worktree, event history, leases, artifacts, and last known evidence.

External or potentially irreversible effects are never retried automatically after an uncertain outcome.

Blocked pods release unused execution resources while retaining research and blocker evidence.

Conflicting pods pause until central ownership and dependency decisions resolve the conflict.

Orchestrator restart replays the journal, rebuilds projections, reconciles workers and workspaces, and marks uncertain effects for review.

## Observability

The platform records:

- Task and workflow state.
- Agent and worker health.
- Lease ownership and expiry.
- Queue depth and wait time.
- Tokens, cost, time, CPU, memory, disk, and network usage.
- Worktree and integration state.
- Test and review evidence.
- Cancellation acknowledgement.
- Approval and grant history.
- Failure and recovery events.

The user receives aggregated attention items rather than independent notifications from every agent.

## Primary Risks

### Scope Explosion

The orchestrator can become a meta-product that delays Zoe.

The first release must be judged by one integrated Zoe capability, not platform feature count.

### False Parallelism

Agent count can exceed the number of genuinely independent tasks.

The scheduler must optimize verified throughput rather than active sessions.

### Merge Bottlenecks

Parallel implementation can overload review and integration capacity.

Review and integration slots are scheduled resources.

### Context Fragmentation

Tasks can receive inconsistent repository revisions, plans, policies, or terminology.

Every ticket brief is versioned and tied to an exact project revision.

### Duplicate Work

Task claiming, ownership, and intent comparison prevent multiple pods from solving the same problem unknowingly.

### Dependency Deadlocks

The scheduler rejects cyclic workflow graphs and detects runtime waits that cannot progress.

### Unsafe Retries

The kernel distinguishes retryable computation from potentially irreversible effects.

### Security Concentration

The orchestrator coordinates authority but does not retain unrestricted repository, credential, device, or communication access.

### Plugin Supply Chain

Plugins require identity, signatures, version compatibility, capability declarations, reduced environments, resource limits, conformance tests, and revocation.

Installation grants no authority.

### Cross-Platform Differences

macOS, Windows, and Linux require platform-specific process, filesystem, terminal, sandbox, credential, and service conformance evidence.

### Cost Growth

Every pod and ticket has enforced monetary, token, time, and retry budgets.

### Alert Fatigue

Only the orchestrator ranks and escalates human attention.

## Success Measures

The development-first platform succeeds when it improves:

- Time from approved ticket to integrated verification.
- Percentage of agent changes accepted.
- Rework and discard rate.
- Merge-conflict rate.
- Test and review failure discovery time.
- Recovery after agent or orchestrator failure.
- Token and monetary cost per integrated outcome.
- Human interruptions per integrated outcome.
- Percentage of completion claims supported by retained evidence.

Agent activity and session count are not success measures.

## Initial Non-Goals

- Supporting every Zoe personal workflow.
- Running 40 concurrent writers.
- Distributed cluster operation.
- A public plugin marketplace.
- General host shell access.
- Autonomous email sending.
- Autonomous purchases or device changes.
- Replacing existing coding harnesses immediately.
- Building Zoe's native reasoning harness inside the orchestrator.

## First Delivery Sequence

1. Define the kernel state and event contracts.
2. Implement one durable local task lifecycle.
3. Register one software project.
4. Create and recover one Git worktree.
5. Run one existing coding harness under supervision.
6. Cancel one running task deterministically.
7. Run one named validation capability.
8. Produce one independent review artifact.
9. Integrate one accepted change through one queue.
10. Record one evidence-backed terminal outcome.
11. Repeat with one four-agent pod.
12. Expand to three concurrent pods only after the first path is reliable.

## Approval Record

The conversational design was approved on 2026-07-11.

Implementation planning requires a separate written-spec review and approval.
