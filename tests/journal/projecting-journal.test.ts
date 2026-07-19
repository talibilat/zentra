import { describe, expect, it, vi } from "vitest";

import type { NewEvent, StoredEvent } from "../../src/contracts/event.js";
import { isAtomicEventJournal, type EventJournal } from "../../src/journal/journal.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const accepted: StoredEvent = {
  streamId: "task-1",
  type: "task.created",
  payload: { title: "Accepted" },
  causationId: null,
  correlationId: "task-1",
  eventId: "event-1",
  streamVersion: 1,
  globalPosition: 7,
  recordedAt: "2026-07-15T00:00:00.000Z",
};

const proposed: NewEvent<string, unknown> = {
  streamId: "task-1",
  type: "task.created",
  payload: { title: "Proposed" },
  causationId: null,
  correlationId: "task-1",
};

describe("ProjectingEventJournal", () => {
  it("retains process-local fanout compatibility for a legacy EventJournal", () => {
    const streams = new Map<string, StoredEvent[]>();
    const all: StoredEvent[] = [];
    const legacy: EventJournal = {
      append: (streamId, expectedVersion, events) => {
        const stream = streams.get(streamId) ?? [];
        const stored = events.map((event, index): StoredEvent => ({
          ...event,
          eventId: `legacy-${all.length + index + 1}`,
          streamVersion: expectedVersion + index + 1,
          globalPosition: all.length + index + 1,
          recordedAt: "2026-07-01T00:00:00.000Z",
        }));
        stream.push(...stored);
        all.push(...stored);
        streams.set(streamId, stream);
        return stored;
      },
      readStream: (streamId, afterVersion = 0) =>
        (streams.get(streamId) ?? []).filter((event) => event.streamVersion > afterVersion),
      readAll: (afterPosition = 0) =>
        all.filter((event) => event.globalPosition > afterPosition),
    };
    const append = vi.fn();
    const projected = new ProjectingEventJournal(legacy, { append });

    const stored = projected.append("task-1", 0, [proposed]);

    expect(append).toHaveBeenCalledWith(stored);
    expect(projected.projectionFailed).toBe(false);
  });

  it("keeps nested legacy projections on process-local fanout", () => {
    const events: StoredEvent[] = [];
    const legacy: EventJournal = {
      append: (_streamId, expectedVersion, proposed) => {
        const stored = proposed.map((event, index): StoredEvent => ({
          ...event, eventId: `nested-${index}`, streamVersion: expectedVersion + index + 1,
          globalPosition: events.length + index + 1, recordedAt: "2026-07-01T00:00:00.000Z",
        }));
        events.push(...stored);
        return stored;
      },
      readStream: (streamId, afterVersion = 0) => events.filter((event) =>
        event.streamId === streamId && event.streamVersion > afterVersion),
      readAll: (afterPosition = 0) => events.filter((event) => event.globalPosition > afterPosition),
    };
    const firstSink = vi.fn();
    const secondSink = vi.fn();
    const first = new ProjectingEventJournal(legacy, { append: firstSink });
    const nested = new ProjectingEventJournal(first, { append: secondSink });

    expect(() => nested.append("task-1", 0, [proposed])).not.toThrow();
    expect(firstSink).toHaveBeenCalledOnce();
    expect(secondSink).toHaveBeenCalledOnce();
  });

  it("projects exactly the authoritative events returned by a successful append", () => {
    const inner = new SqliteEventJournal(":memory:");
    const append = vi.fn();
    const projected = new ProjectingEventJournal(inner, { append });

    const stored = projected.append("task-1", 0, [proposed]);
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(stored);
    expect(projected.readStreamPage("task-1").events).toEqual(stored);
    expect(projected.readAllPage().events).toEqual(stored);
    inner.close();
  });

  it("does not project a rejected journal append", () => {
    const inner = new SqliteEventJournal(":memory:");
    inner.append("task-1", 0, [proposed]);
    const append = vi.fn();
    const projected = new ProjectingEventJournal(inner, { append }, "projection:rejected", 1);

    expect(() => projected.append("task-1", 0, [proposed])).toThrow(
      "expected version 0, actual 1",
    );
    expect(append).not.toHaveBeenCalled();
    inner.close();
  });

  it("projects every accepted event in batch order", () => {
    const inner = new SqliteEventJournal(":memory:");
    const append = vi.fn();
    const projected = new ProjectingEventJournal(inner, { append });

    const stored = projected.append(
      "task-1",
      0,
      [proposed, { ...proposed, type: "task.leased" }],
    );

    expect(append).toHaveBeenCalledWith(stored);
    inner.close();
  });

  it("leaves the authoritative append accepted when projection fails", () => {
    const inner = new SqliteEventJournal(":memory:");
    const projected = new ProjectingEventJournal(inner, {
      append: () => { throw new Error("trace projection failed"); },
    });

    const stored = projected.append("task-1", 0, [proposed]);
    expect(projected.readStreamPage("task-1").events).toEqual(stored);
    expect(projected.projectionFailed).toBe(true);
    inner.close();
  });

  it("preserves branded atomic append and isolates durable sink failure after commit", () => {
    const inner = new SqliteEventJournal(":memory:");
    const projected = new ProjectingEventJournal(inner, {
      append: () => { throw new Error("atomic projection failed"); },
    }, "test:atomic-failure");
    expect(isAtomicEventJournal(projected)).toBe(true);

    const stored = projected.appendAtomically([
      { streamId: "run:1", expectedVersion: 0, events: [{ ...proposed, streamId: "run:1" }] },
      { streamId: "decision:1", expectedVersion: 0, events: [{ ...proposed, streamId: "decision:1" }] },
    ]);
    expect(stored.map((event) => event.globalPosition)).toEqual([1, 2]);
    expect(projected.projectionFailed).toBe(true);
    expect(inner.readAll()).toHaveLength(2);
    expect(inner.inspectProjectionCursor("test:atomic-failure")).toMatchObject({
      position: 0,
      activeClaimId: expect.any(String),
    });
    inner.close();
  });

  it("does not infer atomic capability from an unbranded method", () => {
    const fake = {
      append: () => [], readStream: () => [], readAll: () => [], appendAtomically: () => [],
    };
    expect(isAtomicEventJournal(fake)).toBe(false);
  });

  it("replays authoritative events accepted before fanout construction", () => {
    const inner = new SqliteEventJournal(":memory:");
    inner.append("task-1", 0, [proposed]);
    const append = vi.fn();

    const projected = new ProjectingEventJournal(inner, { append }, "test:recovery");

    expect(append).toHaveBeenCalledWith([
      expect.objectContaining({ streamId: "task-1", globalPosition: 1 }),
    ]);
    expect(inner.inspectProjectionCursor("test:recovery")).toMatchObject({
      position: 1,
      activeClaimId: null,
    });
    inner.close();
  });

  it("replays harmless duplicates when delivery succeeded before commit crashed", () => {
    const inner = new SqliteEventJournal(":memory:");
    inner.append("task-1", 0, [proposed]);
    const delivered = new Set<string>();
    const append = vi.fn((events: readonly StoredEvent[]) => {
      for (const event of events) delivered.add(event.eventId);
    });
    const commit = inner.commitProjection.bind(inner);
    let crash = true;
    inner.commitProjection = ((name: string, claimId: string, claimantId: string) => {
      if (crash) {
        crash = false;
        throw new Error("crash after sink delivery");
      }
      return commit(name, claimId, claimantId);
    }) as typeof inner.commitProjection;

    const sink = {
      idempotentDelivery: true,
      append,
      reconcile: (events: readonly StoredEvent[]) => {
        expect(events.every((event) => delivered.has(event.eventId))).toBe(true);
      },
    };
    const crashed = new ProjectingEventJournal(
      inner, sink, "test:commit-crash", 0, "process:99999999:00000000-0000-4000-8000-000000000001",
    );
    expect(crashed.projectionFailed).toBe(true);
    expect(inner.inspectProjectionCursor("test:commit-crash")?.position).toBe(0);

    const recovered = new ProjectingEventJournal(inner, sink, "test:commit-crash");
    expect(recovered.projectionFailed).toBe(false);
    expect(append).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveLength(1);
    expect(inner.inspectProjectionCursor("test:commit-crash")?.position).toBe(1);
    inner.close();
  });

  it("leaves unknown sensitive projection events durably uncommitted", () => {
    const inner = new SqliteEventJournal(":memory:");
    inner.append("sensitive", 0, [{ ...proposed, streamId: "sensitive", type: "unknown.secret" }]);
    const projected = new ProjectingEventJournal(inner, {
      append: () => { throw new Error("projection policy denied unknown event"); },
    }, "test:policy");

    expect(projected.projectionFailed).toBe(true);
    expect(inner.inspectProjectionCursor("test:policy")).toMatchObject({
      position: 0,
      activeClaimId: expect.any(String),
    });
    inner.close();
  });

  it("does not automatically recover an uncertain non-idempotent delivery", () => {
    const inner = new SqliteEventJournal(":memory:");
    inner.append("task-1", 0, [proposed]);
    const commit = inner.commitProjection.bind(inner);
    inner.commitProjection = (() => {
      throw new Error("uncertain external delivery");
    }) as typeof inner.commitProjection;
    const first = new ProjectingEventJournal(
      inner,
      { append: () => {} },
      "test:non-idempotent",
      0,
      `process:${process.pid}:00000000-0000-4000-8000-000000000001`,
    );
    expect(first.projectionFailed).toBe(true);
    inner.commitProjection = commit;
    const secondAppend = vi.fn();

    const second = new ProjectingEventJournal(
      inner,
      { append: secondAppend },
      "test:non-idempotent",
      0,
      `process:${process.pid}:00000000-0000-4000-8000-000000000002`,
    );

    expect(second.projectionFailed).toBe(true);
    expect(secondAppend).not.toHaveBeenCalled();
    expect(inner.inspectProjectionClaim("test:non-idempotent")).toMatchObject({
      claimantId: `process:${process.pid}:00000000-0000-4000-8000-000000000001`,
    });
    inner.close();
  });

  it("does not take over an idempotent claim owned by a live process", () => {
    const inner = new SqliteEventJournal(":memory:");
    inner.append("task-1", 0, [proposed]);
    const commit = inner.commitProjection.bind(inner);
    inner.commitProjection = (() => { throw new Error("commit acknowledgement lost"); }) as typeof inner.commitProjection;
    const firstSink = { idempotentDelivery: true, append: vi.fn(), reconcile: vi.fn() };
    const first = new ProjectingEventJournal(
      inner, firstSink, "test:live-owner", 0, `process:${process.pid}:00000000-0000-4000-8000-000000000001`,
    );
    expect(first.projectionFailed).toBe(true);
    inner.commitProjection = commit;
    const secondSink = { idempotentDelivery: true, append: vi.fn(), reconcile: vi.fn() };

    const second = new ProjectingEventJournal(
      inner, secondSink, "test:live-owner", 0, `process:${process.pid}:00000000-0000-4000-8000-000000000002`,
    );

    expect(second.projectionFailed).toBe(true);
    expect(secondSink.reconcile).not.toHaveBeenCalled();
    expect(secondSink.append).not.toHaveBeenCalled();
    expect(inner.inspectProjectionClaim("test:live-owner")).toMatchObject({
      claimantId: `process:${process.pid}:00000000-0000-4000-8000-000000000001`,
    });
    inner.close();
  });
});
