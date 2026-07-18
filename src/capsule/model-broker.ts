import { z } from "zod";
import { CostUsdNanoSchema, costFieldsAgree } from "../contracts/cost.js";

const ModelIdentitySchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
export const ModelToolCallIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const ModelToolNameSchema = z.enum(["read", "glob", "grep", "zentra_research_web_research"]);
export const ModelBrokerToolFailureReasonSchema = z.enum([
  "unsupported_tool_call",
  "tool_call_incomplete",
  "tool_call_id_invalid",
  "tool_call_name_invalid",
  "tool_call_arguments_json_invalid",
  "tool_call_arguments_schema_invalid",
  "tool_call_duplicate_id",
  "tool_call_index_invalid",
  "tool_call_count_exceeded",
  "tool_call_content_conflict",
]);
export const ModelBrokerFailureReasonSchema = z.enum([
  "broker_disabled",
  "request_cancelled",
  "request_model_mismatch",
  "input_budget_exceeded",
  "output_budget_exceeded",
  "tool_budget_exceeded",
  "dns_resolution_failed",
  "dns_private_target",
  "tls_failed",
  "transport_failed_before_dispatch",
  "transport_uncertain_after_dispatch",
  "request_timed_out_before_dispatch",
  "provider_status_rejected",
  "provider_status_uncertain",
  "response_utf8_invalid",
  "response_json_invalid",
  "response_sse_invalid",
  "response_schema_invalid",
  "response_incomplete",
  "provider_model_mismatch",
  "usage_invalid",
  "token_budget_exceeded",
  "cost_budget_exceeded",
  "model_turn_budget_exceeded",
  "unsupported_tool_call",
  "tool_call_incomplete",
  "tool_call_id_invalid",
  "tool_call_name_invalid",
  "tool_call_arguments_json_invalid",
  "tool_call_arguments_schema_invalid",
  "tool_call_duplicate_id",
  "tool_call_index_invalid",
  "tool_call_count_exceeded",
  "tool_call_content_conflict",
  "content_filtered",
  "completion_length_exceeded",
  "broker_receipt_invalid",
]);

export const ModelBrokerRequestSchema = z.strictObject({
  modelId: ModelIdentitySchema,
  prompt: z.string().min(1).max(256 * 1024),
  maxInputTokens: z.number().int().positive().max(2_000_000),
  maxOutputTokens: z.number().int().positive().max(2_000_000),
  maxCostUsd: z.number().nonnegative().max(10_000),
  allowedTools: z.array(ModelToolNameSchema).max(4).superRefine((tools, context) => {
    if (new Set(tools).size !== tools.length) context.addIssue({ code: "custom", message: "allowed model tools must be unique" });
  }).optional(),
});

const AssistantResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(4 * 1024 * 1024) }),
  z.strictObject({
    type: z.literal("tool_calls"),
    calls: z.array(z.strictObject({
      id: ModelToolCallIdSchema,
      name: ModelToolNameSchema,
      arguments: z.string().min(2).max(64 * 1024),
    })).min(1).max(16),
  }),
]);

export const ModelBrokerReceiptSchema = z.strictObject({
  outcome: z.enum(["completed", "cancelled", "timed_out", "failed", "uncertain"]),
  failureReason: ModelBrokerFailureReasonSchema.nullable().optional(),
  failureTool: ModelToolNameSchema.optional(),
  response: AssistantResponseSchema.nullable(),
  model: z.strictObject({
    id: ModelIdentitySchema,
    provider: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    name: z.string().min(1).max(256),
    configurationDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).nullable(),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    costUsdNano: CostUsdNanoSchema.optional(),
  }).superRefine((usage, context) => {
    if (usage.costUsdNano !== undefined && !costFieldsAgree(usage.costUsd, usage.costUsdNano)) {
      context.addIssue({ code: "custom", message: "model usage cost fields disagree" });
    }
  }).nullable(),
}).superRefine((receipt, context) => {
  if (receipt.outcome === "completed" && (receipt.response === null || receipt.model === null || receipt.usage === null)) {
    context.addIssue({ code: "custom", message: "completed model receipt requires response, model, and usage" });
  }
  if (receipt.outcome !== "completed" && receipt.response !== null) {
    context.addIssue({ code: "custom", message: "non-completed model receipt cannot contain a response" });
  }
  if (receipt.outcome === "completed" && receipt.failureReason != null) {
    context.addIssue({ code: "custom", message: "completed model receipt cannot contain a failure reason" });
  }
  if (receipt.outcome !== "completed" && receipt.failureReason == null) {
    context.addIssue({ code: "custom", message: "non-completed model receipt requires a failure reason" });
  }
  if (receipt.failureTool !== undefined && (receipt.outcome === "completed" ||
    !ModelBrokerToolFailureReasonSchema.safeParse(receipt.failureReason).success)) {
    context.addIssue({ code: "custom", message: "model failure tool requires a non-completed tool-call failure" });
  }
});

export type ModelBrokerRequest = z.infer<typeof ModelBrokerRequestSchema>;
export type ModelBrokerReceipt = z.infer<typeof ModelBrokerReceiptSchema>;
export type ModelBrokerFailureReason = z.infer<typeof ModelBrokerFailureReasonSchema>;
export type ModelToolName = z.infer<typeof ModelToolNameSchema>;

export function isModelBrokerToolFailureReason(value: unknown): value is z.infer<typeof ModelBrokerToolFailureReasonSchema> {
  return ModelBrokerToolFailureReasonSchema.safeParse(value).success;
}

export interface ModelBroker {
  /**
   * Trusted capability-runner contract.
   * Implementations must settle promptly after signal abort and must not retain provider work beyond that acknowledgement.
   */
  execute(request: ModelBrokerRequest, signal: AbortSignal): Promise<ModelBrokerReceipt>;
}

export class DisabledModelBroker implements ModelBroker {
  execute(_request: ModelBrokerRequest, _signal: AbortSignal): Promise<ModelBrokerReceipt> {
    return Promise.resolve({ outcome: "failed", failureReason: "broker_disabled", response: null, model: null, usage: null });
  }
}
