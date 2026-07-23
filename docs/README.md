# Zentra Documentation

## User Guides

- `../README.md` provides installation and quick-start instructions.
- `commands.md` documents every public CLI command.
- `soak-and-ui.md` explains the UI, AgentTrail, and 24-hour soak path.
- `release/support-policy.md` defines supported hosts and runtimes.

## Codebase Atlas

- `codebase-map.html` is a self-contained, source-derived interactive map of current features, functions, schemas, tests, and end-to-end data flows.
- Regenerate it with `pnpm docs:codebase-map` after executable declarations or module relationships change.

## Design

- `design/orchestrator.md` defines the approved long-term product and architecture.
- `design/opencode-execution-model.md` defines the OpenCode execution boundary.

## Plans

- `plans/mvp.md` defines the first local tracer-bullet implementation.

## Context

- `context/zoe-client.md` explains how Zoe will use Zentra without owning its generic kernel.

## Process

- `process/zoe-ticket-governance-reference.md` preserves the mature readiness and ticket-governance model developed for Zoe.
  Zentra should adapt that model after the MVP proves its own task lifecycle.

## Historical Evidence

- `execution/` contains retained implementation and conformance evidence.
- Historical reports are not current operator instructions.
- `issues/` contains retained issue briefs and its issue index.
- `superpowers/specs/` contains implemented design rationale.

## Document Authority

When documents conflict, use this order:

1. Approved Zentra design.
2. Current approved Zentra implementation plan.
3. Zentra repository instructions.
4. Zoe client context.
5. Imported process references.
