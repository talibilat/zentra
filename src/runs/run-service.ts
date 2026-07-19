import type { NewEvent, StoredEvent } from "../contracts/event.js";
import type { TerminalOutcome } from "../contracts/task.js";
import { findAllEvent, readStreamEvents, type EventJournal } from "../journal/journal.js";
import {
  RUN_SCHEMA_VERSION,
  ProjectRevisionSchema,
  RunActorSchema,
  RunBudgetSchema,
  RunProcessSchema,
  RunSourceSchema,
  ServiceReadyPayloadSchema,
  ServiceStartingPayloadSchema,
  serviceStreamId,
  runStreamId,
  type ProjectRevision,
  type RunActor,
  type RunBudget,
  type RunProcess,
  type RunSource,
} from "./run-contracts.js";
import { projectRun, type RunView } from "./run-projection.js";

export interface AcceptRunInput {
  readonly runId: string;
  readonly projectId: string;
  readonly projectRevision: ProjectRevision;
  readonly source: RunSource;
  readonly actor: RunActor;
  readonly process: RunProcess;
  readonly budget: RunBudget;
  readonly commandId: string;
  readonly causationId: string | null;
}

export interface RunCommandContext {
  readonly expectedVersion: number;
  readonly commandId: string;
  readonly causationId: string | null;
  readonly process: RunProcess;
}

export class RunService {
  constructor(private readonly journal: EventJournal) {}

  accept(input: AcceptRunInput): RunView {
    if (input.source.declaredBytes > input.budget.maxSourceBytes) {
      throw new Error("declared source bytes exceed the run budget");
    }
    if (input.causationId === null) throw new Error("run acceptance requires service.ready causation");
    this.verifyServiceReady(input.causationId, input.process);
    const streamId = runStreamId(input.runId);
    const event = this.event(streamId, "run.accepted", {
      schemaVersion: RUN_SCHEMA_VERSION,
      runVersion: 1,
      runId: input.runId,
      projectId: input.projectId,
      projectRevision: ProjectRevisionSchema.parse(input.projectRevision),
      source: RunSourceSchema.parse(input.source),
      actor: RunActorSchema.parse(input.actor),
      process: RunProcessSchema.parse(input.process),
      budget: RunBudgetSchema.parse(input.budget),
      authority: {
        approvalState: "not_proposed",
        planDigest: null,
        envelopeDigest: null,
        approvalDecisionId: null,
        executionAuthority: "none",
      },
      commandId: input.commandId,
    }, input.causationId, input.runId);
    projectRun([prospective(event, 1)]);
    const existing = readStreamEvents(this.journal, streamId);
    if (existing.length > 0) {
      const current = requiredProjection(existing);
      if (existing[0]!.type === event.type && existing[0]!.causationId === event.causationId && JSON.stringify(existing[0]!.payload) === JSON.stringify(event.payload)) {
        return current;
      }
      throw new Error(`run ${input.runId} already exists with different acceptance input`);
    }
    const stored = this.journal.append(streamId, 0, [event]);
    return requiredProjection(stored);
  }

  startPreflight(runId: string, context: RunCommandContext): RunView {
    return this.append(runId, context, "preflight.started", {
      schemaVersion: RUN_SCHEMA_VERSION, runId, process: RunProcessSchema.parse(context.process),
      commandId: context.commandId, executionAuthority: "none",
    });
  }

  completePreflight(runId: string, context: RunCommandContext): RunView {
    return this.append(runId, context, "preflight.completed", {
      schemaVersion: RUN_SCHEMA_VERSION, runId, process: RunProcessSchema.parse(context.process),
      commandId: context.commandId, executionAuthority: "none",
    });
  }

  failPreflight(runId: string, context: RunCommandContext, input: {
    readonly reasonCode: "project_revision_changed" | "project_revision_unavailable" | "trace_unavailable" | "journal_unavailable" | "runtime_ownership_lost" | "projection_failed" | "internal_failure";
    readonly diagnosticSha256: string;
    readonly disposition: "blocked" | "terminal";
  }): RunView {
    return this.append(runId, context, "preflight.failed", {
      schemaVersion: RUN_SCHEMA_VERSION, runId, process: RunProcessSchema.parse(context.process),
      commandId: context.commandId, executionAuthority: "none", ...input,
    });
  }

  completeIntake(runId: string, expectedVersion: number, commandId: string): RunView {
    return this.appendPhase(runId, expectedVersion, commandId, "run.intake_completed");
  }

  reopenWithProcess(runId: string, expectedVersion: number, commandId: string, process: RunProcess, serviceReadyEventId: string): RunView {
    const current = this.require(runId);
    if (JSON.stringify(current.activeProcess) === JSON.stringify(process)) return current;
    this.verifyServiceReady(serviceReadyEventId, process);
    const priorRunEventId = this.readStream(runId).at(-1)!.eventId;
    return this.append(runId, {
      expectedVersion, commandId, causationId: serviceReadyEventId, process,
    }, "run.reopened", {
      schemaVersion: RUN_SCHEMA_VERSION, commandId, priorProcess: current.activeProcess,
      process: RunProcessSchema.parse(process), priorRunEventId, serviceReadyEventId, executionAuthority: "none",
    });
  }

  completeAnalysis(runId: string, expectedVersion: number, commandId: string): RunView {
    return this.appendPhase(runId, expectedVersion, commandId, "run.analysis_completed");
  }

  requestApproval(runId: string, expectedVersion: number, commandId: string, input: { readonly planDigest: string; readonly envelopeDigest: string }): RunView {
    return this.append(runId, { expectedVersion, commandId, causationId: null, process: this.require(runId).acceptedBy }, "run.approval_requested", {
      schemaVersion: RUN_SCHEMA_VERSION, commandId, ...input, executionAuthority: "none",
    });
  }

  markApprovedAndReadyForExecution(runId: string, expectedVersion: number, commandId: string, input: { readonly planDigest: string; readonly envelopeDigest: string; readonly approvalDecisionId: string }): RunView {
    return this.append(runId, { expectedVersion, commandId, causationId: null, process: this.require(runId).acceptedBy }, "run.ready_for_execution", {
      schemaVersion: RUN_SCHEMA_VERSION, commandId, ...input, executionAuthority: "none",
    });
  }

  wait(runId: string, expectedVersion: number, commandId: string, reasonCode: string): RunView {
    const current = this.require(runId);
    return this.append(runId, { expectedVersion, commandId, causationId: null, process: current.acceptedBy }, "run.waiting", {
      schemaVersion: RUN_SCHEMA_VERSION, commandId, reasonCode, resumeTo: current.lifecycle, executionAuthority: "none",
    });
  }

  block(runId: string, expectedVersion: number, commandId: string, reasonCode: string): RunView {
    const current = this.require(runId);
    return this.append(runId, { expectedVersion, commandId, causationId: null, process: current.acceptedBy }, "run.blocked", {
      schemaVersion: RUN_SCHEMA_VERSION, commandId, reasonCode, resumeTo: current.lifecycle, executionAuthority: "none",
    });
  }

  resume(runId: string, expectedVersion: number, commandId: string): RunView {
    const current = this.require(runId);
    if (current.suspendedFrom === null || current.suspensionEventId === null) throw new Error("run is not suspended");
    return this.append(runId, { expectedVersion, commandId, causationId: current.suspensionEventId, process: current.acceptedBy }, "run.resumed", {
      schemaVersion: RUN_SCHEMA_VERSION, commandId, suspensionEventId: current.suspensionEventId,
      resumeTo: current.suspendedFrom, executionAuthority: "none",
    });
  }

  cancel(runId: string, context: RunCommandContext, input: { readonly cancellationId: string; readonly requestedBy: RunActor; readonly reasonCode: "operator_requested" | "service_shutdown" | "source_withdrawn" | "superseded" }): RunView {
    const current = this.require(runId);
    if (current.terminalOutcome === "cancelled") {
      const cancellation = current.cancellation!;
      const cancellationEvent = this.readStream(runId).find((event) => event.type === "run.cancelled")!;
      if (cancellation.commandId === context.commandId && cancellation.cancellationId === input.cancellationId &&
        JSON.stringify(cancellation.requestedBy) === JSON.stringify(input.requestedBy) &&
        cancellation.reasonCode === input.reasonCode && JSON.stringify(cancellation.process) === JSON.stringify(context.process) &&
        cancellationEvent.causationId === context.causationId) {
        return current;
      }
      throw new Error("run is already cancelled with different cancellation evidence");
    }
    if (current.lifecycle === "terminal") throw new Error("run is already terminal");
    return this.append(runId, context, "run.cancelled", {
      schemaVersion: RUN_SCHEMA_VERSION,
      commandId: context.commandId,
      cancellationId: input.cancellationId,
      requestedBy: RunActorSchema.parse(input.requestedBy),
      reasonCode: input.reasonCode,
      observedLifecycle: current.lifecycle,
      process: RunProcessSchema.parse(context.process),
      executionAuthority: "none",
    });
  }

  terminate(runId: string, context: RunCommandContext, outcome: Exclude<TerminalOutcome, "cancelled">, evidenceSha256: string): RunView {
    const current = this.require(runId);
    if (outcome === "completed" && current.lifecycle !== "approved_and_ready_for_execution") {
      throw new Error("run completion requires approved_and_ready_for_execution");
    }
    return this.append(runId, context, `run.${outcome}`, {
      schemaVersion: RUN_SCHEMA_VERSION, commandId: context.commandId, evidenceSha256,
      process: RunProcessSchema.parse(context.process), executionAuthority: "none",
    });
  }

  get(runId: string): RunView | null {
    return projectRun(readStreamEvents(this.journal, runStreamId(runId)));
  }

  reopen(runId: string): RunView | null {
    return this.get(runId);
  }

  readStream(runId: string): readonly StoredEvent[] {
    return readStreamEvents(this.journal, runStreamId(runId));
  }

  private appendPhase(runId: string, expectedVersion: number, commandId: string, type: string): RunView {
    return this.append(runId, { expectedVersion, commandId, causationId: null, process: this.require(runId).acceptedBy }, type, {
      schemaVersion: RUN_SCHEMA_VERSION, commandId, executionAuthority: "none",
    });
  }

  private append(runId: string, context: RunCommandContext, type: string, payload: unknown): RunView {
    const events = this.readStream(runId);
    const current = requiredProjection(events);
    const canonicalPayload = canonical(payload);
    const priorCommand = events.find((event) => commandId(event.payload) === context.commandId);
    if (priorCommand !== undefined) {
      if (priorCommand.type === type && priorCommand.causationId === context.causationId && JSON.stringify(priorCommand.payload) === JSON.stringify(canonicalPayload)) return current;
      throw new Error("run command identity was reused with different input");
    }
    if (current.lifecycle === "terminal") throw new Error("run is already terminal");
    if (context.expectedVersion !== current.streamVersion) {
      throw new Error(`expected version ${context.expectedVersion}, actual ${current.streamVersion}`);
    }
    const event = this.event(runStreamId(runId), type, canonicalPayload, context.causationId, runId);
    projectRun([...events, prospective(event, current.streamVersion + 1)]);
    const stored = this.journal.append(runStreamId(runId), context.expectedVersion, [event]);
    return requiredProjection([...events, ...stored]);
  }

  private require(runId: string): RunView {
    const run = this.get(runId);
    if (run === null) throw new Error(`run ${runId} not found`);
    return run;
  }

  private verifyServiceReady(eventId: string, process: RunProcess): void {
    const serviceReady = findAllEvent(this.journal, (candidate) => candidate.eventId === eventId);
    if (serviceReady?.type !== "service.ready" || serviceReady.streamId !== serviceStreamId(process.processIncarnation) || serviceReady.streamVersion !== 2) {
      throw new Error("run process is not bound to a valid service.ready event");
    }
    const readyPayload = ServiceReadyPayloadSchema.parse(serviceReady.payload);
    const serviceEvents = readStreamEvents(this.journal, serviceReady.streamId);
    const starting = serviceEvents[0];
    if (starting?.type !== "service.starting" || starting.streamVersion !== 1 || serviceReady.causationId !== starting.eventId) {
      throw new Error("service.ready does not follow service.starting");
    }
    const startingPayload = ServiceStartingPayloadSchema.parse(starting.payload);
    if (serviceReady.correlationId !== readyPayload.serviceId || starting.correlationId !== readyPayload.serviceId ||
      startingPayload.serviceId !== readyPayload.serviceId || JSON.stringify(readyPayload.process) !== JSON.stringify(process) ||
      JSON.stringify(startingPayload.process) !== JSON.stringify(process) || JSON.stringify(startingPayload.address) !== JSON.stringify(readyPayload.address)) {
      throw new Error("service lifecycle identity is contradictory");
    }
    if (startingPayload.observation !== readyPayload.observation) throw new Error("service lifecycle observation is contradictory");
  }

  private event(streamId: string, type: string, payload: unknown, causationId: string | null, correlationId: string): NewEvent<string, unknown> {
    return { streamId, type, payload: canonical(payload), causationId, correlationId };
  }
}

function prospective(event: NewEvent<string, unknown>, streamVersion: number): StoredEvent {
  return { ...event, eventId: `prospective-${streamVersion}`, streamVersion, globalPosition: 0, recordedAt: "1970-01-01T00:00:00.000Z" };
}

function requiredProjection(events: readonly StoredEvent[]): RunView {
  const run = projectRun(events);
  if (run === null) throw new Error("run projection unexpectedly returned null");
  return run;
}

function canonical(payload: unknown): unknown {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("run event payload must be JSON-serializable");
  return JSON.parse(serialized) as unknown;
}

function commandId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Readonly<Record<string, unknown>>)["commandId"];
  return typeof value === "string" ? value : null;
}
