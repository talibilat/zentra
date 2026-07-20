import { describe, expect, it } from "vitest";

import {
  JournalAgentTrailEvidenceSink,
  agentTrailStreamId,
} from "../../src/agenttrail/agenttrail-events.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import {
  GatewayLifecycleService,
  replayGatewayLifecycle,
} from "../../src/gateway/gateway-events.js";
import {
  replayServiceAttention,
} from "../../src/gateway/service-attention.js";

const correlationId = "service-session-1";
const processIncarnation = `process-v2:${"a".repeat(64)}`;
const firstIncarnation = "agenttrail-v1:11111111-1111-4111-8111-111111111111";
const secondIncarnation = "agenttrail-v1:22222222-2222-4222-8222-222222222222";

describe("gateway lifecycle evidence", () => {
  it("replays exact cross-stream degraded, target, and recovered evidence", () => {
    const fixture = lifecycleFixture();
    const [degraded] = fixture.lifecycle.degradeAndRaiseCritical({
      attentionId: "agenttrail-critical-1",
      agentTrailIncarnation: firstIncarnation,
      agentTrailFailureEventId: fixture.failedId,
      tracePathSha256: "b".repeat(64),
      occurredAt: "2026-07-19T12:00:00.000Z",
    });
    fixture.lifecycle.targetBackfill({
      failedAgentTrailIncarnation: firstIncarnation,
      replacementAgentTrailIncarnation: secondIncarnation,
      agentTrailStartingEventId: fixture.replacementStartingId,
      tracePathSha256: "b".repeat(64),
      target: {
        strategy: "journal_projection_high_water",
        throughPosition: fixture.replacementStartingPosition,
      },
      occurredAt: "2026-07-19T12:00:00.500Z",
    });
    fixture.lifecycle.recovered({
      failedAgentTrailIncarnation: firstIncarnation,
      readyAgentTrailIncarnation: secondIncarnation,
      agentTrailReadyEventId: fixture.replacementReadyId,
      tracePathSha256: "b".repeat(64),
      target: {
        strategy: "journal_projection_high_water",
        throughPosition: fixture.replacementStartingPosition,
      },
      occurredAt: "2026-07-19T12:00:01.000Z",
    });

    const replay = replayGatewayLifecycle(fixture.journal, fixture.lifecycle.streamId, fixture.identity);
    expect(replay.map(({ type }) => type)).toEqual([
      "gateway.degraded", "service.critical_attention", "gateway.backfill_target", "gateway.recovered",
    ]);
    expect(replay[2]).toMatchObject({
      target: {
        strategy: "journal_projection_high_water",
        throughPosition: fixture.replacementStartingPosition,
      },
    });
    expect(fixture.journal.readStream(fixture.lifecycle.streamId)[0]?.causationId).toBe(fixture.failedId);
    expect(fixture.journal.readStream(fixture.lifecycle.streamId)[1]?.causationId).toBe(fixture.failedId);
    expect(fixture.journal.readStream(fixture.lifecycle.streamId)[2]?.causationId).toBe(degraded.eventId);

    const gatewayEvents = fixture.journal.readStream(fixture.lifecycle.streamId);
    const recovered = gatewayEvents.at(-1)!;
    const tampered = [
      ...gatewayEvents.slice(0, -1),
      { ...recovered, payload: { ...(recovered.payload as Record<string, unknown>),
        agentTrailReadyEventId: fixture.initialReadyId } },
    ];
    expect(() => replayGatewayLifecycle(
      journalOverlay(fixture.journal, fixture.lifecycle.streamId, tampered),
      fixture.lifecycle.streamId,
      fixture.identity,
    )).toThrow(/incarnation|ready event/i);
    fixture.journal.close();
  });

  it("rejects nonexistent, wrong-type, wrong-incarnation, and wrong-correlation cross-stream references", () => {
    const fixture = lifecycleFixture();
    const base = {
      agentTrailIncarnation: firstIncarnation,
      tracePathSha256: "b".repeat(64),
      occurredAt: "2026-07-19T12:00:00.000Z",
    };
    expect(() => fixture.lifecycle.degradeAndRaiseCritical({ ...base, attentionId: "critical-1", agentTrailFailureEventId: "missing" }))
      .toThrow(/failure event|does not exist/i);
    expect(() => fixture.lifecycle.degradeAndRaiseCritical({ ...base, attentionId: "critical-1", agentTrailFailureEventId: fixture.initialReadyId }))
      .toThrow(/failure event/i);
    expect(() => fixture.lifecycle.degradeAndRaiseCritical({
      ...base,
      attentionId: "critical-1",
      agentTrailIncarnation: secondIncarnation,
      agentTrailFailureEventId: fixture.failedId,
    })).toThrow(/incarnation/i);

    const storedFailure = fixture.journal.readStream(fixture.agentTrailStream).find(({ eventId }) => eventId === fixture.failedId)!;
    const wrongCorrelationJournal = journalOverlay(fixture.journal, fixture.agentTrailStream, [
      ...fixture.journal.readStream(fixture.agentTrailStream).filter(({ eventId }) => eventId !== fixture.failedId),
      { ...storedFailure, correlationId: "wrong-correlation" },
    ].sort((left, right) => left.streamVersion - right.streamVersion));
    expect(() => new GatewayLifecycleService(wrongCorrelationJournal, fixture.identity).degradeAndRaiseCritical({
      ...base,
      attentionId: "critical-1",
      agentTrailFailureEventId: fixture.failedId,
    })).toThrow(/correlation/i);

    const agentTrailEvents = fixture.journal.readStream(fixture.agentTrailStream);
    const wrongInitialCause = journalOverlay(fixture.journal, fixture.agentTrailStream, [
      { ...agentTrailEvents[0]!, causationId: "wrong-service-starting" },
      ...agentTrailEvents.slice(1),
    ]);
    expect(() => new GatewayLifecycleService(wrongInitialCause, fixture.identity)).toThrow(/causation/i);
    fixture.journal.close();
  });

  it("raises one durable critical service attention per failed incarnation", () => {
    const fixture = lifecycleFixture();
    const first = fixture.lifecycle.degradeAndRaiseCritical({
      attentionId: "agenttrail-critical-1",
      agentTrailIncarnation: firstIncarnation,
      agentTrailFailureEventId: fixture.failedId,
      tracePathSha256: "b".repeat(64),
      occurredAt: "2026-07-19T12:00:00.000Z",
    });
    const repeated = fixture.lifecycle.degradeAndRaiseCritical({
      attentionId: "agenttrail-critical-1",
      agentTrailIncarnation: firstIncarnation,
      agentTrailFailureEventId: fixture.failedId,
      tracePathSha256: "b".repeat(64),
      occurredAt: "2026-07-19T12:00:00.000Z",
    });

    expect(repeated.map(({ eventId }) => eventId)).toEqual(first.map(({ eventId }) => eventId));
    expect(replayServiceAttention(fixture.journal, fixture.lifecycle.streamId, fixture.identity)).toEqual([
      expect.objectContaining({
        type: "service.critical_attention",
        source: "agenttrail",
        classification: "critical",
        authority: "none",
        agentTrailFailureEventId: fixture.failedId,
      }),
    ]);
    expect(fixture.journal.readStream(fixture.lifecycle.streamId)[1]?.causationId).toBe(fixture.failedId);
    fixture.journal.close();
  });
});

function lifecycleFixture() {
  const journal = new SqliteEventJournal(":memory:");
  const agentTrailStream = agentTrailStreamId("project-1:service-1");
  const sink = new JournalAgentTrailEvidenceSink(journal, {
    streamId: agentTrailStream,
    correlationId,
    causationId: "service-starting-1",
  });
  const identity = {
    serviceId: "zentra-local",
    processIncarnation,
    correlationId,
    agentTrailStreamId: agentTrailStream,
    serviceStartingEventId: "service-starting-1",
  };
  const base = { schemaVersion: 1 as const, executableSha256: "a".repeat(64), manifestSha256: "b".repeat(64) };
  sink.record({ type: "agenttrail.starting", ...base, incarnation: firstIncarnation,
    occurredAt: "2026-07-19T12:00:00.000Z", pid: null, startupDeadlineMs: 60_000,
    tracePathSha256: "d".repeat(64) });
  sink.record({ type: "agenttrail.ready", ...base, incarnation: firstIncarnation,
    occurredAt: "2026-07-19T12:00:00.100Z", pid: 101,
    address: { host: "127.0.0.1", port: 8080 }, startupMs: 10 });
  const initialReadyId = journal.readStream(agentTrailStream).at(-1)!.eventId;
  sink.record({ type: "agenttrail.failed", ...base, incarnation: firstIncarnation,
    occurredAt: "2026-07-19T12:00:00.200Z", pid: 101, phase: "runtime", uptimeMs: 10,
    failure: { code: "process_exit", message: "exited", exitCode: 1, signal: null } });
  const failedId = journal.readStream(agentTrailStream).at(-1)!.eventId;
  sink.record({ type: "agenttrail.starting", ...base, incarnation: secondIncarnation,
    occurredAt: "2026-07-19T12:00:00.300Z", pid: null, startupDeadlineMs: 60_000,
    tracePathSha256: "d".repeat(64) });
  const replacementStartingId = journal.readStream(agentTrailStream).at(-1)!.eventId;
  const replacementStartingPosition = journal.readStream(agentTrailStream).at(-1)!.globalPosition;
  sink.record({ type: "agenttrail.restarted", ...base, incarnation: secondIncarnation,
    occurredAt: "2026-07-19T12:00:00.400Z", pid: 102, previousIncarnation: firstIncarnation,
    restartAttempt: 1, backoffMs: 10 });
  sink.record({ type: "agenttrail.ready", ...base, incarnation: secondIncarnation,
    occurredAt: "2026-07-19T12:00:00.500Z", pid: 102,
    address: { host: "127.0.0.1", port: 8081 }, startupMs: 10 });
  const replacementReadyId = journal.readStream(agentTrailStream).at(-1)!.eventId;
  return {
    journal,
    agentTrailStream,
    identity,
    lifecycle: new GatewayLifecycleService(journal, identity),
    initialReadyId,
    failedId,
    replacementStartingId,
    replacementStartingPosition,
    replacementReadyId,
  };
}

function journalOverlay(
  journal: SqliteEventJournal,
  streamId: string,
  stream: ReturnType<SqliteEventJournal["readStream"]>,
) {
  return {
    append: journal.append.bind(journal),
    readStream: (candidate: string) => candidate === streamId ? stream : journal.readStream(candidate),
    readAll: journal.readAll.bind(journal),
  };
}
