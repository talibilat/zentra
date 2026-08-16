import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { buildWriterPatchProposal, type WriterPatchProposal } from "../contracts/writer-patch.js";

const BEARER_TOKEN_ENV_VAR = "ZENTRA_WRITER_MCP_TOKEN";

const ProposePatchOperationSchema = z.object({
  path: z.string(),
  expectedSha256: z.string().nullable(),
  content: z.string(),
  contentSha256: z.string(),
});

const ProposePatchInputShape = {
  proposalId: z.string().min(1).max(256),
  baseRevision: z.string(),
  operations: z.array(ProposePatchOperationSchema).min(1).max(256),
};

export interface WriterProposalOutcome {
  readonly proposal: WriterPatchProposal | null;
  readonly protocolFailure: boolean;
}

export interface EphemeralWriterProposalServer {
  readonly url: string;
  readonly bearerTokenEnvVar: string;
  readonly bearerTokenValue: string;
  close(): Promise<WriterProposalOutcome>;
}

export async function startWriterProposalMcpServer(): Promise<EphemeralWriterProposalServer> {
  const bearerTokenValue = randomBytes(32).toString("hex");
  let settled = false;
  let outcome: WriterProposalOutcome = { proposal: null, protocolFailure: false };

  const mcp = new McpServer({ name: "zentra-writer-proposal", version: "1.0.0" });
  mcp.registerTool("propose_patch", {
    title: "Propose a patch",
    description: "The only way to make a change. Call this at most once with the complete set of file operations.",
    inputSchema: ProposePatchInputShape,
  }, (input) => {
    if (settled) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "propose_patch has already been called once for this task" }],
      };
    }
    try {
      const proposal = buildWriterPatchProposal({
        schemaVersion: 1,
        kind: "zentra.patch_proposal",
        proposalId: input.proposalId,
        baseRevision: input.baseRevision,
        operations: input.operations,
      });
      settled = true;
      outcome = { proposal, protocolFailure: false };
      return { content: [{ type: "text" as const, text: "patch proposal accepted" }] };
    } catch (error) {
      settled = true;
      outcome = { proposal: null, protocolFailure: true };
      return {
        isError: true,
        content: [{ type: "text" as const, text: `invalid patch proposal: ${(error as Error).message}` }],
      };
    }
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  // The SDK's own transports declare `onclose`/`sessionId` as `T | undefined` rather than optional,
  // which `exactOptionalPropertyTypes` rejects against its own `Transport` interface.
  await mcp.connect(transport as Transport);

  const httpServer: Server = createServer((request, response) => {
    if (!isAuthorized(request, bearerTokenValue)) {
      response.writeHead(401).end();
      return;
    }
    void transport.handleRequest(request, response);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  let shutdown: Promise<WriterProposalOutcome> | null = null;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    bearerTokenEnvVar: BEARER_TOKEN_ENV_VAR,
    bearerTokenValue,
    close() {
      if (shutdown === null) {
        const attempt: Promise<WriterProposalOutcome> = closeServer(mcp, httpServer).then(() => outcome);
        shutdown = attempt;
        // A rejection is not terminal: clear the memo so the next close()
        // call starts a fresh attempt instead of handing back the same
        // permanently-rejected promise forever, which would leave a caller
        // with no way to retry closing a still-listening server.
        attempt.catch(() => { if (shutdown === attempt) shutdown = null; });
      }
      return shutdown;
    },
  };
}

async function closeServer(mcp: McpServer, httpServer: Server): Promise<void> {
  try {
    await mcp.close();
  } finally {
    // Runs even if mcp.close() throws: the HTTP listener - carrying a live
    // bearer token - must never be stranded open because the unrelated MCP
    // session teardown failed. ERR_SERVER_NOT_RUNNING is tolerated rather
    // than rejected: it means a previous attempt's finally (or an earlier
    // successful close()) already closed the listener, so the outcome this
    // step exists to guarantee already holds - retrying it is not itself an
    // error.
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error === undefined || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
        else reject(error);
      });
      httpServer.closeAllConnections();
    });
  }
}

function isAuthorized(request: IncomingMessage, bearerTokenValue: string): boolean {
  const presented = Buffer.from(request.headers.authorization ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${bearerTokenValue}`, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
