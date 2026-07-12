import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import type { WorkerRequest } from "../../src/workers/worker-adapter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerFixture = path.resolve(here, "../../fixtures/deterministic-worker.mjs");
const printEnvFixture = path.resolve(here, "fixtures/print-env.mjs");
const spawnGrandchildFixture = path.resolve(here, "fixtures/spawn-grandchild.mjs");
const exitBeforeDescendantOutputFixture = path.resolve(
  here,
  "fixtures/exit-before-descendant-output.mjs",
);

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const content = await readFile(filePath, "utf8");
      if (content.length > 0) {
        return content;
      }
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone after all.
      }
      throw new Error(`process ${pid} still alive after group kill`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "zentra-worker-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function request(overrides: Partial<WorkerRequest> & Pick<WorkerRequest, "args">): WorkerRequest {
  return {
    taskId: "task-1",
    executable: process.execPath,
    cwd: workspace,
    timeoutMs: 10_000,
    ...overrides,
  };
}

function workerArgs(file: string, content: string): readonly string[] {
  return [workerFixture, "--workspace", workspace, "--file", file, "--content", content];
}

describe("ProcessSupervisor", () => {
  it("collects JSON-line events from a completed worker", async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.execute(
      request({ args: workerArgs("out.txt", "hello") }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.events).toHaveLength(1);
    expect(result.rawStdout).toContain('"type":"artifact.ready"');
    const event = result.events[0] as { type: string; path: string };
    expect(event.type).toBe("artifact.ready");
    expect(event.path).toBe("out.txt");
    await expect(readFile(path.join(workspace, "out.txt"), "utf8")).resolves.toBe("hello");
  });

  it("refuses to follow a symlink target outside the workspace", async () => {
    const marker = path.join(tmpdir(), `zentra-worker-marker-${process.pid}-${Date.now()}`);
    await writeFile(marker, "unchanged", "utf8");
    await symlink(marker, path.join(workspace, "out.txt"));
    try {
      const result = await new ProcessSupervisor().execute(
        request({ args: workerArgs("out.txt", "changed") }),
        new AbortController().signal,
      );

      expect(result.outcome).toBe("failed");
      expect(await readFile(marker, "utf8")).toBe("unchanged");
    } finally {
      await rm(marker, { force: true });
    }
  });

  it("refuses to traverse a symlink parent outside the workspace", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "zentra-worker-external-"));
    const marker = path.join(external, "out.txt");
    await writeFile(marker, "unchanged", "utf8");
    await symlink(external, path.join(workspace, "linked"));
    try {
      const result = await new ProcessSupervisor().execute(
        request({ args: workerArgs("linked/out.txt", "changed") }),
        new AbortController().signal,
      );

      expect(result.outcome).toBe("failed");
      expect(await readFile(marker, "utf8")).toBe("unchanged");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it("rejects nested target paths as outside the root-file MVP contract", async () => {
    const result = await new ProcessSupervisor().execute(
      request({ args: workerArgs("nested/out.txt", "changed") }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    expect(result.stderr).toMatch(/root|slash|filename/i);
  });

  it("spawns workers with a minimal environment allowlist", async () => {
    const canary = "super-secret-value";
    process.env["ZENTRA_TEST_SECRET"] = canary;
    try {
      const supervisor = new ProcessSupervisor();
      const result = await supervisor.execute(
        request({ args: [printEnvFixture] }),
        new AbortController().signal,
      );

      expect(result.outcome).toBe("completed");
      const event = result.events[0] as { type: string; env: Record<string, string> };
      expect(event.type).toBe("env.dump");
      expect(event.env["ZENTRA_TEST_SECRET"]).toBeUndefined();
      expect(event.env["PATH"]).toBe(process.env["PATH"]);
      // __CF_USER_TEXT_ENCODING is injected by macOS into every spawned process.
      const allowed = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "__CF_USER_TEXT_ENCODING"]);
      for (const key of Object.keys(event.env)) {
        expect(allowed.has(key)).toBe(true);
      }
      expect(result.stdout).not.toContain(canary);
    } finally {
      delete process.env["ZENTRA_TEST_SECRET"];
    }
  });

  it("maps output beyond the byte limit to failed", async () => {
    const supervisor = new ProcessSupervisor({ maxOutputBytes: 1024 });
    const result = await supervisor.execute(
      request({
        args: ["-e", 'process.stdout.write("x".repeat(1024 * 1024)); setInterval(() => {}, 1000);'],
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBeNull();
    expect(Buffer.byteLength(result.rawStdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      1024 + Buffer.byteLength("process supervisor: output limit of 1024 bytes exceeded\n"),
    );
    expect(result.stderr).toContain("output limit");
  });

  it("retains at most the shared output byte limit across multiple stdout and stderr chunks", async () => {
    const supervisor = new ProcessSupervisor({ maxOutputBytes: 64 });
    const result = await supervisor.execute(
      request({
        args: [
          "-e",
          'for (let i = 0; i < 20; i++) { process.stdout.write("abcd"); process.stderr.write("WXYZ"); }',
        ],
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    const capturedStderr = result.stderr.replace(
      /(?:\n)?process supervisor: output limit of 64 bytes exceeded\n$/,
      "",
    );
    expect(Buffer.byteLength(result.rawStdout) + Buffer.byteLength(capturedStderr)).toBeLessThanOrEqual(64);
  });

  it("fails when descendant output exceeds the limit after the parent exits successfully", async () => {
    const supervisor = new ProcessSupervisor({ maxOutputBytes: 64 });
    const result = await supervisor.execute(
      request({ args: [exitBeforeDescendantOutputFixture] }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBeNull();
    expect(Buffer.byteLength(result.rawStdout)).toBeLessThanOrEqual(64);
    expect(result.stderr).toContain("output limit");
  });

  it("maps deadline expiry to timed_out", async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.execute(
      request({ args: workerArgs("never.txt", "__WAIT__"), timeoutMs: 250 }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("timed_out");
    expect(result.exitCode).toBeNull();
    expect(result.rawStdout).toBe("");
    expect(result.events).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("maps abort to cancelled without stale worker output", async () => {
    const supervisor = new ProcessSupervisor();
    const controller = new AbortController();
    const pending = supervisor.execute(
      request({ args: workerArgs("never.txt", "__WAIT__") }),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);
    const result = await pending;

    expect(result.outcome).toBe("cancelled");
    expect(result.exitCode).toBeNull();
    expect(result.rawStdout).toBe("");
    expect(result.events).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("terminates the whole process group, including grandchildren", async () => {
    const supervisor = new ProcessSupervisor();
    const controller = new AbortController();
    const pidFile = path.join(workspace, "grandchild.pid");
    const pending = supervisor.execute(
      request({ args: [spawnGrandchildFixture, pidFile] }),
      controller.signal,
    );

    const grandchildPid = Number(await waitForFile(pidFile));
    expect(Number.isInteger(grandchildPid)).toBe(true);
    controller.abort();
    const result = await pending;

    expect(result.outcome).toBe("cancelled");
    expect(result.events).toEqual([]);
    expect(result.stdout).toBe("");
    await waitForProcessExit(grandchildPid);
  });

  it("maps a nonzero exit to failed", async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.execute(
      request({ args: [workerFixture, "--bogus", "flag"] }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown flag");
  });

  it("maps a spawn error to failed with no available exit code", async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.execute(
      request({ executable: path.join(workspace, "missing-executable"), args: [] }),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      outcome: "failed",
      exitCode: null,
      events: [],
      stdout: "",
      rawStdout: "",
    });
    expect(result.stderr).toContain("process supervisor:");
  });

  it("resolves an already-aborted signal as cancelled", async () => {
    const supervisor = new ProcessSupervisor();
    const controller = new AbortController();
    controller.abort();
    const result = await supervisor.execute(
      request({ args: workerArgs("out.txt", "hello") }),
      controller.signal,
    );

    expect(result.outcome).toBe("cancelled");
    expect(result.exitCode).toBeNull();
    expect(result.rawStdout).toBe("");
    expect(result.events).toEqual([]);
  });

  it("collects non-JSON stdout lines as plain stdout, not events", async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.execute(
      request({
        args: ["-e", 'console.log("plain text"); console.log(JSON.stringify({ type: "ok" }));'],
      }),
      new AbortController().signal,
    );

    expect(result.outcome).toBe("completed");
    expect(result.events).toEqual([{ type: "ok" }]);
    expect(result.stdout).toContain("plain text");
    expect(result.rawStdout).toContain('{"type":"ok"}');
  });
});
