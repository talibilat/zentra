import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ValidationRunner } from "../../src/capabilities/validation-runner.js";
import type { ProjectConfig } from "../../src/projects/project-config.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";

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

function project(command: readonly [string, ...string[]]): ProjectConfig {
  return {
    projectId: "test",
    repositoryPath: "/repo",
    integrationBranch: "zentra/integration",
    worktreeRoot: "/worktrees",
    validations: {
      focused: [...command] as [string, ...string[]],
      full: [process.execPath, "-e", "process.exit(0)"],
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("ValidationRunner", () => {
  it("reports named command identity, exact argv digest, timing, outcome, and exit code", async () => {
    const cwd = await workspace();
    const command = [process.execPath, "-e", 'process.stdout.write("ok")'] as const;
    const report = await new ValidationRunner(new ProcessSupervisor()).run(
      project(command),
      "focused",
      cwd,
      AbortSignal.timeout(5_000),
    );

    expect(report).toMatchObject({ name: "focused", command, outcome: "completed", exitCode: 0 });
    expect(report.argvSha256).toBe(sha256(JSON.stringify(command)));
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
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
    const runner = new ValidationRunner(new ProcessSupervisor(), { timeoutMs: outcome === "timed_out" ? 25 : 5_000 });
    const signal = controller?.signal ?? AbortSignal.timeout(5_000);
    const pending = runner.run(project(command), "focused", cwd, signal);
    if (controller !== undefined) setTimeout(() => controller.abort(), 25);

    await expect(pending).resolves.toMatchObject({ outcome, exitCode: null });
  });
});
