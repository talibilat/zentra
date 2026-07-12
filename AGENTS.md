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
- Configure validations with the approved canonical absolute executable path; relative, symlinked, wrapped, and alternate executable identities are rejected.
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
- Configured validation commands run with the same operating-system authority as the user running the Zentra CLI.
- The exact-executable allowlist reduces accidental use of unintended executables; it is not a filesystem sandbox and does not restrict what an approved executable can access as that user.
- This Trusted-Project MVP is only for projects that the operator controls and configures; hostile repositories and hostile or untrusted project configuration are prohibited.
- Repository owner Md Talib explicitly accepted this Trusted-Project MVP authority model on 2026-07-12.
- Workers and reviewers must not inherit arbitrary parent secrets.
- File writes must remain inside the assigned worktree and reviewed relative paths.
- Integration must validate a disposable candidate before updating the integration branch.
