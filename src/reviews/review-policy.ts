import {
  StopAndAskStateSchema,
  type PlannedTask,
  type StopAndAskState,
} from "../contracts/milestone.js";
import type { SecuritySheet } from "../policy/security-sheet.js";

export type ReviewPolicyReason =
  | "review_required"
  | "missing_review_policy"
  | "self_review"
  | "forbidden_file_scope";

export interface ReviewPolicyInput {
  readonly task: PlannedTask;
  readonly security: SecuritySheet;
  readonly workerId: string;
  readonly reviewerIds: readonly string[];
  readonly reviewerRoles?: Readonly<Record<string, readonly string[]>>;
}

export interface ReviewPolicyDecision {
  readonly status: "ready_for_review" | "paused";
  readonly reason: ReviewPolicyReason;
  readonly minimumReviewers: number;
  readonly requiredReviewerRoles: readonly string[];
  readonly stopAndAsk: StopAndAskState | null;
}

export function assessReviewPolicy(input: ReviewPolicyInput): ReviewPolicyDecision {
  const heightenedReview = requiresHeightenedReview(input.task);
  const minimumReviewers = heightenedReview ? 2 : 1;
  const requiredReviewerRoles = heightenedReview
    ? Object.freeze(["reviewer", "security_reviewer"])
    : Object.freeze(["reviewer"]);
  const outsideAllowedScope = input.task.ownedPaths.find((ownedPath) =>
    !input.security.allowedFileScopes.some((allowedPath) => pathMatchesScope(ownedPath, allowedPath))
  );
  if (outsideAllowedScope !== undefined) {
    return paused(
      "forbidden_file_scope",
      minimumReviewers,
      requiredReviewerRoles,
      `Planned task ${input.task.taskId} touches ${outsideAllowedScope}, which is outside allowed file scope.`,
      "forbidden_file_scope",
    );
  }

  const forbiddenScope = input.task.ownedPaths.find((ownedPath) =>
    input.security.forbiddenPaths.some((forbiddenPath) => pathsOverlap(ownedPath, forbiddenPath))
  );
  if (forbiddenScope !== undefined) {
    return paused(
      "forbidden_file_scope",
      minimumReviewers,
      requiredReviewerRoles,
      `Planned task ${input.task.taskId} touches forbidden review scope ${forbiddenScope}.`,
      "forbidden_file_scope",
    );
  }

  const uniqueReviewerIds = [...new Set(input.reviewerIds)];
  if (uniqueReviewerIds.length < minimumReviewers) {
    return paused(
      "missing_review_policy",
      minimumReviewers,
      requiredReviewerRoles,
      `Planned task ${input.task.taskId} requires ${minimumReviewers} independent reviewer(s).`,
      "missing_authority",
    );
  }
  if (uniqueReviewerIds.includes(input.workerId)) {
    return paused(
      "self_review",
      minimumReviewers,
      requiredReviewerRoles,
      `Planned task ${input.task.taskId} cannot be reviewed by its worker.`,
      "missing_authority",
    );
  }
  if (!reviewerRolesSatisfy(uniqueReviewerIds, input.reviewerRoles ?? {}, requiredReviewerRoles)) {
    return paused(
      "missing_review_policy",
      minimumReviewers,
      requiredReviewerRoles,
      `Planned task ${input.task.taskId} is missing required reviewer role evidence.`,
      "missing_authority",
    );
  }

  return Object.freeze({
    status: "ready_for_review",
    reason: "review_required",
    minimumReviewers,
    requiredReviewerRoles,
    stopAndAsk: null,
  });
}

function reviewerRolesSatisfy(
  reviewerIds: readonly string[],
  reviewerRoles: Readonly<Record<string, readonly string[]>>,
  requiredRoles: readonly string[],
): boolean {
  if (requiredRoles.length === 1 && requiredRoles[0] === "reviewer") return true;
  const assigned = new Set<string>();
  for (const reviewerId of reviewerIds) {
    for (const role of reviewerRoles[reviewerId] ?? []) assigned.add(role);
  }
  return requiredRoles.every((role) => assigned.has(role));
}

function requiresHeightenedReview(task: PlannedTask): boolean {
  return (
    task.risk.level === "high" ||
    task.risk.level === "critical" ||
    task.risk.requiresApproval ||
    task.risk.authority === "integration" ||
    task.risk.authority === "local_release_preparation" ||
    task.risk.authority === "external_effect" ||
    task.roleAssignment.role === "integrator" ||
    task.roleAssignment.role === "verifier"
  );
}

function paused(
  reason: Exclude<ReviewPolicyReason, "review_required">,
  minimumReviewers: number,
  requiredReviewerRoles: readonly string[],
  message: string,
  stopReason: "missing_authority" | "forbidden_file_scope",
): ReviewPolicyDecision {
  return Object.freeze({
    status: "paused",
    reason,
    minimumReviewers,
    requiredReviewerRoles: Object.freeze([...requiredReviewerRoles]),
    stopAndAsk: StopAndAskStateSchema.parse({
      reason: stopReason,
      message,
      requestedBy: "zentra-review-policy",
      requiredDecision: "Assign an independent reviewer or revise the plan before integration.",
    }),
  });
}

function pathMatchesScope(candidate: string, scope: string): boolean {
  if (scope.endsWith("/**")) {
    const prefix = scope.slice(0, -3);
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  }
  return candidate === scope;
}

function pathsOverlap(first: string, second: string): boolean {
  const firstBase = scopeBase(first);
  const secondBase = scopeBase(second);
  return firstBase === secondBase || firstBase.startsWith(`${secondBase}/`) || secondBase.startsWith(`${firstBase}/`);
}

function scopeBase(scope: string): string {
  return scope.endsWith("/**") ? scope.slice(0, -3) : scope;
}
