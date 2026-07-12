import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectConfigSchema,
  type ProjectConfig,
} from "../../src/projects/project-config.js";
import { ProjectRegistry } from "../../src/projects/project-registry.js";

const validConfig = {
  projectId: "fixture-project",
  repositoryPath: "/absolute/path/to/repository",
  integrationBranch: "zentra/integration",
  worktreeRoot: "/absolute/path/to/worktrees",
  validations: {
    focused: [process.execPath, "--test", "test/greeting.test.mjs"],
    full: [process.execPath, "--test"],
  },
};

describe("ProjectConfigSchema", () => {
  it("accepts the supported configuration", () => {
    const parsed = ProjectConfigSchema.parse(validConfig);
    expect(parsed.projectId).toBe("fixture-project");
    expect(parsed.validations.focused).toEqual([
      process.execPath,
      "--test",
      "test/greeting.test.mjs",
    ]);
  });

  it.each([
    "-danger",
    "refs/heads/main",
    "bad..branch",
    "bad//branch",
    "bad/",
    "/bad",
    "bad.lock",
    "bad/component.lock/more",
    "bad@{thing",
    "bad branch",
    "bad~branch",
    "bad^branch",
    "bad:branch",
    "bad?branch",
    "bad*branch",
    "bad[branch",
    "bad\\branch",
    "bad\nbranch",
    ".hidden/branch",
    "branch.",
    "@",
  ])("rejects unsafe integration branch %j", (integrationBranch) => {
    expect(() =>
      ProjectConfigSchema.parse({ ...validConfig, integrationBranch }),
    ).toThrow();
  });

  it("rejects a relative repository path", () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        repositoryPath: "relative/path",
      }),
    ).toThrow();
  });

  it("rejects a relative worktree root", () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        worktreeRoot: "relative/worktrees",
      }),
    ).toThrow();
  });

  it("rejects empty command arrays", () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        validations: { ...validConfig.validations, focused: [] },
      }),
    ).toThrow();
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        validations: { ...validConfig.validations, full: [] },
      }),
    ).toThrow();
  });

  it("rejects an empty executable name", () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        validations: { ...validConfig.validations, focused: ["", "--test"] },
      }),
    ).toThrow();
  });

  it("rejects sh -c validation commands", () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        validations: {
          ...validConfig.validations,
          focused: ["sh", "-c", "rm -rf /"],
        },
      }),
    ).toThrow();
  });

  it("rejects bash -c validation commands", () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        validations: {
          ...validConfig.validations,
          full: ["bash", "-c", "echo hi"],
        },
      }),
    ).toThrow();
  });

  it("rejects zsh -c validation commands using an absolute shell path", () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        validations: {
          ...validConfig.validations,
          focused: ["/bin/zsh", "-c", "echo hi"],
        },
      }),
    ).toThrow();
  });

  it("rejects sh -lc validation commands (combined short flags)", () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        validations: {
          ...validConfig.validations,
          focused: ["sh", "-lc", "rm -rf /"],
        },
      }),
    ).toThrow();
  });

  it("rejects env sh -c validation commands", () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        validations: {
          ...validConfig.validations,
          focused: ["env", "sh", "-c", "echo hi"],
        },
      }),
    ).toThrow();
  });

  it("rejects /usr/bin/env bash -c validation commands with VAR=value args", () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        validations: {
          ...validConfig.validations,
          full: ["/usr/bin/env", "CI=1", "bash", "-c", "echo hi"],
        },
      }),
    ).toThrow();
  });

  it("rejects the extended shell set (fish, pwsh, powershell, ksh)", () => {
    for (const shell of ["fish", "pwsh", "powershell", "ksh", "csh", "tcsh", "dash"]) {
      expect(() =>
        ProjectConfigSchema.parse({
          ...validConfig,
          validations: {
            ...validConfig.validations,
            focused: [shell, "-c", "echo hi"],
          },
        }),
      ).toThrow();
    }
  });

  it.each([
    ["absolute executable outside the allowlist", "/bin/echo"],
    ["relative executable", "node"],
    ["env-prefixed executable", "/usr/bin/env"],
  ])("rejects an %s", (_case, executable) => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        validations: {
          ...validConfig.validations,
          focused: [executable, process.execPath, "--test"],
        },
      }),
    ).toThrow(/approved canonical absolute path/);
  });

  it("rejects a symlink to the approved executable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zentra-executable-"));
    const executable = path.join(dir, "node-link");
    symlinkSync(process.execPath, executable);

    try {
      expect(() =>
        ProjectConfigSchema.parse({
          ...validConfig,
          validations: {
            ...validConfig.validations,
            focused: [executable, "--test"],
          },
        }),
      ).toThrow(/approved canonical absolute path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ProjectRegistry", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads one JSON config file and resolves a project by id", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zentra-registry-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "project.json");
    writeFileSync(configPath, JSON.stringify(validConfig), "utf8");

    const registry = ProjectRegistry.fromFile(configPath);
    const project = registry.get("fixture-project");
    expect(project.repositoryPath).toBe("/absolute/path/to/repository");
  });

  it("rejects an invalid config file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zentra-registry-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "project.json");
    writeFileSync(
      configPath,
      JSON.stringify({ ...validConfig, repositoryPath: "relative" }),
      "utf8",
    );

    expect(() => ProjectRegistry.fromFile(configPath)).toThrow();
  });

  it("includes the config file path in parse and validation errors", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zentra-registry-"));
    tempDirs.push(dir);

    const invalidJsonPath = path.join(dir, "broken.json");
    writeFileSync(invalidJsonPath, "{ not json", "utf8");
    expect(() => ProjectRegistry.fromFile(invalidJsonPath)).toThrow(
      new RegExp(invalidJsonPath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    const invalidConfigPath = path.join(dir, "invalid.json");
    writeFileSync(
      invalidConfigPath,
      JSON.stringify({ ...validConfig, repositoryPath: "relative" }),
      "utf8",
    );
    expect(() => ProjectRegistry.fromFile(invalidConfigPath)).toThrow(
      new RegExp(invalidConfigPath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("throws for an unknown project id", () => {
    const registry = new ProjectRegistry([validConfig as ProjectConfig]);
    expect(() => registry.get("missing-project")).toThrow(/missing-project/);
  });
});
