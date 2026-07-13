# Zentra Documentation

## Design

- `design/orchestrator.md` defines the approved long-term product and architecture.

## Plans

- `plans/mvp.md` preserves the historical implementation plan for the completed first local tracer bullet.
  It is not authoritative for current CLI flags, package metadata, platform support, or runtime policy.

## Context

- `context/zoe-client.md` explains how Zoe will use Zentra without owning its generic kernel.

## Process

- `process/zoe-ticket-governance-reference.md` preserves the mature readiness and ticket-governance model developed for Zoe.
  Zentra should adapt that model after the MVP proves its own task lifecycle.

## Release

- `release/support-policy.md` is the current platform and Node.js runtime support policy.

## Issue Corpus

- `issues/` preserves the pre-deployment audit findings and remediation plan at their recorded baseline.
  Current implementation evidence is retained under `execution/`.

## Execution Evidence

- `execution/issue-*-implementation-report.md` records completed remediation and verification evidence.
- `execution/HANDOFF.md`, `execution/mvp-final-report.md`, `execution/mvp-progress.md`, and `execution/pre-deployment-progress.md` are historical execution snapshots, not current operator policy.

## Document Authority

When documents conflict, use this order:

1. Approved Zentra design.
2. Current operator and release documentation.
3. Zentra repository instructions.
4. Zoe client context.
5. Historical implementation plans and execution evidence.
6. Imported process references.
