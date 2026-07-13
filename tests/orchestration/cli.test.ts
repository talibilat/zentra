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
import { TaskService } from "../../src/tasks/task-service.js";
import { GitClient } from "../../src/workspaces/git-client.js";

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
  return { baseDirectory, repositoryPath, configPath, databasePath };
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
  configureReviewer = true,
): readonly string[] {
  const args = [
    "task", "run",
    "--config", testFixture.configPath,
    "--database", testFixture.databasePath,
    "--task-id", taskId,
    "--title", "Update greeting",
    "--file", "greeting.txt",
    "--content", "hello from CLI\n",
  ];
  if (configureReviewer) {
    args.push(
      "--reviewer-executable", process.execPath,
      "--reviewer-argument", CONTENT_AWARE_REVIEWER,
      "--reviewer-id", "content-reviewer-1",
    );
  }
  return args;
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

  it("runs the complete tracer bullet in a real repository and replays exact status", async () => {
    const testFixture = await fixture();

    const run = await invoke(runArguments(testFixture));
    expect(run).toMatchObject({
      code: 0,
      stderr: "",
      json: {
        command: "task.run",
        outcome: "completed",
        task: {
          taskId: "task-cli",
          projectId: "cli-project",
          lifecycle: "terminal",
          terminalOutcome: "completed",
        },
      },
    });
    expect(await gitOk(testFixture.repositoryPath, ["show", "zentra/integration:greeting.txt"]))
      .toBe("hello from CLI");
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees", "task-cli"))).toBe(false);
    const ticketRef = await new GitClient().run(testFixture.repositoryPath, [
      "show-ref",
      "--verify",
      "refs/heads/ticket/task-cli",
    ]);
    expect(ticketRef.exitCode).not.toBe(0);

    const status = await invoke([
      "task", "status",
      "--database", testFixture.databasePath,
      "--task-id", "task-cli",
    ]);
    expect(status.code).toBe(0);
    expect(status.json).toEqual({ command: "task.status", task: run.json.task });
  });

  it("denies by default without reviewer configuration before commit or integration", async () => {
    const testFixture = await fixture();
    const initialHead = await gitOk(testFixture.repositoryPath, ["rev-parse", "HEAD"]);

    const result = await invoke(runArguments(testFixture, "task-no-reviewer", false));

    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      json: {
        command: "task.run",
        outcome: "denied",
        task: {
          taskId: "task-no-reviewer",
          lifecycle: "terminal",
          terminalOutcome: "denied",
        },
      },
    });
    expect(await gitOk(testFixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect((await new GitClient().run(testFixture.repositoryPath, [
      "show-ref",
      "--verify",
      "refs/heads/zentra/integration",
    ])).exitCode).not.toBe(0);
    expect(existsSync(path.join(testFixture.baseDirectory, "worktrees"))).toBe(false);
  });

  it("denies an adversarial diff that passes focused validation without committing it", async () => {
    const testFixture = await fixture();
    const initialHead = await gitOk(testFixture.repositoryPath, ["rev-parse", "HEAD"]);
    const args = [
      ...runArguments(testFixture, "task-dangerous-review"),
      "--file", "auth.ts",
      "--content", "export const requireAuthentication = false;\n",
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
    const args = [...runArguments(testFixture), "--content", "wrong greeting\n"];

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

  it("maps SIGINT to one cancelled object with a nonzero exit", async () => {
    const testFixture = await fixture();
    const signals = new EventEmitter();
    const pending = invoke(runArguments(testFixture, "task-signal"), signals);
    setTimeout(() => signals.emit("SIGINT"), 10);

    const result = await pending;

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.json).toMatchObject({
      command: "task.run",
      outcome: "cancelled",
      task: { taskId: "task-signal", terminalOutcome: "cancelled" },
    });
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("maps SIGTERM to one cancelled object with a nonzero exit", async () => {
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
  });

  it("supports the documented pnpm start help invocation", async () => {
    const root = path.resolve(import.meta.dirname, "../..");

    const result = await execFileAsync("pnpm", ["start", "--", "--help"], { cwd: root });

    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/\bproject\b/);
    expect(result.stdout).toMatch(/\btask\b/);
    expect(result.stdout).toMatch(/\brecover\b/);
  });

  it("runs the bundled worker and configured content-aware reviewer through the built entry point", async () => {
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
