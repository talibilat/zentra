# Finding: Package-Verifier Descendant Cleanup - Implementation Report

## Finding

`scripts/verify-package-contents.mjs` used `spawnSync` with a raw OS-level timeout.
Timeout and completion outcomes were reported without confirming that the spawned process group, and any descendants it created, had actually exited.

## Reproduction

Added a regression test in `tests/package/package-e2e.test.ts` (`confirms package-verifier descendants exit before reporting a timeout`) that spawns a parent process which detaches a long-lived descendant and records its PID, then calls the verifier's `run` helper with a short timeout.
Before the fix, the timeout error could resolve while the descendant PID was still alive.

## Fix

`scripts/verify-package-contents.mjs` now runs subprocesses asynchronously and detached (its own process group), and on any settlement path (exit, timeout, output-limit, spawn error) confirms the process group is gone before resolving or rejecting:

- Attempts graceful `SIGTERM` first only for a real exit decision, then escalates to `SIGKILL`.
- Polls `process.kill(-pid, 0)` and treats only `ESRCH` as proof of absence (matching the same pattern already used by `ProcessSupervisor`).
- Waits for the child's `close` event (stream drain) before resolving, in addition to process-group absence.
- Throws explicitly if the process group survives the bounded forced-termination window, instead of silently reporting a timeout or success.

## Residual Risk

Process-group exit detection covers same-process-group descendants, but a descendant that uses `detached: true` again to create a new session can escape it; this is accepted outside the Trusted-Project MVP threat model because, consistently with the exact-executable allowlist posture in `AGENTS.md`, Zentra does not sandbox deliberate actions by an approved executable in a trusted project.

## Test Evidence

- `pnpm exec vitest run tests/package/` - 2 files, 26 tests passed, including the new descendant-confirmation regression.
- `pnpm check` - clean, no type errors.
- `pnpm build` then `pnpm package:contents` - real end-to-end run: "Verified 71 deterministic package files across clean packs with umasks 022 and 077" (unchanged from the pre-fix baseline recorded in the handoff, confirming no behavior regression).

## Verification note

The OpenCode writer session that authored this fix had no shell/command-execution tool available and explicitly declined to fabricate test results or a commit.
The integration steward (this orchestration process) ran the above verification commands directly in the writer's worktree and recorded the real results here before committing.
