import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { AnalysisRoundResultSchema, type AnalysisAdapterRequest, type AnalysisRoundResult } from "./analysis-contracts.js";
import { ProcessSupervisor } from "../workers/process-supervisor.js";

export interface SupervisedAnalysisAdapterOptions {
  readonly executable: string;
  readonly executableSha256: string;
  readonly program: string;
  readonly programSha256: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
}

export class AnalysisExecutionError extends Error {
  constructor(readonly outcome: "cancelled" | "timed_out" | "failed", message: string) {
    super(message);
  }
}

/** Exact configured process identity. Its private field brands coordinator dependencies. */
export class SupervisedAnalysisAdapter {
  readonly #identity: Readonly<SupervisedAnalysisAdapterOptions>;

  constructor(options: SupervisedAnalysisAdapterOptions) {
    this.#identity = Object.freeze(validateIdentity(options));
  }

  async analyze(request: AnalysisAdapterRequest, signal: AbortSignal): Promise<AnalysisRoundResult> {
    validateCurrentIdentity(this.#identity);
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input, "utf8") > this.#identity.maxInputBytes) {
      throw new AnalysisExecutionError("failed", "analysis input exceeds its configured bound");
    }
    const started = process.hrtime.bigint();
    const supervisor = new ProcessSupervisor({ maxOutputBytes: Math.min(this.#identity.maxOutputBytes, request.invocationLimits.maxOutputBytes) });
    const result = await supervisor.execute({
      taskId: `analysis-${request.runId}-${request.round}`,
      executable: this.#identity.executable,
      args: [this.#identity.program],
      cwd: this.#identity.cwd,
      timeoutMs: Math.min(this.#identity.timeoutMs, request.invocationLimits.timeoutMs),
      environment: {},
      input,
    }, signal, "validation");
    if (result.outcome !== "completed") throw new AnalysisExecutionError(result.outcome, result.stderr);
    const lines = result.rawStdout.trim().split("\n").filter(Boolean);
    if (lines.length !== 1) throw new AnalysisExecutionError("failed", "analysis protocol requires exactly one result");
    let decoded: unknown;
    try {
      decoded = JSON.parse(lines[0]!);
    } catch {
      throw new AnalysisExecutionError("failed", "analysis protocol returned invalid JSON");
    }
    const parsed = AnalysisRoundResultSchema.parse(decoded);
    return AnalysisRoundResultSchema.parse({
      ...parsed,
      usage: {
        ...parsed.usage,
        outputBytes: Buffer.byteLength(result.rawStdout, "utf8"),
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      },
    });
  }
}

function validateIdentity(options: SupervisedAnalysisAdapterOptions): SupervisedAnalysisAdapterOptions {
  for (const value of [options.timeoutMs, options.maxInputBytes, options.maxOutputBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("analysis process bounds must be positive safe integers");
  }
  const executable = canonicalRegular(options.executable, "analysis executable");
  const program = canonicalRegular(options.program, "analysis program");
  const cwd = realpathSync.native(options.cwd);
  if (cwd !== options.cwd || !statSync(cwd).isDirectory()) throw new Error("analysis cwd must be a canonical directory");
  if (executable !== options.executable || program !== options.program ||
    digestFile(executable) !== options.executableSha256 || digestFile(program) !== options.programSha256) {
    throw new Error("analysis executable identity is not the exact configured identity");
  }
  return { ...options, executable, program, cwd };
}

function validateCurrentIdentity(identity: Readonly<SupervisedAnalysisAdapterOptions>): void {
  if (canonicalRegular(identity.executable, "analysis executable") !== identity.executable ||
    canonicalRegular(identity.program, "analysis program") !== identity.program ||
    digestFile(identity.executable) !== identity.executableSha256 || digestFile(identity.program) !== identity.programSha256) {
    throw new Error("analysis executable identity changed after configuration");
  }
}

function canonicalRegular(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute canonical regular file`);
  const canonical = realpathSync.native(candidate);
  if (!statSync(canonical).isFile()) throw new Error(`${label} must be an absolute canonical regular file`);
  return canonical;
}

function digestFile(filename: string): string {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}
