import { createHash, randomUUID } from "node:crypto";

import { createWriterEventChain } from "../../src/agents/writer-events.js";
import { brandSupervisedReport } from "../../src/harnesses/writer-brand.js";
import type {
  HarnessWriter,
  PreparedWriterRequest,
  WriterDispatchBinding,
  WriterReport,
  WriterRequest,
} from "../../src/harnesses/harness-writer.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class FakeHarnessWriter implements HarnessWriter {
  private request: WriterRequest | null = null;

  async prepare(request: WriterRequest): Promise<PreparedWriterRequest> {
    this.request = request;
    const body = {
      schemaVersion: 1 as const,
      processIncarnation: randomUUID(),
      executableSha256: sha256("fake-executable"),
      argvSha256: sha256("fake-argv"),
      packetSha256: sha256(JSON.stringify(request.packet)),
      cwdSha256: sha256(request.workspace.path),
      dispatchId: request.dispatchAuthority?.dispatchId ?? null,
      projectId: request.dispatchAuthority?.projectId ?? null,
      claimId: request.dispatchAuthority?.claimId ?? null,
      ownerId: request.dispatchAuthority?.ownerId ?? null,
      revision: request.dispatchAuthority?.revision ?? null,
      leaseToken: request.dispatchAuthority?.leaseToken ?? null,
    };
    const binding: WriterDispatchBinding = Object.freeze({
      ...body,
      digest: sha256(JSON.stringify(body)),
    });
    return Object.freeze({ binding });
  }

  async execute(prepared: PreparedWriterRequest, _signal: AbortSignal): Promise<WriterReport> {
    if (this.request === null) throw new Error("fake harness writer was not prepared");
    const now = new Date().toISOString();
    const report: WriterReport = Object.freeze({
      outcome: "completed",
      exitCode: 0,
      executable: "/fake/harness",
      modelId: this.request.model.id,
      requestedModelSha256: sha256(this.request.model.model),
      argv: Object.freeze(["<fake-argv>"]),
      cwd: this.request.workspace.path,
      packetSha256: sha256(JSON.stringify(this.request.packet)),
      networkBoundary: Object.freeze({
        modelTools: "denied" as const,
        harnessProviderTransport: "user_os_network_authority" as const,
      }),
      stdoutSha256: sha256(""),
      stderrSha256: sha256(""),
      eventChain: createWriterEventChain("", []),
      rawOutputPolicy: "not_retained",
      protocolFailure: null,
      stdout: "",
      stderr: "",
      startedAt: now,
      finishedAt: now,
      deniedToolRequests: Object.freeze([]),
      usage: Object.freeze({
        inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0,
      }),
      usageEvidence: "native",
      patchProposal: null,
      dispatchBinding: prepared.binding,
    });
    brandSupervisedReport(report, prepared.binding);
    return report;
  }
}
