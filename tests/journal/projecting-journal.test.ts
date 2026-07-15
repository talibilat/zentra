import { describe, expect, it, vi } from "vitest";

import type { NewEvent, StoredEvent } from "../../src/contracts/event.js";
import type { EventJournal } from "../../src/journal/journal.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";

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

function journal(append: EventJournal["append"]): EventJournal {
  return {
    append,
    readStream: vi.fn(() => [accepted]),
    readAll: vi.fn(() => [accepted]),
  };
}

describe("ProjectingEventJournal", () => {
  it("projects exactly the authoritative events returned by a successful append", () => {
    const inner = journal(vi.fn(() => [accepted]));
    const append = vi.fn();
    const projected = new ProjectingEventJournal(inner, { append });

    expect(projected.append("task-1", 0, [proposed])).toEqual([accepted]);
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith([accepted]);
    expect(projected.readStream("task-1")).toEqual([accepted]);
    expect(projected.readAll()).toEqual([accepted]);
  });

  it("does not project a rejected journal append", () => {
    const inner = journal(vi.fn(() => {
      throw new Error("expected version 0, actual 1");
    }));
    const append = vi.fn();
    const projected = new ProjectingEventJournal(inner, { append });

    expect(() => projected.append("task-1", 0, [proposed])).toThrow(
      "expected version 0, actual 1",
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("projects every accepted event in batch order", () => {
    const second = { ...accepted, eventId: "event-2", streamVersion: 2, globalPosition: 8 };
    const inner = journal(vi.fn(() => [accepted, second]));
    const append = vi.fn();
    const projected = new ProjectingEventJournal(inner, { append });

    projected.append("task-1", 0, [proposed, { ...proposed, type: "task.leased" }]);

    expect(append).toHaveBeenCalledWith([accepted, second]);
  });

  it("leaves the authoritative append accepted when projection fails", () => {
    const inner = journal(vi.fn(() => [accepted]));
    const projected = new ProjectingEventJournal(inner, {
      append: () => { throw new Error("trace projection failed"); },
    });

    expect(projected.append("task-1", 0, [proposed])).toEqual([accepted]);
    expect(inner.append).toHaveBeenCalledWith("task-1", 0, [proposed]);
    expect(projected.readStream("task-1")).toEqual([accepted]);
    expect(projected.projectionFailed).toBe(true);
  });
});
