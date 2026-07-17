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
    this.agent = new OpenCodeReadOnlyAgent(this.projected, capsule, broker, models);
  }

  async reconcile(request: {
    readonly milestoneId: string;
    readonly taskId: string;
    readonly capsuleId?: string;
  }): Promise<{ readonly outcome: "completed" | "uncertain"; readonly trace: "emitted" | "failed" }> {
    const events = this.journal.readStream(request.milestoneId);
    if (events.length === 0) throw new Error("OpenCode milestone does not exist");
    if (projectMilestone(events)?.lifecycle === "paused") {
      throw new Error("OpenCode reconciliation cannot run while the milestone is paused");
    }
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
    if (intent === undefined) throw new Error("OpenCode task has no unreconciled resource intent");
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
    return Object.freeze({
      outcome: reconciled.outcome,
      trace: this.projected.projectionFailed ? "failed" : "emitted",
    });
  }

  async run(request: OpenCodeReadOnlyProgramRequest): Promise<OpenCodeReadOnlyProgramResult> {
    const eventsBeforeAdmission = this.journal.readStream(request.milestoneId);
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
    const admission = new MilestoneRegistry(this.projected).admitTask(
      request.milestoneId,
      request.taskId,
      this.security,
      context,
      this.models,
    );
    if (admission.status === "paused") {
      return Object.freeze({
        status: "paused",
        operationOutcome: "paused",
        attention: admission.attention,
        trace: Object.freeze({ outcome: this.projected.projectionFailed ? "failed" : "emitted" }),
      });
    }
    const result = await this.agent.run({
      ...request,
      repositoryPath: admission.admission.packet.repository,
      admission: admission.admission,
    });
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
