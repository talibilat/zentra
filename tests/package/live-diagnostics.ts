import { createHash } from "node:crypto";
import { ModelBrokerFailureReasonSchema, ModelToolNameSchema, isModelBrokerToolFailureReason } from "../../src/capsule/model-broker.js";

const MAX_FINAL_JSON_BYTES = 64 * 1024;
const LIFECYCLES = new Set(["planning", "ready", "running", "paused", "terminal"]);
const OUTCOMES = new Set(["completed", "cancelled", "denied", "timed_out", "failed"]);
const TRACE_OUTCOMES = new Set(["emitted", "failed", "not_observed", "not_configured"]);
const ERROR_CODES = new Set([
  "BUNDLED_FIXTURE_INVALID", "COMMAND_REQUIRED", "DATABASE_NOT_FOUND", "INVALID_COMMAND", "INVALID_CONFIG",
  "INVALID_CONTENT", "INVALID_FILE", "INVALID_MODEL_SHEET", "INVALID_PROVIDER_CONFIG", "INVALID_SECURITY_SHEET",
  "INVALID_TASK_ID", "INVALID_TITLE", "OPERATION_FAILED", "OUTPUT_TOO_LARGE", "TASK_NOT_FOUND",
]);
const ATTENTION_REASONS = new Set([
  "missing_authority", "undeclared_network", "forbidden_file_scope", "release_boundary", "budget_exceeded",
  "uncertain_effect", "plan_not_ready", "stale_evidence",
]);
const ATTENTION_CLASSIFICATIONS = new Set(["hard_stop", "exact_approval_required", "bounded_replan"]);

export interface LiveFailureDiagnostics {
  readonly command?: "milestone.run";
  readonly milestoneId?: string;
  readonly lifecycle?: string;
  readonly outcome?: string | null;
  readonly traceOutcome?: string;
  readonly errorCode?: string;
  readonly attentionReason?: string;
  readonly attentionClassification?: string;
  readonly brokerFailureReason?: string;
  readonly brokerFailureTool?: string;
  readonly stdoutSha256: string;
  readonly stdoutBytes: number;
  readonly stderrSha256: string;
  readonly stderrBytes: number;
}

export function liveFailureDiagnostics(stdout: Buffer, stderr: Buffer): LiveFailureDiagnostics {
  const diagnostics: Record<string, unknown> = {
    stdoutSha256: sha256(stdout),
    stdoutBytes: stdout.length,
    stderrSha256: sha256(stderr),
    stderrBytes: stderr.length,
  };
  const brokerFailure = parseBrokerFailure(stdout);
  if (brokerFailure !== null) {
    diagnostics["brokerFailureReason"] = brokerFailure.reason;
    if (brokerFailure.tool !== undefined) diagnostics["brokerFailureTool"] = brokerFailure.tool;
  }
  const parsed = parseFinalJson(stderr);
  if (parsed === null) return diagnostics as unknown as LiveFailureDiagnostics;
  if (parsed["command"] === "milestone.run") diagnostics["command"] = "milestone.run";
  const milestoneId = parsed["milestoneId"];
  if (typeof milestoneId === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(milestoneId)) {
    diagnostics["milestoneId"] = milestoneId;
  }
  retainEnum(diagnostics, "lifecycle", parsed["lifecycle"], LIFECYCLES);
  if (parsed["outcome"] === null) diagnostics["outcome"] = null;
  else retainEnum(diagnostics, "outcome", parsed["outcome"], OUTCOMES);
  const trace = record(parsed["trace"]);
  retainEnum(diagnostics, "traceOutcome", trace?.["outcome"], TRACE_OUTCOMES);
  const error = record(parsed["error"]);
  retainEnum(diagnostics, "errorCode", error?.["code"], ERROR_CODES);
  const attention = record(parsed["attention"]);
  retainEnum(diagnostics, "attentionReason", attention?.["reason"], ATTENTION_REASONS);
  retainEnum(diagnostics, "attentionClassification", attention?.["classification"], ATTENTION_CLASSIFICATIONS);
  return diagnostics as unknown as LiveFailureDiagnostics;
}

function parseBrokerFailure(stdout: Buffer): { readonly reason: string; readonly tool?: string } | null {
  if (stdout.length === 0 || stdout.length > 16 * 1024 * 1024) return null;
  let retained: { readonly reason: string; readonly tool?: string } | null = null;
  for (const line of stdout.toString("utf8").split("\n")) {
    if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_FINAL_JSON_BYTES) continue;
    try {
      const event = record(JSON.parse(line));
      const actor = record(event?.["actor"]);
      const payload = record(event?.["payload"]);
      const observation = record(payload?.["observation"]);
      if (event?.["kind"] !== "worker.observed" ||
        (actor?.["role"] !== "planner" && actor?.["role"] !== "researcher") ||
        observation?.["kind"] !== "model" || observation["phase"] !== "completed" ||
        observation["outcome"] === "completed") continue;
      const parsed = ModelBrokerFailureReasonSchema.safeParse(observation["failureReason"]);
      if (parsed.success) {
        const tool = ModelToolNameSchema.safeParse(observation["failureTool"]);
        retained = {
          reason: parsed.data,
          ...(tool.success && isModelBrokerToolFailureReason(parsed.data) ? { tool: tool.data } : {}),
        };
      }
    } catch {
      // Non-JSON and unrelated output never enters diagnostics.
    }
  }
  return retained;
}

function parseFinalJson(stderr: Buffer): Readonly<Record<string, unknown>> | null {
  if (stderr.length === 0 || stderr.length > MAX_FINAL_JSON_BYTES) return null;
  const text = stderr.toString("utf8");
  if (!text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n").filter((line) => line !== "");
  const final = lines.at(-1);
  if (final === undefined || Buffer.byteLength(final, "utf8") > MAX_FINAL_JSON_BYTES) return null;
  try {
    return record(JSON.parse(final)) ?? null;
  } catch {
    return null;
  }
}

function retainEnum(
  diagnostics: Record<string, unknown>,
  key: string,
  value: unknown,
  allowed: ReadonlySet<string>,
): void {
  if (typeof value === "string" && allowed.has(value)) diagnostics[key] = value;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
