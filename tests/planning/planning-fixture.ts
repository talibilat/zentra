import type { PlanningProposalInput } from "../../src/planning/planning-contracts.js";

const digest = (character: string) => character.repeat(64);

export const runBudgetFixture = {
  maxDurationMs: 60_000,
  maxInputTokens: 1_000,
  maxOutputTokens: 1_000,
  maxCostUsdNano: 1_000_000_000,
  maxRetries: 1,
  maxSourceFiles: 10,
  maxSourceBytes: 10_000,
};

export function planningProposalFixture(): PlanningProposalInput {
  return {
    runId: "run-93",
    projectId: "zentra",
    projectRevision: { objectFormat: "sha1", commit: "a".repeat(40) },
    securityDigest: digest("5"),
    capabilityCatalogDigest: digest("4"),
    analysisEvidence: {
      analysisStreamId: "analysis:run-93",
      completionEventId: "00000000-0000-4000-8000-000000000093",
      evidenceSha256: digest("b"),
      sourceEvidenceSha256: digest("c"),
    },
    plan: {
      milestoneId: "milestone-93",
      projectId: "zentra",
      goal: "Implement the approved parser behavior",
      tasks: [{
        taskId: "parser",
        title: "Implement parser",
        description: "Implement and verify the bounded parser change.",
        dependencies: [],
        ownedPaths: ["src/parser.ts"],
        forbiddenPaths: ["secrets"],
        acceptanceCriteria: ["The parser passes validation."],
        roleAssignment: { role: "implementer", agentId: "worker-1", harness: "deterministic" },
        risk: { level: "medium", authority: "workspace_write", requiresReview: true, requiresApproval: true },
        budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 0.01, maxInputTokens: 200, maxOutputTokens: 100 },
      }],
    },
    taskSpecifications: [{
      taskId: "parser",
      capabilityId: "worker-1",
      broadReadPaths: ["src"],
      potentialWritePaths: ["src/parser.ts"],
      evidenceRequirements: [
        { criterionIndex: 0, kind: "changed_paths", producerRole: "implementer", digestBound: true },
        { criterionIndex: 0, kind: "validation_report", producerRole: "validator", digestBound: true },
        { criterionIndex: 0, kind: "review_decision", producerRole: "reviewer", digestBound: true },
      ],
      requiredValidationIds: ["focused"],
    }],
    validationIdentities: [{
      validationId: "focused",
      executable: "/approved/node",
      executableDevice: 1,
      executableInode: 2,
      executableSize: 3,
      executableSha256: digest("d"),
      args: ["--test"],
      argvSha256: digest("e"),
      timeoutMs: 30_000,
      projectConfigSha256: digest("f"),
    }],
  };
}
