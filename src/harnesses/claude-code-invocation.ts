import { EXPECTED_SERVER_NAME, PROPOSE_PATCH_TOOL } from "./claude-code-stream.js";

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
/**
 * Tools permitted at the permission layer. propose_patch must be here: under
 * --permission-mode default a headless run auto-denies anything absent, and
 * without it the writer's only sanctioned way to express a change cannot be
 * used at all (D33). Imported rather than restated so it cannot drift from
 * the name the surface check expects.
 */
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", PROPOSE_PATCH_TOOL] as const;

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

/**
 * Resolves how the Claude Code writer authenticates, from Zentra's own process
 * environment (never the spawned harness's environment). OAuth is the default
 * (D30): api_key mode additionally selects --bare, which is structurally
 * stronger isolation but mutually exclusive with a live OAuth session, so it
 * is only chosen when Zentra itself has a non-empty ANTHROPIC_API_KEY.
 */
export function resolveClaudeCodeAuth(): ClaudeCodeAuth {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return apiKey === undefined || apiKey.trim() === "" ? { mode: "oauth" } : { mode: "api_key", apiKey };
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
    ...(input.auth.mode === "api_key" ? { ANTHROPIC_API_KEY: input.auth.apiKey! } : { USER: requireOAuthUser() }),
  };
}

/**
 * OAuth mode does not set --bare, so the real binary reads its OAuth token
 * from the macOS keychain rather than ANTHROPIC_API_KEY. Measured empirically
 * (issue #131 follow-up): that keychain lookup is keyed by USER specifically,
 * not LOGNAME. ProcessSupervisor's own ENV_ALLOWLIST deliberately does not
 * include USER, because that allow-list is shared by every supervised
 * process - OpenCode writers, validations, reviewers, all running in
 * read-only capsules (D24) - and widening it for one harness's benefit is
 * exactly what D24 forbids. USER is added here instead, in this writer's own
 * explicit environment map, scoped to oauth mode only. api_key mode sets
 * --bare and never reads the keychain, so USER must stay out of that
 * environment to keep it as tight as it already is.
 *
 * Reads from Zentra's own process environment, never the spawned harness's
 * (same rule as resolveClaudeCodeAuth's ANTHROPIC_API_KEY read above).
 */
function requireOAuthUser(): string {
  const user = process.env.USER;
  if (user === undefined || user === "") {
    throw new Error(
      "Claude Code writer oauth mode requires USER in Zentra's own environment for macOS keychain lookup; "
      + "set USER, or switch to api_key mode by setting ANTHROPIC_API_KEY",
    );
  }
  return user;
}

export function buildMcpConfig(url: string, tokenEnvVar: string): string {
  return JSON.stringify({
    mcpServers: { [EXPECTED_SERVER_NAME]: { type: "http", url, headers: { Authorization: `Bearer \${${tokenEnvVar}}` } } },
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
