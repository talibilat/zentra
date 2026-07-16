import {
  MilestonePlanSchema,
  StopAndAskStateSchema,
  type MilestonePlan,
  type PlannedTask,
  type StopAndAskReason,
  type StopAndAskState,
} from "../contracts/milestone.js";
import type { SecuritySheet } from "../policy/security-sheet.js";

export type PlanReadinessStatus = "executable" | "blocked" | "requires_approval";

export interface PlanReadinessDecision {
  readonly status: PlanReadinessStatus;
  readonly reason: "ready" | StopAndAskReason;
  readonly stopAndAsk: StopAndAskState | null;
}

export interface PlanReadinessInput {
  readonly plan: unknown;
  readonly security: SecuritySheet;
}

export function assessMilestonePlanReadiness(
  input: PlanReadinessInput,
): PlanReadinessDecision {
  const parsed = MilestonePlanSchema.safeParse(input.plan);
  if (!parsed.success) {
    return blocked("plan_not_ready", "Milestone plan is not structurally ready.");
  }

  const scopeDecision = assessFileScope(parsed.data, input.security);
  if (scopeDecision !== null) return scopeDecision;

  const authorityDecision = assessAuthority(parsed.data, input.security);
  if (authorityDecision !== null) return authorityDecision;

  return Object.freeze({ status: "executable", reason: "ready", stopAndAsk: null });
}

function assessFileScope(
  plan: MilestonePlan,
  security: SecuritySheet,
): PlanReadinessDecision | null {
  for (const task of plan.tasks) {
    for (const ownedPath of task.ownedPaths) {
      if (!security.allowedFileScopes.some((scope) => pathMatchesScope(ownedPath, scope))) {
        return requiresApproval(
          "forbidden_file_scope",
          `Planned task ${task.taskId} owns ${ownedPath}, which is outside allowed file scope.`,
        );
      }
      if (security.forbiddenPaths.some((scope) => pathMatchesScope(ownedPath, scope))) {
        return requiresApproval(
          "forbidden_file_scope",
          `Planned task ${task.taskId} owns ${ownedPath}, which overlaps forbidden file scope.`,
        );
      }
    }
  }
  return null;
}

function assessAuthority(
  plan: MilestonePlan,
  security: SecuritySheet,
): PlanReadinessDecision | null {
  for (const task of plan.tasks) {
    if (
      task.risk.authority === "external_effect" &&
      security.network.allowedDestinations.length === 0
    ) {
      return requiresApproval(
        "undeclared_network",
        `Planned task ${task.taskId} requires external authority without declared network destinations.`,
      );
    }
    if (
      task.risk.authority === "local_release_preparation" &&
      security.releaseBoundary === "local_preparation_only"
    ) {
      return requiresApproval(
        "release_boundary",
        `Planned task ${task.taskId} reaches the release boundary and requires operator review before execution.`,
      );
    }
    if (task.risk.requiresApproval) {
      return requiresApproval(
        "missing_authority",
        `Planned task ${task.taskId} requires explicit operator approval before execution.`,
      );
    }
  }
  return null;
}

function blocked(reason: StopAndAskReason, message: string): PlanReadinessDecision {
  return Object.freeze({
    status: "blocked",
    reason,
    stopAndAsk: stopAndAsk(reason, message),
  });
}

function requiresApproval(reason: StopAndAskReason, message: string): PlanReadinessDecision {
  return Object.freeze({
    status: "requires_approval",
    reason,
    stopAndAsk: stopAndAsk(reason, message),
  });
}

function stopAndAsk(reason: StopAndAskReason, message: string): StopAndAskState {
  return StopAndAskStateSchema.parse({
    reason,
    message,
    requestedBy: "zentra-readiness-gate",
    requiredDecision: "Revise the plan or approve the bounded operation before any worker starts.",
  });
}

function pathMatchesScope(candidate: string, scope: string): boolean {
  if (scope.endsWith("/**")) {
    const prefix = scope.slice(0, -3);
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  }
  return candidate === scope;
}

export function assertMilestonePlanReady(input: PlanReadinessInput): MilestonePlan {
  const parsed = MilestonePlanSchema.safeParse(input.plan);
  if (!parsed.success) throw new Error("Milestone plan is not structurally ready");
  const decision = assessMilestonePlanReadiness(input);
  if (decision.status !== "executable") {
    throw new Error(`Milestone plan is not executable: ${decision.reason}`);
  }
  return parsed.data;
}

export function plannedTaskRequiresReview(task: PlannedTask): boolean {
  return task.risk.requiresReview;
}
