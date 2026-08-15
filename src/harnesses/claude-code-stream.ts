/** The only tools a Zentra writer may be offered. Anything else aborts the run (D26). */
export const PROPOSE_PATCH_TOOL = "mcp__zentra__propose_patch";
export const EXPECTED_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", PROPOSE_PATCH_TOOL]);

/**
 * The literal Claude Code reports for a healthy MCP server. Checked as an
 * allow-list rather than denying "failed", so an unrecognized third state
 * reads as unhealthy instead of failing open (spec, "One unconfirmed literal").
 */
const CONNECTED_STATUS = "connected";

export interface InitInspection {
  readonly unexpectedTools: readonly string[];
  readonly proposeToolPresent: boolean;
  readonly disconnectedServers: readonly string[];
}

export function inspectInitEvent(events: readonly unknown[]): InitInspection | null {
  for (const event of events) {
    const record = asRecord(event);
    if (record === null || record["type"] !== "system" || record["subtype"] !== "init") continue;
    const tools = asStringArray(record["tools"]);
    const servers = Array.isArray(record["mcp_servers"]) ? record["mcp_servers"] : [];
    const disconnected: string[] = [];
    for (const entry of servers) {
      const server = asRecord(entry);
      if (server === null) continue;
      if (server["status"] !== CONNECTED_STATUS) {
        disconnected.push(typeof server["name"] === "string" ? server["name"] : "unknown");
      }
    }
    return {
      unexpectedTools: tools.filter((tool) => !EXPECTED_TOOLS.has(tool)),
      proposeToolPresent: tools.includes(PROPOSE_PATCH_TOOL),
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
