# Codex and Claude Code Harness Adapters - Design

## Context

Zentra's shared contracts already recognize four harness identifiers: `opencode`, `claude_code`, `codex`, and `deterministic` (a fixture-only value used for tests).
The Model Sheet parser (`src/policy/model-sheet.ts`) accepts `claude_code` and `codex` rows today, but nothing executes them.
Only `opencode` has a real runtime path: `OpenCodeWriter` spawns the `opencode` CLI as a supervised subprocess for the implementer role.
This design adds real runtime adapters for the Codex CLI (`codex`, npm package `@openai/codex`) and the Claude Code CLI (`claude`, npm package `@anthropic-ai/claude-code`), and generalizes the CLI, routing, and writer plumbing so an operator can select any of the three harnesses at execution time without code changes.

## Scope

A "harness runtime adapter" in this codebase is not one thing.
Tracing how `harness` is actually used across the four milestone roles (planner, researcher, implementer, reviewer) shows that only the implementer/writer role ever dispatches by harness.
Planner, researcher, and reviewer roles always run through a separate mechanism, an Azure OpenAI `ModelBroker` calling the model's API directly inside a Docker container for read-only isolation (`src/agents/opencode-read-only-program.ts`, `src/capsule/opencode-read-only-capsule.ts`).
The `harness` field on those role assignments is set but never consulted to choose an execution path for them.

This project therefore covers exactly three components, per harness, for the implementer/writer role only:

1. **Attestation** - verify the executable's identity (SHA-256 and version) before trusting it.
2. **Probe** - a cheap pre-flight check that the configured executable and model actually work before scheduling real work.
3. **Writer** - the security-critical component that runs real tasks and captures a proposed patch.

**Explicitly out of scope:**

- Planner, researcher, and reviewer roles. They remain on the existing Azure ModelBroker/Docker read-only path regardless of which harness label is attached to them.
- Per-task harness dispatch inside the deeper scheduling engine (`src/orchestration/multi-writer-scheduler.ts`, `src/orchestration/opencode-single-file-tracer-bullet.ts`). That engine already threads `model.harness` into its durable batch record for journaling, which is good evidence the registry introduced here is the right shape for it to eventually use, but wiring the scheduler itself to dispatch per task by harness is a separate future project. This design's CLI surface targets `milestone run`, which is the concrete command that currently hardcodes a single harness for the whole milestone plan and requires explicit executable attestation.

## Why this isn't just "call a different binary"

Zentra's writer security model is enforced at the tool-permission layer, not by asking the model nicely.
`OpenCodeWriter` configures OpenCode so the model's own `edit`, `bash`, `webfetch`, and `task` tools are hard-denied (`permission: { edit: "deny", bash: "deny", ... }` in `writerConfiguration()`).
The model cannot touch disk or a shell.
Its only way to "make a change" is to emit a `zentra.patch_proposal` JSON blob as text output, which Zentra validates against a strict schema (`src/contracts/writer-patch.ts`: path uniqueness, per-file byte limits, content digests, a proposal-level digest) before that proposal is ever eligible for merge by a separate integration step.
That is what makes `shellAuthority: none` and `patchProtocol.mutationTools: denied` true guarantees instead of documented intentions.

Codex CLI and Claude Code CLI do not speak this protocol natively.
Research against both CLIs' current source and documentation (2026-08-08) confirmed the following.

**Claude Code** fully supports matching this rigor.
`--disallowedTools Edit Write NotebookEdit Bash WebFetch WebSearch Task` is a genuine hard block enforced by Claude Code itself, not the model ("Permission rules are enforced by Claude Code, not by the model").
A bare tool name in a deny rule removes the tool from the model's context entirely.
`--mcp-config` plus `--strict-mcp-config` lets Zentra load a custom MCP server as the model's only remaining actionable tool.

**Codex** mostly matches, with one real gap.
`features.shell_tool = false` structurally removes the shell tool from the model's tool schema.
But `apply_patch`, Codex's file-edit tool, is wired to the model's own metadata rather than a user-facing toggle, and OpenAI has explicitly declined to add a way to remove it (GitHub issue [#8161](https://github.com/openai/codex/issues/8161), closed as not planned).
The mitigation is to neuter it rather than remove it: `sandbox_mode = "read-only"` plus `approval_policy = "never"` means every `apply_patch` write attempt auto-fails.
The model can call the tool, but it can never succeed.
This is an accepted design tradeoff for this project: the outcome (no unauthorized writes, ever) matters more than whether the tool is absent from the schema.

## Security model decision

For both harnesses, Zentra:

1. Hard-denies every built-in tool that could mutate the filesystem, execute a shell command, or make an arbitrary outbound network call.
2. Exposes exactly one additional tool, a Zentra-owned `propose_patch` MCP tool, as the model's only way to express an intended change.
3. Never trusts the harness's own claims about what changed. The proposal is captured directly by Zentra's own MCP server at the moment of the tool call, validated against the same schema OpenCode's proposals already use, and digested before anything downstream considers it.
4. Accepts, for Codex specifically, that `apply_patch` remains visible to the model but is configured to always fail closed rather than being structurally absent.

## Architecture

### Shared types and dispatch

- `HarnessId = "opencode" | "claude_code" | "codex"` becomes an explicit shared type (today it exists only implicitly as the `HARNESSES` set in `model-sheet.ts`).
- `OpenCodeWriterRequest`, `OpenCodeWriterReport`, and `OpenCodeWriterDispatchBinding` are renamed to `WriterRequest`, `WriterReport`, and `WriterDispatchBinding`. Their content is already harness-agnostic; only the names say "OpenCode."
- A new `HarnessWriter` interface:

  ```ts
  interface HarnessWriter {
    prepare(request: WriterRequest): Promise<PreparedWriterRequest>;
    execute(prepared: PreparedWriterRequest, signal: AbortSignal): Promise<WriterReport>;
  }
  ```

  `OpenCodeWriter` is refactored to implement this interface with no behavior change. `ClaudeCodeWriter` and `CodexWriter` are new implementations. Each writer keeps its own opaque prepared-request shape and its own `WeakSet`-based "prepared by this trusted adapter" guard, exactly as `OpenCodeWriter` does today. That guard is a real security mechanic, preventing a forged prepared request from skipping binding computation, and is not boilerplate to unify away.
- A `HarnessWriterRegistry` (`get(harness: HarnessId): HarnessWriter`) resolves which writer to invoke. `InstalledMilestoneRunner` asks the registry for the writer matching the operator's chosen `--harness` and uses it for the implementer role.
- Mechanical widening of existing literals:
  - `src/routing/model-router.ts`: `RouteApprovedModelRequest.harness` widens from the literal `"opencode"` to `HarnessId`.
  - `src/routing/routing-events.ts`: `harness: z.literal("opencode")` widens to `z.enum(["opencode", "claude_code", "codex"])`.
  - `src/orchestration/writer-worktree-capsule.ts:466`: the `task.roleAssignment.harness !== "opencode"` guard is replaced with a check against a shared `EXECUTABLE_HARNESSES` set, so adding a future harness does not require hunting down every string comparison by hand.

### Shared `propose_patch` MCP server

- **Transport**: MCP's streamable-HTTP transport, bound to `127.0.0.1` on an OS-assigned ephemeral port, started by the orchestrator itself immediately before spawning the harness CLI. It is not a stdio server the harness spawns as its own child process. Hosting it in-process keeps Zentra's supervised child process count at exactly one (the harness CLI), and the received tool call is captured directly in memory with no serialization boundary or extra process to reason about.
- **Auth and isolation**: a random per-task bearer token, passed to the harness through its MCP config by reference to an environment variable so the token is never written to a config file on disk. Any request missing the exact token is rejected. The server accepts at most one successful call; further calls are rejected. It binds to loopback only and is torn down the moment the harness process exits, regardless of outcome.
- **Schema reuse**: the tool's input schema is exactly `PatchProposalBodySchema` from `src/contracts/writer-patch.ts`. No new schema is introduced. `buildWriterPatchProposal` computes the digest on receipt, identical to how a proposal is built today.
- **The "no-op" outcome is expected, not an error**: neither CLI has a "must call this tool" primitive. The model can legally respond without calling `propose_patch` at all. `WriterReport.patchProposal` staying `null` is a valid outcome, exactly as it already can be for `OpenCodeWriterReport` today. A payload that fails schema validation returns a proper MCP tool error to the model and sets `protocolFailure` on the report, mirroring OpenCode's existing `invalid_native_event_stream` mechanic.

### `ClaudeCodeWriter` adapter

- **Invocation shape**:

  ```
  claude -p <prompt>
    --output-format json
    --model <model.model>
    --disallowedTools Edit Write NotebookEdit Bash WebFetch WebSearch Task
    --mcp-config <inline JSON: url + bearer token env var reference>
    --strict-mcp-config
    --append-system-prompt "<protocol: propose_patch is the only way to make a change, call it at most once>"
    --bare
    --settings <generated settings.json>
  ```

  `cwd` is the assigned worktree. No `--add-dir` is passed; nothing outside the worktree is ever exposed. `Task` is denied alongside the mutation and network tools, since it is Claude Code's subagent-spawning tool and an undenied subagent could otherwise acquire its own independent tool grants.
- **Environment**: `ANTHROPIC_API_KEY` from a new `ZENTRA_LIVE_CLAUDE_CODE_API_KEY`-style variable, and `CLAUDE_CONFIG_DIR` pointed at `request.home`, never the operator's real `~/.claude`.
- **No forbidden-path checking inside the writer itself**: this is consistent with `OpenCodeWriter`, which also does not check `ownedPaths`/`forbiddenPaths` at this layer. `extractWriterPatchProposal` only validates that a proposal is well-formed. Path and ownership enforcement happens downstream, harness-agnostically, after the proposal is returned. `ClaudeCodeWriter`'s responsibility is identical to `OpenCodeWriter`'s: capture what the MCP server received, run it through `buildWriterPatchProposal`, and return it.
- **Report mapping**: the `--output-format json` result object (`SDKResultMessage`) maps directly onto `WriterReport`. `subtype`/`is_error` determine `outcome`. `usage`/`total_cost_usd` map onto `WriterUsage` on a best-effort basis (Claude Code has no distinct "reasoning tokens" bucket; that field is left at zero). `permission_denials` maps directly onto `deniedToolRequests`, which is simpler than OpenCode's approach of scanning a raw event stream for denial markers.

### `CodexWriter` adapter

- **Invocation shape**:

  ```
  codex exec --json
    -s read-only
    -c approval_policy=never
    -c features.shell_tool=false
    -c mcp_servers.zentra_writer.url=<ephemeral server URL>
    -c mcp_servers.zentra_writer.bearer_token_env_var=ZENTRA_WRITER_MCP_TOKEN
    -c mcp_servers.zentra_writer.required=true
    -c model_instructions_file=<protocol file>
    -C <worktree>
    -m <model.model>
    --skip-git-repo-check
    "<prompt>"
  ```

  `features.shell_tool=false` removes the shell tool structurally, confirmed at the source level, not merely sandboxed. `sandbox=read-only` combined with `approval_policy=never` means every `apply_patch` write attempt fails closed. `required=true` on the MCP server config means `codex exec` exits non-zero immediately if the server is unreachable, instead of silently proceeding with `apply_patch` as the only remaining path.
- **A real risk to name rather than assume away**: Codex reads the target repository's own `AGENTS.md` from the worktree and appends it to the request, confirmed at the source level, even in `codex exec`. Since the worktree is a checkout of whatever repository the task targets, that file's content is effectively untrusted, repository-authored input, not operator-authored input. The mitigation is not suppressing it. `AGENTS.md` is prompt content, while the tool-denial, sandbox, and approval settings are config-level, so nothing in `AGENTS.md` can escalate actual tool authority. This mirrors the trust boundary Zentra already draws for planner and researcher output through `UntrustedEvidenceHandoff`: contextual input that never grants authority.
- **Output parsing**: `--json` emits typed JSONL events. `turn.completed` carries usage data mapped onto `WriterUsage`. `turn.failed` or a top-level `error` event maps to `outcome: "failed"`, since Codex's exit codes are binary (0 or 1) and do not distinguish failure kinds on their own. Any `item.completed` showing an attempted and blocked `apply_patch` or shell call becomes a `deniedToolRequests` entry, the same role this field plays for OpenCode today. The actual patch still comes from the MCP server's direct capture, not from parsing an MCP tool call out of the JSONL stream.
- **Environment**: `OPENAI_API_KEY` from a new `ZENTRA_LIVE_CODEX_API_KEY`, and `CODEX_HOME` pointed at `request.home`.

### Attestation and Probe generalization

Both are small, mechanical generalizations of existing code, with no new design questions.

- **Attestation** (`attestHostOpenCode` becomes `attestHostHarnessExecutable`): identical core logic, hash the executable, run it with `--version`, hash it again, compare against the operator-attested digest and version. Already harness-agnostic except for the function name. This design assumes `claude --version` and `codex --version` behave like standard version flags; that will be verified empirically against the real installed binaries during implementation.
- **Probe** (`OpenCodeProbe` generalized): `OpenCodeProbeReport.harness` is already typed as `string | null` rather than a literal, so only the `"harness_not_opencode"` failure reason needs renaming, to `"harness_mismatch"`. The probe invocation for Claude Code and Codex reuses the same "deny everything" shape as their writers, since a probe never proposes changes and does not need MCP wiring, only confirmation that the executable runs and the configured model responds correctly before a writer is trusted with real work.

## CLI and environment changes

- **`milestone run`**: add `--harness <opencode|claude_code|codex>` as a required option, consistent with this command's existing style of requiring and eagerly validating every input. Rename the executable-attestation flags from `--opencode`, `--opencode-home`, `--opencode-sha256`, and `--opencode-version` to generic `--harness-executable`, `--harness-home`, `--harness-sha256`, and `--harness-version`. The validation logic is unchanged, only the flag names and the harness they apply to. This is a breaking rename; `docs/commands.md` is the only place outside the CLI itself that references the old names.
- If the API key environment variable required for the selected harness is missing, `milestone run` fails fast with a `CliFailure` before spawning anything.
- **`createInstalledMilestonePlan`**: the four hardcoded `harness: "opencode"` role assignments become `harness: options.harness`. Only the implementer role's harness field is actually consulted for dispatch; planner, researcher, and reviewer keep it as a label.
- **`InstalledMilestoneRunner`**: `openCodeExecutable`, `openCodeHome`, `openCodeExpectedSha256`, and `openCodeExpectedVersion` become generic `harnessExecutable`, `harnessHome`, `harnessExpectedSha256`, and `harnessExpectedVersion`, plus a new `harness: HarnessId` field. The runner resolves the right writer, attestor, and probe from the `HarnessWriterRegistry` instead of hardcoding OpenCode's.
- **`.env.example`**: new `ZENTRA_LIVE_CLAUDE_CODE_API_KEY` and `ZENTRA_LIVE_CODEX_API_KEY`, plus test-only `ZENTRA_LIVE_CLAUDE_CODE_{EXECUTABLE,HOME,SHA256,VERSION,E2E}` and equivalent `ZENTRA_LIVE_CODEX_*` variables, mirroring the existing `ZENTRA_LIVE_OPENCODE_*` block. These gate the live-CLI integration tests and are separate from the CLI's own `--harness-*` flags used by real operators.
- **Model sheet**: no changes needed. It already accepts `claude_code` and `codex` rows; they have simply been inert until now.

## Testing strategy

Three layers, matching the shape of the existing OpenCode tests.

1. **Unit tests with a fake `WorkerAdapter`**, mirroring `opencode-writer.test.ts`: canned `WorkerResult` payloads shaped like Claude Code's `--output-format json` output and Codex's JSONL events drive `ClaudeCodeWriter`, `CodexWriter`, attestation, and probe tests with no real process spawned. These verify report mapping, the prepared-request `WeakSet` guard, argv redaction, and usage and `deniedToolRequests` mapping.
2. **Unit tests for the MCP server itself**: start it in-process and drive it with a real MCP client call, verifying successful capture and digest, rejection of a second call after the first succeeds, rejection of a request with the wrong bearer token, rejection of an oversized or malformed payload, and the "never called" no-op path.
3. **Live-gated integration tests** (`ZENTRA_LIVE_CLAUDE_CODE_E2E`, `ZENTRA_LIVE_CODEX_E2E`, both off by default, matching the existing `ZENTRA_LIVE_OPENCODE_E2E` convention): a happy-path run against the real binaries, and an adversarial test that explicitly instructs the live model to attempt writing a file directly or invoking a shell command, proving the hard-denial holds against real model behavior rather than only against how the configuration was parsed. This adversarial test is the one that actually validates the security claim this design rests on, and it should be treated as a required part of each adapter's test suite, not an optional extra.

## Delivery phases

Each phase is independently shippable and testable.

1. **Phase 1**: shared plumbing. `HarnessId`, the `HarnessWriter`/`WriterRequest`/`WriterReport` renames, `HarnessWriterRegistry`, the `propose_patch` MCP server built and tested standalone, routing and type widening, and attestation/probe generalization. `OpenCodeWriter` is refactored to implement `HarnessWriter` with no behavior change; all existing tests must keep passing unchanged.
2. **Phase 2**: `ClaudeCodeWriter`, plus CLI wiring for `--harness claude_code`.
3. **Phase 3**: `CodexWriter`, plus CLI wiring for `--harness codex`.

Phases 2 and 3 both depend on Phase 1's interfaces and cannot start before it lands, but are independent of each other and can be built in either order.

## Cross-cutting error handling

- Missing API key for the selected harness: the CLI fails fast before spawning anything.
- Executable digest or version drift between the pre- and post-attestation hash: a hard failure, unchanged from today's behavior.
- MCP server unreachable: fail-closed and explicit for Codex through `required=true`. For Claude Code, whether `-p` mode fails or silently degrades when `--mcp-config` points at an unreachable server is an open question, called out below.
- Malformed `propose_patch` payload: the MCP tool call returns a schema validation error to the model, and the report marks `protocolFailure`.
- No proposal ever received: a valid `null` outcome, not a failure, since neither CLI has a "must call this tool" primitive.
- Timeout or cancellation: unchanged, using the existing `ProcessSupervisor` and `AbortSignal` path.

## Explicitly out of scope

- Planner, researcher, and reviewer roles remain on the Azure ModelBroker and Docker read-only path regardless of harness.
- Per-task harness dispatch inside `multi-writer-scheduler.ts` and `opencode-single-file-tracer-bullet.ts`. `milestone run --harness` selects one harness for the whole simplified single-file milestone plan. The registry introduced here is general enough to support real per-task dispatch later, but wiring the scheduler engine itself is a separate future project.

## Open items to verify during implementation

- Whether Claude Code's `-p` mode has an equivalent to Codex's `mcp_servers.required = true`, or whether it silently proceeds without a configured server that failed to start. If there is no such primitive, `ClaudeCodeWriter` needs its own pre-flight health check against the MCP server before launching the CLI, rather than trusting Claude Code to fail closed.
- The exact `--version` output format for the real installed `claude` and `codex` binaries.
- Whether `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, when pointed at `request.home`, leave any session or authentication state that could leak across concurrent writer tasks sharing the same home directory, or whether each task needs a freshly created home directory per invocation.
- Both CLIs ship extremely frequently (roughly daily for Claude Code, multiple times a day for Codex, per research conducted 2026-08-08). Pin specific CLI versions operationally, and add a startup self-test that asserts the tool-denial and sandbox behavior this design relies on still holds before trusting it in production, rather than assuming config semantics are stable across upgrades.
