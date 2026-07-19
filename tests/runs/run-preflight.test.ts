import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { NewEvent, StoredEvent } from "../../src/contracts/event.js";
import type { EventJournal } from "../../src/journal/journal.js";
import { ProjectingEventJournal, type StoredEventSink } from "../../src/journal/projecting-journal.js";
import { RunPreflightCoordinator } from "../../src/runs/run-preflight.js";
import { RunService } from "../../src/runs/run-service.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";

class MemoryJournal implements EventJournal {
  readonly events: StoredEvent[] = [];

  append(streamId: string, expectedVersion: number, events: readonly NewEvent<string, unknown>[]) {
    const current = this.events.filter((event) => event.streamId === streamId).length;
    if (current !== expectedVersion) throw new Error(`expected version ${expectedVersion}, actual ${current}`);
    const stored = events.map((event, index): StoredEvent => ({
      ...event,
      eventId: `event-${this.events.length + index + 1}`,
      streamVersion: current + index + 1,
      globalPosition: this.events.length + index + 1,
      recordedAt: "2026-07-19T12:00:00.000Z",
    }));
    this.events.push(...stored);
    return stored;
  }

  readStream(streamId: string, afterVersion = 0) {
    return this.events.filter((event) => event.streamId === streamId && event.streamVersion > afterVersion);
  }

  readAll(afterPosition = 0) {
    return this.events.filter((event) => event.globalPosition > afterPosition);
  }
}

const processIdentity = { pid: 123, processIncarnation: `process-v2:${"c".repeat(64)}` };

function seedServiceReady(journal: MemoryJournal): string {
  const streamId = `service:${processIdentity.processIncarnation}`;
  const starting = journal.append(streamId, 0, [{
    streamId, type: "service.starting", causationId: null, correlationId: "zentra-local",
    payload: {
      schemaVersion: 1, serviceId: "zentra-local", process: processIdentity,
      address: { host: "127.0.0.1", port: 43_219 }, tokenExpiresAt: "2026-07-19T13:00:00.000Z",
      observation: "performed", commandId: "service-start",
    },
  }])[0]!;
  return journal.append(streamId, 1, [{
    streamId, type: "service.ready", causationId: starting.eventId, correlationId: "zentra-local",
    payload: {
      schemaVersion: 1, serviceId: "zentra-local", process: processIdentity,
      address: { host: "127.0.0.1", port: 43_219 }, runtimeSchemaVersion: 1, journalSchemaVersion: 2,
      observation: "performed", commandId: "service-ready",
    },
  }])[0]!.eventId;
}

describe("RunPreflightCoordinator", () => {
  it("writes a real retained trace before expensive source work", async () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-run-trace-")));
    const tracePath = path.join(directory, "run-real-trace.jsonl");
    const sink = AgentTailJsonlFileSink.open(directory, tracePath, "run-real-trace");
    const inner = new MemoryJournal();
    const serviceReadyEventId = seedServiceReady(inner);
    const journal = new ProjectingEventJournal(inner, sink);
    const coordinator = new RunPreflightCoordinator(new RunService(journal), () => journal.projectionFailed, async () => true);
    try {
      await coordinator.prepareAndInvoke({
        runId: "run-real-trace",
        projectId: "zentra",
        projectRevision: { objectFormat: "sha1", commit: "a".repeat(40) },
        source: { kind: "inline_goal", referenceSha256: "b".repeat(64), declaredBytes: 1 },
        actor: { actorId: "operator-1", kind: "operator" },
        process: { pid: 123, processIncarnation: `process-v2:${"c".repeat(64)}` },
        budget: {
          maxDurationMs: 60_000, maxInputTokens: 10_000, maxOutputTokens: 2_000,
          maxCostUsdNano: 1_000_000_000, maxRetries: 0, maxSourceFiles: 100, maxSourceBytes: 1_000_000,
        },
        commandId: "accept-real-trace",
        causationId: serviceReadyEventId,
      }, () => {
        const kinds = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string });
        expect(kinds.map((event) => event.kind)).toEqual(["run.accepted", "preflight.started", "preflight.completed"]);
      });
    } finally {
      sink.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("projects acceptance and preflight evidence before expensive source work", async () => {
    const inner = new MemoryJournal();
    const serviceReadyEventId = seedServiceReady(inner);
    const traced: StoredEvent[] = [];
    const sink: StoredEventSink = { append: (events) => traced.push(...events) };
    const journal = new ProjectingEventJournal(inner, sink);
    const runs = new RunService(journal);
    const coordinator = new RunPreflightCoordinator(runs, () => journal.projectionFailed, async () => true);
    let invoked = 0;

    const result = await coordinator.prepareAndInvoke({
      runId: "run-order",
      projectId: "zentra",
      projectRevision: { objectFormat: "sha1", commit: "a".repeat(40) },
      source: { kind: "ticket_directory", referenceSha256: "b".repeat(64), declaredBytes: 128 },
      actor: { actorId: "operator-1", kind: "operator" },
      process: { pid: 123, processIncarnation: `process-v2:${"c".repeat(64)}` },
      budget: {
        maxDurationMs: 60_000, maxInputTokens: 10_000, maxOutputTokens: 2_000,
        maxCostUsdNano: 1_000_000_000, maxRetries: 0, maxSourceFiles: 100, maxSourceBytes: 1_000_000,
      },
      commandId: "accept-order",
      causationId: serviceReadyEventId,
    }, async (run) => {
      invoked += 1;
      expect(run.lifecycle).toBe("intake");
      expect(inner.events.filter((event) => event.streamId.startsWith("run:")).map((event) => event.type)).toEqual([
        "run.accepted", "preflight.started", "preflight.completed",
      ]);
      expect(traced.map((event) => event.type)).toEqual([
        "run.accepted", "preflight.started", "preflight.completed",
      ]);
      return "parsed";
    });

    expect(result).toBe("parsed");
    expect(invoked).toBe(1);
  });

  it("resumes after a crash following preflight.started without duplicating an append", async () => {
    const inner = new MemoryJournal();
    const serviceReadyEventId = seedServiceReady(inner);
    const traced: StoredEvent[] = [];
    const journal = new ProjectingEventJournal(inner, { append: (events) => traced.push(...events) });
    const runs = new RunService(journal);
    const input = {
      runId: "run-resume", projectId: "zentra",
      projectRevision: { objectFormat: "sha1" as const, commit: "a".repeat(40) },
      source: { kind: "inline_goal" as const, referenceSha256: "b".repeat(64), declaredBytes: 1 },
      actor: { actorId: "operator-1", kind: "operator" as const },
      process: { pid: 123, processIncarnation: `process-v2:${"c".repeat(64)}` },
      budget: {
        maxDurationMs: 60_000, maxInputTokens: 10_000, maxOutputTokens: 2_000,
        maxCostUsdNano: 1_000_000_000, maxRetries: 0, maxSourceFiles: 100, maxSourceBytes: 1_000_000,
      },
      commandId: "accept-resume", causationId: serviceReadyEventId,
    };
    let run = runs.accept(input);
    run = runs.startPreflight(input.runId, {
      expectedVersion: run.streamVersion,
      commandId: "preflight:crash-started",
      causationId: runs.readStream(input.runId).at(-1)!.eventId,
      process: input.process,
    });
    expect(run.lifecycle).toBe("preflighting");

    let invoked = 0;
    await new RunPreflightCoordinator(runs, () => journal.projectionFailed, async () => true)
      .prepareAndInvoke(input, () => { invoked += 1; });

    expect(invoked).toBe(1);
    expect(inner.events.filter((event) => event.streamId.startsWith("run:")).map((event) => event.type)).toEqual([
      "run.accepted", "preflight.started", "preflight.completed",
    ]);
    expect(traced).toHaveLength(3);
  });

  it("does not invoke expensive work when trace projection fails", async () => {
    const inner = new MemoryJournal();
    const serviceReadyEventId = seedServiceReady(inner);
    const journal = new ProjectingEventJournal(inner, { append: () => { throw new Error("trace failed"); } });
    const coordinator = new RunPreflightCoordinator(new RunService(journal), () => journal.projectionFailed, async () => true);
    let invoked = false;

    await expect(coordinator.prepareAndInvoke({
      runId: "run-failed-trace",
      projectId: "zentra",
      projectRevision: { objectFormat: "sha1", commit: "a".repeat(40) },
      source: { kind: "inline_goal", referenceSha256: "b".repeat(64), declaredBytes: 1 },
      actor: { actorId: "operator-1", kind: "operator" },
      process: { pid: 123, processIncarnation: `process-v2:${"c".repeat(64)}` },
      budget: {
        maxDurationMs: 60_000, maxInputTokens: 10_000, maxOutputTokens: 2_000,
        maxCostUsdNano: 1_000_000_000, maxRetries: 0, maxSourceFiles: 100, maxSourceBytes: 1_000_000,
      },
      commandId: "accept-failed-trace",
      causationId: serviceReadyEventId,
    }, () => {
      invoked = true;
    })).rejects.toThrow("run trace projection failed before source work");
    expect(invoked).toBe(false);
    expect(inner.events.filter((event) => event.streamId.startsWith("run:")).map((event) => event.type)).toEqual([
      "run.accepted", "preflight.started", "preflight.failed",
    ]);
    expect(new RunService(inner).reopen("run-failed-trace")).toMatchObject({
      lifecycle: "terminal",
      terminalOutcome: "failed",
    });
  });
});
