# Zoe Client Context

## Relationship

Zoe is Zentra's first major client.

Zentra owns generic orchestration, scheduling, workers, capabilities, artifacts, evidence, project isolation, reviews, and integration queues.

Zoe owns voice interaction, personal memory, user-facing conversation, attention preferences, and domain semantics for communication, meetings, personal operations, and devices.

## Initial Integration

The first Zentra MVP does not integrate with Zoe at runtime.

It proves a local software-development workflow using deterministic worker and reviewer fixtures.

After that path is reliable, Zoe may submit typed development goals and query task, pod, evidence, approval, and attention state through a narrow API.

## Long-Term API Direction

Expected operations include:

- Register and inspect projects.
- Submit typed goals.
- Query workflows, tasks, pods, and evidence.
- Cancel tasks and workflows.
- Approve or deny exact action packets.
- Pause a project.
- Retrieve ranked attention items.

Natural-language interpretation remains in Zoe.
Zentra receives typed requests rather than unrestricted conversational authority.

## Shared Contracts

- Agent roles do not grant execution authority.
- Policy, approval, grant issuance, secret release, model transport, and effect execution remain separated.
- Every task ends in `completed`, `cancelled`, `denied`, `timed_out`, or `failed`.
- Awaiting approval, interruption, and process exit are lifecycle states or causes.
- Potentially irreversible uncertain effects are never retried automatically.
- Completion requires retained evidence rather than an agent claim.

## Future Capability Packages

Zentra may later host software-development, communication, meeting, personal-operation, and device capability packages.

Only the software-development package belongs in the first implementation sequence.

Later Zoe packages must satisfy the same capability, policy, approval, evidence, budget, cancellation, and recovery contracts.

## Scope Guard

Zentra must remain useful without Zoe.

Zoe must remain able to evolve its personal-assistant behavior without changing Zentra's generic scheduling kernel.
