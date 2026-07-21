import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import { TerminalOutcomeSchema, type TerminalOutcome } from "../contracts/task.js";

const Id = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const Count = z.number().int().nonnegative().max(1_000_000_000);
const NonemptyList = z.array(z.string().min(1).max(2_048)).min(1).max(256);

export const SchedulerResourceSchema = z.strictObject({
  reasoning: Count,
  writers: Count,
  heavyValidation: Count,
  review: Count,
  integration: Count.max(1),
});
export const SchedulerBudgetSchema = z.strictObject({
  seconds: Count,
  inputTokens: Count,
  outputTokens: Count,
  costUsdNano: Count,
});
const DependencySchema = z.strictObject({
  taskId: Id,
  state: z.enum(["completed", "contract_stable", "blocked"]),
});
const WorkspaceSchema = z.strictObject({
  path: z.string().min(1).max(4_096).startsWith("/"),
  available: z.boolean(),
});
export const SchedulerAdmissionSchema = z.strictObject({
  dependencies: z.array(DependencySchema).max(1_000),
  decisionsApproved: z.boolean(),
  pathsAvailable: z.boolean(),
  capabilitySupported: z.boolean(),
  platformSupported: z.boolean(),
  policyPermits: z.boolean(),
  budgetAvailable: z.boolean(),
  workspaceValid: z.boolean(),
  acceptanceCriteria: z.array(z.string().min(1).max(2_048)).max(256),
  evidenceRequirements: z.array(z.string().min(1).max(2_048)).max(256),
});
export const SchedulerControlIdentitySchema = z.strictObject({
  controlPlaneId: Id,
  repositoryIdentity: z.string().min(1).max(4_096).refine((value) =>
    path.isAbsolute(value) && path.normalize(value) === value, "repository identity must be canonical absolute"),
});
export const SchedulerTaskSchema = z.strictObject({
  taskId: Id,
  projectId: Id,
  workerId: Id,
  effect: z.enum(["computation", "potentially_effectful"]),
  requiredCapabilities: NonemptyList,
  platform: z.literal("darwin-arm64"),
  workspace: WorkspaceSchema,
  admission: SchedulerAdmissionSchema,
  resources: SchedulerResourceSchema,
  budget: SchedulerBudgetSchema,
  grantId: Id,
}).superRefine((task, context) => {
  if (Object.values(task.resources).every((value) => value === 0)) {
    context.addIssue({ code: "custom", message: "scheduled task must reserve at least one global resource" });
  }
  if (task.budget.seconds <= 0) {
    context.addIssue({ code: "custom", message: "scheduled task seconds budget must be positive" });
  }
});
export const SchedulerLimitsSchema = z.strictObject({
  resources: SchedulerResourceSchema,
  budget: SchedulerBudgetSchema,
});

export type SchedulerResources = z.infer<typeof SchedulerResourceSchema>;
export type SchedulerBudget = z.infer<typeof SchedulerBudgetSchema>;
export type SchedulerLimits = z.infer<typeof SchedulerLimitsSchema>;
export type SchedulerTaskInput = z.infer<typeof SchedulerTaskSchema>;
export type SchedulerControlIdentity = z.infer<typeof SchedulerControlIdentitySchema>;
export type SchedulerTerminalOutcome = TerminalOutcome;

export const BlockedReasonSchema = z.enum([
  "dependencies", "decisions", "paths", "capability", "platform", "policy", "budget",
  "workspace", "acceptance", "evidence", "grant", "uncertain_effect",
]);
export type BlockedReason = z.infer<typeof BlockedReasonSchema>;

export interface DispatchIntent {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly workerId: string;
  readonly processIncarnation: string;
  readonly taskLeaseId: string;
  readonly workerLeaseId: string;
  readonly grantId: string;
  readonly intentSha256: string;
  readonly effect: "computation" | "potentially_effectful";
  readonly workspace: SchedulerTaskInput["workspace"];
  readonly resources: SchedulerResources;
  readonly budget: SchedulerBudget;
  readonly intendedAtMs: number;
  readonly deadlineAtMs: number;
}

export const SchedulerOutcomeSchema = TerminalOutcomeSchema;

export function schedulerStreamId(schedulerId: string): string {
  return `scheduler:${Id.parse(schedulerId)}`;
}

export function dispatchIntentSha256(input: SchedulerTaskInput): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

export function schedulerControlStreamId(identity: SchedulerControlIdentity): string {
  const parsed = SchedulerControlIdentitySchema.parse(identity);
  const digest = createHash("sha256").update(canonicalJson(parsed), "utf8").digest("hex");
  return `scheduler-control:${digest}`;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("canonical value is not JSON serializable");
  return encoded;
}
