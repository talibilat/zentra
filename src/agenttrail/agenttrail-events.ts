import { z } from "zod";

import type { EventJournal } from "../journal/journal.js";

export const AGENTTRAIL_EVENT_SCHEMA_VERSION = 1;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IncarnationSchema = z.string().regex(
  /^agenttrail-v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const EvidenceBaseSchema = z.strictObject({
  schemaVersion: z.literal(AGENTTRAIL_EVENT_SCHEMA_VERSION),
  executableSha256: Sha256Schema,
  manifestSha256: Sha256Schema,
  incarnation: IncarnationSchema,
  occurredAt: z.iso.datetime({ offset: true }),
});
const ProcessEvidenceSchema = EvidenceBaseSchema.extend({
  pid: z.number().int().positive(),
});

export const AgentTrailStartingEvidenceSchema = EvidenceBaseSchema.extend({
  type: z.literal("agenttrail.starting"),
  pid: z.null(),
  startupDeadlineMs: z.number().int().nonnegative(),
  tracePathSha256: Sha256Schema,
}).strict();

export const AgentTrailReadyEvidenceSchema = ProcessEvidenceSchema.extend({
  type: z.literal("agenttrail.ready"),
  address: z.strictObject({
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1).max(65_535),
  }),
  startupMs: z.number().int().nonnegative(),
}).strict();

export const AgentTrailFailedEvidenceSchema = EvidenceBaseSchema.extend({
  type: z.literal("agenttrail.failed"),
  pid: z.number().int().positive().nullable(),
  phase: z.enum(["startup", "runtime"]),
  uptimeMs: z.number().int().nonnegative(),
  failure: z.strictObject({
    code: z.enum(["readiness_timeout", "process_exit", "output_limit", "spawn_error"]),
    message: z.string().min(1).max(512),
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).max(32).nullable(),
  }),
}).strict();

export const AgentTrailRestartedEvidenceSchema = EvidenceBaseSchema.extend({
  type: z.literal("agenttrail.restarted"),
  pid: z.number().int().positive().nullable(),
  previousIncarnation: IncarnationSchema,
  restartAttempt: z.number().int().positive(),
  backoffMs: z.number().int().nonnegative(),
}).strict();

export const AgentTrailEvidenceSchema = z.discriminatedUnion("type", [
  AgentTrailStartingEvidenceSchema,
  AgentTrailReadyEvidenceSchema,
  AgentTrailFailedEvidenceSchema,
  AgentTrailRestartedEvidenceSchema,
]);

export type AgentTrailEvidence = z.infer<typeof AgentTrailEvidenceSchema>;
export type AgentTrailStartingEvidence = z.infer<typeof AgentTrailStartingEvidenceSchema>;
export type AgentTrailReadyEvidence = z.infer<typeof AgentTrailReadyEvidenceSchema>;
export type AgentTrailFailedEvidence = z.infer<typeof AgentTrailFailedEvidenceSchema>;
export type AgentTrailRestartedEvidence = z.infer<typeof AgentTrailRestartedEvidenceSchema>;

export interface AgentTrailJournalContext {
  readonly streamId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export function agentTrailStreamId(projectId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId)) {
    throw new Error("AgentTrail project ID must be a scoped ASCII identifier");
  }
  return `agenttrail:${projectId}`;
}

export class JournalAgentTrailEvidenceSink {
  private version: number;
  private causationId: string | null;
  private evidence: AgentTrailEvidence[];

  constructor(
    private readonly journal: EventJournal,
    private readonly context: AgentTrailJournalContext,
  ) {
    if (!context.streamId) {
      throw new Error("AgentTrail journal stream and correlation identities are required");
    }
    assertCorrelationId(context.correlationId);
    const retained = journal.readStream(context.streamId);
    this.evidence = validateStoredHistory(retained, {
      correlationId: context.correlationId,
      causationId: context.causationId,
    });
    this.version = retained.at(-1)?.streamVersion ?? 0;
    this.causationId = retained.at(-1)?.eventId ?? context.causationId;
  }

  record = (candidate: AgentTrailEvidence): void => {
    const evidence = AgentTrailEvidenceSchema.parse(candidate);
    validateLifecycle([...this.evidence, evidence]);
    const { type, ...payload } = evidence;
    const stored = this.journal.append(this.context.streamId, this.version, [{
      streamId: this.context.streamId,
      type,
      payload,
      causationId: this.causationId,
      correlationId: this.context.correlationId,
    }]);
    const appended = stored[0];
    if (appended === undefined) throw new Error("AgentTrail evidence append returned no stored event");
    this.version = appended.streamVersion;
    this.causationId = appended.eventId;
    this.evidence.push(evidence);
  };
}

export interface ReplayAgentTrailEvidenceOptions {
  readonly correlationId?: string;
  readonly causationId?: string | null;
}

export function replayAgentTrailEvidence(
  journal: EventJournal,
  streamId: string,
  options: ReplayAgentTrailEvidenceOptions = {},
): readonly AgentTrailEvidence[] {
  return validateStoredHistory(journal.readStream(streamId), options);
}

function validateStoredHistory(
  events: ReturnType<EventJournal["readStream"]>,
  options: ReplayAgentTrailEvidenceOptions,
): AgentTrailEvidence[] {
  const evidence: AgentTrailEvidence[] = [];
  let correlationId = options.correlationId;
  if (correlationId !== undefined) assertCorrelationId(correlationId);
  let previousEventId: string | null | undefined = options.causationId;
  for (const [index, event] of events.entries()) {
    if (event.streamId.length === 0) throw new Error("AgentTrail event stream identity is empty");
    correlationId ??= event.correlationId;
    assertCorrelationId(event.correlationId);
    if (event.correlationId !== correlationId) {
      throw new Error("AgentTrail journal correlation identity changed");
    }
    if ((index > 0 || options.causationId !== undefined) && event.causationId !== previousEventId) {
      throw new Error("AgentTrail journal causation chain is broken");
    }
    evidence.push(AgentTrailEvidenceSchema.parse({ type: event.type, ...payloadRecord(event.payload) }));
    previousEventId = event.eventId;
  }
  validateLifecycle(evidence);
  return evidence;
}

function assertCorrelationId(value: string): void {
  if (value.length === 0 || value.length > 256 || /[\u0000\r\n]/.test(value)) {
    throw new Error("AgentTrail journal correlation identity is invalid");
  }
}

function validateLifecycle(events: readonly AgentTrailEvidence[]): void {
  let state: "none" | "starting_initial" | "starting_restart" | "restarted" | "ready" | "failed" = "none";
  let incarnation: string | null = null;
  let previousFailedIncarnation: string | null = null;
  let assignedPid: number | null = null;
  const executableSha256 = events[0]?.executableSha256;
  const manifestSha256 = events[0]?.manifestSha256;
  for (const [index, event] of events.entries()) {
    if (event.executableSha256 !== executableSha256 || event.manifestSha256 !== manifestSha256) {
      throw new Error("AgentTrail package digest identity changed within the supervised stream");
    }
    if (event.type === "agenttrail.starting") {
      if (index === 0) {
        state = "starting_initial";
      } else {
        if (state !== "failed" || incarnation === event.incarnation) {
          throw new Error("AgentTrail starting event is not preceded by a different failed incarnation");
        }
        previousFailedIncarnation = incarnation;
        state = "starting_restart";
      }
      incarnation = event.incarnation;
      assignedPid = null;
      continue;
    }
    if (incarnation === null || event.incarnation !== incarnation) {
      throw new Error("AgentTrail lifecycle event has the wrong incarnation");
    }
    if (event.type === "agenttrail.restarted") {
      if (state !== "starting_restart" || event.previousIncarnation !== previousFailedIncarnation) {
        throw new Error("AgentTrail restarted event is in the wrong position or references the wrong incarnation");
      }
      assignedPid = consistentPid(assignedPid, event.pid);
      state = "restarted";
      continue;
    }
    if (event.type === "agenttrail.ready") {
      if (state !== "starting_initial" && state !== "restarted") {
        throw new Error("AgentTrail ready event is not preceded by its starting lifecycle");
      }
      assignedPid = consistentPid(assignedPid, event.pid);
      state = "ready";
      continue;
    }
    if (event.phase === "startup") {
      if (state !== "starting_initial" && state !== "restarted") {
        throw new Error("AgentTrail startup failure occurred after readiness or in the wrong position");
      }
    } else if (state !== "ready" || event.pid === null) {
      throw new Error("AgentTrail runtime failure occurred before readiness or without a process identity");
    }
    assignedPid = consistentPid(assignedPid, event.pid);
    state = "failed";
  }
}

function consistentPid(assigned: number | null, candidate: number | null): number | null {
  if (candidate === null) return assigned;
  if (assigned !== null && candidate !== assigned) {
    throw new Error("AgentTrail process identity changed within an incarnation");
  }
  return candidate;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("AgentTrail journal payload must be an object");
  }
  return payload as Record<string, unknown>;
}
