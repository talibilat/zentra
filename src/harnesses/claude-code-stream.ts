import type { WriterUsage } from "./harness-writer.js";

/** The only tools a Zentra writer may be offered. Anything else aborts the run (D26). */
export const PROPOSE_PATCH_TOOL = "mcp__zentra__propose_patch";
export const EXPECTED_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", PROPOSE_PATCH_TOOL]);

/** The MCP server name Zentra's generated config uses. This is the server the trust decision hinges on. */
export const EXPECTED_SERVER_NAME = "zentra";

/**
 * The literal Claude Code reports for a healthy MCP server. Checked as an
 * allow-list rather than denying "failed", so an unrecognized third state
 * reads as unhealthy instead of failing open (spec, "One unconfirmed literal").
 */
const CONNECTED_STATUS = "connected";

export interface InitInspection {
  readonly unexpectedTools: readonly string[];
  readonly proposeToolPresent: boolean;
  /**
   * True only when `mcp_servers` contains an entry named EXPECTED_SERVER_NAME
   * whose status is CONNECTED_STATUS. This is a positive check, not "no
   * disconnected servers were reported" - an unreachable MCP server does not
   * fail a `claude -p` run, it reports success and exit 0, and the only
   * signal is this field being false (empty mcp_servers, a missing key, the
   * server present with any other status, or only other servers present all
   * read as false here).
   *
   * Measured fact: with no MCP config at all, the real binary reports
   * `mcp_servers: []` and also omits `mcp__zentra__propose_patch` from
   * `tools`, so `proposeToolPresent` happens to fail closed too in that
   * case. This field does not rely on that coupling holding across
   * releases - it requires the expected server by name, present and
   * connected, independent of what `tools` advertises.
   */
  readonly expectedServerConnected: boolean;
  /** Diagnostic only - names of servers present but not connected. Do not use this to decide trust; use expectedServerConnected. */
  readonly disconnectedServers: readonly string[];
}

export function inspectInitEvent(events: readonly unknown[]): InitInspection | null {
  for (const event of events) {
    const record = asRecord(event);
    if (record === null || record["type"] !== "system" || record["subtype"] !== "init") continue;
    const tools = asStringArray(record["tools"]);
    const servers = Array.isArray(record["mcp_servers"]) ? record["mcp_servers"] : [];
    const disconnected: string[] = [];
    let expectedServerConnected = false;
    for (const entry of servers) {
      const server = asRecord(entry);
      if (server === null) continue;
      const name = typeof server["name"] === "string" ? server["name"] : "unknown";
      const connected = server["status"] === CONNECTED_STATUS;
      if (connected) {
        if (name === EXPECTED_SERVER_NAME) expectedServerConnected = true;
      } else {
        disconnected.push(name);
      }
    }
    return {
      unexpectedTools: tools.filter((tool) => !EXPECTED_TOOLS.has(tool)),
      proposeToolPresent: tools.includes(PROPOSE_PATCH_TOOL),
      expectedServerConnected,
      disconnectedServers: disconnected,
    };
  }
  return null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Claude Code emits this when a tool was structurally removed by
 * --disallowedTools. Unlike a permission-layer denial it never reaches
 * permission_denials, so the stream is the only record of the attempt (D25).
 */
const NOT_ENABLED_MARKER = "is not enabled in this context";

const MAX_TOKENS = 2_000_000;

export function parseClaudeCodeUsage(events: readonly unknown[]): {
  readonly usage: WriterUsage;
  readonly evidence: "native" | "none";
} {
  let toolCalls = 0;
  let evidence: "native" | "none" = "none";
  let usage: Omit<WriterUsage, "toolCalls"> = {
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  };
  for (const event of events) {
    const record = asRecord(event);
    if (record === null) continue;
    for (const block of contentBlocks(record)) {
      if (block["type"] === "tool_use") toolCalls += 1;
    }
    if (record["type"] !== "result") continue;
    const block = asRecord(record["usage"]);
    if (block === null) continue;
    if (evidence === "native") throw new Error("Claude Code writer stream contains more than one result usage block");
    evidence = "native";
    usage = {
      inputTokens: tokenCount(block["input_tokens"], "input_tokens"),
      outputTokens: tokenCount(block["output_tokens"], "output_tokens"),
      reasoningTokens: 0,
      cacheReadTokens: tokenCount(block["cache_read_input_tokens"], "cache_read_input_tokens"),
      cacheWriteTokens: tokenCount(block["cache_creation_input_tokens"], "cache_creation_input_tokens"),
    };
  }
  if (!Number.isSafeInteger(toolCalls) || toolCalls > 100_000) {
    throw new Error("Claude Code writer tool usage exceeds bounded range");
  }
  return { usage: { ...usage, toolCalls }, evidence };
}

export function parseDeniedToolRequests(
  events: readonly unknown[],
): readonly { readonly tool: string; readonly path: string | null }[] {
  const denied: { tool: string; path: string | null }[] = [];
  const toolNamesById = new Map<string, string>();
  for (const event of events) {
    const record = asRecord(event);
    if (record === null) continue;
    for (const block of contentBlocks(record)) {
      if (block["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string") {
        toolNamesById.set(block["id"], block["name"]);
        continue;
      }
      if (block["type"] !== "tool_result" || block["is_error"] !== true) continue;
      if (!textOf(block["content"]).includes(NOT_ENABLED_MARKER)) continue;
      const id = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "";
      denied.push({ tool: toolNamesById.get(id) ?? "unknown", path: null });
    }
    if (record["type"] !== "result" || !Array.isArray(record["permission_denials"])) continue;
    for (const entry of record["permission_denials"]) {
      const denial = asRecord(entry);
      if (denial === null) continue;
      const input = asRecord(denial["tool_input"]);
      const path = input === null ? null : input["file_path"];
      denied.push({
        tool: typeof denial["tool_name"] === "string" ? denial["tool_name"] : "unknown",
        path: typeof path === "string" ? path : null,
      });
    }
  }
  return denied;
}

function contentBlocks(record: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[] {
  const message = asRecord(record["message"]);
  const content = message === null ? undefined : message["content"];
  if (!Array.isArray(content)) return [];
  return content.map(asRecord).filter((block): block is Readonly<Record<string, unknown>> => block !== null);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry) => {
    const block = asRecord(entry);
    return block !== null && typeof block["text"] === "string" ? block["text"] : "";
  }).join("");
}

function tokenCount(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_TOKENS) {
    throw new Error(`Claude Code writer ${label} must be a nonnegative bounded safe integer`);
  }
  return value;
}
