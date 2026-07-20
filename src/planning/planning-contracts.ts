import { z } from "zod";

import { digestCanonical } from "../contracts/authority-attention.js";
import {
  AuthorityLevelSchema,
  MilestoneBudgetSchema,
  MilestonePlanSchema,
  MilestoneRoleSchema,
  SafeLogicalPathSchema,
} from "../contracts/milestone.js";
import { ProjectRevisionSchema, RunBudgetSchema, type RunBudget } from "../runs/run-contracts.js";

export const PLANNING_SCHEMA_VERSION = 1;

const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TextSchema = z.string().min(1).max(4_096);
const CanonicalPathsSchema = z.array(SafeLogicalPathSchema).max(1_024).superRefine(canonicalSetRefinement);
const CanonicalIdsSchema = z.array(IdSchema).max(256).superRefine(canonicalSetRefinement);

export const PlanningAnalysisEvidenceSchema = z.strictObject({
  analysisStreamId: IdSchema,
  completionEventId: IdSchema,
  evidenceSha256: DigestSchema,
  sourceEvidenceSha256: DigestSchema,
});

export const PlanningCapabilityIdentitySchema = z.strictObject({
  capabilityId: IdSchema,
  agentId: IdSchema,
  role: MilestoneRoleSchema,
  harness: z.enum(["opencode", "claude_code", "codex", "deterministic"]),
});

export const ValidationIdentitySchema = z.strictObject({
  validationId: z.enum(["focused", "full"]),
  executable: z.string().min(1).max(4_096),
  executableDevice: z.number().int().nonnegative(),
  executableInode: z.number().int().nonnegative(),
  executableSize: z.number().int().positive(),
  executableSha256: DigestSchema,
  args: z.array(z.string().max(16_384)).max(256),
  argvSha256: DigestSchema,
  timeoutMs: z.number().int().positive().max(86_400_000),
  projectConfigSha256: DigestSchema,
});

export const PlanningEvidenceRequirementSchema = z.strictObject({
  criterionIndex: z.number().int().nonnegative(),
  kind: z.enum([
    "analysis_citation",
    "changed_paths",
    "validation_report",
    "review_decision",
    "integration_receipt",
    "no_effect_observation",
  ]),
  producerRole: MilestoneRoleSchema,
  digestBound: z.literal(true),
});

export const PlanningTaskSpecificationSchema = z.strictObject({
  taskId: IdSchema,
  capabilityId: IdSchema,
  broadReadPaths: CanonicalPathsSchema,
  potentialWritePaths: CanonicalPathsSchema,
  evidenceRequirements: z.array(PlanningEvidenceRequirementSchema).min(1).max(256),
  requiredValidationIds: CanonicalIdsSchema,
});

export const PlanningProposalSchema = z.strictObject({
  schemaVersion: z.literal(PLANNING_SCHEMA_VERSION),
  revision: z.number().int().positive(),
  runId: IdSchema,
  projectId: IdSchema,
  projectRevision: ProjectRevisionSchema,
  securityDigest: DigestSchema,
  capabilityCatalogDigest: DigestSchema,
  analysisEvidence: PlanningAnalysisEvidenceSchema,
  plan: MilestonePlanSchema,
  taskSpecifications: z.array(PlanningTaskSpecificationSchema).min(1).max(512),
  validationIdentities: z.array(ValidationIdentitySchema).max(2),
  executionAuthority: z.literal("none"),
}).superRefine(validateProposal);

export const PlanningAggregateBudgetSchema = MilestoneBudgetSchema.extend({
  maxCostUsdNano: z.number().int().nonnegative(),
}).omit({ maxCostUsd: true });

export const PlanningAuthorityEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(PLANNING_SCHEMA_VERSION),
  runId: IdSchema,
  projectId: IdSchema,
  projectRevision: ProjectRevisionSchema,
  securityDigest: DigestSchema,
  capabilityCatalogDigest: DigestSchema,
  milestoneId: IdSchema,
  proposalRevision: z.number().int().positive(),
  planDigest: DigestSchema,
  goalDigest: DigestSchema,
  broadReadPaths: CanonicalPathsSchema,
  potentialWritePaths: CanonicalPathsSchema,
  ownedPaths: CanonicalPathsSchema,
  forbiddenPaths: CanonicalPathsSchema,
  authorities: z.array(AuthorityLevelSchema).min(1).superRefine(canonicalSetRefinement),
  roles: z.array(MilestoneRoleSchema).min(1).superRefine(canonicalSetRefinement),
  roleAssignments: z.array(z.strictObject({
    taskId: IdSchema,
    role: MilestoneRoleSchema,
    agentId: IdSchema,
    harness: z.enum(["opencode", "claude_code", "codex", "deterministic"]),
  })).min(1).max(512),
  taskBounds: z.array(z.strictObject({
    taskId: IdSchema,
    broadReadPaths: CanonicalPathsSchema,
    potentialWritePaths: CanonicalPathsSchema,
    ownedPaths: CanonicalPathsSchema,
    forbiddenPaths: CanonicalPathsSchema,
    authority: AuthorityLevelSchema,
    capabilityId: IdSchema,
    budget: MilestoneBudgetSchema,
    requiredValidationIds: CanonicalIdsSchema,
    evidenceRequirementsSha256: DigestSchema,
  })).min(1).max(512),
  aggregateBudget: PlanningAggregateBudgetSchema,
  writerCapacity: z.literal(1),
  validationIdentityDigests: z.array(DigestSchema).max(2).superRefine(canonicalSetRefinement),
  evidenceRequirementsSha256: DigestSchema,
  analysisEvidenceSha256: DigestSchema,
  potentialWriteSemantics: z.literal("descriptive_upper_bound_only"),
  executionAuthority: z.literal("none"),
});

export const PlanningArtifactSchema = z.strictObject({
  proposal: PlanningProposalSchema,
  planDigest: DigestSchema,
  envelope: PlanningAuthorityEnvelopeSchema,
  envelopeDigest: DigestSchema,
}).superRefine((artifact, context) => {
  if (digestCanonical(artifact.proposal) !== artifact.planDigest) {
    context.addIssue({ code: "custom", message: "plan digest does not match the proposal" });
  }
  if (artifact.envelope.planDigest !== artifact.planDigest) {
    context.addIssue({ code: "custom", message: "authority envelope does not bind the proposal" });
  }
  if (digestCanonical(artifact.envelope) !== artifact.envelopeDigest) {
    context.addIssue({ code: "custom", message: "envelope digest does not match the authority envelope" });
  }
  const derived = derivePlanningEnvelope(artifact.proposal);
  if (JSON.stringify(artifact.envelope) !== JSON.stringify(derived)) {
    context.addIssue({ code: "custom", message: "authority envelope is not exactly derived from the proposal" });
  }
});

export const PlanProposedPayloadSchema = PlanningArtifactSchema.extend({
  schemaVersion: z.literal(PLANNING_SCHEMA_VERSION),
  revision: z.number().int().positive(),
  commandId: IdSchema,
  authority: z.literal("none"),
}).superRefine((payload, context) => {
  if (payload.revision !== payload.proposal.revision) {
    context.addIssue({ code: "custom", message: "event revision does not match proposal revision" });
  }
});

export const PlanRevisedPayloadSchema = PlanProposedPayloadSchema.extend({
  priorPlanDigest: DigestSchema,
  priorEnvelopeDigest: DigestSchema,
});

export const PlanRejectedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(PLANNING_SCHEMA_VERSION),
  revision: z.number().int().positive(),
  decisionId: IdSchema,
  approvalRequestEventId: IdSchema,
  decisionEventId: IdSchema,
  reason: TextSchema,
  reasonEvidenceSha256: DigestSchema,
  planDigest: DigestSchema,
  envelopeDigest: DigestSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const CorrectionProposedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(PLANNING_SCHEMA_VERSION),
  revision: z.number().int().positive(),
  rejectedPlanDigest: DigestSchema,
  rejectedEnvelopeDigest: DigestSchema,
  bounds: PlanningAuthorityEnvelopeSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export type PlanningProposalInput = Omit<z.input<typeof PlanningProposalSchema>, "schemaVersion" | "revision" | "executionAuthority">;
export type PlanningProposal = z.output<typeof PlanningProposalSchema>;
export type PlanningAuthorityEnvelope = z.output<typeof PlanningAuthorityEnvelopeSchema>;
export type PlanningArtifact = z.output<typeof PlanningArtifactSchema>;
export type ValidationIdentity = z.output<typeof ValidationIdentitySchema>;
export type PlanningCapabilityIdentity = z.output<typeof PlanningCapabilityIdentitySchema>;

export function planningStreamId(runId: string): string {
  return `planning:${IdSchema.parse(runId)}`;
}

export function buildPlanningArtifact(
  input: PlanningProposalInput,
  runBudget: RunBudget,
  revision: number,
): PlanningArtifact {
  const proposal = PlanningProposalSchema.parse({
    ...input,
    schemaVersion: PLANNING_SCHEMA_VERSION,
    revision,
    taskSpecifications: canonicalBy(input.taskSpecifications, (item) => item.taskId).map((item) => ({
      ...item,
      broadReadPaths: canonicalSet(item.broadReadPaths),
      potentialWritePaths: canonicalSet(item.potentialWritePaths),
      requiredValidationIds: canonicalSet(item.requiredValidationIds),
    })),
    validationIdentities: canonicalBy(input.validationIdentities, (item) => item.validationId),
    executionAuthority: "none",
  });
  validateBudgetContainment(proposal, RunBudgetSchema.parse(runBudget));
  const planDigest = digestCanonical(proposal);
  const envelope = derivePlanningEnvelope(proposal);
  return PlanningArtifactSchema.parse({
    proposal,
    planDigest: digestCanonical(proposal),
    envelope,
    envelopeDigest: digestCanonical(envelope),
  });
}

function derivePlanningEnvelope(proposal: PlanningProposal): PlanningAuthorityEnvelope {
  return PlanningAuthorityEnvelopeSchema.parse({
    schemaVersion: PLANNING_SCHEMA_VERSION,
    runId: proposal.runId,
    projectId: proposal.projectId,
    projectRevision: proposal.projectRevision,
    securityDigest: proposal.securityDigest,
    capabilityCatalogDigest: proposal.capabilityCatalogDigest,
    milestoneId: proposal.plan.milestoneId,
    proposalRevision: proposal.revision,
    planDigest: digestCanonical(proposal),
    goalDigest: digestCanonical(proposal.plan.goal),
    broadReadPaths: canonicalSet(proposal.taskSpecifications.flatMap((item) => item.broadReadPaths)),
    potentialWritePaths: canonicalSet(proposal.taskSpecifications.flatMap((item) => item.potentialWritePaths)),
    ownedPaths: canonicalSet(proposal.plan.tasks.flatMap((task) => task.ownedPaths)),
    forbiddenPaths: canonicalSet(proposal.plan.tasks.flatMap((task) => task.forbiddenPaths)),
    authorities: canonicalSet(proposal.plan.tasks.map((task) => task.risk.authority)),
    roles: canonicalSet(proposal.plan.tasks.map((task) => task.roleAssignment.role)),
    roleAssignments: proposal.plan.tasks.map((task) => ({
      taskId: task.taskId,
      role: task.roleAssignment.role,
      agentId: task.roleAssignment.agentId,
      harness: task.roleAssignment.harness,
    })).sort((left, right) => left.taskId.localeCompare(right.taskId)),
    taskBounds: proposal.plan.tasks.map((task) => {
      const specification = proposal.taskSpecifications.find((item) => item.taskId === task.taskId)!;
      return {
        taskId: task.taskId,
        broadReadPaths: specification.broadReadPaths,
        potentialWritePaths: specification.potentialWritePaths,
        ownedPaths: canonicalSet(task.ownedPaths),
        forbiddenPaths: canonicalSet(task.forbiddenPaths),
        authority: task.risk.authority,
        capabilityId: specification.capabilityId,
        budget: task.budget,
        requiredValidationIds: specification.requiredValidationIds,
        evidenceRequirementsSha256: digestCanonical(specification.evidenceRequirements),
      };
    }).sort((left, right) => left.taskId.localeCompare(right.taskId)),
    aggregateBudget: aggregateBudget(proposal),
    writerCapacity: 1,
    validationIdentityDigests: canonicalSet(proposal.validationIdentities.map((identity) => digestCanonical(identity))),
    evidenceRequirementsSha256: digestCanonical(proposal.taskSpecifications.map((item) => ({
      taskId: item.taskId,
      evidenceRequirements: item.evidenceRequirements,
    }))),
    analysisEvidenceSha256: digestCanonical(proposal.analysisEvidence),
    potentialWriteSemantics: "descriptive_upper_bound_only",
    executionAuthority: "none",
  });
}

export function assertCorrectionWithinBounds(
  artifact: PlanningArtifact,
  bounds: PlanningAuthorityEnvelope,
): void {
  assertSubset(artifact.envelope.broadReadPaths, bounds.broadReadPaths, "broad read scope");
  assertSubset(artifact.envelope.potentialWritePaths, bounds.potentialWritePaths, "potential write scope");
  assertSubset(artifact.envelope.ownedPaths, bounds.ownedPaths, "owned path scope");
  assertSubset(bounds.forbiddenPaths, artifact.envelope.forbiddenPaths, "forbidden path protection");
  assertSubset(artifact.envelope.authorities, bounds.authorities, "authority");
  assertSubset(artifact.envelope.roles, bounds.roles, "role");
  if (JSON.stringify(artifact.envelope.validationIdentityDigests) !== JSON.stringify(bounds.validationIdentityDigests)) {
    throw new Error("corrected proposal changes validation identities");
  }
  if (artifact.envelope.goalDigest !== bounds.goalDigest) throw new Error("corrected proposal changes the rejected goal");
  if (artifact.envelope.securityDigest !== bounds.securityDigest) throw new Error("corrected proposal changes the security policy");
  if (artifact.envelope.capabilityCatalogDigest !== bounds.capabilityCatalogDigest) throw new Error("corrected proposal changes the capability catalog");
  if (artifact.envelope.analysisEvidenceSha256 !== bounds.analysisEvidenceSha256) throw new Error("corrected proposal changes the analysis evidence");
  if (artifact.envelope.evidenceRequirementsSha256 !== bounds.evidenceRequirementsSha256) throw new Error("corrected proposal weakens evidence requirements");
  if (JSON.stringify(artifact.envelope.roleAssignments) !== JSON.stringify(bounds.roleAssignments)) {
    throw new Error("corrected proposal changes role assignment authority");
  }
  const priorTasks = new Map(bounds.taskBounds.map((task) => [task.taskId, task]));
  if (artifact.envelope.taskBounds.length !== bounds.taskBounds.length) {
    throw new Error("corrected proposal changes the bounded task identities");
  }
  for (const task of artifact.envelope.taskBounds) {
    const priorTask = priorTasks.get(task.taskId);
    if (priorTask === undefined) throw new Error("corrected proposal changes the bounded task identities");
    assertSubset(task.broadReadPaths, priorTask.broadReadPaths, `task ${task.taskId} broad read scope`);
    assertSubset(task.potentialWritePaths, priorTask.potentialWritePaths, `task ${task.taskId} potential write scope`);
    assertSubset(task.ownedPaths, priorTask.ownedPaths, `task ${task.taskId} owned path scope`);
    assertSubset(priorTask.forbiddenPaths, task.forbiddenPaths, `task ${task.taskId} forbidden path protection`);
    if (JSON.stringify(task.requiredValidationIds) !== JSON.stringify(priorTask.requiredValidationIds)) {
      throw new Error(`corrected proposal changes task ${task.taskId} validation requirements`);
    }
    if (task.authority !== priorTask.authority) throw new Error(`corrected proposal changes task ${task.taskId} authority`);
    if (task.capabilityId !== priorTask.capabilityId) throw new Error(`corrected proposal changes task ${task.taskId} capability identity`);
    if (task.evidenceRequirementsSha256 !== priorTask.evidenceRequirementsSha256) {
      throw new Error(`corrected proposal weakens task ${task.taskId} evidence requirements`);
    }
    if (task.budget.maxSeconds > priorTask.budget.maxSeconds || task.budget.maxRetries > priorTask.budget.maxRetries ||
      task.budget.maxCostUsd > priorTask.budget.maxCostUsd || task.budget.maxInputTokens > priorTask.budget.maxInputTokens ||
      task.budget.maxOutputTokens > priorTask.budget.maxOutputTokens) {
      throw new Error(`corrected proposal expands task ${task.taskId} budget`);
    }
  }
  const next = artifact.envelope.aggregateBudget;
  const prior = bounds.aggregateBudget;
  if (next.maxSeconds > prior.maxSeconds || next.maxRetries > prior.maxRetries ||
    next.maxCostUsdNano > prior.maxCostUsdNano || next.maxInputTokens > prior.maxInputTokens ||
    next.maxOutputTokens > prior.maxOutputTokens) {
    throw new Error("corrected proposal expands the rejected budget envelope");
  }
}

function validateProposal(proposal: z.infer<typeof PlanningProposalSchema>, context: z.RefinementCtx): void {
  if (proposal.plan.projectId !== proposal.projectId) {
    context.addIssue({ code: "custom", message: "plan project does not match planning project" });
  }
  const tasks = new Map(proposal.plan.tasks.map((task) => [task.taskId, task]));
  const specifications = new Map<string, z.infer<typeof PlanningTaskSpecificationSchema>>();
  const validationIds = new Set(proposal.validationIdentities.map((identity) => identity.validationId));
  for (const specification of proposal.taskSpecifications) {
    if (specifications.has(specification.taskId)) {
      context.addIssue({ code: "custom", message: `duplicate task specification ${specification.taskId}` });
      continue;
    }
    specifications.set(specification.taskId, specification);
    const task = tasks.get(specification.taskId);
    if (task === undefined) {
      context.addIssue({ code: "custom", message: `orphan task specification ${specification.taskId}` });
      continue;
    }
    if (["planner", "researcher", "reviewer"].includes(task.roleAssignment.role) && specification.potentialWritePaths.length > 0) {
      context.addIssue({ code: "custom", message: `read-only role ${task.roleAssignment.role} cannot propose potential writes` });
    }
    if (specification.capabilityId !== task.roleAssignment.agentId) {
      context.addIssue({ code: "custom", message: `task ${task.taskId} capability identity does not match its assigned agent` });
    }
    for (const candidate of specification.potentialWritePaths) {
      if (!task.ownedPaths.some((owner) => pathWithin(candidate, owner))) {
        context.addIssue({ code: "custom", message: `potential write ${candidate} is outside task ownership` });
      }
    }
    for (let criterionIndex = 0; criterionIndex < task.acceptanceCriteria.length; criterionIndex += 1) {
      if (!specification.evidenceRequirements.some((item) => item.criterionIndex === criterionIndex)) {
        context.addIssue({ code: "custom", message: `acceptance criterion ${criterionIndex} has no evidence requirement` });
      }
    }
    for (const requirement of specification.evidenceRequirements) {
      if (requirement.criterionIndex >= task.acceptanceCriteria.length) {
        context.addIssue({ code: "custom", message: `evidence requirement refers to unknown criterion ${requirement.criterionIndex}` });
      }
    }
    for (const validationId of specification.requiredValidationIds) {
      if (!validationIds.has(validationId as "focused" | "full")) {
        context.addIssue({ code: "custom", message: `unknown validation identity ${validationId}` });
      }
    }
    const evidenceKinds = new Set(specification.evidenceRequirements.map((item) => item.kind));
    if (task.risk.requiresReview && !evidenceKinds.has("review_decision")) {
      context.addIssue({ code: "custom", message: `task ${task.taskId} requires review decision evidence` });
    }
    if (specification.potentialWritePaths.length > 0 && !evidenceKinds.has("changed_paths")) {
      context.addIssue({ code: "custom", message: `writing task ${task.taskId} requires changed-path evidence` });
    }
    if (specification.requiredValidationIds.length > 0 && !evidenceKinds.has("validation_report")) {
      context.addIssue({ code: "custom", message: `task ${task.taskId} requires validation report evidence` });
    }
    if ((task.roleAssignment.role === "integrator" || task.risk.authority === "integration") &&
      !evidenceKinds.has("integration_receipt")) {
      context.addIssue({ code: "custom", message: `integration task ${task.taskId} requires integration receipt evidence` });
    }
    for (const requirement of specification.evidenceRequirements) {
      const requiredRole = requirement.kind === "review_decision" ? "reviewer"
        : requirement.kind === "validation_report" ? "validator"
        : requirement.kind === "integration_receipt" ? "integrator"
        : requirement.kind === "changed_paths" ? "implementer"
        : null;
      if (requiredRole !== null && requirement.producerRole !== requiredRole) {
        context.addIssue({ code: "custom", message: `${requirement.kind} evidence must be produced by the ${requiredRole} role` });
      }
    }
  }
  for (const taskId of tasks.keys()) {
    if (!specifications.has(taskId)) context.addIssue({ code: "custom", message: `planned task ${taskId} has no execution specification` });
  }
}

function aggregateBudget(proposal: PlanningProposal) {
  let maxSeconds = 0;
  let maxRetries = 0;
  let maxCostUsdNano = 0;
  let maxInputTokens = 0;
  let maxOutputTokens = 0;
  for (const task of proposal.plan.tasks) {
    maxSeconds += task.budget.maxSeconds;
    maxRetries += task.budget.maxRetries;
    maxInputTokens += task.budget.maxInputTokens;
    maxOutputTokens += task.budget.maxOutputTokens;
    const nanos = task.budget.maxCostUsd * 1_000_000_000;
    if (!Number.isSafeInteger(nanos) || nanos / 1_000_000_000 !== task.budget.maxCostUsd) {
      throw new Error(`task ${task.taskId} cost budget is not exactly representable in USD nanos`);
    }
    maxCostUsdNano += nanos;
  }
  return { maxSeconds, maxRetries, maxCostUsdNano, maxInputTokens, maxOutputTokens };
}

function validateBudgetContainment(proposal: PlanningProposal, runBudget: RunBudget): void {
  const { maxSeconds, maxRetries, maxCostUsdNano, maxInputTokens, maxOutputTokens } = aggregateBudget(proposal);
  if (maxSeconds * 1_000 > runBudget.maxDurationMs) throw new Error("plan duration budget exceeds the run budget");
  if (maxRetries > runBudget.maxRetries) throw new Error("plan retry budget exceeds the run budget");
  if (maxCostUsdNano > runBudget.maxCostUsdNano) throw new Error("plan cost budget exceeds the run budget");
  if (maxInputTokens > runBudget.maxInputTokens) throw new Error("plan input token budget exceeds the run budget");
  if (maxOutputTokens > runBudget.maxOutputTokens) throw new Error("plan output token budget exceeds the run budget");
}

function pathWithin(candidate: string, owner: string): boolean {
  return candidate === owner || candidate.startsWith(`${owner}/`);
}

function assertSubset(values: readonly string[], allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  if (values.some((value) => !set.has(value))) throw new Error(`corrected proposal expands ${label}`);
}

function canonicalSet<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function canonicalBy<T>(values: readonly T[], key: (item: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function canonicalSetRefinement(values: readonly string[], context: z.RefinementCtx): void {
  const canonical = canonicalSet(values);
  if (canonical.length !== values.length || canonical.some((value, index) => value !== values[index])) {
    context.addIssue({ code: "custom", message: "set must be unique and canonically sorted" });
  }
}
