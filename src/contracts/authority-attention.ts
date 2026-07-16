import { createHash } from "node:crypto";

import { z } from "zod";

import {
  AuthorityLevelSchema,
  HarnessSchema,
  MilestonePlanSchema,
  MilestoneRoleSchema,
  StopAndAskReasonSchema,
  type MilestonePlan,
} from "./milestone.js";
import type { SecuritySheet } from "../policy/security-sheet.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentitySchema = z.string().min(1).max(256);
const RepositorySchema = z.string().min(1).max(4_096);
const CanonicalRolesSchema = z.array(MilestoneRoleSchema).min(1).max(16).superRefine(assertCanonicalSet);
const CanonicalToolsSchema = z.array(z.string().min(1).max(128)).max(64).superRefine(assertCanonicalSet);

export const AdmissionRequestedBudgetSchema = z.strictObject({
  maxSeconds: z.number().int().positive().max(86_400),
  maxCostUsd: z.number().nonnegative().max(10_000),
  maxInputTokens: z.number().int().positive().max(2_000_000),
  maxOutputTokens: z.number().int().positive().max(2_000_000),
  timeoutMs: z.number().int().positive().max(86_400_000),
});

export const OpenCodeTaskAdmissionContextSchema = z.strictObject({
  kind: z.literal("opencode"),
  repositoryPath: RepositorySchema,
  actorId: IdentitySchema,
  harness: HarnessSchema,
  role: MilestoneRoleSchema,
  capabilityId: IdentitySchema,
  transportModelId: IdentitySchema,
  authority: AuthorityLevelSchema,
  roles: z.array(MilestoneRoleSchema).min(1).max(16),
  toolPermissions: z.array(z.string().min(1).max(128)).max(64),
  network: z.enum(["denied", "declared"]),
  contextTokens: z.number().int().positive().max(2_000_000),
  requestedBudget: AdmissionRequestedBudgetSchema,
});

export const OpenCodeAdmissionPacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  milestoneId: IdentitySchema,
  taskId: IdentitySchema,
  planDigest: DigestSchema,
  securityDigest: DigestSchema,
  repository: RepositorySchema,
  actorId: IdentitySchema,
  harness: HarnessSchema,
  role: MilestoneRoleSchema,
  capabilityId: IdentitySchema,
  transportModelId: IdentitySchema,
  authority: AuthorityLevelSchema,
  roles: CanonicalRolesSchema,
  toolPermissions: CanonicalToolsSchema,
  network: z.enum(["denied", "declared"]),
  contextTokens: z.number().int().positive().max(2_000_000),
  requestedBudget: AdmissionRequestedBudgetSchema,
});

export const TaskReadyPayloadSchema = z.strictObject({
  taskId: IdentitySchema,
  admissionDigest: DigestSchema,
});

export type AdmissionRequestedBudget = z.infer<typeof AdmissionRequestedBudgetSchema>;
export type OpenCodeAdmissionPacket = z.infer<typeof OpenCodeAdmissionPacketSchema>;
export type OpenCodeTaskAdmissionContext = z.infer<typeof OpenCodeTaskAdmissionContextSchema>;

export const AuthorityAttentionClassificationSchema = z.enum([
  "hard_stop",
  "exact_approval_required",
]);

export const AuthorityAttentionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  attentionId: DigestSchema,
  milestoneId: IdentitySchema,
  taskId: IdentitySchema,
  planDigest: DigestSchema,
  policyDigest: DigestSchema,
  admissionDigest: DigestSchema,
  configuredStopCondition: z.boolean(),
  reason: StopAndAskReasonSchema,
  classification: AuthorityAttentionClassificationSchema,
  requestedBy: z.literal("zentra-authority-gate"),
  message: z.enum([
    "The task requests file scope that policy forbids.",
    "The task requests a network operation whose exact destination is not declared by the plan.",
    "The task requires exact authority that has not been durably granted.",
    "The task crosses the configured release boundary.",
    "The task exceeds its approved execution budget.",
    "The task plan or configured capability contradicts the requested execution.",
  ]),
  requiredDecision: z.enum([
    "Replace the plan before any task starts, or create a new milestone after execution; remain within allowed file scope.",
    "Replace the plan before any task starts, or create a new milestone after execution; express an exact authorized network operation.",
    "Provide a future exact operation-bound approval or revise the plan.",
    "Replace the plan before any task starts, or create a new milestone after execution; remain within the configured release boundary.",
    "Replace the plan before any task starts, or create a new milestone after execution; reduce the requested budget.",
    "Replace the plan or capability before any task starts, or create a new milestone after execution; approval cannot authorize a contradiction.",
  ]),
}).superRefine((attention, context) => {
  const expectedClassification = attention.reason === "missing_authority"
    ? "exact_approval_required"
    : "hard_stop";
  if (attention.classification !== expectedClassification) {
    context.addIssue({ code: "custom", message: "authority attention classification is invalid" });
  }
  const fixed = publicAuthorityAttentionText(attention.reason, attention.classification);
  if (attention.message !== fixed.message || attention.requiredDecision !== fixed.requiredDecision) {
    context.addIssue({ code: "custom", message: "authority attention public text is not canonical" });
  }
  const expectedId = authorityAttentionId({
    milestoneId: attention.milestoneId,
    taskId: attention.taskId,
    planDigest: attention.planDigest,
    policyDigest: attention.policyDigest,
    admissionDigest: attention.admissionDigest,
    configuredStopCondition: attention.configuredStopCondition,
    reason: attention.reason,
    classification: attention.classification,
  });
  if (attention.attentionId !== expectedId) {
    context.addIssue({ code: "custom", message: "authority attention identity is invalid" });
  }
});

export const MilestonePausedPayloadSchema = z.strictObject({
  attention: AuthorityAttentionSchema,
});

export const PlanReplacementPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  milestoneId: IdentitySchema,
  projectId: IdentitySchema,
  attentionId: DigestSchema,
  priorPlanDigest: DigestSchema,
  priorSecurityDigest: DigestSchema,
  replacementPlan: MilestonePlanSchema,
});

export type AuthorityAttention = z.infer<typeof AuthorityAttentionSchema>;
export type AuthorityAttentionClassification = z.infer<typeof AuthorityAttentionClassificationSchema>;
export type MilestonePausedPayload = z.infer<typeof MilestonePausedPayloadSchema>;
export type PlanReplacementPayload = z.infer<typeof PlanReplacementPayloadSchema>;

export function createAuthorityAttention(input: {
  readonly packet: OpenCodeAdmissionPacket;
  readonly reason: AuthorityAttention["reason"];
  readonly classification: AuthorityAttentionClassification;
  readonly configuredStopCondition: boolean;
}): AuthorityAttention {
  const identity = {
    milestoneId: input.packet.milestoneId,
    taskId: input.packet.taskId,
    planDigest: input.packet.planDigest,
    policyDigest: input.packet.securityDigest,
    admissionDigest: admissionPacketDigest(input.packet),
    configuredStopCondition: input.configuredStopCondition,
    reason: input.reason,
    classification: input.classification,
  };
  return AuthorityAttentionSchema.parse({
    schemaVersion: 1,
    attentionId: authorityAttentionId(identity),
    ...identity,
    requestedBy: "zentra-authority-gate",
    ...publicAuthorityAttentionText(input.reason, input.classification),
  });
}

export function authorityAttentionId(input: {
  readonly milestoneId: string;
  readonly taskId: string;
  readonly planDigest: string;
  readonly policyDigest: string;
  readonly admissionDigest: string;
  readonly configuredStopCondition: boolean;
  readonly reason: string;
  readonly classification: string;
}): string {
  return digestCanonical(input);
}

export function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function createOpenCodeAdmissionPacket(input: {
  readonly plan: MilestonePlan | null;
  readonly milestoneId: string;
  readonly taskId: string;
  readonly security: SecuritySheet;
  readonly canonicalRepository: string;
  readonly actorId: string;
  readonly harness: z.infer<typeof HarnessSchema>;
  readonly role: z.infer<typeof MilestoneRoleSchema>;
  readonly capabilityId: string;
  readonly transportModelId: string;
  readonly authority: z.infer<typeof AuthorityLevelSchema>;
  readonly roles: readonly z.infer<typeof MilestoneRoleSchema>[];
  readonly toolPermissions: readonly string[];
  readonly network: "denied" | "declared";
  readonly contextTokens: number;
  readonly requestedBudget: AdmissionRequestedBudget;
}): OpenCodeAdmissionPacket {
  const task = input.plan?.tasks.find((candidate) => candidate.taskId === input.taskId);
  if (input.plan !== null && task === undefined) throw new Error(`unknown planned task: ${input.taskId}`);
  if (input.plan !== null && input.plan.milestoneId !== input.milestoneId) {
    throw new Error("admission milestone contradicts the plan");
  }
  return OpenCodeAdmissionPacketSchema.parse({
    schemaVersion: 1,
    milestoneId: input.milestoneId,
    taskId: input.taskId,
    planDigest: digestCanonical(input.plan),
    securityDigest: digestCanonical(input.security),
    repository: input.canonicalRepository,
    actorId: input.actorId,
    harness: input.harness,
    role: input.role,
    capabilityId: input.capabilityId,
    transportModelId: input.transportModelId,
    authority: input.authority,
    roles: canonicalSet(input.roles),
    toolPermissions: canonicalSet(input.toolPermissions),
    network: input.network,
    contextTokens: input.contextTokens,
    requestedBudget: input.requestedBudget,
  });
}

export function admissionPacketDigest(packet: OpenCodeAdmissionPacket): string {
  return digestCanonical(OpenCodeAdmissionPacketSchema.parse(packet));
}

function publicAuthorityAttentionText(
  reason: AuthorityAttention["reason"],
  classification: AuthorityAttentionClassification,
): { readonly message: AuthorityAttention["message"]; readonly requiredDecision: AuthorityAttention["requiredDecision"] } {
  if (reason === "forbidden_file_scope") return {
    message: "The task requests file scope that policy forbids.",
    requiredDecision: "Replace the plan before any task starts, or create a new milestone after execution; remain within allowed file scope.",
  };
  if (reason === "undeclared_network") return {
    message: "The task requests a network operation whose exact destination is not declared by the plan.",
    requiredDecision: "Replace the plan before any task starts, or create a new milestone after execution; express an exact authorized network operation.",
  };
  if (reason === "release_boundary") return {
    message: "The task crosses the configured release boundary.",
    requiredDecision: "Replace the plan before any task starts, or create a new milestone after execution; remain within the configured release boundary.",
  };
  if (reason === "budget_exceeded") return {
    message: "The task exceeds its approved execution budget.",
    requiredDecision: "Replace the plan before any task starts, or create a new milestone after execution; reduce the requested budget.",
  };
  if (reason === "missing_authority" && classification === "exact_approval_required") return {
    message: "The task requires exact authority that has not been durably granted.",
    requiredDecision: "Provide a future exact operation-bound approval or revise the plan.",
  };
  return {
    message: "The task plan or configured capability contradicts the requested execution.",
    requiredDecision: "Replace the plan or capability before any task starts, or create a new milestone after execution; approval cannot authorize a contradiction.",
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function canonicalSet<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function assertCanonicalSet(values: readonly string[], context: z.RefinementCtx): void {
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    context.addIssue({ code: "custom", message: "set values must be unique and canonically sorted" });
  }
}
