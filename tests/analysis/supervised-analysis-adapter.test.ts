import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AnalysisExecutionError, SupervisedAnalysisAdapter } from "../../src/analysis/supervised-analysis-adapter.js";
import type { AnalysisAdapterRequest } from "../../src/analysis/analysis-contracts.js";

const root = realpathSync.native(path.resolve(import.meta.dirname, "../.."));
const program = realpathSync.native(path.join(root, "fixtures/deterministic-analyzer.mjs"));
const executable = realpathSync.native(process.execPath);
const sha = (filename: string): string => createHash("sha256").update(readFileSync(filename)).digest("hex");
const priorSecret = process.env.ANALYSIS_SECRET_CANARY;

afterEach(() => {
  if (priorSecret === undefined) delete process.env.ANALYSIS_SECRET_CANARY;
  else process.env.ANALYSIS_SECRET_CANARY = priorSecret;
});

function adapter(overrides: Partial<ConstructorParameters<typeof SupervisedAnalysisAdapter>[0]> = {}) {
  return new SupervisedAnalysisAdapter({
    executable,
    executableSha256: sha(executable),
    program,
    programSha256: sha(program),
    cwd: realpathSync.native("/tmp"),
    timeoutMs: 2_000,
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 64 * 1024,
    ...overrides,
  });
}

function request(text = "ticket"): AnalysisAdapterRequest {
  return {
    runId: "run-92",
    round: 1,
    sources: [{
      sourceId: `source-v1:${"a".repeat(64)}`,
      relativePath: "ticket.md",
      artifactId: `intake-text-v1:${createHash("sha256").update(text).digest("hex")}`,
      sha256: createHash("sha256").update(text).digest("hex"),
      normalizedContentSha256: createHash("sha256").update(text).digest("hex"),
      quotedText: text,
      trust: "untrusted_planning_data",
      provenanceSha256: "b".repeat(64),
    }],
    priorObservations: [],
    answers: [],
    budget: {
      maxRounds: 2, maxObservations: 8, maxQuestions: 8, maxOptionsPerQuestion: 4,
      maxQuestionnaireOptions: 16, maxOutputBytes: 64 * 1024, maxDurationMs: 2_000,
      maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsdNano: 0,
    },
    invocationLimits: { timeoutMs: 2_000, maxOutputBytes: 64 * 1024 },
    securityBoundary: {
      authority: "none", effects: "none", tools: [], secrets: [], environment: {},
      sourceInstructions: "untrusted_data_only", retainHiddenReasoning: false,
    },
  };
}

describe("SupervisedAnalysisAdapter", () => {
  it("runs the exact configured analyzer with bounded stdin and no inherited secret or effect capability", async () => {
    process.env.ANALYSIS_SECRET_CANARY = "must-not-leak";
    const result = await adapter().analyze(request(), new AbortController().signal);
    expect(result.observations).toHaveLength(1);
    expect(result.usage).toMatchObject({ durationMs: expect.any(Number), outputBytes: expect.any(Number) });
  });

  it("rejects substituted executable identity before spawn", () => {
    expect(() => adapter({ executableSha256: "0".repeat(64) })).toThrow("exact configured identity");
  });

  it("bounds output and terminates an aborted analyzer", async () => {
    await expect(adapter({ maxOutputBytes: 128 }).analyze(request("__OVERSIZE__"), new AbortController().signal))
      .rejects.toMatchObject({ outcome: "failed" });
    const controller = new AbortController();
    const pending = adapter().analyze(request("__WAIT__"), controller.signal);
    setTimeout(() => controller.abort(), 25);
    await expect(pending).rejects.toEqual(expect.objectContaining<Partial<AnalysisExecutionError>>({ outcome: "cancelled" }));
  });
});
