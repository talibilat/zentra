import { readFileSync, statSync } from "node:fs";

import type { ModelBroker } from "../capsule/model-broker.js";
import {
  AzureOpenAIModelBroker,
  AzureOpenAIProviderConfigSchema,
  type AzureOpenAIProviderConfig,
} from "./azure-openai-model-broker.js";

const MAX_PROVIDER_CONFIG_BYTES = 16 * 1024;

export const InstalledProviderConfigSchema = AzureOpenAIProviderConfigSchema;

export type InstalledProviderConfig = Readonly<AzureOpenAIProviderConfig>;

export function loadInstalledProviderConfig(configPath: string): InstalledProviderConfig {
  const stat = statSync(configPath);
  if (!stat.isFile() || stat.size > MAX_PROVIDER_CONFIG_BYTES) throw new Error("provider configuration is invalid");
  return Object.freeze(InstalledProviderConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8"))));
}

export function createInstalledModelBroker(
  config: InstalledProviderConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ModelBroker {
  return AzureOpenAIModelBroker.create(config, environment);
}
