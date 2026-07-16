import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assessMilestonePlanReadiness } from "../../src/milestones/plan-readiness.js";
import { parseSecuritySheetMarkdown } from "../../src/policy/security-sheet.js";
import { createOpenCodeAdmissionPacket } from "../../src/contracts/authority-attention.js";
import type { OpenCodeTaskAdmissionContext } from "../../src/milestones/milestone-registry.js";
import { MilestonePlanSchema } from "../../src/contracts/milestone.js";

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

const context: OpenCodeTaskAdmissionContext = {
  kind: "opencode", repositoryPath: process.cwd(), actorId: "opencode-general", harness: "opencode",
  role: "implementer", capabilityId: "opencode-general", transportModelId: "fixture/model",
  authority: "workspace_write",
  roles: ["implementer"], toolPermissions: ["read_repository"], network: "denied",
  contextTokens: 10_000,
  requestedBudget: { maxSeconds: 300, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000, timeoutMs: 300_000 },
};

function assess(candidate: unknown, sheet = security) {
  const parsedCandidate = MilestonePlanSchema.safeParse(candidate);
  const packetPlan = parsedCandidate.success ? parsedCandidate.data : basePlan;
  const candidateAuthority = typeof candidate === "object" && candidate !== null && "tasks" in candidate &&
    Array.isArray((candidate as { tasks: unknown }).tasks)
    ? ((candidate as { tasks: Array<{ risk?: { authority?: typeof context.authority } }> }).tasks[0]?.risk?.authority ?? context.authority)
    : context.authority;
  const boundContext = { ...context, authority: candidateAuthority };
  const packet = createOpenCodeAdmissionPacket({
    plan: packetPlan as never, milestoneId: "milestone-ready", taskId: "task-a", security: sheet,
    canonicalRepository: sheet.allowedRepositories[0]!, actorId: context.actorId, role: context.role,
    harness: context.harness,
    capabilityId: context.capabilityId, transportModelId: context.transportModelId,
    authority: candidateAuthority, roles: context.roles, toolPermissions: context.toolPermissions,
    network: context.network, contextTokens: context.contextTokens, requestedBudget: context.requestedBudget,
  });
  return assessMilestonePlanReadiness({ plan: candidate, taskId: "task-a", security: sheet, packet, context: boundContext });
}

describe("assessMilestonePlanReadiness", () => {
  it("marks an in-policy milestone plan executable", () => {
    expect(assess(basePlan)).toEqual({
      status: "executable",
      reason: "ready",
      attention: null,
    });
  });

  it("blocks malformed plans with missing acceptance criteria", () => {
    const { acceptanceCriteria: _acceptanceCriteria, ...task } = baseTask;

    expect(assess({ ...basePlan, tasks: [task] })).toMatchObject({
      status: "blocked",
      reason: "plan_not_ready",
      attention: { reason: "plan_not_ready", classification: "hard_stop" },
    });
  });

  it("blocks cyclic dependency graphs", () => {
    expect(assess({
        ...basePlan,
        tasks: [
          { ...baseTask, taskId: "task-a", dependencies: ["task-b"] },
          { ...baseTask, taskId: "task-b", dependencies: ["task-a"] },
        ],
      })).toMatchObject({
      status: "blocked",
      reason: "plan_not_ready",
    });
  });

  it("hard stops when owned paths are outside allowed file scope", () => {
    expect(assess({ ...basePlan, tasks: [{ ...baseTask, ownedPaths: ["docs/plan.md"] }] })).toMatchObject({
      status: "blocked",
      reason: "forbidden_file_scope",
      attention: { reason: "forbidden_file_scope", classification: "hard_stop" },
    });
  });

  it("hard stops when owned paths overlap forbidden paths", () => {
    expect(assess({ ...basePlan, tasks: [{ ...baseTask, ownedPaths: ["secrets/token.txt"] }] })).toMatchObject({
      status: "blocked",
      reason: "forbidden_file_scope",
    });
  });

  it("requires approval for undeclared network authority", () => {
    expect(assess({
        ...basePlan,
        tasks: [{
          ...baseTask,
          risk: { level: "low", authority: "external_effect", requiresReview: true, requiresApproval: true },
        }],
      }, securitySheet({ network: false }))).toMatchObject({
      status: "blocked",
      reason: "undeclared_network",
      attention: { reason: "undeclared_network", classification: "hard_stop" },
    });
  });

  it("allows local release preparation at a local-only boundary", () => {
    expect(assess({ ...basePlan, tasks: [{ ...baseTask, risk: { ...baseTask.risk, authority: "local_release_preparation" } }] }))
      .toEqual({ status: "executable", reason: "ready", attention: null });
  });
});
