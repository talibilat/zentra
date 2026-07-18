import { createHash } from "node:crypto";
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";

import { z } from "zod";

import type { MilestoneBudget, MilestoneRole } from "../contracts/milestone.js";
import {
  admissionPacketDigest,
  digestCanonical,
  OpenCodeAdmissionPacketSchema,
  type OpenCodeAdmissionPacket,
} from "../contracts/authority-attention.js";
import type { TerminalOutcome } from "../contracts/task.js";
import type { EventJournal } from "../journal/journal.js";
import { projectMilestone } from "../milestones/milestone-projection.js";
import type { ModelBroker } from "../capsule/model-broker.js";
import type { ModelCapability, ModelSheet } from "../policy/model-sheet.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import { GovernedWebResearch, NodeHttpsResearchTransport, WebResearchPolicySchema, webResearchTerminalResult, type WebResearchResult } from "../research/web-research.js";
import { WebResearchRequestSchema } from "../research/web-research.js";
import { TaskService } from "../tasks/task-service.js";
import { capabilityTaskHead, createCapabilityBoundaryOccurrence } from "../contracts/capability-boundary.js";
import { MilestoneRegistry } from "../milestones/milestone-registry.js";
import type { RoleCapabilityDecision } from "../workers/role-capability-envelope.js";
import {
  OpenCodeMilestoneCompletedPayloadSchema,
  OpenCodeMilestoneRunningPayloadSchema,
  OpenCodeResourcesPreparedPayloadSchema,
  OpenCodeCleanupObservedPayloadSchema,
  OpenCodeResourceIntentPayloadSchema,
} from "./opencode-agent-events.js";
import { createReadOnlyRepositoryView } from "./read-only-repository-view.js";
import { openCodeResourceIdentity } from "./opencode-resource-identity.js";
import { WorkerLifecycleService, capabilityEnvelope } from "../workers/worker-lifecycle.js";
import { OpenCodeWorkerEventAdapter } from "./opencode-worker-event-adapter.js";
import {
  RoleCapabilityEnvelopeService,
  buildRoleCapabilityBinding,
  roleModelSupports,
  type RoleCapabilityBinding,
} from "../workers/role-capability-envelope.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const EvidenceSchema = z.strictObject({
  kind: z.enum(["plan", "research", "finding", "review"]),
  summary: z.string().min(1).max(256 * 1024),
  sourceEvidenceIds: z.array(DigestSchema).max(128).optional(),
});
const ModelMetadataSchema = z.strictObject({
  id: z.string().min(1).max(256),
  provider: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
});

export const OpenCodeReadOnlyCapsuleRequestSchema = z.strictObject({
  capsuleId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  taskId: z.string().min(1).max(256),
  repositoryPath: z.string().min(1).max(4_096),
  role: z.enum(["planner", "researcher", "reviewer"]),
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
  webResearch: WebResearchPolicySchema.nullable(),
  webResearchEnvelopeDigest: DigestSchema.nullable(),
  securityBoundary: z.strictObject({
    repository: z.literal("sanitized_read_only_bind_mount"),
    scratch: z.literal("bounded_ephemeral"),
    network: z.enum(["model_broker_only", "brokered_web_research"]),
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
    version: z.literal("1.18.3"),
    executableSha256: DigestSchema,
  }).nullable(),
  model: ModelMetadataSchema.nullable(),
  evidence: z.array(EvidenceSchema).max(128),
  cleanup: z.enum(["completed", "uncertain"]),
  brokerTransport: z.enum(["completed", "uncertain"]),
  usage: z.strictObject({
    seconds: z.number().nonnegative().max(86_400),
    inputTokens: z.number().int().nonnegative().max(2_000_000),
    outputTokens: z.number().int().nonnegative().max(2_000_000),
    costUsd: z.number().nonnegative().max(10_000),
    toolCalls: z.number().int().nonnegative().max(100_000),
    modelTurns: z.number().int().nonnegative().max(100_000).optional(),
  }).optional(),
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
  readonly execution: {
    readonly milestoneId: string;
    readonly taskId: string;
    readonly capsuleId: string;
    readonly actorId: string;
    readonly capabilityId: string;
    readonly transportModelId: string;
  };
}

export interface OpenCodeReadOnlyCapsule {
  execute(
    request: OpenCodeReadOnlyCapsuleRequest,
    broker: ModelBroker,
    signal: AbortSignal,
    observe?: (observation: OpenCodeCapsuleObservation) => void,
    research?: { execute(request: unknown, policy: unknown, signal: AbortSignal): Promise<WebResearchResult> },
  ): Promise<OpenCodeReadOnlyCapsuleResult>;
}

export type OpenCodeCapsuleObservation =
  | { readonly type: "resources_prepared"; readonly payload: Omit<z.infer<typeof OpenCodeResourcesPreparedPayloadSchema>, "taskId"> }
  | { readonly type: "cleanup_observed"; readonly payload: Omit<z.infer<typeof OpenCodeCleanupObservedPayloadSchema>, "taskId"> }
  | { readonly type: "model_started"; readonly modelId: string }
  | { readonly type: "model_completed"; readonly modelId: string; readonly outcome: "completed" | "cancelled" | "timed_out" | "failed"; readonly usage: { readonly seconds: number; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number; readonly toolCalls: number; readonly modelTurns: number } }
  | { readonly type: "research_started"; readonly requestId: string }
  | { readonly type: "research_completed"; readonly requestId: string; readonly result: WebResearchResult };

export interface OpenCodeReadOnlyAgentRequest {
  readonly milestoneId: string;
  readonly taskId: string;
  readonly repositoryPath: string;
  readonly role: "planner" | "researcher" | "reviewer";
  readonly rolePrompt: string;
  readonly budget: Omit<MilestoneBudget, "maxRetries">;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly admission: {
    readonly packet: OpenCodeAdmissionPacket;
    readonly digest: string;
  };
  readonly reviewEvidence?: {
    readonly workerId: string;
    readonly diffSha256: string;
    readonly validationSha256: string;
  };
}

export class OpenCodeReadOnlyAgent {
  constructor(
    private readonly journal: EventJournal,
    private readonly capsule: OpenCodeReadOnlyCapsule,
    private readonly broker: ModelBroker,
    private readonly models: ModelSheet,
    private readonly security?: SecuritySheet,
    private readonly research = new GovernedWebResearch(journal, new NodeHttpsResearchTransport()),
  ) {}

  async run(request: OpenCodeReadOnlyAgentRequest): Promise<OpenCodeReadOnlyAgentResult> {
    const events = this.journal.readStream(request.milestoneId);
    const milestone = projectMilestone(events);
    if (milestone === null || milestone.plan === null) throw new Error("OpenCode role requires a planned milestone");
    if (milestone.lifecycle === "paused") throw new Error("OpenCode role cannot run while the milestone is paused");
    const task = milestone.plan.tasks.find((candidate) => candidate.taskId === request.taskId);
    if (task === undefined) throw new Error("OpenCode role task is not in the milestone plan");
    assertAssignment(task.roleAssignment.role, task.roleAssignment.harness, task.roleAssignment.agentId, task.risk.authority, request);
    const model = approvedModel(this.models, task.roleAssignment.agentId, request.role, request.budget);
    if (milestone.tasks[request.taskId]?.status !== "ready") throw new Error("OpenCode role task must be ready");
    assertAdmission(
      request,
      milestone.tasks[request.taskId]?.admissionDigest ?? null,
      task.roleAssignment.agentId,
      task.risk.authority,
      model,
      digestCanonical(milestone.plan),
    );
    assertBudget(request, task.budget);
    const repositoryPath = canonicalDirectory(request.repositoryPath);
    const correlationId = events[0]!.correlationId;
    let roleBinding: RoleCapabilityBinding | null = null;
    if (this.security !== undefined) {
      roleBinding = buildRoleCapabilityBinding({
        milestoneId: request.milestoneId,
        taskId: request.taskId,
        projectId: milestone.projectId,
        correlationId,
        role: request.role,
        actorId: task.roleAssignment.agentId,
        repository: repositoryPath,
        planDigest: digestCanonical(milestone.plan),
        securityDigest: digestCanonical(this.security),
        model: {
          capabilityId: model.id,
          transportModelId: model.model,
          digest: digestCanonical(model),
          harness: model.harness,
          roles: model.roles,
          toolPermissions: model.toolPermissions,
          network: model.network,
        },
        budget: { ...request.budget, timeoutMs: request.timeoutMs },
        admissionDigest: request.admission.digest,
        configuredReadPaths: request.role === "reviewer" ? task.ownedPaths : this.security.allowedFileScopes,
        ownedPaths: task.ownedPaths,
        forbiddenPaths: [...new Set([...task.forbiddenPaths, ...this.security.forbiddenPaths])],
        ...(model.network === "declared" ? { webResearch: {
          allowedDestinations: this.security.network.allowedDestinations,
          timeoutMs: request.timeoutMs,
        } } : {}),
        ...(request.reviewEvidence === undefined ? {} : { review: request.reviewEvidence }),
      });
      new RoleCapabilityEnvelopeService(this.journal).accept(roleBinding);
    }
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
    const workerId = identity.capsuleId;
    const workers = new WorkerLifecycleService(this.journal);
    const capabilityTasks = new TaskService(this.journal);
    const workerEvents = new OpenCodeWorkerEventAdapter();
    workers.bind({
      schemaVersion: 1,
      workerId,
      taskId: request.taskId,
      rootTaskId: request.taskId,
      parentWorkerId: null,
      harness: "opencode",
      role: request.role,
      model: { capabilityId: model.id, modelId: model.model },
      envelope: roleBinding?.envelope ?? capabilityEnvelope({
        role: request.role,
        authority: task.risk.authority,
        capabilities: request.role === "reviewer" ? ["read_repository", "review_diff"] :
          model.network === "declared" ? ["read_repository", "web_research"] : ["read_repository"],
        network: model.network === "declared" ? "declared_web_research" : "model_provider_only",
        secrets: "none",
        effects: { worktree: "none", pathExpansion: "none", integration: "none", release: "none", external: "none" },
        resources: { repository: "read_only", paths: [...task.ownedPaths], forbiddenPaths: [...task.forbiddenPaths] },
      }),
      taskContext: { kind: "milestone", milestoneId: request.milestoneId },
      budget: {
        budgetId: `${request.milestoneId}/${request.taskId}`,
        ...request.budget,
        maxToolCalls: 10_000,
        maxModelTurns: 32,
        maxActiveWorkers: 1,
        maxConcurrentTools: 1,
        maxConcurrentModelTurns: 1,
      },
      trace: { traceId: correlationId, correlationId },
    });
    const intentPayload = OpenCodeResourceIntentPayloadSchema.parse({ taskId: request.taskId, ...identity });
    const currentEvents = this.journal.readStream(request.milestoneId);
    const currentMilestone = projectMilestone(currentEvents);
    if (currentMilestone?.lifecycle === "paused") throw new Error("OpenCode role cannot run while the milestone is paused");
    if (currentMilestone?.tasks[request.taskId]?.status !== "ready") throw new Error("OpenCode role task must remain ready");
    assertAdmission(
      request,
      currentMilestone.tasks[request.taskId]?.admissionDigest ?? null,
      task.roleAssignment.agentId,
      task.risk.authority,
      model,
      digestCanonical(currentMilestone.plan),
    );
    version = currentEvents.at(-1)!.streamVersion;
    version = this.journal.append(request.milestoneId, version, [{
      streamId: request.milestoneId, type: "milestone.agent_resource_intent", payload: intentPayload,
      causationId: null, correlationId,
    }]).at(-1)!.streamVersion;
    if (roleBinding !== null) {
      const rolePolicy = new RoleCapabilityEnvelopeService(this.journal);
      rolePolicy.verify(roleBinding, {
        planDigest: digestCanonical(currentMilestone.plan),
        securityDigest: digestCanonical(this.security!),
        modelDigest: digestCanonical(model),
        repositoryDigest: digestCanonical(repositoryPath),
        ownershipDigest: roleBinding.ownershipDigest,
        budgetDigest: digestCanonical({ ...request.budget, timeoutMs: request.timeoutMs }),
        admissionDigest: request.admission.digest,
      });
      if (request.role === "reviewer" && request.reviewEvidence !== undefined) {
        const decision = rolePolicy.evaluate(roleBinding, { kind: "review", ...request.reviewEvidence });
        if (decision.status !== "allowed") throw new Error(`review capability was not admitted: ${decision.reason}`);
      }
    }
    let view: ReturnType<typeof createReadOnlyRepositoryView>;
    try {
      view = createReadOnlyRepositoryView(
        repositoryPath,
        roleBinding === null ? task.ownedPaths : existingReadScopes(repositoryPath, roleBinding.access.readPaths),
        roleBinding?.access.forbiddenPaths ?? task.forbiddenPaths,
        identity.repositoryViewPath,
      );
    } catch (error) {
      workers.cleanup(request.taskId, workerId, "completed");
      workers.terminate(request.taskId, workerId, "failed");
      throw error;
    }
    const packet = OpenCodeReadOnlyCapsuleRequestSchema.parse({
      capsuleId: identity.capsuleId,
      taskId: request.taskId,
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
      webResearch: roleBinding?.webResearch ?? null,
      webResearchEnvelopeDigest: roleBinding?.webResearch === null || roleBinding === null ? null : roleBinding.envelope.digest,
      securityBoundary: {
        repository: "sanitized_read_only_bind_mount",
        scratch: "bounded_ephemeral",
        network: roleBinding?.webResearch === null || roleBinding === null ? "model_broker_only" : "brokered_web_research",
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
      workers.start(request.taskId, workerId);
    } catch (error) {
      rmSync(view.path, { recursive: true, force: true });
      const worker = workers.inspect(request.taskId).workers[workerId];
      if (worker?.status === "bound") {
        workers.cleanup(request.taskId, workerId, "completed");
        workers.terminate(request.taskId, workerId, "failed");
      }
      throw error;
    }

    const deadline = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([request.signal, deadline]);
    let capabilityAttention: RoleCapabilityDecision | null = null;
    const researchCapability = roleBinding === null ? undefined : {
      execute: async (rawResearchRequest: unknown, policy: unknown, researchSignal: AbortSignal): Promise<WebResearchResult> => {
        if (typeof rawResearchRequest !== "object" || rawResearchRequest === null || Array.isArray(rawResearchRequest)) throw new Error("invalid research capability request");
        const raw = rawResearchRequest as Readonly<Record<string, unknown>>;
        const destination = new URL(String(raw["url"]));
        destination.search = "";
        destination.hash = "";
        const decision = new RoleCapabilityEnvelopeService(this.journal).evaluate(roleBinding!, {
          kind: "network", destination: destination.href,
          method: raw["method"] === "GET" || raw["method"] === "HEAD" ? raw["method"] : "OTHER",
          capability: raw["tool"] === "zentra_web_research" ? "web_research" : "unknown",
        });
        if (decision.status !== "allowed") {
          capabilityAttention = decision;
          return webResearchTerminalResult(rawResearchRequest, "denied", "capability_attention");
        }
        const researchRequest = WebResearchRequestSchema.parse(rawResearchRequest);
        return this.research.execute(researchRequest, policy, researchSignal);
      },
    };
    let result: OpenCodeReadOnlyCapsuleResult | undefined;
    const observationState: { cleanup: Extract<OpenCodeCapsuleObservation, { type: "cleanup_observed" }> | null } = { cleanup: null };
    let repositoryViewAbsent = false;
    try {
      result = OpenCodeReadOnlyCapsuleResultSchema.parse(await this.capsule.execute(packet, this.broker, signal, (observation) => {
        if (observation.type === "cleanup_observed") {
          observationState.cleanup = observation;
          return;
        }
        if (observation.type === "research_started") {
          workers.observe(request.taskId, workerId, {
            kind: "tool", name: "zentra_web_research", phase: "started", outcome: null,
            usage: { seconds: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, modelTurns: 0 },
          });
          return;
        }
        if (observation.type === "research_completed") {
          workers.observe(request.taskId, workerId, {
            kind: "tool", name: "zentra_web_research", phase: "completed",
            outcome: observation.result.outcome === "uncertain" ? "failed" : observation.result.outcome,
            usage: { seconds: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 1, modelTurns: 0 },
          });
          return;
        }
        if (observation.type === "model_started") {
          workers.observe(request.taskId, workerId, {
            kind: "model", name: observation.modelId, phase: "started", outcome: null,
            usage: { seconds: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, modelTurns: 0 },
          });
          return;
        }
        if (observation.type === "model_completed") {
          workers.observe(request.taskId, workerId, {
            kind: "model", name: observation.modelId, phase: "completed",
            outcome: observation.outcome, usage: observation.usage,
          });
          return;
        }
        const type = "milestone.agent_resources_prepared";
        const payload = OpenCodeResourcesPreparedPayloadSchema.parse({ taskId: request.taskId, ...observation.payload });
        workers.observe(request.taskId, workerId, workerEvents.resourceObservation("read_only_capsule", "completed"));
        version = this.journal.append(request.milestoneId, version, [{
          streamId: request.milestoneId, type, payload, causationId: null, correlationId,
        }]).at(-1)!.streamVersion;
      }, researchCapability));
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
    workers.observe(request.taskId, workerId, workerEvents.processObservation("opencode", outcome));
    const uncertainWorker = result.cleanup === "uncertain" || result.brokerTransport === "uncertain";
    if (uncertainWorker) workers.uncertain(request.taskId, workerId, "OpenCode transport or cleanup is uncertain");
    workers.cleanup(request.taskId, workerId, result.cleanup);
    if (!uncertainWorker) workers.terminate(request.taskId, workerId, outcome);
    if (capabilityAttention !== null && !uncertainWorker) {
      const decision = capabilityAttention as RoleCapabilityDecision;
      const rolePolicy = new RoleCapabilityEnvelopeService(this.journal);
      if (capabilityTasks.readStream(request.taskId).length === 0) {
        capabilityTasks.create({ taskId: request.taskId, projectId: milestone.projectId, title: task.title, correlationId });
      }
      const occurrence = createCapabilityBoundaryOccurrence({
        binding: roleBinding!, decision,
        evaluationEvent: rolePolicy.evaluationEvent(roleBinding!, decision.decisionId),
        phase: "pre_effect", taskHead: capabilityTaskHead(capabilityTasks.readStream(request.taskId)),
      });
      new MilestoneRegistry(this.journal).pauseForCapabilityBoundary(request.milestoneId, occurrence, null);
      const trace = traceOutcome(this.journal);
      return Object.freeze({
        ...result, outcome: "failed", trace: Object.freeze({ outcome: trace }),
        execution: Object.freeze({ milestoneId: request.milestoneId, taskId: request.taskId, capsuleId: packet.capsuleId,
          actorId: packet.actorId, capabilityId: packet.capabilityId, transportModelId: packet.transportModelId }),
      });
    }
    if (uncertainWorker) {
      const trace = traceOutcome(this.journal);
      return Object.freeze({
        ...result, outcome, trace: Object.freeze({ outcome: trace }),
        execution: Object.freeze({
          milestoneId: request.milestoneId, taskId: request.taskId, capsuleId: packet.capsuleId,
          actorId: packet.actorId, capabilityId: packet.capabilityId, transportModelId: packet.transportModelId,
        }),
      });
    }
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
      execution: Object.freeze({
        milestoneId: request.milestoneId,
        taskId: request.taskId,
        capsuleId: packet.capsuleId,
        actorId: packet.actorId,
        capabilityId: packet.capabilityId,
        transportModelId: packet.transportModelId,
      }),
    });
  }
}

function assertAdmission(
  request: OpenCodeReadOnlyAgentRequest,
  durableDigest: string | null,
  actorId: string,
  authority: string,
  model: ModelCapability,
  planDigest: string,
): void {
  const packet = OpenCodeAdmissionPacketSchema.parse(request.admission.packet);
  const digest = admissionPacketDigest(packet);
  if (
    request.admission.digest !== digest ||
    durableDigest !== digest ||
    packet.milestoneId !== request.milestoneId ||
    packet.taskId !== request.taskId ||
    packet.repository !== request.repositoryPath ||
    packet.role !== request.role ||
    packet.actorId !== actorId ||
    packet.harness !== model.harness ||
    packet.capabilityId !== model.id ||
    packet.transportModelId !== model.model ||
    JSON.stringify(packet.roles) !== JSON.stringify([...new Set(model.roles)].sort()) ||
    JSON.stringify(packet.toolPermissions) !== JSON.stringify([...new Set(model.toolPermissions)].sort()) ||
    packet.network !== model.network ||
    packet.contextTokens !== model.contextTokens ||
    packet.requestedBudget.maxInputTokens + packet.requestedBudget.maxOutputTokens > packet.contextTokens ||
    packet.authority !== authority ||
    packet.planDigest !== planDigest ||
    packet.requestedBudget.maxSeconds !== request.budget.maxSeconds ||
    packet.requestedBudget.maxCostUsd !== request.budget.maxCostUsd ||
    packet.requestedBudget.maxInputTokens !== request.budget.maxInputTokens ||
    packet.requestedBudget.maxOutputTokens !== request.budget.maxOutputTokens ||
    packet.requestedBudget.timeoutMs !== request.timeoutMs
  ) throw new Error("OpenCode execution does not match durable task admission");
}

function objectString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function approvedModel(
  sheet: ModelSheet,
  assignedId: string,
  role: "planner" | "researcher" | "reviewer",
  budget: OpenCodeReadOnlyAgentRequest["budget"],
): ModelCapability {
  const model = sheet.models.find((candidate) => candidate.id === assignedId);
  if (
    model === undefined || !roleModelSupports(role, model) ||
    model.contextTokens < budget.maxInputTokens + budget.maxOutputTokens
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
    authority !== (request.role === "reviewer" ? "review" : "read_only")
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

function pathForScope(repository: string, scope: string): string {
  return `${repository}/${scope.endsWith("/**") ? scope.slice(0, -3) : scope}`;
}

function existingReadScopes(repository: string, scopes: readonly string[]): readonly string[] {
  const existing = scopes.filter((scope) => scope === "**" || existsSync(pathForScope(repository, scope)));
  return existing.length > 0 ? existing : scopes;
}
