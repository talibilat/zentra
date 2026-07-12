# Zentra

Zentra is a local-first orchestration kernel that coordinates bounded software-development tasks through durable events, isolated Git worktrees, deterministic validation, independent review, and serialized integration.

The orchestrator owns task lifecycle, execution coordination, evidence, recovery classification, and integration while each configured project continues to own its source, tests, validation commands, protected paths, and release policy.

Zoe is a client of Zentra rather than part of this repository, and Zentra does not own Zoe's voice, memory, personality, attention, email, meeting, personal-operation, or device behavior.

## MVP Boundary

The current MVP runs on one local machine for one user and executes one deterministic tracer-bullet task at a time against one configured Git project.

It uses bundled deterministic worker and reviewer fixtures to prove the orchestration contracts without exposing a general coding harness or shell interface.

Real coding harnesses, high concurrency, distributed execution, plugin APIs, and Zoe personal capabilities are explicitly not included yet.

The MVP is evidence for the local orchestration path, not a production sandbox or a multi-tenant security boundary.

## Installation

Install Node.js 24 or newer and pnpm 10.

Install dependencies and build the CLI from the repository root.

```bash
pnpm install
pnpm build
```

Run the built CLI through the package script.

```bash
pnpm start -- --help
```

## Project Configuration

The CLI reads a JSON object containing the project identity, absolute repository and worktree paths, an integration branch, and direct executable argument arrays for focused and full validation.

```json
{
  "projectId": "example-project",
  "repositoryPath": "/absolute/path/to/example-project",
  "integrationBranch": "zentra/integration",
  "worktreeRoot": "/absolute/path/to/zentra-worktrees",
  "validations": {
    "focused": ["/absolute/path/to/node", "--test", "test/greeting.test.mjs"],
    "full": ["/absolute/path/to/node", "--test"]
  }
}
```

Validation commands are executable and argument arrays invoked with `shell: false`, not shell command strings.

The `project validate` command accepts one configuration object or an array of configuration objects, while the MVP `task run` command requires exactly one configured project because its command contract has no project selector.

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
  --content $'hello from Zentra\n'
```

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

Every operational invocation writes exactly one JSON object, with successful results on standard output and errors or unsuccessful outcomes on standard error.

Commander help remains human-readable text rather than an operational JSON result.

## Deterministic File Scope

The deterministic Task 8 worker may change exactly one root-level file selected by `--file`.

The file value must be a plain root-level filename and cannot be absolute, nested, empty, `.`, `..`, contain `/` or `\`, or contain control characters.

The CLI validates this restriction before opening the event journal or creating a task, worktree, or Git ref.

Task identities are also validated as safe single path and ref components before journal, filesystem, worktree, or ref effects.

## Security Boundary

The CLI chooses the current Node.js executable and Zentra's bundled deterministic worker and reviewer internally.

Callers cannot provide an executable, command, working directory, workspace, worker fixture, or reviewer fixture through the CLI.

Workers, reviewers, and validations receive explicit minimal environments and do not inherit arbitrary parent secrets.

The CLI emits stable JSON without stack traces and does not serialize inherited environment variables.

Project validation arrays remain trusted project configuration, so a user who can edit project configuration can choose direct executables that run with that user's host authority.

The current local process and filesystem isolation are not sufficient for untrusted repositories, untrusted configuration authors, hostile executables, or multi-user operation.

Zentra exposes no general shell capability, but it cannot make an explicitly configured executable safe.

## Events And Recovery

SQLite stores the append-only event journal as the source of truth, and task status is rebuilt by replaying that journal.

Terminal outcomes are limited to `completed`, `cancelled`, `denied`, `timed_out`, and `failed`.

`SIGINT` and `SIGTERM` abort the active CLI operation through one `AbortController`, and a cancellation with a known result produces the canonical `cancelled` outcome with a nonzero exit code.

A signal received at an uncertain commit or integration boundary may instead leave the task nonterminal and require reconciliation because Zentra never infers or retries an uncertain effect.

Failed, cancelled, timed-out, denied, interrupted, and uncertain operations preserve durable evidence and worktrees for inspection.

Recovery is read-only classification and never automatically retries a potentially effectful operation after an uncertain result.

An `await_reconciliation` decision means a human or later bounded workflow must reconcile uncertain state before another effect is authorized.

## Tests

Run the complete test suite, type check, build, and built CLI help verification from the repository root.

```bash
pnpm test
pnpm check
pnpm build
pnpm start -- --help
```

The CLI integration tests create real temporary Git repositories and exercise deterministic task execution, exact journal replay, recovery decisions, unsafe input rejection, stable JSON and exit codes, secret redaction, signal cancellation, and the built help entry point.
