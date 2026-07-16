import { z } from "zod";

import { TerminalOutcomeSchema } from "./task.js";

const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 4_096;
const MAX_PATH_LENGTH = 4_096;

const IdentitySchema = z.string().min(1).max(MAX_ID_LENGTH);
const BoundedTextSchema = z.string().min(1).max(MAX_TEXT_LENGTH);
const SafeLogicalPathSchema = z.string().min(1).max(MAX_PATH_LENGTH).refine(isSafeLogicalPath, {
  message: "path must be a safe logical relative path",
});

export const MilestoneLifecycleStateSchema = z.enum([
  "planning",
  "ready",
  "running",
  "paused",
  "terminal",
]);

export const MilestoneRoleSchema = z.enum([
  "planner",
  "researcher",
  "implementer",
  "validator",
  "reviewer",
  "integrator",
  "verifier",
]);

export const HarnessSchema = z.enum([
  "opencode",
  "claude_code",
  "codex",
  "deterministic",
]);

export const RoleAssignmentSchema = z.strictObject({
  role: MilestoneRoleSchema,
  agentId: IdentitySchema,
  harness: HarnessSchema,
});

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const AuthorityLevelSchema = z.enum([
  "read_only",
  "workspace_write",
  "validation",
  "review",
  "integration",
  "local_release_preparation",
  "external_effect",
]);

export const RiskClassificationSchema = z.strictObject({
  level: RiskLevelSchema,
  authority: AuthorityLevelSchema,
  requiresReview: z.boolean(),
  requiresApproval: z.boolean(),
}).superRefine((risk, context) => {
  if (risk.authority === "external_effect" && !risk.requiresApproval) {
    context.addIssue({
      code: "custom",
      message: "external effects require approval",
    });
  }
  if (risk.level === "critical" && (!risk.requiresApproval || !risk.requiresReview)) {
    context.addIssue({
      code: "custom",
      message: "critical risk requires approval and review",
    });
  }
});

export const MilestoneBudgetSchema = z.strictObject({
  maxSeconds: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  maxCostUsd: z.number().nonnegative(),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
});

export const StopAndAskReasonSchema = z.enum([
  "missing_authority",
  "forbidden_file_scope",
  "undeclared_network",
  "release_boundary",
  "budget_exceeded",
  "uncertain_effect",
  "plan_not_ready",
]);

export const StopAndAskStateSchema = z.strictObject({
  reason: StopAndAskReasonSchema,
  message: BoundedTextSchema,
  requestedBy: IdentitySchema,
  requiredDecision: BoundedTextSchema,
});

export const TaskDependencySchema = IdentitySchema;

export const PlannedTaskSchema = z.strictObject({
  taskId: IdentitySchema,
  title: BoundedTextSchema,
  description: BoundedTextSchema,
  dependencies: z.array(TaskDependencySchema).max(128),
  ownedPaths: z.array(SafeLogicalPathSchema).min(1).max(256),
  forbiddenPaths: z.array(SafeLogicalPathSchema).max(256),
  acceptanceCriteria: z.array(BoundedTextSchema).min(1).max(128),
  roleAssignment: RoleAssignmentSchema,
  risk: RiskClassificationSchema,
  budget: MilestoneBudgetSchema,
}).superRefine((task, context) => {
  const scopeProblem = contradictoryPathScope(task.ownedPaths, task.forbiddenPaths);
  if (scopeProblem !== null) {
    context.addIssue({ code: "custom", message: scopeProblem });
  }
});

export const MilestonePlanSchema = z.strictObject({
  milestoneId: IdentitySchema,
  projectId: IdentitySchema,
  goal: BoundedTextSchema,
  tasks: z.array(PlannedTaskSchema).min(1).max(512),
}).superRefine((plan, context) => {
  const problem = dependencyProblem(plan.tasks);
  if (problem !== null) {
    context.addIssue({ code: "custom", message: problem });
  }
});

export const MilestoneSchema = z.strictObject({
  milestoneId: IdentitySchema,
  projectId: IdentitySchema,
  title: BoundedTextSchema,
  lifecycle: MilestoneLifecycleStateSchema,
  terminalOutcome: TerminalOutcomeSchema.nullable(),
  plan: MilestonePlanSchema.nullable(),
  stopAndAsk: StopAndAskStateSchema.nullable(),
}).superRefine((milestone, context) => {
  if ((milestone.lifecycle === "terminal") !== (milestone.terminalOutcome !== null)) {
    context.addIssue({
      code: "custom",
      message: "terminal lifecycle and terminalOutcome must be set together",
    });
  }
  if (milestone.lifecycle !== "paused" && milestone.stopAndAsk !== null) {
    context.addIssue({
      code: "custom",
      message: "stopAndAsk is only valid while a milestone is paused",
    });
  }
  if ((milestone.lifecycle === "ready" || milestone.lifecycle === "running") && milestone.plan === null) {
    context.addIssue({
      code: "custom",
      message: "ready and running milestones require a plan",
    });
  }
  if (milestone.plan !== null) {
    if (milestone.plan.milestoneId !== milestone.milestoneId) {
      context.addIssue({
        code: "custom",
        message: "milestone plan identity must match milestone identity",
      });
    }
    if (milestone.plan.projectId !== milestone.projectId) {
      context.addIssue({
        code: "custom",
        message: "milestone plan project must match milestone project",
      });
    }
  }
});

export type MilestoneLifecycleState = z.infer<typeof MilestoneLifecycleStateSchema>;
export type MilestoneRole = z.infer<typeof MilestoneRoleSchema>;
export type Harness = z.infer<typeof HarnessSchema>;
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type AuthorityLevel = z.infer<typeof AuthorityLevelSchema>;
export type RiskClassification = z.infer<typeof RiskClassificationSchema>;
export type MilestoneBudget = z.infer<typeof MilestoneBudgetSchema>;
export type StopAndAskReason = z.infer<typeof StopAndAskReasonSchema>;
export type StopAndAskState = z.infer<typeof StopAndAskStateSchema>;
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;
export type MilestonePlan = z.infer<typeof MilestonePlanSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;

export function assertAcyclicMilestonePlan<TPlan extends MilestonePlan>(plan: TPlan): TPlan {
  const problem = dependencyProblem(plan.tasks);
  if (problem !== null) throw new Error(problem);
  return plan;
}

function dependencyProblem(tasks: readonly PlannedTask[]): string | null {
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.taskId)) return `duplicate planned task: ${task.taskId}`;
    taskIds.add(task.taskId);
  }

  for (const task of tasks) {
    const dependencies = new Set<string>();
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) {
        return `planned task ${task.taskId} depends on unknown task ${dependency}`;
      }
      if (dependencies.has(dependency)) {
        return `planned task ${task.taskId} lists duplicate dependency ${dependency}`;
      }
      dependencies.add(dependency);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.taskId, task] as const));

  const visit = (taskId: string): string | null => {
    if (visited.has(taskId)) return null;
    if (visiting.has(taskId)) return `milestone plan contains a dependency cycle involving ${taskId}`;
    visiting.add(taskId);
    const task = byId.get(taskId)!;
    for (const dependency of task.dependencies) {
      const problem = visit(dependency);
      if (problem !== null) return problem;
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return null;
  };

  for (const task of tasks) {
    const problem = visit(task.taskId);
    if (problem !== null) return problem;
  }
  return null;
}

function contradictoryPathScope(
  ownedPaths: readonly string[],
  forbiddenPaths: readonly string[],
): string | null {
  for (const ownedPath of ownedPaths) {
    for (const forbiddenPath of forbiddenPaths) {
      if (pathsOverlap(ownedPath, forbiddenPath)) {
        return `owned path ${ownedPath} overlaps forbidden path ${forbiddenPath}`;
      }
    }
  }
  return null;
}

function pathsOverlap(first: string, second: string): boolean {
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}

function isSafeLogicalPath(candidate: string): boolean {
  if (
    candidate.includes("\0") ||
    candidate.includes("\n") ||
    candidate.includes("\r") ||
    candidate.includes("\\")
  ) return false;
  const segments = candidate.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
