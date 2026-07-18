import { createHash } from "node:crypto";

import { z } from "zod";

import { digestCanonical } from "./authority-attention.js";
import {
  AuthorityLevelSchema,
  HarnessSchema,
  MilestoneBudgetSchema,
  MilestonePlanSchema,
  MilestoneRoleSchema,
  StopAndAskReasonSchema,
  type MilestonePlan,
  type PlannedTask,
} from "./milestone.js";
import type { ModelSheet } from "../policy/model-sheet.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import { modelSheetSha256 } from "../routing/model-router.js";

const IdentitySchema = z.string().min(1).max(256);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SafePathSchema = z.string().min(1).max(4_096);
const CanonicalPathSetSchema = z.array(SafePathSchema).max(512).superRefine(assertCanonicalSet);
const CanonicalIdentitySetSchema = z.array(IdentitySchema).max(256).superRefine(assertCanonicalSet);
const ApprovalOperationSchema = z.enum([
  "external_effect", "publish_release", "push_branch", "create_pull_request", "create_tag",
  "access_secret", "network_access", "modify_protected_path",
]);

export const ReplanningRoleBoundarySchema = z.strictObject({
  role: MilestoneRoleSchema,
  harness: HarnessSchema,
});

export const ReplanningCapabilitySchema = z.strictObject({
  capabilityId: IdentitySchema,
  harness: HarnessSchema,
  roles: z.array(MilestoneRoleSchema).min(1).max(16).superRefine(assertCanonicalSet),
  toolPermissions: z.array(IdentitySchema).max(64).superRefine(assertCanonicalSet),
  network: z.enum(["denied", "declared"]),
  contextTokens: z.number().int().positive().safe(),
  transportModelDigest: DigestSchema,
});

export const ReplanningModelCapabilitySnapshotSchema = z.strictObject({
  id: IdentitySchema,
  harness: z.enum(["opencode", "claude_code", "codex"]),
  model: z.string().min(1).max(4_096),
  roles: z.array(MilestoneRoleSchema).max(16).superRefine(assertUniqueSet),
  specialties: z.array(IdentitySchema).max(256).superRefine(assertUniqueSet),
  costTier: z.enum(["low", "medium", "high", "premium"]),
  contextTokens: z.number().int().positive().safe(),
  maxConcurrency: z.number().int().positive().safe(),
  toolPermissions: z.array(IdentitySchema).max(256).superRefine(assertUniqueSet),
  network: z.enum(["denied", "declared"]),
  fallbackOrder: z.array(IdentitySchema).max(256).superRefine(assertUniqueSet),
  qualityHistory: z.strictObject({ successes: z.number().int().nonnegative().safe(), attempts: z.number().int().positive().safe() }),
});

export const ReplanningModelSheetSnapshotSchema = z.strictObject({
  models: z.array(ReplanningModelCapabilitySnapshotSchema).max(128).superRefine((models, context) => {
    assertUniqueSet(models.map((model) => model.id), context);
  }),
});

export const PublicReplanningSecuritySnapshotSchema = z.strictObject({
  allowedRepositoriesDigest: DigestSchema,
  allowedRepositoryCount: z.number().int().nonnegative().max(1_024),
  allowedFileScopesDigest: DigestSchema,
  allowedFileScopeCount: z.number().int().nonnegative().max(1_024),
  forbiddenPathsDigest: DigestSchema,
  forbiddenPathCount: z.number().int().nonnegative().max(1_024),
  network: z.strictObject({
    default: z.literal("denied"),
    allowedDestinationsDigest: DigestSchema,
    allowedDestinationCount: z.number().int().nonnegative().max(1_024),
  }),
  secretHandlingDigest: DigestSchema,
  secretHandlingRuleCount: z.number().int().nonnegative().max(1_024),
  approvalRequiredOperations: z.array(ApprovalOperationSchema).max(16).superRefine(assertCanonicalSet),
  releaseBoundary: z.enum(["local_preparation_only", "approval_required_for_remote", "no_release_operations"]),
  stopAndAskConditions: z.array(StopAndAskReasonSchema).max(16).superRefine(assertCanonicalSet),
});

export const ReplanningPolicyBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  milestoneId: IdentitySchema,
  projectId: IdentitySchema,
  security: PublicReplanningSecuritySnapshotSchema,
  securityDigest: DigestSchema,
  networkDigest: DigestSchema,
  modelSheet: ReplanningModelSheetSnapshotSchema.nullable(),
  modelSheetDigest: DigestSchema.nullable(),
}).superRefine((binding, context) => {
  if (binding.securityDigest !== digestCanonical(binding.security) ||
    binding.networkDigest !== digestCanonical(binding.security.network)) {
    context.addIssue({ code: "custom", message: "replanning security snapshot digest is invalid" });
  }
  if ((binding.modelSheet === null) !== (binding.modelSheetDigest === null) ||
    (binding.modelSheet !== null && binding.modelSheetDigest !== modelSheetSha256(binding.modelSheet))) {
    context.addIssue({ code: "custom", message: "replanning model snapshot digest is invalid" });
  }
});

export const ReplanningPolicyBoundPayloadSchema = z.strictObject({ policy: ReplanningPolicyBindingSchema });

export const MilestoneAuthorityEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  milestoneId: IdentitySchema,
  projectId: IdentitySchema,
  baselinePlanDigest: DigestSchema,
  goalDigest: DigestSchema,
  aggregateOwnedPaths: CanonicalPathSetSchema,
  forbiddenPaths: CanonicalPathSetSchema,
  authorityCategories: z.array(AuthorityLevelSchema).min(1).max(16).superRefine(assertCanonicalSet),
  roleBoundaries: z.array(ReplanningRoleBoundarySchema).min(1).max(64).superRefine((values, context) => {
    const keys = values.map((value) => `${value.role}:${value.harness}`);
    assertCanonicalSet(keys, context);
  }),
  aggregateBudgetCeiling: MilestoneBudgetSchema,
  securityDigest: DigestSchema,
  networkDigest: DigestSchema,
  releaseBoundary: IdentitySchema,
  modelSheetDigest: DigestSchema.nullable(),
  capabilities: z.array(ReplanningCapabilitySchema).max(128).superRefine((values, context) => {
    assertCanonicalSet(values.map((value) => value.capabilityId), context);
  }),
}).superRefine((envelope, context) => {
  if ((envelope.modelSheetDigest === null) !== (envelope.capabilities.length === 0)) {
    context.addIssue({ code: "custom", message: "model sheet identity and capabilities must be present together" });
  }
});

export const MilestoneAuthorityEnvelopePayloadSchema = z.strictObject({
  envelope: MilestoneAuthorityEnvelopeSchema,
});

export const RevisionEvidenceReferenceSchema = z.strictObject({
  eventId: IdentitySchema,
  streamId: IdentitySchema,
  streamVersion: z.number().int().positive(),
  eventType: IdentitySchema,
  payloadDigest: DigestSchema,
});

export const PlanRevisionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revisionId: IdentitySchema,
  revisionNumber: z.number().int().positive(),
  milestoneId: IdentitySchema,
  projectId: IdentitySchema,
  priorPlanDigest: DigestSchema,
  revisedPlanDigest: DigestSchema,
  authorityEnvelopeDigest: DigestSchema,
  securityDigest: DigestSchema,
  modelSheetDigest: DigestSchema.nullable(),
  revisedPlan: MilestonePlanSchema,
  requestedBy: IdentitySchema,
  priorEvidence: z.array(RevisionEvidenceReferenceSchema).min(1).max(256),
  supersessions: z.array(z.strictObject({
    priorTaskId: IdentitySchema,
    replacementTaskId: IdentitySchema,
  })).max(256),
}).superRefine((revision, context) => {
  if (revision.priorEvidence.some((reference) => reference.streamId !== revision.milestoneId)) {
    context.addIssue({ code: "custom", message: "revision authority evidence must belong to the milestone stream" });
  }
  if (new Set(revision.priorEvidence.map((reference) => reference.eventId)).size !== revision.priorEvidence.length) {
    context.addIssue({ code: "custom", message: "revision evidence references must be unique" });
  }
  if (new Set(revision.supersessions.map((relation) => relation.priorTaskId)).size !== revision.supersessions.length ||
    new Set(revision.supersessions.map((relation) => relation.replacementTaskId)).size !== revision.supersessions.length) {
    context.addIssue({ code: "custom", message: "revision supersession identities must be unique" });
  }
});

export const ReplanningResolutionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  milestoneId: IdentitySchema,
  attentionId: DigestSchema,
  priorPlanDigest: DigestSchema,
  candidateDigest: DigestSchema,
  pauseEventId: IdentitySchema,
  pauseStreamVersion: z.number().int().positive(),
  decisionId: IdentitySchema,
  decidedBy: IdentitySchema,
  action: z.literal("abandon_candidate"),
});

export const ReplanningReasonSchema = z.enum([
  "baseline_authority_unproven",
  "stale_plan",
  "goal",
  "ownership",
  "forbidden_scope",
  "authority",
  "network",
  "release",
  "budget",
  "security",
  "model_sheet",
  "dependency_graph",
  "evidence",
  "executed_task",
  "active_effect",
  "uncertain_effect",
]);

export const ReplanningAttentionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  attentionId: DigestSchema,
  milestoneId: IdentitySchema,
  revisionId: IdentitySchema,
  priorPlanDigest: DigestSchema,
  candidateDigest: DigestSchema,
  reason: ReplanningReasonSchema,
  requestedBy: z.literal("zentra-replanning-controller"),
  requiredDecision: z.literal("abandon_candidate"),
}).superRefine((attention, context) => {
  const expected = digestCanonical({
    milestoneId: attention.milestoneId,
    revisionId: attention.revisionId,
    priorPlanDigest: attention.priorPlanDigest,
    candidateDigest: attention.candidateDigest,
    reason: attention.reason,
  });
  if (attention.attentionId !== expected) {
    context.addIssue({ code: "custom", message: "replanning attention identity is invalid" });
  }
});

export const ReplanningPausedPayloadSchema = z.strictObject({
  attention: ReplanningAttentionSchema,
  evidence: z.record(z.string().min(1).max(128), z.string().max(4_096))
    .refine((value) => Object.keys(value).length <= 32)
    .default({}),
});

export type MilestoneAuthorityEnvelope = z.infer<typeof MilestoneAuthorityEnvelopeSchema>;
export type PlanRevisionPayload = z.infer<typeof PlanRevisionPayloadSchema>;
export type RevisionEvidenceReference = z.infer<typeof RevisionEvidenceReferenceSchema>;
export type ReplanningAttention = z.infer<typeof ReplanningAttentionSchema>;
export type ReplanningReason = z.infer<typeof ReplanningReasonSchema>;
export type ReplanningCapability = z.infer<typeof ReplanningCapabilitySchema>;
export type ReplanningResolutionPayload = z.infer<typeof ReplanningResolutionPayloadSchema>;
export type ReplanningPolicyBinding = z.infer<typeof ReplanningPolicyBindingSchema>;
export type ReplanningModelSheetSnapshot = z.infer<typeof ReplanningModelSheetSnapshotSchema>;
export type ReplanningModelCapabilitySnapshot = z.infer<typeof ReplanningModelCapabilitySnapshotSchema>;
export type PublicReplanningSecuritySnapshot = z.infer<typeof PublicReplanningSecuritySnapshotSchema>;
export type TaskRevisionState = {
  readonly taskId: string;
  readonly status: "planned" | "ready" | "running" | "blocked" | "superseded" | "completed";
  readonly terminalOutcome: "completed" | "cancelled" | "denied" | "timed_out" | "failed" | null;
};

export function createMilestoneAuthorityEnvelope(input: {
  readonly plan: MilestonePlan;
  readonly security: SecuritySheet;
  readonly modelSheet?: ModelSheet;
}): MilestoneAuthorityEnvelope {
  const policy = createReplanningPolicyBinding({
    milestoneId: input.plan.milestoneId,
    projectId: input.plan.projectId,
    security: input.security,
    ...(input.modelSheet === undefined ? {} : { modelSheet: input.modelSheet }),
  });
  const derived = derivePlanAuthority(input.plan);
  return MilestoneAuthorityEnvelopeSchema.parse({
    schemaVersion: 1,
    milestoneId: input.plan.milestoneId,
    projectId: input.plan.projectId,
    baselinePlanDigest: digestCanonical(input.plan),
    ...derived,
    securityDigest: policy.securityDigest,
    networkDigest: policy.networkDigest,
    releaseBoundary: policy.security.releaseBoundary,
    modelSheetDigest: policy.modelSheetDigest,
    capabilities: policy.modelSheet === null ? [] : capabilitySnapshot(policy.modelSheet),
  });
}

export function createReplanningPolicyBinding(input: {
  readonly milestoneId: string;
  readonly projectId: string;
  readonly security: SecuritySheet;
  readonly modelSheet?: ModelSheet;
}): ReplanningPolicyBinding {
  const security = PublicReplanningSecuritySnapshotSchema.parse({
    allowedRepositoriesDigest: digestCanonical(canonicalSet(input.security.allowedRepositories)),
    allowedRepositoryCount: input.security.allowedRepositories.length,
    allowedFileScopesDigest: digestCanonical(canonicalSet(input.security.allowedFileScopes)),
    allowedFileScopeCount: input.security.allowedFileScopes.length,
    forbiddenPathsDigest: digestCanonical(canonicalSet(input.security.forbiddenPaths)),
    forbiddenPathCount: input.security.forbiddenPaths.length,
    network: {
      default: input.security.network.default,
      allowedDestinationsDigest: digestCanonical(canonicalSet(input.security.network.allowedDestinations)),
      allowedDestinationCount: input.security.network.allowedDestinations.length,
    },
    secretHandlingDigest: digestCanonical(canonicalSet(input.security.secretHandling)),
    secretHandlingRuleCount: input.security.secretHandling.length,
    approvalRequiredOperations: canonicalSet(input.security.approvalRequiredOperations),
    releaseBoundary: input.security.releaseBoundary,
    stopAndAskConditions: canonicalSet(input.security.stopAndAskConditions),
  });
  const modelSheet = input.modelSheet === undefined ? null : canonicalModelSheetSnapshot(input.modelSheet);
  return ReplanningPolicyBindingSchema.parse({
    schemaVersion: 1,
    milestoneId: input.milestoneId,
    projectId: input.projectId,
    security,
    securityDigest: digestCanonical(security),
    networkDigest: digestCanonical(security.network),
    modelSheet,
    modelSheetDigest: modelSheet === null ? null : modelSheetSha256(modelSheet),
  });
}

export function createReplanningAttention(input: {
  readonly milestoneId: string;
  readonly revisionId: string;
  readonly priorPlanDigest: string;
  readonly candidateDigest: string;
  readonly reason: ReplanningReason;
}): ReplanningAttention {
  const identity = { ...input };
  return ReplanningAttentionSchema.parse({
    schemaVersion: 1,
    attentionId: digestCanonical(identity),
    ...identity,
    requestedBy: "zentra-replanning-controller",
    requiredDecision: "abandon_candidate",
  });
}

export function derivePlanAuthority(plan: MilestonePlan): Pick<MilestoneAuthorityEnvelope,
  "goalDigest" | "aggregateOwnedPaths" | "forbiddenPaths" | "authorityCategories" | "roleBoundaries" | "aggregateBudgetCeiling"> {
  return {
    goalDigest: digestCanonical(plan.goal),
    aggregateOwnedPaths: canonicalSet(plan.tasks.flatMap((task) => task.ownedPaths)),
    forbiddenPaths: canonicalSet(plan.tasks.flatMap((task) => task.forbiddenPaths)),
    authorityCategories: canonicalSet(plan.tasks.map((task) => task.risk.authority)),
    roleBoundaries: [...new Map(plan.tasks.map((task) => {
      const boundary = { role: task.roleAssignment.role, harness: task.roleAssignment.harness };
      return [`${boundary.role}:${boundary.harness}`, boundary] as const;
    })).values()].sort((a, b) => `${a.role}:${a.harness}`.localeCompare(`${b.role}:${b.harness}`)),
    aggregateBudgetCeiling: sumBudgets(plan),
  };
}

export function validateAuthorityEnvelope(
  envelope: MilestoneAuthorityEnvelope,
  baseline: MilestonePlan,
  policy: ReplanningPolicyBinding,
): void {
  const expected = derivePlanAuthority(baseline);
  if (
    envelope.milestoneId !== baseline.milestoneId || envelope.projectId !== baseline.projectId ||
    envelope.baselinePlanDigest !== digestCanonical(baseline) ||
    policy.milestoneId !== baseline.milestoneId || policy.projectId !== baseline.projectId ||
    envelope.securityDigest !== policy.securityDigest || envelope.networkDigest !== policy.networkDigest ||
    envelope.releaseBoundary !== policy.security.releaseBoundary || envelope.modelSheetDigest !== policy.modelSheetDigest ||
    digestCanonical(envelope.capabilities) !== digestCanonical(policy.modelSheet === null ? [] : capabilitySnapshot(policy.modelSheet)) ||
    digestCanonical({
      goalDigest: envelope.goalDigest,
      aggregateOwnedPaths: envelope.aggregateOwnedPaths,
      forbiddenPaths: envelope.forbiddenPaths,
      authorityCategories: envelope.authorityCategories,
      roleBoundaries: envelope.roleBoundaries,
      aggregateBudgetCeiling: envelope.aggregateBudgetCeiling,
    }) !== digestCanonical(expected)
  ) throw new Error("milestone authority envelope derivation is invalid");
  for (const task of baseline.tasks) {
    const capability = envelope.capabilities.find((candidate) => candidate.capabilityId === task.roleAssignment.agentId);
    if (task.roleAssignment.harness !== "deterministic" && !capabilitySupportsTask(capability, task)) {
      throw new Error("milestone authority envelope lacks the exact planned capability");
    }
  }
}

export function revisionBoundaryViolation(input: {
  readonly envelope: MilestoneAuthorityEnvelope;
  readonly currentPlan: MilestonePlan;
  readonly candidatePlan: MilestonePlan;
  readonly planHistory: readonly MilestonePlan[];
  readonly taskStates: Readonly<Record<string, TaskRevisionState>>;
  readonly executedTaskIds: readonly string[];
  readonly supersessions: readonly { readonly priorTaskId: string; readonly replacementTaskId: string }[];
}): ReplanningReason | null {
  const { envelope, currentPlan, candidatePlan } = input;
  if (candidatePlan.milestoneId !== currentPlan.milestoneId || candidatePlan.projectId !== currentPlan.projectId ||
    digestCanonical(candidatePlan.goal) !== envelope.goalDigest) return "goal";
  if (candidatePlan.tasks.some((task) => task.ownedPaths.some((owned) =>
    !envelope.aggregateOwnedPaths.some((allowed) => scopeContains(allowed, owned))
  ))) return "ownership";
  const forbidden = candidatePlan.tasks.flatMap((task) => task.forbiddenPaths);
  if (envelope.forbiddenPaths.some((path) => !forbidden.some((candidate) => scopeContains(candidate, path)))) {
    return "forbidden_scope";
  }
  const authorities = new Set(envelope.authorityCategories);
  const roles = new Set(envelope.roleBoundaries.map((boundary) => `${boundary.role}:${boundary.harness}`));
  if (candidatePlan.tasks.some((task) => !authorities.has(task.risk.authority) ||
    !roles.has(`${task.roleAssignment.role}:${task.roleAssignment.harness}`) ||
    (task.roleAssignment.harness !== "deterministic" &&
      !capabilitySupportsTask(envelope.capabilities.find((capability) => capability.capabilityId === task.roleAssignment.agentId), task)))) {
    return "authority";
  }
  const candidateById = new Map(candidatePlan.tasks.map((task) => [task.taskId, task] as const));
  const supersessions = new Map(input.supersessions.map((relation) => [relation.priorTaskId, relation.replacementTaskId] as const));
  const historicalTaskIds = new Set(input.planHistory.flatMap((plan) => plan.tasks.map((task) => task.taskId)));
  if (supersessions.size !== input.supersessions.length || new Set(input.supersessions.map((item) => item.replacementTaskId)).size !== input.supersessions.length) {
    return "executed_task";
  }
  for (const taskId of input.executedTaskIds) {
    const state = input.taskStates[taskId];
    const definition = latestDefinition(input.planHistory, taskId);
    const candidate = candidateById.get(taskId);
    if (state === undefined || definition === undefined) return "active_effect";
    if (state.status === "superseded") {
      const replacementId = supersessions.get(taskId);
      if (candidate !== undefined || replacementId === undefined || replacementId === taskId || !candidateById.has(replacementId) ||
        historicalTaskIds.has(replacementId) || input.taskStates[replacementId] !== undefined) return "executed_task";
      continue;
    }
    if (state.status !== "completed") return "active_effect";
    if (state.terminalOutcome === "completed") {
      if (candidate === undefined || digestCanonical(candidate) !== digestCanonical(definition) || supersessions.has(taskId)) return "executed_task";
      continue;
    }
    const replacementId = supersessions.get(taskId);
    if (candidate !== undefined || replacementId === undefined || replacementId === taskId || !candidateById.has(replacementId) ||
      historicalTaskIds.has(replacementId) || input.taskStates[replacementId] !== undefined) return "executed_task";
  }
  if (input.supersessions.some((relation) => !input.executedTaskIds.includes(relation.priorTaskId))) return "executed_task";
  const budget = sumBudgets(candidatePlan);
  for (const taskId of input.executedTaskIds) {
    if (!candidateById.has(taskId)) addBudget(budget, latestDefinition(input.planHistory, taskId)!.budget);
  }
  if (budgetExceeds(budget, envelope.aggregateBudgetCeiling)) return "budget";
  return null;
}

export function capabilitySupportsAdmission(
  envelope: MilestoneAuthorityEnvelope,
  task: PlannedTask,
  context: {
    readonly actorId: string; readonly capabilityId: string; readonly harness: string; readonly role: string;
    readonly roles: readonly string[]; readonly toolPermissions: readonly string[]; readonly network: string;
    readonly contextTokens: number; readonly transportModelId: string; readonly authority: string;
  },
): boolean {
  const capability = envelope.capabilities.find((candidate) => candidate.capabilityId === task.roleAssignment.agentId);
  return capabilitySupportsTask(capability, task) && capability !== undefined &&
    context.actorId === capability.capabilityId && context.capabilityId === capability.capabilityId &&
    context.harness === capability.harness && context.role === task.roleAssignment.role &&
    context.authority === task.risk.authority && sameSet(context.roles, capability.roles) &&
    sameSet(context.toolPermissions, capability.toolPermissions) && context.network === capability.network &&
    context.contextTokens === capability.contextTokens && sha256(context.transportModelId) === capability.transportModelDigest;
}

export function sumBudgets(plan: MilestonePlan): z.infer<typeof MilestoneBudgetSchema> {
  return plan.tasks.reduce((total, task) => ({
    maxSeconds: total.maxSeconds + task.budget.maxSeconds,
    maxRetries: total.maxRetries + task.budget.maxRetries,
    maxCostUsd: total.maxCostUsd + task.budget.maxCostUsd,
    maxInputTokens: total.maxInputTokens + task.budget.maxInputTokens,
    maxOutputTokens: total.maxOutputTokens + task.budget.maxOutputTokens,
  }), { maxSeconds: 0, maxRetries: 0, maxCostUsd: 0, maxInputTokens: 0, maxOutputTokens: 0 });
}

export function capabilitySnapshot(sheet: ModelSheet): ReplanningCapability[] {
  return [...sheet.models].sort((a, b) => a.id.localeCompare(b.id)).map((capability) => ReplanningCapabilitySchema.parse({
    capabilityId: capability.id,
    harness: capability.harness,
    roles: canonicalSet(capability.roles),
    toolPermissions: canonicalSet(capability.toolPermissions),
    network: capability.network,
    contextTokens: capability.contextTokens,
    transportModelDigest: sha256(capability.model),
  }));
}

function canonicalModelSheetSnapshot(sheet: ModelSheet): ReplanningModelSheetSnapshot {
  return ReplanningModelSheetSnapshotSchema.parse({
    models: sheet.models,
  });
}

function capabilitySupportsTask(capability: ReplanningCapability | undefined, task: PlannedTask): boolean {
  if (capability === undefined || capability.harness !== task.roleAssignment.harness || !capability.roles.includes(task.roleAssignment.role)) return false;
  if (task.risk.authority === "external_effect") return false;
  const required = authorityTool(task.risk.authority);
  return required === null || capability.toolPermissions.includes(required);
}

function authorityTool(authority: PlannedTask["risk"]["authority"]): string | null {
  if (authority === "read_only") return "read_repository";
  if (authority === "workspace_write") return "write_worktree";
  if (authority === "validation") return "run_validation";
  if (authority === "review") return "review_diff";
  if (authority === "integration" || authority === "local_release_preparation") return "integrate";
  return null;
}

export function scopeContains(container: string, candidate: string): boolean {
  const containerRecursive = container.endsWith("/**");
  const candidateRecursive = candidate.endsWith("/**");
  const base = containerRecursive ? container.slice(0, -3) : container;
  const candidateBase = candidateRecursive ? candidate.slice(0, -3) : candidate;
  if (!containerRecursive) return !candidateRecursive && base === candidateBase;
  return candidateBase === base || candidateBase.startsWith(`${base}/`);
}

function latestDefinition(history: readonly MilestonePlan[], taskId: string): PlannedTask | undefined {
  return [...history].reverse().flatMap((plan) => plan.tasks).find((task) => task.taskId === taskId);
}

function addBudget(target: z.infer<typeof MilestoneBudgetSchema>, source: PlannedTask["budget"]): void {
  target.maxSeconds += source.maxSeconds;
  target.maxRetries += source.maxRetries;
  target.maxCostUsd += source.maxCostUsd;
  target.maxInputTokens += source.maxInputTokens;
  target.maxOutputTokens += source.maxOutputTokens;
}

function budgetExceeds(candidate: PlannedTask["budget"], ceiling: PlannedTask["budget"]): boolean {
  return candidate.maxSeconds > ceiling.maxSeconds || candidate.maxRetries > ceiling.maxRetries ||
    candidate.maxCostUsd > ceiling.maxCostUsd || candidate.maxInputTokens > ceiling.maxInputTokens ||
    candidate.maxOutputTokens > ceiling.maxOutputTokens;
}

function sameSet(first: readonly string[], second: readonly string[]): boolean {
  return JSON.stringify([...new Set(first)].sort()) === JSON.stringify([...new Set(second)].sort());
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalSet<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function assertCanonicalSet(values: readonly string[], context: z.RefinementCtx): void {
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    context.addIssue({ code: "custom", message: "set values must be unique and canonically sorted" });
  }
}

function assertUniqueSet(values: readonly string[], context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "set values must be unique" });
  }
}
