import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { pathToFileURL } from "node:url";

import { runCli, type SignalSource } from "../../src/cli/main.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";
import { TaskService } from "../../src/tasks/task-service.js";
import { GitClient } from "../../src/workspaces/git-client.js";
import { RoleCapabilityEnvelopeService, buildRoleCapabilityBinding, roleToolPermissions } from "../../src/workers/role-capability-envelope.js";
import { capabilityTaskHead, createCapabilityBoundaryOccurrence } from "../../src/contracts/capability-boundary.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const ATTACKER_MARKER = "ATTACKER_MARKER_DO_NOT_PRINT";
const CONTENT_AWARE_REVIEWER = path.resolve(
  import.meta.dirname,
  "../fixtures/content-aware-reviewer.mjs",
);

interface Fixture {
  readonly baseDirectory: string;
  readonly repositoryPath: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly securitySheetPath: string;
}

interface Invocation {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: Record<string, unknown>;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const result = await new GitClient().run(cwd, args, { timeoutMs: 10_000 });
  if (result.exitCode !== 0 || result.termination !== null || result.truncated) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function fixture(): Promise<Fixture> {
  const baseDirectory = mkdtempSync(path.join(tmpdir(), "zentra-cli-"));
  temporaryDirectories.push(baseDirectory);
  const repositoryPath = path.join(baseDirectory, "repository");
  const worktreeRoot = path.join(baseDirectory, "worktrees");
  const configPath = path.join(baseDirectory, "project.json");
  const databasePath = path.join(baseDirectory, "journal.sqlite");
  const securitySheetPath = path.join(baseDirectory, "task-security.md");

  await gitOk(baseDirectory, ["init", "-b", "main", repositoryPath]);
  await gitOk(repositoryPath, ["config", "user.name", "Zentra CLI Fixture"]);
  await gitOk(repositoryPath, ["config", "user.email", "fixture@zentra.local"]);
  mkdirSync(path.join(repositoryPath, "test"));
  writeFileSync(path.join(repositoryPath, "greeting.txt"), "hello\n", "utf8");
  writeFileSync(
    path.join(repositoryPath, "auth.ts"),
    "export const requireAuthentication = true;\n",
    "utf8",
  );
  writeFileSync(
    path.join(repositoryPath, "test", "greeting.test.mjs"),
    'import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\ntest("greeting", async () => assert.match(await readFile(new URL("../greeting.txt", import.meta.url), "utf8"), /^hello(?: from CLI)?\\n$/));\n',
    "utf8",
  );
  writeFileSync(
    configPath,
    `${JSON.stringify({
      projectId: "cli-project",
      repositoryPath,
      integrationBranch: "zentra/integration",
      worktreeRoot,
      validations: {
        focused: [process.execPath, "--test", "test/greeting.test.mjs"],
        full: [process.execPath, "--test"],
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await gitOk(repositoryPath, ["add", "--", "."]);
  await gitOk(repositoryPath, ["commit", "-m", "initial fixture"]);
  writeFileSync(securitySheetPath, `# Zentra Security Sheet

## Allowed Repositories
- ${realpathSync.native(repositoryPath)}

## Allowed File Scopes
- greeting.txt
- auth.ts

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
- forbidden_file_scope
`, "utf8");
  return { baseDirectory, repositoryPath, configPath, databasePath, securitySheetPath };
}

async function invoke(
  argv: readonly string[],
  signalSource: SignalSource = process,
  fixtureAnchor?: URL,
): Promise<Invocation> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
    signalSource,
    ...(fixtureAnchor === undefined ? {} : { fixtureAnchor }),
  });
  const combined = `${stdout}${stderr}`;
  const lines = combined.trim().split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  return {
    code,
    stdout,
    stderr,
    json: JSON.parse(lines[0]!) as Record<string, unknown>,
  };
}

function runArguments(
  testFixture: Fixture,
  taskId = "task-cli",
): readonly string[] {
  return [
    "task", "run",
    "--config", testFixture.configPath,
    "--database", testFixture.databasePath,
    "--task-id", taskId,
    "--title", "Update greeting",
    "--file", "greeting.txt",
    "--content", "hello from CLI\n",
    "--security-sheet", testFixture.securitySheetPath,
  ];
}

function writePolicySheets(testFixture: Fixture): {
  readonly modelSheetPath: string;
  readonly securitySheetPath: string;
} {
  const modelSheetPath = path.join(testFixture.baseDirectory, "MODEL-SHEET.md");
  const securitySheetPath = path.join(testFixture.baseDirectory, "SECURITY-SHEET.md");
  writeFileSync(modelSheetPath, `# Zentra Model Sheet

## Models
| id | harness | model | roles | specialties | cost | context | concurrency | tools | network | fallback | quality |
| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
| opencode-general | opencode | provider/sk-live-SECRET | planner,researcher,implementer,reviewer | coding,review | low | 128000 | 2 | read_repository,write_worktree,review_diff | denied | none | 3/4 |
`, "utf8");
  writeFileSync(securitySheetPath, `# Zentra Security Sheet

## Allowed Repositories
- ${realpathSync.native(testFixture.repositoryPath)}

## Allowed File Scopes
- src/**
- tests/**

## Forbidden Paths
- .env

## Network
Default: denied

## Secret Handling
- API token sk-live-SECRET must never be printed.
- Do not inherit parent secrets.

## Approval Required Operations
- external_effect
- publish_release

## Release Boundary
local_preparation_only

## Stop And Ask Conditions
- missing_authority
- undeclared_network
- forbidden_file_scope
`, "utf8");
  return { modelSheetPath, securitySheetPath };
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function databaseSchema(databasePath: string): unknown[] {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    ).all();
  } finally {
    database.close();
  }
}

function eventTypes(databasePath: string, streamId: string): readonly string[] {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return (database.prepare(
      "SELECT type FROM events WHERE stream_id = ? ORDER BY stream_version",
    ).all(streamId) as Array<{ readonly type: string }>).map((event) => event.type);
  } finally {
    database.close();
  }
}

function copiedSourceFixtureLayout(): {
  readonly anchor: URL;
  readonly worker: string;
} {
  const baseDirectory = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-fixture-layout-")));
  temporaryDirectories.push(baseDirectory);
  const moduleDirectory = path.join(baseDirectory, "src", "fixtures");
  const fixtureDirectory = path.join(baseDirectory, "fixtures");
  mkdirSync(moduleDirectory, { recursive: true });
  mkdirSync(fixtureDirectory);
  const root = path.resolve(import.meta.dirname, "../..");
  const worker = path.join(fixtureDirectory, "deterministic-worker.mjs");
  copyFileSync(path.join(root, "fixtures", "deterministic-worker.mjs"), worker);
  const anchorPath = path.join(moduleDirectory, "bundled-fixtures.ts");
  writeFileSync(anchorPath, "// isolated resolver anchor\n", "utf8");
  return { anchor: pathToFileURL(anchorPath), worker };
}

describe("Zentra CLI", () => {
  it("validates one project config and emits one success object on stdout", async () => {
    const testFixture = await fixture();

    const result = await invoke(["project", "validate", "--config", testFixture.configPath]);

    expect(result).toMatchObject({
      code: 0,
      stderr: "",
      json: { command: "project.validate", status: "valid", projectIds: ["cli-project"] },
    });
  });

  it("previews Markdown model and security sheets without creating operational effects", async () => {
    const testFixture = await fixture();
    const { modelSheetPath, securitySheetPath } = writePolicySheets(testFixture);
    const schemaBefore = existsSync(testFixture.databasePath)
      ? databaseSchema(testFixture.databasePath)
      : null;

    const result = await invoke([
      "policy", "preview",
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
    ]);

    expect(result).toMatchObject({
      code: 0,
      stderr: "",
      json: {
        command: "policy.preview",
        model: {
          modelCount: 1,
          harnesses: ["opencode"],
          roles: ["implementer", "planner", "researcher", "reviewer"],
          costTiers: ["low"],
          maxConcurrency: 2,
        },
        security: {
          allowedRepositoryCount: 1,
          allowedFileScopeCount: 2,
          forbiddenPathCount: 1,
          network: { default: "denied", allowedDestinationCount: 0 },
          secretHandlingRules: 2,
          releaseBoundary: "local_preparation_only",
        },
        deniedCapabilities: [
          "general_shell",
          "raw_parent_secrets",
          "network_by_default",
          "remote_release_effects",
        ],
      },
    });
    expect(JSON.stringify(result.json)).not.toContain("sk-live-SECRET");
    expect(JSON.stringify(result.json)).not.toContain("provider/");
    expect(existsSync(testFixture.databasePath)).toBe(schemaBefore !== null);
    if (schemaBefore !== null) expect(databaseSchema(testFixture.databasePath)).toEqual(schemaBefore);
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
  });

  it("returns stable bounded errors for invalid policy sheets", async () => {
    const testFixture = await fixture();
    const { modelSheetPath, securitySheetPath } = writePolicySheets(testFixture);
    writeFileSync(modelSheetPath, "# missing models\n", "utf8");

    const modelResult = await invoke([
      "policy", "preview",
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
    ]);
    expect(modelResult).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "policy.preview", error: { code: "INVALID_MODEL_SHEET" } },
    });

    writePolicySheets(testFixture);
    writeFileSync(securitySheetPath, "# missing security\n", "utf8");
    const securityResult = await invoke([
      "policy", "preview",
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
    ]);
    expect(securityResult).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "policy.preview", error: { code: "INVALID_SECURITY_SHEET" } },
    });
    expect(Buffer.byteLength(securityResult.stderr, "utf8")).toBeLessThan(512);
  });

  it("creates a durable natural-language milestone preview without execution effects", async () => {
    const testFixture = await fixture();
    const { modelSheetPath, securitySheetPath } = writePolicySheets(testFixture);
    const tracePath = path.join(testFixture.baseDirectory, "milestone.jsonl");

    const result = await invoke([
      "milestone", "preview",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
      "--agent-tail-jsonl", tracePath,
      "--task", "Add an Agent Tail trace for milestone previews",
    ]);

    expect(result).toMatchObject({
      code: 0,
      stderr: "",
      json: {
        command: "milestone.preview",
        tracePath,
        milestone: {
          projectId: "cli-project",
          lifecycle: "ready",
          terminalOutcome: null,
          plan: {
            projectId: "cli-project",
            goal: "Add an Agent Tail trace for milestone previews",
            tasks: [
              {
                title: "Preview milestone plan",
                acceptanceCriteria: expect.arrayContaining([
                  "The preview creates durable milestone plan evidence.",
                ]),
                dependencies: [],
                ownedPaths: ["src/**"],
                roleAssignment: { role: "planner", agentId: "opencode-general", harness: "opencode" },
                risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
                budget: { maxSeconds: 300, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000 },
              },
            ],
          },
        },
        stopAndAskBoundaries: ["missing_authority", "undeclared_network", "forbidden_file_scope"],
      },
    });
    const milestone = result.json.milestone as { milestoneId: string; streamVersion: number };
    expect(milestone.milestoneId).toMatch(/^milestone-[a-f0-9]{12}$/);
    expect(milestone.streamVersion).toBe(2);
    const traceLines = readFileSync(tracePath, "utf8").trim().split("\n");
    expect(traceLines).toHaveLength(3);
    const traceEvents = traceLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(traceEvents.map((event) => event.kind)).toEqual([
      "routing.model_selected",
      "milestone.created",
      "milestone.plan_created",
    ]);
    expect(traceEvents.every((event) => event.trace_id === milestone.milestoneId)).toBe(true);
    expect((traceEvents[2]!.payload as { stopAndAskBoundaries: unknown }).stopAndAskBoundaries)
      .toEqual(["missing_authority", "undeclared_network", "forbidden_file_scope"]);
    expect(eventTypes(testFixture.databasePath, milestone.milestoneId)).toEqual([
      "milestone.created",
      "milestone.plan_created",
    ]);
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
    expect(await gitOk(testFixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(
      await gitOk(testFixture.repositoryPath, ["rev-parse", "main"]),
    );
  });

  it("streams the retained milestone trace to stdout for live Agent Tail input", async () => {
    const testFixture = await fixture();
    const { modelSheetPath, securitySheetPath } = writePolicySheets(testFixture);
    const tracePath = path.join(testFixture.baseDirectory, "live-milestone.jsonl");
    let stdout = "";
    let stderr = "";

    const code = await runCli([
      "milestone", "preview",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
      "--agent-tail-jsonl", tracePath,
      "--agent-tail-stream",
      "--task", "Stream an Agent Tail milestone preview",
    ], {
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });

    expect(code).toBe(0);
    expect(stdout).toBe(readFileSync(tracePath, "utf8"));
    expect(stdout.trimEnd().split("\n")).toHaveLength(3);
    expect(JSON.parse(stderr) as unknown).toMatchObject({
      command: "milestone.preview",
      tracePath,
      traceOutcome: "completed",
    });
  });

  it("preserves accepted milestone state when the live stream fails", async () => {
    const testFixture = await fixture();
    const { modelSheetPath, securitySheetPath } = writePolicySheets(testFixture);
    const tracePath = path.join(testFixture.baseDirectory, "failed-live-milestone.jsonl");
    let writes = 0;
    let stderr = "";

    const code = await runCli([
      "milestone", "preview",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
      "--agent-tail-jsonl", tracePath,
      "--agent-tail-stream",
      "--task", "Keep accepted state after stream failure",
    ], {
      stdout: () => {
        writes += 1;
        throw new Error("closed stream");
      },
      stderr: (value) => { stderr += value; },
    });

    const result = JSON.parse(stderr) as {
      milestone: { milestoneId: string; lifecycle: string };
      traceOutcome: string;
    };
    expect(code).toBe(1);
    expect(writes).toBe(1);
    expect(result).toMatchObject({ milestone: { lifecycle: "ready" }, traceOutcome: "failed" });
    expect(eventTypes(testFixture.databasePath, result.milestone.milestoneId)).toEqual([
      "milestone.created",
      "milestone.plan_created",
    ]);
    expect(readFileSync(tracePath, "utf8").trimEnd().split("\n")).toHaveLength(3);
  });

  it("documents that live Agent Tail uses stdin instead of following files", async () => {
    let output = "";

    const code = await runCli(["task", "run", "--help"], {
      stdout: (value) => { output += value; },
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(output).toContain("--agent-tail-stream");
    expect(output).toContain("agent-tail -");
    expect(output).toContain("stdin");
    expect(output).toContain("does not follow appended files");
  });

  it("requires a retained trace path before enabling live Agent Tail output", async () => {
    const testFixture = await fixture();

    const result = await invoke([
      ...runArguments(testFixture, "task-live-without-file"),
      "--agent-tail-stream",
    ]);

    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "task.run", error: { code: "INVALID_COMMAND" } },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);
  });

  it("rejects milestone preview when sheets do not authorize the repository or planner role", async () => {
    const testFixture = await fixture();
    const { modelSheetPath, securitySheetPath } = writePolicySheets(testFixture);
    const tracePath = path.join(testFixture.baseDirectory, "milestone.jsonl");
    writeFileSync(securitySheetPath, readFileSync(securitySheetPath, "utf8").replace(
      realpathSync.native(testFixture.repositoryPath),
      realpathSync.native(testFixture.baseDirectory),
    ), "utf8");

    const unauthorizedRepository = await invoke([
      "milestone", "preview",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
      "--agent-tail-jsonl", tracePath,
      "--task", "Plan safely",
    ]);
    expect(unauthorizedRepository).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "milestone.preview", error: { code: "INVALID_SECURITY_SHEET" } },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);
    expect(existsSync(tracePath)).toBe(false);

    writePolicySheets(testFixture);
    writeFileSync(modelSheetPath, readFileSync(modelSheetPath, "utf8").replace(
      "planner,researcher,implementer,reviewer",
      "implementer,reviewer",
    ), "utf8");
    const unauthorizedPlanner = await invoke([
      "milestone", "preview",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
      "--agent-tail-jsonl", tracePath,
      "--task", "Plan safely",
    ]);
    expect(unauthorizedPlanner).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "milestone.preview", error: { code: "INVALID_MODEL_SHEET" } },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);
    expect(existsSync(tracePath)).toBe(false);

    writePolicySheets(testFixture);
    const longModelId = `m${"a".repeat(300)}`;
    writeFileSync(modelSheetPath, readFileSync(modelSheetPath, "utf8").replace(
      "opencode-general",
      longModelId,
    ), "utf8");
    const invalidPlannerIdentity = await invoke([
      "milestone", "preview",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
      "--agent-tail-jsonl", tracePath,
      "--task", "Plan safely",
    ]);
    expect(invalidPlannerIdentity).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "milestone.preview", error: { code: "OPERATION_FAILED" } },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);
    expect(existsSync(tracePath)).toBe(false);
  });

  it("does not erase an existing trace when a duplicate milestone preview append fails", async () => {
    const testFixture = await fixture();
    const { modelSheetPath, securitySheetPath } = writePolicySheets(testFixture);
    const tracePath = path.join(testFixture.baseDirectory, "milestone.jsonl");
    const args = [
      "milestone", "preview",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
      "--agent-tail-jsonl", tracePath,
      "--task", "Do the same preview twice",
    ] as const;

    const first = await invoke(args);
    expect(first.code).toBe(0);
    const traceBefore = readFileSync(tracePath, "utf8");

    const second = await invoke(args);

    expect(second).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "milestone.preview", error: { code: "OPERATION_FAILED" } },
    });
    expect(readFileSync(tracePath, "utf8")).toBe(traceBefore);
  });

  it("lists and inspects milestone previews without worker startup", async () => {
    const testFixture = await fixture();
    const { modelSheetPath, securitySheetPath } = writePolicySheets(testFixture);
    const firstTrace = path.join(testFixture.baseDirectory, "first.jsonl");
    const secondTrace = path.join(testFixture.baseDirectory, "second.jsonl");

    const first = await invoke([
      "milestone", "preview",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
      "--agent-tail-jsonl", firstTrace,
      "--task", "List the first milestone",
    ]);
    const second = await invoke([
      "milestone", "preview",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
      "--agent-tail-jsonl", secondTrace,
      "--task", "List the second milestone",
    ]);
    const firstMilestone = first.json.milestone as { milestoneId: string };
    const secondMilestone = second.json.milestone as { milestoneId: string };

    const listed = await invoke(["milestone", "list", "--database", testFixture.databasePath]);
    expect(listed).toMatchObject({
      code: 0,
      stderr: "",
      json: {
        command: "milestone.list",
        milestones: [
          { milestoneId: firstMilestone.milestoneId, tracePath: firstTrace, lifecycle: "ready" },
          { milestoneId: secondMilestone.milestoneId, tracePath: secondTrace, lifecycle: "ready" },
        ],
      },
    });

    const status = await invoke([
      "milestone", "status",
      "--database", testFixture.databasePath,
      "--milestone-id", firstMilestone.milestoneId,
    ]);
    expect(status).toMatchObject({
      code: 0,
      stderr: "",
      json: {
        command: "milestone.status",
        milestone: {
          milestoneId: firstMilestone.milestoneId,
          title: "List the first milestone",
          lifecycle: "ready",
          traceId: firstMilestone.milestoneId,
          tracePath: firstTrace,
        },
      },
    });
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
  });

  it("reports a file-backed durable authority pause as stable secret-free JSON without Git effects", async () => {
    const testFixture = await fixture();
    const journal = new SqliteEventJournal(testFixture.databasePath);
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-authority-status",
      projectId: "cli-project",
      title: ATTACKER_MARKER,
      correlationId: "trace-authority-status",
      plan: {
        milestoneId: "milestone-authority-status",
        projectId: "cli-project",
        goal: ATTACKER_MARKER,
        tasks: [{
          taskId: "task-authority-status",
          title: ATTACKER_MARKER,
          description: ATTACKER_MARKER,
          dependencies: [],
          ownedPaths: ["secrets/token.txt"],
          forbiddenPaths: [".env"],
          acceptanceCriteria: [ATTACKER_MARKER],
          roleAssignment: { role: "researcher", agentId: "researcher", harness: "opencode" },
          risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
          budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
        }],
      },
    });
    const security: SecuritySheet = {
      allowedRepositories: [testFixture.repositoryPath],
      allowedFileScopes: ["src/**"],
      forbiddenPaths: [".env", "secrets/**"],
      network: { default: "denied", allowedDestinations: [] },
      secretHandling: [`${ATTACKER_MARKER}_SECRET_HANDLING`],
      approvalRequiredOperations: [],
      releaseBoundary: "local_preparation_only",
      stopAndAskConditions: ["forbidden_file_scope"],
    };
    registry.admitTask("milestone-authority-status", "task-authority-status", security, {
      kind: "opencode", repositoryPath: testFixture.repositoryPath, actorId: "researcher", harness: "opencode",
      role: "researcher", capabilityId: "researcher", transportModelId: "fixture/model",
      authority: "read_only",
      contextTokens: 1_000,
      roles: ["researcher"], toolPermissions: ["read_repository"], network: "denied",
      requestedBudget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100, timeoutMs: 30_000 },
    });
    journal.close();
    const refsBefore = await gitOk(testFixture.repositoryPath, ["show-ref"]);
    const worktreesBefore = await gitOk(testFixture.repositoryPath, ["worktree", "list", "--porcelain"]);

    const status = await invoke([
      "milestone", "status",
      "--database", testFixture.databasePath,
      "--milestone-id", "milestone-authority-status",
    ]);

    expect(status).toMatchObject({
      code: 0,
      stderr: "",
      json: {
        command: "milestone.status",
        milestone: {
          milestoneId: "milestone-authority-status",
          lifecycle: "paused",
          terminalOutcome: null,
          attention: {
            schemaVersion: 1,
            attentionId: expect.stringMatching(/^[a-f0-9]{64}$/),
            taskId: "task-authority-status",
            reason: "forbidden_file_scope",
            classification: "hard_stop",
          },
        },
      },
    });
    expect(JSON.stringify(status.json)).not.toContain(ATTACKER_MARKER);
    expect(JSON.stringify(status.json)).not.toContain("secretHandling");
    expect(JSON.stringify(status.json)).not.toContain("credentials");
    expect(await gitOk(testFixture.repositoryPath, ["show-ref"])).toBe(refsBefore);
    expect(await gitOk(testFixture.repositoryPath, ["worktree", "list", "--porcelain"])).toBe(worktreesBefore);
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
  });

  it("rejects an invalid Agent Tail trace target before journal effects", async () => {
    const testFixture = await fixture();
    const { modelSheetPath, securitySheetPath } = writePolicySheets(testFixture);
    const tracePath = path.join(testFixture.baseDirectory, "agent-tail-directory");
    mkdirSync(tracePath);

    const result = await invoke([
      "milestone", "preview",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
      "--agent-tail-jsonl", tracePath,
      "--task", "Do not create partial preview state",
    ]);

    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "milestone.preview", error: { code: "OPERATION_FAILED" } },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);

    const longTracePath = path.join(testFixture.baseDirectory, `${"x".repeat(300)}.jsonl`);
    const longNameResult = await invoke([
      "milestone", "preview",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--model-sheet", modelSheetPath,
      "--security-sheet", securitySheetPath,
      "--agent-tail-jsonl", longTracePath,
      "--task", "Do not create partial preview state",
    ]);
    expect(longNameResult).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "milestone.preview", error: { code: "OPERATION_FAILED" } },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);
  });

  it("rejects task trace destinations outside the journal directory or through a symlink", async () => {
    const testFixture = await fixture();
    const outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-cli-trace-outside-")));
    temporaryDirectories.push(outside);
    const outsideTrace = path.join(outside, "outside.jsonl");

    const outsideResult = await invoke([
      ...runArguments(testFixture, "task-outside-trace"),
      "--agent-tail-jsonl", outsideTrace,
    ]);
    expect(outsideResult).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "task.run", error: { code: "OPERATION_FAILED" } },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);
    expect(existsSync(outsideTrace)).toBe(false);

    const linkedDirectory = path.join(testFixture.baseDirectory, "linked-traces");
    symlinkSync(outside, linkedDirectory);
    const linkedTrace = path.join(linkedDirectory, "linked.jsonl");
    const linkedResult = await invoke([
      ...runArguments(testFixture, "task-linked-trace"),
      "--agent-tail-jsonl", linkedTrace,
    ]);
    expect(linkedResult).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "task.run", error: { code: "OPERATION_FAILED" } },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);
    expect(existsSync(path.join(outside, "linked.jsonl"))).toBe(false);
  });

  it("runs the complete tracer bullet in a real repository and replays exact status", async () => {
    const testFixture = await fixture();
    const tracePath = path.join(testFixture.baseDirectory, "task-cli.jsonl");
    let stdout = "";
    let stderr = "";

    const code = await runCli([
      ...runArguments(testFixture),
      "--agent-tail-jsonl", tracePath,
      "--agent-tail-stream",
    ], {
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    const run = {
      code,
      stdout,
      stderr,
      json: JSON.parse(stderr) as Record<string, unknown>,
    };
    expect(run).toMatchObject({
      code: 0,
      json: {
        command: "task.run",
        outcome: "completed",
        tracePath,
        task: {
          taskId: "task-cli",
          projectId: "cli-project",
          lifecycle: "terminal",
          terminalOutcome: "completed",
        },
      },
    });
    expect(stdout).toBe(readFileSync(tracePath, "utf8"));
    expect(await gitOk(testFixture.repositoryPath, ["show", "zentra/integration:greeting.txt"]))
      .toBe("hello from CLI");
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees", "task-cli"))).toBe(false);
    const ticketRef = await new GitClient().run(testFixture.repositoryPath, [
      "show-ref",
      "--verify",
      "refs/heads/ticket/task-cli",
    ]);
    expect(ticketRef.exitCode).not.toBe(0);

    const journal = new SqliteEventJournal(testFixture.databasePath);
    const stored = journal.readStream("task-cli");
    journal.close();
    const traceLines = readFileSync(tracePath, "utf8").trimEnd().split("\n");
    const traceEvents = traceLines.map((line) => JSON.parse(line) as {
      event_id: string;
      kind: string;
      sequence: number;
      actor: { id: string; role: string };
    });
    expect(traceEvents.map((event) => event.event_id)).toEqual(stored.map((event) => event.eventId));
    expect(traceEvents.map((event) => event.kind)).toEqual(stored.map((event) => event.type));
    expect(traceEvents.map((event) => event.sequence)).toEqual(stored.map((event) => event.globalPosition));
    expect(traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "task.started",
        actor: { id: "zentra-deterministic-worker", role: "worker" },
      }),
      expect.objectContaining({
        kind: "task.validation_started",
        actor: { id: "zentra-validator", role: "validator" },
      }),
      expect.objectContaining({
        kind: "task.review_requested",
        actor: { id: "zentra-deterministic-reviewer", role: "reviewer" },
      }),
      expect.objectContaining({
        kind: "task.integration_started",
        actor: { id: "zentra-integration-controller", role: "integrator" },
      }),
      expect.objectContaining({
        kind: "task.completed",
        actor: { id: "zentra-orchestrator", role: "orchestrator" },
      }),
    ]));
    expect(traceEvents.some((event) => event.kind === "artifact.ready")).toBe(false);
    expect(traceEvents.at(-1)?.kind).toBe("task.completed");

    const status = await invoke([
      "task", "status",
      "--database", testFixture.databasePath,
      "--task-id", "task-cli",
    ]);
    expect(status.code).toBe(0);
    expect(status.json).toEqual({ command: "task.status", task: run.json.task });
  });

  it("uses the internally selected reviewer without caller configuration", async () => {
    const testFixture = await fixture();

    const result = await invoke(runArguments(testFixture, "task-internal-reviewer"));

    expect(result).toMatchObject({
      code: 0,
      stderr: "",
      json: {
        command: "task.run",
        outcome: "completed",
        task: {
          taskId: "task-internal-reviewer",
          lifecycle: "terminal",
          terminalOutcome: "completed",
        },
      },
    });
  });

  it("reports durable capability attention status without inventing a terminal outcome", async () => {
    const testFixture = await fixture();
    const journal = new SqliteEventJournal(testFixture.databasePath);
    const tasks = new TaskService(journal);
    tasks.create({ taskId: "task-capability-attention", projectId: "fixture-project", title: "Pause safely", correlationId: "trace-capability" });
    const binding = buildRoleCapabilityBinding({
      milestoneId: "milestone-capability-attention", taskId: "task-capability-attention", projectId: "fixture-project", correlationId: "trace-capability",
      role: "implementer", actorId: "writer", repository: testFixture.repositoryPath,
      planDigest: "a".repeat(64), securityDigest: "b".repeat(64), admissionDigest: "c".repeat(64),
      model: { capabilityId: "writer", transportModelId: "provider/model", digest: "d".repeat(64), harness: "opencode", roles: ["implementer"], toolPermissions: roleToolPermissions("implementer"), network: "denied" },
      budget: { maxSeconds: 10 }, configuredReadPaths: ["**"], ownedPaths: ["auth.ts"], forbiddenPaths: [".env"],
    });
    const policy = new RoleCapabilityEnvelopeService(journal);
    policy.accept(binding);
    const decision = policy.evaluate(binding, { kind: "external_effect" });
    const occurrence = createCapabilityBoundaryOccurrence({ binding, decision,
      evaluationEvent: policy.evaluationEvent(binding, decision.decisionId), phase: "pre_effect",
      taskHead: capabilityTaskHead(tasks.readStream(binding.taskId)) });
    const source = journal.append(binding.milestoneId, 0, [
      { streamId: binding.milestoneId, type: "milestone.created", payload: { projectId: binding.projectId, title: "Capability authority" }, causationId: null, correlationId: binding.correlationId },
      { streamId: binding.milestoneId, type: "milestone.capability_boundary_paused", payload: { occurrence, evidence: null }, causationId: null, correlationId: binding.correlationId },
    ])[1]!;
    tasks.pauseForCapabilityBoundary(binding.taskId, { occurrence, evidence: null }, source.eventId);
    journal.close();

    const status = await invoke(["task", "status", "--database", testFixture.databasePath, "--task-id", binding.taskId]);
    expect(status).toMatchObject({ code: 0, json: { command: "task.status", task: {
      paused: true, terminalOutcome: null,
      capabilityBoundary: { status: "attention", reason: "forbidden_effect", phase: "pre_effect" },
    } } });
    expect(JSON.stringify(status.json)).not.toContain('"terminalOutcome":"denied"');
  });

  it("denies an adversarial diff that passes focused validation without committing it", async () => {
    const testFixture = await fixture();
    const initialHead = await gitOk(testFixture.repositoryPath, ["rev-parse", "HEAD"]);
    const tracePath = path.join(testFixture.baseDirectory, "denied.jsonl");
    const args = [
      ...runArguments(testFixture, "task-dangerous-review"),
      "--file", "auth.ts",
      "--content", "export const requireAuthentication = false;\n",
      "--agent-tail-jsonl", tracePath,
    ];

    const result = await invoke(args);

    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      json: {
        command: "task.run",
        outcome: "denied",
        task: { terminalOutcome: "denied" },
      },
    });
    expect(await gitOk(testFixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(await gitOk(testFixture.repositoryPath, ["show", "zentra/integration:auth.ts"]))
      .toBe("export const requireAuthentication = true;");
    const traceEvents = readFileSync(tracePath, "utf8").trimEnd().split("\n")
      .map((line) => JSON.parse(line) as { kind: string; operation: { status: string } });
    expect(traceEvents.at(-1)).toMatchObject({ kind: "task.denied", operation: { status: "denied" } });
  });

  it("pauses before integration when review policy security scope does not allow the touched file", async () => {
    const testFixture = await fixture();
    const securitySheetPath = path.join(testFixture.baseDirectory, "SECURITY-SHEET.md");
    writeFileSync(securitySheetPath, `# Zentra Security Sheet

## Allowed Repositories
- ${realpathSync.native(testFixture.repositoryPath)}

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
- forbidden_file_scope
`, "utf8");

    const result = await invoke([
      ...runArguments(testFixture, "task-review-policy-blocked"),
      "--security-sheet", securitySheetPath,
    ]);

    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      json: {
        command: "task.run",
        outcome: null,
        task: { lifecycle: "integration_ready", terminalOutcome: null },
      },
    });
    expect(eventTypes(testFixture.databasePath, "task-review-policy-blocked")).toContain(
      "task.review_policy_blocked",
    );
    const recovery = await invoke([
      "recover",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--task-id", "task-review-policy-blocked",
    ]);
    expect(recovery).toMatchObject({
      code: 0,
      json: { command: "recover", decision: { action: "await_reconciliation" } },
    });
    expect(await gitOk(testFixture.repositoryPath, ["show", "zentra/integration:greeting.txt"]))
      .toBe("hello");

    const wrongRepositorySheet = path.join(testFixture.baseDirectory, "WRONG-SECURITY-SHEET.md");
    writeFileSync(wrongRepositorySheet, readFileSync(securitySheetPath, "utf8").replace(
      realpathSync.native(testFixture.repositoryPath),
      realpathSync.native(testFixture.baseDirectory),
    ), "utf8");
    const wrongRepository = await invoke([
      ...runArguments(testFixture, "task-review-policy-wrong-repo"),
      "--security-sheet", wrongRepositorySheet,
    ]);
    expect(wrongRepository).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "task.run", error: { code: "INVALID_SECURITY_SHEET" } },
    });
    expect(eventTypes(testFixture.databasePath, "task-review-policy-wrong-repo")).toEqual([]);
  });

  it("pauses before integration when task risk requires stronger review evidence", async () => {
    const testFixture = await fixture();

    const result = await invoke([
      ...runArguments(testFixture, "task-review-policy-high-risk"),
      "--risk-level", "high",
    ]);

    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      json: {
        command: "task.run",
        outcome: null,
        task: { lifecycle: "integration_ready", terminalOutcome: null },
      },
    });
    expect(eventTypes(testFixture.databasePath, "task-review-policy-high-risk")).toContain(
      "task.review_policy_blocked",
    );
    expect(await gitOk(testFixture.repositoryPath, ["show", "zentra/integration:greeting.txt"]))
      .toBe("hello");
  });

  it("returns a successful no-op recovery decision for a completed task", async () => {
    const testFixture = await fixture();
    await invoke(runArguments(testFixture, "task-recover"));

    const result = await invoke([
      "recover",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--task-id", "task-recover",
    ]);

    expect(result).toMatchObject({
      code: 0,
      stderr: "",
      json: {
        command: "recover",
        decision: { taskId: "task-recover", action: "await_reconciliation" },
      },
    });
  });

  it("returns nonzero with the canonical failed outcome when validation rejects the change", async () => {
    const testFixture = await fixture();
    const tracePath = path.join(testFixture.baseDirectory, "failed.jsonl");
    const args = [
      ...runArguments(testFixture),
      "--content", "wrong greeting\n",
      "--agent-tail-jsonl", tracePath,
    ];

    const result = await invoke(args);

    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      json: {
        command: "task.run",
        outcome: "failed",
        task: { lifecycle: "terminal", terminalOutcome: "failed" },
      },
    });
    const lastTraceEvent = readFileSync(tracePath, "utf8").trimEnd().split("\n").at(-1);
    expect(JSON.parse(lastTraceEvent!) as unknown).toMatchObject({
      kind: "task.failed",
      operation: { status: "failed" },
    });
  });

  it.each([
    "/absolute.txt",
    "../outside.txt",
    "nested/file.txt",
    "nested\\file.txt",
    ".",
    "..",
    "control\nfile.txt",
  ])("rejects unsafe root-level file %j before a task stream exists", async (file) => {
    const testFixture = await fixture();
    const args = [...runArguments(testFixture), "--file", file];

    const result = await invoke(args);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.json).toMatchObject({ command: "task.run", error: { code: "INVALID_FILE" } });
    if (existsSync(testFixture.databasePath)) {
      const journal = new SqliteEventJournal(testFixture.databasePath);
      expect(journal.readAll()).toEqual([]);
      journal.close();
    }
  });

  it.each(["../outside", "task/child", "task\\child", ".", "..", "bad@{ref", "bad.lock"])(
    "rejects unsafe task id %j before path, ref, or journal effects",
    async (taskId) => {
      const testFixture = await fixture();

      const result = await invoke(runArguments(testFixture, taskId));

      expect(result.code).toBe(1);
      expect(result.json).toMatchObject({ command: "task.run", error: { code: "INVALID_TASK_ID" } });
      expect(existsSync(testFixture.databasePath)).toBe(false);
    },
  );

  it("uses stable nonzero JSON errors for unknown tasks and recovery failures", async () => {
    const testFixture = await fixture();
    new SqliteEventJournal(testFixture.databasePath).close();
    const status = await invoke([
      "task", "status", "--database", testFixture.databasePath, "--task-id", "missing",
    ]);
    expect(status).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "task.status", error: { code: "TASK_NOT_FOUND" } },
    });

    const recovery = await invoke([
      "recover",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--task-id", "missing",
    ]);
    expect(recovery).toMatchObject({
      code: 1,
      stdout: "",
      json: { command: "recover", decision: { action: "record_failure" } },
    });
  });

  it.each(["status", "recover"] as const)(
    "returns DATABASE_NOT_FOUND for %s without creating database sidecars",
    async (command) => {
      const testFixture = await fixture();
      const args = command === "status"
        ? ["task", "status", "--database", testFixture.databasePath, "--task-id", "missing"]
        : [
            "recover",
            "--config", testFixture.configPath,
            "--database", testFixture.databasePath,
            "--task-id", "missing",
          ];

      const result = await invoke(args);

      expect(result).toMatchObject({
        code: 1,
        stdout: "",
        json: {
          command: command === "status" ? "task.status" : "recover",
          error: { code: "DATABASE_NOT_FOUND", message: "Event journal was not found." },
        },
      });
      expect(existsSync(testFixture.databasePath)).toBe(false);
      expect(existsSync(`${testFixture.databasePath}-wal`)).toBe(false);
      expect(existsSync(`${testFixture.databasePath}-shm`)).toBe(false);
    },
  );

  it("keeps an existing journal, schema, and Git refs unchanged during status and recovery", async () => {
    const testFixture = await fixture();
    await invoke(runArguments(testFixture, "task-readonly-cli"));
    const before = {
      databaseSha256: fileSha256(testFixture.databasePath),
      databaseMtimeMs: statSync(testFixture.databasePath).mtimeMs,
      schema: databaseSchema(testFixture.databasePath),
      refs: await gitOk(testFixture.repositoryPath, [
        "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
      ]),
    };

    expect((await invoke([
      "task", "status",
      "--database", testFixture.databasePath,
      "--task-id", "task-readonly-cli",
    ])).code).toBe(0);
    expect((await invoke([
      "recover",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--task-id", "task-readonly-cli",
    ])).code).toBe(0);

    expect(fileSha256(testFixture.databasePath)).toBe(before.databaseSha256);
    expect(statSync(testFixture.databasePath).mtimeMs).toBe(before.databaseMtimeMs);
    expect(databaseSchema(testFixture.databasePath)).toEqual(before.schema);
    expect(await gitOk(testFixture.repositoryPath, [
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
    ])).toBe(before.refs);
  });

  it("does not leak inherited secrets or stack traces in configuration errors", async () => {
    const testFixture = await fixture();
    const secret = "CLI_SUPER_SECRET_VALUE";
    process.env.ZENTRA_TEST_SECRET = secret;
    writeFileSync(testFixture.configPath, "{ invalid", "utf8");
    try {
      const result = await invoke(["project", "validate", "--config", testFixture.configPath]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.json).toMatchObject({ command: "project.validate", error: { code: "INVALID_CONFIG" } });
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(" at ");
    } finally {
      delete process.env.ZENTRA_TEST_SECRET;
    }
  });

  it("does not reflect attacker-controlled config paths or Commander arguments", async () => {
    const testFixture = await fixture();
    const markedConfig = path.join(testFixture.baseDirectory, `${ATTACKER_MARKER}.json`);
    writeFileSync(markedConfig, "{ invalid", "utf8");

    const config = await invoke(["project", "validate", "--config", markedConfig]);
    const commander = await invoke(["task", "status", `--${ATTACKER_MARKER}`]);

    expect(config.code).toBe(1);
    expect(config.stderr).not.toContain(ATTACKER_MARKER);
    expect(config.json).toMatchObject({
      error: { code: "INVALID_CONFIG", message: "Project configuration is invalid." },
    });
    expect(commander.code).toBe(1);
    expect(commander.stderr).not.toContain(ATTACKER_MARKER);
    expect(commander.json).toMatchObject({
      error: { code: "INVALID_COMMAND", message: "Invalid command arguments." },
    });
  });

  it("maps malformed attacker-controlled journal data to one generic bounded error", async () => {
    const testFixture = await fixture();
    const journal = new SqliteEventJournal(testFixture.databasePath);
    const tasks = new TaskService(journal);
    tasks.create({
      taskId: "task-malformed-public",
      projectId: "cli-project",
      title: "Malformed",
      correlationId: "task-malformed-public",
    });
    tasks.append("task-malformed-public", "task.failed", { reason: "failed" }, null);
    journal.close();
    const database = new Database(testFixture.databasePath);
    database.prepare(
      "UPDATE events SET type = ? WHERE stream_id = ? AND stream_version = 2",
    ).run(
      ATTACKER_MARKER,
      "task-malformed-public",
    );
    database.close();

    const result = await invoke([
      "task", "status",
      "--database", testFixture.databasePath,
      "--task-id", "task-malformed-public",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain(ATTACKER_MARKER);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(512);
    expect(result.json).toEqual({
      command: "task.status",
      error: { code: "OPERATION_FAILED", message: "Operation failed." },
    });
  });

  it("omits attacker-controlled recovery and Git failure reasons from public JSON", async () => {
    const testFixture = await fixture();
    const journal = new SqliteEventJournal(testFixture.databasePath);
    new TaskService(journal).create({
      taskId: "task-recovery-public",
      projectId: "cli-project",
      title: "Recovery",
      correlationId: "task-recovery-public",
    });
    journal.close();
    const markedRepository = path.join(testFixture.baseDirectory, ATTACKER_MARKER);
    writeFileSync(testFixture.configPath, `${JSON.stringify({
      projectId: "cli-project",
      repositoryPath: markedRepository,
      integrationBranch: "zentra/integration",
      worktreeRoot: path.join(testFixture.baseDirectory, "worktrees"),
      validations: {
        focused: [process.execPath, "--version"],
        full: [process.execPath, "--version"],
      },
    })}\n`, "utf8");

    const result = await invoke([
      "recover",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--task-id", "task-recovery-public",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain(ATTACKER_MARKER);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(512);
    expect(result.json).toEqual({
      command: "recover",
      decision: {
        taskId: "task-recovery-public",
        action: "record_failure",
        message: "Recovery found invalid durable state.",
      },
    });
  });

  it("replaces oversized project validation output with one fixed bounded error", async () => {
    const testFixture = await fixture();
    const projects = Array.from({ length: 200 }, (_, index) => ({
      projectId: `project-${index}-${"x".repeat(100)}`,
      repositoryPath: testFixture.repositoryPath,
      integrationBranch: "zentra/integration",
      worktreeRoot: path.join(testFixture.baseDirectory, "worktrees"),
      validations: {
        focused: [process.execPath, "--version"],
        full: [process.execPath, "--version"],
      },
    }));
    writeFileSync(testFixture.configPath, JSON.stringify(projects), "utf8");

    const result = await invoke(["project", "validate", "--config", testFixture.configPath]);

    expect(result.code).toBe(1);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(512);
    expect(result.json).toEqual({
      command: "project.validate",
      error: { code: "OUTPUT_TOO_LARGE", message: "Operational output exceeded the limit." },
    });
  });

  it("replaces oversized persisted task status with one fixed bounded error", async () => {
    const testFixture = await fixture();
    const journal = new SqliteEventJournal(testFixture.databasePath);
    new TaskService(journal).create({
      taskId: "task-oversized-status",
      projectId: "cli-project",
      title: "x".repeat(20_000),
      correlationId: "task-oversized-status",
    });
    journal.close();

    const result = await invoke([
      "task", "status",
      "--database", testFixture.databasePath,
      "--task-id", "task-oversized-status",
    ]);

    expect(result.code).toBe(1);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(512);
    expect(result.json).toEqual({
      command: "task.status",
      error: { code: "OUTPUT_TOO_LARGE", message: "Operational output exceeded the limit." },
    });
  });

  it("rejects an oversized project identity before journal, worktree, ref, or integration effects", async () => {
    const testFixture = await fixture();
    const config = JSON.parse(readFileSync(testFixture.configPath, "utf8")) as Record<string, unknown>;
    config.projectId = "p".repeat(129);
    writeFileSync(testFixture.configPath, JSON.stringify(config), "utf8");
    const refsBefore = await gitOk(testFixture.repositoryPath, [
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
    ]);

    const result = await invoke(runArguments(testFixture, "task-oversized-run"));

    expect(result.code).toBe(1);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(512);
    expect(result.json).toEqual({
      command: "task.run",
      error: { code: "INVALID_CONFIG", message: "Project configuration is invalid." },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
    expect(await gitOk(testFixture.repositoryPath, [
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
    ])).toBe(refsBefore);
  });

  it.each([
    ["focusedTimeoutMs", 0],
    ["fullTimeoutMs", 1_800_001],
    ["focusedTimeoutMs", 100.5],
    ["fullTimeoutMs", "5000"],
  ] as const)(
    "rejects invalid %s configuration before journal, worktree, ref, or integration effects",
    async (field, value) => {
      const testFixture = await fixture();
      const config = JSON.parse(readFileSync(testFixture.configPath, "utf8")) as {
        validations: Record<string, unknown>;
      };
      config.validations[field] = value;
      writeFileSync(testFixture.configPath, JSON.stringify(config), "utf8");
      const refsBefore = await gitOk(testFixture.repositoryPath, [
        "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
      ]);

      const result = await invoke(runArguments(testFixture, `task-invalid-${field}`));

      expect(result).toMatchObject({
        code: 1,
        json: {
          command: "task.run",
          error: { code: "INVALID_CONFIG" },
        },
      });
      expect(existsSync(testFixture.databasePath)).toBe(false);
      expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
      expect(await gitOk(testFixture.repositoryPath, [
        "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
      ])).toBe(refsBefore);
    },
  );

  it("rejects multiple task-run projects before journal, worktree, or ref effects", async () => {
    const testFixture = await fixture();
    const config = JSON.parse(readFileSync(testFixture.configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(testFixture.configPath, JSON.stringify([
      config,
      { ...config, projectId: "second-project" },
    ]), "utf8");
    const refsBefore = await gitOk(testFixture.repositoryPath, [
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
    ]);

    const result = await invoke(runArguments(testFixture, "task-multiple-projects"));

    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ error: { code: "INVALID_CONFIG" } });
    expect(existsSync(testFixture.databasePath)).toBe(false);
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
    expect(await gitOk(testFixture.repositoryPath, [
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
    ])).toBe(refsBefore);
  });

  it("rejects oversized content before journal, worktree, or ref effects", async () => {
    const testFixture = await fixture();
    const refsBefore = await gitOk(testFixture.repositoryPath, [
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
    ]);

    const result = await invoke([
      ...runArguments(testFixture, "task-oversized-content"),
      "--content", "c".repeat(1_048_577),
    ]);

    expect(result.code).toBe(1);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(512);
    expect(result.json).toEqual({
      command: "task.run",
      error: { code: "INVALID_CONTENT", message: "Task content is too large." },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
    expect(await gitOk(testFixture.repositoryPath, [
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
    ])).toBe(refsBefore);
  });

  it("reserves artifact capacity for Git diff framing before creating effects", async () => {
    const testFixture = await fixture();

    const result = await invoke([
      ...runArguments(testFixture, "task-unframed-content"),
      "--content", "c".repeat(1_048_576),
    ]);

    expect(result.code).toBe(1);
    expect(result.json).toEqual({
      command: "task.run",
      error: { code: "INVALID_CONTENT", message: "Task content is too large." },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
  });

  it("rejects an oversized config file before reading it or creating effects", async () => {
    const testFixture = await fixture();
    writeFileSync(testFixture.configPath, "x".repeat(1_048_577), "utf8");
    const refsBefore = await gitOk(testFixture.repositoryPath, [
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
    ]);

    const result = await invoke(runArguments(testFixture, "task-oversized-config"));

    expect(result.code).toBe(1);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(512);
    expect(result.json).toEqual({
      command: "task.run",
      error: { code: "INVALID_CONFIG", message: "Project configuration is invalid." },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
    expect(await gitOk(testFixture.repositoryPath, [
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
    ])).toBe(refsBefore);
  });

  it("rejects an unsafe integration branch as a generic config error", async () => {
    const testFixture = await fixture();
    const config = JSON.parse(readFileSync(testFixture.configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      testFixture.configPath,
      JSON.stringify({ ...config, integrationBranch: "-unsafe..branch.lock" }),
      "utf8",
    );

    const result = await invoke(["project", "validate", "--config", testFixture.configPath]);

    expect(result).toEqual(expect.objectContaining({
      code: 1,
      stdout: "",
      json: {
        command: "project.validate",
        error: { code: "INVALID_CONFIG", message: "Project configuration is invalid." },
      },
    }));
  });

  it.each(["task.status", "recover"])(
    "fails %s with one bounded generic error before parsing an oversized journal payload",
    async (command) => {
      const testFixture = await fixture();
      const journal = new SqliteEventJournal(testFixture.databasePath);
      new TaskService(journal).create({
        taskId: "task-hostile-journal",
        projectId: "cli-project",
        title: "Hostile journal",
        correlationId: "task-hostile-journal",
      });
      journal.close();
      const database = new Database(testFixture.databasePath);
      database.prepare("UPDATE events SET payload = ? WHERE stream_id = ?").run(
        JSON.stringify(ATTACKER_MARKER.repeat(400_000)),
        "task-hostile-journal",
      );
      database.close();

      const args = command === "task.status"
        ? ["task", "status", "--database", testFixture.databasePath, "--task-id", "task-hostile-journal"]
        : [
            "recover",
            "--config",
            testFixture.configPath,
            "--database",
            testFixture.databasePath,
            "--task-id",
            "task-hostile-journal",
          ];
      const result = await invoke(args);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(ATTACKER_MARKER);
      expect(Buffer.byteLength(result.stderr)).toBeLessThan(512);
      expect(result.json).toEqual(command === "task.status"
        ? {
            command,
            error: { code: "OPERATION_FAILED", message: "Operation failed." },
          }
        : {
            command,
            decision: {
              taskId: "task-hostile-journal",
              action: "record_failure",
              message: "Recovery found invalid durable state.",
            },
          });
    },
  );

  it("bounds and sanitizes an oversized attacker-controlled recovery reason", async () => {
    const testFixture = await fixture();
    const journal = new SqliteEventJournal(testFixture.databasePath);
    const tasks = new TaskService(journal);
    tasks.create({
      taskId: "task-oversized-reason",
      projectId: "cli-project",
      title: "Recovery",
      correlationId: "task-oversized-reason",
    });
    journal.append("task-oversized-reason", 1, [{
      streamId: "task-oversized-reason",
      type: ATTACKER_MARKER.repeat(1_000),
      payload: {},
      causationId: null,
      correlationId: "task-oversized-reason",
    }]);
    journal.close();

    const result = await invoke([
      "recover",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--task-id", "task-oversized-reason",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain(ATTACKER_MARKER);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(512);
    expect(result.json).toEqual({
      command: "recover",
      decision: {
        taskId: "task-oversized-reason",
        action: "record_failure",
        message: "Recovery found invalid durable state.",
      },
    });
  });

  it.each([
    ["task id", "--task-id", "a".repeat(129), "INVALID_TASK_ID"],
    ["title", "--title", "t".repeat(513), "INVALID_TITLE"],
    ["file", "--file", "f".repeat(256), "INVALID_FILE"],
  ] as const)("rejects an oversized %s before journal or worktree effects", async (
    _name,
    option,
    value,
    code,
  ) => {
    const testFixture = await fixture();

    const result = await invoke([...runArguments(testFixture), option, value]);

    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ error: { code } });
    expect(existsSync(testFixture.databasePath)).toBe(false);
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
  });

  it.each(["--executable", "--command", "--cwd", "--workspace", "--reviewer"])(
    "does not expose caller-controlled runtime authority through %s",
    async (option) => {
      const testFixture = await fixture();

      const result = await invoke([...runArguments(testFixture), option, "/tmp/untrusted"]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.json).toMatchObject({ command: "task.run", error: { code: "INVALID_COMMAND" } });
      expect(existsSync(testFixture.databasePath)).toBe(false);
    },
  );

  it("rejects caller-selected reviewer executable authority before creating effects", async () => {
    const testFixture = await fixture();

    const result = await invoke([
      ...runArguments(testFixture, "task-caller-reviewer"),
      "--reviewer-executable", process.execPath,
      "--reviewer-argument", CONTENT_AWARE_REVIEWER,
      "--reviewer-id", "caller-reviewer",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.json).toMatchObject({
      command: "task.run",
      error: { code: "INVALID_COMMAND" },
    });
    expect(existsSync(testFixture.databasePath)).toBe(false);
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
  });

  // This signal lands in the pre-effect integration-branch read. A bounded
  // read cancellation is known and must not be mislabeled as an uncertain write.
  it("records known pre-effect SIGINT cancellation", async () => {
    const testFixture = await fixture();
    const signals = new EventEmitter();
    const tracePath = path.join(testFixture.baseDirectory, "uncertain.jsonl");
    const pending = invoke([
      ...runArguments(testFixture, "task-signal"),
      "--agent-tail-jsonl", tracePath,
    ], signals);
    setTimeout(() => signals.emit("SIGINT"), 10);

    const result = await pending;

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.json).toMatchObject({
      command: "task.run",
      outcome: "cancelled",
      task: { taskId: "task-signal", terminalOutcome: "cancelled" },
    });
    const traceKinds = readFileSync(tracePath, "utf8").trimEnd().split("\n")
      .map((line) => (JSON.parse(line) as { kind: string }).kind);
    expect(traceKinds[0]).toBe("task.created");
    expect(traceKinds).toContain("task.cancelled");
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("records known pre-effect SIGTERM cancellation", async () => {
    const testFixture = await fixture();
    const signals = new EventEmitter();
    const pending = invoke(runArguments(testFixture, "task-sigterm"), signals);
    setTimeout(() => signals.emit("SIGTERM"), 10);

    const result = await pending;

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.json).toMatchObject({
      command: "task.run",
      outcome: "cancelled",
      task: { taskId: "task-sigterm", terminalOutcome: "cancelled" },
    });
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("replays status without resolving missing bundled fixtures", async () => {
    const testFixture = await fixture();
    await invoke(runArguments(testFixture, "task-status-no-fixtures"));
    const layout = copiedSourceFixtureLayout();
    const invalidAnchor = pathToFileURL(path.join(testFixture.baseDirectory, "wrong-layout.ts"));
    const invalidLayout = await invoke([
      "task", "status",
      "--database", testFixture.databasePath,
      "--task-id", "task-status-no-fixtures",
    ], process, invalidAnchor);
    rmSync(path.dirname(layout.worker), { recursive: true, force: true });

    const result = await invoke([
      "task", "status",
      "--database", testFixture.databasePath,
      "--task-id", "task-status-no-fixtures",
    ], process, layout.anchor);

    expect(invalidLayout.code).toBe(0);
    expect(result).toMatchObject({
      code: 0,
      stderr: "",
      json: {
        command: "task.status",
        task: { taskId: "task-status-no-fixtures", terminalOutcome: "completed" },
      },
    });
  });

  it("inspects recovery without resolving modified bundled fixtures", async () => {
    const testFixture = await fixture();
    await invoke(runArguments(testFixture, "task-recover-modified-fixtures"));
    const layout = copiedSourceFixtureLayout();
    writeFileSync(layout.worker, "modified worker\n", "utf8");
    const invalidAnchor = pathToFileURL(path.join(testFixture.baseDirectory, "wrong-layout.ts"));
    const invalidLayout = await invoke([
      "recover",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--task-id", "task-recover-modified-fixtures",
    ], process, invalidAnchor);

    const result = await invoke([
      "recover",
      "--config", testFixture.configPath,
      "--database", testFixture.databasePath,
      "--task-id", "task-recover-modified-fixtures",
    ], process, layout.anchor);

    expect(invalidLayout.code).toBe(0);
    expect(result).toMatchObject({
      code: 0,
      stderr: "",
      json: {
        command: "recover",
        decision: { taskId: "task-recover-modified-fixtures", action: "await_reconciliation" },
      },
    });
  });

  it.each(["invalid layout", "missing worker", "modified worker"] as const)(
    "rejects %s before the task journal, reviewer adapter, or worktree is reached",
    async (failure) => {
      const testFixture = await fixture();
      const layout = copiedSourceFixtureLayout();
      let anchor = layout.anchor;
      if (failure === "invalid layout") {
        anchor = pathToFileURL(path.join(path.dirname(layout.worker), "bundled-fixtures.ts"));
      } else if (failure === "missing worker") {
        rmSync(layout.worker);
      } else {
        writeFileSync(layout.worker, "process.exit(0);\n", "utf8");
      }

      const result = await invoke(
        runArguments(testFixture, `task-fixture-${failure.replace(" ", "-")}`),
        process,
        anchor,
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.json).toMatchObject({
        command: "task.run",
        error: { code: "BUNDLED_FIXTURE_INVALID" },
      });
      expect(existsSync(testFixture.databasePath)).toBe(false);
      expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
    },
  );
});

describe("built CLI help", () => {
  beforeAll(async () => {
    await execFileAsync("pnpm", ["build"], { cwd: path.resolve(import.meta.dirname, "../..") });
  }, 30_000);

  it("lists project, task, and recover from the built entry point", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const result = await execFileAsync(process.execPath, ["dist/src/cli/main.js", "--help"], { cwd: root });
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/\bproject\b/);
    expect(result.stdout).toMatch(/\btask\b/);
    expect(result.stdout).toMatch(/\brecover\b/);
    expect(result.stdout).toContain("bounded local software-development workflows");
    const milestone = await execFileAsync(process.execPath, ["dist/src/cli/main.js", "milestone", "--help"], { cwd: root });
    expect(milestone.stderr).toBe("");
    expect(milestone.stdout).toMatch(/\brun\b/);
    expect(milestone.stdout).toContain("installed OpenCode workflows");
    const milestoneRun = await execFileAsync(
      process.execPath,
      ["dist/src/cli/main.js", "milestone", "run", "--help"],
      { cwd: root },
    );
    expect(milestoneRun.stderr).toBe("");
    expect(milestoneRun.stdout).toContain("authenticated host OpenCode writer");
    expect(milestoneRun.stdout).toMatch(/user-OS provider transport and\s+brokered review/);
    expect(milestoneRun.stdout).toMatch(/provider\s+transport uses user OS network authority/);
  });

  it("supports the documented pnpm start help invocation", async () => {
    const root = path.resolve(import.meta.dirname, "../..");

    const result = await execFileAsync("pnpm", ["start", "--", "--help"], { cwd: root });

    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/\bproject\b/);
    expect(result.stdout).toMatch(/\btask\b/);
    expect(result.stdout).toMatch(/\brecover\b/);
  });

  it("runs the bundled worker and internally fixed reviewer through the built entry point", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const testFixture = await fixture();

    const result = await execFileAsync(
      process.execPath,
      ["dist/src/cli/main.js", ...runArguments(testFixture, "task-built")],
      { cwd: root },
    );

    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "task.run",
      outcome: "completed",
      task: { taskId: "task-built", terminalOutcome: "completed" },
    });
  });

  it("does not wire the deterministic test reviewer into the built production CLI", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const builtCli = readFileSync(path.join(root, "dist", "src", "cli", "main.js"), "utf8");

    expect(builtCli).not.toContain("deterministic-reviewer.mjs");
    expect(builtCli).not.toContain("DeterministicReviewerAdapter");
  });

  it("executes help through a real symlink to the built entry point", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-cli-link-")));
    temporaryDirectories.push(directory);
    const linkedEntry = path.join(directory, "zentra-linked.mjs");
    symlinkSync(path.join(root, "dist", "src", "cli", "main.js"), linkedEntry);

    const result = await execFileAsync(process.execPath, [linkedEntry, "--help"], { cwd: root });

    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/\bproject\b/);
    expect(result.stdout).toMatch(/\btask\b/);
    expect(result.stdout).toMatch(/\brecover\b/);
  });
});
