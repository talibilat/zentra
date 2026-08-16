import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCodeWriter } from "../../src/harnesses/claude-code-writer.js";
import { EXPECTED_SERVER_NAME } from "../../src/harnesses/claude-code-stream.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { appendSupervisedWriterReceipt, PathClaimService } from "../../src/workspaces/path-claims.js";
import type { WorkerAdapter, WorkerResult } from "../../src/workers/worker-adapter.js";
import type { WriterDispatchBinding, WriterRequest } from "../../src/harnesses/harness-writer.js";

const PROPOSE_TOOL = "mcp__zentra__propose_patch";

function init(tools: readonly string[], status = "connected"): unknown {
  return { type: "system", subtype: "init", tools, mcp_servers: [{ name: "zentra", status }] };
}

/**
 * Like init(), but for the mcp_servers shapes init() cannot produce: an empty
 * array, or the key omitted entirely. Both read as "no server at all" and
 * are what distinguishes expectedServerConnected from the stale
 * disconnectedServers.length > 0 check - an empty/absent mcp_servers never
 * populates disconnectedServers, so that check would read it as healthy.
 * `tools` still advertises the propose tool, matching the real binary's
 * documented behavior of reporting an empty mcp_servers array while a
 * misconfigured client can still list stale tool names.
 */
function initWithMcpServers(tools: readonly string[], mcpServers: readonly unknown[] | "absent"): unknown {
  const base: Record<string, unknown> = { type: "system", subtype: "init", tools };
  if (mcpServers !== "absent") base["mcp_servers"] = mcpServers;
  return base;
}

const OK_RESULT = { type: "result", subtype: "success", is_error: false, permission_denials: [] };

/**
 * Supervisor that replays canned events and optionally calls the live MCP
 * server first. rawStdout must end on an event boundary (a trailing "\n")
 * for createWriterEventChain to accept it - real `claude -p --output-format
 * stream-json` output always ends this way.
 */
function scriptedSupervisor(
  events: readonly unknown[],
  onExecute?: (argv: readonly string[], env: Readonly<Record<string, string>>) => Promise<void>,
): WorkerAdapter {
  return {
    async execute(request): Promise<WorkerResult> {
      await onExecute?.(request.args, request.environment ?? {});
      const rawStdout = events.length === 0 ? "" : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      return {
        outcome: "completed", exitCode: 0, events, stdout: rawStdout, rawStdout, stderr: "",
      };
    },
  };
}

const BASE_REVISION = "a".repeat(40);

const directories: string[] = [];
const clientsByUrl = new Map<string, Client>();

afterEach(async () => {
  for (const [, client] of clientsByUrl) await client.close().catch(() => {});
  clientsByUrl.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function canonicalNodeExecutable(): string {
  return realpathSync.native(process.execPath);
}

function workspaceDir(): string {
  const directory = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-claude-code-writer-")));
  directories.push(directory);
  return directory;
}

function writerRequest(dispatchAuthority?: WriterRequest["dispatchAuthority"]): WriterRequest {
  const taskId = `task-claude-code-writer-${randomUUID()}`;
  return {
    taskId,
    ...(dispatchAuthority === undefined ? {} : { dispatchAuthority }),
    executable: canonicalNodeExecutable(),
    model: {
      id: "claude-implementer",
      harness: "claude_code",
      model: "claude-sonnet-4-5",
      roles: ["implementer"],
      specialties: ["coding"],
      costTier: "low",
      contextTokens: 128_000,
      maxConcurrency: 1,
      toolPermissions: ["read_repository", "write_worktree"],
      network: "denied",
      fallbackOrder: [],
      qualityHistory: { successes: 1, attempts: 1 },
    },
    workspace: { taskId, branch: `ticket/${taskId}`, path: workspaceDir() },
    packet: {
      brief: "make the requested change",
      ownedPaths: ["a.txt"],
      forbiddenPaths: [],
      acceptanceCriteria: ["the change compiles"],
      patchProtocol: { mode: "proposal_only", maxOperations: 256, maxBytes: 1048576, mutationTools: "denied" },
      budget: { maxSeconds: 60, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
      securityBoundary: {
        repositoryWrites: "assigned_worktree_only",
        validationAuthority: "zentra_named_validations_only",
        integrationAuthority: "none",
        shellAuthority: "none",
        modelToolNetwork: "denied",
        harnessProviderTransport: "user_os_network_authority",
        parentSecretInheritance: "denied",
        runtimeIsolation: "trusted_project_policy_not_os_sandbox",
      },
    },
    timeoutMs: 5_000,
  };
}

function testBinding(): WriterDispatchBinding {
  const body = {
    schemaVersion: 1 as const,
    processIncarnation: "foreign-incarnation",
    executableSha256: "e".repeat(64),
    argvSha256: "a".repeat(64),
    packetSha256: "p".repeat(64),
    cwdSha256: "c".repeat(64),
    dispatchId: null,
    projectId: null,
    claimId: null,
    ownerId: null,
    revision: null,
    leaseToken: null,
  };
  return { ...body, digest: sha256(JSON.stringify(body)) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Reads the dynamic loopback URL Zentra generated for the "zentra" MCP server out of argv. */
function mcpUrlFrom(argv: readonly string[]): string {
  const index = argv.indexOf("--mcp-config");
  if (index === -1 || argv[index + 1] === undefined) throw new Error("argv has no --mcp-config entry");
  const config = JSON.parse(argv[index + 1] as string) as {
    readonly mcpServers: Readonly<Record<string, { readonly url: string }>>;
  };
  const server = config.mcpServers[EXPECTED_SERVER_NAME];
  if (server === undefined) throw new Error("mcp config has no zentra server entry");
  return server.url;
}

/** Reads back the argv the adapter attested for a prepared request, for tests only. */
function preparedArgv(prepared: unknown): readonly string[] {
  return (prepared as { readonly argv: readonly string[] }).argv;
}

interface ProposePatchOperation {
  readonly path: string;
  readonly expectedSha256: string | null;
  readonly content: string;
  readonly contentSha256: string;
}

/**
 * Connects one real MCP client per server URL and reuses it across calls.
 * The ephemeral proposal server runs its StreamableHTTPServerTransport in
 * stateful mode (one session for the process's whole run, matching a real
 * Claude Code CLI invocation), so a second `initialize` handshake against
 * the same server is rejected - exactly like a real writer run would only
 * ever hold one MCP session open.
 */
async function mcpClientFor(url: string, token: string): Promise<Client> {
  const existing = clientsByUrl.get(url);
  if (existing !== undefined) return existing;
  const client = new Client({ name: "zentra-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as Transport);
  clientsByUrl.set(url, client);
  return client;
}

/** Performs a real MCP tools/call against the live server, proving the channel actually works. */
async function callProposePatch(
  url: string,
  token: string,
  payload: { readonly proposalId: string; readonly baseRevision: string; readonly operations: readonly ProposePatchOperation[] },
): Promise<unknown> {
  const client = await mcpClientFor(url, token);
  return client.callTool({ name: "propose_patch", arguments: payload });
}

describe("ClaudeCodeWriter", () => {
  it("fails with mcp_server_unavailable when the init event reports a failed server", async () => {
    const writer = new ClaudeCodeWriter(
      scriptedSupervisor([init(["Read", PROPOSE_TOOL], "failed"), OK_RESULT]),
      { mode: "oauth" },
    );
    const prepared = await writer.prepare(writerRequest());
    const report = await writer.execute(prepared, new AbortController().signal);
    expect(report.outcome).toBe("failed");
    expect(report.protocolFailure).toBe("mcp_server_unavailable");
  });

  it("fails with unexpected_tool_surface when NotebookEdit is advertised", async () => {
    const writer = new ClaudeCodeWriter(
      scriptedSupervisor([init(["Read", "NotebookEdit", PROPOSE_TOOL]), OK_RESULT]),
      { mode: "oauth" },
    );
    const prepared = await writer.prepare(writerRequest());
    const report = await writer.execute(prepared, new AbortController().signal);
    expect(report.outcome).toBe("failed");
    expect(report.protocolFailure).toBe("unexpected_tool_surface");
    // protocolFailure must stay a bounded token, so the actual offending
    // tool name (needed to tell operators on a second machine what to add
    // to DENIED_TOOLS) has to travel somewhere else.
    expect(report.unexpectedTools).toEqual(["NotebookEdit"]);
  });

  it("names every offending tool, not just the first, and carries none when the failure is unrelated", async () => {
    const withMultiple = new ClaudeCodeWriter(
      scriptedSupervisor([init(["Read", "NotebookEdit", "WebFetch", PROPOSE_TOOL]), OK_RESULT]),
      { mode: "oauth" },
    );
    const preparedMultiple = await withMultiple.prepare(writerRequest());
    const reportMultiple = await withMultiple.execute(preparedMultiple, new AbortController().signal);
    expect(reportMultiple.protocolFailure).toBe("unexpected_tool_surface");
    expect(reportMultiple.unexpectedTools).toEqual(["NotebookEdit", "WebFetch"]);

    const withoutSurfaceIssue = new ClaudeCodeWriter(
      scriptedSupervisor([init(["Read", PROPOSE_TOOL], "failed"), OK_RESULT]),
      { mode: "oauth" },
    );
    const preparedClean = await withoutSurfaceIssue.prepare(writerRequest());
    const reportClean = await withoutSurfaceIssue.execute(preparedClean, new AbortController().signal);
    expect(reportClean.protocolFailure).toBe("mcp_server_unavailable");
    expect(reportClean.unexpectedTools).toBeUndefined();
  });

  it("fails when the propose tool is absent", async () => {
    const writer = new ClaudeCodeWriter(
      scriptedSupervisor([init(["Read", "Glob"]), OK_RESULT]),
      { mode: "oauth" },
    );
    const prepared = await writer.prepare(writerRequest());
    const report = await writer.execute(prepared, new AbortController().signal);
    expect(report.protocolFailure).toBe("mcp_server_unavailable");
  });

  // These two cases are the ones that actually discriminate
  // expectedServerConnected from the stale disconnectedServers.length > 0
  // check (see the comment on InitInspection.expectedServerConnected).
  // tools still advertises the propose tool here, so a check that only
  // looked at disconnectedServers - which stays empty when mcp_servers is
  // empty or missing, since the loop that populates it never runs - would
  // wrongly read the run as healthy.
  it("fails with mcp_server_unavailable when mcp_servers is empty despite the propose tool being advertised", async () => {
    const writer = new ClaudeCodeWriter(
      scriptedSupervisor([initWithMcpServers(["Read", PROPOSE_TOOL], []), OK_RESULT]),
      { mode: "oauth" },
    );
    const prepared = await writer.prepare(writerRequest());
    const report = await writer.execute(prepared, new AbortController().signal);
    expect(report.outcome).toBe("failed");
    expect(report.protocolFailure).toBe("mcp_server_unavailable");
  });

  it("fails with mcp_server_unavailable when mcp_servers is absent despite the propose tool being advertised", async () => {
    const writer = new ClaudeCodeWriter(
      scriptedSupervisor([initWithMcpServers(["Read", PROPOSE_TOOL], "absent"), OK_RESULT]),
      { mode: "oauth" },
    );
    const prepared = await writer.prepare(writerRequest());
    const report = await writer.execute(prepared, new AbortController().signal);
    expect(report.outcome).toBe("failed");
    expect(report.protocolFailure).toBe("mcp_server_unavailable");
  });

  it("takes the patch proposal from the MCP server, not the event stream", async () => {
    const fabricated = {
      type: "assistant",
      message: { content: [{ type: "text", text: JSON.stringify({
        kind: "zentra.patch_proposal", proposalId: "FABRICATED", baseRevision: BASE_REVISION, operations: [],
      }) }] },
    };
    const writer = new ClaudeCodeWriter(
      scriptedSupervisor([init(["Read", PROPOSE_TOOL]), fabricated, OK_RESULT], async (argv, env) => {
        await callProposePatch(mcpUrlFrom(argv), env["ZENTRA_WRITER_MCP_TOKEN"]!, {
          proposalId: "GENUINE", baseRevision: BASE_REVISION,
          operations: [{ path: "a.txt", expectedSha256: null, content: "x", contentSha256: sha256("x") }],
        });
      }),
      { mode: "oauth" },
    );
    const prepared = await writer.prepare(writerRequest());
    const report = await writer.execute(prepared, new AbortController().signal);
    expect(report.patchProposal?.proposalId).toBe("GENUINE");
  });

  it("rejects a second propose_patch call and keeps the first", async () => {
    let secondResponse: unknown;
    const writer = new ClaudeCodeWriter(
      scriptedSupervisor([init(["Read", PROPOSE_TOOL]), OK_RESULT], async (argv, env) => {
        const url = mcpUrlFrom(argv);
        const token = env["ZENTRA_WRITER_MCP_TOKEN"]!;
        const operations = [{ path: "a.txt", expectedSha256: null, content: "x", contentSha256: sha256("x") }];
        await callProposePatch(url, token, { proposalId: "FIRST", baseRevision: BASE_REVISION, operations });
        secondResponse = await callProposePatch(url, token, { proposalId: "SECOND", baseRevision: BASE_REVISION, operations });
      }),
      { mode: "oauth" },
    );
    const prepared = await writer.prepare(writerRequest());
    const report = await writer.execute(prepared, new AbortController().signal);
    expect(JSON.stringify(secondResponse)).toContain("already been called once");
    expect(report.patchProposal?.proposalId).toBe("FIRST");
  });

  it("fails with invalid_patch_proposal when the proposal is malformed", async () => {
    const writer = new ClaudeCodeWriter(
      scriptedSupervisor([init(["Read", PROPOSE_TOOL]), OK_RESULT], async (argv, env) => {
        await callProposePatch(mcpUrlFrom(argv), env["ZENTRA_WRITER_MCP_TOKEN"]!, {
          proposalId: "BAD",
          baseRevision: BASE_REVISION,
          // contentSha256 deliberately does not match content, so
          // buildWriterPatchProposal rejects it inside the server.
          operations: [{ path: "a.txt", expectedSha256: null, content: "x", contentSha256: sha256("different") }],
        });
      }),
      { mode: "oauth" },
    );
    const prepared = await writer.prepare(writerRequest());
    const report = await writer.execute(prepared, new AbortController().signal);
    expect(report.outcome).toBe("failed");
    expect(report.protocolFailure).toBe("invalid_patch_proposal");
    expect(report.patchProposal).toBeNull();
  });

  it("closes the MCP server when execute completes", async () => {
    const writer = new ClaudeCodeWriter(
      scriptedSupervisor([init(["Read", PROPOSE_TOOL]), OK_RESULT]), { mode: "oauth" },
    );
    const prepared = await writer.prepare(writerRequest());
    const url = mcpUrlFrom(preparedArgv(prepared));
    await writer.execute(prepared, new AbortController().signal);
    await expect(fetch(url, { method: "POST" })).rejects.toThrow();
  });

  it("is idempotent when dispose is called twice", async () => {
    const writer = new ClaudeCodeWriter(
      scriptedSupervisor([init(["Read", PROPOSE_TOOL]), OK_RESULT]), { mode: "oauth" },
    );
    const prepared = await writer.prepare(writerRequest());
    await prepared.dispose();
    await expect(prepared.dispose()).resolves.toBeUndefined();
  });

  // Discriminates the receipt invariant fix in src/agents/writer-events.ts:
  // every prior Claude Code test above reaches only writer.execute(), never
  // the durable receipt path, so it could not catch usage.toolCalls (counted
  // from nested message.content[] blocks) diverging from the chain's
  // retained tool_use events (previously always empty for Claude Code,
  // since createWriterEventChain only recognized OpenCode's top-level/"part"
  // shape). Two parallel tool_use blocks on one stdout line exercise the
  // multi-block-per-line split, not just the single-block case.
  it("produces a report whose receipt is accepted through appendSupervisedWriterReceipt", async () => {
    const parallelToolUse = {
      type: "assistant",
      message: { content: [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } },
        { type: "tool_use", id: "t2", name: "Glob", input: { pattern: "*.ts" } },
      ] },
    };
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-claude-code-writer-receipt-"));
    directories.push(directory);
    const journal = new SqliteEventJournal(path.join(directory, "journal.sqlite"));
    const service = new PathClaimService(journal);
    const claim = service.acquire({
      projectId: "project-claude-code", claimId: "claim-claude-code", ownerId: "claude-implementer",
      revision: BASE_REVISION, paths: ["a.txt"], leaseMs: 60_000, correlationId: "run-claude-code",
    });
    const dispatchId = randomUUID();

    const writer = new ClaudeCodeWriter(
      scriptedSupervisor(
        [init(["Read", "Glob", PROPOSE_TOOL]), parallelToolUse, OK_RESULT],
        async (argv, env) => {
          await callProposePatch(mcpUrlFrom(argv), env["ZENTRA_WRITER_MCP_TOKEN"]!, {
            proposalId: "RECEIPT-PROOF", baseRevision: BASE_REVISION,
            operations: [{ path: "a.txt", expectedSha256: null, content: "x", contentSha256: sha256("x") }],
          });
        },
      ),
      { mode: "oauth" },
    );
    const prepared = await writer.prepare(writerRequest({
      dispatchId, projectId: claim.projectId, claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, leaseToken: claim.leaseToken,
    }));
    service.beginDispatch({
      projectId: claim.projectId, claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, leaseToken: claim.leaseToken,
      dispatchId, binding: prepared.binding, correlationId: "run-claude-code",
    });

    const report = await writer.execute(prepared, new AbortController().signal);
    expect(report.protocolFailure).toBeNull();
    expect(report.usage.toolCalls).toBe(2);

    const receipt = appendSupervisedWriterReceipt(service, {
      projectId: claim.projectId, claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, correlationId: "run-claude-code",
      leaseToken: claim.leaseToken, dispatchId,
    }, report, prepared.binding);

    expect(receipt.usage.toolCalls).toBe(2);
    expect(receipt.eventChain.events.filter((event) =>
      event.type === "tool_use" && event.status !== "denied" && event.tool !== null)).toHaveLength(2);

    journal.close();
  });

  it("refuses a request it did not prepare", async () => {
    const writer = new ClaudeCodeWriter(
      scriptedSupervisor([init(["Read", PROPOSE_TOOL]), OK_RESULT]), { mode: "oauth" },
    );
    const foreign = { binding: testBinding(), dispose: async () => {} };
    await expect(writer.execute(foreign, new AbortController().signal))
      .rejects.toThrow("was not prepared by this trusted adapter");
  });
});
