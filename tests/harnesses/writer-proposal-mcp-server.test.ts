import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startWriterProposalMcpServer,
  type EphemeralWriterProposalServer,
} from "../../src/harnesses/writer-proposal-mcp-server.js";

interface ProposePatchOperation {
  readonly path: string;
  readonly expectedSha256: string | null;
  readonly content: string;
  readonly contentSha256: string;
}

type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

const openServers: EphemeralWriterProposalServer[] = [];
const openClients: Client[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close();
  for (const server of openServers.splice(0)) await server.close();
});

async function startServer(): Promise<EphemeralWriterProposalServer> {
  const server = await startWriterProposalMcpServer();
  openServers.push(server);
  return server;
}

async function connectClient(server: EphemeralWriterProposalServer): Promise<Client> {
  const client = new Client({ name: "zentra-test-client", version: "1.0.0" });
  openClients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { authorization: `Bearer ${server.bearerTokenValue}` } },
  });
  await client.connect(transport as Transport);
  return client;
}

async function callProposePatch(
  client: Client,
  operations: readonly ProposePatchOperation[],
): Promise<ToolCallResult> {
  return client.callTool({
    name: "propose_patch",
    arguments: { proposalId: "proposal-1", baseRevision: "a".repeat(40), operations },
  });
}

function shaHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function operation(path: string, content: string): ProposePatchOperation {
  return { path, expectedSha256: null, content, contentSha256: shaHex(content) };
}

describe("writer proposal MCP server", () => {
  it("captures a valid proposal and reports it on close", async () => {
    const server = await startServer();
    const client = await connectClient(server);
    const result = await callProposePatch(client, [operation("src/example.ts", "hello world\n")]);
    expect(result.isError).toBeFalsy();

    await client.close();
    const outcome = await server.close();
    expect(outcome.protocolFailure).toBe(false);
    expect(outcome.proposal?.operations).toHaveLength(1);
    expect(outcome.proposal?.operations[0]?.path).toBe("src/example.ts");
    expect(outcome.proposal?.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("exposes a loopback url and a fresh token per server", async () => {
    const first = await startServer();
    const second = await startServer();
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(first.bearerTokenEnvVar).toBe("ZENTRA_WRITER_MCP_TOKEN");
    expect(first.bearerTokenValue).toMatch(/^[a-f0-9]{64}$/);
    expect(second.bearerTokenValue).not.toBe(first.bearerTokenValue);
    expect(second.url).not.toBe(first.url);
  });

  it("rejects a request with the wrong bearer token", async () => {
    const server = await startServer();
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    await response.text();

    const outcome = await server.close();
    expect(outcome.proposal).toBeNull();
    expect(outcome.protocolFailure).toBe(false);
  });

  it("rejects a request with no bearer token", async () => {
    const server = await startServer();
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    await response.text();

    const outcome = await server.close();
    expect(outcome.proposal).toBeNull();
  });

  it("reports no proposal when the harness never calls the tool", async () => {
    const server = await startServer();
    const outcome = await server.close();
    expect(outcome.proposal).toBeNull();
    expect(outcome.protocolFailure).toBe(false);
  });

  it("rejects a second call after the first succeeds", async () => {
    const server = await startServer();
    const client = await connectClient(server);
    await callProposePatch(client, [operation("a.ts", "first\n")]);
    const second = await callProposePatch(client, [operation("b.ts", "second\n")]);
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second.content)).toContain("already been called");

    await client.close();
    const outcome = await server.close();
    expect(outcome.protocolFailure).toBe(false);
    expect(outcome.proposal?.operations).toHaveLength(1);
    expect(outcome.proposal?.operations[0]?.path).toBe("a.ts");
  });

  it("closes while a client connection is still open", async () => {
    const server = await startServer();
    await connectClient(server);
    const outcome = await server.close();
    expect(outcome.proposal).toBeNull();

    const refused = await fetch(server.url, { method: "POST" }).then(() => "reachable", () => "refused");
    expect(refused).toBe("refused");
  }, 5000);

  it("records a protocol failure when the proposal fails validation", async () => {
    const server = await startServer();
    const client = await connectClient(server);
    const result = await callProposePatch(client, [
      { path: "src/example.ts", expectedSha256: null, content: "hello\n", contentSha256: shaHex("goodbye\n") },
    ]);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("invalid patch proposal");

    await client.close();
    const outcome = await server.close();
    expect(outcome.proposal).toBeNull();
    expect(outcome.protocolFailure).toBe(true);
  });

  // Discriminates the closeServer fix: a rejecting mcp.close() must not
  // strand the HTTP listener (still carrying a live bearer token) open, and
  // that rejection must not be memoized forever - a later close() call has
  // to be able to retry and actually succeed.
  it("still closes the HTTP listener when the MCP session close rejects", async () => {
    const closeSpy = vi.spyOn(McpServer.prototype, "close")
      .mockRejectedValueOnce(new Error("mcp close exploded"));
    const server = await startServer();

    await expect(server.close()).rejects.toThrow("mcp close exploded");

    const refused = await fetch(server.url, { method: "POST" }).then(() => "reachable", () => "refused");
    expect(refused).toBe("refused");

    closeSpy.mockRestore();
  });

  it("retries a failed close instead of memoizing the rejection forever", async () => {
    const closeSpy = vi.spyOn(McpServer.prototype, "close")
      .mockRejectedValueOnce(new Error("mcp close exploded"));
    const server = await startServer();

    await expect(server.close()).rejects.toThrow("mcp close exploded");
    // The real McpServer#close() is idempotent, so the retry below hits the
    // unmocked implementation and this resolves instead of repeating the
    // same rejection the first call already saw.
    await expect(server.close()).resolves.toMatchObject({ proposal: null });

    closeSpy.mockRestore();
  });
});
