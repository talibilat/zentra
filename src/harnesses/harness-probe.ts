import { createHash } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";

import type { ModelCapability, ModelSheet } from "../policy/model-sheet.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { WorkerAdapter, WorkerResult } from "../workers/worker-adapter.js";
import type { HarnessId } from "./harness-id.js";

export type HarnessProbeOutcome = "completed" | "failed" | "cancelled" | "timed_out";

export type HarnessProbeFailureReason =
  | "model_not_approved"
  | "harness_mismatch"
  | "repository_not_allowed"
  | "network_not_allowed"
  | "harness_unavailable"
  | "probe_failed";

export interface HarnessProbeRequest {
  readonly harness: HarnessId;
  readonly executable: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly modelId: string;
  readonly models: ModelSheet;
  readonly security: SecuritySheet;
  readonly home?: string;
  readonly expectedExecutableSha256?: string;
  readonly expectedVersion?: string;
}

export interface HarnessProbeReport {
  readonly outcome: HarnessProbeOutcome;
  readonly reason: HarnessProbeFailureReason | null;
  readonly modelId: string;
  readonly harness: string | null;
  readonly model: string | null;
  readonly provider: string | null;
  readonly executable: string | null;
  readonly executableSha256: string | null;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly version: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

const verifiedProbeReports = new WeakSet<HarnessProbeReport>();

export function isVerifiedHarnessProbeReport(
  report: HarnessProbeReport,
  expected: {
    readonly harness: HarnessId;
    readonly modelId: string;
    readonly model: string;
    readonly provider: string;
    readonly cwd: string;
  },
): boolean {
  return verifiedProbeReports.has(report) &&
    report.outcome === "completed" &&
    report.reason === null &&
    report.harness === expected.harness &&
    report.modelId === expected.modelId &&
    report.model === expected.model &&
    report.provider === expected.provider &&
    report.cwd === expected.cwd &&
    report.executable !== null &&
    report.executableSha256 !== null;
}

export class HarnessProbe {
  constructor(private readonly supervisor: WorkerAdapter) {}

  async probe(request: HarnessProbeRequest, signal: AbortSignal): Promise<HarnessProbeReport> {
    const startedAt = new Date().toISOString();
    const model = request.models.models.find((candidate) => candidate.id === request.modelId) ?? null;
    let canonicalCwd: string;
    try {
      canonicalCwd = canonicalDirectory(request.cwd);
    } catch {
      return failure(request, model, request.cwd, "repository_not_allowed", startedAt);
    }

    if (model === null) {
      return failure(request, null, canonicalCwd, "model_not_approved", startedAt);
    }
    if (model.harness !== request.harness) {
      return failure(request, model, canonicalCwd, "harness_mismatch", startedAt);
    }
    if (!request.security.allowedRepositories.includes(canonicalCwd)) {
      return failure(request, model, canonicalCwd, "repository_not_allowed", startedAt);
    }
    if (model.network === "declared" && request.security.network.allowedDestinations.length === 0) {
      return failure(request, model, canonicalCwd, "network_not_allowed", startedAt);
    }

    let executable: string;
    try {
      executable = canonicalExecutable(request.executable);
    } catch {
      return failure(request, model, canonicalCwd, "harness_unavailable", startedAt);
    }

    const result = await this.supervisor.execute({
      taskId: `${request.harness}-probe-${model.id}`,
      executable,
      args: ["--version"],
      cwd: canonicalCwd,
      timeoutMs: request.timeoutMs,
      ...(request.home === undefined ? {} : { environment: { HOME: canonicalDirectory(request.home) } }),
    }, signal, "validation");

    let executableSha256: string | null = null;
    if (result.outcome === "completed") {
      try {
        executableSha256 = await sha256File(executable);
      } catch {
        return failure(request, model, canonicalCwd, "probe_failed", startedAt);
      }
    }
    const measuredVersion = result.rawStdout.endsWith("\n") ? result.rawStdout.replace(/\r?\n$/, "") : result.rawStdout;
    if (result.outcome === "completed" && (
      (request.expectedExecutableSha256 !== undefined && executableSha256 !== request.expectedExecutableSha256) ||
      (request.expectedVersion !== undefined && measuredVersion !== request.expectedVersion)
    )) return failure(request, model, canonicalCwd, "probe_failed", startedAt);
    return reportFromWorkerResult(
      model,
      executable,
      executableSha256,
      canonicalCwd,
      result,
      startedAt,
    );
  }
}

function reportFromWorkerResult(
  model: ModelCapability,
  executable: string,
  executableSha256: string | null,
  cwd: string,
  result: WorkerResult,
  startedAt: string,
): HarnessProbeReport {
  if (result.outcome === "completed") {
    const report: HarnessProbeReport = Object.freeze({
      outcome: "completed",
      reason: null,
      modelId: model.id,
      harness: model.harness,
      model: model.model,
      provider: providerFromModel(model.model),
      executable,
      executableSha256,
      argv: Object.freeze(["--version"]),
      cwd,
      version: result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    verifiedProbeReports.add(report);
    return report;
  }
  return Object.freeze({
    outcome: result.outcome,
    reason: result.outcome === "failed" ? "probe_failed" : null,
    modelId: model.id,
    harness: model.harness,
    model: model.model,
    provider: providerFromModel(model.model),
    executable,
    executableSha256,
    argv: Object.freeze(["--version"]),
    cwd,
    version: null,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

function failure(
  request: HarnessProbeRequest,
  model: ModelCapability | null,
  cwd: string,
  reason: HarnessProbeFailureReason,
  startedAt: string,
): HarnessProbeReport {
  return Object.freeze({
    outcome: "failed",
    reason,
    modelId: request.modelId,
    harness: model?.harness ?? null,
    model: model?.model ?? null,
    provider: model === null ? null : providerFromModel(model.model),
    executable: null,
    executableSha256: null,
    argv: Object.freeze(["--version"]),
    cwd,
    version: null,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

function canonicalDirectory(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  const stat = statSync(canonical);
  if (candidate !== canonical) {
    throw new Error("harness probe cwd must be a canonical absolute path");
  }
  if (!stat.isDirectory()) {
    throw new Error("harness probe cwd must be a directory");
  }
  return canonical;
}

function canonicalExecutable(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  const stat = statSync(canonical);
  if (candidate !== canonical) {
    throw new Error("harness probe executable must be a canonical absolute path");
  }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error("harness probe executable must be an executable file");
  }
  return canonical;
}

function providerFromModel(model: string): string {
  return model.replace(/\/.*/, "");
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
