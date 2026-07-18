# Zentra And OpenCode Execution Model

Date: 2026-07-18

Status: Discussion draft

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

## Example Workflows

### Research

Zentra assigns one research task to an OpenCode worker.

The worker may inspect the repository, search documentation, browse approved web sources, and use internal research subagents.

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

The initial product should use OpenCode with Azure and should not require OpenRouter.

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

1. Define the exact observability contract for OpenCode internal subagents.
2. Define default web-research destinations and escalation behavior.
3. Define how Azure credentials and deployments are configured without reading OpenCode's private auth files.
4. Define which roles use one shared Azure deployment and which use specialized models.
5. Decide when evidence justifies building a native Zentra writer harness.

## Proposed Tickets

1. Define the generic OpenCode worker and internal-subagent execution contract.
2. Add role-based capability envelopes for research, writing, and review.
3. Add approved web research with source provenance and bounded network policy.
4. Replace the required OpenRouter path with Azure-only provider configuration.
5. Align installed milestone execution with OpenCode plus Azure for every role.
6. Add end-to-end research, implementation, independent review, and parallel-worker tests.
7. Run final Azure-authenticated package and Agent Trail conformance.

These tickets should be created only after this draft is approved.
