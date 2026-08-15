import { describe, expect, it } from "vitest";

import { inspectInitEvent } from "../../src/harnesses/claude-code-stream.js";

const PROPOSE_TOOL = "mcp__zentra__propose_patch";

function initEvent(tools: readonly string[], servers: readonly { name: string; status: string }[]): unknown {
  return { type: "system", subtype: "init", tools, mcp_servers: servers };
}

describe("inspectInitEvent", () => {
  it("accepts the expected surface with a connected server", () => {
    const result = inspectInitEvent([
      initEvent(["Read", "Glob", "Grep", PROPOSE_TOOL], [{ name: "zentra", status: "connected" }]),
    ]);
    expect(result).toEqual({ unexpectedTools: [], proposeToolPresent: true, disconnectedServers: [] });
  });

  it("tolerates a missing read tool", () => {
    const result = inspectInitEvent([
      initEvent(["Read", PROPOSE_TOOL], [{ name: "zentra", status: "connected" }]),
    ]);
    expect(result?.unexpectedTools).toEqual([]);
    expect(result?.proposeToolPresent).toBe(true);
  });

  it("reports a file-mutating tool that survived the deny-list", () => {
    const result = inspectInitEvent([
      initEvent(["Read", "NotebookEdit", PROPOSE_TOOL], [{ name: "zentra", status: "connected" }]),
    ]);
    expect(result?.unexpectedTools).toEqual(["NotebookEdit"]);
  });

  it("reports a failed MCP server", () => {
    const result = inspectInitEvent([
      initEvent(["Read", PROPOSE_TOOL], [{ name: "zentra", status: "failed" }]),
    ]);
    expect(result?.disconnectedServers).toEqual(["zentra"]);
  });

  it("treats an unknown server status as disconnected", () => {
    const result = inspectInitEvent([
      initEvent(["Read", PROPOSE_TOOL], [{ name: "zentra", status: "degraded" }]),
    ]);
    expect(result?.disconnectedServers).toEqual(["zentra"]);
  });

  it("reports the propose tool missing", () => {
    const result = inspectInitEvent([
      initEvent(["Read", "Glob"], [{ name: "zentra", status: "connected" }]),
    ]);
    expect(result?.proposeToolPresent).toBe(false);
  });

  it("returns null when no init event is present", () => {
    expect(inspectInitEvent([{ type: "assistant" }])).toBeNull();
  });
});
