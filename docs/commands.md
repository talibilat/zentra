# Zentra Command Reference

This document covers every public CLI command.
Use `zentra` below for an installed package.

Use this prefix in the source checkout:

```bash
pnpm start --
```

## Global Behavior

Run `zentra --help` for the top-level list.
Run `zentra <command> --help` for command help.

Operational commands return one JSON object.
Help output is plain text.
Errors go to standard error.

Milestone live output uses standard output for JSONL.
Its final result goes to standard error.

## Logging

The local service owns the project runtime log paths.

- `.zentra/events.sqlite` is the source of truth.
- `.zentra/traces/*.jsonl` contains AgentTrail projections.
- The UI shows the active trace through AgentTrail.

Commands with `--database` use the named SQLite journal.
Commands with `--agent-tail-jsonl` create a named trace file.
The trace path must be new, absolute, and normalized.
It must sit beside the journal when required by the command.

`--agent-tail-stream` streams retained JSONL to standard output.
It requires `--agent-tail-jsonl`.

Read-only commands do not create a new trace.
They replay the existing journal.

## Local Service

### `zentra start`

Purpose: Start the local Zentra service.

Usage:

```bash
zentra start [--project <path>] \
  [--token-ttl-seconds <seconds>] \
  [--agenttrail-timeout-ms <milliseconds>]
```

Options:

- `--project` selects a path inside the Git project.
- The current directory is the default project path.
- `--token-ttl-seconds` defaults to `900`.
- `--agenttrail-timeout-ms` defaults to `60000`.

Capabilities:

- Discovers the Git project root.
- Creates the private `.zentra` runtime.
- Starts the event journal.
- Starts the scheduler.
- Starts the loopback gateway.
- Starts AgentTrail.
- Prints a private session URL.
- Opens the browser in an interactive terminal.
- Runs until stopped by a signal.

Logging:

- Journal: `.zentra/events.sqlite`.
- Trace: `.zentra/traces/agenttrail-<service-id>.jsonl`.
- UI evidence: `/agenttrail/` in the session URL.

### `zentra run`

Purpose: Submit one workflow run.

Usage:

```bash
zentra run [goal] [--tickets <folder>] [--actor <id>]
```

Rules:

- Supply either `goal` or `--tickets`.
- Do not supply both.
- `--actor` defaults to `zentra-local-operator`.
- The service must already be running.

Capabilities:

- Submits an inline goal.
- Submits a bounded ticket directory.
- Creates a new single-use command identity.
- Uses the local service control API.

Logging:

- The running service journals the submission.
- The active service trace receives its projection.

### `zentra list`

Purpose: List durable workflow runs.

Usage:

```bash
zentra list
```

Capabilities:

- Reads all visible runs from the local service.
- Returns compact JSON.

Logging:

- This is a read-only service query.
- It does not create a new trace.

### `zentra status`

Purpose: Inspect one workflow run.

Usage:

```bash
zentra status <run-id>
```

Capabilities:

- Returns the durable run view.
- Fails when the run does not exist.

Logging:

- This is a read-only service query.
- It does not create a new trace.

### `zentra cancel`

Purpose: Record cancellation of one workflow run.

Usage:

```bash
zentra cancel <run-id> \
  --expected-version <version> \
  --actor <id> \
  --command-id <id>
```

Capabilities:

- Uses optimistic concurrency.
- Records an exact actor identity.
- Uses a single-use command identity.
- Rejects stale or repeated mutations.

Logging:

- The service journals the cancellation decision.
- The active service trace receives its projection.

## Questions And Plans

### `zentra question answer`

Purpose: Answer one pending workflow question.

Usage:

```bash
zentra question answer <decision-id> \
  --run-id <id> \
  --expected-version <version> \
  --actor <id> \
  --command-id <id> \
  --option-id <id>
```

Capabilities:

- Selects one exact offered option.
- Binds the answer to the run and decision version.
- Prevents duplicate command use.

Logging:

- The service journals the answer and actor.
- The active service trace receives its projection.

### `zentra question reject`

Purpose: Reject one pending workflow question.

Usage:

```bash
zentra question reject <decision-id> \
  --run-id <id> \
  --expected-version <version> \
  --actor <id> \
  --command-id <id> \
  --reason <text>
```

Capabilities:

- Records a bounded rejection reason.
- Binds the rejection to the exact decision version.

Logging:

- The service journals the rejection and actor.
- The active service trace receives its projection.

### `zentra plan approve`

Purpose: Approve one exact plan and authority envelope.

Usage:

```bash
zentra plan approve <decision-id> \
  --run-id <id> \
  --expected-version <version> \
  --actor <id> \
  --command-id <id> \
  --plan-digest <sha256> \
  --envelope-digest <sha256>
```

Capabilities:

- Requires both displayed SHA-256 digests.
- Binds approval to one decision version.
- Grants no authority outside that envelope.

Logging:

- The service journals the approval and digests.
- The active service trace receives its projection.

### `zentra plan reject`

Purpose: Reject one pending plan approval.

Usage:

```bash
zentra plan reject <decision-id> \
  --run-id <id> \
  --expected-version <version> \
  --actor <id> \
  --command-id <id> \
  --reason <text>
```

Capabilities:

- Records a bounded rejection reason.
- Binds the rejection to the exact decision version.

Logging:

- The service journals the rejection and actor.
- The active service trace receives its projection.

## Configuration And Policy

### `zentra project validate`

Purpose: Validate project configuration.

Usage:

```bash
zentra project validate --config <path>
```

Capabilities:

- Accepts one project object or an array.
- Validates project identities and absolute paths.
- Validates the dedicated integration branch.
- Validates focused and full commands.
- Enforces the canonical Node.js executable.
- Rejects shell wrappers and unsafe timeouts.

Logging:

- This command does not open a journal.
- It writes only its JSON result.

### `zentra policy preview`

Purpose: Validate model and security sheets.

Usage:

```bash
zentra policy preview \
  --model-sheet <path> \
  --security-sheet <path>
```

Capabilities:

- Parses both Markdown policy files.
- Returns public summaries.
- Lists denied capabilities.
- Creates no operational effect.

Logging:

- This command does not open a journal.
- It writes only its JSON result.

## Milestones

### `zentra milestone run`

Purpose: Run the fixed installed OpenCode milestone.

Usage:

```bash
zentra milestone run \
  --goal <sentence> \
  --config <path> \
  --database <path> \
  --model-sheet <path> \
  --security-sheet <path> \
  --provider <path> \
  --opencode <path> \
  --opencode-home <path> \
  --opencode-sha256 <digest> \
  --opencode-version <version> \
  --agent-tail-jsonl <path> \
  --file <path>
```

Capabilities:

- Plans through the configured Azure broker.
- Performs governed IANA research.
- Runs a host OpenCode writer.
- Limits writing to the explicit file.
- Runs named validation.
- Runs independent review.
- Uses disposable candidate integration.
- Attests the OpenCode digest and version.
- Stops on uncertain effects.

Logging:

- The named SQLite database is authoritative.
- The named AgentTrail JSONL file is mandatory.
- Standard output streams the same JSONL.
- The final compact result goes to standard error.

Exit codes:

- `0` means `completed`.
- `1` means failure, nonterminal state, or trace failure.
- `2` means `cancelled`.
- `3` means `denied`.
- `4` means `timed_out`.

### `zentra milestone preview`

Purpose: Create a durable plan preview.

Usage:

```bash
zentra milestone preview \
  --config <path> \
  --database <path> \
  --model-sheet <path> \
  --security-sheet <path> \
  --agent-tail-jsonl <path> \
  [--agent-tail-stream] \
  --task <sentence>
```

Capabilities:

- Selects an approved planner model.
- Creates a one-task milestone plan.
- Records stop-and-ask boundaries.
- Runs no worker or validation.
- Creates no worktree or integration effect.

Logging:

- Writes the preview to the named journal.
- Writes AgentTrail JSONL to the named trace.
- `--agent-tail-stream` also streams that JSONL.

### `zentra milestone list`

Purpose: List milestone statuses.

Usage:

```bash
zentra milestone list --database <path>
```

Capabilities:

- Replays all milestone views.
- Uses active and archived journal history.

Logging:

- This is a read-only journal query.
- It does not create a new trace.

### `zentra milestone status`

Purpose: Inspect one milestone.

Usage:

```bash
zentra milestone status \
  --database <path> \
  --milestone-id <id>
```

Capabilities:

- Replays one public milestone view.
- Returns lifecycle, outcome, and attention state.

Logging:

- This is a read-only journal query.
- It does not create a new trace.

## Capsule Conformance

### `zentra capsule conformance`

Purpose: Test the Darwin arm64 capsule boundary.

Usage:

```bash
zentra capsule conformance \
  --capsule-id <id> \
  --policy <path> \
  --project <path> \
  --database <path> \
  --agent-tail-jsonl <path>
```

Capabilities:

- Runs the real Docker capsule path.
- Mounts the project read-only.
- Tests the TLS policy proxy.
- Attests the packaged runtime.
- Performs no model call.
- Performs no GitHub effect.

Logging:

- Writes evidence to the named journal.
- Writes AgentTrail JSONL to the named trace.

## GitHub Effects

All GitHub commands require these options:

```text
--policy <path>
--database <path>
--agent-tail-jsonl <path>
--grant-id <id>
```

The grant ID is also the request identity.
Effect dispatch never proves completion.
Use the matching reconciliation command.

### `zentra github push`

Purpose: Dispatch one exact non-force push.

Usage:

```bash
zentra github push \
  --policy <path> \
  --database <path> \
  --agent-tail-jsonl <path> \
  --grant-id <id> \
  --repository <owner/name> \
  --target-ref <ref> \
  --source-commit <oid> \
  --expected-old-oid <oid> \
  --source-repository <path>
```

Capabilities:

- Consumes one exact push grant.
- Verifies the source object.
- Enforces expected remote state.
- Uses broker-owned Git configuration.
- Returns an uncertain receipt after dispatch.

Logging:

- Journals grant consumption and dispatch.
- Writes AgentTrail JSONL to the named trace.

### `zentra github create-pr`

Purpose: Dispatch one exact pull-request creation.

Usage:

```bash
zentra github create-pr \
  --policy <path> \
  --database <path> \
  --agent-tail-jsonl <path> \
  --grant-id <id> \
  --push-grant-id <id> \
  --repository <owner/name> \
  --base <branch> \
  --head-ref <branch> \
  --head-commit <oid> \
  --title <title> \
  --body <body> \
  [--draft]
```

Capabilities:

- Requires a completed prerequisite push grant.
- Rechecks the exact head commit.
- Binds title, body, base, and draft state.
- Returns an uncertain receipt after dispatch.

Logging:

- Journals grant consumption and dispatch.
- Writes AgentTrail JSONL to the named trace.

### `zentra github reconcile-push`

Purpose: Reconcile one uncertain push.

Usage:

```bash
zentra github reconcile-push \
  --policy <path> \
  --database <path> \
  --agent-tail-jsonl <path> \
  --grant-id <id>
```

Capabilities:

- Reads the exact remote ref.
- Derives request fields from durable evidence.
- Never redispatches the push.

Logging:

- Journals the reconciliation receipt.
- Writes AgentTrail JSONL to the named trace.

### `zentra github reconcile-pr`

Purpose: Reconcile one uncertain pull request.

Usage:

```bash
zentra github reconcile-pr \
  --policy <path> \
  --database <path> \
  --agent-tail-jsonl <path> \
  --grant-id <id>
```

Capabilities:

- Searches for the bound request marker.
- Verifies exact pull-request details.
- Verifies the exact head commit.
- Never recreates the pull request.

Logging:

- Journals the reconciliation receipt.
- Writes AgentTrail JSONL to the named trace.

## Journal Retention

The journal is the source of truth.
Archive and prune are separate operations.
Pruning is irreversible.

### `zentra journal archive`

Purpose: Archive one bounded event range.

Usage:

```bash
zentra journal archive \
  --database <path> \
  --through-position <position> \
  --max-events <count>
```

Capabilities:

- Creates a checksummed JSONL segment.
- Creates a chained manifest.
- Anchors archive state in SQLite.

Logging:

- Writes retention events to the journal.
- Writes archive files under `<database>.archives/`.

### `zentra journal verify`

Purpose: Verify the complete archive chain.

Usage:

```bash
zentra journal verify --database <path>
```

Capabilities:

- Verifies segments, manifests, ranges, and anchors.
- Fails on gaps or tampering.

Logging:

- Reads journal and archive evidence.
- It does not create a trace.

### `zentra journal prune-request`

Purpose: Create an audited prune request.

Usage:

```bash
zentra journal prune-request \
  --database <path> \
  --through-position <position> \
  --operator <id>
```

Capabilities:

- Records the operator and boundary.
- Returns a request ID.
- Returns the exact confirmation phrase.
- Does not delete events.

Logging:

- Writes the request above the prune boundary.

### `zentra journal prune`

Purpose: Apply one audited prune request.

Usage:

```bash
zentra journal prune \
  --database <path> \
  --through-position <position> \
  --operator <id> \
  --request-id <id> \
  --confirm <phrase>
```

Capabilities:

- Requires a verified archive.
- Requires the exact request and phrase.
- Blocks on unsafe projection cursors.
- Deletes only the authorized active rows.

Logging:

- Journals authorization and completion evidence.
- Retains archived history under `<database>.archives/`.

### `zentra journal maintain`

Purpose: Run bounded SQLite maintenance.

Usage:

```bash
zentra journal maintain \
  --database <path> \
  [--vacuum-pages <count>]
```

Options:

- `--vacuum-pages` has a maximum of `1000`.

Capabilities:

- Runs a passive WAL checkpoint.
- Creates a bounded integrity-checked backup.
- Can run bounded incremental vacuum.
- Never runs full `VACUUM`.

Logging:

- Journals maintenance intent and results.

### `zentra journal export`

Purpose: Export complete journal history.

Usage:

```bash
zentra journal export \
  --database <path> \
  --name <filename>
```

Capabilities:

- Exports active and archived history.
- Uses one fixed high-water position.
- Creates a new file beside the journal.
- Rejects paths and existing destinations.

Logging:

- Journals export evidence.
- Returns the exported file digest.

### `zentra journal restore`

Purpose: Restore an export into a new journal.

Usage:

```bash
zentra journal restore \
  --database <path> \
  --name <filename>
```

Capabilities:

- Verifies the export and archive chain.
- Preserves event identities and positions.
- Creates a new file beside the source journal.

Logging:

- Journals restore intent and completion evidence.

### `zentra journal recover`

Purpose: Inspect interrupted retention work.

Usage:

```bash
zentra journal recover --database <path>
```

Capabilities:

- Performs read-only recovery classification.
- Does not repeat an interrupted effect.
- This is an alias of `inspect-recovery` behavior.

Logging:

- Reads retained operation evidence.
- It does not create a trace.

### `zentra journal inspect-recovery`

Purpose: Inspect interrupted retention work.

Usage:

```bash
zentra journal inspect-recovery --database <path>
```

Capabilities:

- Classifies archive, prune, backup, or restore state.
- Returns the operation ID and safe next action.
- Performs no repair effect.

Logging:

- Reads retained operation evidence.
- It does not create a trace.

### `zentra journal reconcile`

Purpose: Reconcile one classified retention operation.

Usage:

```bash
zentra journal reconcile \
  --database <path> \
  --operation-id <id> \
  --confirm <phrase>
```

Capabilities:

- Requires the exact classified operation.
- Requires the exact generated phrase.
- Anchors proven effects.
- Can remove exact orphan publication residue.
- Does not repeat the original effect.

Logging:

- Journals reconciliation evidence.

## Deterministic Tasks

### `zentra task run`

Purpose: Run one deterministic tracer-bullet task.

Usage:

```bash
zentra task run \
  --config <path> \
  --database <path> \
  --task-id <id> \
  --title <title> \
  --file <relative-path> \
  --content <text> \
  --security-sheet <path> \
  [--risk-level <level>] \
  [--authority <authority>] \
  [--requires-approval] \
  [--agent-tail-jsonl <path>] \
  [--agent-tail-stream]
```

Defaults:

- `--risk-level` defaults to `low`.
- `--authority` defaults to `workspace_write`.

Capabilities:

- Changes one safe root-level file.
- Uses the bundled deterministic worker.
- Runs focused validation.
- Runs independent deterministic review.
- Commits only reviewed content.
- Validates a disposable integration candidate.
- Preserves evidence on failure.

Logging:

- Writes all task events to the named journal.
- `--agent-tail-jsonl` adds a retained trace.
- `--agent-tail-stream` streams that trace.

### `zentra task status`

Purpose: Replay one task status.

Usage:

```bash
zentra task status \
  --database <path> \
  --task-id <id>
```

Capabilities:

- Rebuilds the task view from journal history.
- Reads active and archived events.

Logging:

- This is a read-only journal query.
- It does not create a new trace.

### `zentra task diagnose`

Purpose: Produce one bounded operator diagnostic.

Usage:

```bash
zentra task diagnose \
  --config <path> \
  --database <path> \
  --task-id <id>
```

Capabilities:

- Reports the stable task stage.
- Reports bounded validation summaries.
- Reports artifact identities and digests.
- Reports recovery classification.
- Reports configured retained worktree state.
- Omits raw child output and environments.

Logging:

- This is a read-only journal query.
- It does not apply recovery effects.

## Task Recovery

### `zentra recover`

Purpose: Classify one task for safe recovery.

Usage:

```bash
zentra recover \
  --config <path> \
  --database <path> \
  --task-id <id>
```

Capabilities:

- Inspects task, worktree, commit, and integration evidence.
- Returns `resume_preparation`, `await_reconciliation`, `record_completion`, or `record_failure`.
- Never retries a potentially effectful operation.

Logging:

- This is a read-only classification.
- It does not create a new trace.

### `zentra recover-apply`

Purpose: Record an authorized recovery completion.

Usage:

```bash
zentra recover-apply \
  --config <path> \
  --database <path> \
  --task-id <id>
```

Capabilities:

- Recomputes recovery state inside the write path.
- Requires a fresh `record_completion` classification.
- Uses short-lived single-use authorization.
- Is idempotent after completion.
- Never accepts a caller-supplied decision.

Logging:

- Appends the terminal completion to the journal.
- It does not create a separate trace.
