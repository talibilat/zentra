import { createHash } from "node:crypto";

import type { NewEvent, StoredEvent } from "../contracts/event.js";
import type { TerminalOutcome } from "../contracts/task.js";
import { findAllEvent, readStreamEvents, type EventJournal } from "../journal/journal.js";
import {
  RUN_SCHEMA_VERSION,
  IntakeClosureReferenceSchema,
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
  type IntakeClosureReference,
  type RunActor,
  type RunBudget,
  type RunProcess,
  type RunSource,
} from "./run-contracts.js";
import {
  IntakeSnapshotClosedPayloadSchema,
  SourceDiscoveredPayloadSchema,
  SourceRejectedPayloadSchema,
  computeIntakeArtifactAggregateSha256,
  computeIntakeSnapshotSha256,
} from "../intake/intake-contracts.js";
import {
  consumeAndVerifyIntakeArtifacts,
} from "../intake/intake-artifact-store.js";
import { consumeAnalysisCompletion, type AnalysisCompletionCapability } from "../analysis/analysis-completion.js";
import { projectRun, type RunView } from "./run-projection.js";
import { verifyAgentTrailReady } from "./service-lifecycle.js";

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

  completeIntake(
    runId: string,
    expectedVersion: number,
    commandId: string,
    intake: IntakeClosureReference,
  ): RunView {
    const current = this.require(runId);
    if (current.lifecycle === "terminal") throw new Error("run is already terminal");
    if (current.lifecycle !== "intake") throw new Error(`invalid run transition ${current.lifecycle} -> run.intake_completed`);
    const verified = this.verifyIntakeClosure(current, intake);
    return this.append(runId, {
      expectedVersion,
      commandId,
      causationId: verified.closureEventId,
      process: current.activeProcess,
    }, "run.intake_completed", {
      schemaVersion: RUN_SCHEMA_VERSION,
      commandId,
      intake: verified,
      executionAuthority: "none",
    });
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

  completeAnalysis(
    runId: string,
    expectedVersion: number,
    commandId: string,
    analysisCompletionCapability: AnalysisCompletionCapability,
  ): RunView {
    const current = this.require(runId);
    if (current.lifecycle !== "analyzing") throw new Error(`invalid run transition ${current.lifecycle} -> run.analysis_completed`);
    const intakeEvent = this.readStream(runId).find((event) => event.type === "run.intake_completed");
    if (intakeEvent === undefined || typeof intakeEvent.payload !== "object" || intakeEvent.payload === null) {
      throw new Error("analysis requires durable intake closure evidence");
    }
    const intake = IntakeClosureReferenceSchema.parse(
      (intakeEvent.payload as Readonly<Record<string, unknown>>)["intake"],
    );
    const verified = this.verifyIntakeClosure(current, intake);
    const analysisVerification = consumeAnalysisCompletion(analysisCompletionCapability);
    if (analysisVerification.runId !== runId) throw new Error("analysis completion evidence belongs to a different run");
    const completionEvent = findAllEvent(this.journal, (event) => event.eventId === analysisVerification.completionEventId);
    if (completionEvent?.streamId !== analysisVerification.analysisStreamId || completionEvent.type !== "analysis.completed" ||
      completionEvent.correlationId !== runId) throw new Error("analysis completion event is missing or incorrectly bound");
    const artifactVerification = consumeAndVerifyIntakeArtifacts(analysisVerification.intakeArtifactVerification);
    if (artifactVerification.runId !== runId
      || artifactVerification.snapshotSha256 !== verified.snapshotSha256
      || artifactVerification.sourceStreamId !== verified.sourceStreamId
      || artifactVerification.closureEventId !== verified.closureEventId
      || artifactVerification.artifactAggregateSha256 !== this.intakeArtifactAggregate(verified.sourceStreamId)
      || artifactVerification.retainedSourceAggregateSha256 !== analysisVerification.sourceEvidenceSha256) {
      throw new Error("verified intake artifact evidence does not match the durable closure");
    }
    return this.append(runId, {
      expectedVersion,
      commandId,
      causationId: completionEvent.eventId,
      process: current.activeProcess,
    }, "run.analysis_completed", {
      schemaVersion: RUN_SCHEMA_VERSION,
      commandId,
      intake: verified,
      analysisStreamId: analysisVerification.analysisStreamId,
      analysisCompletionEventId: completionEvent.eventId,
      analysisEvidenceSha256: analysisVerification.evidenceSha256,
      sourceEvidenceSha256: analysisVerification.sourceEvidenceSha256,
      executionAuthority: "none",
    });
  }

  requestApproval(runId: string, expectedVersion: number, commandId: string, input: { readonly planDigest: string; readonly envelopeDigest: string }): RunView {
    return this.append(runId, { expectedVersion, commandId, causationId: null, process: this.require(runId).acceptedBy }, "run.approval_requested", {
      schemaVersion: RUN_SCHEMA_VERSION, commandId, ...input, executionAuthority: "none",
    });
  }

  revisePlan(runId: string, expectedVersion: number, commandId: string): RunView {
    const events = this.readStream(runId);
    const priorApproval = events.at(-1);
    if (priorApproval?.type !== "run.approval_requested") {
      throw new Error("run plan revision requires the current approval request event");
    }
    return this.append(runId, {
      expectedVersion, commandId, causationId: priorApproval.eventId, process: this.require(runId).acceptedBy,
    }, "run.plan_revised", {
      schemaVersion: RUN_SCHEMA_VERSION,
      commandId,
      priorApprovalRequestEventId: priorApproval.eventId,
      executionAuthority: "none",
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

  private verifyIntakeClosure(run: RunView, input: IntakeClosureReference): IntakeClosureReference {
    const intake = IntakeClosureReferenceSchema.parse(input);
    const expectedStreamId = `source-intake:${createHash("sha256").update(run.runId).digest("hex")}`;
    if (intake.sourceStreamId !== expectedStreamId) throw new Error("intake closure source stream identity is invalid");
    const closure = findAllEvent(this.journal, (event) => event.eventId === intake.closureEventId);
    if (closure?.type !== "intake.snapshot_closed"
      || closure.streamId !== intake.sourceStreamId
      || closure.correlationId !== run.runId) {
      throw new Error("intake closure evidence is missing or incorrectly bound");
    }
    const payload = IntakeSnapshotClosedPayloadSchema.parse(closure.payload);
    if (payload.runId !== run.runId
      || payload.projectId !== run.projectId
      || JSON.stringify(payload.projectRevision) !== JSON.stringify(run.projectRevision)
      || payload.snapshotSha256 !== intake.snapshotSha256
      || payload.sourceCount !== intake.sourceCount
      || payload.rejectedCount !== intake.rejectedCount
      || payload.totalBytes !== intake.totalBytes) {
      throw new Error("intake closure evidence contradicts the authoritative run");
    }
    const sourceEvents = readStreamEvents(this.journal, intake.sourceStreamId);
    if (sourceEvents.length !== payload.evidenceCount + 1 || sourceEvents.at(-1)?.eventId !== closure.eventId) {
      throw new Error("intake closure does not cover the complete source evidence stream");
    }
    const evidence = sourceEvents.slice(0, -1);
    if (evidence.length === 0) throw new Error("intake closure cannot cover empty source evidence");
    const discovered = evidence.filter((event) => event.type === "source.discovered")
      .map((event) => SourceDiscoveredPayloadSchema.parse(event.payload));
    const rejected = evidence.filter((event) => event.type === "source.rejected")
      .map((event) => SourceRejectedPayloadSchema.parse(event.payload));
    if (discovered.length !== payload.sourceCount
      || rejected.length !== payload.rejectedCount
      || discovered.length + rejected.length !== evidence.length) {
      throw new Error("intake closure source counts contradict durable evidence");
    }
    if (discovered.length === 0) throw new Error("intake closure requires at least one accepted source");
    const parsed = evidence.map((event) => event.type === "source.discovered"
      ? { type: event.type, payload: SourceDiscoveredPayloadSchema.parse(event.payload) }
      : { type: event.type, payload: SourceRejectedPayloadSchema.parse(event.payload) });
    const rootIdentitySha256 = parsed[0]?.payload.provenance.rootIdentitySha256;
    for (let index = 0; index < parsed.length; index += 1) {
      const item = parsed[index]!;
      const itemPayload = item.payload;
      if (itemPayload.runId !== run.runId
        || itemPayload.projectId !== run.projectId
        || itemPayload.commandId !== payload.commandId
        || itemPayload.requestSha256 !== payload.requestSha256
        || itemPayload.eventIndex !== index
        || itemPayload.evidenceCount !== evidence.length
        || itemPayload.sourceKind !== payload.sourceKind
        || itemPayload.snapshotTotalBytes !== payload.totalBytes
        || JSON.stringify(itemPayload.limits) !== JSON.stringify(payload.limits)
        || itemPayload.provenance.runId !== run.runId
        || itemPayload.provenance.projectId !== run.projectId
        || itemPayload.provenance.sourceKind !== payload.sourceKind
        || itemPayload.provenance.rootIdentitySha256 !== rootIdentitySha256
        || JSON.stringify(itemPayload.provenance.projectRevision) !== JSON.stringify(run.projectRevision)) {
        throw new Error("intake evidence payload contradicts the durable closure");
      }
      if (index > 0) {
        const prior = parsed[index - 1]!;
        const order = prior.payload.path === itemPayload.path
          ? prior.type < item.type ? -1 : prior.type > item.type ? 1 : 0
          : prior.payload.path < itemPayload.path ? -1 : 1;
        if (order >= 0) throw new Error("intake evidence order is not deterministic");
      }
    }
    const totalBytes = discovered.reduce((sum, item) => sum + item.sizeBytes, 0)
      + rejected.reduce((sum, item) => sum + item.bytesRead, 0);
    if (totalBytes !== payload.totalBytes) throw new Error("intake closure byte total contradicts durable evidence");
    const recomputedSnapshotSha256 = computeIntakeSnapshotSha256({
      closure: {
        schemaVersion: payload.schemaVersion,
        runId: payload.runId,
        projectId: payload.projectId,
        projectRevision: payload.projectRevision,
        commandId: payload.commandId,
        requestSha256: payload.requestSha256,
        sourceKind: payload.sourceKind,
        limits: payload.limits,
        totalBytes: payload.totalBytes,
      },
      discovered,
      rejected,
    });
    if (payload.snapshotSha256 !== recomputedSnapshotSha256) {
      throw new Error("intake closure snapshot digest contradicts canonical durable evidence");
    }
    const preflight = this.readStream(run.runId).findLast((event) => event.type === "preflight.completed");
    for (let index = 0; index < sourceEvents.length; index += 1) {
      const event = sourceEvents[index]!;
      const expectedCause = index === 0 ? preflight?.eventId : sourceEvents[index - 1]!.eventId;
      if (event.streamId !== intake.sourceStreamId
        || event.streamVersion !== index + 1
        || event.correlationId !== run.runId
        || event.causationId !== expectedCause) {
        throw new Error("intake evidence causal chain contradicts the authoritative run");
      }
    }
    return intake;
  }

  private intakeArtifactAggregate(sourceStreamId: string): string {
    const discovered = readStreamEvents(this.journal, sourceStreamId)
      .filter((event) => event.type === "source.discovered")
      .map((event) => SourceDiscoveredPayloadSchema.parse(event.payload));
    return computeIntakeArtifactAggregateSha256(discovered.map((source) => ({
      sourceId: source.sourceId,
      relativePath: source.path,
      artifact: source.artifact,
    })));
  }

  private verifyServiceReady(eventId: string, process: RunProcess): void {
    const serviceReady = findAllEvent(this.journal, (candidate) => candidate.eventId === eventId);
    if (serviceReady?.type !== "service.ready" || serviceReady.streamId !== serviceStreamId(process.processIncarnation) || serviceReady.streamVersion !== 2) {
      throw new Error("run process is not bound to a valid service.ready event");
    }
    const readyPayload = ServiceReadyPayloadSchema.parse(serviceReady.payload);
    const serviceEvents = readStreamEvents(this.journal, serviceReady.streamId);
    if (serviceEvents.at(-1)?.eventId !== serviceReady.eventId) {
      throw new Error("service.ready is not the latest active service lifecycle event after shutdown");
    }
    const starting = serviceEvents[0];
    if (starting?.type !== "service.starting" || starting.streamVersion !== 1) {
      throw new Error("service.ready does not follow service.starting");
    }
    const startingPayload = ServiceStartingPayloadSchema.parse(starting.payload);
    if (serviceReady.correlationId !== readyPayload.serviceId || starting.correlationId !== readyPayload.serviceId ||
      startingPayload.serviceId !== readyPayload.serviceId || JSON.stringify(readyPayload.process) !== JSON.stringify(process) ||
      JSON.stringify(startingPayload.process) !== JSON.stringify(process) || JSON.stringify(startingPayload.address) !== JSON.stringify(readyPayload.address)) {
      throw new Error("service lifecycle identity is contradictory");
    }
    if (startingPayload.observation !== readyPayload.observation) throw new Error("service lifecycle observation is contradictory");
    verifyAgentTrailReady(this.journal, {
      serviceId: readyPayload.serviceId,
      serviceStartingEventId: starting.eventId,
      agentTrailStreamId: readyPayload.agentTrailStreamId,
      agentTrailReadyEventId: readyPayload.agentTrailReadyEventId,
      agentTrailIncarnation: readyPayload.agentTrailIncarnation,
      causationId: serviceReady.causationId,
    });
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
