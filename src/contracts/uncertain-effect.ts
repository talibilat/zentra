import { z } from "zod";

import { StopAndAskStateSchema } from "./milestone.js";

export const UncertainEffectBoundarySchema = z.enum([
  "worktree_creation",
  "worker",
  "validation",
  "review",
  "commit",
  "integration",
  "cleanup",
]);

export const UncertainEffectPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  boundary: UncertainEffectBoundarySchema,
  operation: z.string().min(1).max(256),
  reason: z.string().min(1).max(4_096),
  retryPolicy: z.literal("never_automatic"),
  recoveryClassification: z.literal("await_reconciliation"),
  stopAndAsk: StopAndAskStateSchema.extend({ reason: z.literal("uncertain_effect") }),
  workspace: z.strictObject({
    path: z.string().min(1).max(4_096),
    branch: z.string().min(1).max(1_024).nullable(),
    preservation: z.literal("required"),
  }).nullable(),
  evidence: z.record(z.string().min(1).max(128), z.string().max(4_096))
    .refine((value) => Object.keys(value).length <= 32)
    .default({}),
});

export type UncertainEffectBoundary = z.infer<typeof UncertainEffectBoundarySchema>;
export type UncertainEffectPayload = z.infer<typeof UncertainEffectPayloadSchema>;

export const EffectReconciliationPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  boundary: UncertainEffectBoundarySchema,
  resolution: z.enum(["effect_applied", "effect_absent", "abandoned"]),
  reason: z.string().min(1).max(4_096),
  decidedBy: z.string().min(1).max(256),
  decisionId: z.string().min(1).max(256),
});

export type EffectReconciliationPayload = z.infer<typeof EffectReconciliationPayloadSchema>;

export function uncertainEffectPayload(input: {
  readonly boundary: UncertainEffectBoundary;
  readonly operation: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly workspace: { readonly path: string; readonly branch: string | null } | null;
  readonly evidence?: Readonly<Record<string, string>>;
}): UncertainEffectPayload {
  return UncertainEffectPayloadSchema.parse({
    schemaVersion: 1,
    boundary: input.boundary,
    operation: input.operation,
    reason: input.reason,
    retryPolicy: "never_automatic",
    recoveryClassification: "await_reconciliation",
    stopAndAsk: {
      reason: "uncertain_effect",
      message: input.reason,
      requestedBy: input.requestedBy,
      requiredDecision:
        "Inspect retained evidence and explicitly reconcile, abandon, or authorize a new attempt.",
    },
    workspace: input.workspace === null
      ? null
      : { ...input.workspace, preservation: "required" },
    evidence: input.evidence ?? {},
  });
}
