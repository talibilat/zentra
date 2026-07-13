# 005 - Deferred Safe Nested Relative Paths

Severity: Enhancement.
Status: Deferred.
Execution wave: Post-MVP enhancement backlog.
Suggested owner scope: Future CLI path validation, deterministic worker containment, tracer artifact paths, and Git commit scope.
Dependencies: Deployment closure is not blocked by this issue.
Conflicts and serialization notes: If prioritized after MVP, serialize CLI edits with active CLI work and serialize any shared tracer or artifact-path files with issue 006.

## Problem

The documented MVP intentionally supports root-level file targets only and rejects every path containing a slash.
Nested relative paths would expand product capability and require a stronger canonical containment design, but their absence is not a deployment defect.

## Repository Evidence

`src/cli/main.ts:384-397` rejects `/` and `\` anywhere in the requested file before opening the journal.
`fixtures/deterministic-worker.mjs:65-67` independently rejects every path containing either slash separator.
`fixtures/deterministic-worker.mjs:69-75` already checks unsafe segments and workspace containment after the blanket slash rejection.

## Failure Sequence Or User Impact

After MVP, an operator may request a bounded change to `docs/example.md` or `src/example.ts` inside the assigned worktree.
The root-level-only MVP correctly rejects the request because nested paths are outside its documented scope.
Future expansion must preserve Zentra's containment and evidence guarantees rather than merely removing the separator check.

## Acceptance Criteria

- [ ] Accept normalized nested relative paths whose canonical target and every traversed parent remain inside the assigned canonical worktree.
- [ ] Reject absolute paths on POSIX and Windows, empty segments, `.`, `..`, control characters, alternate separators, traversal encodings, and paths over documented limits.
- [ ] Reject symlinked parents, symlink targets, and path replacement races without following them outside the worktree.
- [ ] Preserve the exact normalized relative path in typed artifact, review, commit, and replay evidence.
- [ ] Create required parent directories only through a bounded, symlink-safe mechanism when the requested behavior permits a new nested file.

## Required Tests

- [ ] Add built-CLI end-to-end tests for an existing nested file and an allowed new nested file.
- [ ] Add rejection tests for traversal, absolute paths, backslash variants, symlink parents, symlink targets, and parent replacement races.
- [ ] Add replay and reviewed-path commit tests proving only the requested nested path is committed.

## Final Verification

This verification applies only when the enhancement is prioritized after MVP.
Run `pnpm test`, `pnpm check`, and `pnpm build`.
Run the packed CLI against a temporary repository and verify the resulting commit contains exactly one requested nested path.
Inspect the worktree and an outside canary after every adversarial path case.

## Non-Goals

This issue does not allow arbitrary glob patterns or multiple file targets.
This issue does not permit writes through symlinks.
This issue does not broaden worker authority beyond one explicitly requested contained path.
This issue is excluded from the deployment closure gate and active execution waves.
