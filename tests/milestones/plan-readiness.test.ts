import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assessMilestonePlanReadiness } from "../../src/milestones/plan-readiness.js";
import { parseSecuritySheetMarkdown } from "../../src/policy/security-sheet.js";

function securitySheet(options: { network?: boolean } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-readiness-"));
  const repository = realpathSync.native(directory);
  const sheet = parseSecuritySheetMarkdown(`# Zentra Security Sheet

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
${options.network === false ? "" : `Allowed Destinations:
- https://api.github.com
`}

## Secret Handling
- Do not inherit parent secrets.

## Approval Required Operations
- external_effect
- publish_release

## Release Boundary
local_preparation_only

## Stop And Ask Conditions
- missing_authority
- undeclared_network
- forbidden_file_scope
- release_boundary
- plan_not_ready
`);
  rmSync(directory, { recursive: true, force: true });
  return sheet;
}

const security = securitySheet();

const baseTask = {
  taskId: "task-a",
  title: "Implement slice",
  description: "Implement a safe slice.",
  dependencies: [],
  ownedPaths: ["src/feature"],
  forbiddenPaths: [".env"],
  acceptanceCriteria: ["The slice is demonstrable."],
  roleAssignment: { role: "implementer", agentId: "opencode-general", harness: "opencode" },
  risk: { level: "low", authority: "workspace_write", requiresReview: true, requiresApproval: false },
  budget: { maxSeconds: 300, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000 },
};

const basePlan = {
  milestoneId: "milestone-ready",
  projectId: "zentra",
  goal: "Implement one safe slice.",
  tasks: [baseTask],
};

describe("assessMilestonePlanReadiness", () => {
  it("marks an in-policy milestone plan executable", () => {
    expect(assessMilestonePlanReadiness({ plan: basePlan, security })).toEqual({
      status: "executable",
      reason: "ready",
      stopAndAsk: null,
    });
  });

  it("blocks malformed plans with missing acceptance criteria", () => {
    const { acceptanceCriteria: _acceptanceCriteria, ...task } = baseTask;

    expect(assessMilestonePlanReadiness({
      plan: { ...basePlan, tasks: [task] },
      security,
    })).toMatchObject({
      status: "blocked",
      reason: "plan_not_ready",
      stopAndAsk: { reason: "plan_not_ready" },
    });
  });

  it("blocks cyclic dependency graphs", () => {
    expect(assessMilestonePlanReadiness({
      plan: {
        ...basePlan,
        tasks: [
          { ...baseTask, taskId: "task-a", dependencies: ["task-b"] },
          { ...baseTask, taskId: "task-b", dependencies: ["task-a"] },
        ],
      },
      security,
    })).toMatchObject({
      status: "blocked",
      reason: "plan_not_ready",
    });
  });

  it("requires approval when owned paths are outside allowed file scope", () => {
    expect(assessMilestonePlanReadiness({
      plan: { ...basePlan, tasks: [{ ...baseTask, ownedPaths: ["docs/plan.md"] }] },
      security,
    })).toMatchObject({
      status: "requires_approval",
      reason: "forbidden_file_scope",
      stopAndAsk: { reason: "forbidden_file_scope" },
    });
  });

  it("requires approval when owned paths overlap forbidden paths", () => {
    expect(assessMilestonePlanReadiness({
      plan: { ...basePlan, tasks: [{ ...baseTask, ownedPaths: ["secrets/token.txt"] }] },
      security,
    })).toMatchObject({
      status: "requires_approval",
      reason: "forbidden_file_scope",
    });
  });

  it("requires approval for undeclared network authority", () => {
    expect(assessMilestonePlanReadiness({
      plan: {
        ...basePlan,
        tasks: [{
          ...baseTask,
          risk: { level: "low", authority: "external_effect", requiresReview: true, requiresApproval: true },
        }],
      },
      security: securitySheet({ network: false }),
    })).toMatchObject({
      status: "requires_approval",
      reason: "undeclared_network",
      stopAndAsk: { reason: "undeclared_network" },
    });
  });

  it("requires approval for release effects beyond local preparation", () => {
    expect(assessMilestonePlanReadiness({
      plan: { ...basePlan, tasks: [{ ...baseTask, risk: { ...baseTask.risk, authority: "local_release_preparation" } }] },
      security,
    })).toMatchObject({
      status: "requires_approval",
      reason: "release_boundary",
      stopAndAsk: { reason: "release_boundary" },
    });
  });
});
