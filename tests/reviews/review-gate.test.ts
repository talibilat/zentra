import { beforeAll, describe, expect, it } from "vitest";
import {
  isVerifiedReviewDecision,
  ReviewGate,
} from "../../src/reviews/review-gate.js";
import type { ValidationReport } from "../../src/capabilities/validation-runner.js";
import {
  canonicalValidationDigest,
  type ReviewInput,
  type ReviewDecision,
} from "../../src/reviews/reviewer-adapter.js";
import { createHash } from "node:crypto";
import { ValidationRunner } from "../../src/capabilities/validation-runner.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";

function hashInput(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("ReviewGate", () => {
  const gate = new ReviewGate();

  const diff = "diff content";
  const diffSha256 = hashInput(diff);
  let validationReport!: ValidationReport;
  let validationSha256!: string;
  let input!: ReviewInput;
  let decision!: ReviewDecision;

  beforeAll(async () => {
    const command = [process.execPath, "-e", 'process.stdout.write("test output")'] as const;
    validationReport = await new ValidationRunner(new ProcessSupervisor()).run(
      {
        projectId: "review-gate",
        repositoryPath: "/tmp",
        integrationBranch: "integration",
        worktreeRoot: "/tmp",
        validations: {
          focused: [...command],
          full: [...command],
          focusedTimeoutMs: 5_000,
          fullTimeoutMs: 5_000,
        },
      },
      "focused",
      "/tmp",
      AbortSignal.timeout(5_000),
      { invocationId: "review-gate-current-diff", subjectSha256: diffSha256 },
    );
    validationSha256 = canonicalValidationDigest(validationReport);
    input = {
      workerId: "worker-1",
      reviewerId: "reviewer-1",
      diff,
      validation: validationReport,
    };
    decision = {
      reviewerId: "reviewer-1",
      approved: true,
      diffSha256,
      validationSha256,
      decidedAt: new Date().toISOString(),
      reason: "looks good",
    };
  });

  it("approves when all conditions pass", () => {
    const verified = gate.verify(input, decision);
    expect(verified).toEqual(decision);
    expect(verified).not.toBe(decision);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(decision)).toBe(false);
  });

  it("reads accessor-backed decision fields once into the verified snapshot", () => {
    const reads = new Map<keyof ReviewDecision, number>();
    const values: ReviewDecision = { ...decision };
    const retargeted: ReviewDecision = {
      reviewerId: "attacker",
      approved: false,
      diffSha256: "0".repeat(64),
      validationSha256: "1".repeat(64),
      decidedAt: new Date(0).toISOString(),
      reason: "retargeted",
    };
    const source = {} as ReviewDecision;
    for (const key of Object.keys(values) as (keyof ReviewDecision)[]) {
      Object.defineProperty(source, key, {
        configurable: true,
        enumerable: true,
        get: () => {
          const count = (reads.get(key) ?? 0) + 1;
          reads.set(key, count);
          return count === 1 ? values[key] : retargeted[key];
        },
      });
      reads.set(key, 0);
    }

    const verified = gate.verify(input, source);

    expect(verified).toEqual(values);
    expect([...reads.values()]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(isVerifiedReviewDecision(verified)).toBe(true);
    expect(isVerifiedReviewDecision(source)).toBe(false);
  });

  it("registers only a captured snapshot from a retargeting Proxy", () => {
    const values: ReviewDecision = { ...decision };
    const reads = new Map<PropertyKey, number>();
    const source = new Proxy(values, {
      get(target, property, receiver) {
        const count = (reads.get(property) ?? 0) + 1;
        reads.set(property, count);
        if (count > 1 && property === "diffSha256") return "0".repeat(64);
        return Reflect.get(target, property, receiver);
      },
    });

    const verified = gate.verify(input, source);

    expect(verified).toEqual(values);
    expect(verified).not.toBe(source);
    expect(isVerifiedReviewDecision(verified)).toBe(true);
    expect(isVerifiedReviewDecision(source)).toBe(false);
  });

  it("rejects when diff is empty", () => {
    const emptyDiffInput: ReviewInput = {
      ...input,
      diff: "",
    };

    expect(() => gate.verify(emptyDiffInput, decision)).toThrow(
      /diff.*empty/i
    );
  });

  it("rejects when validation outcome is not completed", () => {
    const failedValidation: ValidationReport = {
      ...validationReport,
      outcome: "failed",
    };
    const failedInput: ReviewInput = {
      ...input,
      validation: failedValidation,
    };

    expect(() => gate.verify(failedInput, decision)).toThrow(
      /validation.*provenance/i
    );
  });

  it("rejects an otherwise valid decision over a fabricated validation report", () => {
    const fabricated = { ...validationReport };
    expect(() => gate.verifyEvidence({ ...input, validation: fabricated }, decision)).toThrow(
      /provenance|validation/i,
    );
  });

  it("rejects a branded validation report bound to an old diff", async () => {
    const oldDiff = "old diff content";
    const command = [process.execPath, "-e", 'process.stdout.write("test output")'] as const;
    const oldValidation = await new ValidationRunner(new ProcessSupervisor()).run(
      {
        projectId: "review-gate-old",
        repositoryPath: "/tmp",
        integrationBranch: "integration",
        worktreeRoot: "/tmp",
        validations: {
          focused: [...command],
          full: [...command],
          focusedTimeoutMs: 5_000,
          fullTimeoutMs: 5_000,
        },
      },
      "focused",
      "/tmp",
      AbortSignal.timeout(5_000),
      { invocationId: "review-gate-old-diff", subjectSha256: hashInput(oldDiff) },
    );
    const newInput = { ...input, validation: oldValidation };
    const newDecision = {
      ...decision,
      validationSha256: canonicalValidationDigest(oldValidation),
    };

    expect(() => gate.verify(newInput, newDecision)).toThrow(/subject|diff|provenance/i);
    expect(isVerifiedReviewDecision(newDecision)).toBe(false);
  });

  it("rejects when validation exit code is not 0", () => {
    const badExitValidation: ValidationReport = {
      ...validationReport,
      exitCode: 1,
    };
    const badExitInput: ReviewInput = {
      ...input,
      validation: badExitValidation,
    };

    expect(() => gate.verify(badExitInput, decision)).toThrow(
      /validation.*provenance/i
    );
  });

  it("rejects when reviewer identity matches worker identity", () => {
    const selfReviewInput: ReviewInput = {
      ...input,
      workerId: "same-id",
      reviewerId: "same-id",
    };

    expect(() => gate.verify(selfReviewInput, decision)).toThrow(
      /reviewer.*worker|identity/i
    );
  });

  it("rejects a validation other than focused", () => {
    const fullInput = { ...input, validation: { ...validationReport, name: "full" } };
    expect(() => gate.verify(fullInput, decision)).toThrow(/validation.*provenance/i);
  });

  it("rejects when the decision reviewer differs from the requested reviewer", () => {
    expect(() => gate.verify(input, { ...decision, reviewerId: "reviewer-2" })).toThrow(/reviewer/i);
  });

  it("rejects when diff digest in decision does not match current diff", () => {
    const wrongDiffDecision: ReviewDecision = {
      ...decision,
      diffSha256: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    expect(() => gate.verify(input, wrongDiffDecision)).toThrow(
      /diff.*mismatch|stale/i
    );
  });

  it("rejects when validation digest in decision does not match current validation", () => {
    const wrongValidationDecision: ReviewDecision = {
      ...decision,
      validationSha256: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    expect(() => gate.verify(input, wrongValidationDecision)).toThrow(
      /validation.*mismatch|stale/i
    );
  });

  it("rejects when decision.approved is false", () => {
    const deniedDecision: ReviewDecision = {
      ...decision,
      approved: false,
      reason: "not approved",
    };

    expect(() => gate.verify(input, deniedDecision)).toThrow(/not approved/i);
  });

  it("verifies and freezes valid denial evidence without integration provenance", () => {
    const denied = { ...decision, approved: false, reason: "policy rejected" };

    const evidence = gate.verifyEvidence(input, denied);

    expect(evidence).toEqual(denied);
    expect(evidence).not.toBe(denied);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(isVerifiedReviewDecision(evidence)).toBe(false);
  });

  it.each([
    ["stale diff", { diffSha256: "0".repeat(64) }],
    ["wrong reviewer", { reviewerId: "reviewer-2" }],
  ])("rejects %s denial evidence", (_case, change) => {
    const denied = {
      ...decision,
      approved: false,
      reason: "policy rejected",
      ...change,
    };

    expect(() => gate.verifyEvidence(input, denied)).toThrow();
  });

  it.each([
    ["extra field", { ...decision, extra: true }],
    ["non-boolean approval", { ...decision, approved: "yes" }],
    ["invalid timestamp", { ...decision, decidedAt: "yesterday" }],
    ["empty reason", { ...decision, reason: "" }],
  ])("strictly rejects a runtime decision with %s", (_case, malformed) => {
    expect(() => gate.verifyEvidence(input, malformed as never)).toThrow(/decision|invalid/i);
  });

  it("rejects cancelled validation", () => {
    const cancelledValidation: ValidationReport = {
      ...validationReport,
      outcome: "cancelled",
    };
    const cancelledInput: ReviewInput = {
      ...input,
      validation: cancelledValidation,
    };

    expect(() => gate.verify(cancelledInput, decision)).toThrow();
  });

  it("rejects timed_out validation", () => {
    const timedOutValidation: ValidationReport = {
      ...validationReport,
      outcome: "timed_out",
    };
    const timedOutInput: ReviewInput = {
      ...input,
      validation: timedOutValidation,
    };

    expect(() => gate.verify(timedOutInput, decision)).toThrow();
  });

  it("rejects inconsistent embedded command and output digests", () => {
    expect(() => canonicalValidationDigest({ ...validationReport, argvSha256: "0".repeat(64) })).toThrow(
      /argv/i,
    );
    expect(() => canonicalValidationDigest({ ...validationReport, outputSha256: "0".repeat(64) })).toThrow(
      /output/i,
    );
  });

  it.each([
    ["name", { name: "full" }],
    ["stdout", { stdout: "changed output" }],
    ["stderr", { stderr: "changed error" }],
    ["startedAt", { startedAt: "2026-01-01T00:00:00.000Z" }],
    ["finishedAt", { finishedAt: "2026-01-01T00:00:01.000Z" }],
  ])("changes the canonical digest when authoritative %s evidence changes", (_field, change) => {
    const changed = { ...validationReport, ...change };
    changed.argvSha256 = hashInput(JSON.stringify(changed.command));
    changed.outputSha256 = hashInput(JSON.stringify({ stdout: changed.stdout, stderr: changed.stderr }));
    expect(canonicalValidationDigest(changed)).not.toBe(validationSha256);
  });
});
