import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import type { WorkerRequest } from "../../src/workers/worker-adapter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerFixture = path.resolve(here, "../../fixtures/deterministic-worker.mjs");
const printEnvFixture = path.resolve(here, "fixtures/print-env.mjs");
const spawnGrandchildFixture = path.resolve(here, "fixtures/spawn-grandchild.mjs");
const successWithLiveDescendantFixture = path.resolve(
  here,
  "fixtures/success-with-live-descendant.mjs",
);
const successWithInheritedStreamsFixture = path.resolve(
  here,
  "fixtures/success-with-inherited-streams.mjs",
);
const successWithTermResistantDescendantFixture = path.resolve(
  here,
  "fixtures/success-with-term-resistant-descendant.mjs",
);
const successWithEscapedSessionFixture = path.resolve(
  here,
  "fixtures/success-with-escaped-session.mjs",
);
const exitBeforeDescendantOutputFixture = path.resolve(
  here,
  "fixtures/exit-before-descendant-output.mjs",
);
const waitingLeaderFixture = path.resolve(here, "fixtures/waiting-leader.mjs");

const VALID_ARTIFACT_EVENT = JSON.stringify({
  type: "artifact.ready",
  path: "out.txt",
  sha256: "0000000000000000000000000000000000000000000000000000000000000000",
});

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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
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
      "worker",
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

  it("terminates a same-group descendant before reporting successful completion", async () => {
    const pidFile = path.join(workspace, "descendant.pid");
    let descendantPid: number | undefined;

    try {
      let settled = false;
      const pending = new ProcessSupervisor().execute(
        request({ args: [successWithLiveDescendantFixture, pidFile] }),
        new AbortController().signal,
        "worker",
      );
      void pending.finally(() => {
        settled = true;
      });
      descendantPid = Number(await waitForFile(pidFile));

      expect(processExists(descendantPid)).toBe(true);
      expect(settled).toBe(false);
      const result = await pending;

      expect(result.outcome).toBe("completed");
      expect(descendantPid).toBeGreaterThan(0);
      expect(processExists(descendantPid)).toBe(false);
    } finally {
      if (descendantPid !== undefined && processExists(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  it("bounds stream flushing before terminating a descendant with inherited streams", async () => {
    const pidFile = path.join(workspace, "inherited-stream-descendant.pid");
    const leaderExitFile = path.join(workspace, "inherited-stream-leader-exit.txt");
    const descendantTerminationFile = path.join(
      workspace,
      "inherited-stream-descendant-termination.txt",
    );
    const streamGraceMs = 150;
    const terminationGraceMs = 100;
    const forcedTerminationMs = 1_000;
    let settled = false;
    const pending = new ProcessSupervisor({
      streamGraceMs,
      terminationGraceMs,
      forcedTerminationMs,
    }).execute(
      request({
        args: [
          successWithInheritedStreamsFixture,
          pidFile,
          leaderExitFile,
          descendantTerminationFile,
        ],
      }),
      new AbortController().signal,
      "worker",
    );
    void pending.finally(() => {
      settled = true;
    });
    const descendantPid = Number(await waitForFile(pidFile));
    const leaderExitedAt = BigInt(await waitForFile(leaderExitFile));

    expect(processExists(descendantPid)).toBe(true);
    expect(settled).toBe(false);
    const result = await pending;
    const descendantTerminatedAt = BigInt(await waitForFile(descendantTerminationFile));
    const elapsedAfterLeaderExitMs = Number(descendantTerminatedAt - leaderExitedAt) / 1_000_000;

    expect(result.outcome).toBe("completed");
    expect(elapsedAfterLeaderExitMs).toBeGreaterThanOrEqual(streamGraceMs);
    expect(elapsedAfterLeaderExitMs).toBeLessThan(
      streamGraceMs + terminationGraceMs + forcedTerminationMs,
    );
    expect(processExists(descendantPid)).toBe(false);
  });

  it("forces and confirms termination when a descendant ignores SIGTERM", async () => {
    const pidFile = path.join(workspace, "term-resistant-descendant.pid");
    const startedAt = process.hrtime.bigint();
    let settled = false;
    const pending = new ProcessSupervisor({
      terminationGraceMs: 75,
      forcedTerminationMs: 500,
    }).execute(
      request({ args: [successWithTermResistantDescendantFixture, pidFile] }),
      new AbortController().signal,
      "worker",
    );
    void pending.finally(() => {
      settled = true;
    });
    const descendantPid = Number(await waitForFile(pidFile));

    expect(processExists(descendantPid)).toBe(true);
    expect(settled).toBe(false);
    const result = await pending;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    expect(result.outcome).toBe("completed");
    expect(elapsedMs).toBeGreaterThanOrEqual(50);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(processExists(descendantPid)).toBe(false);
  });

  it("fails when group absence cannot be confirmed inside the forced termination bound", async () => {
    const pidFile = path.join(workspace, "unconfirmed-descendant.pid");
    const result = await new ProcessSupervisor({
      terminationGraceMs: 25,
      forcedTerminationMs: 0,
    }).execute(
      request({ args: [successWithTermResistantDescendantFixture, pidFile] }),
      new AbortController().signal,
      "worker",
    );
    const descendantPid = Number(await readFile(pidFile, "utf8"));

    expect(result.outcome).toBe("failed");
    expect(result.stderr).toContain("process group survived bounded termination");
    await waitForProcessExit(descendantPid);
  });

  it("documents deliberate session escape as outside macOS process-group containment", async () => {
    const pidFile = path.join(workspace, "escaped-session.pid");
    let escapedPid: number | undefined;

    try {
      const result = await new ProcessSupervisor().execute(
        request({ args: [successWithEscapedSessionFixture, pidFile] }),
        new AbortController().signal,
        "worker",
      );
      escapedPid = Number(await readFile(pidFile, "utf8"));

      expect(result.outcome).toBe("completed");
      expect(processExists(escapedPid)).toBe(true);
    } finally {
      if (escapedPid !== undefined && processExists(escapedPid)) {
        process.kill(escapedPid, "SIGKILL");
      }
    }
  });

  it("refuses to follow a symlink target outside the workspace", async () => {
    const marker = path.join(tmpdir(), `zentra-worker-marker-${process.pid}-${Date.now()}`);
    await writeFile(marker, "unchanged", "utf8");
    await symlink(marker, path.join(workspace, "out.txt"));
    try {
      const result = await new ProcessSupervisor().execute(
        request({ args: workerArgs("out.txt", "changed") }),
        new AbortController().signal,
        "worker",
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
        "worker",
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
      "worker",
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
        "worker",
      );

      expect(result.outcome).toBe("completed");
      const environment = JSON.parse(result.stdout.match(/^environment=(.*)$/m)?.[1] ?? "") as Record<
        string,
        string
      >;
      expect(environment["ZENTRA_TEST_SECRET"]).toBeUndefined();
      expect(environment["PATH"]).toBe(process.env["PATH"]);
      // __CF_USER_TEXT_ENCODING is injected by macOS into every spawned process.
      const allowed = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "__CF_USER_TEXT_ENCODING"]);
      for (const key of Object.keys(environment)) {
        expect(allowed.has(key)).toBe(true);
      }
      expect(result.stdout).not.toContain(canary);
    } finally {
      delete process.env["ZENTRA_TEST_SECRET"];
    }
  });

  it("maps output beyond the byte limit to failed", async () => {
    const pidFile = path.join(workspace, "output-limit-descendant.pid");
    const pending = new ProcessSupervisor({ maxOutputBytes: 1024 }).execute(
      request({ args: [spawnGrandchildFixture, pidFile, "exceed-output"] }),
      new AbortController().signal,
      "worker",
    );
    const descendantPid = Number(await waitForFile(pidFile));
    const result = await pending;

    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBeNull();
    expect(Buffer.byteLength(result.rawStdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      1024 + Buffer.byteLength("process supervisor: output limit of 1024 bytes exceeded\n"),
    );
    expect(result.stderr).toContain("output limit");
    expect(processExists(descendantPid)).toBe(false);
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
      "worker",
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
      "worker",
    );

    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBeNull();
    expect(Buffer.byteLength(result.rawStdout)).toBeLessThanOrEqual(64);
    expect(result.stderr).toContain("output limit");
  });

  it("maps deadline expiry to timed_out", async () => {
    const pidFile = path.join(workspace, "timed-out-descendant.pid");
    const pending = new ProcessSupervisor().execute(
      request({ args: [spawnGrandchildFixture, pidFile], timeoutMs: 250 }),
      new AbortController().signal,
      "worker",
    );
    const descendantPid = Number(await waitForFile(pidFile));
    const result = await pending;

    expect(result.outcome).toBe("timed_out");
    expect(result.exitCode).toBeNull();
    expect(result.rawStdout).toBe("");
    expect(result.events).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(processExists(descendantPid)).toBe(false);
  });

  it("maps abort to cancelled without stale worker output", async () => {
    const supervisor = new ProcessSupervisor();
    const controller = new AbortController();
    const pidFile = path.join(workspace, "cancelled-descendant.pid");
    const pending = supervisor.execute(
      request({ args: [spawnGrandchildFixture, pidFile] }),
      controller.signal,
      "worker",
    );
    const descendantPid = Number(await waitForFile(pidFile));
    controller.abort();
    const result = await pending;

    expect(result.outcome).toBe("cancelled");
    expect(result.exitCode).toBeNull();
    expect(result.rawStdout).toBe("");
    expect(result.events).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(processExists(descendantPid)).toBe(false);
  });

  it("maps a nonzero exit to failed", async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.execute(
      request({ args: [workerFixture, "--bogus", "flag"] }),
      new AbortController().signal,
      "worker",
    );

    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown flag");
  });

  it("maps exit zero with invalid worker protocol output to failed", async () => {
    const result = await new ProcessSupervisor().execute(
      request({ args: ["-e", 'console.log(JSON.stringify({ type: "worker.completed" }))'] }),
      new AbortController().signal,
      "worker",
    );

    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("worker protocol");
  });

  it("does not let a worker task named validation bypass artifact validation", async () => {
    const result = await new ProcessSupervisor().execute(
      request({ taskId: "validation", args: ["-e", 'console.log("no artifact")'] }),
      new AbortController().signal,
      "worker",
    );

    expect(result.outcome).toBe("failed");
    expect(result.stderr).toContain("worker protocol");
  });

  it("does not let worker inline arguments bypass artifact validation", async () => {
    const result = await new ProcessSupervisor().execute(
      request({ args: ["-e", 'console.log("no artifact")'] }),
      new AbortController().signal,
      "worker",
    );

    expect(result.outcome).toBe("failed");
    expect(result.stderr).toContain("worker protocol");
  });

  it("maps exit zero with a consumer-invalid review date to failed", async () => {
    const invalidDecision = JSON.stringify({
      reviewerId: "reviewer-1",
      approved: true,
      diffSha256: "0".repeat(64),
      validationSha256: "1".repeat(64),
      decidedAt: "2025-02-30T12:00:00Z",
      reason: "invalid calendar date",
    });
    const result = await new ProcessSupervisor().execute(
      request({ taskId: "review", args: ["-e", `console.log(${JSON.stringify(invalidDecision)})`] }),
      new AbortController().signal,
      "reviewer",
    );

    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBe(0);
    expect(result.events).toEqual([]);
    expect(result.stderr).toContain("reviewer protocol");
  });

  it("validates the reviewer protocol from the explicit kind instead of taskId", async () => {
    const artifact = JSON.stringify({
      type: "artifact.ready",
      path: "out.txt",
      sha256: "0".repeat(64),
    });
    const result = await new ProcessSupervisor().execute(
      request({ taskId: "validation", args: ["-e", `console.log(${JSON.stringify(artifact)})`] }),
      new AbortController().signal,
      "reviewer",
    );

    expect(result.outcome).toBe("failed");
    expect(result.stderr).toContain("reviewer protocol");
  });

  it("accepts exit zero without worker events for validation invocations", async () => {
    const result = await new ProcessSupervisor().execute(
      request({ taskId: "validation", args: ["-e", 'console.log("validation passed")'] }),
      new AbortController().signal,
      "validation",
    );

    expect(result.outcome).toBe("completed");
    expect(result.stdout).toContain("validation passed");
  });

  it("uses the validation protocol even when taskId and args resemble other kinds", async () => {
    const result = await new ProcessSupervisor().execute(
      request({ taskId: "review", args: ["-e", 'console.log("validation passed")'] }),
      new AbortController().signal,
      "validation",
    );

    expect(result.outcome).toBe("completed");
    expect(result.stdout).toContain("validation passed");
  });

  it("settles within the forced bound when process-group signaling is denied", async () => {
    const pidFile = path.join(workspace, "denied-group-descendant.pid");
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signalName) => {
      if (pid < 0 && signalName !== 0) {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return realKill(pid, signalName);
    });
    let descendantPid: number | undefined;

    try {
      const startedAt = process.hrtime.bigint();
      const result = await new ProcessSupervisor({
        streamGraceMs: 10,
        terminationGraceMs: 20,
        forcedTerminationMs: 60,
      }).execute(
        request({ args: [successWithLiveDescendantFixture, pidFile] }),
        new AbortController().signal,
        "worker",
      );
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      descendantPid = Number(await readFile(pidFile, "utf8"));

      expect(result.outcome).toBe("failed");
      expect(elapsedMs).toBeLessThan(500);
      expect(processExists(descendantPid)).toBe(true);
    } finally {
      kill.mockRestore();
      if (descendantPid !== undefined && processExists(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  it("settles within the forced bound when group and leader signaling are denied", async () => {
    const pidFile = path.join(workspace, "denied-leader.pid");
    const controller = new AbortController();
    const realKill = process.kill.bind(process);
    let leaderPid: number | undefined;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signalName) => {
      if (signalName !== 0) {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return realKill(pid, signalName);
    });

    try {
      const pending = new ProcessSupervisor({ forcedTerminationMs: 60 }).execute(
        request({ args: [waitingLeaderFixture, pidFile] }),
        controller.signal,
        "worker",
      );
      leaderPid = Number(await waitForFile(pidFile));
      const startedAt = process.hrtime.bigint();
      controller.abort();
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("supervisor did not settle after denied signals")), 500),
        ),
      ]);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      expect(result.outcome).toBe("cancelled");
      expect(elapsedMs).toBeLessThan(500);
      expect(processExists(leaderPid)).toBe(true);
    } finally {
      kill.mockRestore();
      if (leaderPid !== undefined && processExists(leaderPid)) {
        process.kill(leaderPid, "SIGKILL");
      }
    }
  });

  it("gives post-exit cancellation precedence over stream and graceful termination grace", async () => {
    const pidFile = path.join(workspace, "post-exit-cancel-descendant.pid");
    const controller = new AbortController();
    const pending = new ProcessSupervisor({
      streamGraceMs: 2_000,
      terminationGraceMs: 2_000,
      forcedTerminationMs: 500,
    }).execute(
      request({
        args: [
          successWithInheritedStreamsFixture,
          pidFile,
          path.join(workspace, "post-exit-cancel-leader-exit.txt"),
          path.join(workspace, "post-exit-cancel-descendant-termination.txt"),
        ],
      }),
      controller.signal,
      "worker",
    );
    const descendantPid = Number(await waitForFile(pidFile));
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
    const startedAt = process.hrtime.bigint();
    controller.abort();
    const result = await pending;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    expect(result.outcome).toBe("cancelled");
    expect(elapsedMs).toBeLessThan(500);
    expect(processExists(descendantPid)).toBe(false);
  });

  it("gives post-exit timeout precedence over stream and graceful termination grace", async () => {
    const pidFile = path.join(workspace, "post-exit-timeout-descendant.pid");
    const startedAt = process.hrtime.bigint();
    const pending = new ProcessSupervisor({
      streamGraceMs: 2_000,
      terminationGraceMs: 2_000,
      forcedTerminationMs: 500,
    }).execute(
      request({
        args: [
          successWithInheritedStreamsFixture,
          pidFile,
          path.join(workspace, "post-exit-timeout-leader-exit.txt"),
          path.join(workspace, "post-exit-timeout-descendant-termination.txt"),
        ],
        timeoutMs: 100,
      }),
      new AbortController().signal,
      "worker",
    );
    const descendantPid = Number(await waitForFile(pidFile));

    expect(processExists(descendantPid)).toBe(true);
    const result = await pending;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    expect(result.outcome).toBe("timed_out");
    expect(elapsedMs).toBeLessThan(500);
    expect(processExists(descendantPid)).toBe(false);
  });

  it("rejects invalid supervisor and request durations", async () => {
    expect(() => new ProcessSupervisor({ streamGraceMs: -1 })).toThrow(RangeError);
    expect(() => new ProcessSupervisor({ terminationGraceMs: Number.NaN })).toThrow(RangeError);
    expect(() => new ProcessSupervisor({ forcedTerminationMs: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    await expect(
      new ProcessSupervisor().execute(
        request({ args: ["-e", `console.log(${JSON.stringify(VALID_ARTIFACT_EVENT)})`], timeoutMs: -1 }),
        new AbortController().signal,
        "worker",
      ),
    ).rejects.toThrow(RangeError);
  });

  it("maps a spawn error to failed with no available exit code", async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.execute(
      request({ executable: path.join(workspace, "missing-executable"), args: [] }),
      new AbortController().signal,
      "worker",
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
      "worker",
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
        args: [
          "-e",
          `console.log("plain text"); console.log(${JSON.stringify(VALID_ARTIFACT_EVENT)});`,
        ],
      }),
      new AbortController().signal,
      "worker",
    );

    expect(result.outcome).toBe("completed");
    expect(result.events).toEqual([JSON.parse(VALID_ARTIFACT_EVENT)]);
    expect(result.stdout).toContain("plain text");
    expect(result.rawStdout).toContain('"type":"artifact.ready"');
  });
});
