/**
 * Tools denied structurally. NotebookEdit is on this list because it writes
 * files and survived the originally specified deny-list (D26). The list is a
 * floor, not the security boundary: inspectInitEvent is what actually holds,
 * because a future release could add a mutating tool this list does not name.
 */
const DENIED_TOOLS = [
  // Mutating or executing.
  "Edit", "Write", "Bash", "WebFetch", "Task", "NotebookEdit",
  // Present on a 2.1.207 desktop build and reachable without any of the above.
  // CronCreate schedules recurring execution, EnterWorktree mutates git state,
  // and SendMessage reaches other agents. Measured, not guessed: with only the
  // first line denied, all of these were still advertised at init.
  "CronCreate", "CronDelete", "CronList", "DesignSync", "EnterWorktree", "ExitWorktree",
  "Monitor", "PushNotification", "RemoteTrigger", "ReportFindings", "ScheduleWakeup",
  "SendMessage", "Skill", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop",
  "TaskUpdate", "ToolSearch", "WebSearch", "Workflow", "Artifact",
] as const;
const ALLOWED_TOOLS = ["Read", "Glob", "Grep"] as const;

const PROTOCOL_INSTRUCTIONS = [
  "You are a Zentra writer. You cannot modify any file directly.",
  "The only way to express a change is the propose_patch tool.",
  "Call it at most once, with the complete set of file operations.",
  "If no change is needed, say so and make no call.",
].join(" ");

export interface ClaudeCodeAuth {
  readonly mode: "oauth" | "api_key";
  readonly apiKey?: string;
}

export function buildClaudeCodeArgv(input: {
  readonly packet: string;
  readonly model: string;
  readonly mcpConfig: string;
  readonly auth: ClaudeCodeAuth;
}): readonly string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", input.model,
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", input.mcpConfig,
    "--disallowedTools", DENIED_TOOLS.join(","),
    "--allowedTools", ALLOWED_TOOLS.join(","),
    "--permission-mode", "default",
    "--append-system-prompt", PROTOCOL_INSTRUCTIONS,
    ...(input.auth.mode === "api_key" ? ["--bare"] : []),
    input.packet,
  ];
}

export function buildClaudeCodeEnvironment(input: {
  readonly home?: string;
  readonly mcpToken: string;
  readonly auth: ClaudeCodeAuth;
}): Readonly<Record<string, string>> {
  if (input.auth.mode === "api_key" && (input.auth.apiKey ?? "") === "") {
    throw new Error("Claude Code writer api_key mode requires a key");
  }
  return {
    ...(input.home === undefined ? {} : { HOME: input.home }),
    ZENTRA_WRITER_MCP_TOKEN: input.mcpToken,
    ...(input.auth.mode === "api_key" ? { ANTHROPIC_API_KEY: input.auth.apiKey! } : {}),
  };
}

export function buildMcpConfig(url: string, tokenEnvVar: string): string {
  return JSON.stringify({
    mcpServers: { zentra: { type: "http", url, headers: { Authorization: `Bearer \${${tokenEnvVar}}` } } },
  });
}

export function redactClaudeCodeArgv(argv: readonly string[]): readonly string[] {
  const retained = [...argv.slice(0, -1), "<writer-task-packet>"];
  for (const [flag, placeholder] of [
    ["--model", "<approved-model>"],
    ["--mcp-config", "<writer-mcp-config>"],
    ["--append-system-prompt", "<writer-protocol>"],
  ] as const) {
    const index = retained.indexOf(flag);
    if (index !== -1 && retained[index + 1] !== undefined) retained[index + 1] = placeholder;
  }
  return retained;
}
