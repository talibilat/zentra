import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { CapsuleBackedAnalysisAdapter } from "../../src/analysis/capsule-analysis-adapter.js";
import { DisabledModelBroker } from "../../src/capsule/model-broker.js";
import type { OpenCodeReadOnlyCapsule } from "../../src/agents/opencode-read-only-agent.js";
import { requestFixture } from "./test-fixtures.js";
import type { AnalysisRepositorySnapshotProvider } from "../../src/analysis/analysis-repository-snapshot.js";

describe("CapsuleBackedAnalysisAdapter", () => {
  it("uses only the existing enforced read-only capsule and capsule-measured usage", async () => {
    const execute = vi.fn<OpenCodeReadOnlyCapsule["execute"]>(async (input) => {
      expect(input.securityBoundary).toMatchObject({
        repository: "sanitized_read_only_bind_mount", scratch: "bounded_ephemeral", network: "model_broker_only",
        credentials: "none", shell: "none",
      });
      expect(input.webResearch).toBeNull();
      return result(JSON.stringify({ observations: [], uncertainties: [], usage: { inputTokens: 999_999 } }));
    });
    await expect(adapter({ execute }).analyze(requestFixture(), new AbortController().signal))
      .rejects.toThrow(/invalid|unrecognized/i);
    expect(execute).toHaveBeenCalledOnce();

    const valid = adapter({ execute: async () => result(JSON.stringify({ observations: [], uncertainties: [] })) });
    const usage = (await valid.analyze(requestFixture(), new AbortController().signal)).usage;
    expect(usage).toMatchObject({ inputTokens: 7, outputTokens: 8, costUsdNano: 9 });
    expect(usage.durationMs).toBeLessThan(1_000);
  });

  it("rejects duplicate option identities before combinations", async () => {
    const duplicate = adapter({ execute: async () => result(JSON.stringify({ observations: [], uncertainties: [
      uncertainty("u1", "same"), uncertainty("u2", "same"),
    ] })) });
    await expect(duplicate.analyze(requestFixture(), new AbortController().signal)).rejects.toThrow("option identities must be unique");
  });

  it("keeps retained sources over 64 KiB out of the prompt and passes reserved output/deadline", async () => {
    const text = "SOURCE_CANARY".repeat(7_000);
    const sha256 = createHash("sha256").update(text).digest("hex");
    const request = { ...requestFixture(), sources: [{ ...requestFixture().sources[0]!, artifactId: `intake-text-v1:${sha256}`,
      sha256, normalizedContentSha256: sha256, quotedText: text, sizeBytes: Buffer.byteLength(text) }], invocationLimits: {
      ...requestFixture().invocationLimits, timeoutMs: 1_234, maxOutputBytes: 4_321,
    } };
    const execute: OpenCodeReadOnlyCapsule["execute"] = async (input) => {
      expect(Buffer.byteLength(input.rolePrompt)).toBeLessThan(64 * 1024);
      expect(input.rolePrompt).not.toContain("SOURCE_CANARY");
      expect(input.timeoutMs).toBeGreaterThan(0);
      expect(input.timeoutMs).toBeLessThanOrEqual(1_234);
      expect(input.budget.maxOutputBytes).toBe(4_321);
      expect(input.repositoryPath).toBe("/tmp/sanitized-analysis-view");
      return result(JSON.stringify({ observations: [], uncertainties: [] }));
    };
    await adapter({ execute }).analyze(request, new AbortController().signal);
  });

  it("bounds snapshot preparation inside the reserved monotonic deadline without capsule dispatch", async () => {
    const execute = vi.fn<OpenCodeReadOnlyCapsule["execute"]>();
    const snapshots: AnalysisRepositorySnapshotProvider = {
      prepare: async (_request, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("preparation aborted");
      },
    };
    const request = { ...requestFixture(), invocationLimits: { ...requestFixture().invocationLimits, timeoutMs: 25 } };
    const started = performance.now();
    await expect(adapter({ execute }, snapshots).analyze(request, new AbortController().signal))
      .rejects.toMatchObject({ outcome: "timed_out" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports timed_out when a cooperative capsule returns cancelled after the host deadline", async () => {
    const execute: OpenCodeReadOnlyCapsule["execute"] = async (_input, _broker, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return cancelledResult();
    };
    const request = { ...requestFixture(), invocationLimits: { ...requestFixture().invocationLimits, timeoutMs: 25 } };
    const started = performance.now();
    await expect(adapter({ execute }).analyze(request, new AbortController().signal)).rejects.toMatchObject({
      outcome: "timed_out", cleanup: "completed", usage: { durationMs: expect.any(Number) },
    });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("gives an earlier caller abort precedence over the later deadline", async () => {
    const execute: OpenCodeReadOnlyCapsule["execute"] = async (_input, _broker, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return cancelledResult();
    };
    const controller = new AbortController();
    const request = { ...requestFixture(), invocationLimits: { ...requestFixture().invocationLimits, timeoutMs: 200 } };
    const pending = adapter({ execute }).analyze(request, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ outcome: "cancelled", cleanup: "completed" });
  });

  it("returns uncertain after bounded cleanup grace when a capsule ignores abort forever", async () => {
    let released = 0;
    const snapshots: AnalysisRepositorySnapshotProvider = { prepare: async (request) => ({
      view: { path: "/tmp/sanitized-analysis-view", revision: createRevision(request.projectRevision.commit), readableScopes: ["src/**"], forbiddenPaths: [] },
      sourceBundleSha256: "c".repeat(64), sourceManifestPath: ".analysis-sources/manifest.json", release: () => { released += 1; },
    }) };
    const execute: OpenCodeReadOnlyCapsule["execute"] = async () => await new Promise<never>(() => {});
    const request = { ...requestFixture(), invocationLimits: { ...requestFixture().invocationLimits, timeoutMs: 25 } };
    const started = performance.now();
    await expect(adapter({ execute }, snapshots).analyze(request, new AbortController().signal)).rejects.toMatchObject({
      outcome: "uncertain", cleanup: "uncertain",
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(released).toBe(1);
  });
});

function adapter(capsule: OpenCodeReadOnlyCapsule, snapshots = snapshotProvider()) {
  return CapsuleBackedAnalysisAdapter.composeTrusted(capsule, new DisabledModelBroker(), {
    snapshots, capabilityId: "analysis", transportModelId: "zentra/analysis", imageName: "zentra-opencode-readonly:analysis",
  });
}

function snapshotProvider(): AnalysisRepositorySnapshotProvider {
  return { prepare: async (request) => ({
    view: { path: "/tmp/sanitized-analysis-view", revision: createRevision(request.projectRevision.commit), readableScopes: ["src/**", ".analysis-sources/**"], forbiddenPaths: [".git/**", ".zentra/**"] },
    sourceBundleSha256: "c".repeat(64), sourceManifestPath: ".analysis-sources/manifest.json", release: () => {},
  }) };
}

function createRevision(commit: string): string {
  return createHash("sha256").update(commit).digest("hex");
}

function result(summary: string) {
  return {
    outcome: "completed" as const, openCode: { version: "1.18.3" as const, executableSha256: "a".repeat(64) },
    model: { id: "zentra/analysis", provider: "fixture", name: "analysis" }, evidence: [{ kind: "plan" as const, summary }],
    cleanup: "completed" as const, brokerTransport: "completed" as const,
    usage: { seconds: 10, inputTokens: 7, outputTokens: 8, costUsd: 0.000000009, costUsdNano: 9, toolCalls: 0, modelTurns: 1 },
  };
}

function cancelledResult() {
  return { outcome: "cancelled" as const, openCode: null, model: null, evidence: [], cleanup: "completed" as const,
    brokerTransport: "completed" as const,
    usage: { seconds: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costUsdNano: 0, toolCalls: 0, modelTurns: 0 } };
}

function uncertainty(uncertaintyId: string, optionId: string) {
  return { uncertaintyId, question: "Choose?", materiality: "material", affectedScopes: [], dependentScopes: [],
    options: [{ optionId, label: "Choice", impacts: ["Impact"] }], recommendation: { optionId, rationale: "Recommended." } };
}
