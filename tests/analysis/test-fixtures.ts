import { createHash } from "node:crypto";
import type { AnalysisAdapterRequest } from "../../src/analysis/analysis-contracts.js";

export function requestFixture(): AnalysisAdapterRequest {
  const text = "ticket";
  const sha256 = createHash("sha256").update(text).digest("hex");
  return {
    runId: "run-92", round: 1, projectRevision: { objectFormat: "sha1", commit: "1".repeat(40) },
    sources: [{ sourceId: `source-v1:${"a".repeat(64)}`, relativePath: "ticket.md", artifactId: `intake-text-v1:${sha256}`,
      sha256, normalizedContentSha256: sha256, quotedText: text, sizeBytes: Buffer.byteLength(text),
      trust: "untrusted_planning_data", provenanceSha256: "b".repeat(64) }],
    sourceByteBudget: 1024 * 1024,
    priorObservations: [], answers: [],
    budget: { maxRounds: 2, maxObservations: 8, maxQuestions: 8, maxOptionsPerQuestion: 4, maxQuestionnaireOptions: 16,
      maxOutputBytes: 65_536, maxDurationMs: 2_000, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsdNano: 10 },
    invocationLimits: { timeoutMs: 2_000, maxOutputBytes: 65_536, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsdNano: 10 },
    securityBoundary: { authority: "none", effects: "none", tools: [], secrets: [], environment: {}, sourceInstructions: "untrusted_data_only", retainHiddenReasoning: false },
  };
}
