import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PlannedTask } from "../../src/contracts/milestone.js";
import { OpenCodeWriter } from "../../src/harnesses/opencode-writer.js";
import { WriterWorktreeCapsule } from "../../src/orchestration/writer-worktree-capsule.js";
import type { ModelCapability } from "../../src/policy/model-sheet.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";
import type { ProjectConfig } from "../../src/projects/project-config.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import { GitClient } from "../../src/workspaces/git-client.js";
import { WorkspaceOwnershipGate } from "../../src/workspaces/workspace-ownership.js";
import { WorktreeManager } from "../../src/workspaces/worktree-manager.js";

const temporaryDirectories: string[] = [];
const git = new GitClient();

afterEach(() => {
  delete process.env.ZENTRA_WRITER_SECRET;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WriterWorktreeCapsule", () => {
  it.each([
    ["empty", ""],
    ["plain", "process.stdout.write('plain output\\n');"],
    ["malformed", "process.stdout.write('{not-json}\\n');"],
    ["mixed", "process.stdout.write(JSON.stringify({ type: 'step_finish' }) + '\\nplain\\n');"],
    ["incomplete", "process.stdout.write(JSON.stringify({ type: 'step_finish' }));"],
    ["delegation", "process.stdout.write(JSON.stringify({ type: 'tool_use', tool: 'task' }) + '\\n');"],
  ])("fails a successful process with %s OpenCode event output before validation", async (_name, output) => {
    const fixture = await projectFixture();
    const executable = fakeOpenCode(fixture.root, `
      import { writeFileSync } from "node:fs";
      import path from "node:path";
      const args = process.argv.slice(2);
      writeFileSync(path.join(args[9], "src/greeting.ts"), "changed but untrusted\\n");
      ${output}
    `);
    const result = await capsule().run({
      project: fixture.project, task: plannedTask(), model: writerModel(), security: security(fixture.repository),
      executable, signal: AbortSignal.timeout(10_000),
    });
    expect(result).toMatchObject({ outcome: "failed", writer: {
      outcome: "failed", protocolFailure: "invalid_native_event_stream", rawOutputPolicy: "not_retained",
    } });
  });

  it("gives OpenCode only the bounded writer packet and keeps the primary checkout clean", async () => {
    const fixture = await projectFixture();
    process.env.ZENTRA_WRITER_SECRET = "must-not-leak";
    const executable = fakeOpenCode(fixture.root, `
      import { writeFileSync } from "node:fs";
      import path from "node:path";
      const args = process.argv.slice(2);
      if (process.env.ZENTRA_WRITER_SECRET) process.exit(91);
      if (args.slice(0, 9).join("|") !== "--pure|run|--format|json|--model|provider/model|--agent|zentra-writer|--dir") process.exit(92);
      const packet = JSON.parse(args[10]);
      process.stdout.write(JSON.stringify({ type: "step_start", packet }) + "\\n");
      writeFileSync(path.join(args[9], "src/greeting.ts"), "export const greeting = 'hello from OpenCode';\\n");
      process.stdout.write(JSON.stringify({ type: "step_finish" }) + "\\n");
    `);

    const result = await capsule().run({
      project: fixture.project,
      task: plannedTask(),
      model: writerModel(),
      security: security(fixture.repository),
      executable,
      signal: AbortSignal.timeout(10_000),
    });

    expect(result.outcome).toBe("completed");
    expect(result.ownership).toMatchObject({
      outcome: "accepted",
      changedPaths: ["src/greeting.ts"],
      violations: [],
    });
    const packetEvent = JSON.parse(result.writer!.stdout.split("\n")[0]!);
    expect(packetEvent.packet).toEqual({
      brief: "Update the greeting implementation.",
      ownedPaths: ["src/**"],
      forbiddenPaths: [".env", ".git/**"],
      acceptanceCriteria: ["The greeting is updated."],
      budget: {
        maxSeconds: 5,
        maxRetries: 0,
        maxCostUsd: 1,
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
      },
      securityBoundary: {
        repositoryWrites: "assigned_worktree_only",
        validationAuthority: "zentra_named_validations_only",
        integrationAuthority: "none",
        shellAuthority: "none",
        modelToolNetwork: "denied",
        harnessProviderTransport: "user_os_network_authority",
        parentSecretInheritance: "denied",
        runtimeIsolation: "trusted_project_policy_not_os_sandbox",
      },
    });
    expect(await gitOutput(fixture.repository, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(path.join(fixture.repository, "src/greeting.ts"), "utf8")).toContain("hello");
    expect(readFileSync(path.join(result.lease!.path, "src/greeting.ts"), "utf8")).toContain("OpenCode");
  });

  it("allows the integration ref to advance while an isolated writer runs", async () => {
    const fixture = await projectFixture();
    const executable = fakeOpenCode(fixture.root, `
      import { writeFileSync } from "node:fs";
      import path from "node:path";
      const args = process.argv.slice(2);
      writeFileSync(path.join(args[9], "src/greeting.ts"), "export const greeting = 'new';\\n");
      process.stdout.write(JSON.stringify({ type: "step_finish" }) + "\\n");
    `);
    let advancedFrom: string | null = null;

    const result = await capsule().run({
      project: fixture.project,
      task: plannedTask(),
      model: writerModel(),
      security: security(fixture.repository),
      executable,
      signal: AbortSignal.timeout(10_000),
      observer: {
        onWriterStarted: async () => {
          const original = (await gitOutput(fixture.repository, ["rev-parse", "refs/heads/zentra/integration"])).trim();
          advancedFrom = original;
          const tree = (await gitOutput(fixture.repository, ["rev-parse", `${original}^{tree}`])).trim();
          const advanced = (await gitOutput(fixture.repository, ["commit-tree", tree, "-p", original, "-m", "concurrent integration"])).trim();
          const update = await git.run(fixture.repository, ["update-ref", "refs/heads/zentra/integration", advanced, original]);
          expect(update.exitCode).toBe(0);
        },
      },
    });

    expect(result.outcome).toBe("completed");
    expect(advancedFrom).not.toBeNull();
    expect((await gitOutput(fixture.repository, ["rev-parse", "refs/heads/zentra/integration"])).trim()).not.toBe(advancedFrom);
    expect(await gitOutput(fixture.repository, ["status", "--porcelain"])).toBe("");
  });

  it("rejects writes outside ownership and preserves the worktree evidence", async () => {
    const fixture = await projectFixture();
    const executable = fakeOpenCode(fixture.root, `
      import { writeFileSync } from "node:fs";
      import path from "node:path";
      const args = process.argv.slice(2);
      writeFileSync(path.join(args[9], "README.md"), "unauthorized\\n");
      process.stdout.write(JSON.stringify({ type: "step_finish" }) + "\\n");
    `);

    const result = await capsule().run({
      project: fixture.project,
      task: plannedTask(),
      model: writerModel(),
      security: security(fixture.repository),
      executable,
      signal: AbortSignal.timeout(10_000),
    });

    expect(result.outcome).toBe("denied");
    expect(result.ownership).toMatchObject({
      outcome: "rejected",
      changedPaths: ["README.md"],
      violations: [{ path: "README.md", reason: "outside_owned_scope" }],
    });
    expect(existsSync(result.lease!.path)).toBe(true);
    expect(readFileSync(path.join(result.lease!.path, "README.md"), "utf8")).toBe("unauthorized\n");
    expect(await gitOutput(fixture.repository, ["status", "--porcelain"])).toBe("");
  });

  it("rejects ignored writes outside ownership before they can affect validation", async () => {
    const fixture = await projectFixture();
    const executable = fakeOpenCode(fixture.root, `
      import { mkdirSync, writeFileSync } from "node:fs";
      import path from "node:path";
      const args = process.argv.slice(2);
      mkdirSync(path.join(args[9], "cache"));
      writeFileSync(path.join(args[9], "cache/result.json"), "{}\\n");
      process.stdout.write(JSON.stringify({ type: "step_finish" }) + "\\n");
    `);

    const result = await capsule().run({
      project: fixture.project,
      task: plannedTask(),
      model: writerModel(),
      security: security(fixture.repository),
      executable,
      signal: AbortSignal.timeout(10_000),
    });

    expect(result).toMatchObject({
      outcome: "denied",
      ownership: {
        outcome: "rejected",
        changedPaths: ["cache/result.json"],
        violations: [{ path: "cache/result.json", reason: "outside_owned_scope" }],
      },
    });
    expect(existsSync(path.join(result.lease!.path, "cache/result.json"))).toBe(true);
    expect(await gitOutput(fixture.repository, ["status", "--porcelain"])).toBe("");
  });

  it("preserves the worktree and bounded worker evidence when OpenCode fails", async () => {
    const fixture = await projectFixture();
    const executable = fakeOpenCode(fixture.root, `
      import { writeFileSync } from "node:fs";
      import path from "node:path";
      const args = process.argv.slice(2);
      writeFileSync(path.join(args[9], "src/greeting.ts"), "unfinished\\n");
      writeFileSync(path.join(args[9], "README.md"), "unauthorized and unfinished\\n");
      process.stderr.write("model failed\\n");
      process.exit(7);
    `);

    const result = await capsule().run({
      project: fixture.project,
      task: plannedTask(),
      model: writerModel(),
      security: security(fixture.repository),
      executable,
      signal: AbortSignal.timeout(10_000),
    });

    expect(result.outcome).toBe("failed");
    expect(result.writer).toMatchObject({ outcome: "failed", exitCode: 7 });
    expect(result.writer?.stderr).toContain("model failed");
    expect(result.ownership).toMatchObject({
      outcome: "rejected",
      violations: [{ path: "README.md", reason: "outside_owned_scope" }],
    });
    expect(existsSync(result.lease!.path)).toBe(true);
    expect(readFileSync(path.join(result.lease!.path, "src/greeting.ts"), "utf8")).toBe("unfinished\n");
    expect(await gitOutput(fixture.repository, ["status", "--porcelain"])).toBe("");
  });

  it("rejects a writer-created commit instead of trusting a clean worktree", async () => {
    const fixture = await projectFixture();
    const executable = fakeOpenCode(fixture.root, `
      import { writeFileSync } from "node:fs";
      import { execFileSync } from "node:child_process";
      import path from "node:path";
      const args = process.argv.slice(2);
      const workspace = args[9];
      writeFileSync(path.join(workspace, "README.md"), "committed unauthorized change\\n");
      execFileSync("git", ["add", "--", "README.md"], { cwd: workspace });
      execFileSync("git", ["commit", "-m", "unauthorized"], { cwd: workspace });
      process.stdout.write(JSON.stringify({ type: "step_finish" }) + "\\n");
    `);

    const result = await capsule().run({
      project: fixture.project,
      task: plannedTask(),
      model: writerModel(),
      security: security(fixture.repository),
      executable,
      signal: AbortSignal.timeout(10_000),
    });

    expect(result.outcome).toBe("denied");
    expect(result.ownership?.changedPaths).toContain("README.md");
    expect(result.ownership?.violations).toEqual(expect.arrayContaining([
      { path: "README.md", reason: "outside_owned_scope" },
      { path: ".git", reason: "git_state_changed" },
    ]));
    expect(existsSync(result.lease!.path)).toBe(true);
    expect(await gitOutput(fixture.repository, ["status", "--porcelain"])).toBe("");
  });

  it("refuses an owned scope containing a tracked symlink before OpenCode starts", async () => {
    const fixture = await projectFixture();
    const outside = path.join(fixture.root, "outside");
    const marker = path.join(fixture.root, "writer-started");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "file.ts"), "outside\n");
    symlinkSync(outside, path.join(fixture.repository, "src/external-link"));
    await gitOk(fixture.repository, ["add", "--", "src/external-link"]);
    await gitOk(fixture.repository, ["commit", "-m", "add tracked symlink"]);
    const executable = fakeOpenCode(fixture.root, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "started");
    `);

    await expect(capsule().run({
      project: fixture.project,
      task: { ...plannedTask(), ownedPaths: ["src/external-link/file.ts"] },
      model: writerModel(),
      security: security(fixture.repository),
      executable,
      signal: AbortSignal.timeout(10_000),
    })).rejects.toThrow(/link|submodule/i);

    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(path.join(outside, "file.ts"), "utf8")).toBe("outside\n");
    expect(await gitOutput(fixture.repository, ["status", "--porcelain"])).toBe("");
  });

  it("rejects detaching the ticket worktree even when the commit stays unchanged", async () => {
    const fixture = await projectFixture();
    const executable = fakeOpenCode(fixture.root, `
      import { writeFileSync } from "node:fs";
      import { execFileSync } from "node:child_process";
      import path from "node:path";
      const args = process.argv.slice(2);
      const workspace = args[9];
      execFileSync("git", ["checkout", "--detach"], { cwd: workspace });
      writeFileSync(path.join(workspace, "src/greeting.ts"), "detached change\\n");
      process.stdout.write(JSON.stringify({ type: "step_finish" }) + "\\n");
    `);

    const result = await capsule().run({
      project: fixture.project,
      task: plannedTask(),
      model: writerModel(),
      security: security(fixture.repository),
      executable,
      signal: AbortSignal.timeout(10_000),
    });

    expect(result.outcome).toBe("denied");
    expect(result.ownership?.violations).toContainEqual({
      path: ".git",
      reason: "git_state_changed",
    });
    expect(existsSync(result.lease!.path)).toBe(true);
  });
});

function capsule(): WriterWorktreeCapsule {
  return new WriterWorktreeCapsule(
    new WorktreeManager(),
    new OpenCodeWriter(new ProcessSupervisor()),
    new WorkspaceOwnershipGate(),
  );
}

function plannedTask(): PlannedTask {
  return {
    taskId: "writer-1",
    title: "Update greeting",
    description: "Update the greeting implementation.",
    dependencies: [],
    ownedPaths: ["src/**"],
    forbiddenPaths: [".env"],
    acceptanceCriteria: ["The greeting is updated."],
    roleAssignment: { role: "implementer", agentId: "writer-model", harness: "opencode" },
    risk: {
      level: "low",
      authority: "workspace_write",
      requiresReview: true,
      requiresApproval: false,
    },
    budget: {
      maxSeconds: 5,
      maxRetries: 0,
      maxCostUsd: 1,
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
    },
  };
}

function writerModel(): ModelCapability {
  return {
    id: "writer-model",
    harness: "opencode",
    model: "provider/model",
    roles: ["implementer"],
    specialties: ["coding"],
    costTier: "low",
    contextTokens: 128_000,
    maxConcurrency: 1,
    toolPermissions: ["read_repository", "write_worktree"],
    network: "denied",
    fallbackOrder: [],
    qualityHistory: { successes: 1, attempts: 1 },
  };
}

function security(repository: string): SecuritySheet {
  return {
    allowedRepositories: [repository],
    allowedFileScopes: ["src/**"],
    forbiddenPaths: [".env", ".git/**"],
    network: { default: "denied", allowedDestinations: [] },
    secretHandling: ["Do not inherit parent secrets."],
    approvalRequiredOperations: ["external_effect"],
    releaseBoundary: "local_preparation_only",
    stopAndAskConditions: ["forbidden_file_scope"],
  };
}

async function projectFixture(): Promise<{
  root: string;
  repository: string;
  project: ProjectConfig;
}> {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-writer-capsule-")));
  temporaryDirectories.push(root);
  const repository = path.join(root, "repository");
  const worktrees = path.join(root, "worktrees");
  await gitOk(root, ["init", "-b", "main", repository]);
  await gitOk(repository, ["config", "user.name", "Zentra Fixture"]);
  await gitOk(repository, ["config", "user.email", "fixture@zentra.local"]);
  mkdirSync(path.join(repository, "src"));
  writeFileSync(path.join(repository, ".gitignore"), "cache/\n");
  writeFileSync(path.join(repository, "README.md"), "# fixture\n");
  writeFileSync(path.join(repository, "src/greeting.ts"), "export const greeting = 'hello';\n");
  await gitOk(repository, ["add", "--", ".gitignore", "README.md", "src/greeting.ts"]);
  await gitOk(repository, ["commit", "-m", "initial"]);
  return {
    root,
    repository,
    project: {
      projectId: "fixture",
      repositoryPath: repository,
      integrationBranch: "zentra/integration",
      worktreeRoot: worktrees,
      validations: {
        focused: [process.execPath, "--version"],
        full: [process.execPath, "--version"],
        focusedTimeoutMs: 5_000,
        fullTimeoutMs: 5_000,
      },
    },
  };
}

function fakeOpenCode(root: string, source: string): string {
  const executable = path.join(root, `fake-opencode-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(executable, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  return realpathSync.native(executable);
}

async function gitOk(cwd: string, args: readonly string[]): Promise<void> {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout;
}
