import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import type {
  OpenCodeReadOnlyProgramRequest,
  OpenCodeReadOnlyProgramResult,
} from "../agents/opencode-read-only-program.js";
import type { MilestoneBudget } from "../contracts/milestone.js";
import {
  canonicalValidationDigest,
  ReviewDecisionSchema,
  ReviewerExecutionError,
  type ReviewDecision,
  type ReviewInput,
  type ReviewerAdapter,
} from "./reviewer-adapter.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const OpenCodeReviewResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reviewerId: z.string().min(1).max(256),
  decision: z.enum(["approve", "deny"]),
  requestSha256: DigestSchema,
  diffSha256: DigestSchema,
  validationSha256: DigestSchema,
  decidedAt: z.string().datetime({ offset: true }),
  reason: z.string().min(1).max(4_096),
});

export interface OpenCodeReviewerProgram {
  run(request: OpenCodeReadOnlyProgramRequest): Promise<OpenCodeReadOnlyProgramResult>;
}

export interface OpenCodeReviewerAssignment {
  readonly milestoneId: string;
  readonly taskId: string;
  readonly repositoryPath: string;
  readonly reviewerId: string;
  readonly budget: Omit<MilestoneBudget, "maxRetries">;
  readonly timeoutMs: number;
}

export class OpenCodeReviewerUncertainError extends Error {
  override readonly name = "OpenCodeReviewerUncertainError";

  constructor(
    readonly evidence: Readonly<{
      reviewerId: string;
      milestoneId: string;
      taskId: string;
      capsuleId: string;
      actorId: string;
      capabilityId: string;
      transportModelId: string;
      requestSha256: string;
      diffSha256: string;
      validationSha256: string;
      brokerTransport: "completed" | "uncertain";
      cleanup: "completed" | "uncertain";
    }>,
  ) {
    super("OpenCode reviewer transport or cleanup requires reconciliation");
  }
}

export class OpenCodeReviewerAdapter implements ReviewerAdapter {
  constructor(
    private readonly program: OpenCodeReviewerProgram,
    private readonly assignment: OpenCodeReviewerAssignment,
  ) {}

  async review(input: ReviewInput, signal: AbortSignal): Promise<ReviewDecision> {
    if (input.workerId === input.reviewerId) {
      throw new Error("OpenCode reviewer identity must differ from worker identity");
    }
    if (input.reviewerId !== this.assignment.reviewerId) {
      throw new Error("OpenCode reviewer assignment identity mismatch");
    }
    const challenged = {
      schemaVersion: 1,
      challenge: randomBytes(32).toString("hex"),
      milestoneId: this.assignment.milestoneId,
      taskId: this.assignment.taskId,
      workerId: input.workerId,
      reviewerId: input.reviewerId,
      diff: input.diff,
      validation: input.validation,
      diffSha256: sha256(input.diff),
      validationSha256: canonicalValidationDigest(input.validation),
    };
    const requestSha256 = sha256(JSON.stringify(challenged));
    const rolePrompt = JSON.stringify({
      instructions: [
        "Review only the supplied diff and validation evidence.",
        "Return exactly one JSON object with no Markdown or commentary.",
        "Use decision approve or deny and retain every supplied identity and digest.",
      ],
      request: challenged,
      requiredResponse: {
        schemaVersion: 1,
        reviewerId: challenged.reviewerId,
        decision: "approve | deny",
        requestSha256,
        diffSha256: challenged.diffSha256,
        validationSha256: challenged.validationSha256,
        decidedAt: "ISO-8601 timestamp",
        reason: "nonempty explanation",
      },
    });
    const result = await this.program.run({
      milestoneId: this.assignment.milestoneId,
      taskId: this.assignment.taskId,
      repositoryPath: this.assignment.repositoryPath,
      role: "reviewer",
      rolePrompt,
      budget: this.assignment.budget,
      timeoutMs: this.assignment.timeoutMs,
      signal,
    });
    if (result.status === "paused") {
      throw new ReviewerExecutionError("failed", "OpenCode reviewer paused at an authority boundary");
    }
    const uncertainty = Object.freeze({
      reviewerId: input.reviewerId,
      milestoneId: result.execution.milestoneId,
      taskId: result.execution.taskId,
      capsuleId: result.execution.capsuleId,
      actorId: result.execution.actorId,
      capabilityId: result.execution.capabilityId,
      transportModelId: result.execution.transportModelId,
      requestSha256,
      diffSha256: challenged.diffSha256,
      validationSha256: challenged.validationSha256,
      brokerTransport: result.brokerTransport,
      cleanup: result.cleanup,
    });
    if (
      result.execution.milestoneId !== this.assignment.milestoneId ||
      result.execution.taskId !== this.assignment.taskId ||
      result.execution.actorId !== this.assignment.reviewerId ||
      result.execution.actorId !== input.reviewerId ||
      result.execution.capabilityId !== result.execution.actorId
    ) {
      throw new Error("OpenCode reviewer execution identity mismatch");
    }
    if (result.brokerTransport === "uncertain" || result.cleanup === "uncertain") {
      throw new OpenCodeReviewerUncertainError(uncertainty);
    }
    if (result.outcome !== "completed" || result.operationOutcome !== "completed") {
      const outcome = result.outcome === "cancelled" || result.outcome === "timed_out"
        ? result.outcome
        : "failed";
      throw new ReviewerExecutionError(outcome, "OpenCode reviewer did not complete");
    }
    if (result.evidence.length !== 1 || result.evidence[0]?.kind !== "review") {
      throw new Error("OpenCode reviewer requires exactly one review evidence item");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(result.evidence[0].summary);
    } catch {
      throw new Error("OpenCode reviewer returned invalid JSON");
    }
    const response = OpenCodeReviewResponseSchema.parse(decoded);
    if (response.reviewerId !== input.reviewerId) {
      throw new Error("OpenCode reviewer identity mismatch");
    }
    if (response.requestSha256 !== requestSha256) {
      throw new Error("OpenCode reviewer request digest mismatch");
    }
    if (response.diffSha256 !== challenged.diffSha256) {
      throw new Error("OpenCode reviewer diff digest mismatch");
    }
    if (response.validationSha256 !== challenged.validationSha256) {
      throw new Error("OpenCode reviewer validation digest mismatch");
    }
    return ReviewDecisionSchema.parse({
      reviewerId: response.reviewerId,
      approved: response.decision === "approve",
      diffSha256: response.diffSha256,
      validationSha256: response.validationSha256,
      decidedAt: response.decidedAt,
      reason: response.reason,
    });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
