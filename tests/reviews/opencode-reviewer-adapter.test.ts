import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { OpenCodeReadOnlyProgramResult } from "../../src/agents/opencode-read-only-program.js";
import {
  OpenCodeReviewerAdapter,
  type OpenCodeReviewerProgram,
} from "../../src/reviews/opencode-reviewer-adapter.js";
import {
  canonicalValidationDigest,
  type ReviewInput,
} from "../../src/reviews/reviewer-adapter.js";

describe("OpenCodeReviewerAdapter", () => {
  it.each(["approve", "deny"] as const)(
    "returns a digest-bound %s decision from the read-only OpenCode reviewer",
    async (decision) => {
      const program = reviewerProgram(decision);
      const adapter = new OpenCodeReviewerAdapter(program, assignment());

      const result = await adapter.review(reviewInput(), new AbortController().signal);

      expect(result).toMatchObject({
        reviewerId: "opencode-reviewer",
        approved: decision === "approve",
        diffSha256: sha256(reviewInput().diff),
        validationSha256: canonicalValidationDigest(reviewInput().validation),
      });
      expect(program.run).toHaveBeenCalledOnce();
      expect(program.run).toHaveBeenCalledWith(expect.objectContaining({
        role: "reviewer",
        repositoryPath: "/canonical/repository",
      }));
    },
  );

  it("rejects self-review before starting OpenCode", async () => {
    const program = reviewerProgram("approve");
    const adapter = new OpenCodeReviewerAdapter(program, assignment());

    await expect(adapter.review({
      ...reviewInput(),
      workerId: "opencode-reviewer",
    }, new AbortController().signal)).rejects.toThrow(/identity.*differ|self-review/i);
    expect(program.run).not.toHaveBeenCalled();
  });

  it.each(["diff", "validation", "reviewer", "execution"] as const)(
    "rejects stale or substituted %s evidence",
    async (substitution) => {
      const program = reviewerProgram("approve", substitution);
      const adapter = new OpenCodeReviewerAdapter(program, assignment());

      await expect(adapter.review(reviewInput(), new AbortController().signal))
        .rejects.toThrow(/mismatch/i);
    },
  );

  it("preserves digest and execution evidence when reviewer transport is uncertain", async () => {
    const adapter = new OpenCodeReviewerAdapter(
      reviewerProgram("approve", "uncertain"),
      assignment(),
    );

    await expect(adapter.review(reviewInput(), new AbortController().signal)).rejects.toMatchObject({
      name: "OpenCodeReviewerUncertainError",
      evidence: {
        reviewerId: "opencode-reviewer",
        milestoneId: "milestone-review",
        taskId: "review-task",
        actorId: "opencode-reviewer",
        brokerTransport: "uncertain",
      },
    });
  });
});

function reviewerProgram(
  decision: "approve" | "deny",
  substitution?: "diff" | "validation" | "reviewer" | "execution" | "uncertain",
): OpenCodeReviewerProgram & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async (request): Promise<OpenCodeReadOnlyProgramResult> => {
      const prompt = JSON.parse(request.rolePrompt) as {
        request: Record<string, unknown>;
      };
      const challenged = prompt.request;
      const response = {
        schemaVersion: 1,
        reviewerId: substitution === "reviewer" ? "other-reviewer" : challenged.reviewerId,
        decision,
        requestSha256: sha256(JSON.stringify(challenged)),
        diffSha256: substitution === "diff" ? "a".repeat(64) : challenged.diffSha256,
        validationSha256: substitution === "validation"
          ? "b".repeat(64)
          : challenged.validationSha256,
        decidedAt: "2026-07-16T12:00:00.000Z",
        reason: decision === "approve" ? "The validated change is acceptable." : "The change is unsafe.",
      };
      return {
        outcome: "completed",
        openCode: { version: "1.18.1", executableSha256: "c".repeat(64) },
        model: { id: "fixture/model", provider: "fixture", name: "reviewer-v1" },
        evidence: [{ kind: "review", summary: JSON.stringify(response) }],
        cleanup: "completed",
        brokerTransport: substitution === "uncertain" ? "uncertain" : "completed",
        trace: { outcome: "emitted" },
        operationOutcome: "completed",
        execution: {
          milestoneId: request.milestoneId,
          taskId: request.taskId,
          capsuleId: "capsule-review-1",
          actorId: substitution === "execution" ? "other-reviewer" : "opencode-reviewer",
          capabilityId: "opencode-reviewer",
          transportModelId: "fixture/model",
        },
      };
    }),
  };
}

function assignment() {
  return {
    milestoneId: "milestone-review",
    taskId: "review-task",
    repositoryPath: "/canonical/repository",
    reviewerId: "opencode-reviewer",
    budget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 },
    timeoutMs: 20_000,
  } as const;
}

function reviewInput(): ReviewInput {
  const command = [process.execPath, "--test"];
  const stdout = "ok\n";
  const stderr = "";
  return {
    workerId: "opencode-writer",
    reviewerId: "opencode-reviewer",
    diff: "diff --git a/src/a.ts b/src/a.ts\n",
    validation: {
      name: "focused",
      outcome: "completed",
      exitCode: 0,
      stdout,
      stderr,
      startedAt: "2026-07-16T11:59:59.000Z",
      finishedAt: "2026-07-16T12:00:00.000Z",
      command,
      argvSha256: sha256(JSON.stringify(command)),
      outputSha256: sha256(JSON.stringify({ stdout, stderr })),
      timeoutMs: 5_000,
      provenance: {
        invocationId: "validation-1",
        canonicalCwd: "/work/task",
        subjectSha256: sha256("diff --git a/src/a.ts b/src/a.ts\n"),
        timeoutMs: 5_000,
      },
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
