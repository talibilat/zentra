import type { StoredEvent } from "../contracts/event.js";
import {
  MilestonePlanSchema,
  MilestoneCompletedPayloadSchema,
  WriterBatchStartedPayloadSchema,
  WriterIntegrationCompletedPayloadSchema,
  WriterTerminalReleasedPayloadSchema,
  StopAndAskStateSchema,
  type MilestoneLifecycleState,
  type MilestonePlan,
  type StopAndAskState,
} from "../contracts/milestone.js";
import { logicalPathSetsOverlap } from "./path-ownership.js";
import {
  digestCanonical,
  MilestonePausedPayloadSchema,
  PlanReplacementPayloadSchema,
  TaskReadyPayloadSchema,
  type AuthorityAttention,
} from "../contracts/authority-attention.js";
import { TerminalOutcomeSchema, type TerminalOutcome } from "../contracts/task.js";
import {
  OpenCodeCleanupObservedPayloadSchema,
  OpenCodeMilestoneCompletedPayloadSchema,
  OpenCodeMilestoneRunningPayloadSchema,
  OpenCodeResourceIntentPayloadSchema,
  OpenCodeResourcesPreparedPayloadSchema,
  OpenCodeTraceObservedPayloadSchema,
} from "../agents/opencode-agent-events.js";
import {
  MilestoneAuthorityEnvelopePayloadSchema,
  PlanRevisionPayloadSchema,
  ReplanningPausedPayloadSchema,
  ReplanningPolicyBoundPayloadSchema,
  ReplanningResolutionPayloadSchema,
  revisionBoundaryViolation,
  validateAuthorityEnvelope,
  type MilestoneAuthorityEnvelope,
  type PlanRevisionPayload,
  type ReplanningAttention,
  type ReplanningResolutionPayload,
  type ReplanningPolicyBinding,
} from "../contracts/replanning.js";
import {
  LegacyMilestoneNonSuccessPayloadSchema,
  MilestoneTerminalPayloadSchema,
  type MilestoneTerminalResult,
} from "../contracts/milestone-result.js";
import { ReleaseOperationBoundPayloadSchema, type ReleaseOperationBoundPayload } from "../release/release-events.js";

export type PlannedTaskStatus = "planned" | "ready" | "running" | "blocked" | "completed";

export interface PlannedTaskView {
  readonly taskId: string;
  readonly status: PlannedTaskStatus;
  readonly terminalOutcome: TerminalOutcome | null;
  readonly blockedReason: string | null;
  readonly admissionDigest: string | null;
}

export interface MilestoneView {
  readonly milestoneId: string;
  readonly projectId: string;
  readonly title: string;
  readonly lifecycle: MilestoneLifecycleState;
  readonly terminalOutcome: TerminalOutcome | null;
  readonly streamVersion: number;
  readonly plan: MilestonePlan | null;
  readonly stopAndAsk: StopAndAskState | null;
  readonly attention: AuthorityAttention | null;
  readonly replanningAttention: ReplanningAttention | null;
  readonly tasks: Readonly<Record<string, PlannedTaskView>>;
  readonly historicalTasks: Readonly<Record<string, PlannedTaskView>>;
  readonly authorityEnvelope: MilestoneAuthorityEnvelope | null;
  readonly revisions: readonly PlanRevisionPayload[];
  readonly planHistory: readonly MilestonePlan[];
  readonly executedTaskIds: readonly string[];
  readonly hasActiveEffects: boolean;
  readonly hasUncertainEffects: boolean;
  readonly hasTraceFailure: boolean;
  readonly replanningAttentionHistory: readonly ReplanningAttention[];
  readonly replanningResolutions: readonly ReplanningResolutionPayload[];
  readonly replanningPolicy: ReplanningPolicyBinding | null;
  readonly replanningPauseOccurrence: { readonly eventId: string; readonly streamVersion: number } | null;
  readonly writerOwnership: Readonly<Record<string, WriterOwnershipView>>;
  readonly maxConcurrentWriters: number | null;
  readonly result: MilestoneTerminalResult | null;
  readonly releaseOperation: ReleaseOperationBoundPayload | null;
}

export interface WriterOwnershipView {
  readonly batchId: string;
  readonly writerTaskId: string;
  readonly reviewerTaskId: string;
  readonly actorId: string;
  readonly capabilityId: string;
  readonly transportModelId: string;
  readonly harness: string;
  readonly roles: readonly string[];
  readonly toolPermissions: readonly string[];
  readonly network: string;
  readonly contextTokens: number;
  readonly modelCapabilityDigest: string;
  readonly modelMaxConcurrency: number;
  readonly ownedPaths: readonly string[];
  readonly status: "claimed" | "integrated" | "released";
  readonly terminalOutcome: TerminalOutcome | null;
  readonly releasePhase: "pre_review_writer" | "post_handoff_reviewer" | null;
}

interface MilestoneState {
  milestoneId: string;
  projectId: string;
  title: string;
  lifecycle: MilestoneLifecycleState;
  terminalOutcome: TerminalOutcome | null;
  streamVersion: number;
  plan: MilestonePlan | null;
  stopAndAsk: StopAndAskState | null;
  attention: AuthorityAttention | null;
  replanningAttention: ReplanningAttention | null;
  tasks: Map<string, PlannedTaskView>;
  historicalTasks: Map<string, PlannedTaskView>;
  authorityEnvelope: MilestoneAuthorityEnvelope | null;
  revisions: PlanRevisionPayload[];
  planHistory: MilestonePlan[];
  replanningAttentionHistory: ReplanningAttention[];
  replanningResolutions: ReplanningResolutionPayload[];
  seenEvents: StoredEvent[];
  replanningPolicy: ReplanningPolicyBinding | null;
  replanningPauseOccurrence: { eventId: string; streamVersion: number } | null;
  openCodeRuns: Map<string, { actorId: string; role: string; capsuleId: string; capabilityId: string; transportModelId: string; repositoryRevision: string }>;
  resources: Map<string, { taskId: string; intent: Record<string, unknown>; prepared: Record<string, unknown> | null; cleanup: Record<string, unknown> | null }>;
  tracedTasks: Set<string>;
  traceOutcomes: Map<string, "emitted" | "failed">;
  startedTasks: Set<string>;
  writerOwnership: Map<string, WriterOwnershipView>;
  maxConcurrentWriters: number | null;
  writerModelLimits: Map<string, number>;
  writerBatchIds: Set<string>;
  result: MilestoneTerminalResult | null;
  releaseOperation: ReleaseOperationBoundPayload | null;
}

const TERMINAL_EVENTS = new Map<string, TerminalOutcome>([
  ["milestone.completed", "completed"],
  ["milestone.cancelled", "cancelled"],
  ["milestone.denied", "denied"],
  ["milestone.timed_out", "timed_out"],
  ["milestone.failed", "failed"],
]);

export function projectMilestone(events: readonly StoredEvent[]): MilestoneView | null {
  if (events.length === 0) return null;
  assertContiguousMetadata(events);
  const first = events[0]!;
  if (first.type !== "milestone.created") throw new Error("first event must be milestone.created");
  if (first.streamId.length === 0) throw new Error("milestone.created streamId must be a nonempty string");
  const state: MilestoneState = {
    milestoneId: first.streamId,
    projectId: payloadString(first, "projectId"),
    title: payloadString(first, "title"),
    lifecycle: "planning",
    terminalOutcome: null,
    streamVersion: first.streamVersion,
    plan: null,
    stopAndAsk: null,
    attention: null,
    replanningAttention: null,
    tasks: new Map(),
    historicalTasks: new Map(),
    authorityEnvelope: null,
    revisions: [],
    planHistory: [],
    replanningAttentionHistory: [],
    replanningResolutions: [],
    seenEvents: [first],
    replanningPolicy: null,
    replanningPauseOccurrence: null,
    openCodeRuns: new Map(),
    resources: new Map(),
    tracedTasks: new Set(),
    traceOutcomes: new Map(),
    startedTasks: new Set(),
    writerOwnership: new Map(),
    maxConcurrentWriters: null,
    writerModelLimits: new Map(),
    writerBatchIds: new Set(),
    result: null,
    releaseOperation: null,
  };

  for (const event of events.slice(1)) {
    if (state.lifecycle === "terminal") throw new Error("milestone is already terminal");
    if (
      state.lifecycle === "paused" &&
      event.type !== "milestone.cancelled" &&
      event.type !== "milestone.denied" &&
      event.type !== "milestone.plan_replaced" &&
      event.type !== "milestone.replanning_resolved"
    ) {
      throw new Error("milestone is paused pending plan replacement");
    }
    state.streamVersion = event.streamVersion;
    const terminalOutcome = TERMINAL_EVENTS.get(event.type);
    if (terminalOutcome !== undefined) {
      const payload = objectPayload(event);
      const isIssue30 = "result" in payload;
      if (isIssue30) {
        const terminal = MilestoneTerminalPayloadSchema.parse(payload);
        if (terminal.outcome !== terminalOutcome || terminal.result.milestoneId !== state.milestoneId ||
          terminal.result.projectId !== state.projectId) {
          throw new Error("milestone terminal result contradicts its stream identity");
        }
        assertTerminalResultTaskConsistency(state, terminal.result);
        state.result = terminal.result;
      } else if (terminalOutcome === "completed") {
        const hasWriterReviewPair = state.plan?.tasks.some((task) => task.roleAssignment.role === "implementer") === true &&
          state.plan.tasks.some((task) => task.roleAssignment.role === "reviewer");
        if (Object.keys(payload).length !== 0 || hasWriterReviewPair) {
          MilestoneCompletedPayloadSchema.parse(payload);
        }
      } else {
        const legacy = LegacyMilestoneNonSuccessPayloadSchema.parse(payload);
        if ("outcome" in legacy && legacy.outcome !== terminalOutcome) {
          throw new Error("legacy milestone terminal outcome contradicts its event type");
        }
      }
      if (terminalOutcome === "completed") assertSuccessfulMilestoneCompletion(state);
      state.lifecycle = "terminal";
      state.terminalOutcome = terminalOutcome;
      state.stopAndAsk = null;
      state.attention = null;
      state.replanningAttention = null;
      continue;
    }

    switch (event.type) {
      case "milestone.plan_created":
        applyPlanCreated(state, event);
        break;
      case "milestone.authority_envelope_established":
        applyAuthorityEnvelope(state, event);
        break;
      case "milestone.replanning_policy_bound":
        applyReplanningPolicyBound(state, event);
        break;
      case "milestone.task_ready":
        updateTask(state, event, "ready");
        state.lifecycle = state.lifecycle === "planning" ? "ready" : state.lifecycle;
        break;
      case "milestone.task_running":
        observeOpenCodeRunning(state, event);
        updateTask(state, event, "running");
        state.lifecycle = "running";
        break;
      case "milestone.task_blocked":
        updateTask(state, event, "blocked");
        break;
      case "milestone.task_completed":
        observeOpenCodeCompleted(state, event);
        updateTask(state, event, "completed");
        break;
      case "milestone.writer_batch_started":
        applyWriterBatchStarted(state, event);
        break;
      case "milestone.writer_integration_completed":
        applyWriterIntegrationCompleted(state, event);
        break;
      case "milestone.writer_terminal_released":
        applyWriterTerminalReleased(state, event);
        break;
      case "milestone.release_operation_bound":
        applyReleaseOperationBound(state, event);
        break;
      case "milestone.paused":
        applyPaused(state, event);
        break;
      case "milestone.plan_replaced":
        applyPlanReplaced(state, event);
        break;
      case "milestone.plan_revised":
        applyPlanRevised(state, event);
        break;
      case "milestone.replanning_resolved":
        applyReplanningResolved(state, event);
        break;
      case "milestone.agent_trace_observed":
        observeTrace(state, event);
        break;
      case "milestone.agent_resource_intent":
        observeResourceIntent(state, event);
        break;
      case "milestone.agent_resources_prepared":
        observeResourcesPrepared(state, event);
        break;
      case "milestone.agent_cleanup_observed":
        observeCleanup(state, event);
        break;
      default:
        throw new Error(`unknown milestone event type: ${event.type}`);
    }
    state.seenEvents.push(event);
  }

  return freezeView(state);
}

function applyReleaseOperationBound(state: MilestoneState, event: StoredEvent): void {
  const payload = ReleaseOperationBoundPayloadSchema.parse(objectPayload(event));
  if (state.releaseOperation !== null) throw new Error("milestone release operation is already bound");
  const planned = state.plan?.tasks.find((task) => task.taskId === payload.taskId);
  const current = state.tasks.get(payload.taskId);
  if (planned?.roleAssignment.role !== "verifier" || planned.roleAssignment.harness !== "deterministic" ||
    planned.risk.authority !== "local_release_preparation" || current?.status !== "ready" ||
    current.admissionDigest !== payload.verifierAdmissionDigest) {
    throw new Error("milestone release operation does not match the admitted verifier");
  }
  state.releaseOperation = payload;
}

function applyWriterBatchStarted(state: MilestoneState, event: StoredEvent): void {
  if (state.plan === null) throw new Error("writer batch requires a plan");
  const payload = WriterBatchStartedPayloadSchema.parse(objectPayload(event));
  if (state.writerBatchIds.has(payload.batchId)) throw new Error("duplicate writer batch identity");
  if (state.maxConcurrentWriters !== null && state.maxConcurrentWriters !== payload.maxConcurrentWriters) {
    throw new Error("writer batch changes configured global writer capacity");
  }
  if (payload.writers.length > payload.maxConcurrentWriters) {
    throw new Error("writer batch exceeds global writer capacity");
  }
  const taskIds = new Set<string>();
  const modelCounts = new Map<string, number>();
  const active = [...state.writerOwnership.values()].filter((claim) => claim.status === "claimed");
  for (const claim of active) {
    modelCounts.set(claim.capabilityId, (modelCounts.get(claim.capabilityId) ?? 0) + 1);
  }
  for (const claim of payload.writers) {
    if (state.writerOwnership.has(claim.writerTaskId)) throw new Error(`writer ${claim.writerTaskId} is already claimed`);
    if (taskIds.has(claim.writerTaskId) || taskIds.has(claim.reviewerTaskId)) {
      throw new Error("writer batch contains duplicate task identity");
    }
    taskIds.add(claim.writerTaskId);
    taskIds.add(claim.reviewerTaskId);
    const writer = state.plan.tasks.find((task) => task.taskId === claim.writerTaskId);
    const reviewer = state.plan.tasks.find((task) => task.taskId === claim.reviewerTaskId);
    if (writer?.roleAssignment.role !== "implementer" || reviewer?.roleAssignment.role !== "reviewer" ||
      !reviewer.dependencies.includes(claim.writerTaskId)) {
      throw new Error("writer batch requires paired implementer and reviewer tasks");
    }
    if (state.tasks.get(claim.writerTaskId)?.status !== "ready" || state.tasks.get(claim.reviewerTaskId)?.status !== "planned") {
      throw new Error(`planned writer ${claim.writerTaskId} is not dependency-ready`);
    }
    if (writer.roleAssignment.agentId !== claim.actorId || claim.capabilityId !== claim.actorId ||
      JSON.stringify(writer.ownedPaths) !== JSON.stringify(claim.ownedPaths)) {
      throw new Error(`writer ${claim.writerTaskId} claim contradicts its plan`);
    }
    for (const dependency of writer.dependencies) {
      if (state.tasks.get(dependency)?.terminalOutcome !== "completed") {
        throw new Error(`planned writer ${claim.writerTaskId} dependency ${dependency} is not completed successfully`);
      }
    }
    if ([...active, ...payload.writers.filter((candidate) => candidate.writerTaskId !== claim.writerTaskId)]
      .some((candidate) => logicalPathSetsOverlap(claim.ownedPaths, candidate.ownedPaths))) {
      throw new Error("writer ownership overlap");
    }
    const modelCount = (modelCounts.get(claim.capabilityId) ?? 0) + 1;
    modelCounts.set(claim.capabilityId, modelCount);
    const configuredModelLimit = state.writerModelLimits.get(claim.capabilityId);
    if (configuredModelLimit !== undefined && configuredModelLimit !== claim.modelMaxConcurrency) {
      throw new Error("writer batch changes configured model writer capacity");
    }
    if (modelCount > claim.modelMaxConcurrency) throw new Error("writer batch exceeds model writer capacity");
  }
  if (active.length + payload.writers.length > payload.maxConcurrentWriters) {
    throw new Error("writer batch exceeds global writer capacity");
  }
  state.maxConcurrentWriters = payload.maxConcurrentWriters;
  state.writerBatchIds.add(payload.batchId);
  for (const claim of payload.writers) {
    state.writerModelLimits.set(claim.capabilityId, claim.modelMaxConcurrency);
    state.writerOwnership.set(claim.writerTaskId, Object.freeze({
      batchId: payload.batchId,
      writerTaskId: claim.writerTaskId,
      reviewerTaskId: claim.reviewerTaskId,
      actorId: claim.actorId,
      capabilityId: claim.capabilityId,
      transportModelId: claim.transportModelId,
      harness: claim.harness,
      roles: Object.freeze([...claim.roles]),
      toolPermissions: Object.freeze([...claim.toolPermissions]),
      network: claim.network,
      contextTokens: claim.contextTokens,
      modelCapabilityDigest: claim.modelCapabilityDigest,
      modelMaxConcurrency: claim.modelMaxConcurrency,
      ownedPaths: Object.freeze([...claim.ownedPaths]),
      status: "claimed",
      terminalOutcome: null,
      releasePhase: null,
    }));
  }
}

function applyWriterIntegrationCompleted(state: MilestoneState, event: StoredEvent): void {
  const payload = WriterIntegrationCompletedPayloadSchema.parse(objectPayload(event));
  const ownership = state.writerOwnership.get(payload.writerTaskId);
  if (ownership === undefined || ownership.status !== "claimed" || ownership.batchId !== payload.batchId ||
    ownership.reviewerTaskId !== payload.reviewerTaskId || payload.evidence.taskStreamId !== payload.writerTaskId) {
    throw new Error("writer integration completion contradicts its ownership claim");
  }
  if (state.tasks.get(payload.writerTaskId)?.terminalOutcome !== "completed" ||
    state.tasks.get(payload.reviewerTaskId)?.terminalOutcome !== "completed") {
    throw new Error("writer integration completion requires completed writer and reviewer tasks");
  }
  state.writerOwnership.set(payload.writerTaskId, Object.freeze({
    ...ownership,
    status: "integrated",
    terminalOutcome: "completed",
    releasePhase: null,
  }));
}

function applyWriterTerminalReleased(state: MilestoneState, event: StoredEvent): void {
  const payload = WriterTerminalReleasedPayloadSchema.parse(objectPayload(event));
  const ownership = state.writerOwnership.get(payload.writerTaskId);
  if (
    ownership === undefined || ownership.status !== "claimed" || ownership.batchId !== payload.batchId ||
    ownership.reviewerTaskId !== payload.reviewerTaskId
  ) throw new Error("writer terminal release contradicts its ownership claim");
  const writer = state.tasks.get(payload.writerTaskId);
  const reviewer = state.tasks.get(payload.reviewerTaskId);
  if (payload.phase === "pre_review_writer") {
    if (payload.milestoneTerminalTaskId !== payload.writerTaskId || writer?.terminalOutcome !== payload.outcome ||
      reviewer?.status !== "planned") {
      throw new Error("pre-review writer release contradicts milestone task outcomes");
    }
  } else if (
    payload.milestoneTerminalTaskId !== payload.reviewerTaskId || writer?.terminalOutcome !== "completed" ||
    reviewer?.terminalOutcome !== payload.outcome
  ) {
    throw new Error("post-handoff reviewer release contradicts milestone task outcomes");
  }
  state.writerOwnership.set(payload.writerTaskId, Object.freeze({
    ...ownership,
    status: "released",
    terminalOutcome: payload.outcome,
    releasePhase: payload.phase,
  }));
}

function observeOpenCodeRunning(state: MilestoneState, event: StoredEvent): void {
  const payload = objectPayload(event);
  if (payload["harness"] !== "opencode") return;
  const parsed = OpenCodeMilestoneRunningPayloadSchema.parse(payload);
  const resources = state.resources.get(parsed.capsuleId);
  if (resources === undefined || resources.taskId !== parsed.taskId || resources.cleanup !== null) {
    throw new Error("OpenCode running event requires an active resource intent");
  }
  state.openCodeRuns.set(parsed.taskId, {
    actorId: parsed.actorId,
    role: parsed.role,
    capsuleId: parsed.capsuleId,
    capabilityId: parsed.requestedModel.capabilityId,
    transportModelId: parsed.requestedModel.transportModelId,
    repositoryRevision: parsed.securityBoundary.repositoryRevision,
  });
}

function observeOpenCodeCompleted(state: MilestoneState, event: StoredEvent): void {
  const payload = objectPayload(event);
  if (payload["harness"] !== "opencode") return;
  const parsed = OpenCodeMilestoneCompletedPayloadSchema.parse(payload);
  const running = state.openCodeRuns.get(parsed.taskId);
  const resources = state.resources.get(parsed.capsuleId);
  const cleanupOutcome = resources?.cleanup?.["outcome"];
  if (running === undefined || running.actorId !== parsed.actorId || running.role !== parsed.role ||
    running.capsuleId !== parsed.capsuleId || running.capabilityId !== parsed.capabilityId ||
    running.transportModelId !== parsed.transportModelId || cleanupOutcome === undefined || parsed.cleanup !== cleanupOutcome ||
    parsed.evidence.some((evidence) => evidence.provenance.repositoryRevision !== running.repositoryRevision)) {
    throw new Error("OpenCode completed event contradicts its running identity");
  }
  state.openCodeRuns.delete(parsed.taskId);
}

function observeResourceIntent(state: MilestoneState, event: StoredEvent): void {
  const parsed = OpenCodeResourceIntentPayloadSchema.parse(objectPayload(event));
  const task = state.tasks.get(parsed.taskId);
  if (task?.status !== "ready") throw new Error("OpenCode resource intent requires a ready task");
  if (state.resources.has(parsed.capsuleId)) throw new Error("duplicate OpenCode resource intent");
  if ([...state.resources.values()].some((resource) => resource.taskId === parsed.taskId && resource.cleanup === null)) {
    throw new Error("OpenCode task already has an unreconciled resource intent");
  }
  state.resources.set(parsed.capsuleId, {
    taskId: parsed.taskId,
    intent: parsed as unknown as Record<string, unknown>,
    prepared: null,
    cleanup: null,
  });
  state.startedTasks.add(parsed.taskId);
}

function observeResourcesPrepared(state: MilestoneState, event: StoredEvent): void {
  const parsed = OpenCodeResourcesPreparedPayloadSchema.parse(objectPayload(event));
  const resource = state.resources.get(parsed.capsuleId);
  if (resource === undefined || resource.taskId !== parsed.taskId || resource.prepared !== null || resource.cleanup !== null) {
    throw new Error("OpenCode resources prepared event is out of order");
  }
  assertResourceIdentity(resource.intent, parsed);
  resource.prepared = parsed as unknown as Record<string, unknown>;
}

function observeCleanup(state: MilestoneState, event: StoredEvent): void {
  const parsed = OpenCodeCleanupObservedPayloadSchema.parse(objectPayload(event));
  const resource = state.resources.get(parsed.capsuleId);
  if (resource === undefined || resource.taskId !== parsed.taskId) {
    throw new Error("OpenCode cleanup event is out of order");
  }
  if (resource.cleanup !== null) {
    if (resource.cleanup["outcome"] !== "uncertain" || parsed.outcome !== "completed") {
      throw new Error("duplicate OpenCode cleanup observation");
    }
    assertCleanupReconciliation(resource.cleanup, parsed);
  }
  assertResourceIdentity(resource.intent, parsed);
  if (resource.prepared !== null) {
    if (resource.prepared["containerId"] !== parsed.containerId || resource.prepared["imageId"] !== parsed.imageId ||
      resource.prepared["repositoryRevision"] !== parsed.repositoryRevision) {
      throw new Error("OpenCode cleanup contradicts prepared resources");
    }
  }
  if (parsed.outcome === "completed" && (!parsed.containerAbsent || !parsed.imageAbsent || !parsed.repositoryViewAbsent)) {
    throw new Error("completed OpenCode cleanup requires proven absence");
  }
  resource.cleanup = parsed as unknown as Record<string, unknown>;
}

function assertCleanupReconciliation(previous: Record<string, unknown>, completed: {
  taskId: string; capsuleId: string; resourceLabel: string; containerName: string; containerId: string | null;
  imageName: string; imageId: string | null; repositoryViewPath: string; repositoryRevision: string | null;
}): void {
  for (const key of ["taskId", "capsuleId", "resourceLabel", "containerName", "imageName", "repositoryViewPath"] as const) {
    if (previous[key] !== completed[key]) throw new Error("OpenCode cleanup reconciliation identity mismatch");
  }
  for (const key of ["containerId", "imageId", "repositoryRevision"] as const) {
    if (previous[key] !== null && previous[key] !== completed[key]) {
      throw new Error("OpenCode cleanup reconciliation resource mismatch");
    }
  }
}

function observeTrace(state: MilestoneState, event: StoredEvent): void {
  const parsed = OpenCodeTraceObservedPayloadSchema.parse(objectPayload(event));
  if (state.tasks.get(parsed.taskId)?.status !== "completed") throw new Error("OpenCode trace observation requires task completion");
  const prior = state.traceOutcomes.get(parsed.taskId);
  if (prior !== undefined && !(prior === "emitted" && parsed.outcome === "failed")) {
    throw new Error("duplicate OpenCode trace observation");
  }
  state.tracedTasks.add(parsed.taskId);
  state.traceOutcomes.set(parsed.taskId, parsed.outcome);
}

function assertResourceIdentity(intent: Record<string, unknown>, observed: {
  capsuleId: string; resourceLabel: string; containerName: string; imageName: string; repositoryViewPath: string;
}): void {
  for (const key of ["capsuleId", "resourceLabel", "containerName", "imageName", "repositoryViewPath"] as const) {
    if (intent[key] !== observed[key]) throw new Error("OpenCode resource identity mismatch");
  }
}

function applyPlanCreated(state: MilestoneState, event: StoredEvent): void {
  if (state.lifecycle === "paused") throw new Error("milestone.plan_created cannot follow a pause");
  if (state.plan !== null) throw new Error("duplicate milestone.plan_created event");
  const payload = objectPayload(event);
  const parsed = MilestonePlanSchema.safeParse(payload["plan"]);
  if (!parsed.success) throw new Error("invalid milestone plan");
  if (parsed.data.milestoneId !== state.milestoneId || parsed.data.projectId !== state.projectId) {
    throw new Error("milestone plan identity contradicts milestone identity");
  }
  state.plan = parsed.data;
  state.planHistory.push(parsed.data);
  state.lifecycle = "ready";
  for (const task of parsed.data.tasks) {
    state.tasks.set(task.taskId, Object.freeze({
      taskId: task.taskId,
      status: "planned",
      terminalOutcome: null,
      blockedReason: null,
      admissionDigest: null,
    }));
  }
}

function applyPaused(state: MilestoneState, event: StoredEvent): void {
  const authority = MilestonePausedPayloadSchema.safeParse(objectPayload(event));
  const replanning = ReplanningPausedPayloadSchema.safeParse(objectPayload(event));
  if (!authority.success && !replanning.success) throw new Error("invalid milestone attention");
  const attention = authority.success ? authority.data.attention : replanning.data!.attention;
  if (authority.success && (
    [...state.resources.values()].some((resource) => resource.cleanup?.["outcome"] !== "completed") ||
    state.openCodeRuns.size > 0 ||
    [...state.tasks.values()].some((task) => task.status === "running")
  )) throw new Error("authority pause must precede active or uncertain milestone effects");
  if (authority.success && (
    attention.milestoneId !== state.milestoneId ||
    (state.plan === null ? authority.data.attention.reason !== "plan_not_ready" : !state.tasks.has(authority.data.attention.taskId)) ||
    authority.data.attention.planDigest !== digestCanonical(state.plan)
  )) throw new Error("milestone authority attention binding is invalid");
  if (replanning.success && (
    attention.milestoneId !== state.milestoneId ||
    replanning.data.attention.priorPlanDigest !== digestCanonical(state.plan)
  )) throw new Error("milestone replanning attention binding is invalid");
  state.lifecycle = "paused";
  state.attention = authority.success ? authority.data.attention : null;
  state.replanningAttention = replanning.success ? replanning.data.attention : null;
  if (replanning.success) {
    state.replanningAttentionHistory.push(replanning.data.attention);
    state.replanningPauseOccurrence = { eventId: event.eventId, streamVersion: event.streamVersion };
  }
  state.stopAndAsk = authority.success ? StopAndAskStateSchema.parse({
    reason: authority.data.attention.reason,
    message: authority.data.attention.message,
    requestedBy: authority.data.attention.requestedBy,
    requiredDecision: authority.data.attention.requiredDecision,
  }) : null;
}

function applyAuthorityEnvelope(state: MilestoneState, event: StoredEvent): void {
  if (state.plan === null || state.replanningPolicy === null || state.authorityEnvelope !== null || state.startedTasks.size > 0) {
    throw new Error("milestone authority envelope must bind the unexecuted baseline plan exactly once");
  }
  const envelope = MilestoneAuthorityEnvelopePayloadSchema.parse(objectPayload(event)).envelope;
  validateAuthorityEnvelope(envelope, state.plan, state.replanningPolicy);
  state.authorityEnvelope = envelope;
}

function applyReplanningPolicyBound(state: MilestoneState, event: StoredEvent): void {
  if (state.plan === null || state.replanningPolicy !== null || state.authorityEnvelope !== null || state.startedTasks.size > 0) {
    throw new Error("replanning policy must bind the unexecuted baseline before authority");
  }
  const policy = ReplanningPolicyBoundPayloadSchema.parse(objectPayload(event)).policy;
  if (policy.milestoneId !== state.milestoneId || policy.projectId !== state.projectId) {
    throw new Error("replanning policy identity is invalid");
  }
  state.replanningPolicy = policy;
}

function applyPlanRevised(state: MilestoneState, event: StoredEvent): void {
  if (state.plan === null || state.authorityEnvelope === null || state.lifecycle === "paused") {
    throw new Error("milestone plan revision requires active durable authority");
  }
  const revision = PlanRevisionPayloadSchema.parse(objectPayload(event));
  if (
    revision.milestoneId !== state.milestoneId ||
    revision.projectId !== state.projectId ||
    revision.priorPlanDigest !== digestCanonical(state.plan) ||
    revision.revisedPlanDigest !== digestCanonical(revision.revisedPlan) ||
    revision.authorityEnvelopeDigest !== digestCanonical(state.authorityEnvelope) ||
    revision.securityDigest !== state.authorityEnvelope.securityDigest ||
    revision.modelSheetDigest !== state.authorityEnvelope.modelSheetDigest ||
    revision.revisionNumber !== state.revisions.length + 1
  ) throw new Error("milestone plan revision binding is invalid");
  validateRevisionEvidence(state, revision);
  const violation = revisionBoundaryViolation({
    envelope: state.authorityEnvelope,
    currentPlan: state.plan,
    candidatePlan: revision.revisedPlan,
    planHistory: state.planHistory,
    taskStates: Object.fromEntries(state.tasks),
    executedTaskIds: [...state.startedTasks],
    supersessions: revision.supersessions,
  });
  if (violation !== null) throw new Error(`milestone plan revision violates ${violation}`);

  const priorTasks = new Map(state.tasks);
  for (const [taskId, task] of priorTasks) {
    if (!revision.revisedPlan.tasks.some((candidate) => candidate.taskId === taskId)) {
      state.historicalTasks.set(taskId, task);
    }
  }
  state.tasks.clear();
  for (const task of revision.revisedPlan.tasks) {
    const prior = priorTasks.get(task.taskId);
    state.tasks.set(task.taskId, prior ?? Object.freeze({
      taskId: task.taskId,
      status: "planned",
      terminalOutcome: null,
      blockedReason: null,
      admissionDigest: null,
    }));
  }
  state.plan = revision.revisedPlan;
  state.planHistory.push(revision.revisedPlan);
  state.revisions.push(revision);
  state.lifecycle = [...state.tasks.values()].some((task) => task.status === "running") ? "running" : "ready";
  state.attention = null;
  state.replanningAttention = null;
  state.stopAndAsk = null;
}

function validateRevisionEvidence(state: MilestoneState, revision: PlanRevisionPayload): void {
  const seen = new Map(state.seenEvents.map((event) => [event.eventId, event] as const));
  let completion: StoredEvent | null = null;
  for (const reference of revision.priorEvidence) {
    if (reference.streamId !== state.milestoneId) continue;
    const event = seen.get(reference.eventId);
    if (event === undefined || event.streamId !== reference.streamId || event.streamVersion !== reference.streamVersion ||
      event.type !== reference.eventType || digestCanonical(event.payload) !== reference.payloadDigest) {
      throw new Error("milestone plan revision evidence binding is invalid");
    }
    if (event.type === "milestone.task_completed") completion = event;
  }
  if (completion === null) throw new Error("milestone plan revision requires same-stream completion evidence");
  const taskId = payloadString(completion, "taskId");
  const task = state.tasks.get(taskId);
  if (task?.status !== "completed" || task.terminalOutcome === null) {
    throw new Error("milestone plan revision completion evidence is not terminal");
  }
  const resources = [...state.resources.values()].filter((resource) => resource.taskId === taskId);
  if (resources.some((resource) => resource.cleanup?.["outcome"] !== "completed")) {
    throw new Error("milestone plan revision completion evidence lacks completed cleanup");
  }
}

function applyReplanningResolved(state: MilestoneState, event: StoredEvent): void {
  if (state.lifecycle !== "paused" || state.replanningAttention === null || state.plan === null) {
    throw new Error("replanning resolution requires an active replanning attention");
  }
  const resolution = ReplanningResolutionPayloadSchema.parse(objectPayload(event));
  if (resolution.milestoneId !== state.milestoneId ||
    resolution.attentionId !== state.replanningAttention.attentionId ||
    resolution.priorPlanDigest !== state.replanningAttention.priorPlanDigest ||
    resolution.candidateDigest !== state.replanningAttention.candidateDigest ||
    state.replanningPauseOccurrence === null ||
    resolution.pauseEventId !== state.replanningPauseOccurrence.eventId ||
    resolution.pauseStreamVersion !== state.replanningPauseOccurrence.streamVersion) {
    throw new Error("replanning resolution binding is stale");
  }
  state.replanningResolutions.push(resolution);
  state.replanningAttention = null;
  state.replanningPauseOccurrence = null;
  state.lifecycle = [...state.tasks.values()].some((task) => task.status === "running" || task.status === "blocked")
    ? "running"
    : "ready";
}

function applyPlanReplaced(state: MilestoneState, event: StoredEvent): void {
  if (state.lifecycle !== "paused" || state.attention === null) {
    throw new Error("milestone plan replacement requires an exact pause");
  }
  if (
    state.startedTasks.size > 0 ||
    state.resources.size > 0 ||
    state.openCodeRuns.size > 0 ||
    [...state.tasks.values()].some((task) => task.status === "running" || task.status === "completed")
  ) throw new Error("create a new milestone after task execution has started");
  const parsed = PlanReplacementPayloadSchema.safeParse(objectPayload(event));
  if (!parsed.success) throw new Error("invalid milestone plan replacement");
  const replacement = parsed.data;
  if (
    replacement.milestoneId !== state.milestoneId ||
    replacement.projectId !== state.projectId ||
    replacement.replacementPlan.milestoneId !== state.milestoneId ||
    replacement.replacementPlan.projectId !== state.projectId ||
    replacement.attentionId !== state.attention.attentionId ||
    replacement.priorPlanDigest !== state.attention.planDigest ||
    replacement.priorSecurityDigest !== state.attention.policyDigest
  ) throw new Error("paused plan replacement binding is stale");
  state.plan = replacement.replacementPlan;
  state.planHistory.push(replacement.replacementPlan);
  // Replacement establishes a different pre-execution baseline, but its API
  // does not carry enough policy detail to prove a new replanning envelope.
  state.authorityEnvelope = null;
  state.replanningPolicy = null;
  state.tasks.clear();
  for (const task of replacement.replacementPlan.tasks) {
    state.tasks.set(task.taskId, Object.freeze({
      taskId: task.taskId,
      status: "planned",
      terminalOutcome: null,
      blockedReason: null,
      admissionDigest: null,
    }));
  }
  state.lifecycle = "planning";
  state.attention = null;
  state.replanningAttention = null;
  state.stopAndAsk = null;
}

function updateTask(
  state: MilestoneState,
  event: StoredEvent,
  status: PlannedTaskStatus,
): void {
  if (state.plan === null) throw new Error("milestone task event requires a plan");
  const taskId = payloadString(event, "taskId");
  const current = state.tasks.get(taskId);
  if (current === undefined) throw new Error(`unknown planned task: ${taskId}`);
  validateAssignedActor(state, event, taskId, status);
  if (current.status === "completed") throw new Error(`planned task ${taskId} is already completed`);
  if (status === "ready") {
    const parsed = TaskReadyPayloadSchema.safeParse(objectPayload(event));
    if (!parsed.success || parsed.data.taskId !== taskId) throw new Error("invalid milestone task admission");
    if (current.status !== "planned" && current.status !== "blocked") {
      throw new Error(`planned task ${taskId} cannot become ready from ${current.status}`);
    }
    const task = state.plan.tasks.find((candidate) => candidate.taskId === taskId)!;
    for (const dependency of task.dependencies) {
      const dependencyView = state.tasks.get(dependency);
      if (dependencyView?.status !== "completed") {
        throw new Error(`planned task ${taskId} dependency ${dependency} is not completed`);
      }
      if (dependencyView.terminalOutcome !== "completed") {
        throw new Error(`planned task ${taskId} dependency ${dependency} is not completed successfully`);
      }
    }
  }
  if (status === "blocked" && current.status !== "ready" && current.status !== "running") {
    throw new Error(`planned task ${taskId} cannot be blocked from ${current.status}`);
  }
  if (status === "running" && current.status !== "ready" && current.status !== "blocked") {
    throw new Error(`planned task ${taskId} must be ready before running`);
  }
  if (status === "running") state.startedTasks.add(taskId);
  if (status === "completed" && current.status !== "running") {
    throw new Error(`planned task ${taskId} must be running before completion`);
  }
  state.tasks.set(taskId, Object.freeze({
    taskId,
    status,
    terminalOutcome: status === "completed" ? terminalOutcome(event) : null,
    blockedReason: status === "blocked" ? payloadString(event, "reason") : null,
    admissionDigest: status === "ready"
      ? TaskReadyPayloadSchema.parse(objectPayload(event)).admissionDigest
      : current.admissionDigest,
  }));
}

function assertSuccessfulMilestoneCompletion(state: MilestoneState): void {
  if (state.plan === null) throw new Error("successful milestone completion requires a plan");
  for (const task of state.plan.tasks) {
    const view = state.tasks.get(task.taskId);
    if (view?.terminalOutcome !== "completed") {
      throw new Error("successful milestone completion requires all planned tasks completed");
    }
  }
}

function assertTerminalResultTaskConsistency(state: MilestoneState, result: MilestoneTerminalResult): void {
  if (result.tasks.length !== (state.plan?.tasks.length ?? 0)) {
    throw new Error("milestone terminal result must include every planned task");
  }
  for (const [index, planned] of (state.plan?.tasks ?? []).entries()) {
    const retained = result.tasks[index];
    const current = state.tasks.get(planned.taskId);
    if (retained?.taskId !== planned.taskId || retained.role !== planned.roleAssignment.role ||
      retained.status !== current?.status || retained.outcome !== current.terminalOutcome) {
      throw new Error("milestone terminal result task outcome contradicts same-stream state");
    }
    for (const evidence of retained.evidence.filter((item) => item.streamId === state.milestoneId)) {
      const event = state.seenEvents.find((candidate) => candidate.eventId === evidence.eventId);
      if (event === undefined || event.type !== evidence.eventType || event.streamVersion !== evidence.streamVersion ||
        digestCanonical(event.payload) !== evidence.payloadDigest) {
        throw new Error("milestone terminal result same-stream evidence is invalid");
      }
    }
  }
}

function validateAssignedActor(
  state: MilestoneState,
  event: StoredEvent,
  taskId: string,
  status: PlannedTaskStatus,
): void {
  if (status !== "running" && status !== "completed") return;
  const payload = objectPayload(event);
  const actorId = payload["actorId"];
  const role = payload["role"];
  if (actorId === undefined && role === undefined) {
    if (
      state.plan!.tasks.some((task) => task.roleAssignment.role === "implementer") &&
      state.plan!.tasks.some((task) => task.roleAssignment.role === "reviewer")
    ) throw new Error(`planned task ${taskId} requires assigned actor evidence`);
    return;
  }
  const assignment = state.plan!.tasks.find((task) => task.taskId === taskId)!.roleAssignment;
  if (actorId !== assignment.agentId || role !== assignment.role) {
    throw new Error(`planned task ${taskId} actor contradicts its assignment`);
  }
}

function terminalOutcome(event: StoredEvent): TerminalOutcome {
  const payload = objectPayload(event);
  const parsed = TerminalOutcomeSchema.safeParse(payload["outcome"]);
  if (!parsed.success) throw new Error("invalid planned task terminal outcome");
  return parsed.data;
}

function freezeView(state: MilestoneState): MilestoneView {
  return Object.freeze({
    milestoneId: state.milestoneId,
    projectId: state.projectId,
    title: state.title,
    lifecycle: state.lifecycle,
    terminalOutcome: state.terminalOutcome,
    streamVersion: state.streamVersion,
    plan: state.plan,
    stopAndAsk: state.stopAndAsk,
    attention: state.attention,
    replanningAttention: state.replanningAttention,
    tasks: Object.freeze(Object.fromEntries(state.tasks)),
    historicalTasks: Object.freeze(Object.fromEntries(state.historicalTasks)),
    authorityEnvelope: state.authorityEnvelope,
    revisions: Object.freeze([...state.revisions]),
    planHistory: Object.freeze([...state.planHistory]),
    executedTaskIds: Object.freeze([...state.startedTasks].sort()),
    hasActiveEffects: state.openCodeRuns.size > 0 || [...state.resources.values()].some((resource) => resource.cleanup === null),
    hasUncertainEffects: [...state.resources.values()].some((resource) => resource.cleanup?.["outcome"] === "uncertain"),
    hasTraceFailure: [...state.traceOutcomes.values()].some((outcome) => outcome === "failed"),
    replanningAttentionHistory: Object.freeze([...state.replanningAttentionHistory]),
    replanningResolutions: Object.freeze([...state.replanningResolutions]),
    replanningPolicy: state.replanningPolicy,
    replanningPauseOccurrence: state.replanningPauseOccurrence === null ? null : Object.freeze({ ...state.replanningPauseOccurrence }),
    writerOwnership: Object.freeze(Object.fromEntries(state.writerOwnership)),
    maxConcurrentWriters: state.maxConcurrentWriters,
    result: state.result,
    releaseOperation: state.releaseOperation,
  });
}

function assertContiguousMetadata(events: readonly StoredEvent[]): void {
  const streamId = events[0]!.streamId;
  for (const [index, event] of events.entries()) {
    if (event.streamId !== streamId) throw new Error("milestone events must share one stream");
    if (event.streamVersion !== index + 1) throw new Error("milestone stream versions must be contiguous");
  }
}

function payloadString(event: StoredEvent, key: string): string {
  const payload = objectPayload(event);
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${event.type} payload requires ${key}`);
  }
  return value;
}

function objectPayload(event: StoredEvent): Readonly<Record<string, unknown>> {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new Error(`${event.type} payload must be an object`);
  }
  return event.payload as Readonly<Record<string, unknown>>;
}
