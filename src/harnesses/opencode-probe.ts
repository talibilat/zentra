import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { ModelCapability, ModelSheet } from "../policy/model-sheet.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { WorkerAdapter, WorkerResult } from "../workers/worker-adapter.js";

export type OpenCodeProbeOutcome = "completed" | "failed" | "cancelled" | "timed_out";

export type OpenCodeProbeFailureReason =
  | "model_not_approved"
  | "harness_not_opencode"
  | "repository_not_allowed"
  | "network_not_allowed"
  | "opencode_unavailable"
  | "probe_failed";

export interface OpenCodeProbeRequest {
  readonly executable: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly modelId: string;
  readonly models: ModelSheet;
  readonly security: SecuritySheet;
}

export interface OpenCodeProbeReport {
  readonly outcome: OpenCodeProbeOutcome;
  readonly reason: OpenCodeProbeFailureReason | null;
  readonly modelId: string;
  readonly harness: string | null;
  readonly model: string | null;
  readonly provider: string | null;
  readonly executable: string | null;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly version: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export class OpenCodeProbe {
  constructor(private readonly supervisor: WorkerAdapter) {}

  async probe(request: OpenCodeProbeRequest, signal: AbortSignal): Promise<OpenCodeProbeReport> {
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
    if (model.harness !== "opencode") {
      return failure(request, model, canonicalCwd, "harness_not_opencode", startedAt);
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
      return failure(request, model, canonicalCwd, "opencode_unavailable", startedAt);
    }

    const result = await this.supervisor.execute({
      taskId: `opencode-probe-${model.id}`,
      executable,
      args: ["--version"],
      cwd: canonicalCwd,
      timeoutMs: request.timeoutMs,
    }, signal, "validation");

    return reportFromWorkerResult(model, executable, canonicalCwd, result, startedAt);
  }
}

function reportFromWorkerResult(
  model: ModelCapability,
  executable: string,
  cwd: string,
  result: WorkerResult,
  startedAt: string,
): OpenCodeProbeReport {
  if (result.outcome === "completed") {
    return Object.freeze({
      outcome: "completed",
      reason: null,
      modelId: model.id,
      harness: model.harness,
      model: model.model,
      provider: providerFromModel(model.model),
      executable,
      argv: Object.freeze(["--version"]),
      cwd,
      version: result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }
  return Object.freeze({
    outcome: result.outcome,
    reason: result.outcome === "failed" ? "probe_failed" : null,
    modelId: model.id,
    harness: model.harness,
    model: model.model,
    provider: providerFromModel(model.model),
    executable,
    argv: Object.freeze(["--version"]),
    cwd,
    version: null,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

function failure(
  request: OpenCodeProbeRequest,
  model: ModelCapability | null,
  cwd: string,
  reason: OpenCodeProbeFailureReason,
  startedAt: string,
): OpenCodeProbeReport {
  return Object.freeze({
    outcome: "failed",
    reason,
    modelId: request.modelId,
    harness: model?.harness ?? null,
    model: model?.model ?? null,
    provider: model === null ? null : providerFromModel(model.model),
    executable: null,
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
  if (!path.isAbsolute(candidate) || candidate !== canonical) {
    throw new Error("OpenCode probe cwd must be a canonical absolute path");
  }
  if (!stat.isDirectory()) {
    throw new Error("OpenCode probe cwd must be a directory");
  }
  return canonical;
}

function canonicalExecutable(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  const stat = statSync(canonical);
  if (!path.isAbsolute(candidate) || candidate !== canonical) {
    throw new Error("OpenCode probe executable must be a canonical absolute path");
  }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error("OpenCode probe executable must be an executable file");
  }
  return canonical;
}

function providerFromModel(model: string): string {
  const [provider] = model.split("/", 1);
  return provider ?? model;
}
