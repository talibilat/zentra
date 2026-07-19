import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { StoredEvent } from "../../src/contracts/event.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { AgentTailSegmentStore } from "../../src/observability/agent-tail-segment-store.js";
import { AgentTailTraceService } from "../../src/observability/agent-tail-trace.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-agent-tail-segments-")));
  directories.push(root);
  return root;
}

function event(position: number, overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    streamId: "task-1",
    type: "task.started",
    payload: { workerId: "worker-1" },
    causationId: null,
    correlationId: "trace-1",
    eventId: `event-${position}`,
    streamVersion: position,
    globalPosition: position,
    recordedAt: `2026-07-19T00:00:${String(position).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

describe("AgentTailSegmentStore", () => {
  it("rotates immutable segments and replays the same claim idempotently", () => {
    const root = fixture();
    const directory = path.join(root, "trace");
    const store = AgentTailSegmentStore.create({
      trustedRoot: root,
      traceDirectory: directory,
      traceId: "trace-1",
      limits: { maxEvents: 2, maxBytes: 1024 * 1024 },
    });
    const events = [event(1), event(2), event(3), event(4), event(5)];
    store.append(events);
    const before = readdirSync(directory).sort();
    expect(before.filter((name) => name.endsWith(".jsonl"))).toHaveLength(3);
    store.reconcile(events);
    store.append(events);
    expect(readdirSync(directory).sort()).toEqual(before);
    expect(store.report()).toMatchObject({ eventCount: 5, segmentCount: 3, withheldCount: 0 });
    store.close();
  });

  it("withholds unknown sensitive families using bounded hashed alerts", () => {
    const root = fixture();
    const directory = path.join(root, "trace");
    const secret = "ghp_must_never_leave_the_journal";
    const store = AgentTailSegmentStore.create({ trustedRoot: root, traceDirectory: directory,
      traceId: "trace-1" });
    store.append([event(1, { type: `unknown.${secret}`, payload: { token: secret } }), event(2)]);
    const bytes = readdirSync(directory).map((name) => readFileSync(path.join(directory, name))).map(String).join("");
    expect(bytes).not.toContain(secret);
    expect(store.report()).toMatchObject({ eventCount: 1, withheldCount: 1 });
    store.close();
  });

  it("exports, validates, and repairs exact canonical bytes from journal truth", () => {
    const root = fixture();
    const database = path.join(root, "journal.sqlite");
    const journal = new SqliteEventJournal(database);
    journal.append("task-1", 0, [event(1), event(2), event(3)].map((stored) => ({
      streamId: stored.streamId, type: stored.type, payload: stored.payload,
      causationId: stored.causationId, correlationId: stored.correlationId,
    })));
    const service = new AgentTailTraceService(journal);
    const projected = service.project({ trustedRoot: root, traceDirectory: path.join(root, "trace"),
      traceId: "trace-1", limits: { maxEvents: 2, maxBytes: 1024 * 1024 } });
    const validated = service.validate(path.join(root, "trace"));
    expect(validated.contentSha256).toBe(projected.contentSha256);
    const exported = service.export(path.join(root, "trace"), path.join(root, "trace.jsonl"));
    expect(exported.contentSha256).toBe(projected.contentSha256);
    const repaired = service.repair({ trustedRoot: root, traceDirectory: path.join(root, "repaired"),
      traceId: "trace-1", throughPosition: projected.throughPosition });
    expect(repaired.contentSha256).toBe(projected.contentSha256);
    expect(readFileSync(path.join(root, "trace.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
    journal.close();
  });

  it("backfills through a durable cursor and reopens without duplicate logical events", () => {
    const root = fixture();
    const database = path.join(root, "cursor.sqlite");
    const journal = new SqliteEventJournal(database);
    journal.append("task-1", 0, [1, 2].map(() => ({
      streamId: "task-1", type: "task.started", payload: { workerId: "worker-1" },
      causationId: null, correlationId: "trace-1",
    })));
    const directory = path.join(root, "cursor-trace");
    const first = AgentTailSegmentStore.create({ trustedRoot: root, traceDirectory: directory,
      traceId: "trace-1" });
    const projected = new ProjectingEventJournal(journal, first);
    expect(projected.projectionFailed).toBe(false);
    expect(journal.inspectProjectionCursor(first.projectionCursorName)?.position).toBe(2);
    first.close();
    journal.close();

    const reopenedJournal = new SqliteEventJournal(database);
    const reopened = AgentTailSegmentStore.reopen({ trustedRoot: root, traceDirectory: directory });
    const resumed = new ProjectingEventJournal(reopenedJournal, reopened);
    expect(resumed.projectionFailed).toBe(false);
    expect(reopened.report()).toMatchObject({ eventCount: 2, segmentCount: 1 });
    reopened.close();
    reopenedJournal.close();
  });

  it("recovers publication after cursor commit loss exactly once", () => {
    const root = fixture();
    const database = path.join(root, "commit-loss.sqlite");
    const journal = new SqliteEventJournal(database);
    journal.append("task-1", 0, [{ streamId: "task-1", type: "task.started",
      payload: { workerId: "worker-1" }, causationId: null, correlationId: "trace-1" }]);
    const originalCommit = journal.commitProjection.bind(journal);
    journal.commitProjection = (() => { throw new Error("simulated commit loss"); }) as typeof journal.commitProjection;
    const directory = path.join(root, "commit-loss-trace");
    const first = AgentTailSegmentStore.create({ trustedRoot: root, traceDirectory: directory,
      traceId: "trace-1" });
    const failed = new ProjectingEventJournal(journal, first, first.projectionCursorName, 0,
      "process:99999999:00000000-0000-4000-8000-000000000001");
    expect(failed.projectionFailed).toBe(true);
    first.close();
    journal.commitProjection = originalCommit;
    journal.close();

    const reopenedJournal = new SqliteEventJournal(database);
    const reopened = AgentTailSegmentStore.reopen({ trustedRoot: root, traceDirectory: directory });
    const recovered = new ProjectingEventJournal(reopenedJournal, reopened);
    expect(recovered.projectionFailed).toBe(false);
    expect(reopened.report()).toMatchObject({ eventCount: 1, segmentCount: 1 });
    expect(reopenedJournal.inspectProjectionCursor(reopened.projectionCursorName)).toMatchObject({
      position: 1, activeClaimId: null, replayCount: 1,
    });
    reopened.close();
    reopenedJournal.close();
  });

  it("adopts exact active-claim segments published before the claim manifest", () => {
    const root = fixture();
    const database = path.join(root, "manifest-loss.sqlite");
    const journal = new SqliteEventJournal(database);
    journal.append("task-1", 0, [{ streamId: "task-1", type: "task.started",
      payload: { workerId: "worker-1" }, causationId: null, correlationId: "trace-1" }]);
    const directory = path.join(root, "manifest-loss-trace");
    const first = AgentTailSegmentStore.create({ trustedRoot: root, traceDirectory: directory,
      traceId: "trace-1", crashPoint: "before_claim_manifest" });
    const failed = new ProjectingEventJournal(journal, first, first.projectionCursorName, 0,
      "process:99999999:00000000-0000-4000-8000-000000000001");
    expect(failed.projectionFailed).toBe(true);
    expect(readdirSync(directory).some((name) => name.endsWith(".jsonl"))).toBe(true);
    expect(readdirSync(directory).some((name) => name.endsWith(".claim.json"))).toBe(false);
    first.close();
    journal.close();

    const reopenedJournal = new SqliteEventJournal(database);
    const reopened = AgentTailSegmentStore.reopen({ trustedRoot: root, traceDirectory: directory });
    const recovered = new ProjectingEventJournal(reopenedJournal, reopened);
    expect(recovered.projectionFailed).toBe(false);
    expect(reopened.report()).toMatchObject({ eventCount: 1, segmentCount: 1 });
    reopened.close();
    reopenedJournal.close();
  });

  it("tails exact backfill and then live events without a boundary duplicate", async () => {
    const root = fixture();
    const journal = new SqliteEventJournal(path.join(root, "tail.sqlite"));
    journal.append("task-1", 0, [{ streamId: "task-1", type: "task.started",
      payload: { workerId: "worker-1" }, causationId: null, correlationId: "trace-1" }]);
    const service = new AgentTailTraceService(journal);
    const controller = new AbortController();
    const iterator = service.tail({ traceId: "trace-1", signal: controller.signal,
      pollIntervalMs: 10 });
    const first = await iterator.next();
    expect(JSON.parse(first.value!) as { sequence: number }).toMatchObject({ sequence: 1 });
    journal.append("task-1", 1, [{ streamId: "task-1", type: "task.started",
      payload: { workerId: "worker-1" }, causationId: null, correlationId: "trace-1" }]);
    const second = await iterator.next();
    expect(JSON.parse(second.value!) as { sequence: number }).toMatchObject({ sequence: 2 });
    controller.abort();
    await iterator.return();
    journal.close();
  });
});
