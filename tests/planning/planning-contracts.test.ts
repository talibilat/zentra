import { describe, expect, it } from "vitest";
import { digestCanonical } from "../../src/contracts/authority-attention.js";

import {
  assertCorrectionWithinBounds,
  buildPlanningArtifact,
  PlanningArtifactSchema,
  type PlanningProposalInput,
} from "../../src/planning/planning-contracts.js";
import {
  APPROVED_VALIDATION_EXECUTABLE,
  ProjectConfigSchema,
  createValidationIdentitySnapshot,
} from "../../src/projects/project-config.js";

const digest = (character: string) => character.repeat(64);

function proposal(): PlanningProposalInput {
  return {
    runId: "run-93",
    projectId: "zentra",
    projectRevision: { objectFormat: "sha1", commit: "a".repeat(40) },
    securityDigest: digest("5"),
    capabilityCatalogDigest: digest("4"),
    analysisEvidence: {
      analysisStreamId: "analysis:run-93",
      completionEventId: "analysis-completed-93",
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
        ownedPaths: ["src/parser.ts", "tests/parser.test.ts"],
        forbiddenPaths: ["secrets"],
        acceptanceCriteria: ["The parser passes its focused validation."],
        roleAssignment: { role: "implementer", agentId: "worker-1", harness: "deterministic" },
        risk: { level: "medium", authority: "workspace_write", requiresReview: true, requiresApproval: true },
        budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 0.01, maxInputTokens: 200, maxOutputTokens: 100 },
      }],
    },
    taskSpecifications: [{
      taskId: "parser",
      capabilityId: "worker-1",
      broadReadPaths: ["src", "tests"],
      potentialWritePaths: ["src/parser.ts", "tests/parser.test.ts"],
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
      args: ["--test", "tests/parser.test.ts"],
      argvSha256: digest("e"),
      timeoutMs: 30_000,
      projectConfigSha256: digest("f"),
    }],
  };
}

const budget = {
  maxDurationMs: 60_000,
  maxInputTokens: 1_000,
  maxOutputTokens: 1_000,
  maxCostUsdNano: 1_000_000_000,
  maxRetries: 1,
  maxSourceFiles: 10,
  maxSourceBytes: 10_000,
};

describe("buildPlanningArtifact", () => {
  it("snapshots the approved canonical executable and exact configured arguments", () => {
    const project = ProjectConfigSchema.parse({
      projectId: "zentra",
      repositoryPath: "/tmp/zentra",
      worktreeRoot: "/tmp/zentra-worktrees",
      validations: {
        focused: [APPROVED_VALIDATION_EXECUTABLE, "--test", "tests/parser.test.ts"],
        full: [APPROVED_VALIDATION_EXECUTABLE, "--test"],
      },
    });

    expect(createValidationIdentitySnapshot(project, "focused")).toMatchObject({
      validationId: "focused",
      executable: APPROVED_VALIDATION_EXECUTABLE,
      args: ["--test", "tests/parser.test.ts"],
      timeoutMs: 30_000,
    });
  });

  it("derives an exact authority-free envelope from a valid DAG", () => {
    const artifact = buildPlanningArtifact(proposal(), budget, 1);

    expect(artifact.envelope).toMatchObject({
      runId: "run-93",
      proposalRevision: 1,
      writerCapacity: 1,
      executionAuthority: "none",
      potentialWriteSemantics: "descriptive_upper_bound_only",
      broadReadPaths: ["src", "tests"],
      potentialWritePaths: ["src/parser.ts", "tests/parser.test.ts"],
    });
    expect(artifact.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.envelopeDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["dependency cycle", (input: PlanningProposalInput) => {
      input.plan.tasks.push({ ...input.plan.tasks[0]!, taskId: "tests", dependencies: ["parser"] });
      input.plan.tasks[0]!.dependencies = ["tests"];
      input.taskSpecifications.push({ ...input.taskSpecifications[0]!, taskId: "tests" });
    }],
    ["write outside ownership", (input: PlanningProposalInput) => {
      input.taskSpecifications[0]!.potentialWritePaths = ["README.md"];
    }],
    ["missing acceptance evidence", (input: PlanningProposalInput) => {
      input.taskSpecifications[0]!.evidenceRequirements = [];
    }],
    ["unknown validation", (input: PlanningProposalInput) => {
      input.taskSpecifications[0]!.requiredValidationIds = ["full"];
    }],
    ["duration expansion", (input: PlanningProposalInput) => {
      input.plan.tasks[0]!.budget.maxSeconds = 61;
    }],
  ])("rejects %s", (_label, mutate) => {
    const input = proposal();
    mutate(input);
    expect(() => buildPlanningArtifact(input, budget, 1)).toThrow();
  });

  it("rejects read-only roles with potential writes", () => {
    const input = proposal();
    input.plan.tasks[0]!.roleAssignment.role = "researcher";
    input.plan.tasks[0]!.risk.authority = "read_only";
    expect(() => buildPlanningArtifact(input, budget, 1)).toThrow(/read-only/i);
  });

  it("rejects generated dependency cycles of every supported shape", () => {
    for (let taskCount = 1; taskCount <= 16; taskCount += 1) {
      const input = proposal();
      input.plan.tasks = Array.from({ length: taskCount }, (_, index) => ({
        ...input.plan.tasks[0]!,
        taskId: `task-${index}`,
        dependencies: [`task-${(index + 1) % taskCount}`],
      }));
      input.taskSpecifications = Array.from({ length: taskCount }, (_, index) => ({
        ...input.taskSpecifications[0]!,
        taskId: `task-${index}`,
      }));
      expect(() => buildPlanningArtifact(input, budget, 1)).toThrow(/cycle/i);
    }
  });

  it("prevents corrections from expanding ownership or weakening forbidden paths", () => {
    const rejected = buildPlanningArtifact(proposal(), budget, 1);
    const ownershipExpansion = proposal();
    ownershipExpansion.plan.tasks[0]!.ownedPaths.push("src/other.ts");
    const expanded = buildPlanningArtifact(ownershipExpansion, budget, 2);
    expect(() => assertCorrectionWithinBounds(expanded, rejected.envelope)).toThrow(/owned path scope/i);

    const forbiddenWeakening = proposal();
    forbiddenWeakening.plan.tasks[0]!.forbiddenPaths = [];
    const weakened = buildPlanningArtifact(forbiddenWeakening, budget, 2);
    expect(() => assertCorrectionWithinBounds(weakened, rejected.envelope)).toThrow(/forbidden path protection/i);
  });

  it("rejects substituted envelopes and removal of required validation identity", () => {
    const rejected = buildPlanningArtifact(proposal(), budget, 1);
    const substitutedEnvelope = {
      ...rejected.envelope,
      potentialWritePaths: [],
    };
    expect(() => PlanningArtifactSchema.parse({
      ...rejected,
      envelope: substitutedEnvelope,
      envelopeDigest: digestCanonical(substitutedEnvelope),
    })).toThrow(/exactly derived/i);

    const removedValidation = proposal();
    removedValidation.taskSpecifications[0]!.requiredValidationIds = [];
    removedValidation.validationIdentities = [];
    const corrected = buildPlanningArtifact(removedValidation, budget, 2);
    expect(() => assertCorrectionWithinBounds(corrected, rejected.envelope)).toThrow(/validation/i);
  });
});
