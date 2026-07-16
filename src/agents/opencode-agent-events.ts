import { z } from "zod";
import { createHash } from "node:crypto";

import { TerminalOutcomeSchema } from "../contracts/task.js";

const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ScopeSchema = z.string().min(1).max(4_096);
const BudgetSchema = z.strictObject({
  maxSeconds: z.number().int().positive().max(86_400),
  maxCostUsd: z.number().nonnegative().max(10_000),
  maxInputTokens: z.number().int().positive().max(2_000_000),
  maxOutputTokens: z.number().int().positive().max(2_000_000),
});
const BoundarySchema = z.strictObject({
  repository: z.literal("sanitized_read_only_bind_mount"),
  scratch: z.literal("bounded_ephemeral"),
  network: z.literal("model_broker_only"),
  home: z.literal("ephemeral"),
  credentials: z.literal("none"),
  shell: z.literal("none"),
  readableScopes: z.array(ScopeSchema).min(1).max(256),
  forbiddenPaths: z.array(ScopeSchema).max(256),
  repositoryRevision: DigestSchema,
});

export const OpenCodeMilestoneRunningPayloadSchema = z.strictObject({
  taskId: IdSchema,
  capsuleId: IdSchema,
  actorId: IdSchema,
  role: z.enum(["planner", "researcher", "reviewer"]),
  harness: z.literal("opencode"),
  requestedModel: z.strictObject({ capabilityId: IdSchema, transportModelId: IdSchema }),
  budget: BudgetSchema,
  timeoutMs: z.number().int().positive().max(86_400_000),
  securityBoundary: BoundarySchema,
});

const HarnessMetadataSchema = z.strictObject({
  version: z.literal("1.18.1"),
  executableSha256: DigestSchema,
});
const ModelMetadataSchema = z.strictObject({
  id: IdSchema,
  provider: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  name: z.string().min(1).max(256),
});
const EvidenceSchema = z.strictObject({
  kind: z.enum(["plan", "research", "finding", "review"]),
  summary: z.string().min(1).max(256 * 1024),
  sha256: DigestSchema,
  provenance: z.strictObject({
    harness: z.literal("opencode"),
    capabilityId: IdSchema,
    transportModelId: IdSchema,
    repositoryRevision: DigestSchema,
  }),
});

export const OpenCodeMilestoneCompletedPayloadSchema = z.strictObject({
  taskId: IdSchema,
  capsuleId: IdSchema,
  outcome: TerminalOutcomeSchema.exclude(["denied"]),
  actorId: IdSchema,
  role: z.enum(["planner", "researcher", "reviewer"]),
  harness: z.literal("opencode"),
  capabilityId: IdSchema,
  transportModelId: IdSchema,
  measuredHarness: HarnessMetadataSchema.nullable(),
  model: ModelMetadataSchema.nullable(),
  evidence: z.array(EvidenceSchema).max(128),
  cleanup: z.enum(["completed", "uncertain"]),
  brokerTransport: z.enum(["completed", "uncertain"]),
}).superRefine((payload, context) => {
  if (payload.outcome === "completed" && (
    payload.cleanup !== "completed" || payload.brokerTransport !== "completed" ||
    payload.measuredHarness === null || payload.model === null || payload.evidence.length === 0
  )) context.addIssue({ code: "custom", message: "completed OpenCode event lacks required evidence" });
  for (const evidence of payload.evidence) {
    const digest = createHash("sha256").update(evidence.summary, "utf8").digest("hex");
    if (digest !== evidence.sha256 || evidence.provenance.capabilityId !== payload.capabilityId ||
      evidence.provenance.transportModelId !== payload.transportModelId ||
      (payload.model !== null && evidence.provenance.transportModelId !== payload.model.id)) {
      context.addIssue({ code: "custom", message: "OpenCode evidence provenance is invalid" });
    }
  }
  if (payload.model !== null && payload.model.id !== payload.transportModelId) {
    context.addIssue({ code: "custom", message: "OpenCode model identity is invalid" });
  }
});

export const OpenCodeTraceObservedPayloadSchema = z.strictObject({
  taskId: IdSchema,
  outcome: z.enum(["emitted", "failed"]),
});

export const OpenCodeResourceIntentPayloadSchema = z.strictObject({
  taskId: IdSchema,
  capsuleId: IdSchema,
  resourceLabel: z.string().min(1).max(512),
  containerName: z.string().min(1).max(255),
  imageName: z.string().min(1).max(255),
  repositoryViewPath: z.string().min(1).max(4_096),
});

export const OpenCodeResourcesPreparedPayloadSchema = z.strictObject({
  taskId: IdSchema,
  capsuleId: IdSchema,
  resourceLabel: z.string().min(1).max(512),
  containerName: z.string().min(1).max(255),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  imageName: z.string().min(1).max(255),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  repositoryViewPath: z.string().min(1).max(4_096),
  repositoryRevision: DigestSchema,
});

export const OpenCodeCleanupObservedPayloadSchema = z.strictObject({
  taskId: IdSchema,
  capsuleId: IdSchema,
  resourceLabel: z.string().min(1).max(512),
  containerName: z.string().min(1).max(255),
  containerId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  imageName: z.string().min(1).max(255),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  repositoryViewPath: z.string().min(1).max(4_096),
  repositoryRevision: DigestSchema.nullable(),
  outcome: z.enum(["completed", "uncertain"]),
  containerAbsent: z.boolean(),
  imageAbsent: z.boolean(),
  repositoryViewAbsent: z.boolean(),
});

export function parseOpenCodeMilestonePayload(type: string, payload: unknown): unknown {
  const schema = type === "milestone.task_running" ? OpenCodeMilestoneRunningPayloadSchema :
    type === "milestone.task_completed" ? OpenCodeMilestoneCompletedPayloadSchema : null;
  if (schema === null) throw new Error("unsupported OpenCode milestone event type");
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error("invalid OpenCode milestone event payload");
  return parsed.data;
}
