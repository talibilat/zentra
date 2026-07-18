import type { EventJournal } from "../journal/journal.js";
import { ProjectingEventJournal } from "../journal/projecting-journal.js";
import type { AgentTailJsonlFileSink } from "../observability/agent-tail-file-sink.js";
import type { ModelSheet } from "../policy/model-sheet.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { AuthorityAttention } from "../contracts/authority-attention.js";
import { OpenCodeTaskAdmissionContextSchema } from "../contracts/authority-attention.js";
import { MilestoneRegistry } from "../milestones/milestone-registry.js";
import { projectMilestone } from "../milestones/milestone-projection.js";
import { DockerOpenCodeReadOnlyCapsule } from "../capsule/opencode-read-only-capsule.js";
import type { ModelBroker } from "../capsule/model-broker.js";
import {
  OpenCodeReadOnlyAgent,
  type OpenCodeReadOnlyAgentRequest,
  type OpenCodeReadOnlyAgentResult,
  type OpenCodeReadOnlyCapsule,
} from "./opencode-read-only-agent.js";
import {
  OpenCodeCleanupObservedPayloadSchema,
  OpenCodeResourceIntentPayloadSchema,
  OpenCodeResourcesPreparedPayloadSchema,
  OpenCodeTraceObservedPayloadSchema,
} from "./opencode-agent-events.js";
import { projectWorkerLifecycle, WorkerLifecycleService, workerStreamId } from "../workers/worker-lifecycle.js";
import { RoleCapabilityEnvelopeService, parseRoleCapabilityEventPayload, type RoleCapabilityBinding, type RoleCapabilityDecision } from "../workers/role-capability-envelope.js";
import { capabilityTaskHead, createCapabilityBoundaryOccurrence } from "../contracts/capability-boundary.js";
import { TaskService } from "../tasks/task-service.js";
import type { StoredEvent } from "../contracts/event.js";

export interface OpenCodeReadOnlyExecutedResult extends OpenCodeReadOnlyAgentResult {
  readonly status: "executed";
  readonly operationOutcome: "completed" | "failed";
}

export interface OpenCodeReadOnlyPausedResult {
  readonly status: "paused";
  readonly operationOutcome: "paused";
  readonly attention: AuthorityAttention;
  readonly trace: { readonly outcome: "emitted" | "failed" };
}

export type OpenCodeReadOnlyProgramResult = OpenCodeReadOnlyExecutedResult | OpenCodeReadOnlyPausedResult;
export type OpenCodeReadOnlyProgramRequest = Omit<OpenCodeReadOnlyAgentRequest, "admission">;

export class OpenCodeReadOnlyProgram {
  private readonly projected: ProjectingEventJournal;
  private readonly agent: OpenCodeReadOnlyAgent;

  constructor(
    private readonly journal: EventJournal,
    agentTailSink: AgentTailJsonlFileSink,
    broker: ModelBroker,
    private readonly models: ModelSheet,
    private readonly security: SecuritySheet,
    private readonly capsule: OpenCodeReadOnlyCapsule = new DockerOpenCodeReadOnlyCapsule(),
  ) {
    this.projected = journal instanceof ProjectingEventJournal
      ? journal
      : new ProjectingEventJournal(journal, agentTailSink);
    this.agent = new OpenCodeReadOnlyAgent(this.projected, capsule, broker, models, security);
  }

  async reconcile(request: {
    readonly milestoneId: string;
    readonly taskId: string;
    readonly capsuleId?: string;
  }): Promise<{ readonly outcome: "completed" | "uncertain"; readonly trace: "emitted" | "failed" }> {
    const events = this.journal.readStream(request.milestoneId);
    if (events.length === 0) throw new Error("OpenCode milestone does not exist");
    const pendingAttention = findPendingResearchAttention(this.journal, request.milestoneId, request.taskId);
    if (projectMilestone(events)?.lifecycle === "paused") return Object.freeze({ outcome: "completed", trace: this.projected.projectionFailed ? "failed" : "emitted" });
    const cleanups = new Map<string, "completed" | "uncertain">();
    for (const event of events.filter((candidate) => candidate.type === "milestone.agent_cleanup_observed")) {
      const cleanup = OpenCodeCleanupObservedPayloadSchema.parse(event.payload);
      cleanups.set(cleanup.capsuleId, cleanup.outcome);
    }
    const intents = events.filter((event) => event.type === "milestone.agent_resource_intent")
      .map((event) => OpenCodeResourceIntentPayloadSchema.parse(event.payload))
      .filter((intent) => intent.taskId === request.taskId && cleanups.get(intent.capsuleId) !== "completed");
    const intent = request.capsuleId === undefined
      ? intents.at(-1)
      : intents.find((candidate) => candidate.capsuleId === request.capsuleId);
    if (intent === undefined) {
      const completedCleanup = events.some((event) => event.type === "milestone.agent_cleanup_observed" &&
        OpenCodeCleanupObservedPayloadSchema.parse(event.payload).taskId === request.taskId &&
        OpenCodeCleanupObservedPayloadSchema.parse(event.payload).outcome === "completed");
      if (pendingAttention === null || !completedCleanup) throw new Error("OpenCode task has no unreconciled resource intent");
      recoverResearchAttention(this.projected, request.milestoneId, request.taskId, pendingAttention);
      return Object.freeze({ outcome: "completed", trace: this.projected.projectionFailed ? "failed" : "emitted" });
    }
    const preparedEvent = events.find((event) => event.type === "milestone.agent_resources_prepared" &&
      OpenCodeResourcesPreparedPayloadSchema.parse(event.payload).capsuleId === intent.capsuleId);
    const prepared = preparedEvent === undefined ? null : OpenCodeResourcesPreparedPayloadSchema.parse(preparedEvent.payload);
    if (!("reconcile" in this.capsule) || typeof this.capsule.reconcile !== "function") {
      throw new Error("configured OpenCode capsule does not support reconciliation");
    }
    const reconciled = await (this.capsule.reconcile as DockerOpenCodeReadOnlyCapsule["reconcile"])({
      capsuleId: intent.capsuleId,
      resourceLabel: intent.resourceLabel,
      containerName: intent.containerName,
      containerId: prepared?.containerId ?? null,
      imageName: intent.imageName,
      imageId: prepared?.imageId ?? null,
      repositoryViewPath: intent.repositoryViewPath,
      repositoryRevision: prepared?.repositoryRevision ?? null,
    });
    const payload = OpenCodeCleanupObservedPayloadSchema.parse({
      ...intent,
      containerId: reconciled.containerId,
      imageId: reconciled.imageId,
      repositoryRevision: prepared?.repositoryRevision ?? null,
      outcome: reconciled.outcome,
      containerAbsent: reconciled.containerAbsent,
      imageAbsent: reconciled.imageAbsent,
      repositoryViewAbsent: reconciled.repositoryViewAbsent,
    });
    this.projected.append(request.milestoneId, events.at(-1)!.streamVersion, [{
      streamId: request.milestoneId,
      type: "milestone.agent_cleanup_observed",
      payload,
      causationId: null,
      correlationId: events[0]!.correlationId,
    }]);
    if (reconciled.outcome === "completed" && pendingAttention !== null) {
      recoverResearchAttention(this.projected, request.milestoneId, request.taskId, pendingAttention);
    }
    return Object.freeze({
      outcome: reconciled.outcome,
      trace: this.projected.projectionFailed ? "failed" : "emitted",
    });
  }

  async run(request: OpenCodeReadOnlyProgramRequest): Promise<OpenCodeReadOnlyProgramResult> {
    const eventsBeforeAdmission = this.journal.readStream(request.milestoneId);
    const retainedWorkers = Object.values(projectWorkerLifecycle(
      this.journal.readStream(workerStreamId(request.taskId)),
    ).workers).filter((worker) => worker.taskId === request.taskId);
    if (retainedWorkers.length !== 0) {
      const states = [...new Set(retainedWorkers.map((worker) => worker.status))].sort().join(",");
      throw new Error(`OpenCode task has retained durable worker state (${states}); redispatch requires an explicit effect reconciliation contract`);
    }
    const planned = projectMilestone(eventsBeforeAdmission)?.plan?.tasks.find((task) => task.taskId === request.taskId);
    const capability = planned === undefined
      ? undefined
      : this.models.models.find((model) => model.id === planned.roleAssignment.agentId);
    const context = OpenCodeTaskAdmissionContextSchema.parse({
      kind: "opencode" as const,
      repositoryPath: request.repositoryPath,
      actorId: planned?.roleAssignment.agentId ?? "unassigned",
      harness: capability?.harness ?? "opencode",
      role: request.role,
      capabilityId: planned?.roleAssignment.agentId ?? "unassigned",
      transportModelId: capability?.model ?? "unavailable",
      authority: planned?.risk.authority ?? "read_only",
      roles: [...(capability?.roles ?? [request.role])],
      toolPermissions: [...(capability?.toolPermissions ?? [])],
      network: capability?.network === "declared" ? "declared" as const : "denied" as const,
      contextTokens: capability?.contextTokens ?? 1,
      requestedBudget: { ...request.budget, timeoutMs: request.timeoutMs },
    });
    const registry = new MilestoneRegistry(this.projected);
    const preview = registry.previewTaskAdmission(
      request.milestoneId,
      request.taskId,
      this.security,
      context,
      this.models,
    );
    if (preview.status === "paused") {
      return Object.freeze({
        status: "paused",
        operationOutcome: "paused",
        attention: preview.attention,
        trace: Object.freeze({ outcome: this.projected.projectionFailed ? "failed" : "emitted" }),
      });
    }
    const admission = registry.admitTask(
      request.milestoneId, request.taskId, this.security, context, this.models,
    );
    if (admission.status === "paused") throw new Error("OpenCode admission changed after pure validation");
    const result = await this.agent.run({
      ...request,
      repositoryPath: admission.admission.packet.repository,
      admission: admission.admission,
    });
    const postRunWorkers = Object.values(projectWorkerLifecycle(
      this.journal.readStream(workerStreamId(request.taskId)),
    ).workers).filter((worker) => worker.taskId === request.taskId);
    if (postRunWorkers.some((worker) => worker.status === "uncertain")) {
      return Object.freeze({
        status: "executed",
        ...result,
        operationOutcome: "failed",
      });
    }
    const observedTraceOutcome = this.projected.projectionFailed ? "failed" : "emitted";
    const events = this.journal.readStream(request.milestoneId);
    const correlationId = events[0]?.correlationId;
    if (correlationId === undefined) throw new Error("OpenCode milestone stream disappeared before trace observation");
    this.projected.append(request.milestoneId, events.at(-1)!.streamVersion, [{
      streamId: request.milestoneId,
      type: "milestone.agent_trace_observed",
      payload: OpenCodeTraceObservedPayloadSchema.parse({ taskId: request.taskId, outcome: observedTraceOutcome }),
      causationId: null,
      correlationId,
    }]);
    if (observedTraceOutcome === "emitted" && this.projected.projectionFailed) {
      const corrected = this.journal.readStream(request.milestoneId);
      this.projected.append(request.milestoneId, corrected.at(-1)!.streamVersion, [{
        streamId: request.milestoneId,
        type: "milestone.agent_trace_observed",
        payload: OpenCodeTraceObservedPayloadSchema.parse({ taskId: request.taskId, outcome: "failed" }),
        causationId: corrected.at(-1)!.eventId,
        correlationId,
      }]);
    }
    const traceOutcome = this.projected.projectionFailed ? "failed" : "emitted";
    return Object.freeze({
      status: "executed",
      ...result,
      trace: Object.freeze({ outcome: traceOutcome }),
      operationOutcome: result.outcome === "completed" && traceOutcome === "emitted" ? "completed" : "failed",
    });
  }
}

interface PendingResearchAttention {
  readonly binding: RoleCapabilityBinding;
  readonly decision: RoleCapabilityDecision;
  readonly evaluationEvent: StoredEvent;
}

function findPendingResearchAttention(journal: EventJournal, milestoneId: string, taskId: string): PendingResearchAttention | null {
  const pauses = new Set(journal.readStream(milestoneId).filter((event) => event.type === "milestone.capability_boundary_paused")
    .map((event) => typeof event.payload === "object" && event.payload !== null
      ? (event.payload as { occurrence?: { decisionId?: string } }).occurrence?.decisionId : undefined).filter((value): value is string => value !== undefined));
  for (const acceptedEvent of journal.readAll().filter((event) => event.type === "capability_envelope.accepted")) {
    const accepted = parseRoleCapabilityEventPayload(acceptedEvent.type, acceptedEvent.payload) as { readonly binding: RoleCapabilityBinding };
    if (accepted.binding.milestoneId !== milestoneId || accepted.binding.taskId !== taskId) continue;
    new RoleCapabilityEnvelopeService(journal).inspect(accepted.binding);
    const evaluations = journal.readStream(acceptedEvent.streamId).filter((event) => event.type === "capability_envelope.evaluated");
    for (const evaluationEvent of [...evaluations].reverse()) {
      const evaluation = parseRoleCapabilityEventPayload(evaluationEvent.type, evaluationEvent.payload) as { readonly request: { readonly kind: string }; readonly decision: RoleCapabilityDecision };
      if (evaluation.request.kind === "network" && evaluation.decision.status !== "allowed" && !pauses.has(evaluation.decision.decisionId)) {
        return { binding: accepted.binding, decision: evaluation.decision, evaluationEvent };
      }
    }
  }
  return null;
}

function recoverResearchAttention(
  journal: EventJournal,
  milestoneId: string,
  taskId: string,
  pending: PendingResearchAttention,
): void {
  const workers = new WorkerLifecycleService(journal);
  const lifecycle = workers.inspect(taskId);
  for (const retained of Object.values(lifecycle.workers)) {
    if (retained.taskId !== taskId || retained.status === "terminal") continue;
    if (retained.activeModelTurns !== 0) throw new Error("research attention recovery has an unresolved model turn");
    let current = retained;
    while (current.activeTools > 0) {
      current = workers.observe(taskId, current.workerId, {
        kind: "tool", name: "zentra_web_research", phase: "completed", outcome: "denied",
        usage: { seconds: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 1, modelTurns: 0 },
      });
    }
    if (current.status === "running" || current.status === "bound") current = workers.cleanup(taskId, current.workerId, "completed");
    if (current.status === "cleaned") workers.terminate(taskId, current.workerId, "denied");
  }
  const milestone = projectMilestone(journal.readStream(milestoneId));
  const planned = milestone?.plan?.tasks.find((task) => task.taskId === taskId);
  if (milestone === null || planned === undefined) throw new Error("research attention recovery lacks its planned task");
  const tasks = new TaskService(journal);
  if (tasks.readStream(taskId).length === 0) {
    tasks.create({ taskId, projectId: milestone.projectId, title: planned.title, correlationId: journal.readStream(milestoneId)[0]!.correlationId });
  }
  const occurrence = createCapabilityBoundaryOccurrence({
    binding: pending.binding, decision: pending.decision, evaluationEvent: pending.evaluationEvent,
    phase: "pre_effect", taskHead: capabilityTaskHead(tasks.readStream(taskId)),
  });
  new MilestoneRegistry(journal).pauseForCapabilityBoundary(milestoneId, occurrence, null);
}
