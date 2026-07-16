import { createHash } from "node:crypto";
import { realpathSync, rmSync, statSync } from "node:fs";

import { z } from "zod";

import type { MilestoneBudget, MilestoneRole } from "../contracts/milestone.js";
import type { TerminalOutcome } from "../contracts/task.js";
import type { EventJournal } from "../journal/journal.js";
import { projectMilestone } from "../milestones/milestone-projection.js";
import type { ModelBroker } from "../capsule/model-broker.js";
import type { ModelCapability, ModelSheet } from "../policy/model-sheet.js";
import {
  OpenCodeMilestoneCompletedPayloadSchema,
  OpenCodeMilestoneRunningPayloadSchema,
  OpenCodeResourcesPreparedPayloadSchema,
  OpenCodeCleanupObservedPayloadSchema,
  OpenCodeResourceIntentPayloadSchema,
} from "./opencode-agent-events.js";
import { createReadOnlyRepositoryView } from "./read-only-repository-view.js";
import { openCodeResourceIdentity } from "./opencode-resource-identity.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const EvidenceSchema = z.strictObject({
  kind: z.enum(["plan", "research", "finding"]),
  summary: z.string().min(1).max(256 * 1024),
});
const ModelMetadataSchema = z.strictObject({
  id: z.string().min(1).max(256),
  provider: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
});

export const OpenCodeReadOnlyCapsuleRequestSchema = z.strictObject({
  capsuleId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  repositoryPath: z.string().min(1).max(4_096),
  role: z.enum(["planner", "researcher"]),
  actorId: z.string().min(1).max(256),
  rolePrompt: z.string().min(1).max(64 * 1024),
  capabilityId: z.string().min(1).max(256),
  transportModelId: z.string().min(1).max(256),
  resources: z.strictObject({
    resourceLabel: z.string().min(1).max(512),
    containerName: z.string().min(1).max(255),
    imageName: z.string().min(1).max(255),
  }),
  budget: z.strictObject({
    maxSeconds: z.number().int().positive().max(86_400),
    maxCostUsd: z.number().nonnegative().max(10_000),
    maxInputTokens: z.number().int().positive().max(2_000_000),
    maxOutputTokens: z.number().int().positive().max(2_000_000),
  }),
  timeoutMs: z.number().int().positive().max(86_400_000),
  securityBoundary: z.strictObject({
    repository: z.literal("sanitized_read_only_bind_mount"),
    scratch: z.literal("bounded_ephemeral"),
    network: z.literal("model_broker_only"),
    home: z.literal("ephemeral"),
    credentials: z.literal("none"),
    shell: z.literal("none"),
    readableScopes: z.array(z.string().min(1).max(4_096)).min(1).max(256),
    forbiddenPaths: z.array(z.string().min(1).max(4_096)).max(256),
    repositoryRevision: DigestSchema,
  }),
});

export const OpenCodeReadOnlyCapsuleResultSchema = z.strictObject({
  outcome: z.enum(["completed", "cancelled", "timed_out", "failed"]),
  openCode: z.strictObject({
    version: z.literal("1.18.1"),
    executableSha256: DigestSchema,
  }).nullable(),
  model: ModelMetadataSchema.nullable(),
  evidence: z.array(EvidenceSchema).max(128),
  cleanup: z.enum(["completed", "uncertain"]),
  brokerTransport: z.enum(["completed", "uncertain"]),
}).superRefine((result, context) => {
  if (result.outcome === "completed" && (
    result.cleanup !== "completed" || result.brokerTransport !== "completed" ||
    result.openCode === null || result.model === null || result.evidence.length === 0
  )) context.addIssue({ code: "custom", message: "completed OpenCode result lacks required evidence" });
});

export type OpenCodeReadOnlyCapsuleRequest = z.infer<typeof OpenCodeReadOnlyCapsuleRequestSchema>;
export type OpenCodeReadOnlyCapsuleResult = z.infer<typeof OpenCodeReadOnlyCapsuleResultSchema>;

export interface OpenCodeReadOnlyAgentResult extends OpenCodeReadOnlyCapsuleResult {
  readonly trace: { readonly outcome: "emitted" | "failed" | "not_configured" };
}

export interface OpenCodeReadOnlyCapsule {
  execute(
    request: OpenCodeReadOnlyCapsuleRequest,
    broker: ModelBroker,
    signal: AbortSignal,
    observe?: (observation: OpenCodeCapsuleObservation) => void,
  ): Promise<OpenCodeReadOnlyCapsuleResult>;
}

export type OpenCodeCapsuleObservation =
  | { readonly type: "resources_prepared"; readonly payload: Omit<z.infer<typeof OpenCodeResourcesPreparedPayloadSchema>, "taskId"> }
  | { readonly type: "cleanup_observed"; readonly payload: Omit<z.infer<typeof OpenCodeCleanupObservedPayloadSchema>, "taskId"> };

export interface OpenCodeReadOnlyAgentRequest {
  readonly milestoneId: string;
  readonly taskId: string;
  readonly repositoryPath: string;
  readonly role: "planner" | "researcher";
  readonly rolePrompt: string;
  readonly budget: Omit<MilestoneBudget, "maxRetries">;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export class OpenCodeReadOnlyAgent {
  constructor(
    private readonly journal: EventJournal,
    private readonly capsule: OpenCodeReadOnlyCapsule,
    private readonly broker: ModelBroker,
    private readonly models: ModelSheet,
  ) {}

  async run(request: OpenCodeReadOnlyAgentRequest): Promise<OpenCodeReadOnlyAgentResult> {
    const events = this.journal.readStream(request.milestoneId);
    const milestone = projectMilestone(events);
    if (milestone === null || milestone.plan === null) throw new Error("OpenCode role requires a planned milestone");
    const task = milestone.plan.tasks.find((candidate) => candidate.taskId === request.taskId);
    if (task === undefined) throw new Error("OpenCode role task is not in the milestone plan");
    assertAssignment(task.roleAssignment.role, task.roleAssignment.harness, task.roleAssignment.agentId, task.risk.authority, request);
    const model = approvedModel(this.models, task.roleAssignment.agentId, request.role, request.budget);
    if (milestone.tasks[request.taskId]?.status !== "ready") throw new Error("OpenCode role task must be ready");
    assertBudget(request, task.budget);
    const repositoryPath = canonicalDirectory(request.repositoryPath);
    const correlationId = events[0]!.correlationId;
    let version = events.at(-1)!.streamVersion;
    const resourceEvents = events.filter((event) => event.type === "milestone.agent_resource_intent" &&
      objectString(event.payload, "taskId") === request.taskId);
    const cleanedCapsules = new Set(events.filter((event) => event.type === "milestone.agent_cleanup_observed" &&
      objectString(event.payload, "taskId") === request.taskId && objectString(event.payload, "outcome") === "completed")
      .map((event) => objectString(event.payload, "capsuleId")).filter((value): value is string => value !== null));
    const pending = resourceEvents.find((event) => {
      const capsuleId = objectString(event.payload, "capsuleId");
      return capsuleId !== null && !cleanedCapsules.has(capsuleId);
    });
    if (pending !== undefined) throw new Error("OpenCode resource intent requires reconciliation before execution");
    const identity = openCodeResourceIdentity(request.milestoneId, request.taskId, resourceEvents.length + 1);
    const intentPayload = OpenCodeResourceIntentPayloadSchema.parse({ taskId: request.taskId, ...identity });
    version = this.journal.append(request.milestoneId, version, [{
      streamId: request.milestoneId, type: "milestone.agent_resource_intent", payload: intentPayload,
      causationId: null, correlationId,
    }]).at(-1)!.streamVersion;
    const view = createReadOnlyRepositoryView(
      repositoryPath, task.ownedPaths, task.forbiddenPaths, identity.repositoryViewPath,
    );
    const packet = OpenCodeReadOnlyCapsuleRequestSchema.parse({
      capsuleId: identity.capsuleId,
      repositoryPath: view.path,
      role: request.role,
      actorId: task.roleAssignment.agentId,
      rolePrompt: request.rolePrompt,
      capabilityId: model.id,
      transportModelId: model.model,
      resources: {
        resourceLabel: identity.resourceLabel,
        containerName: identity.containerName,
        imageName: identity.imageName,
      },
      budget: request.budget,
      timeoutMs: request.timeoutMs,
      securityBoundary: {
        repository: "sanitized_read_only_bind_mount",
        scratch: "bounded_ephemeral",
        network: "model_broker_only",
        home: "ephemeral",
        credentials: "none",
        shell: "none",
        readableScopes: view.readableScopes,
        forbiddenPaths: view.forbiddenPaths,
        repositoryRevision: view.revision,
      },
    });
    const runningPayload = OpenCodeMilestoneRunningPayloadSchema.parse({
      taskId: request.taskId,
      capsuleId: packet.capsuleId,
      actorId: packet.actorId,
      role: packet.role,
      harness: "opencode",
      requestedModel: { capabilityId: packet.capabilityId, transportModelId: packet.transportModelId },
      budget: packet.budget,
      timeoutMs: packet.timeoutMs,
      securityBoundary: packet.securityBoundary,
    });
    try {
      version = this.journal.append(request.milestoneId, version, [{
        streamId: request.milestoneId,
        type: "milestone.task_running",
        payload: runningPayload,
        causationId: null,
        correlationId,
      }]).at(-1)!.streamVersion;
    } catch (error) {
      rmSync(view.path, { recursive: true, force: true });
      throw error;
    }

    const deadline = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([request.signal, deadline]);
    let result: OpenCodeReadOnlyCapsuleResult | undefined;
    const observationState: { cleanup: Extract<OpenCodeCapsuleObservation, { type: "cleanup_observed" }> | null } = { cleanup: null };
    let repositoryViewAbsent = false;
    try {
      result = OpenCodeReadOnlyCapsuleResultSchema.parse(await this.capsule.execute(packet, this.broker, signal, (observation) => {
        if (observation.type === "cleanup_observed") {
          observationState.cleanup = observation;
          return;
        }
        const type = "milestone.agent_resources_prepared";
        const payload = OpenCodeResourcesPreparedPayloadSchema.parse({ taskId: request.taskId, ...observation.payload });
        version = this.journal.append(request.milestoneId, version, [{
          streamId: request.milestoneId, type, payload, causationId: null, correlationId,
        }]).at(-1)!.streamVersion;
      }));
      if (deadline.aborted && result.outcome === "cancelled") {
        result = Object.freeze({ ...result, outcome: "timed_out" });
      }
    } catch {
      result = {
        outcome: deadline.aborted ? "timed_out" : request.signal.aborted ? "cancelled" : "failed",
        openCode: null,
        model: null,
        evidence: [],
        cleanup: "uncertain",
        brokerTransport: "completed",
      };
    } finally {
      try {
        rmSync(view.path, { recursive: true, force: true });
        repositoryViewAbsent = true;
      } catch {
        if (result !== undefined) result = { ...result, cleanup: "uncertain" };
      }
    }
    if (result === undefined) throw new Error("OpenCode capsule produced no result");
    if (!repositoryViewAbsent) result = { ...result, cleanup: "uncertain" };
    if (observationState.cleanup !== null) {
      const cleanupPayload = OpenCodeCleanupObservedPayloadSchema.parse({
        taskId: request.taskId,
        ...observationState.cleanup.payload,
        outcome: observationState.cleanup.payload.outcome === "completed" && repositoryViewAbsent ? "completed" : "uncertain",
        repositoryViewAbsent,
      });
      version = this.journal.append(request.milestoneId, version, [{
        streamId: request.milestoneId, type: "milestone.agent_cleanup_observed",
        payload: cleanupPayload, causationId: null, correlationId,
      }]).at(-1)!.streamVersion;
    } else {
      result = { ...result, cleanup: "uncertain" };
      const cleanupPayload = OpenCodeCleanupObservedPayloadSchema.parse({
        taskId: request.taskId,
        capsuleId: identity.capsuleId,
        resourceLabel: identity.resourceLabel,
        containerName: identity.containerName,
        containerId: null,
        imageName: identity.imageName,
        imageId: null,
        repositoryViewPath: identity.repositoryViewPath,
        repositoryRevision: view.revision,
        outcome: "uncertain",
        containerAbsent: false,
        imageAbsent: false,
        repositoryViewAbsent,
      });
      version = this.journal.append(request.milestoneId, version, [{
        streamId: request.milestoneId, type: "milestone.agent_cleanup_observed",
        payload: cleanupPayload, causationId: null, correlationId,
      }]).at(-1)!.streamVersion;
    }
    const outcome: TerminalOutcome = result.cleanup === "uncertain" && result.outcome === "completed"
      ? "failed"
      : result.outcome;
    const evidence = result.evidence.map((item) => Object.freeze({
      ...item,
      sha256: createHash("sha256").update(item.summary, "utf8").digest("hex"),
      provenance: Object.freeze({
        harness: "opencode" as const,
        capabilityId: packet.capabilityId,
        transportModelId: result.model?.id ?? packet.transportModelId,
        repositoryRevision: view.revision,
      }),
    }));
    const completedPayload = OpenCodeMilestoneCompletedPayloadSchema.parse({
      taskId: request.taskId,
      capsuleId: packet.capsuleId,
      outcome,
      actorId: packet.actorId,
      role: packet.role,
      harness: "opencode",
      capabilityId: packet.capabilityId,
      transportModelId: packet.transportModelId,
      measuredHarness: result.openCode,
      model: result.model,
      evidence,
      cleanup: result.cleanup,
      brokerTransport: result.brokerTransport,
    });
    this.journal.append(request.milestoneId, version, [{
      streamId: request.milestoneId,
      type: "milestone.task_completed",
      payload: completedPayload,
      causationId: null,
      correlationId,
    }]);
    const trace = traceOutcome(this.journal);
    return Object.freeze({
      ...result,
      outcome,
      trace: Object.freeze({ outcome: trace }),
    });
  }
}

function objectString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function approvedModel(
  sheet: ModelSheet,
  assignedId: string,
  role: "planner" | "researcher",
  budget: OpenCodeReadOnlyAgentRequest["budget"],
): ModelCapability {
  const model = sheet.models.find((candidate) => candidate.id === assignedId);
  if (
    model === undefined || model.harness !== "opencode" || !model.roles.includes(role) ||
    !model.toolPermissions.includes("read_repository") ||
    model.toolPermissions.some((permission) => permission !== "read_repository") ||
    model.network !== "denied" || model.contextTokens < budget.maxInputTokens + budget.maxOutputTokens
  ) throw new Error("OpenCode model assignment is not approved for the read-only role");
  return model;
}

function traceOutcome(journal: EventJournal): "emitted" | "failed" | "not_configured" {
  if (!("projectionFailed" in journal)) return "not_configured";
  return (journal as EventJournal & { readonly projectionFailed: boolean }).projectionFailed ? "failed" : "emitted";
}

function assertAssignment(
  assignedRole: MilestoneRole,
  harness: string,
  actorId: string,
  authority: string,
  request: OpenCodeReadOnlyAgentRequest,
): void {
  if (
    assignedRole !== request.role ||
    harness !== "opencode" ||
    actorId.length === 0 ||
    authority !== "read_only"
  ) throw new Error("OpenCode role assignment is outside read-only authority");
}

function assertBudget(request: OpenCodeReadOnlyAgentRequest, approved: MilestoneBudget): void {
  if (
    request.budget.maxSeconds > approved.maxSeconds ||
    request.budget.maxCostUsd > approved.maxCostUsd ||
    request.budget.maxInputTokens > approved.maxInputTokens ||
    request.budget.maxOutputTokens > approved.maxOutputTokens ||
    request.timeoutMs > approved.maxSeconds * 1_000
  ) throw new Error("OpenCode role budget exceeds the milestone plan");
}

function canonicalDirectory(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  if (canonical !== candidate || !statSync(canonical).isDirectory()) {
    throw new Error("OpenCode repository must be a canonical directory");
  }
  return canonical;
}
