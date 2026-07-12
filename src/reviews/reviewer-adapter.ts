import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { ValidationReport } from "../capabilities/validation-runner.js";

export interface ReviewInput {
  readonly workerId: string;
  readonly reviewerId: string;
  readonly diff: string;
  readonly validation: ValidationReport;
}

export interface ReviewDecision {
  readonly reviewerId: string;
  readonly approved: boolean;
  readonly diffSha256: string;
  readonly validationSha256: string;
  readonly decidedAt: string;
  readonly reason: string;
}

export interface ReviewerAdapter {
  review(input: ReviewInput, signal: AbortSignal): Promise<ReviewDecision>;
}

export class ReviewerExecutionError extends Error {
  override readonly name = "ReviewerExecutionError";

  constructor(
    readonly outcome: "cancelled" | "timed_out" | "failed",
    stderr: string,
  ) {
    super(
      `reviewer process failed: outcome=${outcome}${
        stderr === "" ? "" : `, stderr=${stderr}`
      }`,
    );
  }
}

export const ReviewDecisionSchema = z.strictObject({
  reviewerId: z.string().min(1),
  approved: z.boolean(),
  diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
  validationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  decidedAt: z.string().datetime({ offset: true }),
  reason: z.string().min(1),
});

const ProcessReviewDecisionSchema = z.strictObject({
  reviewerId: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
  diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
  validationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  decidedAt: z.string().datetime({ offset: true }),
  reason: z.string().min(1).max(4_096),
});

const REVIEWER_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;
const DEFAULT_REVIEWER_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REVIEW_INPUT_BYTES = 2 * 1_024 * 1_024;
const DEFAULT_MAX_REVIEW_OUTPUT_BYTES = 16 * 1_024;
const STREAM_FLUSH_GRACE_MS = 100;

export interface ProcessReviewerOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalValidationDigest(validation: ValidationReport): string {
  const argvSha256 = sha256(JSON.stringify(validation.command));
  const outputSha256 = sha256(
    JSON.stringify({ stdout: validation.stdout, stderr: validation.stderr }),
  );
  if (validation.argvSha256 !== argvSha256) {
    throw new Error("validation argvSha256 is inconsistent with command evidence");
  }
  if (validation.outputSha256 !== outputSha256) {
    throw new Error("validation outputSha256 is inconsistent with output evidence");
  }
  const canonical = JSON.stringify({
    name: validation.name,
    outcome: validation.outcome,
    exitCode: validation.exitCode,
    startedAt: validation.startedAt,
    finishedAt: validation.finishedAt,
    command: validation.command,
    stdout: validation.stdout,
    stderr: validation.stderr,
    argvSha256,
    outputSha256,
    provenance: validation.provenance,
  });
  return sha256(canonical);
}

export class ProcessReviewerAdapter implements ReviewerAdapter {
  private readonly args: readonly string[];
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;

  constructor(private readonly options: ProcessReviewerOptions) {
    this.args = options.args ?? [];
    this.cwd = options.cwd ?? "/tmp";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_REVIEW_INPUT_BYTES;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_REVIEW_OUTPUT_BYTES;
    for (const [name, value] of [
      ["timeoutMs", this.timeoutMs],
      ["maxInputBytes", this.maxInputBytes],
      ["maxOutputBytes", this.maxOutputBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive safe integer`);
      }
    }
  }

  async review(input: ReviewInput, signal: AbortSignal): Promise<ReviewDecision> {
    if (input.workerId === input.reviewerId) {
      throw new Error(
        `reviewer identity must differ from worker identity: ${input.workerId}`,
      );
    }

    const diffSha256 = sha256(input.diff);
    const validationSha256 = canonicalValidationDigest(input.validation);
    const request = JSON.stringify({
      schemaVersion: 1,
      workerId: input.workerId,
      reviewerId: input.reviewerId,
      diff: input.diff,
      validation: input.validation,
      diffSha256,
      validationSha256,
    });
    const requestBytes = Buffer.byteLength(request, "utf8");
    if (requestBytes > this.maxInputBytes) {
      throw new Error(
        `reviewer protocol input exceeded bounded evidence limit of ${this.maxInputBytes} bytes`,
      );
    }

    const output = await this.execute(request, signal);
    const lines = output.trim().split("\n").filter((line) => line.trim() !== "");
    if (lines.length !== 1) {
      throw new Error(
        `reviewer protocol requires exactly one decision, received ${lines.length}`,
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(lines[0]!);
    } catch {
      throw new Error("reviewer protocol returned invalid JSON");
    }
    const parsed = ProcessReviewDecisionSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error(`reviewer protocol returned invalid decision: ${parsed.error.message}`);
    }
    if (parsed.data.reviewerId !== input.reviewerId) {
      throw new Error("reviewer protocol returned a reviewer identity mismatch");
    }
    if (parsed.data.diffSha256 !== diffSha256) {
      throw new Error("reviewer protocol returned a diff evidence digest mismatch");
    }
    if (parsed.data.validationSha256 !== validationSha256) {
      throw new Error("reviewer protocol returned a validation evidence digest mismatch");
    }

    return ReviewDecisionSchema.parse({
      reviewerId: parsed.data.reviewerId,
      approved: parsed.data.decision === "approve",
      diffSha256: parsed.data.diffSha256,
      validationSha256: parsed.data.validationSha256,
      decidedAt: parsed.data.decidedAt,
      reason: parsed.data.reason,
    });
  }

  private execute(request: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) {
      return Promise.reject(new ReviewerExecutionError("cancelled", ""));
    }

    return new Promise((resolve, reject) => {
      const env: Record<string, string> = {};
      for (const key of REVIEWER_ENV_ALLOWLIST) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      const child = spawn(this.options.executable, [...this.args], {
        cwd: this.cwd,
        shell: false,
        detached: true,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let outcome: "cancelled" | "timed_out" | "failed" | undefined;
      let reason = "";
      let settled = false;
      let exitObserved = false;
      let exitCode: number | null = null;
      let stdinCompleted = false;
      let stdoutEnded = false;
      let stderrEnded = false;
      let settlementTimer: NodeJS.Timeout | undefined;

      const kill = (): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (settlementTimer !== undefined) clearTimeout(settlementTimer);
        signal.removeEventListener("abort", onAbort);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        kill();

        const stderrText = Buffer.concat(stderr).toString("utf8");
        if (outcome !== undefined) {
          reject(new ReviewerExecutionError(outcome, reason || stderrText));
          return;
        }
        if (!exitObserved || exitCode !== 0) {
          reject(new ReviewerExecutionError("failed", stderrText));
          return;
        }
        if (!stdinCompleted) {
          reject(new ReviewerExecutionError("failed", "reviewer stdin did not accept the complete request"));
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      };
      const scheduleSettlementDeadline = (): void => {
        settlementTimer ??= setTimeout(finish, STREAM_FLUSH_GRACE_MS);
      };
      const finishIfFlushed = (): void => {
        if (!exitObserved || !stdoutEnded || !stderrEnded) return;
        if (outcome !== undefined || exitCode !== 0 || stdinCompleted) finish();
      };
      const stop = (
        nextOutcome: "cancelled" | "timed_out" | "failed",
        nextReason: string,
      ): void => {
        if (outcome !== undefined) return;
        outcome = nextOutcome;
        reason = nextReason;
        kill();
        scheduleSettlementDeadline();
      };
      const timer = setTimeout(
        () => stop("timed_out", "reviewer timeout exceeded"),
        this.timeoutMs,
      );
      const onAbort = (): void => stop("cancelled", "reviewer cancelled");
      signal.addEventListener("abort", onAbort, { once: true });
      const capture = (target: Buffer[], chunk: Buffer): void => {
        const remaining = this.maxOutputBytes - outputBytes;
        if (remaining > 0) target.push(chunk.subarray(0, Math.min(remaining, chunk.byteLength)));
        outputBytes += chunk.byteLength;
        if (outputBytes > this.maxOutputBytes) {
          stop("failed", `reviewer output limit of ${this.maxOutputBytes} bytes exceeded`);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.stdout.on("end", () => {
        stdoutEnded = true;
        finishIfFlushed();
      });
      child.stderr.on("end", () => {
        stderrEnded = true;
        finishIfFlushed();
      });
      child.stdout.on("error", (error) => stop("failed", `reviewer stdout failed: ${error.message}`));
      child.stderr.on("error", (error) => stop("failed", `reviewer stderr failed: ${error.message}`));
      child.on("error", (error) => stop("failed", `reviewer spawn failed: ${error.message}`));
      child.on("exit", (code) => {
        exitObserved = true;
        exitCode = code;
        scheduleSettlementDeadline();
        finishIfFlushed();
      });
      child.stdin.on("error", (error) => {
        stop("failed", `reviewer stdin failed: ${error.message}`);
      });
      child.stdin.on("close", () => {
        if (!stdinCompleted) stop("failed", "reviewer stdin closed before the request completed");
      });
      child.stdin.end(request, "utf8", () => {
        stdinCompleted = true;
        finishIfFlushed();
      });
    });
  }
}
