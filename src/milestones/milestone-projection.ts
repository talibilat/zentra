import type { StoredEvent } from "../contracts/event.js";
import {
  MilestonePlanSchema,
  StopAndAskStateSchema,
  type MilestoneLifecycleState,
  type MilestonePlan,
  type StopAndAskState,
} from "../contracts/milestone.js";
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
  readonly replanningAttentionHistory: readonly ReplanningAttention[];
  readonly replanningResolutions: readonly ReplanningResolutionPayload[];
  readonly replanningPolicy: ReplanningPolicyBinding | null;
  readonly replanningPauseOccurrence: { readonly eventId: string; readonly streamVersion: number } | null;
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
  startedTasks: Set<string>;
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
    startedTasks: new Set(),
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
  if (state.tracedTasks.has(parsed.taskId)) throw new Error("duplicate OpenCode trace observation");
  state.tracedTasks.add(parsed.taskId);
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
    replanningAttentionHistory: Object.freeze([...state.replanningAttentionHistory]),
    replanningResolutions: Object.freeze([...state.replanningResolutions]),
    replanningPolicy: state.replanningPolicy,
    replanningPauseOccurrence: state.replanningPauseOccurrence === null ? null : Object.freeze({ ...state.replanningPauseOccurrence }),
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
