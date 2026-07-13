import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ValidationRunner,
  ValidationReportSchema,
  isVerifiedValidationReport,
} from "../../src/capabilities/validation-runner.js";
import {
  DEFAULT_FOCUSED_VALIDATION_TIMEOUT_MS,
  DEFAULT_FULL_VALIDATION_TIMEOUT_MS,
  MAX_VALIDATION_TIMEOUT_MS,
  MIN_VALIDATION_TIMEOUT_MS,
  ProjectConfigSchema,
  type ProjectConfig,
} from "../../src/projects/project-config.js";
import { canonicalValidationDigest } from "../../src/reviews/reviewer-adapter.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import type { WorkerRequest, WorkerResult } from "../../src/workers/worker-adapter.js";

const cleanup: string[] = [];

afterEach(async () => {
  delete process.env["ZENTRA_VALIDATION_SECRET"];
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "zentra-validation-"));
  cleanup.push(directory);
  return directory;
}

function project(
  command: readonly [string, ...string[]],
  timeouts: {
    readonly focusedTimeoutMs?: number;
    readonly fullTimeoutMs?: number;
  } = {},
): ProjectConfig {
  return {
    projectId: "test",
    repositoryPath: "/repo",
    integrationBranch: "zentra/integration",
    worktreeRoot: "/worktrees",
    validations: {
      focused: [...command] as [string, ...string[]],
      full: [process.execPath, "-e", "process.exit(0)"],
      focusedTimeoutMs: timeouts.focusedTimeoutMs ?? 5_000,
      fullTimeoutMs: timeouts.fullTimeoutMs ?? 5_000,
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function waitForPid(pidFile: string): Promise<number> {
  const deadline = process.hrtime.bigint() + 2_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    try {
      return Number(await readFile(pidFile, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("timed out waiting for validation descendant pid");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function withDotSegment(executable: string): string {
  const directory = path.dirname(executable);
  return `${directory}${path.sep}.${path.sep}${path.basename(executable)}`;
}

function withCaseVariant(executable: string): string {
  return executable.replace(/[A-Za-z]/, (character) =>
    character === character.toLowerCase()
      ? character.toUpperCase()
      : character.toLowerCase(),
  );
}

async function withTemporaryApprovedExecutable(
  test: (approvedExecutable: string, replacement: string) => Promise<void>,
): Promise<void> {
  const directory = await workspace();
  const approvedExecutable = path.join(directory, "approved-node");
  const replacement = path.join(directory, "replacement-node");
  await writeFile(approvedExecutable, "approved", { mode: 0o755 });
  await writeFile(replacement, "replaced", { mode: 0o755 });
  const canonicalApprovedExecutable = await realpath(approvedExecutable);
  const originalExecPath = process.execPath;

  try {
    process.execPath = canonicalApprovedExecutable;
    vi.resetModules();
    await test(canonicalApprovedExecutable, replacement);
  } finally {
    process.execPath = originalExecPath;
    vi.resetModules();
  }
}

class CountingSupervisor extends ProcessSupervisor {
  readonly requests: WorkerRequest[] = [];

  override execute(request: WorkerRequest, _signal: AbortSignal): Promise<WorkerResult> {
    this.requests.push(request);
    return Promise.resolve({
      outcome: "completed",
      exitCode: 0,
      events: [],
      stdout: "",
      rawStdout: "",
      stderr: "",
    });
  }
}

describe("ValidationRunner", () => {
  it("rejects unintended executable identities before process creation", async () => {
    const cwd = await workspace();
    const executableLink = path.join(cwd, "node-link");
    await symlink(process.execPath, executableLink);
    const deniedCommands = [
      ["/bin/echo", "unapproved"],
      ["node", "--version"],
      [withDotSegment(process.execPath), "--version"],
      [`${process.execPath}${path.sep}`, "--version"],
      [withCaseVariant(process.execPath), "--version"],
      [executableLink, "--version"],
      ["/usr/bin/env", process.execPath, "--version"],
    ] as const;

    for (const command of deniedCommands) {
      const supervisor = new CountingSupervisor();
      await expect(
        new ValidationRunner(supervisor).run(
          project(command),
          "focused",
          cwd,
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toThrow(/approved canonical absolute path/);
      expect(supervisor.requests).toHaveLength(0);
    }
  });

  it("rejects an approved executable replaced at the same pathname", async () => {
    await withTemporaryApprovedExecutable(async (approvedExecutable) => {
      const { ValidationRunner: IsolatedValidationRunner } = await import(
        "../../src/capabilities/validation-runner.js"
      );
      const cwd = await workspace();
      const supervisor = new CountingSupervisor();
      await writeFile(approvedExecutable, "replaced", { mode: 0o755 });

      await expect(
        new IsolatedValidationRunner(supervisor).run(
          project([approvedExecutable, "--version"]),
          "focused",
          cwd,
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toThrow(/identity changed/);
      expect(supervisor.requests).toHaveLength(0);
    });
  });

  it("performs best-effort pre-spawn re-verification before supervisor dispatch", async () => {
    await withTemporaryApprovedExecutable(async (approvedExecutable, replacement) => {
      const { ValidationRunner: IsolatedValidationRunner } = await import(
        "../../src/capabilities/validation-runner.js"
      );
      const cwd = await workspace();
      const supervisor = new CountingSupervisor();
      const pending = new IsolatedValidationRunner(supervisor).run(
        project([approvedExecutable, "--version"]),
        "focused",
        cwd,
        AbortSignal.timeout(5_000),
      );
      renameSync(replacement, approvedExecutable);

      await expect(pending).rejects.toThrow(/identity changed/);
      expect(supervisor.requests).toHaveLength(0);
    });
  });

  it.each(["focused", "full"] as const)(
    "runs approved %s validation through the executable policy",
    async (name) => {
      const cwd = await workspace();
      const supervisor = new CountingSupervisor();
      const configured = project([process.execPath, "--version"]);
      configured.validations.full = [process.execPath, "--version"];

      await expect(
        new ValidationRunner(supervisor).run(
          configured,
          name,
          cwd,
          AbortSignal.timeout(5_000),
        ),
      ).resolves.toMatchObject({ name, outcome: "completed", exitCode: 0 });
      expect(supervisor.requests).toHaveLength(1);
      expect(supervisor.requests[0]?.executable).toBe(process.execPath);
      expect(supervisor.requests[0]?.timeoutMs).toBe(5_000);
    },
  );

  it("applies and reports the distinct schema defaults", async () => {
    const cwd = await workspace();
    const supervisor = new CountingSupervisor();
    const configured = ProjectConfigSchema.parse({
      projectId: "defaults",
      repositoryPath: cwd,
      integrationBranch: "zentra/integration",
      worktreeRoot: cwd,
      validations: {
        focused: [process.execPath, "--version"],
        full: [process.execPath, "--version"],
      },
    });
    const runner = new ValidationRunner(supervisor);

    const focused = await runner.run(configured, "focused", cwd, AbortSignal.timeout(5_000));
    const full = await runner.run(configured, "full", cwd, AbortSignal.timeout(5_000));

    expect(supervisor.requests.map((request) => request.timeoutMs)).toEqual([
      DEFAULT_FOCUSED_VALIDATION_TIMEOUT_MS,
      DEFAULT_FULL_VALIDATION_TIMEOUT_MS,
    ]);
    expect(focused).toMatchObject({
      timeoutMs: DEFAULT_FOCUSED_VALIDATION_TIMEOUT_MS,
      provenance: { timeoutMs: DEFAULT_FOCUSED_VALIDATION_TIMEOUT_MS },
    });
    expect(full).toMatchObject({
      timeoutMs: DEFAULT_FULL_VALIDATION_TIMEOUT_MS,
      provenance: { timeoutMs: DEFAULT_FULL_VALIDATION_TIMEOUT_MS },
    });
  });

  it("reports named command identity, exact argv digest, timing, outcome, and exit code", async () => {
    const cwd = await workspace();
    const command = [process.execPath, "-e", 'process.stdout.write("ok")'] as const;
    const report = await new ValidationRunner(new ProcessSupervisor()).run(
      project(command),
      "focused",
      cwd,
      AbortSignal.timeout(5_000),
    );
    const canonicalCwd = await realpath(cwd);

    expect(report).toMatchObject({
      name: "focused",
      command,
      outcome: "completed",
      exitCode: 0,
      timeoutMs: 5_000,
      provenance: { timeoutMs: 5_000 },
    });
    expect(report.argvSha256).toBe(sha256(JSON.stringify(command)));
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
    expect(isVerifiedValidationReport(report)).toBe(true);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.command)).toBe(true);
    expect(isVerifiedValidationReport({ ...report })).toBe(false);
  });

  it("binds hidden provenance to invocation, canonical cwd, and subject", async () => {
    const cwd = await workspace();
    const command = [process.execPath, "-e", "process.exit(0)"] as const;
    const context = { invocationId: "validation-invocation-1", subjectSha256: "subject-1" };
    const report = await new ValidationRunner(new ProcessSupervisor()).run(
      project(command),
      "focused",
      cwd,
      AbortSignal.timeout(5_000),
      context,
    );
    const canonicalCwd = await realpath(cwd);

    expect(report.provenance).toEqual({ ...context, canonicalCwd, timeoutMs: 5_000 });
    expect(Object.isFrozen(report.provenance)).toBe(true);
    expect(isVerifiedValidationReport(report, {
      ...context,
      canonicalCwd,
    })).toBe(true);
    expect(isVerifiedValidationReport(report, {
      ...context,
      invocationId: "validation-invocation-2",
      canonicalCwd,
    })).toBe(false);
    expect(isVerifiedValidationReport(report, {
      ...context,
      canonicalCwd: `${cwd}-other`,
    })).toBe(false);
    expect(isVerifiedValidationReport(report, {
      ...context,
      subjectSha256: "subject-2",
      canonicalCwd,
    })).toBe(false);
  });

  it("includes durable provenance in the canonical validation digest", async () => {
    const cwd = await workspace();
    const report = await new ValidationRunner(new ProcessSupervisor()).run(
      project([process.execPath, "-e", "process.exit(0)"]),
      "focused",
      cwd,
      AbortSignal.timeout(5_000),
      { invocationId: "digest-provenance", subjectSha256: "subject-1" },
    );

    const digest = canonicalValidationDigest(report);
    expect(canonicalValidationDigest({
      ...report,
      provenance: { ...report.provenance, subjectSha256: "subject-2" },
    })).not.toBe(digest);
    expect(canonicalValidationDigest({
      ...report,
      provenance: { ...report.provenance, timeoutMs: 5_001 },
    })).not.toBe(digest);
  });

  it("brands standalone reports without allowing a fabricated context match", async () => {
    const cwd = await workspace();
    const report = await new ValidationRunner(new ProcessSupervisor()).run(
      project([process.execPath, "-e", "process.exit(0)"]),
      "focused",
      cwd,
      AbortSignal.timeout(5_000),
    );
    const canonicalCwd = await realpath(cwd);

    expect(isVerifiedValidationReport(report)).toBe(true);
    expect(isVerifiedValidationReport(report, {
      invocationId: "unknown",
      canonicalCwd,
      subjectSha256: "unknown",
    })).toBe(false);
  });

  it.each([
    ["completed nonzero", { outcome: "completed", exitCode: 1 }],
    ["failed zero", { outcome: "failed", exitCode: 0 }],
    ["cancelled exit", { outcome: "cancelled", exitCode: 0 }],
    ["timed_out exit", { outcome: "timed_out", exitCode: 1 }],
    ["backwards time", { startedAt: "2026-01-02T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z" }],
  ])("rejects report invariant %s", (_case, change) => {
    expect(() => ValidationReportSchema.parse({
      name: "focused",
      outcome: "completed",
      exitCode: 0,
      stdout: "",
      stderr: "",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      command: [process.execPath],
      argvSha256: "0".repeat(64),
      outputSha256: "1".repeat(64),
      provenance: {
        invocationId: "schema-test",
        canonicalCwd: "/tmp/schema-test",
        subjectSha256: "subject",
        timeoutMs: 5_000,
      },
      timeoutMs: 5_000,
      ...change,
    })).toThrow();
  });

  it("reports the exact command snapshot that was executed", async () => {
    const cwd = await workspace();
    const original = [
      process.execPath,
      "-e",
      'setTimeout(() => process.stdout.write("ok"), 50)',
    ] as const;
    const configured = project(original);
    const pending = new ValidationRunner(new ProcessSupervisor()).run(
      configured,
      "focused",
      cwd,
      AbortSignal.timeout(5_000),
    );
    configured.validations.focused[2] = 'process.stdout.write("mutated")';

    const report = await pending;
    expect(report.command).toEqual(original);
    expect(report.argvSha256).toBe(sha256(JSON.stringify(original)));
  });

  it("passes shell metacharacters as a literal argv value without expansion", async () => {
    const cwd = await workspace();
    const marker = path.join(cwd, "expanded");
    const literal = `$(touch ${marker}) ; echo expanded`;
    const command = [process.execPath, "-e", "process.stdout.write(process.argv[1])", literal] as const;
    const report = await new ValidationRunner(new ProcessSupervisor()).run(
      project(command), "focused", cwd, AbortSignal.timeout(5_000),
    );

    expect(report.stdout).toBe(literal);
    await expect(access(marker)).rejects.toThrow();
  });

  it("does not expose an arbitrary parent secret", async () => {
    const cwd = await workspace();
    process.env["ZENTRA_VALIDATION_SECRET"] = "must-not-leak";
    const command = [
      process.execPath,
      "-e",
      'process.stdout.write(String(process.env.ZENTRA_VALIDATION_SECRET))',
    ] as const;
    const report = await new ValidationRunner(new ProcessSupervisor()).run(
      project(command), "focused", cwd, AbortSignal.timeout(5_000),
    );

    expect(report.stdout).toBe("undefined");
    expect(report.stdout + report.stderr).not.toContain("must-not-leak");
  });

  it("retains and hashes JSON-only stdout as raw validation evidence", async () => {
    const cwd = await workspace();
    const raw = '{"test":"passed"}\n';
    const command = [process.execPath, "-e", `process.stdout.write(${JSON.stringify(raw)})`] as const;
    const report = await new ValidationRunner(new ProcessSupervisor()).run(
      project(command), "focused", cwd, AbortSignal.timeout(5_000),
    );

    expect(report.stdout).toBe(raw);
    expect(report.outputSha256).toBe(sha256(JSON.stringify({ stdout: raw, stderr: "" })));
  });

  it("retains an actual nonzero exit code", async () => {
    const cwd = await workspace();
    const command = [process.execPath, "-e", "process.exit(1)"] as const;
    const report = await new ValidationRunner(new ProcessSupervisor()).run(
      project(command), "focused", cwd, AbortSignal.timeout(5_000),
    );

    expect(report.outcome).toBe("failed");
    expect(report.exitCode).toBe(1);
  });

  it("records output-limit failure with unavailable exit code and bounded evidence", async () => {
    const cwd = await workspace();
    const command = [process.execPath, "-e", 'process.stdout.write("x".repeat(10_000))'] as const;
    const report = await new ValidationRunner(new ProcessSupervisor({ maxOutputBytes: 128 })).run(
      project(command), "focused", cwd, AbortSignal.timeout(5_000),
    );

    expect(report.outcome).toBe("failed");
    expect(report.exitCode).toBeNull();
    expect(report.stderr).toContain("output limit");
    expect(Buffer.byteLength(report.stdout)).toBeLessThanOrEqual(128);
  });

  it.each([
    ["timed_out", undefined],
    ["cancelled", new AbortController()],
  ] as const)("records %s with unavailable exit code", async (outcome, controller) => {
    const cwd = await workspace();
    const command = [process.execPath, "-e", "setInterval(() => {}, 1000)"] as const;
    const timeoutMs = outcome === "timed_out" ? MIN_VALIDATION_TIMEOUT_MS : 5_000;
    const runner = new ValidationRunner(new ProcessSupervisor());
    const signal = controller?.signal ?? AbortSignal.timeout(5_000);
    const pending = runner.run(
      project(command, { focusedTimeoutMs: timeoutMs }),
      "focused",
      cwd,
      signal,
    );
    if (controller !== undefined) setTimeout(() => controller.abort(), 25);

    await expect(pending).resolves.toMatchObject({
      outcome,
      exitCode: null,
      timeoutMs,
      provenance: { timeoutMs },
    });
  });

  it("routes focused and full validation through their distinct configured budgets", async () => {
    const cwd = await workspace();
    const command = [process.execPath, "-e", "setTimeout(() => process.exit(0), 250)"] as const;
    const configured = project(command, {
      focusedTimeoutMs: MIN_VALIDATION_TIMEOUT_MS,
      fullTimeoutMs: 500,
    });
    configured.validations.full = [...command];
    const runner = new ValidationRunner(new ProcessSupervisor());

    const focused = await runner.run(configured, "focused", cwd, AbortSignal.timeout(5_000));
    const full = await runner.run(configured, "full", cwd, AbortSignal.timeout(5_000));

    expect(focused).toMatchObject({
      outcome: "timed_out",
      timeoutMs: MIN_VALIDATION_TIMEOUT_MS,
      provenance: { timeoutMs: MIN_VALIDATION_TIMEOUT_MS },
    });
    expect(full).toMatchObject({
      outcome: "completed",
      timeoutMs: 500,
      provenance: { timeoutMs: 500 },
    });
  });

  it("bounds timeout elapsed time and confirms the validation process group is gone", async () => {
    const cwd = await workspace();
    const pidFile = path.join(cwd, "descendant.pid");
    const script = [
      'const { spawn } = require("node:child_process")',
      'const { writeFileSync } = require("node:fs")',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const timeoutMs = 250;
    const started = process.hrtime.bigint();
    const pending = new ValidationRunner(new ProcessSupervisor()).run(
      project([process.execPath, "-e", script], { focusedTimeoutMs: timeoutMs }),
      "focused",
      cwd,
      AbortSignal.timeout(5_000),
    );
    const descendantPid = await waitForPid(pidFile);

    const report = await pending;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    expect(report).toMatchObject({
      outcome: "timed_out",
      exitCode: null,
      timeoutMs,
      provenance: { timeoutMs },
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(processExists(descendantPid)).toBe(false);
  });

  it("rejects an invalid timeout before supervisor dispatch", async () => {
    const cwd = await workspace();
    const supervisor = new CountingSupervisor();
    const configured = project([process.execPath, "--version"]);
    configured.validations.focusedTimeoutMs = MAX_VALIDATION_TIMEOUT_MS + 1;

    await expect(
      new ValidationRunner(supervisor).run(
        configured,
        "focused",
        cwd,
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toThrow(/timeout/i);
    expect(supervisor.requests).toHaveLength(0);
  });
});
