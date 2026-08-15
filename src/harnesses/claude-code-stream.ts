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
