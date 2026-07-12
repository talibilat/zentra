import { readFileSync } from "node:fs";
import {
  ProjectConfigSchema,
  type ProjectConfig,
} from "./project-config.js";

export class ProjectRegistry {
  private readonly configs: ReadonlyMap<string, ProjectConfig>;

  static fromFile(configPath: string): ProjectRegistry {
    const raw = readFileSync(configPath, "utf8");
    try {
      const parsed: unknown = JSON.parse(raw);
      const configs = Array.isArray(parsed)
        ? parsed.map((entry) => ProjectConfigSchema.parse(entry))
        : [ProjectConfigSchema.parse(parsed)];
      return new ProjectRegistry(configs);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid project config file ${configPath}: ${detail}`, {
        cause: error,
      });
    }
  }

  constructor(configs: readonly ProjectConfig[]) {
    const byId = new Map<string, ProjectConfig>();
    for (const config of configs) {
      if (byId.has(config.projectId)) {
        throw new Error(`Duplicate project id: ${config.projectId}`);
      }
      byId.set(config.projectId, config);
    }
    this.configs = byId;
  }

  get(projectId: string): ProjectConfig {
    const config = this.configs.get(projectId);
    if (config === undefined) {
      throw new Error(`Unknown project id: ${projectId}`);
    }
    return config;
  }
}
