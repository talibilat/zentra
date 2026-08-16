import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  buildClaudeCodeArgv,
  buildClaudeCodeEnvironment,
  buildMcpConfig,
  redactClaudeCodeArgv,
  resolveClaudeCodeAuth,
} from "../../src/harnesses/claude-code-invocation.js";
import { EXPECTED_SERVER_NAME, PROPOSE_PATCH_TOOL } from "../../src/harnesses/claude-code-stream.js";

const base = { packet: '{"brief":"x"}', model: "claude-haiku-4-5-20251001", mcpConfig: '{"mcpServers":{}}' };

const originalApiKey = process.env.ANTHROPIC_API_KEY;
const originalUser = process.env.USER;

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  process.env.USER = "zentra-test-user";
});

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
  if (originalUser === undefined) {
    delete process.env.USER;
  } else {
    process.env.USER = originalUser;
  }
});

describe("resolveClaudeCodeAuth", () => {
  it("returns oauth mode when ANTHROPIC_API_KEY is unset", () => {
    const auth = resolveClaudeCodeAuth();
    expect(auth).toEqual({ mode: "oauth" });
  });

  it("returns oauth mode when ANTHROPIC_API_KEY is an empty string", () => {
    process.env.ANTHROPIC_API_KEY = "";
    const auth = resolveClaudeCodeAuth();
    expect(auth).toEqual({ mode: "oauth" });
  });

  it("returns oauth mode when ANTHROPIC_API_KEY is whitespace only", () => {
    process.env.ANTHROPIC_API_KEY = "   ";
    const auth = resolveClaudeCodeAuth();
    expect(auth).toEqual({ mode: "oauth" });
  });

  it("returns api_key mode with the original value when ANTHROPIC_API_KEY is set to a real value", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key-123";
    const auth = resolveClaudeCodeAuth();
    expect(auth).toEqual({ mode: "api_key", apiKey: "sk-test-key-123" });
  });

  it("preserves leading and trailing whitespace in the api key", () => {
    process.env.ANTHROPIC_API_KEY = "  sk-test-key  ";
    const auth = resolveClaudeCodeAuth();
    expect(auth).toEqual({ mode: "api_key", apiKey: "  sk-test-key  " });
  });
});

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

  it("permits propose_patch at the permission layer", () => {
    // Regression test for D33. --allowedTools is a permission allow-list, and a
    // headless run under --permission-mode default auto-denies anything absent
    // from it. With propose_patch missing, the real binary refused the writer's
    // only sanctioned way to make a change. Every fixture test still passed,
    // because they asserted the flags were built as specified and they were -
    // the specification was wrong. Only the live suite caught it.
    const argv = buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } });
    const allowed = argv[argv.indexOf("--allowedTools") + 1]!.split(",");
    expect(allowed).toContain(PROPOSE_PATCH_TOOL);
  });

  it("does not structurally remove propose_patch", () => {
    const argv = buildClaudeCodeArgv({ ...base, auth: { mode: "oauth" } });
    const denied = argv[argv.indexOf("--disallowedTools") + 1]!.split(",");
    expect(denied).not.toContain(PROPOSE_PATCH_TOOL);
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

  it("carries USER from Zentra's own environment in oauth mode, for the macOS keychain lookup", () => {
    const env = buildClaudeCodeEnvironment({ mcpToken: "tok", auth: { mode: "oauth" } });
    expect(env["USER"]).toBe("zentra-test-user");
  });

  it("does not carry USER in api_key mode, since --bare never reads the keychain", () => {
    const env = buildClaudeCodeEnvironment({ mcpToken: "tok", auth: { mode: "api_key", apiKey: "sk-x" } });
    expect(env["USER"]).toBeUndefined();
  });

  it("throws in oauth mode when Zentra's own USER is unset, rather than shipping a confusing 'Not logged in'", () => {
    delete process.env.USER;
    expect(() => buildClaudeCodeEnvironment({ mcpToken: "tok", auth: { mode: "oauth" } }))
      .toThrow("oauth mode requires USER");
  });

  it("throws in oauth mode when Zentra's own USER is an empty string", () => {
    process.env.USER = "";
    expect(() => buildClaudeCodeEnvironment({ mcpToken: "tok", auth: { mode: "oauth" } }))
      .toThrow("oauth mode requires USER");
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
