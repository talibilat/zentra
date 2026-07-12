import type { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import {
  canonicalValidationDigest,
  ReviewerExecutionError,
  ReviewDecisionSchema,
  type ReviewDecision,
  type ReviewerAdapter,
  type ReviewInput,
} from "../../src/reviews/reviewer-adapter.js";
import { createHash } from "node:crypto";

export class DeterministicReviewerAdapter implements ReviewerAdapter {
  constructor(
    private readonly supervisor: ProcessSupervisor,
    private readonly executable: string,
  ) {}

  async review(input: ReviewInput, signal: AbortSignal): Promise<ReviewDecision> {
    if (input.workerId === input.reviewerId) {
      throw new Error(
        `reviewer identity must differ from worker identity: ${input.workerId}`,
      );
    }

    const result = await this.supervisor.execute(
      {
        taskId: "review",
        executable: process.execPath,
        args: [
          this.executable,
          "--diff-sha256",
          createHash("sha256").update(input.diff, "utf8").digest("hex"),
          "--validation-sha256",
          canonicalValidationDigest(input.validation),
          "--worker-id",
          input.workerId,
          "--reviewer-id",
          input.reviewerId,
        ],
        cwd: "/tmp",
        timeoutMs: 30_000,
      },
      signal,
    );

    if (result.outcome !== "completed") {
      throw new ReviewerExecutionError(result.outcome, result.stderr);
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
