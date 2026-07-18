import { describe, expect, it } from "vitest";

import { OpenCodeWorkerEventAdapter } from "../../src/agents/opencode-worker-event-adapter.js";

describe("OpenCodeWorkerEventAdapter", () => {
  it("maps only process and resource evidence that OpenCode supervision actually measures", () => {
    const adapter = new OpenCodeWorkerEventAdapter();
    expect(adapter.processObservation("opencode", "completed")).toEqual({ kind: "process", name: "opencode", outcome: "completed" });
    expect(adapter.resourceObservation("container", "uncertain")).toEqual({ kind: "resource", name: "container", outcome: "uncertain" });
  });

  it("fails explicitly on task or subagent attempts because OpenCode 1.18.3 has no supported observable nested protocol", () => {
    const adapter = new OpenCodeWorkerEventAdapter();
    expect(() => adapter.rejectDelegation("task")).toThrow(/delegation is disabled.*no supported observable lifecycle/i);
    expect(() => adapter.rejectDelegation("subagent")).toThrow(/delegation is disabled/i);
    expect(() => adapter.assertNoDelegation([{ type: "tool_use", part: { tool: "task" } }])).toThrow(/delegation is disabled/i);
    expect(() => adapter.assertNoDelegation([{ type: "step_start" }, { type: "text", part: { type: "text" } }])).not.toThrow();
  });
});
