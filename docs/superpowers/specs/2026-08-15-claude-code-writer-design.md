# Phase 2: the `ClaudeCodeWriter` runtime adapter

**Date:** 2026-08-15
**Issue:** #131 (adversarial live test: #132; epic: #130)
**Depends on:** Phase 1 (PR #128), Phase 1.5 (PR #129), issues #133 and #134 (PR #137)
**Decision record:** `docs/design/harness-adapters-decision-record.md`, D24 through D28

## Summary

Phase 1 built the shared plumbing and Phase 1.5 proved a second writer can plug into it.
Neither shipped a writer that talks to a real harness.
This phase adds `ClaudeCodeWriter`, the first concrete runtime adapter, and wires the `propose_patch` MCP server that has been dead code since Phase 1.

The design below differs from the approved Phase 1 spec in three places.
Each difference exists because the real binary was measured rather than trusted, and each is recorded as a decision in D24 through D28.

## What changed against the Phase 1 spec

The Phase 1 spec assumed a tool deny-list at the harness's own permission layer was sufficient, that `--output-format json` carried enough signal, and that MCP misconfiguration would fail closed.
Measurement against Claude Code 2.1.207 contradicted all three.

**Hooks execute outside the tool-permission model.**
A `PreToolUse` hook in a project-level `.claude/settings.json` ran `touch HOOK_FIRED` during a session whose only tool call was a `Read` that was denied.
`Bash` was never invoked and never needed to be.
Because the writer's cwd is the worktree under edit, any repository carrying a `.claude/settings.json` would have obtained arbitrary command execution inside the writer capsule, bypassing `propose_patch` entirely.
This was a live hole in the approved design.

**The deny-list was incomplete and cannot be made complete by enumeration.**
With the specified `Edit,Write,Bash,WebFetch,Task` deny-list, the `system:init` event still advertised `NotebookEdit`, which writes files.
The advertised set also varied between runs under identical flags.

**An unreachable MCP server does not fail the run.**
Against a dead endpoint with `--strict-mcp-config`, the run reported `is_error: false`, `subtype: "success"`, `terminal_reason: "completed"`, and exit 0.
Under `--output-format json` there is no signal at all.

## Goals

- A `ClaudeCodeWriter` implementing `HarnessWriter`, dispatched through the existing registry for `harness: "claude_code"`.
- The `propose_patch` MCP server wired into a real run, as the only channel through which a change can be expressed.
- Two authentication modes, OAuth by default.
- A live adversarial test that demonstrates the security claim against the real binary rather than asserting it.

## Non-goals

- `CodexWriter`. That is Phase 3 (#135), and it must repeat the measurement rather than inherit these conclusions.
- Widening any read-only role beyond OpenCode. The scope boundary from Phase 1 holds: only the implementer role dispatches by harness.
- Renaming the stale OpenCode-flavored identifiers. That is #136.

## Authentication

Two modes. OAuth is the default because it matches how Claude Code is normally used, and because it keeps long-lived key material out of the child environment.

### The constraint that shapes both modes

`--bare` is the flag that structurally disables hooks, LSP, plugin sync, auto-memory, keychain reads, and CLAUDE.md auto-discovery.
Its help text states that Anthropic auth is then strictly `ANTHROPIC_API_KEY` or `apiKeyHelper`, and a live run confirms it: with OAuth credentials present and `--bare` set, the run fails with `Not logged in`.

**`--bare` and OAuth are mutually exclusive.**
Choosing OAuth as the default therefore rules out the strongest isolation flag, and the isolation it would have provided has to be reconstructed from narrower flags.

### OAuth mode (default)

`HOME` is set to the attested `--harness-home`, a directory the operator prepared by running `claude /login` against it.
No credential passes through Zentra's process environment.

The harness home stays writable, because OAuth token refresh writes to it.
That is the cost of this mode and the reason the isolation profile below is not optional.

### API-key mode

The configured key is placed in the child's explicit environment map as `ANTHROPIC_API_KEY`, and `--bare` is added.
In this mode the isolation profile is belt-and-braces rather than load-bearing.

### What must not happen

`ProcessSupervisor`'s environment allow-list is `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`.
It must not grow to carry harness credentials.
Per D24, a child `claude` that inherits `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` can delegate its permission decisions back to the parent Claude Code session, where they are auto-approved, silently defeating the tool restrictions.
That allow-list is what prevents it, and adding `ANTHROPIC_*` or `CLAUDE_*` to it would pass the delegation socket through whenever Zentra itself runs under Claude Code, which is the normal development and CI condition.

Credentials reach the child only through the caller's explicit environment map, under a name Zentra chooses.

## Isolation profile

Applied in both modes.

| mechanism | flag | what it prevents |
| --- | --- | --- |
| settings sources | `--setting-sources ""` | hook execution from user, project, and local settings |
| MCP isolation | `--strict-mcp-config` | host-user MCP servers reaching the capsule |
| structural tool removal | `--disallowedTools` | the tool existing at all |
| permission-layer denial | `--allowedTools` | use of anything else, and it records the attempt |
| surface verification | init-event check | any tool outside the expected set, from any source |
| MCP health gate | init-event check | running against a capsule that cannot propose a patch |

`--setting-sources ""` was verified to block the hook while leaving OAuth working.
That combination is what makes OAuth mode viable at all.

It is narrower than `--bare`: it governs settings files, so plugins, auto-memory, and CLAUDE.md discovery remain active in OAuth mode.
Plugins are caught by surface verification, because they surface as tools.
Auto-memory and CLAUDE.md discovery are context injection rather than code execution, and are accepted as a residual risk in OAuth mode, absent in API-key mode.

### Why both tool flags

They are not alternatives. Measured in a clean environment:

| | removes the tool | records the attempt |
| --- | --- | --- |
| `--disallowedTools` | yes, it vanishes from `system:init` and a call fails with `No such tool available` | no, `permission_denials` stays empty |
| `--allowedTools` | no, it stays advertised | yes, with `tool_name`, `tool_use_id`, and the full `tool_input` |

Structural removal alone would make breach attempts invisible in the durable receipt, which is precisely what `deniedToolRequests` exists to record.
`deniedToolRequests` is therefore assembled from two sources: `permission_denials` in the result event, and `tool_use_error` results in the stream whose text matches the not-enabled-in-this-context form.

### Surface verification

The expected tool set is `Read`, `Glob`, `Grep`, and `mcp__zentra__propose_patch`.
`ClaudeCodeWriter` reads the `tools` array from the `system:init` event and applies two rules:

- **Any tool outside the expected set aborts the run.** The check is on extras, not on exact equality.
- **`mcp__zentra__propose_patch` must be present.** Its absence aborts, because a run that cannot propose a patch can only produce a false no-op.

A missing `Read`, `Glob`, or `Grep` is tolerated.
This matters in practice: the advertised set was observed to vary between runs under identical flags, with `Glob` and `Grep` moving in and out as tools shifted between loaded and deferred.
Requiring exact equality would produce spurious aborts.

### One unconfirmed literal

The MCP health gate requires every configured server to report connected.
Only the failure case was observed during measurement, which produced `{"name": "zentra", "status": "failed"}`.
The literal for a successful connection was never seen, because no live `propose_patch` server was stood up.

**The gate must be written as an allow-list on the success literal, not a deny-list on `"failed"`.**
A deny-list would treat an unknown third state as healthy, which fails open in exactly the direction this gate exists to prevent.
The first implementation task confirms the literal against a running server and pins it in a fixture.

This is an assertion rather than an assumption on purpose.
A hardcoded deny-list is a snapshot of one version, both CLIs ship near-daily, and a release adding a file-mutating tool would otherwise break the model with no failing test.

## Adapter structure

`src/harnesses/claude-code-writer.ts`, implementing `HarnessWriter`.

### MCP server lifecycle

The server starts in `prepare()`.
It has to, because the endpoint URL carries a dynamically-assigned port and `argvSha256` in the dispatch binding must attest the argv that actually ran.
Starting it in `execute()` would mean moving the URL into a file and losing attestation of the endpoint.

`prepare()` is not guaranteed to be followed by `execute()`.
In `writer-worktree-capsule.ts`, `beginDispatch()` runs between them and throws on a claim conflict.
On that path a server started in `prepare()` would be stranded, still listening and still serving `propose_patch` to anyone holding the bearer token.
That is a security leak, not a resource leak.

**`PreparedWriterRequest` gains a required `dispose(): Promise<void>`.**
The capsule calls it on every path that does not reach `execute()`, and `execute()` calls it in a `finally`.

Required rather than optional, because Phase 1.5 established that an optional security obligation is one an implementation forgets: that is exactly how `FakeHarnessWriter` shipped without the `preparedRequests` guard.
`OpenCodeWriter`'s implementation is a no-op.
The cost is a shared-interface change touching every existing implementation, accepted because it makes the lifecycle explicit before Phase 3 needs the same thing.

### Bearer token delivery

`--mcp-config` expands `${VAR}` in header values.
Verified by capturing the outbound request: `Authorization: Bearer SENTINEL_abc123`, sourced from `ZENTRA_WRITER_MCP_TOKEN` in the child's explicit environment map.

`startWriterProposalMcpServer` already emits `bearerTokenEnvVar` and `bearerTokenValue` for exactly this, and needs no change.

### Invocation

The serialized packet is the prompt argument.
`--append-system-prompt` carries the protocol instructions establishing that `propose_patch` is the only way to express a change.
Output is `--output-format stream-json --verbose`, required by D27 because the MCP status appears only there.

`redactedArgv` must cover the new surface: the packet and the model are already redacted by the OpenCode equivalent, and the MCP config string must not retain the bearer token in the attested argv.

### Where the patch proposal comes from

From the MCP server's `close()` outcome, not from the event stream.

This is the sharpest departure from `OpenCodeWriter`, which extracts it with `extractWriterPatchProposal(result.events)`.
Because the proposal never transits the model's output, a model that emits a patch-shaped blob in its text cannot produce one.
The event stream is still parsed, but only for usage, tool calls, and denials.

## Failure taxonomy

Mapped onto the neutral receipt vocabulary from Phase 1.5.
All values are lowercase tokens of at most 64 characters, so `boundedProtocolFailure` accepts them.

| condition | `outcome` | `protocolFailure` |
| --- | --- | --- |
| an MCP server is not connected at init | `failed` | `mcp_server_unavailable` |
| a tool outside the expected set is advertised at init | `failed` | `unexpected_tool_surface` |
| the stream cannot be parsed | `failed` | `invalid_output_stream` |
| `propose_patch` received an invalid proposal | `failed` | `invalid_patch_proposal` |
| clean run, no proposal made | `completed` with `patchProposal: null` | `null` |

**Where these values survive.**
They are set on `WriterReport.protocolFailure`, which is an open `string`, and they reach the journal through `boundedProtocolFailure`.
They do **not** reach the durable receipt: `normalizeProtocolFailure` collapses every non-null value to `invalid_output_stream`, and the receipt enum admits nothing else.

That is D23's deliberate split, not an oversight.
Do not extend `WriterReceiptBodySchema`'s `protocolFailure` enum to carry them.
The journal is the forensic record that distinguishes a `ClaudeCodeWriter` failure from a `CodexWriter` one; the receipt records only that a protocol failure occurred.

`usageEvidence` is `native` when the result event carries `usage`, and `none` otherwise.
Per D21, `normalizeUsageEvidence` throws on anything unrecognized, so a typo here surfaces as a test failure rather than degrading the durable evidence.

The result event's `usage` maps to `WriterUsage` as `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`.
Claude Code reports no separate reasoning-token count, so `reasoningTokens` is 0.
`toolCalls` is counted from `tool_use` blocks in the stream.

## Testing

### Unit, no credentials

Stream parsing against fixtures recorded from 2.1.207 during this session's measurement, including the `system:init` event with `mcp_servers: [{"status": "failed"}]`, a `permission_denials` entry with a populated `tool_input`, and the `tool_use_error` text produced for a structurally-removed tool.

Every mapping is proven to discriminate by reverting it and observing the test fail, per the standing practice.

### Integration, no credentials

Against the real `startWriterProposalMcpServer`:

- a proposal arriving through `propose_patch` reaches `WriterReport.patchProposal`
- a second `propose_patch` call is rejected
- an invalid proposal yields `invalid_patch_proposal`
- `dispose()` on the `beginDispatch`-throws path closes the socket

The last is asserted by confirming the port stops accepting connections, not by confirming `dispose` was called.

### Live adversarial, gated (#132)

Gated on `ZENTRA_LIVE_CLAUDE_CODE_E2E` plus credentials.
Four assertions against the real binary:

1. A writer instructed to edit a file directly produces no filesystem change in the worktree, and the attempt appears in `deniedToolRequests`.
2. A worktree containing a hostile `.claude/settings.json` hook does not execute it.
3. A writer that legitimately proposes a change produces a `patchProposal` sourced from the MCP server.
4. An unreachable MCP server aborts before the first turn rather than completing successfully.

Assertion 2 is the regression test for the hole found on 2026-08-15.
It must fail if `--setting-sources ""` is dropped, and that must be proven by dropping it.

The suite skips when credentials are absent and reports that it skipped, so an empty run cannot be mistaken for a passing one.
Live tests pin Haiku and keep prompts minimal to bound cost.

## Risks

**The measurements are version-pinned.**
Everything here was measured against 2.1.207 on 2026-08-15.
Claude Code ships near-daily.
The surface verification in D26 is the structural defense: it converts a silent behavior change into a loud failure.

**OAuth mode carries residual context-injection exposure.**
Auto-memory and CLAUDE.md discovery remain active because `--setting-sources ""` does not cover them and `--bare` is unavailable.
Accepted, documented, and absent in API-key mode.

**`dispose()` is a breaking interface change.**
Every `HarnessWriter` implementation and every test double must be updated. The package is private with no external consumers.

## Stop conditions

Report and stop rather than widening scope if:

- the isolation profile cannot block the hostile-hook test, which would mean `--setting-sources` is not the control it appeared to be
- surface verification cannot be made stable because the advertised tool set varies for reasons unrelated to configuration
- `dispose()` cannot be threaded through the capsule without changing the dispatch-authority sequence, which is security-critical and out of scope for this phase
