# Zentra And OpenCode Execution Model

Date: 2026-07-18

Status: Approved

## Decision

Zentra is the trusted control plane.

OpenCode is the primary agent harness.

Azure is the initial model provider.

Agent Trail is the read-only observability layer.

Zentra should not replace OpenCode's reasoning, exploration, coding, or tool loop.

## Responsibilities

Zentra owns:

- Goals, plans, tasks, dependencies, and role assignment.
- Permissions, budgets, deadlines, and concurrency.
- Worktrees, file ownership, validation, review, and integration.
- Durable events, evidence, recovery, and terminal outcomes.
- Decisions about when a top-level OpenCode worker may start.

OpenCode owns:

- Reasoning and task decomposition inside the assigned task.
- Repository exploration and context gathering.
- Approved web research and other approved tool calls.
- Coding and iteration inside an assigned worktree.
- Internal subagents that remain inside the same capability envelope.

Azure owns model inference, quotas, and billing.

Agent Trail visualizes accepted Zentra events and never grants authority.

## Permission Model

The guiding rule is broad permission to learn and narrow permission to cause effects.

Research agents should normally receive broad repository read access, search tools, and approved web access.

Writer agents should receive broad read access but write access only inside their assigned worktree and owned paths.

Reviewer agents should receive the exact diff and evidence with no writer authority.

Validation and integration remain Zentra-controlled capabilities.

OpenCode should not request approval for every safe read or search operation.

Zentra grants a task-scoped capability envelope before execution and records tool observations against that envelope.

An operation outside the envelope must stop, request escalation, or trigger bounded replanning.

## Agent And Subagent Rules

Zentra launches each top-level OpenCode worker that owns a durable task, worktree, or review responsibility.

OpenCode may use internal subagents when they inherit equal or narrower permissions, share the parent task budget, and remain observable.

An internal subagent must not create a new worktree, expand file scope, obtain secrets, or perform external effects independently.

Independent implementation, review, or conflicting ownership requires separate Zentra-managed OpenCode workers.

## Worker Contract Decisions

The durable kernel uses harness-neutral `worker.*` events rather than OpenCode-native event names.

Every top-level worker and descendant for one root task shares one deterministic `worker-task:<rootTaskId>` stream.

Optimistic concurrency on that stream serializes parent state, descendant binding, active-worker and activity reservations, usage, cleanup, uncertainty, and terminal transitions.

The binding records worker identity, task identity, `parentWorkerId: null`, harness, role, model capability and transport identity, capability-envelope digest, shared budget identity and limits, and trace and correlation identity.

The lifecycle is `worker.bound`, `worker.started`, zero or more `worker.observed` events, `worker.cleanup_observed`, and exactly one canonical `worker.terminal` outcome.

Accepted terminal outcomes remain `completed`, `cancelled`, `denied`, `timed_out`, and `failed`.

The event journal remains the source of truth, and the worker projection is rebuilt by replay after restart.

Every append is validated against the complete durable projection before persistence.

Internal OpenCode agents use the same lifecycle with a non-null parent worker identity.

A nested agent must reference an existing nonterminal parent, stay in the same task and trace, use the same root task budget identity, and receive equal or lower limits.

Worker envelopes use closed role, authority, capability, network, secret, effect, repository-resource, and logical-path schemas.

Nested authorities and capabilities must be subsets of the parent's envelope, logical paths must be semantically contained by a parent scope, and inherited forbidden paths cannot be removed.

Authority uses an explicit partial order rather than a privilege rank.

Independent categories such as `review` and `workspace_write` are incomparable, and a child may normally retain its authority or narrow to `read_only` with a matching role and capability set.

Network authority may remain equal or narrow from `model_provider_only` to `denied`.

Repository authority may remain equal or narrow from `assigned_worktree` to `read_only` or `none`, or from `read_only` to `none`.

Inherited assigned-worktree authority requires the exact parent path scope plus matching read, write, resource, and worktree-effect fields.

Nested agents cannot independently receive worktree creation, path expansion, secret acquisition, integration, release, or external-effect capabilities.

Tool and model observations are accepted only for measured activity with explicit start reservations and completion usage.

Model turns, tool calls, input tokens, output tokens, cost, elapsed time, active workers, concurrent tools, and concurrent model turns are charged to the shared root task budget.

Process and resource observations are separate from model and tool usage and never fabricate token, cost, turn, or call measurements.

A terminal event is accepted only after cleanup evidence.

Completed cleanup requires every tool and model reservation to have a measured completion and all activity counters to be zero.

Uncertain cleanup retains unresolved reservations and worker uncertainty.

Cleanup reconciliation does not authorize redispatch, and any retained worker identity blocks a second OpenCode execution until a future explicit effect-reconciliation contract authorizes it.

Unknown parents, self-cycles, duplicate worker identities, authority expansion, budget overrun, unsupported delegation, missing observations, and post-terminal events fail closed.

OpenCode parsing and translation are isolated in `OpenCodeWorkerEventAdapter`.

Local inspection on 2026-07-21 identified the canonical installed OpenCode executable as version `1.18.3` and SHA-256 `43f7083d450567706a80b6441331a25b5ed6d6c9f742826790545b068229cbb2`.

The externally signed negative `1.18.3` report remains retained as the genuine v2 journal fixture `tests/fixtures/retained-opencode-subagent-v2.sqlite.fixture` and in the approved temporary evidence journal `zentra-issue-104-subagent-probe-v2-final.sqlite`.

OpenCode release `1.18.3` is source revision `127bdb30784d508cc556c71a0f32b508a3061517`.

Its Task tool creates a child session with `parentID`, returns parent and child session IDs in tool metadata, and cancels a foreground child when the foreground Task call is interrupted.

It also supports experimental background subagents and task-ID session resumption.

Those mechanisms are OpenCode session lifecycle features rather than a stable Zentra execution protocol.

The `run --format json` implementation filters message-part events to the root session, so it does not expose a complete attributed child event stream to the supervising Zentra process.

The Task tool does not carry Zentra task, worker, or process-incarnation identities.

It does not bind child sessions to the parent's Zentra authority and path claims, shared task budget and resource reservations, at-most-60-second heartbeat, canonical terminal outcome, descendant-process absence proof, or restart reconciliation decision.

OpenCode's `deriveSubagentSessionPermission` preserves parent deny and external-directory rules but otherwise delegates capability selection to the configured subagent.

That is useful OpenCode policy behavior, but it is not proof of Zentra envelope containment.

Background child lifecycle and task-ID resumption also do not prove cancellation propagation or no-retry handling after an uncertain effect.

Zentra therefore defines `zentra.opencode-native-subagents.v2` with these mandatory contracts:

- Stable parent and child identity.
- Exact Zentra task, worker, and process-incarnation mapping.
- Inherited and non-expanded authority and logical path claims.
- Shared budget and resource accounting.
- Matching journal and AgentTrail attribution.
- An active heartbeat no more than 60 seconds apart.
- Parent cancellation propagation.
- Process-group and descendant cleanup evidence.
- Restart reconciliation without implicit redispatch.
- Exactly one canonical terminal outcome.
- No automatic retry after an uncertain effect.

Every contract requires one explicit observation with references to retained command or source-attestation evidence.

Observations use `supported`, `not_observable`, or `unsupported` rather than claiming that an unexecuted native lifecycle check failed.

Missing, duplicate, unsupported-version, changed-version, source-revision, executable-identity, executable-digest, noncanonical-path, incomplete, or truncated evidence fails closed.

The trusted identity fixes the canonical executable path, executable SHA-256, version, and source revision before probing.

The probe rejects a different executable before spawning it even when that executable prints `1.18.3`.

When the exact canonical path remains attested but its digest has drifted, the probe executes only bounded `--version` identity evidence.

It records the supported expected path, digest, version, and source revision together with the observed digest and version, classifies the capability as `denied` with `version_drift` when applicable, and does not execute or claim lifecycle capability evidence from the unsupported binary.

The probe invokes the canonical executable directly with `shell: false`, a minimal environment, bounded output, bounded deadlines, and no credential values.

Only after the complete reviewed executable and source identity matches does it sequentially retain raw output, byte counts, SHA-256 digests, exit status, and argv for root help, debug help, run help, pure resolved configuration, agent inventory, primary and subagent tool inventories, session help, and server help in addition to `--version`.

The pure configuration must report an empty plugin list.

The source attestation binds release revision `127bdb30784d508cc556c71a0f32b508a3061517` to the inspected Task tool, subagent-permission, session, JSON-run, and session HTTP API implementation paths.

The experimental HTTP API exposes session status, child listing, and abort routes at API version `0.0.1`.

Those routes do not expose Zentra identity, shared budgets, heartbeats, cleanup proof, reconciliation, or canonical child terminal outcomes.

No stable native child-lifecycle conformance endpoint is exposed by the command, debug, session, or server surfaces.

Parent and child session identity is source-attested as supported.

The other ten contracts are classified as `not_observable` or `unsupported`, so the feature is denied without inventing runtime failures.

The executable is digested before and after invocation.

The operator supplies a private Ed25519 key from a canonical, bounded, owner-private file.

The complete report digest and signature cover the probe and project identities, executable identity, source revision, every raw command evidence record, every observation, and the terminal denial.

New probe reports use strict report and journal schema v3.

The retained v2 schema is separately strict and exactly matches the signed `1.18.3` evidence: it has the original four-path source attestation and does not add `expectedExecutable`, `capability`, or `classification` to the signed payload.

Verification selects the unsigned canonical payload by the signed report version, recomputes its report and command-evidence digests, and verifies its Ed25519 signature against the configured trusted signer digest.

Unknown report and journal versions fail closed.

Verification requires the expected public-key SHA-256 or a configured trust store.

An embedded public key never establishes trust by itself.

The operator entrypoint pins the exact canonical executable, version, digest, and source revision instead of accepting caller-defined expected identities.

After `pnpm build`, operators run `node scripts/probe-opencode-subagents.mjs` with the exact executable, canonical working directory and home, journal database, retained report path, project and probe identities, private signing key, and trusted public-key digest.

The journal rejects reports whose signed project or probe identity differs from the target stream.

It atomically records the complete signed report under `subagent.capability_probe_observed` and `subagent.capability_denied`.

An exact retry replays the retained pair without duplication, while a different report for that probe identity is rejected.

AgentTrail accepts only strict v2 and v3 journal evidence.

Its versioned public denial projection preserves the signed report digest, trusted signer digest, report schema version, evidence aggregate digest, and exact probe and project identity without projecting raw command output.

The projection classifies retained v2 evidence as `legacy_v2` and `legacy_retained_denial`; these public fields are not inserted into or used to reinterpret the original signed payload.

Fixture evidence can prove the generic positive and negative contracts but is explicitly ineligible to enable production tools.

The retained externally signed `1.18.3` report is negative, so there is no production enablement path for this provider revision.

Closure also requires signed drift denial, positive and negative fixtures, and the continued absence of any production enablement path.

Production OpenCode configurations therefore keep the `task` tool denied.

Any measured `task` or `subagent` tool event fails explicitly, and Zentra does not claim production OpenCode nested-agent support.

The generic nested contract is exercised with harness-neutral fixtures until OpenCode provides a stable observable protocol.

The existing planner, researcher, writer, and reviewer journals and APIs remain intact while their executions also emit generic worker streams.

Agent Tail projects generic workers as actor-specific spans, with nested workers parented to the worker that delegated them.

The typed `web_research` capability and declared-web-research network mode are admitted only for planner and researcher tasks with exact security-sheet HTTPS destinations.

OpenCode uses one local MCP tool inside the network-dark capsule, and Zentra brokers each typed request through the host policy boundary.

Native OpenCode web tools and internal subagents remain denied because OpenCode 1.18.3 does not provide the complete stable lifecycle, budget, and provenance observations required by Zentra.

Web research source evidence is journaled by digest and provenance without raw response content or query values.

Azure provider configuration is strict, host-brokered, and deployment-bound for read-only roles.

## Example Workflows

### Research

Zentra assigns one research task to an OpenCode worker.

The worker may inspect the repository, search documentation, and browse approved web sources.

Native internal research subagents remain denied for OpenCode `1.18.3`.

The worker returns findings with source and provenance evidence.

### Implementation

Zentra creates an isolated worktree and assigns owned paths to one OpenCode writer.

The writer explores broadly but edits only its assigned scope.

Zentra runs configured validation after the writer finishes.

A separate OpenCode reviewer evaluates the exact diff and validation evidence.

Zentra alone integrates an approved result through the validated integration queue.

### Parallel Work

Zentra may launch multiple OpenCode writers when dependencies are ready and owned paths do not overlap.

Each writer receives a separate worktree, budget, capability envelope, and trace identity.

Integration remains serialized.

## Harness And Provider Strategy

OpenCode and Azure are complementary rather than competing choices.

OpenCode provides the agent loop and coding tools.

Azure provides the selected models.

The initial product uses OpenCode with Azure and does not admit alternate provider configuration.

Future harness adapters may support Codex, Claude Code, and other agent runtimes.

Future provider adapters may support direct API users who do not install an external harness.

A native Zentra harness may be added later for narrow API-only roles, but it is not the current priority.

## Security Boundary

Reasoning never grants authority.

OpenCode installation or authentication never grants repository, network-tool, secret, integration, or release authority by itself.

Host OpenCode provider transport uses the user's operating-system network authority in Trusted-Project mode and is not a network sandbox.

Raw credentials must not enter prompts, worker environments, journals, or Agent Trail.

Potentially effectful uncertain operations must never be retried automatically.

## Open Decisions

1. Define default web-research destinations and escalation behavior.
2. Define how Azure credentials and deployments are configured without reading OpenCode's private auth files.
3. Define which roles use one shared Azure deployment and which use specialized models.
4. Decide when evidence justifies building a native Zentra writer harness.

## Proposed Tickets

1. Define the generic OpenCode worker and internal-subagent execution contract.
2. Add role-based capability envelopes for research, writing, and review.
3. Add approved web research with source provenance and bounded network policy.
4. Establish Azure-only provider configuration.
5. Align installed milestone execution with OpenCode plus Azure for every role.
6. Add end-to-end research, implementation, independent review, and parallel-worker tests.
7. Run final Azure-authenticated package and Agent Trail conformance.

These tickets should be created only after this draft is approved.
