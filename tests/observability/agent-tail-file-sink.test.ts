import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type { StoredEvent } from "../../src/contracts/event.js";
import {
  AgentTailJsonlFileSink,
  assertSafeAgentTailJsonlPath,
} from "../../src/observability/agent-tail-file-sink.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { agentTailEventToJsonLine, storedEventToAgentTailEvent } from "../../src/observability/agent-tail.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): { readonly root: string; readonly outside: string } {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-agent-tail-root-")));
  const outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-agent-tail-outside-")));
  directories.push(root, outside);
  return { root, outside };
}

function event(overrides: Partial<StoredEvent> = {}): StoredEvent {
  const type = overrides.type ?? "task.started";
  const payload = overrides.payload ?? (type === "task.started"
    ? { workerId: "worker-1", text: "hello, 世界" }
    : type === "task.completed"
      ? { stage: "validation", validation: { name: "focused" }, diffSha256: "a".repeat(64), changedPath: "src/a.ts", workspace: "/tmp/work" }
      : { stage: "worker", reason: `${type} fixture` });
  return {
    streamId: "task-1",
    causationId: null,
    correlationId: "task-1",
    eventId: "event-1",
    streamVersion: 1,
    globalPosition: 1,
    recordedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
    type,
    payload,
  };
}

describe("AgentTailJsonlFileSink", () => {
  it("appends accepted events as readable UTF-8 JSONL without replacing earlier bytes", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "task-1.jsonl");
    const sink = AgentTailJsonlFileSink.open(root, tracePath, "task-1");

    sink.append([event()]);
    const firstBytes = readFileSync(tracePath);
    expect(firstBytes.toString("utf8")).not.toContain("hello, 世界");
    expect(firstBytes.toString("utf8").endsWith("\n")).toBe(true);

    sink.append([event({
      type: "task.completed",
      eventId: "event-2",
      streamVersion: 2,
      globalPosition: 4,
    })]);
    sink.close();

    const finalBytes = readFileSync(tracePath);
    expect(finalBytes.subarray(0, firstBytes.length)).toEqual(firstBytes);
    const lines = finalBytes.toString("utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line) as { kind: string; sequence: number }))
      .toMatchObject([
        { kind: "task.started", sequence: 1 },
        { kind: "task.completed", sequence: 4 },
      ]);
  });

  it("streams the exact retained lines in accepted event order", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "streamed.jsonl");
    let streamed = "";
    const sink = AgentTailJsonlFileSink.open(root, tracePath, "task-1", (line) => {
      streamed += line;
    });

    sink.append([event(), event({
      type: "task.completed",
      eventId: "event-2",
      streamVersion: 2,
      globalPosition: 4,
    })]);
    sink.close();

    expect(streamed).toBe(readFileSync(tracePath, "utf8"));
  });

  it("continues retaining events after the live stream fails", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "failed-stream.jsonl");
    let attempts = 0;
    const sink = AgentTailJsonlFileSink.open(root, tracePath, "task-1", () => {
      attempts += 1;
      throw new Error("closed stream");
    });

    expect(() => sink.append([event()])).not.toThrow();
    expect(sink.streamFailed).toBe(true);
    expect(() => sink.append([event({
      type: "task.completed",
      eventId: "event-2",
      streamVersion: 2,
      globalPosition: 2,
    })])).not.toThrow();
    sink.close();

    expect(attempts).toBe(1);
    expect(readFileSync(tracePath, "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  it("rejects existing destinations without modifying their bytes", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "existing.jsonl");
    writeFileSync(tracePath, "sentinel\n", "utf8");

    expect(() => AgentTailJsonlFileSink.open(root, tracePath, "task-1")).toThrow(
      "Agent Tail trace path must not already exist",
    );
    expect(readFileSync(tracePath, "utf8")).toBe("sentinel\n");
  });

  it("rejects destinations outside the trusted root and symbolic-link components", () => {
    const { root, outside } = fixture();
    const outsideTrace = path.join(outside, "outside.jsonl");
    expect(() => assertSafeAgentTailJsonlPath(root, outsideTrace)).toThrow(
      "Agent Tail trace path must remain inside the trusted root",
    );
    expect(existsSync(outsideTrace)).toBe(false);

    const linkedParent = path.join(root, "linked");
    symlinkSync(outside, linkedParent);
    expect(() => assertSafeAgentTailJsonlPath(root, path.join(linkedParent, "trace.jsonl"))).toThrow(
      "Agent Tail trace path must be a direct child of the trusted root",
    );
    expect(existsSync(path.join(outside, "trace.jsonl"))).toBe(false);

    const externalTarget = path.join(outside, "target.jsonl");
    writeFileSync(externalTarget, "external\n", "utf8");
    const linkedTarget = path.join(root, "target.jsonl");
    symlinkSync(externalTarget, linkedTarget);
    expect(() => AgentTailJsonlFileSink.open(root, linkedTarget, "task-1")).toThrow(
      "Agent Tail trace path must not already exist",
    );
    expect(readFileSync(externalTarget, "utf8")).toBe("external\n");
  });

  it("rejects relative, non-normalized, and directory destinations", () => {
    const { root } = fixture();
    expect(() => assertSafeAgentTailJsonlPath(root, "trace.jsonl")).toThrow(
      "Agent Tail trace path must be absolute",
    );
    expect(() => assertSafeAgentTailJsonlPath(root, `${root}${path.sep}nested${path.sep}..${path.sep}trace.jsonl`))
      .toThrow("Agent Tail trace path must be normalized");
    const directoryPath = path.join(root, "directory.jsonl");
    mkdirSync(directoryPath);
    expect(() => AgentTailJsonlFileSink.open(root, directoryPath, "task-1")).toThrow(
      "Agent Tail trace path must not already exist",
    );
  });

  it("suppresses duplicate delivery and rejects descending new events", () => {
    const { root } = fixture();
    const sink = AgentTailJsonlFileSink.open(root, path.join(root, "trace.jsonl"), "task-1");
    sink.append([event()]);

    expect(() => sink.append([event()])).not.toThrow();
    expect(() => sink.append([event({ eventId: "event-0", globalPosition: 0 })])).toThrow(
      "Agent Tail trace events must follow journal order",
    );
    sink.close();
  });

  it("rejects a legacy event identity reused at another global position before writing", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "legacy-event-position.jsonl");
    const sink = AgentTailJsonlFileSink.open(root, tracePath);
    const first = event({ correlationId: "legacy-trace" });
    sink.append([first]);
    const before = readFileSync(tracePath);

    expect(() => sink.append([{ ...first, streamVersion: 2, globalPosition: 2 }]))
      .toThrow(/event.*position|corrupt/i);

    expect(readFileSync(tracePath)).toEqual(before);
    expect(() => sink.append([first])).not.toThrow();
    expect(readFileSync(tracePath)).toEqual(before);
    sink.close();
  });

  it("rejects a durable event identity reused at another position and preserves sequence checks", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "durable-event-position.jsonl");
    const sink = AgentTailJsonlFileSink.open(root, tracePath, "durable-trace");
    const first = event({ correlationId: "durable-trace" });
    sink.append([first]);
    const before = readFileSync(tracePath);

    expect(() => sink.append([{ ...first, streamVersion: 2, globalPosition: 2 }]))
      .toThrow(/event.*position|corrupt/i);
    expect(readFileSync(tracePath)).toEqual(before);
    expect(() => sink.append([{
      ...first, eventId: "different-event", streamVersion: 2, globalPosition: 1,
    }])).toThrow("Agent Tail trace events must follow journal order");
    expect(readFileSync(tracePath)).toEqual(before);
    sink.close();
  });

  it("reopens an authorized interrupted trace and suppresses replayed positions", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "resume.jsonl");
    const first = AgentTailJsonlFileSink.open(root, tracePath, "task-1");
    first.append([event()]);
    first.close();

    const resumed = AgentTailJsonlFileSink.open(root, tracePath, "task-1", undefined, true);
    const replay = [
      event(),
      event({ eventId: "event-2", globalPosition: 2, streamVersion: 2 }),
    ];
    resumed.reconcile(replay);
    resumed.append(replay);
    resumed.close();

    expect(readFileSync(tracePath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("recovers production fanout after delivery succeeds and cursor commit crashes", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "crash-recovery.jsonl");
    const databasePath = path.join(root, "journal.db");
    const firstJournal = new SqliteEventJournal(databasePath);
    const firstSink = AgentTailJsonlFileSink.open(root, tracePath, "trace");
    const commit = firstJournal.commitProjection.bind(firstJournal);
    let crash = true;
    firstJournal.commitProjection = ((name: string, claimId: string, claimantId: string) => {
      if (crash) {
        crash = false;
        throw new Error("simulated process loss after fsync");
      }
      return commit(name, claimId, claimantId);
    }) as typeof firstJournal.commitProjection;
    const firstProjection = new ProjectingEventJournal(
      firstJournal, firstSink, firstSink.projectionCursorName, 0,
      "process:99999999:00000000-0000-4000-8000-000000000001",
    );
    firstProjection.append("task-1", 0, [{
      streamId: "task-1",
      type: "task.created",
      payload: { projectId: "project", title: "Crash recovery" },
      causationId: null,
      correlationId: "trace",
    }]);
    expect(firstProjection.projectionFailed).toBe(true);
    firstSink.close();
    firstJournal.close();

    const recoveredJournal = new SqliteEventJournal(databasePath);
    const cursorName = AgentTailJsonlFileSink.projectionCursorName(tracePath);
    expect(recoveredJournal.inspectProjectionCursor(cursorName)).toMatchObject({ position: 0 });
    const recoveredSink = AgentTailJsonlFileSink.open(root, tracePath, "trace", undefined, true);
    const recoveredProjection = new ProjectingEventJournal(recoveredJournal, recoveredSink);

    expect(recoveredProjection.projectionFailed).toBe(false);
    expect(recoveredJournal.inspectProjectionCursor(cursorName)).toMatchObject({
      position: 1,
      activeClaimId: null,
      replayCount: 1,
    });
    expect(readFileSync(tracePath, "utf8").trim().split("\n")).toHaveLength(1);
    recoveredSink.close();
    recoveredJournal.close();
  });

  it("backfills historical pages from position zero and releases only the expected trace", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "historical.jsonl");
    const journal = new SqliteEventJournal(path.join(root, "historical.db"));
    journal.append("other", 0, [{
      streamId: "other", type: "task.created", payload: { projectId: "project", title: "Other" }, causationId: null,
      correlationId: "other-trace",
    }]);
    const matching = journal.append("matching", 0, [{
      streamId: "matching", type: "task.created", payload: { projectId: "project", title: "Matching" }, causationId: null,
      correlationId: "expected-trace",
    }]);
    const sink = AgentTailJsonlFileSink.open(
      root,
      tracePath,
      "expected-trace",
      undefined,
      false,
    );

    new ProjectingEventJournal(journal, sink);

    const retained = readFileSync(tracePath, "utf8").trim().split("\n").map((line) =>
      JSON.parse(line) as { readonly event_id: string; readonly trace_id: string }
    );
    expect(retained.map(({ event_id, trace_id }) => ({ event_id, trace_id }))).toEqual([{
      event_id: matching[0]!.eventId,
      trace_id: "expected-trace",
    }]);
    expect(retained).toHaveLength(1);
    sink.close();
    journal.close();
  });

  it("redacts validation secrets in both backfill and live delivery", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "validation-redaction.jsonl");
    const journal = new SqliteEventJournal(path.join(root, "validation-redaction.db"));
    const validation = (canary: string) => ({ validation: {
      name: "focused", outcome: "failed", exitCode: 1,
      stdout: `${canary}_STDOUT`, stderr: `${canary}_STDERR`,
      command: ["node", `--secret=${canary}`],
      argvSha256: "a".repeat(64), outputSha256: "b".repeat(64),
      startedAt: "2026-07-01T00:00:00.000Z", finishedAt: "2026-07-01T00:00:01.000Z",
      provenance: { canonicalCwd: `/secret/${canary}`, subjectSha256: "c".repeat(64) },
    } });
    journal.append("task", 0, [{ streamId: "task", type: "task.validation_completed",
      payload: validation("BACKFILL_SECRET_CANARY"), causationId: null, correlationId: "trace" }]);
    const sink = AgentTailJsonlFileSink.open(root, tracePath, "trace");
    const projected = new ProjectingEventJournal(journal, sink);
    projected.append("task", 1, [{ streamId: "task", type: "task.validation_completed",
      payload: validation("LIVE_SECRET_CANARY"), causationId: null, correlationId: "trace" }]);
    sink.close();

    const retained = readFileSync(tracePath, "utf8");
    expect(retained).not.toMatch(/SECRET_CANARY|STDOUT|STDERR|--secret|\/secret\//);
    expect(retained.trim().split("\n")).toHaveLength(2);
    journal.close();
  });

  it("redacts OpenCode scopes and evidence summaries in backfill and live delivery", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "opencode-redaction.jsonl");
    const journal = new SqliteEventJournal(path.join(root, "opencode-redaction.db"));
    const scopeCanary = "ghp_BACKFILL_SCOPE_CREDENTIAL";
    const forbiddenCanary = "FORBIDDEN_PRIVATE_KEY_CANARY";
    const summaryCanary = "LIVE_EVIDENCE_SECRET_SUMMARY";
    journal.append("milestone", 0, [{
      streamId: "milestone", type: "milestone.task_running", causationId: null,
      correlationId: "trace", payload: {
        taskId: "research", capsuleId: "capsule-1", actorId: "researcher-1",
        role: "researcher", harness: "opencode",
        requestedModel: { capabilityId: "research-model", transportModelId: "provider/model" },
        budget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 },
        timeoutMs: 30_000,
        securityBoundary: {
          repository: "sanitized_read_only_bind_mount", scratch: "bounded_ephemeral",
          network: "model_broker_only", home: "ephemeral", credentials: "none", shell: "none",
          readableScopes: [`src/${scopeCanary}/**`], forbiddenPaths: [`.env/${forbiddenCanary}`],
          repositoryRevision: "a".repeat(64),
        },
      },
    }]);
    const sink = AgentTailJsonlFileSink.open(root, tracePath, "trace");
    const projected = new ProjectingEventJournal(journal, sink);
    projected.append("milestone", 1, [{
      streamId: "milestone", type: "milestone.task_completed", causationId: null,
      correlationId: "trace", payload: {
        taskId: "research", capsuleId: "capsule-1", outcome: "failed",
        actorId: "researcher-1", role: "researcher", harness: "opencode",
        capabilityId: "research-model", transportModelId: "provider/model",
        measuredHarness: null, model: null,
        evidence: [{
          kind: "research", summary: summaryCanary,
          sourceEvidenceIds: ["b".repeat(64)],
          sha256: createHash("sha256").update(summaryCanary, "utf8").digest("hex"),
          provenance: {
            harness: "opencode", capabilityId: "research-model",
            transportModelId: "provider/model", repositoryRevision: "a".repeat(64),
          },
        }],
        cleanup: "completed", brokerTransport: "completed", brokerFailureReason: null,
      },
    }]);
    sink.close();

    const retained = readFileSync(tracePath, "utf8");
    expect(retained).not.toMatch(new RegExp(`${scopeCanary}|${forbiddenCanary}|${summaryCanary}`));
    const payloads = retained.trim().split("\n").map((line) =>
      (JSON.parse(line) as { readonly payload: Record<string, unknown> }).payload);
    expect(payloads[0]).toMatchObject({
      taskId: "research",
      securityBoundary: { readableScopeCount: 1, forbiddenPathCount: 1 },
    });
    expect(payloads[1]).toMatchObject({
      taskId: "research", outcome: "failed", evidenceCount: 1,
      evidence: [{ kind: "research", sha256: expect.any(String) }],
    });
    journal.close();
  });

  it("supports legacy direct append by binding the first trace and rejecting another", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "legacy-direct.jsonl");
    let streamed = "";
    const sink = AgentTailJsonlFileSink.open(root, tracePath, (line) => { streamed += line; });

    sink.append([event({ correlationId: "legacy-trace" })]);
    expect(() => sink.append([event({
      eventId: "event-2", streamVersion: 2, globalPosition: 2,
      correlationId: "legacy-trace",
    })])).not.toThrow();
    expect(() => sink.append([event({
      eventId: "event-3", streamVersion: 3, globalPosition: 3,
      correlationId: "different-trace",
    })])).toThrow(/trace/i);
    sink.close();

    expect(streamed).toBe(readFileSync(tracePath, "utf8"));
    expect(readFileSync(tracePath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("refuses unscoped legacy selection and durable projection", () => {
    const { root } = fixture();
    const direct = AgentTailJsonlFileSink.open(root, path.join(root, "legacy-unscoped.jsonl"));
    expect(() => direct.select([event()])).toThrow(/explicit trace|unscoped/i);
    expect(() => direct.reconcile([])).toThrow(/explicit trace|unscoped/i);
    expect(() => direct.reconcileHistory([])).toThrow(/explicit trace|unscoped/i);
    expect(() => direct.projectionCursorName).toThrow(/explicit trace|unscoped/i);
    direct.close();

    const journal = new SqliteEventJournal(path.join(root, "legacy-unscoped.db"));
    const durable = AgentTailJsonlFileSink.open(root, path.join(root, "legacy-durable.jsonl"));
    expect(() => new ProjectingEventJournal(journal, durable)).toThrow(/explicit trace|unscoped/i);
    durable.close();
    journal.close();
  });

  it("leaves the durable cursor unadvanced when mandatory payload validation fails", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "invalid-payload.jsonl");
    const journal = new SqliteEventJournal(path.join(root, "invalid-payload.db"));
    journal.append("task", 0, [{ streamId: "task", type: "task.started",
      payload: {}, causationId: null, correlationId: "trace" }]);
    const sink = AgentTailJsonlFileSink.open(root, tracePath, "trace");

    const projected = new ProjectingEventJournal(journal, sink);

    expect(projected.projectionFailed).toBe(true);
    expect(journal.inspectProjectionCursor(sink.projectionCursorName)).toMatchObject({
      position: 0,
      activeClaimId: expect.any(String),
    });
    expect(readFileSync(tracePath)).toHaveLength(0);
    sink.close();
    journal.close();
  });

  it("reconciles a multibyte event identity split at the 64 KiB read boundary", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "utf8-boundary.jsonl");
    const probe = event({ eventId: "💥" });
    const probeLine = agentTailEventToJsonLine(storedEventToAgentTailEvent(probe));
    const emojiOffset = Buffer.from(probeLine.slice(0, probeLine.indexOf("💥")), "utf8").length;
    const longEventId = `${"a".repeat(65_535 - emojiOffset)}💥`;
    const sink = AgentTailJsonlFileSink.open(root, tracePath, "task-1");
    const retained = event({ eventId: longEventId });
    const retainedLine = agentTailEventToJsonLine(storedEventToAgentTailEvent(retained));
    expect(Buffer.from(retainedLine.slice(0, retainedLine.indexOf("💥")), "utf8").length).toBe(65_535);
    sink.append([retained]);
    sink.close();

    const reopened = AgentTailJsonlFileSink.open(root, tracePath, "task-1", undefined, true);
    expect(() => reopened.reconcileHistory([retained])).not.toThrow();
    reopened.close();
  });

  it("repairs a crash-torn active claim line and replays it exactly once", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "torn-active.jsonl");
    const journal = new SqliteEventJournal(path.join(root, "torn-active.db"));
    const stored = journal.append("task", 0, [{ streamId: "task", type: "task.started",
      payload: { workerId: "worker-1" }, causationId: null, correlationId: "trace" }]);
    const sink = AgentTailJsonlFileSink.open(root, tracePath, "trace");
    journal.ensureProjectionCursor(sink.projectionCursorName);
    journal.claimProjection(sink.projectionCursorName,
      "process:99999999:00000000-0000-4000-8000-000000000001");
    const canonical = agentTailEventToJsonLine(storedEventToAgentTailEvent(stored[0]!));
    writeFileSync(tracePath, Buffer.from(canonical, "utf8").subarray(0, 113));
    sink.close();

    const resumed = AgentTailJsonlFileSink.open(root, tracePath, "trace", undefined, true);
    const projected = new ProjectingEventJournal(journal, resumed);
    expect(projected.projectionFailed).toBe(false);
    expect(readFileSync(tracePath, "utf8")).toBe(canonical);
    expect(journal.inspectProjectionCursor(resumed.projectionCursorName)?.position).toBe(1);
    resumed.close();
    journal.close();
  });

  it("does not repair a torn line while a different live process owns the claim", async () => {
    const { root } = fixture();
    const tracePath = path.join(root, "torn-live-owner.jsonl");
    const journal = new SqliteEventJournal(path.join(root, "torn-live-owner.db"));
    const stored = journal.append("task", 0, [{ streamId: "task", type: "task.started",
      payload: { workerId: "worker-1" }, causationId: null, correlationId: "trace" }]);
    const first = AgentTailJsonlFileSink.open(root, tracePath, "trace");
    journal.ensureProjectionCursor(first.projectionCursorName);
    const owner = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      env: {},
    });
    try {
      await once(owner.stdout!, "data");
      journal.claimProjection(
        first.projectionCursorName,
        `process:${owner.pid}:00000000-0000-4000-8000-000000000001`,
      );
      const canonical = agentTailEventToJsonLine(storedEventToAgentTailEvent(stored[0]!));
      writeFileSync(tracePath, Buffer.from(canonical, "utf8").subarray(0, 113));
      first.close();
      const before = readFileSync(tracePath);
      const resumed = AgentTailJsonlFileSink.open(root, tracePath, "trace", undefined, true);

      expect(() => resumed.reconcileHistory([])).toThrow(/incomplete line/i);
      expect(() => resumed.repairTornClaim(
        journal,
        resumed.projectionCursorName,
        journal.inspectProjectionClaim(resumed.projectionCursorName)!.claimId,
        `process:${process.pid}:00000000-0000-4000-8000-000000000002`,
        [],
      )).toThrow(/claim owner|ownership/i);
      expect(readFileSync(tracePath)).toEqual(before);

      const projected = new ProjectingEventJournal(journal, resumed);

      expect(projected.projectionFailed).toBe(true);
      expect(readFileSync(tracePath)).toEqual(before);
      resumed.close();
    } finally {
      owner.kill("SIGTERM");
      await once(owner, "exit");
      journal.close();
    }
  });

  it("rejects malformed UTF-8 in a retained JSON string", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "invalid-utf8.jsonl");
    const bytes = Buffer.from('{"event_id":"e","sequence":1,"trace_id":"task-1","payload":"x"}\n');
    bytes[bytes.indexOf("x")] = 0xff;
    writeFileSync(tracePath, bytes);
    expect(() => AgentTailJsonlFileSink.open(root, tracePath, "task-1", undefined, true))
      .toThrow(/UTF-8|encoded/i);
  });

  it("rejects an invalid explicit trace identity", () => {
    const { root } = fixture();
    expect(() => AgentTailJsonlFileSink.open(root, path.join(root, "invalid-scope.jsonl"), ""))
      .toThrow(/expected trace/i);
  });

  it("fails closed when retained JSONL identity differs from the active claim", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "mismatch.jsonl");
    const databasePath = path.join(root, "mismatch.db");
    const firstJournal = new SqliteEventJournal(databasePath);
    const firstSink = AgentTailJsonlFileSink.open(root, tracePath, "trace");
    const commit = firstJournal.commitProjection.bind(firstJournal);
    firstJournal.commitProjection = (() => {
      throw new Error("simulated commit loss");
    }) as typeof firstJournal.commitProjection;
    new ProjectingEventJournal(
      firstJournal, firstSink, firstSink.projectionCursorName, 0,
      "process:99999999:00000000-0000-4000-8000-000000000001",
    ).append("task", 0, [{
      streamId: "task", type: "task.created", payload: { projectId: "project", title: "Mismatch" }, causationId: null,
      correlationId: "trace",
    }]);
    firstSink.close();
    firstJournal.close();
    const line = JSON.parse(readFileSync(tracePath, "utf8")) as Record<string, unknown>;
    line["event_id"] = "0".repeat(36);
    writeFileSync(tracePath, `${JSON.stringify(line)}\n`);

    const recoveredJournal = new SqliteEventJournal(databasePath);
    const recoveredSink = AgentTailJsonlFileSink.open(root, tracePath, "trace", undefined, true);
    const recovered = new ProjectingEventJournal(recoveredJournal, recoveredSink);

    expect(recovered.projectionFailed).toBe(true);
    expect(recoveredJournal.inspectProjectionCursor(
      AgentTailJsonlFileSink.projectionCursorName(tracePath),
    )).toMatchObject({ position: 0, activeClaimId: expect.any(String) });
    recoveredSink.close();
    recoveredJournal.close();
    void commit;
  });

  it("reconciles committed history exactly and rejects a modified committed payload", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "committed-modified.jsonl");
    const databasePath = path.join(root, "committed-modified.db");
    const firstJournal = new SqliteEventJournal(databasePath);
    const firstSink = AgentTailJsonlFileSink.open(root, tracePath, "trace");
    new ProjectingEventJournal(firstJournal, firstSink).append("task", 0, [{
      streamId: "task", type: "task.created", payload: { projectId: "project", title: "Original" },
      causationId: null, correlationId: "trace",
    }]);
    firstSink.close();
    firstJournal.close();
    const line = JSON.parse(readFileSync(tracePath, "utf8")) as Record<string, unknown>;
    line["payload"] = { title: "Modified" };
    writeFileSync(tracePath, `${JSON.stringify(line)}\n`);

    const reopenedJournal = new SqliteEventJournal(databasePath);
    const reopenedSink = AgentTailJsonlFileSink.open(root, tracePath, "trace", undefined, true);
    const reopened = new ProjectingEventJournal(reopenedJournal, reopenedSink);

    expect(reopened.projectionFailed).toBe(true);
    expect(reopenedJournal.inspectProjectionCursor(reopenedSink.projectionCursorName)?.position).toBe(1);
    reopenedSink.close();
    reopenedJournal.close();
  });

  it("rejects an extra structurally valid retained line after the committed cursor", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "committed-extra.jsonl");
    const databasePath = path.join(root, "committed-extra.db");
    const firstJournal = new SqliteEventJournal(databasePath);
    const firstSink = AgentTailJsonlFileSink.open(root, tracePath, "trace");
    new ProjectingEventJournal(firstJournal, firstSink).append("task", 0, [{
      streamId: "task", type: "task.created", payload: { projectId: "project", title: "Extra" }, causationId: null,
      correlationId: "trace",
    }]);
    firstSink.close();
    firstJournal.close();
    const original = JSON.parse(readFileSync(tracePath, "utf8")) as Record<string, unknown>;
    const extra = { ...original, event_id: "extra-event", sequence: 2 };
    writeFileSync(tracePath, `${JSON.stringify(original)}\n${JSON.stringify(extra)}\n`);

    const reopenedJournal = new SqliteEventJournal(databasePath);
    const reopenedSink = AgentTailJsonlFileSink.open(root, tracePath, "trace", undefined, true);
    const reopened = new ProjectingEventJournal(reopenedJournal, reopenedSink);

    expect(reopened.projectionFailed).toBe(true);
    reopenedSink.close();
    reopenedJournal.close();
  });

  it.each(["cancelled", "timed_out", "denied", "failed"] as const)(
    "retains a readable %s terminal outcome",
    (outcome) => {
      const { root } = fixture();
      const tracePath = path.join(root, `${outcome}.jsonl`);
      const sink = AgentTailJsonlFileSink.open(root, tracePath, "task-1");
      sink.append([event({ type: `task.${outcome}` })]);
      sink.close();

      expect(JSON.parse(readFileSync(tracePath, "utf8")) as unknown).toMatchObject({
        kind: `task.${outcome}`,
        operation: { status: outcome },
      });
    },
  );
});
