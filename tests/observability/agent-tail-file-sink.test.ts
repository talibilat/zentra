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

import { afterEach, describe, expect, it } from "vitest";

import type { StoredEvent } from "../../src/contracts/event.js";
import {
  AgentTailJsonlFileSink,
  assertSafeAgentTailJsonlPath,
} from "../../src/observability/agent-tail-file-sink.js";

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
  return {
    streamId: "task-1",
    type: "task.started",
    payload: { text: "hello, 世界" },
    causationId: null,
    correlationId: "task-1",
    eventId: "event-1",
    streamVersion: 1,
    globalPosition: 1,
    recordedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("AgentTailJsonlFileSink", () => {
  it("appends accepted events as readable UTF-8 JSONL without replacing earlier bytes", () => {
    const { root } = fixture();
    const tracePath = path.join(root, "task-1.jsonl");
    const sink = AgentTailJsonlFileSink.open(root, tracePath);

    sink.append([event()]);
    const firstBytes = readFileSync(tracePath);
    expect(firstBytes.toString("utf8")).toContain("hello, 世界");
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
    const sink = AgentTailJsonlFileSink.open(root, tracePath, (line) => {
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
    const sink = AgentTailJsonlFileSink.open(root, tracePath, () => {
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

    expect(() => AgentTailJsonlFileSink.open(root, tracePath)).toThrow(
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
    expect(() => AgentTailJsonlFileSink.open(root, linkedTarget)).toThrow(
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
    expect(() => AgentTailJsonlFileSink.open(root, directoryPath)).toThrow(
      "Agent Tail trace path must not already exist",
    );
  });

  it("rejects duplicate or out-of-order accepted events", () => {
    const { root } = fixture();
    const sink = AgentTailJsonlFileSink.open(root, path.join(root, "trace.jsonl"));
    sink.append([event()]);

    expect(() => sink.append([event()])).toThrow("Agent Tail trace event was already appended");
    expect(() => sink.append([event({ eventId: "event-0", globalPosition: 0 })])).toThrow(
      "Agent Tail trace events must follow journal order",
    );
    sink.close();
  });

  it.each(["cancelled", "timed_out", "denied", "failed"] as const)(
    "retains a readable %s terminal outcome",
    (outcome) => {
      const { root } = fixture();
      const tracePath = path.join(root, `${outcome}.jsonl`);
      const sink = AgentTailJsonlFileSink.open(root, tracePath);
      sink.append([event({ type: `task.${outcome}` })]);
      sink.close();

      expect(JSON.parse(readFileSync(tracePath, "utf8")) as unknown).toMatchObject({
        kind: `task.${outcome}`,
        operation: { status: outcome },
      });
    },
  );
});
