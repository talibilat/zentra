# Zentra

Zentra is a local-first orchestration kernel that coordinates bounded software-development tasks through durable events, isolated Git worktrees, deterministic validation, independent review, and serialized integration.

The orchestrator owns task lifecycle, execution coordination, evidence, recovery classification, and integration while each configured project continues to own its source, tests, validation commands, protected paths, and release policy.

Zoe is a client of Zentra rather than part of this repository, and Zentra does not own Zoe's voice, memory, personality, attention, email, meeting, personal-operation, or device behavior.

## MVP Boundary

The current MVP runs on one local machine for one user and executes one deterministic tracer-bullet task at a time against one configured Git project.

It uses a bundled deterministic worker fixture and an internally fixed deterministic reviewer subprocess to prove the orchestration contracts without exposing a general coding harness or shell interface.

Real coding harnesses, high concurrency, distributed execution, plugin APIs, and Zoe personal capabilities are explicitly not included yet.

The MVP is evidence for the local orchestration path, not a production sandbox or a multi-tenant security boundary.

## Installation

The MVP supports only macOS on Apple Silicon (`darwin`/`arm64`).

The current local conformance evidence was produced on macOS 26.6 arm64.
That observation is not a claim that untested macOS versions work, and Intel (`x64`) macOS, Linux, and Windows remain unsupported.

Install Node.js 24, 25, or 26 and pnpm 10 on a supported host.
The exact package engine range is `>=24 <27`; Node.js 27 and later are unsupported until an explicit compatibility review widens that bound.

The package declares its supported operating system and CPU through npm `os` and `cpu` metadata.
npm rejects other targets with `EBADPLATFORM` before installing Zentra, rather than allowing an operator to reach operational commands with an untested process, filesystem, Git, SQLite, or native-addon stack.

The repository is not currently published through npm or an automated release channel.
The instructions below describe development from a source checkout.
Local tarballs produced by `npm pack` are tested installation artifacts, but no supported release-download, upgrade, rollback, or provenance procedure exists yet.

Install dependencies and build the CLI from the repository root.

```bash
pnpm install
pnpm build
```

Run the built CLI through the package script.

```bash
pnpm start -- --help
```

See [MVP Platform And Runtime Support](docs/release/support-policy.md) for the exact support boundary and the evidence required to widen it.

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

Every validation report and its durable provenance record the selected bounded `timeoutMs`, including timed-out results.

Relative paths, symlinks, `env` and similar wrappers, alternate spellings, missing targets, and absolute executables outside that allowlist are rejected during configuration parsing and checked again before process creation.

Approved validation commands are executable and argument arrays invoked with `shell: false`, not shell command strings.

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
  --content $'hello from Zentra\n' \
  --security-sheet /absolute/path/to/SECURITY-SHEET.md \
  --agent-tail-jsonl /absolute/path/to/task-greeting.jsonl
```

`--content` accepts at most 522,240 UTF-8 bytes, reserving 4 KiB for fixed Git headers and another content-sized allowance for the worst case in which Git adds a prefix to every one-byte line.
Zentra measures the complete generated diff, including replaced content and framing, against the 1 MiB byte boundary and fails closed without recording a partial patch when that complete diff is too large.
`--agent-tail-jsonl` is optional and writes each accepted journal event as one append-only UTF-8 JSONL line while the run progresses.
The destination must be a new absolute normalized direct child of the directory containing the event journal, and symbolic-link targets or existing paths are rejected.
The JSONL file is a retained projection for Agent Tail inspection; the SQLite event journal remains the source of truth.

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

The CLI chooses Zentra's bundled deterministic worker internally and runs its fixed reviewer source only through the same approved canonical absolute Node.js executable identity used by validation policy.
The `task run` command exposes no reviewer executable, reviewer argument, or reviewer identity options; attempts to supply those options are rejected before journal or worktree effects.

Configured validations are different: trusted project configuration supplies their argument arrays, while each validation executable must exactly match the approved canonical absolute path of the Node.js executable running Zentra.

CLI callers cannot provide a working directory, workspace, worker fixture, reviewer source, or reviewer process arguments.

Workers, reviewers, and validations receive explicit minimal environments and do not inherit arbitrary parent secrets.

The CLI emits stable JSON without stack traces and does not serialize inherited environment variables.

Configured validation commands run with the same operating-system authority as the user who runs the Zentra CLI.

The exact-executable allowlist reduces accidental use of unintended executables, but it is not a filesystem sandbox and does not restrict what the approved Node.js executable or validation code can access with that user's authority.

Using executable and argument arrays with `shell: false` prevents shell-string interpretation, but it does not reduce filesystem authority.

This Trusted-Project MVP is intended only for projects that the operator controls and configures themselves.

Hostile repositories, hostile or untrusted project configuration, hostile validation code, and multi-user operation are prohibited.

Repository owner Md Talib explicitly accepted this Trusted-Project MVP authority model on 2026-07-12.

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

The CLI integration tests create real temporary Git repositories and exercise deterministic task execution, caller-selected reviewer rejection, retained-patch byte limits, exact journal replay, recovery decisions, unsafe input rejection, stable JSON and exit codes, secret redaction, signal cancellation, and the built help entry point.
