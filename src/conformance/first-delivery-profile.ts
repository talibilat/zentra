import { createHash } from "node:crypto";
import path from "node:path";

import type { AnalysisAdapterRequest } from "../analysis/analysis-contracts.js";
import { AnalysisExecutionError, type AnalysisAdapterResult } from "../analysis/capsule-analysis-adapter.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import type {
  FirstDeliveryConfiguration,
  FirstDeliveryPlannerRequest,
} from "../first-delivery/production-run-advancer.js";
import {
  APPROVED_VALIDATION_EXECUTABLE,
  createValidationIdentitySnapshot,
  ProjectConfigSchema,
} from "../projects/project-config.js";
import { resolveProjectRevision } from "../runs/project-revision.js";

const CANCELLATION_MARKER = "ZENTRA_CONFORMANCE_ACTIVE_ANALYSIS";

export async function createFirstDeliveryConformanceProfile(
  projectRoot: string,
): Promise<FirstDeliveryConfiguration> {
  const projectRevision = await resolveProjectRevision(projectRoot);
  const projectId = `project-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 24)}`;
  const project = ProjectConfigSchema.parse({
    projectId,
    repositoryPath: projectRoot,
    worktreeRoot: path.join(projectRoot, ".zentra", "conformance-worktrees"),
    validations: {
      focused: [APPROVED_VALIDATION_EXECUTABLE, "--test"],
      full: [APPROVED_VALIDATION_EXECUTABLE, "--test"],
    },
  });
  const security = {
    allowedRepositories: [projectRoot],
    allowedFileScopes: ["src/**"],
    forbiddenPaths: [".env", "secrets"],
    network: { default: "denied" as const, allowedDestinations: [] },
    secretHandling: ["No secrets or ambient credentials are available."],
    approvalRequiredOperations: ["external_effect"],
    releaseBoundary: "no_release_operations",
    stopAndAskConditions: ["uncertain_effect"],
  };
  const capabilities = [{
    capabilityId: "deterministic-worker",
    agentId: "deterministic-worker",
    role: "implementer" as const,
    harness: "deterministic" as const,
  }];

  return {
    analysis: new ConformanceAnalysisAdapter(),
    analysisBudget: {
      maxRounds: 4,
      maxObservations: 16,
      maxQuestions: 8,
      maxOptionsPerQuestion: 4,
      maxQuestionnaireOptions: 16,
      maxOutputBytes: 64 * 1024,
      maxDurationMs: 30_000,
      maxInputTokens: 2_000,
      maxOutputTokens: 1_000,
      maxCostUsdNano: 0,
    },
    project,
    security,
    capabilities,
    approvalExpiresAt: () => new Date(Date.now() + 10 * 60_000).toISOString(),
    planner: {
      plan: async (request: FirstDeliveryPlannerRequest) => ({
        runId: request.run.runId,
        projectId,
        projectRevision,
        securityDigest: digestCanonical(security),
        capabilityCatalogDigest: digestCanonical(capabilities),
        analysisEvidence: request.analysisEvidence,
        plan: {
          milestoneId: `milestone-${request.run.runId}`,
          projectId,
          goal: "Approve the bounded installed first-delivery plan.",
          tasks: [{
            taskId: "parser",
            title: "Implement parser",
            description: "Implement and verify the bounded parser change.",
            dependencies: [],
            ownedPaths: ["src/parser.ts"],
            forbiddenPaths: ["secrets"],
            acceptanceCriteria: ["The parser passes validation."],
            roleAssignment: {
              role: "implementer",
              agentId: "deterministic-worker",
              harness: "deterministic",
            },
            risk: {
              level: "medium",
              authority: "workspace_write",
              requiresReview: true,
              requiresApproval: true,
            },
            budget: {
              maxSeconds: 30,
              maxRetries: 0,
              maxCostUsd: 0,
              maxInputTokens: 200,
              maxOutputTokens: 100,
            },
          }],
        },
        taskSpecifications: [{
          taskId: "parser",
          capabilityId: "deterministic-worker",
          broadReadPaths: ["src"],
          potentialWritePaths: ["src/parser.ts"],
          evidenceRequirements: [{
            criterionIndex: 0,
            kind: "changed_paths",
            producerRole: "implementer",
            digestBound: true,
          }, {
            criterionIndex: 0,
            kind: "validation_report",
            producerRole: "validator",
            digestBound: true,
          }, {
            criterionIndex: 0,
            kind: "review_decision",
            producerRole: "reviewer",
            digestBound: true,
          }],
          requiredValidationIds: ["focused"],
        }],
        validationIdentities: [createValidationIdentitySnapshot(project, "focused")],
      }),
    },
  };
}

class ConformanceAnalysisAdapter {
  async analyze(request: AnalysisAdapterRequest, signal: AbortSignal): Promise<AnalysisAdapterResult> {
    if (request.sources.some((source) => source.quotedText.includes(CANCELLATION_MARKER))) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new AnalysisExecutionError(
        "cancelled",
        "completed",
        usage(request.round),
        "analysis cancelled by the bounded conformance operator",
      );
    }
    const uncertainty = request.round === 1 ? [{
      uncertaintyId: "parser-policy",
      question: "Preserve parser compatibility?",
      materiality: "material" as const,
      affectedScopes: ["scope:parser"],
      dependentScopes: ["scope:parser-tests"],
      options: [{
        optionId: "breaking",
        label: "Break compatibility",
        impacts: ["Requires migration authority."],
      }, {
        optionId: "compatible",
        label: "Preserve compatibility",
        impacts: ["No migration is required."],
      }],
      recommendation: {
        optionId: "compatible",
        rationale: "No migration authority was granted.",
      },
    }] : [];
    return {
      observations: [{
        observationId: `observation-${request.round}`,
        summary: "Bounded source analysis.",
        sourceIds: [request.sources[0]!.sourceId],
        repositoryPaths: [],
        affectedScopes: ["scope:parser"],
      }],
      uncertainties: uncertainty,
      usage: usage(request.round),
    };
  }
}

function usage(_round: number) {
  return {
    inputTokens: 10,
    outputTokens: 5,
    inputBytes: 100,
    outputBytes: 100,
    durationMs: 1,
    costUsdNano: 0,
    modelReceiptSha256: "a".repeat(64),
  };
}
