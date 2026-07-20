import { z } from "zod";

import { DecisionActorSchema } from "../attention/attention-contracts.js";

export const ANALYSIS_SCHEMA_VERSION = 1;

const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TextSchema = z.string().min(1).max(4_096);
const SafePathSchema = z.string().min(1).max(1_024).refine((value) =>
  !value.includes("\\") && !value.startsWith("/") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
const CanonicalIdsSchema = z.array(IdSchema).max(256).superRefine(canonicalArray);
const CanonicalPathsSchema = z.array(SafePathSchema).max(256).superRefine(canonicalArray);

export const AnalysisBudgetSchema = z.strictObject({
  maxRounds: z.number().int().positive().max(32),
  maxObservations: z.number().int().positive().max(1_024),
  maxQuestions: z.number().int().positive().max(64),
  maxOptionsPerQuestion: z.number().int().positive().max(16),
  maxQuestionnaireOptions: z.number().int().positive().max(64),
  maxOutputBytes: z.number().int().positive().max(16 * 1024 * 1024),
  maxDurationMs: z.number().int().positive().max(86_400_000),
  maxInputTokens: z.number().int().positive().max(2_000_000),
  maxOutputTokens: z.number().int().positive().max(2_000_000),
  maxCostUsdNano: z.number().int().nonnegative().max(10_000_000_000_000),
});

export const RetainedAnalysisSourceSchema = z.strictObject({
  sourceId: z.string().regex(/^source-v1:[a-f0-9]{64}$/),
  relativePath: SafePathSchema,
  artifactId: z.string().regex(/^intake-text-v1:[a-f0-9]{64}$/),
  sha256: DigestSchema,
  normalizedContentSha256: DigestSchema,
  quotedText: z.string().max(1024 * 1024 * 1024),
  sizeBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
  trust: z.literal("untrusted_planning_data"),
  provenanceSha256: DigestSchema,
}).superRefine((source, context) => {
  if (source.artifactId !== `intake-text-v1:${source.sha256}`) {
    context.addIssue({ code: "custom", message: "retained source artifact does not match its digest" });
  }
});

export const AnalysisObservationSchema = z.strictObject({
  observationId: IdSchema,
  summary: TextSchema,
  sourceIds: CanonicalIdsSchema,
  repositoryPaths: CanonicalPathsSchema,
  affectedScopes: CanonicalIdsSchema,
});

export const AnalysisUncertaintySchema = z.strictObject({
  uncertaintyId: IdSchema,
  question: TextSchema,
  materiality: z.enum(["material", "advisory"]),
  affectedScopes: CanonicalIdsSchema,
  dependentScopes: CanonicalIdsSchema,
  options: z.array(z.strictObject({
    optionId: IdSchema,
    label: TextSchema,
    impacts: z.array(TextSchema).min(1).max(64),
  })).min(1).max(16),
  recommendation: z.strictObject({ optionId: IdSchema, rationale: TextSchema }),
}).superRefine((uncertainty, context) => {
  const optionIds = uncertainty.options.map((option) => option.optionId);
  if (new Set(optionIds).size !== optionIds.length) {
    context.addIssue({ code: "custom", message: "uncertainty option identities must be unique" });
  }
  if (!optionIds.includes(uncertainty.recommendation.optionId)) {
    context.addIssue({ code: "custom", message: "uncertainty recommendation must reference an option" });
  }
});

export const AnalysisUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().max(2_000_000),
  outputTokens: z.number().int().nonnegative().max(2_000_000),
  inputBytes: z.number().int().nonnegative().max(64 * 1024 * 1024),
  outputBytes: z.number().int().nonnegative().max(16 * 1024 * 1024),
  durationMs: z.number().int().nonnegative().max(86_400_000),
  costUsdNano: z.number().int().nonnegative().max(10_000_000_000_000),
  modelReceiptSha256: DigestSchema,
});

export const AnalysisRoundResultSchema = z.strictObject({
  observations: z.array(AnalysisObservationSchema).max(1_024),
  uncertainties: z.array(AnalysisUncertaintySchema).max(64),
}).superRefine((result, context) => {
  for (const [label, ids] of [
    ["observation", result.observations.map((item) => item.observationId)],
    ["uncertainty", result.uncertainties.map((item) => item.uncertaintyId)],
  ] as const) {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: `${label} identities must be unique` });
  }
  const optionIds = result.uncertainties.flatMap((item) => item.options.map((option) => option.optionId));
  if (new Set(optionIds).size !== optionIds.length) {
    context.addIssue({ code: "custom", message: "option identities must be unique across the questionnaire" });
  }
});

export const AnalysisAnswerSchema = z.strictObject({
  decisionId: IdSchema,
  decisionEventId: IdSchema,
  optionId: IdSchema,
  actor: DecisionActorSchema,
  evidenceSha256: DigestSchema,
  packetSha256: DigestSchema,
  selections: z.array(z.strictObject({ uncertaintyId: IdSchema, optionId: IdSchema })).min(1).max(64),
  semantics: z.array(z.strictObject({
    uncertaintyId: IdSchema,
    question: TextSchema,
    materiality: z.enum(["material", "advisory"]),
    affectedScopes: CanonicalIdsSchema,
    dependentScopes: CanonicalIdsSchema,
    options: z.array(z.strictObject({ optionId: IdSchema, label: TextSchema, impacts: z.array(TextSchema).min(1).max(64) })).min(1).max(16),
    recommendation: z.strictObject({ optionId: IdSchema, rationale: TextSchema }),
    selectedOption: z.strictObject({ optionId: IdSchema, label: TextSchema, impacts: z.array(TextSchema).min(1).max(64) }),
  })).min(1).max(64),
  semanticSha256: DigestSchema,
});

export const AnalysisStartedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  snapshotSha256: DigestSchema,
  sourceEvidenceSha256: DigestSchema,
  budget: AnalysisBudgetSchema,
  sourceCount: z.number().int().positive().max(10_000),
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AnalysisObservedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  round: z.number().int().positive().max(32),
  observations: z.array(AnalysisObservationSchema).max(1_024),
  uncertainties: z.array(AnalysisUncertaintySchema).max(64),
  usage: AnalysisUsageSchema,
  sourceEvidenceSha256: DigestSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
  reservationEventId: IdSchema,
});

export const AnalysisInvocationReservedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  round: z.number().int().positive().max(32),
  requestSha256: DigestSchema,
  sourceEvidenceSha256: DigestSchema,
  budget: AnalysisBudgetSchema,
  reservationId: IdSchema,
  budgetReservationEventId: IdSchema,
  runStreamVersion: z.number().int().positive(),
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AnalysisBudgetReservedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  reservationId: IdSchema,
  round: z.number().int().positive().max(32),
  limits: z.strictObject({
    maxDurationMs: z.number().int().positive().max(86_400_000),
    maxOutputBytes: z.number().int().positive().max(16 * 1024 * 1024),
    maxInputTokens: z.number().int().positive().max(2_000_000),
    maxOutputTokens: z.number().int().positive().max(2_000_000),
    maxCostUsdNano: z.number().int().nonnegative().max(10_000_000_000_000),
  }),
  analysisStreamVersion: z.number().int().positive(),
  analysisReservationEventId: IdSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AnalysisBudgetChargedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  reservationId: IdSchema,
  reservationEventId: IdSchema,
  analysisEventId: IdSchema,
  usage: AnalysisUsageSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AnalysisRevisedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  round: z.number().int().positive().max(32),
  answer: AnalysisAnswerSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AnalysisCompletedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  rounds: z.number().int().positive().max(32),
  observationCount: z.number().int().nonnegative().max(1_024),
  evidenceSha256: DigestSchema,
  sourceEvidenceSha256: DigestSchema,
  finalObservationEventId: IdSchema,
  totalUsage: AnalysisUsageSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AnalysisBudgetExhaustedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  round: z.number().int().nonnegative().max(32),
  reason: z.enum(["rounds", "observations", "questions", "options", "output", "duration", "input_tokens", "output_tokens", "cost"]),
  affectedScopes: CanonicalIdsSchema,
  dependentScopes: CanonicalIdsSchema,
  evidenceSha256: DigestSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AnalysisBudgetRevisedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  priorBudget: AnalysisBudgetSchema,
  budget: AnalysisBudgetSchema,
  exhaustionEventId: IdSchema,
  decisionEventId: IdSchema,
  actor: DecisionActorSchema,
  evidenceSha256: DigestSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AnalysisCancelledPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  reason: z.enum(["run_cancelled", "decision_rejected", "decision_expired", "budget_cancelled", "aborted", "analyzer_failed"]),
  cancellationEventId: IdSchema.nullable(),
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AnalysisTerminalPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  outcome: z.enum(["timed_out", "failed"]),
  runTerminalEventId: IdSchema,
  reservationEventId: IdSchema,
  usage: AnalysisUsageSchema,
  evidenceSha256: DigestSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AnalysisReconciliationRequiredPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  reservationEventId: IdSchema,
  reason: z.enum(["capsule_uncertain", "cleanup_uncertain"]),
  capsuleOutcome: z.enum(["cancelled", "timed_out", "failed", "uncertain"]),
  cleanup: z.enum(["completed", "uncertain"]),
  effectState: z.enum(["known_no_effect", "uncertain"]),
  usage: AnalysisUsageSchema,
  evidenceSha256: DigestSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export const AnalysisReconciliationResolvedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  runId: IdSchema,
  reservationEventId: IdSchema,
  reconciliationEventId: IdSchema,
  resolution: z.enum(["released_known_no_effect"]),
  actor: DecisionActorSchema,
  evidenceSha256: DigestSchema,
  commandId: IdSchema,
  authority: z.literal("none"),
});

export type AnalysisBudget = z.infer<typeof AnalysisBudgetSchema>;
export type RetainedAnalysisSource = z.infer<typeof RetainedAnalysisSourceSchema>;
export type AnalysisObservation = z.infer<typeof AnalysisObservationSchema>;
export type AnalysisUncertainty = z.infer<typeof AnalysisUncertaintySchema>;
export type AnalysisRoundResult = z.infer<typeof AnalysisRoundResultSchema>;
export type AnalysisUsage = z.infer<typeof AnalysisUsageSchema>;
export type AnalysisAnswer = z.infer<typeof AnalysisAnswerSchema>;

export interface AnalysisAdapterRequest {
  readonly runId: string;
  readonly round: number;
  readonly projectRevision: { readonly objectFormat: "sha1" | "sha256"; readonly commit: string };
  readonly sourceByteBudget: number;
  readonly sources: readonly RetainedAnalysisSource[];
  readonly priorObservations: readonly AnalysisObservation[];
  readonly answers: readonly AnalysisAnswer[];
  readonly budget: AnalysisBudget;
  readonly invocationLimits: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly maxCostUsdNano: number;
  };
  readonly securityBoundary: {
    readonly authority: "none";
    readonly effects: "none";
    readonly tools: readonly [];
    readonly secrets: readonly [];
    readonly environment: Readonly<Record<string, never>>;
    readonly sourceInstructions: "untrusted_data_only";
    readonly retainHiddenReasoning: false;
  };
}

export function analysisStreamId(runId: string): string {
  return `analysis:${IdSchema.parse(runId)}`;
}

export function analysisBudgetStreamId(runId: string): string {
  return `analysis-budget:${IdSchema.parse(runId)}`;
}

function canonicalArray(values: readonly string[], context: z.RefinementCtx): void {
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    context.addIssue({ code: "custom", message: "values must be unique and canonically sorted" });
  }
}
