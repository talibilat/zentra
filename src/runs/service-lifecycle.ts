import type { StoredEvent } from "../contracts/event.js";
import { readStreamEvents, type EventJournal } from "../journal/journal.js";
import {
  RUN_SCHEMA_VERSION,
  ServiceReadyPayloadSchema,
  ServiceStartingPayloadSchema,
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
      if (payload.commandId === input.commandId && prior.causationId === input.causationId && JSON.stringify(payload) === JSON.stringify(expected)) return prior;
      throw new Error("service process incarnation is already ready");
    }
    if (existing.length !== 1 || existing[0]!.type !== "service.starting" || existing[0]!.eventId !== input.causationId) {
      throw new Error("service.ready requires its durable service.starting event");
    }
    const starting = ServiceStartingPayloadSchema.parse(existing[0]!.payload);
    if (starting.serviceId !== input.serviceId || JSON.stringify(starting.process) !== JSON.stringify(input.process) ||
      JSON.stringify(starting.address) !== JSON.stringify(input.address) || starting.observation !== input.observation) {
      throw new Error("service.ready contradicts service.starting identity");
    }
    const { causationId, ...untrustedPayload } = input;
    const payload = ServiceReadyPayloadSchema.parse({ schemaVersion: RUN_SCHEMA_VERSION, ...untrustedPayload });
    return this.journal.append(streamId, 1, [{
      streamId, type: "service.ready", payload, causationId, correlationId: input.serviceId,
    }])[0]!;
  }
}
