import {
  JournalAgentTrailEvidenceSink,
  agentTrailStreamId,
} from "../../src/agenttrail/agenttrail-events.js";
import type { EventJournal } from "../../src/journal/journal.js";

export function seedAgentTrailReady(
  journal: EventJournal,
  input: { readonly serviceId: string; readonly serviceStartingEventId: string; readonly seed?: string },
) {
  const seed = input.seed ?? "1";
  const incarnation = `agenttrail-v1:${seed.repeat(8)}-${seed.repeat(4)}-4${seed.repeat(3)}-8${seed.repeat(3)}-${seed.repeat(12)}`;
  const streamId = agentTrailStreamId(`fixture:${input.serviceId}:${seed}`);
  const sink = new JournalAgentTrailEvidenceSink(journal, {
    streamId,
    correlationId: input.serviceId,
    causationId: input.serviceStartingEventId,
  });
  const base = {
    schemaVersion: 1 as const,
    executableSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    incarnation,
    occurredAt: "2026-07-19T12:00:00.000Z",
  };
  sink.record({ type: "agenttrail.starting", ...base, pid: null, startupDeadlineMs: 60_000,
    tracePathSha256: "c".repeat(64) });
  sink.record({ type: "agenttrail.ready", ...base, pid: 987,
    address: { host: "127.0.0.1", port: 45_678 }, startupMs: 10 });
  return {
    agentTrailStreamId: streamId,
    agentTrailReadyEventId: journal.readStream(streamId).at(-1)!.eventId,
    agentTrailIncarnation: incarnation,
  };
}
