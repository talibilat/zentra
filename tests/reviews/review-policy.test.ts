import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PlannedTask } from "../../src/contracts/milestone.js";
import { assessReviewPolicy } from "../../src/reviews/review-policy.js";
import { parseSecuritySheetMarkdown } from "../../src/policy/security-sheet.js";

function securitySheet() {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-review-policy-"));
  const repository = realpathSync.native(directory);
  const parsed = parseSecuritySheetMarkdown(`# Zentra Security Sheet

## Allowed Repositories
- ${repository}

## Allowed File Scopes
- src/**
- tests/**

## Forbidden Paths
- .env
- secrets/**

## Network
Default: denied

## Secret Handling
- Do not inherit parent secrets.

## Approval Required Operations
- external_effect
- modify_protected_path

## Release Boundary
local_preparation_only

## Stop And Ask Conditions
- missing_authority
- forbidden_file_scope
- plan_not_ready
`);
  rmSync(directory, { recursive: true, force: true });
  return parsed;
}

const security = securitySheet();

const task: PlannedTask = {
  taskId: "task-code",
  title: "Code task",
  description: "Change code.",
  dependencies: [],
  ownedPaths: ["src/feature"],
  forbiddenPaths: [".env"],
  acceptanceCriteria: ["Change is reviewed."],
  roleAssignment: { role: "implementer", agentId: "opencode-writer", harness: "opencode" },
  risk: { level: "low", authority: "workspace_write", requiresReview: false, requiresApproval: false },
  budget: { maxSeconds: 300, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000 },
};

describe("assessReviewPolicy", () => {
  it("requires a distinct review decision even for low-risk integration-bound work", () => {
    expect(assessReviewPolicy({
      task,
      security,
      workerId: "opencode-writer",
      reviewerIds: ["opencode-reviewer"],
    })).toEqual({
      status: "ready_for_review",
      reason: "review_required",
      minimumReviewers: 1,
      requiredReviewerRoles: ["reviewer"],
      stopAndAsk: null,
    });
  });

  it("requires stronger review for high-risk work", () => {
    expect(assessReviewPolicy({
      task: { ...task, risk: { ...task.risk, level: "high", requiresReview: true } },
      security,
      workerId: "opencode-writer",
      reviewerIds: ["reviewer-a", "reviewer-b"],
      reviewerRoles: {
        "reviewer-a": ["reviewer"],
        "reviewer-b": ["security_reviewer"],
      },
    })).toMatchObject({
      status: "ready_for_review",
      minimumReviewers: 2,
      requiredReviewerRoles: ["reviewer", "security_reviewer"],
    });
  });

  it("requires stronger review for approval-required or external-authority work", () => {
    expect(assessReviewPolicy({
      task: {
        ...task,
        risk: { level: "low", authority: "external_effect", requiresReview: true, requiresApproval: true },
      },
      security,
      workerId: "opencode-writer",
      reviewerIds: ["reviewer-a"],
      reviewerRoles: { "reviewer-a": ["reviewer"] },
    })).toMatchObject({
      status: "paused",
      reason: "missing_review_policy",
      minimumReviewers: 2,
      requiredReviewerRoles: ["reviewer", "security_reviewer"],
    });
    expect(assessReviewPolicy({
      task: {
        ...task,
        risk: { level: "low", authority: "workspace_write", requiresReview: true, requiresApproval: true },
      },
      security,
      workerId: "opencode-writer",
      reviewerIds: ["reviewer-a", "reviewer-b"],
      reviewerRoles: { "reviewer-a": ["reviewer"], "reviewer-b": ["security_reviewer"] },
    })).toMatchObject({
      status: "ready_for_review",
      minimumReviewers: 2,
      requiredReviewerRoles: ["reviewer", "security_reviewer"],
    });
  });

  it("pauses when review policy evidence is missing", () => {
    expect(assessReviewPolicy({
      task,
      security,
      workerId: "opencode-writer",
      reviewerIds: [],
    })).toMatchObject({
      status: "paused",
      reason: "missing_review_policy",
      stopAndAsk: { reason: "missing_authority" },
    });
  });

  it("rejects self-review", () => {
    expect(assessReviewPolicy({
      task,
      security,
      workerId: "opencode-writer",
      reviewerIds: ["opencode-writer"],
    })).toMatchObject({
      status: "paused",
      reason: "self_review",
      stopAndAsk: { reason: "missing_authority" },
    });
  });

  it("pauses when high-risk work has too few reviewers", () => {
    expect(assessReviewPolicy({
      task: { ...task, risk: { ...task.risk, level: "critical", requiresReview: true, requiresApproval: true } },
      security,
      workerId: "opencode-writer",
      reviewerIds: ["reviewer-a"],
    })).toMatchObject({
      status: "paused",
      reason: "missing_review_policy",
    });
  });

  it("pauses high-risk work without unique reviewer and security-reviewer evidence", () => {
    const highRiskTask = { ...task, risk: { ...task.risk, level: "high" as const, requiresReview: true } };
    expect(assessReviewPolicy({
      task: highRiskTask,
      security,
      workerId: "opencode-writer",
      reviewerIds: ["reviewer-a", "reviewer-a"],
      reviewerRoles: { "reviewer-a": ["reviewer", "security_reviewer"] },
    })).toMatchObject({ status: "paused", reason: "missing_review_policy" });
    expect(assessReviewPolicy({
      task: highRiskTask,
      security,
      workerId: "opencode-writer",
      reviewerIds: ["reviewer-a", "reviewer-b"],
      reviewerRoles: { "reviewer-a": ["reviewer"], "reviewer-b": ["reviewer"] },
    })).toMatchObject({ status: "paused", reason: "missing_review_policy" });
  });

  it("pauses before integration when touched scope is forbidden", () => {
    expect(assessReviewPolicy({
      task: { ...task, ownedPaths: ["secrets/token.ts"] },
      security,
      workerId: "opencode-writer",
      reviewerIds: ["opencode-reviewer"],
    })).toMatchObject({
      status: "paused",
      reason: "forbidden_file_scope",
      stopAndAsk: { reason: "forbidden_file_scope" },
    });
    expect(assessReviewPolicy({
      task: { ...task, ownedPaths: ["docs/plan.md"] },
      security,
      workerId: "opencode-writer",
      reviewerIds: ["opencode-reviewer"],
    })).toMatchObject({
      status: "paused",
      reason: "forbidden_file_scope",
    });
    expect(assessReviewPolicy({
      task: { ...task, ownedPaths: ["secrets"] },
      security,
      workerId: "opencode-writer",
      reviewerIds: ["opencode-reviewer"],
    })).toMatchObject({
      status: "paused",
      reason: "forbidden_file_scope",
    });
  });
});
