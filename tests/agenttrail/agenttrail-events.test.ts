import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentTrailEvidenceSchema,
  JournalAgentTrailEvidenceSink,
  agentTrailStreamId,
  replayAgentTrailEvidence,
  type AgentTrailEvidence,
} from "../../src/agenttrail/agenttrail-events.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import type { StoredEvent } from "../../src/contracts/event.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("AgentTrail durable lifecycle evidence", () => {
  it("rejects malformed runtime payloads", () => {
    expect(() => AgentTrailEvidenceSchema.parse({
      type: "agenttrail.ready",
      incarnation: "invalid",
    })).toThrow();
  });

  it("persists causally linked incarnation evidence across SQLite reopen", async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "zentra-agenttrail-events-")));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "events.sqlite");
    const streamId = agentTrailStreamId("project-1");
    const identity = {
      schemaVersion: 1,
      executableSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      occurredAt: "2026-07-19T12:00:00.000Z",
    } as const;
    let journal = new SqliteEventJournal(databasePath);
    const sink = new JournalAgentTrailEvidenceSink(journal, {
      streamId,
      correlationId: "run-1",
      causationId: "command-1",
    });
    const firstIncarnation = "agenttrail-v1:11111111-1111-4111-8111-111111111111";
    const secondIncarnation = "agenttrail-v1:22222222-2222-4222-8222-222222222222";
    sink.record({
      type: "agenttrail.starting", ...identity, incarnation: firstIncarnation,
      pid: null, startupDeadlineMs: 45_000, tracePathSha256: "c".repeat(64),
    });
    sink.record({
      type: "agenttrail.ready", ...identity, incarnation: firstIncarnation,
      pid: 101, address: { host: "127.0.0.1", port: 8080 }, startupMs: 10,
    });
    sink.record({
      type: "agenttrail.failed", ...identity, incarnation: firstIncarnation,
      pid: 101, phase: "runtime", uptimeMs: 10,
      failure: { code: "process_exit", message: "exited", exitCode: 1, signal: null },
    });
    sink.record({
      type: "agenttrail.starting", ...identity, incarnation: secondIncarnation,
      pid: null, startupDeadlineMs: 45_000, tracePathSha256: "c".repeat(64),
    });
    sink.record({
      type: "agenttrail.restarted", ...identity, incarnation: secondIncarnation,
      pid: 102, previousIncarnation: firstIncarnation, restartAttempt: 1, backoffMs: 10,
    });
    journal.close();

    journal = new SqliteEventJournal(databasePath);
    const replayed = replayAgentTrailEvidence(journal, streamId);
    const stored = journal.readStream(streamId);

    expect(replayed.map(({ type }) => type)).toEqual([
      "agenttrail.starting", "agenttrail.ready", "agenttrail.failed", "agenttrail.starting", "agenttrail.restarted",
    ]);
    expect(replayed[4]).toMatchObject({
      incarnation: secondIncarnation,
      previousIncarnation: firstIncarnation,
    });
    expect(stored.map(({ correlationId }) => correlationId)).toEqual([
      "run-1", "run-1", "run-1", "run-1", "run-1",
    ]);
    expect(stored.map(({ causationId }) => causationId)).toEqual([
      "command-1", stored[0]!.eventId, stored[1]!.eventId, stored[2]!.eventId, stored[3]!.eventId,
    ]);
    journal.close();
  });

  it.each([
    ["ready without starting", [event("agenttrail.ready", "a", null)]],
    ["wrong ready incarnation", [event("agenttrail.starting", "a", "command-1"), event("agenttrail.ready", "b", "event-1")]],
    ["broken causation", [event("agenttrail.starting", "a", "command-1"), event("agenttrail.ready", "a", "wrong")]],
    ["duplicate ready", [event("agenttrail.starting", "a", "command-1"), event("agenttrail.ready", "a", "event-1"), event("agenttrail.ready", "a", "event-2")]],
    ["restart without failure", [event("agenttrail.starting", "a", "command-1"), event("agenttrail.starting", "b", "event-1")]],
    ["bad previous incarnation", [
      event("agenttrail.starting", "a", "command-1"), event("agenttrail.failed", "a", "event-1"),
      event("agenttrail.starting", "b", "event-2"), event("agenttrail.restarted", "b", "event-3", "c"),
    ]],
    ["restarted in wrong position", [
      event("agenttrail.starting", "a", "command-1"), event("agenttrail.failed", "a", "event-1"),
      event("agenttrail.starting", "b", "event-2"), event("agenttrail.ready", "b", "event-3"),
    ]],
    ["executable digest changes", [
      event("agenttrail.starting", "a", "command-1"),
      withPayload(event("agenttrail.ready", "a", "event-1"), { executableSha256: "d".repeat(64) }),
    ]],
    ["manifest digest changes across restart", [
      event("agenttrail.starting", "a", "command-1"), event("agenttrail.failed", "a", "event-1"),
      withPayload(event("agenttrail.starting", "b", "event-2"), { manifestSha256: "d".repeat(64) }),
    ]],
    ["runtime failure before ready", [
      event("agenttrail.starting", "a", "command-1"), event("agenttrail.failed", "a", "event-1"),
    ]],
    ["startup failure after ready", [
      event("agenttrail.starting", "a", "command-1"), event("agenttrail.ready", "a", "event-1"),
      withPayload(event("agenttrail.failed", "a", "event-2"), { phase: "startup" }),
    ]],
    ["runtime failure pid changes", [
      event("agenttrail.starting", "a", "command-1"), event("agenttrail.ready", "a", "event-1"),
      withPayload(event("agenttrail.failed", "a", "event-2"), { pid: 999 }),
    ]],
    ["restarted and ready pid disagree", [
      event("agenttrail.starting", "a", "command-1"), event("agenttrail.failed", "a", "event-1"),
      event("agenttrail.starting", "b", "event-2"),
      withPayload(event("agenttrail.restarted", "b", "event-3", "a"), { pid: 102 }),
      withPayload(event("agenttrail.ready", "b", "event-4"), { pid: 103 }),
    ]],
  ] as const)("rejects malformed retained history: %s", (_name, events) => {
    expect(() => replayAgentTrailEvidence(journalWith(events), "agenttrail:project-1", {
      correlationId: "run-1",
      causationId: "command-1",
    })).toThrow();
  });

  it("rejects retained correlation and initial causation mismatches during sink construction", () => {
    const retained = [event("agenttrail.starting", "a", "wrong-cause")];
    expect(() => new JournalAgentTrailEvidenceSink(journalWith(retained), {
      streamId: "agenttrail:project-1", correlationId: "run-1", causationId: "command-1",
    })).toThrow(/causation/);
    const wrongCorrelation = [{ ...retained[0]!, correlationId: "other-run" }];
    expect(() => new JournalAgentTrailEvidenceSink(journalWith(wrongCorrelation), {
      streamId: "agenttrail:project-1", correlationId: "run-1", causationId: "wrong-cause",
    })).toThrow(/correlation/);
  });
});

const incarnations = {
  a: "agenttrail-v1:11111111-1111-4111-8111-111111111111",
  b: "agenttrail-v1:22222222-2222-4222-8222-222222222222",
  c: "agenttrail-v1:33333333-3333-4333-8333-333333333333",
} as const;

function event(
  type: AgentTrailEvidence["type"],
  incarnation: keyof typeof incarnations,
  causationId: string | null,
  previousIncarnation?: keyof typeof incarnations,
): StoredEvent {
  const base = {
    schemaVersion: 1 as const,
    executableSha256: "a".repeat(64), manifestSha256: "b".repeat(64),
    incarnation: incarnations[incarnation], occurredAt: "2026-07-19T12:00:00.000Z",
  };
  const payload = type === "agenttrail.starting"
    ? { ...base, pid: null, startupDeadlineMs: 60_000, tracePathSha256: "c".repeat(64) }
    : type === "agenttrail.ready"
      ? { ...base, pid: 101, address: { host: "127.0.0.1", port: 8080 }, startupMs: 10 }
      : type === "agenttrail.failed"
        ? { ...base, pid: 101, phase: "runtime", uptimeMs: 10,
          failure: { code: "process_exit", message: "exited", exitCode: 1, signal: null } }
        : { ...base, pid: 102, previousIncarnation: incarnations[previousIncarnation ?? "a"],
          restartAttempt: 1, backoffMs: 10 };
  const position = Number(causationId?.replace("event-", "")) + 1 || 1;
  return {
    streamId: "agenttrail:project-1", type, payload, causationId, correlationId: "run-1",
    eventId: `event-${position}`, streamVersion: position, globalPosition: position,
    recordedAt: "2026-07-19T12:00:00.000Z",
  };
}

function journalWith(events: readonly StoredEvent[]) {
  return {
    append: () => { throw new Error("not used"); },
    readStream: () => events,
    readAll: () => events,
  };
}

function withPayload(event: StoredEvent, changes: Record<string, unknown>): StoredEvent {
  return { ...event, payload: { ...(event.payload as Record<string, unknown>), ...changes } };
}
