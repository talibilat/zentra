import { createHash } from "node:crypto";
import type { ReviewInput, ReviewDecision } from "./reviewer-adapter.js";
import {
  canonicalValidationDigest,
  ReviewDecisionSchema,
} from "./reviewer-adapter.js";
import {
  isVerifiedValidationReport,
  isVerifiedValidationSubject,
} from "../capabilities/validation-runner.js";

const verifiedDecisions = new WeakSet<ReviewDecision>();

export function isVerifiedReviewDecision(decision: ReviewDecision): boolean {
  return verifiedDecisions.has(decision);
}

export class ReviewGate {
  verifyEvidence(input: ReviewInput, decision: ReviewDecision): ReviewDecision {
    if (!isVerifiedValidationReport(input.validation)) {
      throw new Error("review gate: validation report lacks provenance");
    }
    const captured = {
      reviewerId: decision.reviewerId,
      approved: decision.approved,
      diffSha256: decision.diffSha256,
      validationSha256: decision.validationSha256,
      decidedAt: decision.decidedAt,
      reason: decision.reason,
    };
    const expectedKeys = Object.keys(captured).sort();
    const actualKeys = Object.keys(decision).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error("review gate: invalid decision fields");
    }
    const parsed = ReviewDecisionSchema.safeParse(captured);
    if (!parsed.success) {
      throw new Error(`review gate: invalid decision: ${parsed.error.message}`);
    }
    const snapshot: ReviewDecision = parsed.data;
    // Reject nonempty diff requirement
    if (!input.diff || input.diff.trim() === "") {
      throw new Error("review gate: diff is empty");
    }
    const inputDiffSha256 = createHash("sha256").update(input.diff, "utf8").digest("hex");
    if (!isVerifiedValidationSubject(input.validation, inputDiffSha256)) {
      throw new Error("review gate: validation subject does not match input diff");
    }

    // Reject if validation outcome is not completed
    if (input.validation.outcome !== "completed") {
      throw new Error(
        `review gate: validation outcome must be 'completed', got '${input.validation.outcome}'`
      );
    }

    // Reject if validation exit code is not 0
    if (input.validation.exitCode !== 0) {
      throw new Error(
        `review gate: validation exit code must be 0, got ${input.validation.exitCode}`
      );
    }

    if (input.validation.name !== "focused") {
      throw new Error(
        `review gate: validation name must be 'focused', got '${input.validation.name}'`,
      );
    }

    // Reject if reviewer identity matches worker identity
    if (input.workerId === input.reviewerId) {
      throw new Error(
        "review gate: reviewer identity must differ from worker identity"
      );
    }

    if (snapshot.reviewerId !== input.reviewerId) {
      throw new Error("review gate: decision reviewer identity does not match requested reviewer");
    }

    const currentValidationSha256 = canonicalValidationDigest(input.validation);

    // Reject if diff digest does not match
    if (snapshot.diffSha256 !== inputDiffSha256) {
      throw new Error(
        `review gate: diff digest mismatch - decision was ${snapshot.diffSha256}, current is ${inputDiffSha256}`
      );
    }

    // Reject if validation digest does not match
    if (snapshot.validationSha256 !== currentValidationSha256) {
      throw new Error(
        `review gate: validation digest mismatch - decision was ${snapshot.validationSha256}, current is ${currentValidationSha256}`
      );
    }

    Object.freeze(snapshot);
    return snapshot;
  }

  verify(input: ReviewInput, decision: ReviewDecision): ReviewDecision {
    const snapshot = this.verifyEvidence(input, decision);
    if (!snapshot.approved) {
      throw new Error(`review gate: decision was not approved: ${snapshot.reason}`);
    }
    verifiedDecisions.add(snapshot);
    return snapshot;
  }
}
