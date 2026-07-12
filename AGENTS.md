# Zentra Agent Instructions

## Source Of Truth

- Read `docs/design/orchestrator.md` before changing architecture.
- Read `docs/plans/mvp.md` before implementing the MVP.
- Treat `docs/context/zoe-client.md` as the client boundary between Zentra and Zoe.
- The imported Zoe ticket-governance document is a reference, not permission to copy Zoe-specific paths into Zentra.

## Engineering Rules

- Use Node.js 24 or newer and pnpm 10.
- Follow test-driven development for behavioral changes.
- Invoke subprocesses with executable and argument arrays and `shell: false`.
- Pass explicit minimal environments to workers and validations.
- Do not expose a general shell capability.
- Keep the event journal as the source of truth and projections rebuildable.
- Use only `completed`, `cancelled`, `denied`, `timed_out`, or `failed` as terminal outcomes.
- Never automatically retry a potentially effectful operation after an uncertain result.
- Keep implementation work off `main` and use isolated worktrees.
- Do not commit, push, or file issues unless the user explicitly requests it.
- Put each full sentence on its own physical line in long Markdown documents.

## Scope Discipline

- Complete the deterministic local tracer bullet before adding real coding harnesses.
- Do not add distributed execution, personal workflows, email, meetings, or devices to the MVP.
- Do not introduce plugin APIs until the core contracts are exercised end to end.
- Prefer one measurable vertical outcome over unused horizontal infrastructure.

## Security Boundary

- Agent reasoning never grants execution authority.
- Installation never grants authority.
- Workers and reviewers must not inherit arbitrary parent secrets.
- File writes must remain inside the assigned worktree and reviewed relative paths.
- Integration must validate a disposable candidate before updating the integration branch.
