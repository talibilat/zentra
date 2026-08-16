import { describe, expect, it } from "vitest";

import { inspectInitEvent, parseClaudeCodeUsage, parseDeniedToolRequests } from "../../src/harnesses/claude-code-stream.js";

const PROPOSE_TOOL = "mcp__zentra__propose_patch";

function initEvent(tools: readonly string[], servers: readonly { name: string; status: string }[]): unknown {
  return { type: "system", subtype: "init", tools, mcp_servers: servers };
}

describe("inspectInitEvent", () => {
  it("accepts the expected surface with a connected server", () => {
    const result = inspectInitEvent([
      initEvent(["Read", "Glob", "Grep", PROPOSE_TOOL], [{ name: "zentra", status: "connected" }]),
    ]);
    expect(result).toEqual({
      unexpectedTools: [],
      proposeToolPresent: true,
      expectedServerConnected: true,
      disconnectedServers: [],
    });
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
    expect(result?.expectedServerConnected).toBe(false);
  });

  it("treats an unknown server status as disconnected", () => {
    const result = inspectInitEvent([
      initEvent(["Read", PROPOSE_TOOL], [{ name: "zentra", status: "degraded" }]),
    ]);
    expect(result?.disconnectedServers).toEqual(["zentra"]);
    expect(result?.expectedServerConnected).toBe(false);
  });

  it("treats an empty mcp_servers list as the expected server missing", () => {
    const result = inspectInitEvent([initEvent(["Read", PROPOSE_TOOL], [])]);
    expect(result?.expectedServerConnected).toBe(false);
    expect(result?.disconnectedServers).toEqual([]);
  });

  it("treats a missing mcp_servers key as the expected server missing", () => {
    const result = inspectInitEvent([
      { type: "system", subtype: "init", tools: ["Read", PROPOSE_TOOL] },
    ]);
    expect(result?.expectedServerConnected).toBe(false);
    expect(result?.disconnectedServers).toEqual([]);
  });

  it("treats a different connected server with zentra absent as the expected server missing", () => {
    const result = inspectInitEvent([
      initEvent(["Read", PROPOSE_TOOL], [{ name: "other", status: "connected" }]),
    ]);
    expect(result?.expectedServerConnected).toBe(false);
    expect(result?.disconnectedServers).toEqual([]);
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

const resultEvent = {
  type: "result",
  subtype: "success",
  is_error: false,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 27127,
    cache_read_input_tokens: 512,
    output_tokens: 43,
  },
  permission_denials: [
    { tool_name: "Write", tool_use_id: "toolu_01", tool_input: { file_path: "/w/notes.txt", content: "x" } },
  ],
};

describe("parseClaudeCodeUsage", () => {
  it("maps the native usage block", () => {
    const { usage, evidence } = parseClaudeCodeUsage([resultEvent]);
    expect(evidence).toBe("native");
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 43,
      reasoningTokens: 0,
      cacheReadTokens: 512,
      cacheWriteTokens: 27127,
      toolCalls: 0,
    });
  });

  it("counts tool_use blocks", () => {
    const assistant = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: {} }, { type: "text", text: "hi" }] },
    };
    expect(parseClaudeCodeUsage([assistant, resultEvent]).usage.toolCalls).toBe(1);
  });

  it("reports no evidence when the result carries no usage", () => {
    const { usage, evidence } = parseClaudeCodeUsage([{ type: "result", subtype: "success" }]);
    expect(evidence).toBe("none");
    expect(usage.inputTokens).toBe(0);
  });
});

describe("parseDeniedToolRequests", () => {
  it("records a permission-layer denial with its path", () => {
    expect(parseDeniedToolRequests([resultEvent])).toEqual([{ tool: "Write", path: "/w/notes.txt" }]);
  });

  it("records a structurally removed tool from its tool_use_error", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }] } },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "t1",
            is_error: true,
            content: "<tool_use_error>Error: No such tool available: Write. Write exists but is not enabled in this context.</tool_use_error>",
          }],
        },
      },
    ];
    expect(parseDeniedToolRequests(events)).toEqual([{ tool: "Write", path: null }]);
  });

  it("does not record an ordinary tool error as a denial", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "File not found" }] },
      },
    ];
    expect(parseDeniedToolRequests(events)).toEqual([]);
  });
});
