import { describe, expect, it } from "vitest";

import { AttentionService } from "../../src/attention/attention-service.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { AgentTrailAttentionBridge } from "../../src/observability/agenttrail-attention-bridge.js";

describe("AgentTrailAttentionBridge", () => {
  it("publishes idempotent evidence-backed advisory attention with no policy effect", () => {
    const journal = new SqliteEventJournal(":memory:");
    journal.append("run:run-warning", 0, [{ streamId: "run:run-warning", type: "run.accepted", payload: {},
      causationId: null, correlationId: "run-warning" }]);
    const attention = new AttentionService(journal);
    const bridge = new AgentTrailAttentionBridge(attention);
    const warning = { runId: "run-warning", code: "STALE_HEARTBEAT", summary: "Worker heartbeat is stale.",
      actorId: "worker-1", eventIds: ["event-10", "event-11"],
      affectedScopes: ["task:task-1"], dependentScopes: ["pod:pod-1"] };

    const first = bridge.publish(warning);
    const second = bridge.publish(warning);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ kind: "advisory", material: false, authority: "none",
      warningCode: "STALE_HEARTBEAT", status: "pending",
      affectedScopes: ["task:task-1"], dependentScopes: ["pod:pod-1"] });
    expect(attention.pausedScopes("run-warning")).toEqual([]);
    expect(attention.attentionIndex("run-warning").pending).toEqual({});
    expect(journal.readStream("run:run-warning").map((event) => event.type)).toEqual(["run.accepted"]);
    expect(journal.readAll().some((event) => /policy|pause|cancel/.test(event.type))).toBe(false);
    journal.close();
  });
});
