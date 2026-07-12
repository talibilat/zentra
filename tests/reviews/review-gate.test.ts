import { describe, expect, it } from "vitest";
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

function hashInput(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("ReviewGate", () => {
  const gate = new ReviewGate();

  const validationReport: ValidationReport = {
    name: "focused",
    outcome: "completed",
    exitCode: 0,
    stdout: "test output",
    stderr: "",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    command: ["echo", "test"],
    argvSha256: hashInput(JSON.stringify(["echo", "test"])),
    outputSha256: hashInput(JSON.stringify({ stdout: "test output", stderr: "" })),
  };

  const diff = "diff content";
  const diffSha256 = hashInput(diff);
  const validationSha256 = canonicalValidationDigest(validationReport);

  const input: ReviewInput = {
    workerId: "worker-1",
    reviewerId: "reviewer-1",
    diff,
    validation: validationReport,
  };

  const decision: ReviewDecision = {
    reviewerId: "reviewer-1",
    approved: true,
    diffSha256,
    validationSha256,
    decidedAt: new Date().toISOString(),
    reason: "looks good",
  };

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
      /validation.*completed/i
    );
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
      /exit.*0/i
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
    expect(() => gate.verify(fullInput, decision)).toThrow(/focused/i);
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
