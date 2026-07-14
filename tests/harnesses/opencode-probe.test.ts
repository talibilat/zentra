import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseModelSheetMarkdown } from "../../src/policy/model-sheet.js";
import { parseSecuritySheetMarkdown } from "../../src/policy/security-sheet.js";
import { OpenCodeProbe } from "../../src/harnesses/opencode-probe.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.ZENTRA_SHOULD_NOT_LEAK;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return realpathSync.native(directory);
}

function fakeOpenCodeExecutable(source: string): string {
  const directory = fixtureDirectory("zentra-opencode-probe-bin-");
  const executable = path.join(directory, "fake-opencode.mjs");
  writeFileSync(executable, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  return realpathSync.native(executable);
}

function modelSheet(harness = "opencode"): ReturnType<typeof parseModelSheetMarkdown> {
  return parseModelSheetMarkdown(`# Zentra Model Sheet

## Models
| id | harness | model | roles | specialties | cost | context | concurrency | tools | network | fallback | quality |
| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
| opencode-general | ${harness} | provider/opencode-model | planner,researcher,implementer,reviewer | coding,review | low | 128000 | 2 | read_repository,write_worktree,review_diff | denied | none | 3/4 |
`);
}

function securitySheet(repositoryPath: string): ReturnType<typeof parseSecuritySheetMarkdown> {
  return parseSecuritySheetMarkdown(`# Zentra Security Sheet

## Allowed Repositories
- ${repositoryPath}

## Allowed File Scopes
- src/**

## Forbidden Paths
- .env

## Network
Default: denied

## Secret Handling
- Do not inherit parent secrets.

## Approval Required Operations
- external_effect

## Release Boundary
local_preparation_only

## Stop And Ask Conditions
- missing_authority
- undeclared_network
`);
}

describe("OpenCodeProbe", () => {
  it("probes an approved OpenCode model with a bounded subprocess and records metadata", async () => {
    const repository = fixtureDirectory("zentra-opencode-repo-");
    const executable = fakeOpenCodeExecutable([
      "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--version'])) process.exit(7);",
      "process.stdout.write('OpenCode 1.2.3\\n');",
    ].join("\n"));
    const probe = new OpenCodeProbe(new ProcessSupervisor());

    const report = await probe.probe({
      executable,
      cwd: repository,
      timeoutMs: 5_000,
      modelId: "opencode-general",
      models: modelSheet(),
      security: securitySheet(repository),
    }, AbortSignal.timeout(10_000));

    expect(report).toMatchObject({
      outcome: "completed",
      modelId: "opencode-general",
      harness: "opencode",
      model: "provider/opencode-model",
      provider: "provider",
      version: "OpenCode 1.2.3",
    });
    expect(report.argv).toEqual(["--version"]);
  });

  it("uses the supervisor minimal environment", async () => {
    process.env.ZENTRA_SHOULD_NOT_LEAK = "secret";
    const repository = fixtureDirectory("zentra-opencode-repo-");
    const executable = fakeOpenCodeExecutable([
      "if (process.env.ZENTRA_SHOULD_NOT_LEAK) process.exit(9);",
      "process.stdout.write('OpenCode 1.2.3\\n');",
    ].join("\n"));
    const probe = new OpenCodeProbe(new ProcessSupervisor());

    const report = await probe.probe({
      executable,
      cwd: repository,
      timeoutMs: 5_000,
      modelId: "opencode-general",
      models: modelSheet(),
      security: securitySheet(repository),
    }, AbortSignal.timeout(10_000));

    expect(report.outcome).toBe("completed");
  });

  it("fails closed without spawning when the model is not approved for OpenCode", async () => {
    const repository = fixtureDirectory("zentra-opencode-repo-");
    const executable = fakeOpenCodeExecutable("process.exit(99);\n");
    const probe = new OpenCodeProbe(new ProcessSupervisor());

    await expect(probe.probe({
      executable,
      cwd: repository,
      timeoutMs: 5_000,
      modelId: "missing-model",
      models: modelSheet(),
      security: securitySheet(repository),
    }, AbortSignal.timeout(10_000))).resolves.toMatchObject({
      outcome: "failed",
      reason: "model_not_approved",
    });

    await expect(probe.probe({
      executable,
      cwd: repository,
      timeoutMs: 5_000,
      modelId: "opencode-general",
      models: modelSheet("codex"),
      security: securitySheet(repository),
    }, AbortSignal.timeout(10_000))).resolves.toMatchObject({
      outcome: "failed",
      reason: "harness_not_opencode",
    });
  });

  it("fails closed when outside the security sheet or executable is unavailable", async () => {
    const repository = fixtureDirectory("zentra-opencode-repo-");
    const outside = fixtureDirectory("zentra-opencode-outside-");
    const executable = fakeOpenCodeExecutable("process.stdout.write('OpenCode 1.2.3\\n');\n");
    const probe = new OpenCodeProbe(new ProcessSupervisor());

    await expect(probe.probe({
      executable,
      cwd: outside,
      timeoutMs: 5_000,
      modelId: "opencode-general",
      models: modelSheet(),
      security: securitySheet(repository),
    }, AbortSignal.timeout(10_000))).resolves.toMatchObject({
      outcome: "failed",
      reason: "repository_not_allowed",
    });

    await expect(probe.probe({
      executable: path.join(repository, "missing-opencode"),
      cwd: repository,
      timeoutMs: 5_000,
      modelId: "opencode-general",
      models: modelSheet(),
      security: securitySheet(repository),
    }, AbortSignal.timeout(10_000))).resolves.toMatchObject({
      outcome: "failed",
      reason: "opencode_unavailable",
    });
  });

  it("fails closed for invalid cwd and non-executable OpenCode paths", async () => {
    const repository = fixtureDirectory("zentra-opencode-repo-");
    const repositoryFile = path.join(repository, "not-a-directory");
    writeFileSync(repositoryFile, "not a directory", { mode: 0o644 });
    const nonExecutable = path.join(repository, "not-executable");
    writeFileSync(nonExecutable, "not executable", { mode: 0o644 });
    const probe = new OpenCodeProbe(new ProcessSupervisor());

    await expect(probe.probe({
      executable: process.execPath,
      cwd: repositoryFile,
      timeoutMs: 5_000,
      modelId: "opencode-general",
      models: modelSheet(),
      security: securitySheet(repositoryFile),
    }, AbortSignal.timeout(10_000))).resolves.toMatchObject({
      outcome: "failed",
      reason: "repository_not_allowed",
    });

    await expect(probe.probe({
      executable: process.execPath,
      cwd: path.join(repository, "missing"),
      timeoutMs: 5_000,
      modelId: "opencode-general",
      models: modelSheet(),
      security: securitySheet(repository),
    }, AbortSignal.timeout(10_000))).resolves.toMatchObject({
      outcome: "failed",
      reason: "repository_not_allowed",
    });

    await expect(probe.probe({
      executable: nonExecutable,
      cwd: repository,
      timeoutMs: 5_000,
      modelId: "opencode-general",
      models: modelSheet(),
      security: securitySheet(repository),
    }, AbortSignal.timeout(10_000))).resolves.toMatchObject({
      outcome: "failed",
      reason: "opencode_unavailable",
    });

    await expect(probe.probe({
      executable: repository,
      cwd: repository,
      timeoutMs: 5_000,
      modelId: "opencode-general",
      models: modelSheet(),
      security: securitySheet(repository),
    }, AbortSignal.timeout(10_000))).resolves.toMatchObject({
      outcome: "failed",
      reason: "opencode_unavailable",
    });
  });
});
