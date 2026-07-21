import { z } from "zod";
import path from "node:path";

import { TerminalOutcomeSchema } from "../contracts/task.js";
import { logicalPathScopesOverlap } from "../milestones/path-ownership.js";

const Id = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const Text = z.string().min(1).max(4_096);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.string().datetime({ offset: true });
const CanonicalAbsolutePath = z.string().refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
const SafePath = z.string().min(1).max(4_096).refine((value) => {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r") || value.includes("\\") || value.startsWith("/")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "path must be a safe logical relative path");

const CanonicalIds = z.array(Id).max(512).superRefine(canonicalStrings);
const CanonicalPaths = z.array(SafePath).max(512).superRefine(canonicalStrings);

export const POD_SCHEMA_VERSION = 1 as const;

export const PodCapabilitySchema = z.enum([
  "read_repository",
  "write_worktree",
  "run_validation",
  "review_diff",
]);

export const PodBudgetSchema = z.strictObject({
  maxSeconds: z.number().int().positive().safe(),
  maxRetries: z.number().int().nonnegative().safe(),
  maxCostUsd: z.number().nonnegative().finite(),
  maxInputTokens: z.number().int().positive().safe(),
  maxOutputTokens: z.number().int().positive().safe(),
  maxExternalEffects: z.literal(0),
});

export const PodBudgetUsageSchema = z.strictObject({
  elapsedMs: z.number().int().nonnegative().safe(),
  retries: z.number().int().nonnegative().safe(),
  costUsd: z.number().nonnegative().finite(),
  inputTokens: z.number().int().nonnegative().safe(),
  outputTokens: z.number().int().nonnegative().safe(),
  externalEffects: z.literal(0),
});

export const PodTaskReferenceSchema = z.strictObject({
  milestoneId: Id,
  taskId: Id,
});

export const PodTaskSchema = z.strictObject({
  milestoneId: Id,
  taskId: Id,
  title: Text,
  dependencies: z.array(PodTaskReferenceSchema).max(128),
  acceptanceCriteria: z.array(Text).min(1).max(128),
  evidenceRequirements: z.array(Id).min(1).max(128).superRefine(canonicalStrings),
});

export const PodTaskRelationshipsSchema = z.strictObject({
  charterRevision: z.number().int().positive().safe(),
  relationships: z.array(z.strictObject({
    taskId: Id,
    dependencies: z.array(PodTaskReferenceSchema).max(128),
  })).min(1).max(512),
});

export const PodRoleAssignmentSchema = z.strictObject({
  roleId: Id,
  agentId: Id,
  taskIds: CanonicalIds,
});

export const PodOwnershipSchema = z.strictObject({
  ownedPaths: CanonicalPaths.min(1),
  forbiddenPaths: CanonicalPaths,
}).superRefine((scope, context) => {
  for (const owned of scope.ownedPaths) {
    for (const forbidden of scope.forbiddenPaths) {
      if (logicalPathScopesOverlap(owned, forbidden)) {
        context.addIssue({ code: "custom", message: `owned path ${owned} overlaps forbidden path ${forbidden}` });
      }
    }
  }
});

export const PodCheckpointDefinitionSchema = z.strictObject({
  checkpointId: Id,
  afterTaskIds: CanonicalIds.min(1),
  evidenceRequirements: z.array(Id).min(1).max(128).superRefine(canonicalStrings),
});

export const PodCharterSchema = z.strictObject({
  schemaVersion: z.literal(POD_SCHEMA_VERSION),
  podId: Id,
  projectId: Id,
  revision: z.number().int().positive().safe(),
  outcome: Text,
  sourceRefs: z.array(z.strictObject({ kind: z.enum(["plan", "ticket", "milestone"]), value: Text })).min(1).max(128),
  tasks: z.array(PodTaskSchema).min(1).max(512),
  roles: z.array(PodRoleAssignmentSchema).min(1).max(128),
  requiredCapabilities: z.array(PodCapabilitySchema).min(1).max(16).superRefine(canonicalStrings),
  ownership: PodOwnershipSchema,
  budget: PodBudgetSchema,
  checkpoints: z.array(PodCheckpointDefinitionSchema).max(128),
  acceptanceCriteria: z.array(Text).min(1).max(128),
  evidenceRequirements: z.array(Id).min(1).max(128).superRefine(canonicalStrings),
  forbiddenChanges: z.array(Text).min(1).max(128),
  securityBoundary: Text,
  escalationConditions: z.array(Text).min(1).max(128),
  completionRules: z.array(Text).min(1).max(128),
  cleanupRules: z.array(Text).min(1).max(128),
  execution: z.strictObject({
    mode: z.literal("local_process"),
    nativeSubagents: z.literal(false),
    distributed: z.literal(false),
  }),
}).superRefine(validateCharterGraph);

export const PodParentGrantSchema = z.strictObject({
  schemaVersion: z.literal(POD_SCHEMA_VERSION),
  grantId: Id,
  parentAuthorityId: Id,
  podId: Id,
  projectId: Id,
  repositoryPath: CanonicalAbsolutePath,
  worktreeRoot: CanonicalAbsolutePath,
  charterRevision: z.number().int().positive().safe(),
  charterDigest: Digest,
  agentIds: CanonicalIds.min(1),
  capabilities: z.array(PodCapabilitySchema).min(1).max(16).superRefine(canonicalStrings),
  ownedPaths: CanonicalPaths.min(1),
  forbiddenPaths: CanonicalPaths,
  budget: PodBudgetSchema,
  sharedIntegrationRefs: z.array(z.string().min(1).max(4_096).transform(normalizeHeadRef)).max(128)
    .transform((values) => [...new Set(values)].sort()),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  executionMode: z.literal("local_process"),
  nativeSubagents: z.literal(false),
  distributed: z.literal(false),
}).superRefine((grant, context) => {
  if (Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) {
    context.addIssue({ code: "custom", message: "grant expiry must follow issuance" });
  }
  for (const owned of grant.ownedPaths) {
    for (const forbidden of grant.forbiddenPaths) {
      if (logicalPathScopesOverlap(owned, forbidden)) {
        context.addIssue({ code: "custom", message: `grant owned path ${owned} overlaps forbidden path ${forbidden}` });
      }
    }
  }
});

export const PodLeaseSchema = z.strictObject({
  schemaVersion: z.literal(POD_SCHEMA_VERSION),
  leaseId: Id,
  grantId: Id,
  podId: Id,
  assignmentId: Id,
  workspaceLeaseId: Id,
  taskId: Id,
  agentId: Id,
  charterRevision: z.number().int().positive().safe(),
  capabilities: z.array(PodCapabilitySchema).min(1).max(16).superRefine(canonicalStrings),
  ownedPaths: CanonicalPaths.min(1),
  budget: PodBudgetSchema,
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  status: z.enum(["active", "cancelled", "expired", "released"]),
}).superRefine((lease, context) => {
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.issuedAt)) {
    context.addIssue({ code: "custom", message: "lease expiry must follow issuance" });
  }
});

export const PodWorkspaceLeaseSchema = z.strictObject({
  schemaVersion: z.literal(POD_SCHEMA_VERSION),
  workspaceLeaseId: Id,
  podLeaseId: Id,
  podId: Id,
  projectId: Id,
  taskId: Id,
  repositoryPath: CanonicalAbsolutePath,
  path: CanonicalAbsolutePath,
  branch: z.string().min(1).max(4_096).transform(normalizeHeadRef),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  status: z.literal("active"),
});

export const PodAssignmentSchema = z.strictObject({
  assignmentId: Id,
  taskId: Id,
  roleId: Id,
  agentId: Id,
  charterRevision: z.number().int().positive().safe(),
  capabilities: z.array(PodCapabilitySchema).min(1).max(16).superRefine(canonicalStrings),
  ownedPaths: CanonicalPaths.min(1),
  budget: PodBudgetSchema,
});

export const PodEvidenceSchema = z.strictObject({
  evidenceId: Id,
  taskId: Id.nullable(),
  kind: Id,
  sha256: Digest,
  sourceEventId: Id.nullable(),
});

export const PodCheckpointSchema = z.strictObject({
  checkpointId: Id,
  evidenceIds: CanonicalIds,
  status: z.enum(["passed", "failed", "blocked"]),
});

export const PodTaskTerminalProjectionSchema = z.strictObject({
  taskId: Id,
  outcome: TerminalOutcomeSchema,
  evidenceIds: CanonicalIds,
});

export const PodTerminalProjectionSchema = z.strictObject({
  schemaVersion: z.literal(POD_SCHEMA_VERSION),
  podId: Id,
  projectId: Id,
  charterRevision: z.number().int().positive().safe(),
  outcome: TerminalOutcomeSchema,
  tasks: z.array(PodTaskTerminalProjectionSchema).max(512),
  evidenceIds: CanonicalIds,
});

export const PodRevisionCauseSchema = z.strictObject({
  eventId: Id,
  streamVersion: z.number().int().positive().safe(),
  eventType: Id,
  payloadDigest: Digest,
});

export const PodRevisionSchema = z.strictObject({
  schemaVersion: z.literal(POD_SCHEMA_VERSION),
  revisionId: Id,
  priorRevision: z.number().int().positive().safe(),
  charter: PodCharterSchema,
  cause: PodRevisionCauseSchema,
});

export const PodOwnershipIntentSchema = z.strictObject({
  assignmentId: Id,
  taskId: Id,
  ownedPaths: CanonicalPaths.min(1),
});

export const PodReconciliationSchema = z.strictObject({
  reconciliationId: Id,
  assignmentId: Id,
  dispatchId: Id,
  operation: Text,
  reason: Text,
  evidence: z.record(Id, z.string().max(4_096)).refine((value) => Object.keys(value).length <= 32),
  requestedBy: Id,
});

export const PodReconciliationResolutionSchema = z.strictObject({
  reconciliationId: Id,
  assignmentId: Id,
  dispatchId: Id,
  resolution: z.enum(["completed", "no_effect", "failed"]),
  evidenceIds: CanonicalIds,
  decidedBy: Id,
  executionId: Id.nullable().default(null),
  processId: Id.nullable().default(null),
  processIncarnation: Id.nullable().default(null),
  terminationEvidenceSha256: Digest.nullable().default(null),
  effectEvidenceSha256: Digest.nullable().default(null),
});

export const PodAttentionSchema = z.strictObject({
  attentionId: Id,
  reason: Text,
  requestedBy: Id,
  requiredDecision: Text,
});

export const PodLifecycleSchema = z.enum([
  "registered", "admitted", "running", "blocked", "cancel_requested", "terminal",
]);

export type PodCapability = z.infer<typeof PodCapabilitySchema>;
export type PodBudget = z.infer<typeof PodBudgetSchema>;
export type PodBudgetUsage = z.infer<typeof PodBudgetUsageSchema>;
export type PodTask = z.infer<typeof PodTaskSchema>;
export type PodCharter = z.infer<typeof PodCharterSchema>;
export type PodParentGrant = z.infer<typeof PodParentGrantSchema>;
export type PodLease = z.infer<typeof PodLeaseSchema>;
export type PodWorkspaceLease = z.infer<typeof PodWorkspaceLeaseSchema>;
export type PodAssignment = z.infer<typeof PodAssignmentSchema>;
export type PodEvidence = z.infer<typeof PodEvidenceSchema>;
export type PodCheckpoint = z.infer<typeof PodCheckpointSchema>;
export type PodTerminalProjection = z.infer<typeof PodTerminalProjectionSchema>;
export type PodRevision = z.infer<typeof PodRevisionSchema>;
export type PodOwnershipIntent = z.infer<typeof PodOwnershipIntentSchema>;
export type PodReconciliation = z.infer<typeof PodReconciliationSchema>;
export type PodReconciliationResolution = z.infer<typeof PodReconciliationResolutionSchema>;
export type PodAttention = z.infer<typeof PodAttentionSchema>;
export type PodLifecycle = z.infer<typeof PodLifecycleSchema>;

export function parsePodEventPayload(type: string, payload: unknown): unknown {
  switch (type) {
    case "pod.registered": return z.strictObject({ charter: PodCharterSchema }).parse(payload);
    case "pod.admitted": return z.strictObject({ grant: PodParentGrantSchema, admittedAt: Timestamp }).parse(payload);
    case "pod.lease_received": return z.strictObject({ lease: PodLeaseSchema }).parse(payload);
    case "pod.workspace_lease_received": return z.strictObject({ workspace: PodWorkspaceLeaseSchema }).parse(payload);
    case "pod.task_relationships_recorded": return PodTaskRelationshipsSchema.parse(payload);
    case "pod.started": return z.strictObject({ podId: Id }).parse(payload);
    case "pod.blocked": return z.strictObject({ reason: Text }).parse(payload);
    case "pod.attention_raised": return PodAttentionSchema.parse(payload);
    case "pod.attention_resolved": return z.strictObject({ attentionId: Id, decidedBy: Id }).parse(payload);
    case "pod.assignment_recorded": return z.strictObject({
      assignment: PodAssignmentSchema, proposalId: Digest, assignmentDigest: Digest,
      charterDigest: Digest, grantDigest: Digest, leaseDigest: Digest,
    }).parse(payload);
    case "pod.assignment_dispatched": return z.strictObject({ assignmentId: Id, proposalId: Digest, dispatchId: Id }).parse(payload);
    case "pod.assignment_invocation_started": return z.strictObject({ assignmentId: Id, dispatchId: Id, authorizedAt: Timestamp }).parse(payload);
    case "pod.execution_reserved": return z.strictObject({ assignmentId: Id, dispatchId: Id, executionId: Id,
      charterRevision: z.number().int().positive().safe() }).parse(payload);
    case "pod.execution_bound": return z.strictObject({ assignmentId: Id, dispatchId: Id, executionId: Id,
      processId: Id, processIncarnation: Id }).parse(payload);
    case "pod.assignment_observed": return z.strictObject({
      assignmentId: Id, dispatchId: Id, outcome: z.enum(["completed", "cancelled", "timed_out", "failed", "uncertain"]),
      evidenceIds: CanonicalIds, usage: PodBudgetUsageSchema, terminationAcknowledged: z.boolean(),
    }).parse(payload);
    case "pod.ownership_intent_observed": return PodOwnershipIntentSchema.parse(payload);
    case "pod.checkpointed": return PodCheckpointSchema.parse(payload);
    case "pod.evidence_recorded": return PodEvidenceSchema.parse(payload);
    case "pod.revised": return PodRevisionSchema.parse(payload);
    case "pod.reconciliation_required": return PodReconciliationSchema.parse(payload);
    case "pod.reconciliation_resolved": return PodReconciliationResolutionSchema.parse(payload);
    case "pod.cancel_requested": return z.strictObject({ requestedBy: Id, reason: Text }).parse(payload);
    case "pod.completed":
    case "pod.cancelled":
    case "pod.denied":
    case "pod.timed_out":
    case "pod.failed": return PodTerminalProjectionSchema.parse(payload);
    default: throw new Error(`unknown pod event type: ${type}`);
  }
}

export function normalizeHeadRef(value: string): string {
  if (value.startsWith("refs/heads/")) return value;
  if (value.startsWith("refs/")) throw new Error("only branch refs are supported");
  return `refs/heads/${value}`;
}

function canonicalStrings(values: readonly string[], context: z.RefinementCtx): void {
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    context.addIssue({ code: "custom", message: "set values must be unique and canonically sorted" });
  }
}

function validateCharterGraph(charter: PodCharter, context: z.RefinementCtx): void {
  const tasks = new Map<string, PodTask>();
  for (const task of charter.tasks) {
    if (tasks.has(task.taskId)) context.addIssue({ code: "custom", message: `duplicate pod task ${task.taskId}` });
    tasks.set(task.taskId, task);
  }
  for (const task of charter.tasks) {
    const dependencyKeys = task.dependencies.map((dependency) => `${dependency.milestoneId}:${dependency.taskId}`);
    if (new Set(dependencyKeys).size !== dependencyKeys.length) context.addIssue({ code: "custom", message: `pod task ${task.taskId} has duplicate DAG references` });
    for (const dependency of task.dependencies) {
      const target = tasks.get(dependency.taskId);
      if (target === undefined || target.milestoneId !== dependency.milestoneId) {
        context.addIssue({ code: "custom", message: `pod task ${task.taskId} has an unknown DAG reference` });
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): boolean => {
    if (visiting.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    visiting.add(taskId);
    for (const dependency of tasks.get(taskId)?.dependencies ?? []) if (visit(dependency.taskId)) return true;
    visiting.delete(taskId);
    visited.add(taskId);
    return false;
  };
  if (charter.tasks.some((task) => visit(task.taskId))) context.addIssue({ code: "custom", message: "pod task DAG contains a cycle" });
  const assigned = new Set<string>();
  for (const role of charter.roles) {
    for (const taskId of role.taskIds) {
      if (!tasks.has(taskId)) context.addIssue({ code: "custom", message: `role ${role.roleId} references unknown task ${taskId}` });
      if (assigned.has(taskId)) context.addIssue({ code: "custom", message: `task ${taskId} has multiple role assignments` });
      assigned.add(taskId);
    }
  }
  if (charter.tasks.some((task) => !assigned.has(task.taskId))) context.addIssue({ code: "custom", message: "every pod task requires one role assignment" });
  for (const checkpoint of charter.checkpoints) {
    if (checkpoint.afterTaskIds.some((taskId) => !tasks.has(taskId))) context.addIssue({ code: "custom", message: "checkpoint references unknown task" });
  }
}
