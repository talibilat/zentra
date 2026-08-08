import { describe, expect, it } from "vitest";

import { reshapeTrail } from "../../../src/gateway/console/trail-reshape.js";

const RUN_DETAIL = {
  run: { trace_id: "trace-1" },
  duration_seconds: 42.5,
  events: [
    {
      event_id: "evt-1", offset_seconds: 1.5, sequence: 1, kind: "tool.call.attempt",
      actor: { id: "pod-a" }, operation: { status: "running", name: "run_tests" },
      relationships: [], payload: { preview: { ok: true } },
    },
    {
      event_id: "evt-2", offset_seconds: 3.25, sequence: 2, kind: "verification.finished",
      actor: { id: "pod-a" }, operation: { status: "failed", error: "assertion mismatch" },
      relationships: [{ type: "caused_by", event_id: "evt-1" }], payload: { preview: { detail: "boom" } },
    },
    {
      event_id: "evt-3", offset_seconds: 4.0, sequence: 3, kind: "scheduler.task_ready.failed",
      actor: { id: "pod-b" }, operation: { status: "done" },
      relationships: [], payload: null,
    },
  ],
  actors: [
    { id: "pod-a", role: "implementation" },
    { id: "pod-b", role: null },
  ],
};

describe("reshapeTrail", () => {
  it("maps run id and duration from AgentTrail's run_detail shape", () => {
    const view = reshapeTrail(RUN_DETAIL);
    expect(view.runId).toBe("trace-1");
    expect(view.durationSeconds).toBe(42.5);
  });

  it("maps each event's presentational fields", () => {
    const view = reshapeTrail(RUN_DETAIL);
    const first = view.events[0]!;
    expect(first.id).toBe("evt-1");
    expect(first.offsetSeconds).toBe(1.5);
    expect(first.kind).toBe("tool.call.attempt");
    expect(first.name).toBe("run_tests");
    expect(first.summary).toBe("tool.call.attempt - running");
    expect(first.actorId).toBe("pod-a");
    expect(first.failed).toBe(false);
    expect(first.sequence).toBe(1);
    expect(first.payload).toEqual({ preview: { ok: true } });
  });

  it("uses operation.error as the summary when present", () => {
    const view = reshapeTrail(RUN_DETAIL);
    expect(view.events[1]!.summary).toBe("assertion mismatch");
  });

  it("falls back to the last kind segment as the name when operation.name is absent", () => {
    const view = reshapeTrail(RUN_DETAIL);
    expect(view.events[1]!.name).toBe("finished");
  });

  it("classifies an event as failed when operation.status is a failure status", () => {
    const view = reshapeTrail(RUN_DETAIL);
    expect(view.events[1]!.failed).toBe(true);
  });

  it("classifies an event as failed when its kind ends in .failed regardless of status", () => {
    const view = reshapeTrail(RUN_DETAIL);
    expect(view.events[2]!.failed).toBe(true);
  });

  it("maps relationships into evidence links", () => {
    const view = reshapeTrail(RUN_DETAIL);
    expect(view.events[1]!.evidence).toEqual([{ type: "caused_by", refEventId: "evt-1" }]);
    expect(view.events[0]!.evidence).toEqual([]);
  });

  it("assigns each actor a deterministic color and glyph, stable across calls", () => {
    const first = reshapeTrail(RUN_DETAIL);
    const second = reshapeTrail(RUN_DETAIL);
    expect(first.actors[0]!.color).toBe(second.actors[0]!.color);
    expect(first.actors[0]!.glyph).toBe("I");
    expect(first.actors[1]!.glyph).toBe("P");
  });

  it("throws when the raw response is not an object", () => {
    expect(() => reshapeTrail("not an object")).toThrow();
    expect(() => reshapeTrail(null)).toThrow();
  });

  it("degrades gracefully when events or actors are missing entirely", () => {
    const view = reshapeTrail({ run: { trace_id: "trace-2" } });
    expect(view.events).toEqual([]);
    expect(view.actors).toEqual([]);
    expect(view.durationSeconds).toBe(0);
  });
});

const RUN_DETAIL_WITH_ACTOR_DETAIL = {
  ...RUN_DETAIL,
  actors: [
    {
      id: "pod-a", role: "implementation", model: "claude-sonnet-5", status: "running",
      usage: {
        input_tokens: { available: true, value: 120 },
        output_tokens: { available: true, value: 340 },
        total_tokens: { available: true, value: 460 },
        cost_usd: { available: false, value: null },
      },
    },
    { id: "pod-b", role: null },
  ],
};

describe("reshapeTrail actor detail", () => {
  it("maps model, status, and usage metrics from the raw actor payload", () => {
    const view = reshapeTrail(RUN_DETAIL_WITH_ACTOR_DETAIL);
    const actor = view.actors[0]!;
    expect(actor.model).toBe("claude-sonnet-5");
    expect(actor.status).toBe("running");
    expect(actor.usage).toEqual({
      inputTokens: { available: true, value: 120 },
      outputTokens: { available: true, value: 340 },
      totalTokens: { available: true, value: 460 },
      costUsd: { available: false, value: null },
    });
  });

  it("defaults model to null, status to unknown, and every usage metric to unavailable when absent", () => {
    const view = reshapeTrail(RUN_DETAIL_WITH_ACTOR_DETAIL);
    const actor = view.actors[1]!;
    expect(actor.model).toBeNull();
    expect(actor.status).toBe("unknown");
    expect(actor.usage).toEqual({
      inputTokens: { available: false, value: null },
      outputTokens: { available: false, value: null },
      totalTokens: { available: false, value: null },
      costUsd: { available: false, value: null },
    });
  });
});
