import type { StoredEvent } from "../contracts/event.js";
import type { TerminalOutcome } from "../contracts/task.js";
import {
  PreflightPayloadSchema,
  PreflightFailedPayloadSchema,
  RunAcceptedPayloadSchema,
  RunAnalysisCompletedPayloadSchema,
  RunApprovalRequestedPayloadSchema,
  RunCancelledPayloadSchema,
  RunPhasePayloadSchema,
  RunIntakeCompletedPayloadSchema,
  RunPlanRevisedPayloadSchema,
  RunReadyPayloadSchema,
  RunReopenedPayloadSchema,
  RunResumedPayloadSchema,
  RunSuspendedPayloadSchema,
  RunTerminalPayloadSchema,
  type ProjectRevision,
  type RunActor,
  type RunAuthority,
  type RunBudget,
  type RunLifecycle,
  type RunProcess,
  type RunSource,
  runStreamId,
} from "./run-contracts.js";

export interface RunView {
  readonly schemaVersion: 1;
  readonly runVersion: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly projectRevision: ProjectRevision;
  readonly source: RunSource;
  readonly actor: RunActor;
  readonly acceptedBy: RunProcess;
  readonly activeProcess: RunProcess;
  readonly budget: RunBudget;
  readonly lifecycle: RunLifecycle;
  readonly terminalOutcome: TerminalOutcome | null;
  readonly streamVersion: number;
  readonly authority: RunAuthority;
  readonly suspendedFrom: Exclude<RunLifecycle, "waiting" | "blocked" | "terminal"> | null;
  readonly suspensionEventId: string | null;
  readonly cancellation: ReturnType<typeof RunCancelledPayloadSchema.parse> | null;
}

const terminalEvents: Readonly<Record<string, TerminalOutcome>> = {
  "run.completed": "completed",
  "run.cancelled": "cancelled",
  "run.denied": "denied",
  "run.timed_out": "timed_out",
  "run.failed": "failed",
};

export function projectRun(events: readonly StoredEvent[]): RunView | null {
  if (events.length === 0) return null;
  const first = events[0]!;
  if (first.type !== "run.accepted") throw new Error("first event must be run.accepted");
  const accepted = RunAcceptedPayloadSchema.parse(first.payload);
  const expectedStreamId = runStreamId(accepted.runId);
  if (first.streamId !== expectedStreamId || first.streamVersion !== 1 || first.correlationId !== accepted.runId) {
    throw new Error("run.accepted metadata contradicts its run identity");
  }

  const state = {
    lifecycle: "accepted" as RunLifecycle,
    terminalOutcome: null as TerminalOutcome | null,
    streamVersion: 1,
    authority: accepted.authority as RunAuthority,
    suspendedFrom: null as Exclude<RunLifecycle, "waiting" | "blocked" | "terminal"> | null,
    suspensionEventId: null as string | null,
    cancellation: null as ReturnType<typeof RunCancelledPayloadSchema.parse> | null,
    activeProcess: accepted.process as RunProcess,
    seenProcessIncarnations: new Set([accepted.process.processIncarnation]),
    intakeClosure: null as ReturnType<typeof RunIntakeCompletedPayloadSchema.parse>["intake"] | null,
    intakeCompletionEventId: null as string | null,
  };
  const commandBindings = new Map<string, string>([[accepted.commandId, JSON.stringify(first.payload)]]);

  for (let index = 1; index < events.length; index++) {
    const event = events[index]!;
    if (state.lifecycle === "terminal") throw new Error("run is already terminal");
    if (event.streamId !== expectedStreamId || event.streamVersion !== index + 1 || event.correlationId !== accepted.runId) {
      throw new Error("run event metadata is not contiguous or bound to the run");
    }

    const terminalOutcome = terminalEvents[event.type];
    if (terminalOutcome !== undefined) {
      if (terminalOutcome === "completed" && state.lifecycle !== "approved_and_ready_for_execution") {
        throw new Error("run completion requires approved_and_ready_for_execution");
      }
      if (event.type === "run.cancelled") {
        const payload = RunCancelledPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        if (payload.observedLifecycle !== state.lifecycle) throw new Error("run cancellation observed lifecycle is stale");
        if (JSON.stringify(payload.process) !== JSON.stringify(state.activeProcess)) throw new Error("run cancellation process is not active");
        state.cancellation = payload;
      } else {
        const payload = RunTerminalPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        requireActiveProcess(state.activeProcess, payload.process);
      }
      state.lifecycle = "terminal";
      state.terminalOutcome = terminalOutcome;
      state.streamVersion = event.streamVersion;
      continue;
    }

    switch (event.type) {
      case "preflight.started": {
        const payload = PreflightPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        requireActiveProcess(state.activeProcess, payload.process);
        requireTransition(state.lifecycle, "accepted", event.type);
        state.lifecycle = "preflighting";
        break;
      }
      case "preflight.completed": {
        const payload = PreflightPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        requireActiveProcess(state.activeProcess, payload.process);
        requireTransition(state.lifecycle, "preflighting", event.type);
        state.lifecycle = "intake";
        break;
      }
      case "preflight.failed": {
        const payload = PreflightFailedPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        requireActiveProcess(state.activeProcess, payload.process);
        if (state.lifecycle !== "preflighting" && state.lifecycle !== "intake") {
          throw new Error(`invalid run transition ${state.lifecycle} -> ${event.type}`);
        }
        const failedFrom = state.lifecycle;
        if (payload.disposition === "terminal") {
          state.lifecycle = "terminal";
          state.terminalOutcome = "failed";
        } else {
          state.lifecycle = "blocked";
          state.suspendedFrom = failedFrom;
          state.suspensionEventId = event.eventId;
        }
        break;
      }
      case "run.intake_completed": {
        const payload = RunIntakeCompletedPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        requireTransition(state.lifecycle, "intake", event.type);
        if (event.causationId !== payload.intake.closureEventId) throw new Error("run intake completion is not caused by its closure");
        state.intakeClosure = payload.intake;
        state.intakeCompletionEventId = event.eventId;
        state.lifecycle = "analyzing";
        break;
      }
      case "run.reopened": {
        const payload = RunReopenedPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        if (JSON.stringify(payload.priorProcess) !== JSON.stringify(state.activeProcess)) {
          throw new Error("run reopen prior process does not match the active process");
        }
        if (payload.priorRunEventId !== events[index - 1]!.eventId || payload.serviceReadyEventId !== event.causationId) {
          throw new Error("run reopen causation does not bind the prior run and ready service");
        }
        if (state.seenProcessIncarnations.has(payload.process.processIncarnation)) {
          throw new Error("run cannot reactivate a prior process incarnation");
        }
        state.seenProcessIncarnations.add(payload.process.processIncarnation);
        state.activeProcess = payload.process;
        break;
      }
      case "run.analysis_completed": {
        const payload = RunAnalysisCompletedPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        requireTransition(state.lifecycle, "analyzing", event.type);
        if (state.intakeClosure === null || JSON.stringify(payload.intake) !== JSON.stringify(state.intakeClosure)) {
          throw new Error("run analysis does not match the durable intake closure");
        }
        if (event.causationId !== state.intakeCompletionEventId) throw new Error("run analysis is not caused by intake completion");
        state.lifecycle = "planning";
        break;
      }
      case "run.approval_requested": {
        const payload = RunApprovalRequestedPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        requireTransition(state.lifecycle, "planning", event.type);
        state.lifecycle = "awaiting_approval";
        state.authority = { ...state.authority, approvalState: "approval_pending", planDigest: payload.planDigest, envelopeDigest: payload.envelopeDigest };
        break;
      }
      case "run.ready_for_execution": {
        const payload = RunReadyPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        requireTransition(state.lifecycle, "awaiting_approval", event.type);
        if (payload.planDigest !== state.authority.planDigest || payload.envelopeDigest !== state.authority.envelopeDigest) {
          throw new Error("run ready evidence contradicts the approval request");
        }
        const approvalRequest = events[index - 1]!;
        if (approvalRequest.type !== "run.approval_requested" ||
          payload.approvalRequestEventId !== approvalRequest.eventId ||
          payload.approvalDecisionEventId !== event.causationId) {
          throw new Error("run ready evidence does not bind the current request and accepted decision event");
        }
        state.lifecycle = "approved_and_ready_for_execution";
        state.authority = { ...state.authority, approvalState: "approved", approvalDecisionId: payload.approvalDecisionId };
        break;
      }
      case "run.plan_revised": {
        const payload = RunPlanRevisedPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        requireTransition(state.lifecycle, "awaiting_approval", event.type);
        const priorApproval = events[index - 1]!;
        if (priorApproval.type !== "run.approval_requested" || payload.priorApprovalRequestEventId !== priorApproval.eventId ||
          event.causationId !== priorApproval.eventId) {
          throw new Error("run plan revision does not bind the current approval request");
        }
        state.lifecycle = "planning";
        state.authority = {
          approvalState: "not_proposed",
          planDigest: null,
          envelopeDigest: null,
          approvalDecisionId: null,
          executionAuthority: "none",
        };
        break;
      }
      case "run.waiting":
      case "run.blocked": {
        const payload = RunSuspendedPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        if (state.lifecycle === "waiting" || state.lifecycle === "blocked") throw new Error(`invalid run transition ${state.lifecycle} -> ${event.type}`);
        if (payload.resumeTo !== state.lifecycle) throw new Error("run suspension resume state is stale");
        state.suspendedFrom = payload.resumeTo;
        state.suspensionEventId = event.eventId;
        state.lifecycle = event.type === "run.waiting" ? "waiting" : "blocked";
        break;
      }
      case "run.resumed": {
        const payload = RunResumedPayloadSchema.parse(event.payload);
        bindCommand(commandBindings, payload.commandId, event.payload);
        if (state.lifecycle !== "waiting" && state.lifecycle !== "blocked") throw new Error(`invalid run transition ${state.lifecycle} -> ${event.type}`);
        if (payload.resumeTo !== state.suspendedFrom || payload.suspensionEventId !== state.suspensionEventId) {
          throw new Error("run resume does not match the active suspension");
        }
        state.lifecycle = payload.resumeTo;
        state.suspendedFrom = null;
        state.suspensionEventId = null;
        break;
      }
      default:
        throw new Error(`unknown run event type ${event.type}`);
    }
    state.streamVersion = event.streamVersion;
  }

  return Object.freeze({
    schemaVersion: 1,
    runVersion: 1,
    runId: accepted.runId,
    projectId: accepted.projectId,
    projectRevision: accepted.projectRevision,
    source: accepted.source,
    actor: accepted.actor,
    acceptedBy: accepted.process,
    activeProcess: state.activeProcess,
    budget: accepted.budget,
    lifecycle: state.lifecycle,
    terminalOutcome: state.terminalOutcome,
    streamVersion: state.streamVersion,
    authority: Object.freeze(state.authority),
    suspendedFrom: state.suspendedFrom,
    suspensionEventId: state.suspensionEventId,
    cancellation: state.cancellation,
  });
}

function requireTransition(actual: RunLifecycle, expected: RunLifecycle, eventType: string): void {
  if (actual !== expected) throw new Error(`invalid run transition ${actual} -> ${eventType}`);
}

function bindPhase(bindings: Map<string, string>, payload: unknown): void {
  const parsed = RunPhasePayloadSchema.parse(payload);
  bindCommand(bindings, parsed.commandId, payload);
}

function bindCommand(bindings: Map<string, string>, commandId: string, payload: unknown): void {
  const serialized = JSON.stringify(payload);
  const prior = bindings.get(commandId);
  if (prior !== undefined && prior !== serialized) throw new Error("run command identity was reused with different input");
  if (prior !== undefined) throw new Error("duplicate run command event");
  bindings.set(commandId, serialized);
}

function requireActiveProcess(active: RunProcess, observed: RunProcess): void {
  if (JSON.stringify(active) !== JSON.stringify(observed)) throw new Error("run event process is not active");
}
