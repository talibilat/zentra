import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProcessSupervisor } from "../workers/process-supervisor.js";
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

const ReviewDecisionSchema = z.strictObject({
  reviewerId: z.string().min(1),
  approved: z.boolean(),
  diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
  validationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  decidedAt: z.string().datetime({ offset: true }),
  reason: z.string().min(1),
});

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
  });
  return sha256(canonical);
}

export class DeterministicReviewerAdapter implements ReviewerAdapter {
  constructor(
    private readonly supervisor: ProcessSupervisor,
    private readonly executable: string
  ) {}

  async review(input: ReviewInput, signal: AbortSignal): Promise<ReviewDecision> {
    // Reject matching worker and reviewer identities before spawning
    if (input.workerId === input.reviewerId) {
      throw new Error(
        `reviewer identity must differ from worker identity: ${input.workerId}`
      );
    }

    const diffSha256 = createHash("sha256")
      .update(input.diff, "utf8")
      .digest("hex");

    const validationSha256 = canonicalValidationDigest(input.validation);

    const result = await this.supervisor.execute(
      {
        taskId: "review",
        executable: process.execPath,
        args: [
          this.executable,
          "--diff-sha256",
          diffSha256,
          "--validation-sha256",
          validationSha256,
          "--worker-id",
          input.workerId,
          "--reviewer-id",
          input.reviewerId,
        ],
        cwd: "/tmp",
        timeoutMs: 30_000,
      },
      signal
    );

    if (result.outcome !== "completed") {
      throw new Error(
        `reviewer fixture failed: outcome=${result.outcome}, stderr=${result.stderr}`
      );
    }
    if (result.events.length !== 1) {
      throw new Error(
        `reviewer protocol requires exactly one event, received ${result.events.length}`,
      );
    }

    const parsed = ReviewDecisionSchema.safeParse(result.events[0]);
    if (!parsed.success) {
      throw new Error(`reviewer protocol returned invalid decision: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}
