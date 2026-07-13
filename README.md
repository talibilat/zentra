# Zentra

Zentra is a local-first orchestration kernel that coordinates bounded software-development tasks through durable events, isolated Git worktrees, deterministic validation, independent review, and serialized integration.

The orchestrator owns task lifecycle, execution coordination, evidence, recovery classification, and integration while each configured project continues to own its source, tests, validation commands, protected paths, and release policy.

Zoe is a client of Zentra rather than part of this repository, and Zentra does not own Zoe's voice, memory, personality, attention, email, meeting, personal-operation, or device behavior.

## MVP Boundary

The current MVP runs on one local macOS machine for one user, and each `task run` invocation executes one deterministic tracer-bullet task against one configured Git project.

It uses a bundled deterministic worker to prove the execution contract without exposing a general coding harness or shell interface.
Successful execution requires an operator-configured content-aware reviewer process; without one, `task run` records `denied` before worktree, commit, or integration effects.

Real coding harnesses, high concurrency, distributed execution, plugin APIs, and Zoe personal capabilities are explicitly not included yet.

The MVP is evidence for the local orchestration path, not a production sandbox or a multi-tenant security boundary.

## Installation

Install Node.js 24 or newer and pnpm 10.

Install dependencies and build the CLI from the repository root.

```bash
pnpm install
pnpm build
```

`pnpm build` performs a clean production-only build, marks the declared CLI executable, and writes `dist/package-manifest.json` with hashes of its production inputs and outputs.
Run `pnpm package:verify` to verify that manifest, the bundled worker, the CLI shebang and mode, and all recorded hashes.
`pnpm pack` runs both steps through `prepack`; package tests install the resulting tarball into an empty consumer project and run its binary without repository-relative files.
The package remains `private: true`, so packing is a verification surface rather than an enabled publication channel.

To inspect the packed CLI from a separate empty project, run `pnpm pack` here, install the generated `zentra-0.1.0.tgz` by absolute path with `npm install`, and invoke `./node_modules/.bin/zentra --help` in the consumer project.

The supported package interface is the `zentra` CLI.
Emitted `dist/src` modules and declaration files are internal implementation artifacts, not a stable public library API.

Run the built CLI through the package script.

```bash
pnpm start -- --help
```

## Project Configuration

The CLI reads a JSON object containing the project identity, absolute repository and worktree paths, an integration branch, and direct executable argument arrays for focused and full validation.
`project validate` also accepts an array of 1 through 256 objects from a regular JSON file no larger than 1 MiB; project IDs must be unique and no more than 128 UTF-8 bytes.
`task run` requires exactly one object.

```json
{
  "projectId": "example-project",
  "repositoryPath": "/absolute/path/to/example-project",
  "integrationBranch": "zentra/integration",
  "worktreeRoot": "/absolute/path/to/zentra-worktrees",
  "validations": {
    "focused": ["/absolute/path/to/node", "--test", "test/greeting.test.mjs"],
    "full": ["/absolute/path/to/node", "--test"],
    "focusedTimeoutMs": 30000,
    "fullTimeoutMs": 300000
  }
}
```

Each validation executable must exactly match the canonical absolute real path of the Node.js executable running Zentra.

`focusedTimeoutMs` and `fullTimeoutMs` are finite integer millisecond budgets from `100` through `1800000`, inclusive.

The fields may be omitted, in which case focused validation defaults to `30000` ms and full validation defaults to `300000` ms.

Zero, negative, fractional, nonnumeric, nonfinite, and over-limit timeout values are rejected while parsing project configuration, before a validation process can start.

Every focused or full validation that starts records the selected bounded `timeoutMs` in both its report and durable provenance, including timed-out results.
Synthetic evidence for a validation that could not start may omit that field, and historical reports without timeout fields remain replayable.

Relative paths, symlinks, `env` and similar wrappers, alternate spellings, missing targets, and absolute executables outside that allowlist are rejected during configuration parsing and checked again before process creation.
Approval binds the executable's device, inode, size, and SHA-256 identity observed when Zentra starts, and Zentra rechecks that identity immediately before spawning a validation.
This narrows but does not eliminate the accepted verify-to-exec replacement race in the Trusted-Project authority model.

Approved validation commands are executable and argument arrays invoked with `shell: false`, not shell command strings.

The integration branch must be a safe nonspecial Git branch name.
Zentra rejects names with unsafe Git syntax, including leading `-` or `refs/`, whitespace or control characters, `..`, `@{`, `//`, empty components, dot-prefixed components, dot-suffixed components, and `.lock` components.

## Commands

Validate project configuration and return exit code `0` with one JSON object when every entry is valid.

```bash
pnpm start -- project validate --config /absolute/path/to/zentra.project.json
```

Run the deterministic tracer bullet and return exit code `0` only when the terminal outcome is `completed`.

```bash
pnpm start -- task run \
  --config /absolute/path/to/zentra.project.json \
  --database /absolute/path/to/zentra.sqlite \
  --task-id task-greeting \
  --title "Update greeting" \
  --file greeting.txt \
  --content $'hello from Zentra\n' \
  --reviewer-executable /canonical/absolute/path/to/reviewer \
  --reviewer-id independent-reviewer
```

`--reviewer-argument <value>` may be repeated to pass operator-configured arguments to the reviewer executable.
The executable must be an exact canonical absolute path to a regular executable file; relative, symlinked, normalized-different, and non-executable identities fail before task or journal creation.

### Reviewer Protocol

Zentra starts the reviewer with `shell: false`, `/tmp` as its working directory, a minimal environment, a 30-second timeout, a 2 MiB input limit, and a combined 16 KiB output limit.
It sends one schema-version-1 JSON request on standard input containing a random challenge, worker and reviewer identities, the complete diff, complete focused-validation evidence, and canonical diff and validation digests.
The reviewer must inspect that evidence and emit exactly one nonempty JSON line containing `reviewerId`, `decision` (`approve` or `deny`), `requestSha256`, `diffSha256`, `validationSha256`, an offset-aware `decidedAt`, and a nonempty `reason` of at most 4096 characters.
Zentra rejects malformed or incomplete input and output, self-review, identity or digest mismatches, stale evidence, timeout, excess output, surviving owned descendants, and nonzero exit.

Replay exact task status from the SQLite event journal and return exit code `0` only when the task exists and can be projected.

```bash
pnpm start -- task status \
  --database /absolute/path/to/zentra.sqlite \
  --task-id task-greeting
```

Inspect recovery state and return a recovery classification without automatically retrying or applying an effect.

```bash
pnpm start -- recover \
  --config /absolute/path/to/zentra.project.json \
  --database /absolute/path/to/zentra.sqlite \
  --task-id task-greeting
```

Recovery exits with code `0` for `resume_preparation`, `await_reconciliation`, or `record_completion`, because those values are successful inspection results.

Recovery exits nonzero for `record_failure`, and unknown tasks also produce `record_failure` without appending an event.
The public `recover` command only classifies recovery state.
`record_completion` means inspection proved that completion could be recorded; the command does not apply completion, and the MVP exposes no recovery-apply command.

Every operational invocation writes exactly one JSON object, with successful results on standard output and errors or unsuccessful outcomes on standard error.

Commander help remains human-readable text rather than an operational JSON result.

## Deterministic File Scope

The deterministic Task 8 worker may change exactly one root-level file selected by `--file`.

The file value must be a plain root-level filename and cannot be absolute, nested, empty, `.`, `..`, contain `/` or `\`, or contain control characters.

The CLI validates this restriction before opening the event journal or creating a task, worktree, or Git ref.

Task identities are also validated as safe single path and ref components before journal, filesystem, worktree, or ref effects.
Task IDs are limited to 128 characters, titles to 512 UTF-8 bytes, file names to 255 UTF-8 bytes, replacement content to 1 MiB, and operational JSON output to 16,384 bytes.
Oversized output is replaced with stable `OUTPUT_TOO_LARGE` error JSON, and public errors do not reflect attacker-controlled paths, arguments, stack traces, or inherited secrets.

## Security Boundary

The CLI chooses Zentra's bundled deterministic worker internally.
The local operator may configure one canonical absolute reviewer executable and its arguments; this is trusted executable authority under the Trusted-Project MVP model, not a sandbox or permission grant to untrusted callers.

Configured validations are different: trusted project configuration supplies their argument arrays, while each validation executable must exactly match the approved canonical absolute path of the Node.js executable running Zentra.

CLI callers cannot provide a working directory, workspace, worker executable, or worker fixture.
Reviewer authority is supplied only through the explicit reviewer executable, repeated reviewer arguments, and reviewer identity options.

Workers, reviewers, and validations receive explicit minimal environments and do not inherit arbitrary parent secrets.

The CLI emits stable JSON without stack traces and does not serialize inherited environment variables.

Configured validation commands run with the same operating-system authority as the user who runs the Zentra CLI.

The exact-executable allowlist reduces accidental use of unintended executables, but it is not a filesystem sandbox and does not restrict what the approved Node.js executable or validation code can access with that user's authority.

Using executable and argument arrays with `shell: false` prevents shell-string interpretation, but it does not reduce filesystem authority.

This Trusted-Project MVP is intended only for projects that the operator controls and configures themselves.

Hostile repositories, hostile or untrusted project configuration, hostile validation code, and multi-user operation are prohibited.

Repository owner Md Talib explicitly accepted this Trusted-Project MVP authority model on 2026-07-12.

The current process-supervision implementation is supported and tested on macOS.
Zentra owns a detached process group, allows a bounded stream-flush grace period, terminates same-group descendants after leader exit, and confirms group absence before successful worker, reviewer, or validation completion.
A descendant that deliberately creates a new session or process group is outside this containment mechanism.
The deterministic worker timeout is 120 seconds; focused and full validation timeouts come from project configuration.

## Events And Recovery

SQLite stores the append-only event journal as the source of truth, and task status is rebuilt by replaying that journal.

The MVP records patch, validation-report, review-report, and integration-receipt artifacts as typed, digest-bound evidence inside each task stream.
Every new artifact is preceded by a version-1 `task.artifact_recording` marker, and the marker, artifact, and any immediately consuming lifecycle event are appended atomically.
Artifact paths are logical identifiers rather than separate temporary files.
Replay fails closed on missing, duplicate, out-of-order, cross-task, stale, or contradictory artifact evidence.
Integration receipts distinguish prepared evidence from final observed evidence while retaining narrow compatibility for legacy receipts whose prepared meaning is proven by a matching later event.

Journal reads and projected appends are bounded to 10,000 events, 8 MiB per materialized event, and 64 MiB total materialized event bytes.
File admission limits are 128 MiB for the database, 128 MiB for the WAL, and 8 MiB for shared memory.
Reads and appends require the expected indexed schema and use one-second SQLite lock and guarded-operation budgets; violations fail closed.

Terminal outcomes are limited to `completed`, `cancelled`, `denied`, `timed_out`, and `failed`.

`SIGINT` and `SIGTERM` abort the active CLI operation through one `AbortController`, and a cancellation with a known result produces the canonical `cancelled` outcome with a nonzero exit code.

A signal received at an uncertain commit or integration boundary may instead leave the task nonterminal and require reconciliation because Zentra never infers or retries an uncertain effect.

For unsuccessful operations, durable evidence and any worktree already created are preserved for inspection unless cleanup was durably verified.

Recovery is read-only classification and never automatically retries a potentially effectful operation after an uncertain result.

An `await_reconciliation` decision means a human or later bounded workflow must reconcile uncertain state before another effect is authorized.

`task run` opens the journal read-write and creates it when absent.
`task status` and `recover` require an existing journal and open it read-only without creating schema or SQLite sidecars.
Missing, malformed, unsupported, or over-limit journals fail closed.

A task reaches `completed` only after verified integration and durable cleanup completion or cleanup reconciliation.
Successful cleanup removes the exact clean ticket worktree and ticket ref; cleanup uncertainty leaves the task nonterminal and preserves inspectable state.

Integration is serialized across queue instances within one process.
Separate Zentra processes are not lease-coordinated; Git compare-and-swap prevents stale integration-ref overwrite but does not prevent overlapping candidate work or validation.

## Tests

Run the complete test suite, type check, build verification, package verification, and built CLI help verification from the repository root.

```bash
pnpm test
pnpm check
pnpm build
pnpm package:verify
pnpm start -- --help
```

The CLI integration tests create real temporary Git repositories and exercise deterministic task execution, exact journal replay, recovery decisions, unsafe input rejection, stable JSON and exit codes, secret redaction, signal cancellation, and the built help entry point.
