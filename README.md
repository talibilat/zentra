# Zentra

Zentra is a general agent orchestration platform that begins with software-development projects and may later execute broader Zoe workflows.

The first implementation is a local, single-project TypeScript tracer bullet.
It will durably execute one approved coding ticket through worktree creation, deterministic worker execution, validation, independent review, integration, and evidence-backed completion.

## Status

Zentra is currently in the approved design and implementation-planning phase.
The repository does not yet contain a working orchestrator.

## Documentation

- [Approved orchestrator design](docs/design/orchestrator.md)
- [MVP implementation plan](docs/plans/mvp.md)
- [Zoe client boundary](docs/context/zoe-client.md)
- [Imported Zoe ticket-governance reference](docs/process/zoe-ticket-governance-reference.md)
- [Documentation index](docs/README.md)

## Initial Scope

- Node.js 24 and TypeScript.
- Local single-user operation on macOS.
- SQLite event journal.
- One registered software project.
- Git worktree isolation.
- One deterministic worker and reviewer fixture.
- Named validation capabilities.
- One serialized integration queue.
- Restart recovery and evidence-backed terminal outcomes.

## Explicit Non-Goals

- Real OpenCode, Claude Code, or Codex integration in the first MVP.
- Twenty to forty concurrent writers.
- Distributed workers.
- Email, meeting, personal-operation, or device execution.
- A general shell capability.
- Ambient credential inheritance.

## Planned Growth

After the local tracer bullet is reliable, Zentra will add real harness containment, pod execution, multiple projects, twenty-agent resource governance, forty-agent isolation, and later Zoe capability packages.
