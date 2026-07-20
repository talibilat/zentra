import type { StoredEvent } from "../contracts/event.js";
import { readStreamEvents, type EventJournal } from "../journal/journal.js";
import {
  AgentTrailReadyEvidenceSchema,
  replayAgentTrailEvidence,
} from "../agenttrail/agenttrail-events.js";
import {
  RUN_SCHEMA_VERSION,
  ServiceReadyPayloadSchema,
  ServiceShutdownPayloadSchema,
  ServiceStartingPayloadSchema,
  ServiceStoppingPayloadSchema,
  serviceStreamId,
  type RunProcess,
} from "./run-contracts.js";

export class ServiceLifecycleService {
  constructor(private readonly journal: EventJournal) {}

  start(input: {
    readonly serviceId: string;
    readonly process: RunProcess;
    readonly address: { readonly host: "127.0.0.1"; readonly port: number };
    readonly tokenExpiresAt: string;
    readonly observation: "performed" | "reconciled";
    readonly commandId: string;
  }): StoredEvent {
    const streamId = serviceStreamId(input.process.processIncarnation);
    const existing = readStreamEvents(this.journal, streamId);
    if (existing.length > 0) {
      const payload = ServiceStartingPayloadSchema.parse(existing[0]!.payload);
      const expected = ServiceStartingPayloadSchema.parse({ schemaVersion: RUN_SCHEMA_VERSION, ...input });
      if (payload.commandId === input.commandId && JSON.stringify(payload) === JSON.stringify(expected)) return existing[0]!;
      throw new Error("service process incarnation already started");
    }
    const payload = ServiceStartingPayloadSchema.parse({ schemaVersion: RUN_SCHEMA_VERSION, ...input });
    return this.journal.append(streamId, 0, [{
      streamId, type: "service.starting", payload, causationId: null, correlationId: input.serviceId,
    }])[0]!;
  }

  ready(input: {
    readonly serviceId: string;
    readonly process: RunProcess;
    readonly address: { readonly host: "127.0.0.1"; readonly port: number };
    readonly runtimeSchemaVersion: number;
    readonly journalSchemaVersion: number;
    readonly tokenExpiresAt: string;
    readonly agentTrailStreamId: string;
    readonly agentTrailReadyEventId: string;
    readonly agentTrailIncarnation: string;
    readonly observation: "performed" | "reconciled";
    readonly commandId: string;
    readonly causationId: string;
  }): StoredEvent {
    const streamId = serviceStreamId(input.process.processIncarnation);
    const existing = readStreamEvents(this.journal, streamId);
    const prior = existing.find((event) => event.type === "service.ready");
    if (prior !== undefined) {
      const payload = ServiceReadyPayloadSchema.parse(prior.payload);
      const { causationId: _causationId, ...untrustedPayload } = input;
      const expected = ServiceReadyPayloadSchema.parse({ schemaVersion: RUN_SCHEMA_VERSION, ...untrustedPayload });
      if (payload.commandId === input.commandId && prior.causationId === input.causationId && JSON.stringify(payload) === JSON.stringify(expected)) {
        const starting = existing[0];
        if (starting?.type !== "service.starting") throw new Error("service.ready is missing service.starting evidence");
        verifyAgentTrailReady(this.journal, {
          serviceId: payload.serviceId,
          serviceStartingEventId: starting.eventId,
          agentTrailStreamId: payload.agentTrailStreamId,
          agentTrailReadyEventId: payload.agentTrailReadyEventId,
          agentTrailIncarnation: payload.agentTrailIncarnation,
          causationId: prior.causationId,
        });
        return prior;
      }
      throw new Error("service process incarnation is already ready");
    }
    if (existing.length !== 1 || existing[0]!.type !== "service.starting") {
      throw new Error("service.ready requires its durable service.starting event");
    }
    const starting = ServiceStartingPayloadSchema.parse(existing[0]!.payload);
    if (starting.serviceId !== input.serviceId || JSON.stringify(starting.process) !== JSON.stringify(input.process) ||
      JSON.stringify(starting.address) !== JSON.stringify(input.address) || starting.observation !== input.observation) {
      throw new Error("service.ready contradicts service.starting identity");
    }
    verifyAgentTrailReady(this.journal, {
      serviceId: input.serviceId,
      serviceStartingEventId: existing[0]!.eventId,
      agentTrailStreamId: input.agentTrailStreamId,
      agentTrailReadyEventId: input.agentTrailReadyEventId,
      agentTrailIncarnation: input.agentTrailIncarnation,
      causationId: input.causationId,
    });
    const { causationId, ...untrustedPayload } = input;
    const payload = ServiceReadyPayloadSchema.parse({ schemaVersion: RUN_SCHEMA_VERSION, ...untrustedPayload });
    return this.journal.append(streamId, 1, [{
      streamId, type: "service.ready", payload, causationId, correlationId: input.serviceId,
    }])[0]!;
  }

  shutdown(input: {
    readonly serviceId: string;
    readonly process: RunProcess;
    readonly outcome: "completed" | "failed";
    readonly reasonCode: "signal" | "operator_requested" | "startup_failed" | "internal_failure" | "test_requested";
    readonly occurredAt: string;
    readonly commandId: string;
    readonly observation?: "performed" | "reconciled";
  }): StoredEvent {
    const streamId = serviceStreamId(input.process.processIncarnation);
    const existing = readStreamEvents(this.journal, streamId);
    const prior = existing.find((event) => event.type === "service.shutdown");
    const payload = ServiceShutdownPayloadSchema.parse({
      schemaVersion: RUN_SCHEMA_VERSION,
      ...input,
      observation: input.observation ?? "performed",
    });
    if (prior !== undefined) {
      if (JSON.stringify(ServiceShutdownPayloadSchema.parse(prior.payload)) === JSON.stringify(payload)) return prior;
      throw new Error("service process incarnation is already shut down");
    }
    const cause = existing.at(-1);
    if (cause?.type !== "service.stopping") {
      throw new Error("service.shutdown requires durable service.stopping evidence");
    }
    if (existing.some((event) => event.correlationId !== input.serviceId)) {
      throw new Error("service.shutdown contradicts service correlation identity");
    }
    const priorProcess = ServiceStoppingPayloadSchema.parse(cause.payload);
    if (priorProcess.serviceId !== input.serviceId || JSON.stringify(priorProcess.process) !== JSON.stringify(input.process)) {
      throw new Error("service.shutdown contradicts service process identity");
    }
    return this.journal.append(streamId, cause.streamVersion, [{
      streamId, type: "service.shutdown", payload, causationId: cause.eventId, correlationId: input.serviceId,
    }])[0]!;
  }

  beginShutdown(input: {
    readonly serviceId: string;
    readonly process: RunProcess;
    readonly occurredAt: string;
    readonly commandId: string;
    readonly observation?: "performed" | "reconciled";
  }): StoredEvent {
    const streamId = serviceStreamId(input.process.processIncarnation);
    const existing = readStreamEvents(this.journal, streamId);
    const prior = existing.find((event) => event.type === "service.stopping");
    const payload = ServiceStoppingPayloadSchema.parse({
      schemaVersion: RUN_SCHEMA_VERSION,
      ...input,
      observation: input.observation ?? "performed",
    });
    if (prior !== undefined) {
      if (JSON.stringify(ServiceStoppingPayloadSchema.parse(prior.payload)) === JSON.stringify(payload)) return prior;
      throw new Error("service process incarnation is already stopping");
    }
    const cause = existing.at(-1);
    if (cause === undefined || (cause.type !== "service.starting" && cause.type !== "service.ready")) {
      throw new Error("service.stopping requires the latest service.starting or service.ready event");
    }
    const priorProcess = cause.type === "service.starting"
      ? ServiceStartingPayloadSchema.parse(cause.payload)
      : ServiceReadyPayloadSchema.parse(cause.payload);
    if (priorProcess.serviceId !== input.serviceId || JSON.stringify(priorProcess.process) !== JSON.stringify(input.process) ||
      existing.some((event) => event.correlationId !== input.serviceId)) {
      throw new Error("service.stopping contradicts service identity");
    }
    return this.journal.append(streamId, cause.streamVersion, [{
      streamId,
      type: "service.stopping",
      payload,
      causationId: cause.eventId,
      correlationId: input.serviceId,
    }])[0]!;
  }

  reconcileStale(input: {
    readonly stalePid: number;
    readonly staleProcessIncarnation: string;
    readonly detectedAt: string;
    readonly commandId: string;
  }): StoredEvent | null {
    const streamId = serviceStreamId(input.staleProcessIncarnation);
    const existing = readStreamEvents(this.journal, streamId);
    if (existing.length === 0) return null;
    const starting = existing[0];
    if (starting?.type !== "service.starting") throw new Error("stale service stream is missing service.starting");
    const startingPayload = ServiceStartingPayloadSchema.parse(starting.payload);
    if (startingPayload.process.pid !== input.stalePid ||
      startingPayload.process.processIncarnation !== input.staleProcessIncarnation) {
      throw new Error("stale runtime evidence contradicts durable service process identity");
    }
    const priorShutdown = existing.find((event) => event.type === "service.shutdown");
    if (priorShutdown !== undefined) {
      const payload = ServiceShutdownPayloadSchema.parse(priorShutdown.payload);
      if (JSON.stringify(payload.process) !== JSON.stringify(startingPayload.process)) {
        throw new Error("stale service shutdown process identity is contradictory");
      }
      return priorShutdown;
    }
    this.beginShutdown({
      serviceId: startingPayload.serviceId,
      process: startingPayload.process,
      observation: "reconciled",
      occurredAt: input.detectedAt,
      commandId: `${input.commandId}-stopping`,
    });
    return this.shutdown({
      serviceId: startingPayload.serviceId,
      process: startingPayload.process,
      outcome: "failed",
      reasonCode: "internal_failure",
      observation: "reconciled",
      occurredAt: input.detectedAt,
      commandId: input.commandId,
    });
  }
}

export function verifyAgentTrailReady(
  journal: EventJournal,
  input: {
    readonly serviceId: string;
    readonly serviceStartingEventId: string;
    readonly agentTrailStreamId: string;
    readonly agentTrailReadyEventId: string;
    readonly agentTrailIncarnation: string;
    readonly causationId: string | null;
  },
): StoredEvent {
  if (input.causationId !== input.agentTrailReadyEventId) {
    throw new Error("service.ready causation must be the exact AgentTrail ready event");
  }
  replayAgentTrailEvidence(journal, input.agentTrailStreamId, {
    correlationId: input.serviceId,
    causationId: input.serviceStartingEventId,
  });
  const ready = readStreamEvents(journal, input.agentTrailStreamId)
    .find(({ eventId }) => eventId === input.agentTrailReadyEventId);
  if (ready?.type !== "agenttrail.ready" || ready.correlationId !== input.serviceId) {
    throw new Error("service.ready references missing or wrong AgentTrail readiness evidence");
  }
  const payload = AgentTrailReadyEvidenceSchema.parse({
    type: ready.type,
    ...(ready.payload as Record<string, unknown>),
  });
  if (payload.incarnation !== input.agentTrailIncarnation) {
    throw new Error("service.ready references the wrong AgentTrail incarnation");
  }
  return ready;
}
