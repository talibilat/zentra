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
Add `--agent-tail-stream` and pipe stdout to `agent-tail -` for live stdin visualization while retaining the same JSONL lines in the file.
Agent Tail file input is a snapshot and does not follow appended files.
In live stream mode stdout contains only Agent Tail JSONL, and Zentra writes its final operational result to stderr.

Run the Darwin arm64 Docker capsule conformance path with a strict external JSON policy.

```bash
pnpm start -- capsule conformance \
  --capsule-id capsule-check-1 \
  --policy /absolute/path/to/capsule-policy.json \
  --project /canonical/absolute/path/to/project \
  --database /absolute/path/to/capsule.sqlite \
  --agent-tail-jsonl /absolute/path/to/capsule.jsonl
```

The policy schema supports configurable `GET` and `HEAD` methods with either exact domains or all public domains.
Push grants bind repository, target ref, exact source commit, expected old remote OID, non-force behavior, and the typed environment credential reference.
Pull-request grants bind repository, a separate prerequisite push grant, the deterministic broker-owned head ref and exact commit, base, title/body SHA-256 digests, draft state, and the typed environment credential reference.
Every GitHub grant also has a unique `grantId`, the literal audience `zentra.github-broker`, and an expiry timestamp.
The `grantId` is also the deterministic request identity, and the CLI does not accept a separate `--request-id`.
The broker atomically appends grant consumption and action acceptance to `github-grant:<grantId>` at version zero before dispatching an effect, so concurrent or later reuse is denied without a partially consumed state.
Consumption events contain request/policy/action identity but no credential reference or value.
All-public-domain mode still requires HTTPS and denies every non-global DNS result.
The GitHub host broker resolves a grant's handle outside the worker and can invoke one bounded fixed `git push` or `gh pr create` operation without exposing executable, environment, or argument controls.
Every dispatched GitHub effect remains `uncertain`, including zero exit, nonzero exit, timeout, and cancellation, until a separate read-only remote-ref or pull-request lookup records a reconciliation receipt.
An uncertain effect is never retried automatically.
The conformance command does not invoke that effect broker or perform a remote GitHub effect.
The only supported credential reference is `{ "type": "environment", "name": "GITHUB_TOKEN" }`; journal and Agent Tail events contain only policy/action digests and never that reference or credential value.
The `github push` and `github create-pr` CLI commands dispatch exact granted requests and always return an uncertain effect receipt.
The `github reconcile-push` and `github reconcile-pr` commands perform the separate read-only verification required before completion.
Reconciliation derives every action field from the durable accepted event, permits at most five uncertain read-only attempts within 24 hours, and rejects caller substitutions.
An accepted-only crash is treated as an uncertain burned grant and may only use read-only reconciliation; it can never redispatch.
Push reconciliation treats absent or later-moved refs as uncertain rather than proving failure.
Pull-request bodies include the bound opaque request marker, and reconciliation uses GitHub's total-count search plus exact PR detail verification so absent or ambiguous results remain uncertain.
PR admission requires its `pushGrantId` stream to end in completed reconciliation for a separate exact zero-old-OID push that created the deterministic broker-owned head ref at the same repository and source commit.
PR dispatch never creates or moves the branch.
GitHub exposes no atomic pull-request creation primitive with an expected head OID, so the supported boundary combines the broker-owned branch, completed exact push evidence, durable cross-process per-repository serialization, and an immediate head-OID recheck before `gh pr create`.
Repository leases coexist with journal tables in the canonical event-journal SQLite database; path aliases converge through filesystem canonicalization and no separate lease sidecar database is created.
External repository actors can still move or delete the head after that final check, so reconciliation verifies the created PR's exact head OID and keeps any mismatch uncertain.
The conformance command keeps model traffic disabled and proves only the OpenCode version and executable digest.
The programmatic read-only OpenCode role requires an explicitly supplied typed `ModelBroker` and records the broker-reported model metadata and bounded evidence in the milestone journal.
Installed milestone CLI composition belongs to issue #34 and is not exposed by issue #18.
Issue #18 supports programmatic composition through `OpenCodeReadOnlyProgram`, which requires an authoritative journal, retained `AgentTailJsonlFileSink`, trusted `ModelBroker`, parsed `ModelSheet`, and parsed `SecuritySheet`.
The program resolves the task-assigned capability from that sheet and constructs `DockerOpenCodeReadOnlyCapsule`; callers do not select a model in each run request.
`ModelCapability.id` remains the local assignment and policy identity, while `ModelCapability.model` is the approved provider transport identity sent to `ModelBroker` and required in its receipt.
The broker is a trusted capability-runner contract and must acknowledge abort promptly.
If it ignores abort beyond the fixed termination grace, Zentra records a failed task with uncertain broker transport rather than claiming successful cancellation or completion.

```ts
import {
  AgentTailJsonlFileSink,
  MilestoneRegistry,
  OpenCodeReadOnlyProgram,
  SqliteEventJournal,
  loadModelSheet,
  loadSecuritySheet,
} from "zentra";

const journal = new SqliteEventJournal(databasePath);
const agentTailSink = AgentTailJsonlFileSink.open(traceRoot, tracePath);
const modelSheet = loadModelSheet(modelSheetPath);
const securitySheet = loadSecuritySheet(securitySheetPath);
const program = new OpenCodeReadOnlyProgram(
  journal,
  agentTailSink,
  modelBroker,
  modelSheet,
  securitySheet,
);
const milestones = new MilestoneRegistry(journal);
milestones.register({ milestoneId, projectId, title, correlationId, plan });
const result = await program.run({
  milestoneId,
  taskId,
  repositoryPath,
  role: "researcher",
  rolePrompt,
  budget,
  timeoutMs,
  signal,
});
```

`OpenCodeReadOnlyProgram.run()` constructs a required identity-bearing OpenCode admission context and calls `MilestoneRegistry.admitTask()` before any repository view, resource intent, capsule, Docker, or broker action.
The registry canonicalizes the requested repository, requires an exact security-sheet repository match, checks the assigned model, requested budget, file scope, network, approval, and release boundary, and atomically records either the packet-bound task readiness digest or one durable pause.
OpenCode admission requires the assigned model harness to be exactly `opencode` and binds its canonical roles, tool permissions, network declaration, and positive context-token capacity into the packet digest.
Requested input and output tokens must fit within that bound capacity, and the complete snapshot is checked again immediately before resource intent.
Direct callers of `MilestoneRegistry.admitTask()` must provide its complete `OpenCodeTaskAdmissionContext`; there is no context-free readiness API.
The milestone must already exist in the supplied journal, and an executable task assignment must name an approved OpenCode capability with only `read_repository` tool authority and denied direct network access.
When no valid plan exists yet, admission records bounded `plan_not_ready` attention instead of starting work.
`stopAndAskConditions` records the configured escalation vocabulary but never disables mandatory repository, file, authority, network, release, or budget stops.
The current OpenCode admission packet has no optional advisory condition beyond those mandatory checks.
`approvalRequiredOperations` is consulted only for operations represented by the typed request; it does not turn a broad authority label into an inferred remote operation or standing approval.
Because the current milestone plan cannot express an exact remote destination and release target, remote effects remain stopped rather than borrowing authority from an allowed destination or approval-operation name.
An unstarted paused milestone may replace its plan through `MilestoneRegistry.replacePlan()` only when the request exactly binds the durable `attentionId`, prior plan digest, prior security digest, milestone identity, and project identity.
The replacement event clears attention into `planning`, resets only unstarted task projections, and grants no readiness or execution authority; every replacement task must pass current-policy admission again.
Once any task has started or created a resource intent, same-milestone replacement is prohibited even after successful completion and cleanup.
Create a new milestone to revise work after execution has started.
Before creating the deterministic sanitized view or any Docker resource, the program journals `milestone.agent_resource_intent` with reconstructable names, label, and controlled view path.
After an interrupted attempt, `program.reconcile({ milestoneId, taskId, capsuleId? })` discovers labeled resources, removes and proves their absence, and journals cleanup before another attempt can start.
The built-in `DisabledModelBroker` performs no provider transport and no provider credentials are invented or passed into the capsule.
Policy files, journals, command results, and Agent Tail JSONL must never contain credentials.

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
Live Agent Tail streaming is the exception because it reserves standard output for JSONL and writes the operational result to standard error.

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

The Docker capsule uses an internal worker network and a separate TLS-intercepting mitmproxy sidecar attached to both internal and egress networks.
`HTTP_PROXY` and `HTTPS_PROXY` are convenience routing settings, not the containment boundary; the internal Docker network removes the worker's direct egress route.
The worker runs non-root with a read-only root, dropped capabilities, no-new-privileges, a read-only project bind, and a `noexec,nosuid` 16 MiB scratch tmpfs.
The conformance command records approved Node and mitmproxy index/arm64 manifest digests separately from measured local image IDs, Docker executable/context/version/platform values, the built worker image ID, and the OpenCode executable digest/version.
The proxy accepts only bodyless HTTPS `GET` and `HEAD` requests to exact configured domains after resolving every flow to global addresses and pinning the upstream connection to the checked address.
It denies plaintext HTTP, private CONNECT targets, protocol upgrades and WebSockets, read requests with bodies, writes, failed DNS, and any private, loopback, link-local, multicast, metadata, unspecified, documentation, or reserved IPv4/IPv6 result.
mitmproxy raw TCP fallback is disabled, and both raw TCP lifecycle hooks kill any flow that nevertheless reaches them.
Redirect targets and every subsequent flow are checked again.
HTTPS method enforcement depends on the mounted mitmproxy CA and decrypted HTTP requests; proxy environment variables and CONNECT destination allowlisting are not treated as containment or method enforcement.
Allowed internet reads remain an exfiltration channel and are not claimed to be side-effect-free.
The worker receives no GitHub or provider credential.
GitHub broker credentials exist only in the host effect runner environment for one exact granted operation.
The read-only OpenCode role runs in a separate non-root, read-only, network-disabled worker with a sanitized planned-scope repository view mounted read-only and a `noexec,nosuid` 16 MiB scratch tmpfs.
The view contains only planned readable paths, excludes planned forbidden paths, rejects symlink traversal, and records a content revision digest in journal evidence.
Typed text and `read`, `glob`, or `grep` model turns cross the supervised Docker process stream to a host `ModelBroker`; all other OpenCode tools are denied.
No general proxy POST permission, host HOME, provider credential, arbitrary executable, argument vector, working directory, shell, or writable worktree is exposed.
OpenCode version and executable digest are measured in the named execution container before model work, and container and image absence are inspected after cleanup before success is claimed.
Pushes run from a broker-owned bare repository with isolated HOME/XDG and fixed Git configuration, disabled hooks/helpers/external programs, no caller local config, exact source-object verification, fast-forward proof, and an expected-old-OID lease.
The production broker pins `/usr/bin/git` to SHA-256 `97be7fb98d7272d97ca3034740883a93c12c5a438b313fd618a80aca102a3dda` and GitHub CLI `2.76.2` at `/opt/homebrew/Cellar/gh/2.76.2/bin/gh` to SHA-256 `2ee6cbdeee81adabbdd0d379610054d9e55d047067ff70401ad2fa5b5b3f9e0d` before credential resolution.
Cleanup failure is journaled as uncertain and turns an otherwise completed conformance result into failure.

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
