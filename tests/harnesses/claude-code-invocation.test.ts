import { describe, expect, it } from "vitest";

import {
  buildClaudeCodeArgv,
  buildClaudeCodeEnvironment,
  buildMcpConfig,
  redactClaudeCodeArgv,
} from "../../src/harnesses/claude-code-invocation.js";
import { EXPECTED_SERVER_NAME } from "../../src/harnesses/claude-code-stream.js";

const base = { packet: '{"brief":"x"}', model: "claude-haiku-4-5-20251001", mcpConfig: '{"mcpServers":{}}' };

describe("buildClaudeCodeArgv", () => {
  it("carries every isolation flag", () => {
    const argv = buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } });
    expect(argv).toContain("--setting-sources");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("--verbose");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
  });

  it("denies every tool observed on a 2.1.207 surface", () => {
    const argv = buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } });
    const denied = argv[argv.indexOf("--disallowedTools") + 1]!.split(",");
    // The first six are the mutating set. The rest were measured as still
    // advertised at init when only those six were denied, and several of them
    // execute or persist state: CronCreate schedules recurring work,
    // EnterWorktree mutates git, SendMessage reaches other agents.
    for (const tool of [
      "Edit", "Write", "Bash", "WebFetch", "Task", "NotebookEdit",
      "CronCreate", "EnterWorktree", "SendMessage", "Skill", "Workflow", "ToolSearch",
    ]) {
      expect(denied).toContain(tool);
    }
  });

  it("never denies a tool the writer legitimately needs", () => {
    const argv = buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } });
    const denied = argv[argv.indexOf("--disallowedTools") + 1]!.split(",");
    for (const tool of ["Read", "Glob", "Grep"]) {
      expect(denied).not.toContain(tool);
    }
  });

  it("adds --bare only in api_key mode", () => {
    expect(buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } })).not.toContain("--bare");
    expect(buildClaudeCodeArgv({ ...base, auth: { mode: "api_key", apiKey: "k" } })).toContain("--bare");
  });

  it("puts the packet last", () => {
    const argv = buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } });
    expect(argv[argv.length - 1]).toBe(base.packet);
  });
});

describe("buildClaudeCodeEnvironment", () => {
  it("carries the MCP token and no credential in oauth mode", () => {
    const env = buildClaudeCodeEnvironment({ home: "/h", mcpToken: "tok", auth: { mode: "oauth" } });
    expect(env["ZENTRA_WRITER_MCP_TOKEN"]).toBe("tok");
    expect(env["HOME"]).toBe("/h");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("carries the key in api_key mode", () => {
    const env = buildClaudeCodeEnvironment({ mcpToken: "tok", auth: { mode: "api_key", apiKey: "sk-x" } });
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-x");
  });

  it("never forwards a parent Claude Code delegation variable", () => {
    const env = buildClaudeCodeEnvironment({ mcpToken: "tok", auth: { mode: "oauth" } });
    for (const key of Object.keys(env)) {
      expect(key.startsWith("CLAUDE_CODE_")).toBe(false);
      expect(key).not.toBe("CLAUDECODE");
    }
  });
});

describe("buildMcpConfig", () => {
  it("references the token by env var rather than inlining it", () => {
    const config = buildMcpConfig("http://127.0.0.1:1/mcp", "ZENTRA_WRITER_MCP_TOKEN");
    expect(config).toContain("${ZENTRA_WRITER_MCP_TOKEN}");
    expect(JSON.parse(config).mcpServers.zentra.type).toBe("http");
  });

  it("uses EXPECTED_SERVER_NAME for the server key, binding it to inspectInitEvent's expectation", () => {
    const config = buildMcpConfig("http://127.0.0.1:1/mcp", "ZENTRA_WRITER_MCP_TOKEN");
    const parsed = JSON.parse(config);
    const serverKeys = Object.keys(parsed.mcpServers);
    expect(serverKeys).toHaveLength(1);
    expect(serverKeys[0]).toBe(EXPECTED_SERVER_NAME);
  });
});

describe("redactClaudeCodeArgv", () => {
  it("removes the packet, the model, and the MCP config", () => {
    const argv = buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } });
    const redacted = redactClaudeCodeArgv(argv);
    expect(redacted).not.toContain(base.packet);
    expect(redacted).not.toContain(base.model);
    expect(redacted).not.toContain(base.mcpConfig);
    expect(redacted[redacted.length - 1]).toBe("<writer-task-packet>");
  });
});
