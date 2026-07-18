# Zentra

Zentra is a local-first orchestration kernel that coordinates bounded software-development tasks through durable events, isolated Git worktrees, deterministic validation, independent review, and serialized integration.

The orchestrator owns task lifecycle, execution coordination, evidence, recovery classification, and integration while each configured project continues to own its source, tests, validation commands, protected paths, and release policy.

Zoe is a client of Zentra rather than part of this repository, and Zentra does not own Zoe's voice, memory, personality, attention, email, meeting, personal-operation, or device behavior.

## MVP Boundary

The current MVP runs on one local machine for one user and executes one bounded software-development workflow at a time against one configured Git project.

The `task run` command retains the bundled deterministic tracer bullet for local contract verification.

The `milestone run` command is the installed real-harness workflow: brokered Azure OpenAI planner and researcher roles, an authenticated OpenCode writer in an isolated Git worktree, named validations, an independent brokered Azure OpenAI reviewer, and validated candidate integration.

The planner, researcher, and reviewer run attested OpenCode 1.18.3 in short-lived Docker capsules with sanitized read-only repository views and model turns brokered by the host.
The fixed researcher must retrieve `https://www.iana.org/help/example-domains` once through the governed GET-only HTTPS broker, retain its content digest and provenance, cite its source evidence exactly once, and hand the result to the writer as untrusted guidance.
The installed researcher has a 32,000 input-token budget so its post-tool model turn can include bounded source context; its 2,000 output-token, USD 1 cost, model-turn, tool, request, web-byte, and time limits are unchanged.
The installed planner and reviewer retain their 8,000 input-token limits, and all three read-only roles remain within the required 128,000-token model context.
The installed planner, researcher, implementer, and reviewer each have one 300-second elapsed budget.
For read-only roles, the same journaled execution deadline covers cold Docker image preparation, resource creation, harness attestation, and model turns; preparation does not receive a separate unjournaled allowance.
The governed research request policy remains bounded to a 120-second timeout and cumulative web-time ceiling inside the researcher's overall 300-second task deadline.
The installed required IANA request is additionally bound to one exact `GET` and one outbound request.
After its source event is retained, the trusted capsule removes the research tool from later model turns; a repeated native MCP call receives the same bounded completed reference without another dispatch, source event, or citation requirement.
General planner or researcher policies without a required source retain their configured multi-request allowance.
Zentra creates or verifies the configured integration branch before planning, and installed planner and researcher views are materialized from immutable blobs at that exact integration head.
Every blob identity is recomputed before exposure, so mutable primary-checkout bytes are never labeled as the accepted integration commit and a normal later milestone starts from prior integrated work.
Before any integration-ref creation, Zentra durably registers the exact milestone authority and journals a preparation intent bound to canonical repository and Git-common-directory paths plus their filesystem device/inode identities, the full ref, intended base commit, project, milestone, and correlation identity.
Repository and common-directory identity are remeasured through hardened Git before every ref inspection, mutation, and observation; same-path replacement pauses without touching the replacement repository.
Restart records an exact existing ref without repeating the effect, creates it again only after proving the prior intent had no effect, and pauses with uncertain-effect evidence for contradictory or partial ref state.

The writer runs the exact operator-supplied OpenCode executable on the host with a dedicated explicit home and authority to edit only the configured owned file in its assigned worktree.
Its model tools have no web or general network authority, but OpenCode's own provider transport uses the user's operating-system network authority and is not sandboxed in Trusted-Project mode.

High concurrency, distributed execution, plugin APIs, and Zoe personal capabilities are not included.

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
Local tarballs produced by `npm pack` are the tested installation artifacts, but no supported release-download, upgrade, rollback, or provenance procedure exists yet.

Install dependencies, build, and verify the package from the repository root.

```bash
pnpm install
pnpm build
pnpm package:verify
pnpm package:contents
```

Create a tarball and install it into a new consumer directory.

```bash
npm pack --pack-destination /absolute/path/to/artifacts
mkdir /absolute/path/to/consumer
cd /absolute/path/to/consumer
npm init -y
npm install /absolute/path/to/artifacts/zentra-0.1.0.tgz
./node_modules/.bin/zentra --help
```

For source-checkout development, run the built CLI through the package script.

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
  },
  "releasePreparation": {
    "build": ["/absolute/path/to/node", "scripts/build.mjs"],
    "package": ["/absolute/path/to/node", "scripts/package.mjs"],
    "verify": ["/absolute/path/to/node", "scripts/verify.mjs"],
    "buildTimeoutMs": 300000,
    "packageTimeoutMs": 300000,
    "verifyTimeoutMs": 300000,
    "artifacts": ["dist/example-package.tgz"]
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

`releasePreparation` is optional and available only through the programmatic API.

Its build, package, and verify commands use the same canonical executable and timeout constraints as validation commands.

Artifact entries must be unique safe relative paths to regular nonsymlink files inside the isolated exact-commit release worktree.

Local release preparation never exposes push, tag, publish, pull request, remote release, GitHub broker, or credential capabilities.

Configured release commands are trusted project code executed with the operating-system authority of the user running Zentra.

The reduced environment and exact executable policy do not provide a filesystem or network sandbox, so this capability is restricted to projects the operator controls and trusts.

Successful preparation reports `prepared_local_only` and pauses at the `release_boundary`; `no_release_operations` pauses before worktree or command effects, while `approval_required_for_remote` permits only the local preparation phase before the same pause.

The `project validate` command accepts one configuration object or an array of configuration objects, while the MVP `task run` command requires exactly one configured project because its command contract has no project selector.

## Commands

Validate project configuration and return exit code `0` with one JSON object when every entry is valid.

```bash
pnpm start -- project validate --config /absolute/path/to/zentra.project.json
```

Run the deterministic tracer bullet and return exit code `0` only when the terminal outcome is `completed`.
This command is retained for local deterministic conformance and is separate from the installed OpenCode workflow.

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
The installed milestone command composes that role with the existing OpenCode probe, isolated writer worktree, named validations, independent reviewer, disposable integration candidate, terminal result builder, and Agent Tail projection.
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
The milestone must already exist in the supplied journal, and an executable task assignment must name an approved OpenCode capability matching the exact canonical role tools and network mode.
Planner and researcher roles may add only brokered `web_research` when the model and security sheets both admit its bounded destination policy.
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

Run one fixed planner-to-researcher-to-implementer-to-reviewer milestone from a natural-language goal.

```bash
zentra milestone run \
  --goal "Update the greeting implementation" \
  --config /canonical/path/zentra.project.json \
  --database /canonical/path/zentra.sqlite \
  --model-sheet /canonical/path/MODELS.md \
  --security-sheet /canonical/path/SECURITY-SHEET.md \
  --provider /canonical/path/azure.json \
  --opencode /canonical/path/opencode \
  --opencode-home /canonical/path/opencode-home \
  --opencode-sha256 <operator-measured-lowercase-sha256> \
  --opencode-version "<exact-opencode-version-output>" \
  --agent-tail-jsonl /canonical/path/zentra.jsonl \
  --file src/greeting.ts
```

Every path argument is explicit and canonical.
The command does not resolve fixtures, source checkouts, package-development paths, alternate executables, provider URLs, or provider headers.
Use the executable at `node_modules/.bin/zentra` from an installed tarball for package acceptance.
The provider configuration is strict JSON:

```json
{
  "provider": "azure",
  "endpoint": "https://resource-name.openai.azure.com",
  "deployment": "gpt-5-mini-prod",
  "apiVersion": "2025-04-01-preview",
  "credentialEnv": "ZENTRA_AZURE_OPENAI_API_KEY",
  "timeoutMs": 30000,
  "maxResponseBytes": 4194304,
  "maxInputTokens": 128000,
  "maxOutputTokens": 16000,
  "maxToolCalls": 4,
  "expectedProviderModels": ["gpt-5-mini-2025-01-01"],
  "inputTokenRateUsdPerMillion": "1.25",
  "outputTokenRateUsdPerMillion": "10"
}
```

The endpoint must be one canonical HTTPS origin with exactly one Azure resource label under `.openai.azure.com` or `.cognitiveservices.azure.com`.
User information, paths, queries, fragments, custom ports, IP literals, localhost, private names, arbitrary headers, and non-Azure suffixes are rejected.
Azure sovereign-cloud suffixes, including `.azure.us`, `.azure.cn`, and `.microsoftazure.de`, are unsupported until a separate typed provider configuration explicitly admits their cloud boundary.
Zentra constructs the exact `/openai/deployments/{deployment}/chat/completions?api-version={apiVersion}` URL internally and does not accept a caller-supplied request path or query.
Production model transport performs bounded DNS resolution before dispatch, rejects any private resolution, pins one selected public address, verifies TLS with the Azure hostname as SNI, checks the connected peer, and only then sends the API key and one streaming POST.
It rejects redirects, requires fatal UTF-8 and strict Azure/OpenAI SSE records, and permits only bounded text or envelope-authorized `read`, `glob`, `grep`, and brokered web-research tool calls.
The configured environment credential name must be an uppercase environment identifier and cannot name ambient process-control variables such as `PATH`, `HOME`, or `NODE_OPTIONS`.
The credential is resolved only by the host broker and is not written to the journal, trace, command output, model prompt, or OpenCode capsule.
The expected provider-model list is sorted, nonempty, and exact; a response model outside that allowlist fails even when the requested deployment still matches.
The per-million input and output rates are bounded decimal strings containing at most nine fractional digits and are operator-approved configuration, not provider-reported billing data.
Zentra requires streamed token usage, computes cost in integer nanodollars with conservative rounding, and rejects any configured or task token, tool, response-byte, timeout, or computed-cost excess.
`costUsdNano` is the authoritative measured and aggregated cost in broker receipts, worker observations, shared root-task budgets, replayed projections, and Agent Tail payloads.
`costUsd` remains display metadata, must exactly correspond to `costUsdNano` when both are present, and is never used to authorize measured budget consumption.
Planner, researcher, and reviewer model turns use this host broker.
The host OpenCode writer remains a separate boundary and may use auth already configured inside the exact canonical `--opencode-home` directory.
The writer and probe receive that directory as their minimal `HOME`; they do not inherit ambient `HOME`, arbitrary parent secrets, or the raw broker credential.
Use a dedicated authenticated OpenCode home created for this workflow rather than a general interactive home containing unrelated configuration or credentials.
Before milestone registration, Zentra hashes the canonical host OpenCode executable and invokes its exact `--version` command in the minimal configured home.
The required digest and version are operator consistency attestations that detect substitution or drift; they are not a vendor signature, provenance guarantee, or independent statement that the executable is trustworthy.
The runtime capability probe repeats the version check and executable digest measurement, and the writer rechecks the executable digest immediately before execution.
The environment-gated installed live conformance path uses an actual operator-configured host OpenCode executable and is the acceptance path reserved for issue #75.
Package fixtures attest only their controlled fake executable and are not described as real OpenCode conformance.
The implementer model in `MODELS.md` must be a model identity understood by that OpenCode installation and authenticated home.
The planner, researcher, and reviewer model values must equal the exact configured Azure deployment identity.
The receipt retains that requested deployment as its transport identity, records the allowlisted provider-reported underlying model separately, exposes exact nanodollar cost, and binds the complete non-secret provider configuration through a SHA-256 digest.
That provider-configuration digest is copied into durable evidence provenance.
Cancellation proven before POST dispatch is `cancelled`.
An expired DNS or connection deadline before dispatch is `timed_out`.
After POST dispatch begins, transport rejection, timeout, cancellation, response-size termination, HTTP `408`, HTTP `5xx`, or a `200` stream missing `[DONE]`, usage, or a finish reason is `uncertain` because remote completion or usage is unknown, and it is never retried automatically.
A complete Azure JSON error response for HTTP `4xx`, including authentication, policy, and rate-limit rejection, is `failed` because the provider response proves rejection; a truncated or malformed `4xx` body remains `uncertain`.
Redirects, fully received malformed responses, model drift, invalid tool arguments, disallowed tools, and budget excess are `failed`.

The fixed plan has exactly one planner, one researcher, one implementer, and one independent reviewer selected from unambiguous approved model-sheet capabilities.
Only the explicit `--file`, project validations, configured integration branch, security sheet, and model sheet grant authority.
Goal wording cannot add files, tools, network destinations, credentials, commands, approval, integration targets, or release authority.
The Model Sheet `network: denied` value and durable admission packet describe model tool and web-research authority.
They do not claim that the host OpenCode process lacks provider transport or operating-system network access.
Durable `task.writer_completed` evidence records this split as denied model tools and `user_os_network_authority` harness provider transport.
It also retains a bounded normalized native-event chain with event order, types, digests, byte counts, and cumulative stdout digests.
Raw OpenCode stdout and stderr are explicitly non-retained; diff and validation artifacts remain authoritative effect evidence, and no model or tool activity is inferred without a corresponding native event.
An exit-zero writer must produce at least one complete supported JSON event line; empty, plain, malformed, mixed, incomplete, or delegation output fails before validation or integration.
After a validated handoff, Zentra records an exact reviewer dispatch intent immediately before invoking the reviewer.
Restart before that intent resumes only review, commit, and integration from the retained worktree, diff, and validation evidence without rerunning the writer.
Restart after reviewer, resource, or worker intent produces durable uncertain-effect attention and never retries automatically.
If a safely resumable handoff has a missing, replaced, unregistered, or modified worktree, Zentra retains bounded expected and observed evidence in idempotent `stale_evidence` replanning attention instead of throwing or retrying.
The command always retains Agent Tail JSONL and streams the same JSONL on stdout while running.
Its final compact replay-backed JSON is written to stderr and contains only the command, milestone and project identities, canonical terminal outcome, and trace path/outcome.
Standard output bytes are the retained trace bytes, so consumers can validate JSONL incrementally and compare the completed stream byte-for-byte with `--agent-tail-jsonl`.
Exit codes are `0` for `completed`, `1` for failed, nonterminal, or trace failure, `2` for `cancelled`, `3` for `denied`, and `4` for `timed_out`.
The production CLI owns and closes both the trace sink and SQLite journal on every path.
The package root does not export the CLI runtime, provider transport, broker implementation, credential-bearing Fetch seam, or capsule-construction seam.
Hermetic packed tests invoke the installed binary with test-only interception to exercise failure paths without provider traffic.
The separate live package smoke test forbids preload, fetch, capsule, and OpenCode substitution and exercises the real fixed endpoint, Docker capsule, OpenCode executable, and authenticated OpenCode home.
There is no product option for an arbitrary provider URL, headers, transport, or capsule implementation.

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

Docker containment applies to the read-only planner and reviewer capsules, not to configured validations or the host OpenCode writer.
Those host processes run with the same operating-system filesystem and network authority as the user, constrained by direct argument invocation, minimal environments, denied web and general network tools, OpenCode tool policy, exact file ownership checks, review, and disposable-candidate integration rather than by a host sandbox.

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

### Bounded Replanning

The library API can establish a durable authority envelope when registering an accepted milestone plan and can later call `MilestoneRegistry.revisePlan` after execution-informed evidence exists.
Registration appends `milestone.replanning_policy_bound` before `milestone.authority_envelope_established` in the same journal append.
The policy event contains canonical public Security Sheet component digests and bounded counts/enums plus an exact canonical Model Sheet snapshot and digest.
It does not retain raw network destinations or secret-handling prose.
The envelope binds the exact goal, project and milestone identities, aggregate ownership and budget ceilings, forbidden scope, authority and role/harness boundaries, Security Sheet digest, network and release boundaries, and the exact Model Sheet capability set.
Model-backed tasks fail closed when no Model Sheet is supplied, and admission must match the pinned capability's role, harness, tools, network, context, authority, and transport identity.

An accepted in-bound request appends `milestone.plan_revised` with the complete revised acyclic plan and immutable references to prior strictly parsed evidence in the same milestone stream.
Completed successful tasks may be carried unchanged without rerunning, removed failed attempts remain visible in `historicalTasks`, and `planHistory` plus `revisions` retain deterministic ancestry.
Replacing a failed terminal task requires an explicit old-task to new-task supersession relation retained in revision history.
The latest active plan governs milestone completion.

Stale, malformed, forged, expanded, security-changing, active-effect, or uncertain-effect requests append one bounded `milestone.paused` replanning attention instead.
The attention contains only canonical identities, digests, and the violated dimension; it does not copy plan, policy, evidence, or secret bodies.
Paused milestones cannot project later readiness, worker, resource, or effect events.
An exact `abandon_candidate` decision appends `milestone.replanning_resolved`, preserves the attention in history, grants no authority, and restores the unchanged current plan for a fresh bounded request.

`ProjectingEventJournal` writes accepted revision, pause, and resolution events to Agent Tail JSONL after the SQLite append.
Agent Tail receives only revision identities, digests, evidence references, and supersession metadata rather than the journal's full plan descriptions, goals, or paths.
SQLite remains authoritative if that projection fails, and `revisePlan` reports the projection failure separately through `traceProjectionFailed`.
`EventJournal.append` is trusted infrastructure and does not perform domain authorization itself, while milestone replay rejects histories whose policy, envelope, capability, revision, evidence, or resolution events are internally inconsistent.
There is intentionally no installed replanning CLI in this release.

## Tests

Run the complete test suite, type check, build, and built CLI help verification from the repository root.

```bash
pnpm test
pnpm check
pnpm build
pnpm package:verify
pnpm package:contents
pnpm start -- --help
```

The CLI integration tests create real temporary Git repositories and exercise deterministic task execution, caller-selected reviewer rejection, retained-patch byte limits, exact journal replay, recovery decisions, unsafe input rejection, stable JSON and exit codes, secret redaction, signal cancellation, and the built help entry point.

Run the Docker-gated OpenCode capsule test when Docker Desktop and the approved OpenCode capsule prerequisites are available.

```bash
pnpm exec vitest run tests/capsule/opencode-read-only-capsule.test.ts
pnpm exec vitest run tests/capsule/docker-capsule.e2e.test.ts
```

Run the final installed-package smoke only with a real Azure OpenAI deployment and credential, a canonical OpenCode executable, a dedicated canonical authenticated OpenCode home, operator-attested executable identity, and an explicit implementer model.
Use `.env.example` as the complete Azure-only prerequisite name list; it intentionally contains no credentials.

```bash
ZENTRA_LIVE_OPENCODE_E2E=1 \
ZENTRA_LIVE_AZURE_OPENAI_API_KEY='<redacted>' \
ZENTRA_LIVE_AZURE_OPENAI_ENDPOINT=https://resource-name.openai.azure.com \
ZENTRA_LIVE_AZURE_OPENAI_DEPLOYMENT=gpt-5-mini-prod \
ZENTRA_LIVE_AZURE_OPENAI_API_VERSION=2025-04-01-preview \
ZENTRA_LIVE_AZURE_OPENAI_EXPECTED_PROVIDER_MODELS=gpt-5-mini-2025-01-01 \
ZENTRA_LIVE_AZURE_OPENAI_INPUT_TOKEN_RATE_USD_PER_MILLION=1.25 \
ZENTRA_LIVE_AZURE_OPENAI_OUTPUT_TOKEN_RATE_USD_PER_MILLION=10 \
ZENTRA_LIVE_OPENCODE_EXECUTABLE=/canonical/path/to/opencode \
ZENTRA_LIVE_OPENCODE_HOME=/canonical/path/to/dedicated-opencode-home \
ZENTRA_LIVE_OPENCODE_SHA256='<redacted-lowercase-sha256>' \
ZENTRA_LIVE_OPENCODE_VERSION='<redacted-exact-version-line>' \
ZENTRA_LIVE_IMPLEMENTER_MODEL=opencode-provider/implementer-model \
pnpm exec vitest run tests/package/installed-milestone-live.e2e.test.ts
```

`ZENTRA_LIVE_OPENCODE_SHA256` is the expected lowercase SHA-256 of the exact canonical executable, and `ZENTRA_LIVE_OPENCODE_VERSION` is the exact single-line identifier produced by `opencode --version` after trimming its line ending.
These values are operator-provided identity evidence and are shown redacted here; matching them proves consistency with the operator's expectation, not a vendor signature, notarization, or supply-chain provenance claim.
Before creating the package or any project, Git, Docker, or provider effect, the test computes the executable digest and runs bounded `--version` with the dedicated home, failing on any mismatch without printing the configured values.
It repeats the same operator-identity check immediately before invoking the installed workflow; Zentra's production probe then measures the executable used at runtime, and the writer rejects an executable change after that probe.
The test performs no OpenCode, capsule, fetch, preload, provider endpoint, or executable substitution.
The live test then packs Zentra, installs it into an empty consumer, invokes the installed binary, validates a concurrently nonterminal SQLite milestone snapshot when live stdout JSONL first arrives, compares stdout with the retained trace byte-for-byte, replays terminal status, verifies only the owned file reached the integration branch, proves ticket and candidate worktrees and branches were removed, scans retained evidence for credential and source-checkout leakage, and confirms all recorded capsule resources are absent.
When `ZENTRA_LIVE_OPENCODE_E2E` is unset, empty, or exactly `0`, the test reports a gated skip that does not satisfy final live acceptance.
When the gate is `1`, every prerequisite is mandatory and a missing or invalid value fails the test rather than skipping.
Any other nonempty gate value is invalid and fails the test rather than silently skipping.
`ZENTRA_LIVE_KEEP_ARTIFACTS=1` is accepted only when the live gate is exactly `1`.
It preserves the temporary live root on test failure and prints only that root path; the default is cleanup, and successful runs are always cleaned.
Installed CLI failures report only allowlisted lifecycle fields plus stdout/stderr SHA-256 digests and byte counts, never raw output, credentials, prompts, model text, or paths parsed from output.
