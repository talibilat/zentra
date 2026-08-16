import { randomUUID } from "node:crypto";

import { createWriterEventChain, type WriterEventChain } from "../agents/writer-events.js";
import type { WorkerAdapter } from "../workers/worker-adapter.js";
import { brandSupervisedReport } from "./writer-brand.js";
import { createPreparedWriterRegistry } from "./writer-prepared.js";
import { canonicalDirectory, canonicalExecutable, sha256, sha256File } from "./writer-canonical.js";
import {
  buildClaudeCodeArgv, buildClaudeCodeEnvironment, buildMcpConfig, redactClaudeCodeArgv,
  type ClaudeCodeAuth,
} from "./claude-code-invocation.js";
import { inspectInitEvent, parseClaudeCodeUsage, parseDeniedToolRequests } from "./claude-code-stream.js";
import { startWriterProposalMcpServer, type EphemeralWriterProposalServer } from "./writer-proposal-mcp-server.js";
import type {
  HarnessWriter, PreparedWriterRequest, WriterReport, WriterRequest,
} from "./harness-writer.js";

interface InternalPrepared extends PreparedWriterRequest {
  readonly request: WriterRequest;
  readonly executable: string;
  readonly cwd: string;
  readonly packet: string;
  readonly argv: readonly string[];
  readonly server: EphemeralWriterProposalServer;
}

const preparedRequests = createPreparedWriterRegistry();

export class ClaudeCodeWriter implements HarnessWriter {
  constructor(
    private readonly supervisor: WorkerAdapter,
    private readonly auth: ClaudeCodeAuth,
  ) {}

  async prepare(request: WriterRequest): Promise<PreparedWriterRequest> {
    const executable = canonicalExecutable(request.executable);
    const executableSha256 = await sha256File(executable);
    if (request.expectedExecutableSha256 !== undefined && executableSha256 !== request.expectedExecutableSha256) {
      throw new Error("Claude Code writer executable changed after capability probe");
    }
    const cwd = canonicalDirectory(request.workspace.path);
    if (cwd !== request.workspace.path) throw new Error("Claude Code writer workspace must be canonical");
    const packet = JSON.stringify(request.packet);

    // Started here, not in execute(), because the URL carries a dynamic port and
    // argvSha256 must attest the argv that actually ran (D31).
    const server = await startWriterProposalMcpServer();
    try {
      const argv = buildClaudeCodeArgv({
        packet,
        model: request.model.model,
        mcpConfig: buildMcpConfig(server.url, server.bearerTokenEnvVar),
        auth: this.auth,
      });
      const bindingBody = {
        schemaVersion: 1 as const,
        processIncarnation: randomUUID(),
        executableSha256,
        argvSha256: sha256(JSON.stringify(argv)),
        packetSha256: sha256(packet),
        cwdSha256: sha256(cwd),
        dispatchId: request.dispatchAuthority?.dispatchId ?? null,
        projectId: request.dispatchAuthority?.projectId ?? null,
        claimId: request.dispatchAuthority?.claimId ?? null,
        ownerId: request.dispatchAuthority?.ownerId ?? null,
        revision: request.dispatchAuthority?.revision ?? null,
        leaseToken: request.dispatchAuthority?.leaseToken ?? null,
      };
      const prepared: InternalPrepared = Object.freeze({
        request, executable, cwd, packet, argv, server,
        binding: Object.freeze({ ...bindingBody, digest: sha256(JSON.stringify(bindingBody)) }),
        // close() memoizes into `shutdown`, so this is already idempotent.
        dispose: async () => { await server.close(); },
      });
      preparedRequests.mark(prepared);
      return prepared;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  async execute(rawPrepared: PreparedWriterRequest, signal: AbortSignal): Promise<WriterReport> {
    if (!preparedRequests.consume(rawPrepared)) {
      throw new Error("Claude Code writer request was not prepared by this trusted adapter");
    }
    const prepared = rawPrepared as InternalPrepared;
    const { request, executable, cwd, packet, argv, server } = prepared;
    const startedAt = new Date().toISOString();
    try {
      const result = await this.supervisor.execute({
        taskId: request.taskId,
        executable,
        args: argv,
        cwd,
        timeoutMs: request.timeoutMs,
        environment: buildClaudeCodeEnvironment({
          ...(request.home === undefined ? {} : { home: canonicalDirectory(request.home) }),
          mcpToken: server.bearerTokenValue,
          auth: this.auth,
        }),
      }, signal, "harness_writer");

      let eventChain: WriterEventChain;
      let protocolFailure: string | null = null;
      try {
        eventChain = createWriterEventChain(result.rawStdout, result.events);
      } catch {
        eventChain = createWriterEventChain(result.rawStdout, []);
        protocolFailure = "invalid_output_stream";
      }

      if (protocolFailure === null && result.outcome === "completed") {
        const init = inspectInitEvent(result.events);
        // Gate on expectedServerConnected, a positive check that the named
        // "zentra" server is present and connected. Gating on
        // disconnectedServers.length > 0 instead would read an empty or
        // absent mcp_servers array as healthy - the fail-open this check
        // exists to prevent. disconnectedServers stays diagnostic-only.
        if (init === null || !init.proposeToolPresent || !init.expectedServerConnected) {
          protocolFailure = "mcp_server_unavailable";
        } else if (init.unexpectedTools.length > 0) {
          protocolFailure = "unexpected_tool_surface";
        }
      }

      // Closing collects the proposal. It never transits model output, so a
      // fabricated patch-shaped blob in the text cannot produce one.
      const outcome = await server.close();
      if (protocolFailure === null && outcome.protocolFailure) protocolFailure = "invalid_patch_proposal";

      const parsed = protocolFailure === null
        ? parseClaudeCodeUsage(result.events)
        : { usage: EMPTY_USAGE, evidence: "none" as const };

      const report: WriterReport = Object.freeze({
        outcome: protocolFailure !== null && result.outcome === "completed" ? "failed" : result.outcome,
        exitCode: result.exitCode,
        executable,
        modelId: request.model.id,
        requestedModelSha256: sha256(request.model.model),
        argv: Object.freeze(redactClaudeCodeArgv(argv)),
        cwd,
        packetSha256: sha256(packet),
        networkBoundary: Object.freeze({
          modelTools: request.packet.securityBoundary.modelToolNetwork,
          harnessProviderTransport: request.packet.securityBoundary.harnessProviderTransport,
        }),
        stdoutSha256: eventChain.stdoutSha256,
        stderrSha256: sha256(result.stderr),
        eventChain,
        rawOutputPolicy: "not_retained",
        protocolFailure,
        stdout: result.rawStdout,
        stderr: result.stderr,
        startedAt,
        finishedAt: new Date().toISOString(),
        deniedToolRequests: Object.freeze(
          protocolFailure === "invalid_output_stream" ? [] : parseDeniedToolRequests(result.events),
        ),
        usage: Object.freeze(parsed.usage),
        usageEvidence: parsed.evidence,
        patchProposal: protocolFailure === null ? outcome.proposal : null,
        dispatchBinding: prepared.binding,
      });
      brandSupervisedReport(report, prepared.binding);
      return report;
    } finally {
      // dispose() re-invokes the same memoized close() this try block already
      // awaited on the success path, so it is normally a cheap no-op re-await
      // of a settled promise. On the path where the run fails before
      // server.close() is ever reached, this is the first real close() call -
      // if IT throws, that teardown failure must not replace whatever error
      // or return value the try block already decided, so it is caught and
      // logged here rather than left to propagate through the finally.
      await prepared.dispose().catch((disposeError: unknown) => {
        console.error("Claude Code writer: dispose() failed during execute() teardown", disposeError);
      });
    }
  }
}

const EMPTY_USAGE = {
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0,
};
