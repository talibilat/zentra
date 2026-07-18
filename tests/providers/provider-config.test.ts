import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInstalledModelBroker,
  loadInstalledProviderConfig,
} from "../../src/providers/provider-config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("installed provider configuration", () => {
  it("loads Azure as the installed provider and resolves its credential only in the host broker", async () => {
    const config = {
      provider: "azure", endpoint: "https://zentra-test.openai.azure.com", deployment: "deployment",
      apiVersion: "2025-04-01-preview", credentialEnv: "AZURE_KEY", timeoutMs: 5_000,
      maxResponseBytes: 1_048_576, maxInputTokens: 100_000, maxOutputTokens: 10_000, maxToolCalls: 4,
      expectedProviderModels: ["provider-model"],
      inputTokenRateUsdPerMillion: "1", outputTokenRateUsdPerMillion: "2",
    };
    const loaded = writeAndLoad(config);
    expect(loaded).toEqual(config);
    const controller = new AbortController();
    controller.abort();
    await expect(createInstalledModelBroker(loaded, { AZURE_KEY: "host-secret" }).execute({
      modelId: "deployment", prompt: "x", maxInputTokens: 1, maxOutputTokens: 1, maxCostUsd: 1,
    }, controller.signal)).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("rejects a non-Azure provider before broker construction", () => {
    expect(() => writeAndLoad({ provider: "unsupported", credentialEnv: "LEGACY_KEY", timeoutMs: 5_000 })).toThrow();
  });
});

function writeAndLoad(value: unknown) {
  const root = mkdtempSync(path.join(tmpdir(), "zentra-provider-config-"));
  roots.push(root);
  const file = path.join(root, "provider.json");
  writeFileSync(file, JSON.stringify(value), "utf8");
  return loadInstalledProviderConfig(file);
}
