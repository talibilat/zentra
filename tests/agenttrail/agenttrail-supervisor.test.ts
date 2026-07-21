import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentTrailSupervisor,
  createAgentTrailSupervisorForTesting,
  probeAgentTrailReadinessForTesting,
  type AgentTrailEvidence,
} from "../../src/agenttrail/agenttrail-supervisor.js";
import type { ProjectRuntimeLayout } from "../../src/runtime/repository-runtime.js";

const supervisors: AgentTrailSupervisor[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("AgentTrailSupervisor", () => {
  it.each([
    ["404", 404, "text/html; charset=utf-8", "<title>AgentTrail</title>", false],
    ["redirect", 302, "text/html; charset=utf-8", "<title>AgentTrail</title>", false],
    ["title-matching changed bytes", 200, "text/html; charset=utf-8", "<title>AgentTrail</title>changed", false],
    ["wrong content type", 200, "application/json", "<title>AgentTrail</title>", false],
    ["packaged identity", 200, "text/html; charset=utf-8", "<!doctype html><title>AgentTrail</title>", true],
  ] as const)("requires exact AgentTrail HTML readiness for %s", async (_name, status, contentType, body, expected) => {
    const reviewedBody = Buffer.from("<!doctype html><title>AgentTrail</title>");
    const server = createServer((_request, response) => {
      response.statusCode = status;
      response.setHeader("content-type", contentType);
      if (status === 302) response.setHeader("location", "/other");
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture server did not bind");
    try {
      await expect(probeAgentTrailReadinessForTesting(address.port, reviewedBody)).resolves.toBe(expected);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("starts the packaged sidecar with Python absent from PATH and a minimal environment", async () => {
    const fixture = await traceFixture();
    const evidence: AgentTrailEvidence[] = [];
    process.env["ZENTRA_AGENTTRAIL_SECRET_CANARY"] = "must-not-leak";
    const supervisor = new AgentTrailSupervisor({ evidence: (event) => { evidence.push(event); } });
    supervisors.push(supervisor);

    const ready = await supervisor.start({ ...fixture, startupTimeoutMs: 60_000 });

    expect(ready.address.host).toBe("127.0.0.1");
    expect(ready.address.port).toBeGreaterThan(0);
    expect(evidence.map(({ type }) => type)).toEqual(["agenttrail.starting", "agenttrail.ready"]);
    expect(evidence[0]).toMatchObject({ type: "agenttrail.starting", pid: null });
    expect(execFileSync("/usr/bin/curl", ["--silent", "--fail", `http://127.0.0.1:${ready.address.port}/`], {
      env: { PATH: "/usr/bin:/bin" },
    }).toString()).toContain("AgentTrail");
    expect(supervisor.environmentKeys()).toEqual(["HOME", "LANG", "LC_ALL", "TMPDIR"]);
  }, 90_000);

  it("terminates a sidecar that misses its readiness deadline with exact failure evidence", async () => {
    const fixture = await traceFixture("slow-start.jsonl");
    const evidence: AgentTrailEvidence[] = [];
    const supervisor = new AgentTrailSupervisor({ evidence: (event) => { evidence.push(event); } });
    supervisors.push(supervisor);

    await expect(supervisor.start({ ...fixture, startupTimeoutMs: 1 }))
      .rejects.toThrow("AgentTrail readiness deadline exceeded");

    expect(evidence.map(({ type }) => type)).toEqual(["agenttrail.starting", "agenttrail.failed"]);
    expect(evidence[1]).toMatchObject({
      type: "agenttrail.failed",
      phase: "startup",
      failure: { code: "readiness_timeout", message: "AgentTrail readiness deadline exceeded" },
    });
  }, 20_000);

  it("detects a later crash, restarts with a new incarnation, and leaves acceptance available", async () => {
    const fixture = await traceFixture();
    const evidence: AgentTrailEvidence[] = [];
    const supervisor = new AgentTrailSupervisor({
      evidence: (event) => { evidence.push(event); },
      restartBackoffMs: [10, 20],
    });
    supervisors.push(supervisor);
    const first = await supervisor.start({ ...fixture, startupTimeoutMs: 60_000 });

    process.kill(first.pid, "SIGKILL");
    const restarted = await waitForEvidence(evidence, "agenttrail.restarted");
    const ready = await waitForReadyIncarnation(evidence, restarted.incarnation);

    expect(restarted.previousIncarnation).toBe(first.incarnation);
    expect(restarted.incarnation).not.toBe(first.incarnation);
    expect(restarted.restartAttempt).toBe(1);
    expect(restarted.backoffMs).toBe(10);
    expect(ready.executableSha256).toBe(first.executableSha256);
    expect(supervisor.acceptingTasks()).toBe(true);
  }, 150_000);

  it("bounds captured output and shuts down without restarting", async () => {
    const fixture = await traceFixture();
    const evidence: AgentTrailEvidence[] = [];
    const supervisor = new AgentTrailSupervisor({
      evidence: (event) => { evidence.push(event); },
      maxOutputBytes: 256,
      restartBackoffMs: [10],
    });
    supervisors.push(supervisor);
    const ready = await supervisor.start({ ...fixture, startupTimeoutMs: 60_000 });

    await supervisor.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(Buffer.byteLength(supervisor.stdout())).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(supervisor.stderr())).toBeLessThanOrEqual(256);
    expect(evidence.filter(({ type }) => type === "agenttrail.restarted")).toHaveLength(0);
    expect(supervisor.acceptingTasks()).toBe(true);
    expect(() => process.kill(-ready.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }, 90_000);

  it("requires the production evidence sink and exposes no package injection option", () => {
    expect(() => new AgentTrailSupervisor({} as never)).toThrow(/evidence sink/);
    expect(() => new AgentTrailSupervisor({
      evidence: () => undefined,
      packageRoot: "/tmp/alternate",
    } as never)).toThrow(/unknown option/);
  });

  it("does not spawn and cleans its environment when starting intent persistence rejects", async () => {
    const fixture = await traceFixture();
    let spawnObserved = false;
    const supervisor = createAgentTrailSupervisorForTesting({
      evidence: async () => { throw new Error("journal unavailable"); },
    }, {
      beforeSpawn: () => { spawnObserved = true; },
    });
    supervisors.push(supervisor);

    await expect(supervisor.start({ ...fixture, startupTimeoutMs: 60_000 }))
      .rejects.toThrow("journal unavailable");
    expect(spawnObserved).toBe(false);
    expect(supervisor.environmentKeys()).toEqual([]);
  }, 90_000);

  it("records a pre-spawn failure with the durable intent incarnation and no pid", async () => {
    const fixture = await traceFixture();
    const evidence: AgentTrailEvidence[] = [];
    const supervisor = createAgentTrailSupervisorForTesting({
      evidence: (event) => { evidence.push(event); },
    }, {
      beforeSpawn: () => { throw new Error("controlled spawn failure"); },
    });
    supervisors.push(supervisor);

    await expect(supervisor.start({ ...fixture, startupTimeoutMs: 60_000 }))
      .rejects.toThrow("AgentTrail failed to start");

    expect(evidence.map(({ type }) => type)).toEqual(["agenttrail.starting", "agenttrail.failed"]);
    expect(evidence[0]).toMatchObject({ pid: null });
    expect(evidence[1]).toMatchObject({
      pid: null,
      incarnation: evidence[0]!.incarnation,
      phase: "startup",
      failure: { code: "spawn_error", message: "controlled spawn failure" },
    });
  });

  it("does not restart when runtime failure evidence cannot be persisted", async () => {
    const fixture = await traceFixture();
    const evidence: AgentTrailEvidence[] = [];
    let rejectFailure = true;
    const supervisor = new AgentTrailSupervisor({
      evidence: async (event) => {
        evidence.push(event);
        if (event.type === "agenttrail.failed" && rejectFailure) {
          rejectFailure = false;
          throw new Error("journal temporarily unavailable");
        }
      },
      restartBackoffMs: [10],
    });
    supervisors.push(supervisor);
    const first = await supervisor.start({ ...fixture, startupTimeoutMs: 60_000 });

    process.kill(first.pid, "SIGKILL");
    await waitForEvidence(evidence, "agenttrail.failed");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(evidence.filter(({ type }) => type === "agenttrail.restarted")).toHaveLength(0);
    expect(supervisor.evidenceFailure()?.message).toBe("journal temporarily unavailable");
    expect(supervisor.acceptingTasks()).toBe(true);
  }, 150_000);

  it("rejects a controlled private launch pathname replacement after descriptor verification", async () => {
    const fixture = await traceFixture();
    let launchPath: string | null = null;
    let launchDigest: string | null = null;
    let launchMode: number | null = null;
    let launchLinks: number | null = null;
    let launchCanonical = false;
    let spawnObserved = false;
    const supervisor = createAgentTrailSupervisorForTesting({ evidence: () => undefined }, {
      beforeSpawn: async (candidate) => {
        launchPath = candidate;
        launchDigest = createHash("sha256").update(await readFile(candidate)).digest("hex");
        const metadata = await lstat(candidate);
        launchMode = metadata.mode & 0o777;
        launchLinks = metadata.nlink;
        launchCanonical = await realpath(candidate) === candidate;
        await rename(candidate, `${candidate}.reviewed`);
        await writeFile(candidate, "#!/bin/sh\nexit 97\n", { mode: 0o700 });
      },
      afterSpawn: () => { spawnObserved = true; },
    });
    supervisors.push(supervisor);

    await expect(supervisor.start({ ...fixture, startupTimeoutMs: 60_000 }))
      .rejects.toThrow("AgentTrail failed to start");

    expect(launchPath).not.toContain("agenttrail/package/darwin-arm64/agenttrail");
    expect(launchCanonical).toBe(true);
    expect(launchLinks).toBe(1);
    expect(launchMode).toBe(0o700);
    expect(launchDigest).toBe("50b33f3019132e9b186585088f74a28558649e52667420c5f5debae47676438d");
    expect(spawnObserved).toBe(false);
    expect(supervisor.environmentKeys()).toEqual([]);
  }, 90_000);

  it("rejects start when shutdown overlaps a pending ready evidence append", async () => {
    const fixture = await traceFixture();
    let readyPending!: () => void;
    let releaseReady!: () => void;
    const readyPendingPromise = new Promise<void>((resolve) => { readyPending = resolve; });
    const releaseReadyPromise = new Promise<void>((resolve) => { releaseReady = resolve; });
    const supervisor = new AgentTrailSupervisor({
      evidence: async (event) => {
        if (event.type === "agenttrail.ready") {
          readyPending();
          await releaseReadyPromise;
        }
      },
    });
    supervisors.push(supervisor);

    const pending = supervisor.start({ ...fixture, startupTimeoutMs: 60_000 });
    const rejected = expect(pending).rejects.toThrow("AgentTrail startup was cancelled by shutdown");
    await readyPendingPromise;
    await supervisor.shutdown();
    releaseReady();

    await rejected;
    expect(supervisor.environmentKeys()).toEqual([]);
  }, 90_000);

  it("retains process and private environment identity when shutdown termination fails", async () => {
    const fixture = await traceFixture();
    const terminationPids: number[] = [];
    let rejectOnce = true;
    const supervisor = createAgentTrailSupervisorForTesting({ evidence: () => undefined }, {
      beforeTerminate: (pid) => {
        terminationPids.push(pid);
        if (rejectOnce) {
          rejectOnce = false;
          throw new Error("controlled termination failure");
        }
      },
    });
    supervisors.push(supervisor);
    const ready = await supervisor.start({ ...fixture, startupTimeoutMs: 60_000 });

    await expect(supervisor.shutdown()).rejects.toThrow("controlled termination failure");
    expect(supervisor.environmentKeys()).toEqual(["HOME", "LANG", "LC_ALL", "TMPDIR"]);
    expect(() => process.kill(-ready.pid, 0)).not.toThrow();

    await supervisor.shutdown();
    expect(terminationPids).toEqual([ready.pid, ready.pid]);
    expect(supervisor.environmentKeys()).toEqual([]);
    expect(() => process.kill(-ready.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }, 90_000);

  it("promptly rejects a pending start on shutdown without delayed stale signaling", async () => {
    const fixture = await traceFixture();
    let spawned!: () => void;
    const spawnedPromise = new Promise<void>((resolve) => { spawned = resolve; });
    const terminationPids: number[] = [];
    const supervisor = createAgentTrailSupervisorForTesting({ evidence: () => undefined }, {
      afterSpawn: () => { spawned(); },
      beforeTerminate: (pid) => { terminationPids.push(pid); },
    });
    supervisors.push(supervisor);

    const pending = supervisor.start({ ...fixture, startupTimeoutMs: 60_000 });
    const rejected = expect(pending).rejects.toThrow("AgentTrail startup was cancelled by shutdown");
    await spawnedPromise;
    const startedAt = Date.now();
    await supervisor.shutdown();

    await rejected;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(terminationPids).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(terminationPids).toHaveLength(1);
    expect(() => process.kill(-terminationPids[0]!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }, 90_000);

  it("does not spawn a replacement when delayed restarted intent persistence rejects", async () => {
    const fixture = await traceFixture();
    const evidence: AgentTrailEvidence[] = [];
    const spawnedPids: number[] = [];
    let restartedPending!: () => void;
    let releaseRestarted!: () => void;
    const restartedPendingPromise = new Promise<void>((resolve) => { restartedPending = resolve; });
    const releaseRestartedPromise = new Promise<void>((resolve) => { releaseRestarted = resolve; });
    const supervisor = createAgentTrailSupervisorForTesting({
      evidence: async (event) => {
        evidence.push(event);
        if (event.type === "agenttrail.restarted") {
          restartedPending();
          await releaseRestartedPromise;
          throw new Error("restarted evidence unavailable");
        }
      },
      restartBackoffMs: [10, 20],
    }, {
      afterSpawn: (pid) => { spawnedPids.push(pid); },
    });
    supervisors.push(supervisor);
    const first = await supervisor.start({ ...fixture, startupTimeoutMs: 60_000 });

    process.kill(first.pid, "SIGKILL");
    await restartedPendingPromise;
    expect(spawnedPids).toHaveLength(1);
    releaseRestarted();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(spawnedPids).toHaveLength(1);
    expect(supervisor.evidenceFailure()?.message).toBe("restarted evidence unavailable");
    await supervisor.shutdown();
  }, 150_000);

  it("stops recovery after restarted evidence rejection and permits reset through shutdown", async () => {
    const fixture = await traceFixture();
    const evidence: AgentTrailEvidence[] = [];
    const spawnedPids: number[] = [];
    let rejectRestarted = true;
    const supervisor = createAgentTrailSupervisorForTesting({
      evidence: async (event) => {
        evidence.push(event);
        if (event.type === "agenttrail.restarted" && rejectRestarted) {
          rejectRestarted = false;
          throw new Error("restarted evidence unavailable");
        }
      },
      restartBackoffMs: [10, 20],
    }, {
      afterSpawn: (pid) => { spawnedPids.push(pid); },
    });
    supervisors.push(supervisor);
    const first = await supervisor.start({ ...fixture, startupTimeoutMs: 60_000 });

    process.kill(first.pid, "SIGKILL");
    await waitForEvidence(evidence, "agenttrail.restarted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(spawnedPids).toHaveLength(1);

    await supervisor.shutdown();
    const restarted = await supervisor.start({ ...fixture, startupTimeoutMs: 60_000 });
    expect(restarted.pid).toBeGreaterThan(0);
    expect(spawnedPids).toHaveLength(2);
  }, 180_000);

  it("advances and exhausts finite restart attempts across repeated ready crashes", async () => {
    const fixture = await traceFixture();
    const evidence: AgentTrailEvidence[] = [];
    const supervisor = new AgentTrailSupervisor({
      evidence: (event) => { evidence.push(event); },
      restartBackoffMs: [10, 20],
    });
    supervisors.push(supervisor);
    let ready = await supervisor.start({ ...fixture, startupTimeoutMs: 60_000 });

    process.kill(ready.pid, "SIGKILL");
    const firstRestart = await waitForRestartAttempt(evidence, 1);
    ready = await waitForReadyIncarnation(evidence, firstRestart.incarnation, 65_000);
    process.kill(ready.pid, "SIGKILL");
    const secondRestart = await waitForRestartAttempt(evidence, 2);
    ready = await waitForReadyIncarnation(evidence, secondRestart.incarnation, 65_000);
    process.kill(ready.pid, "SIGKILL");
    await waitForFailureIncarnation(evidence, ready.incarnation);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect([firstRestart.restartAttempt, secondRestart.restartAttempt]).toEqual([1, 2]);
    expect([firstRestart.backoffMs, secondRestart.backoffMs]).toEqual([10, 20]);
    expect(evidence.filter(({ type }) => type === "agenttrail.restarted")).toHaveLength(2);
  }, 240_000);

  it("rejects traces outside the runtime trace directory and unsafe file identities", async () => {
    const fixture = await traceFixture();
    const supervisor = new AgentTrailSupervisor({ evidence: () => undefined });
    supervisors.push(supervisor);
    const outside = path.join(path.dirname(fixture.runtime.traceDirectory), "outside.jsonl");
    await writeFile(outside, "", { mode: 0o600 });

    await expect(supervisor.start({ ...fixture, tracePath: outside, startupTimeoutMs: 100 }))
      .rejects.toThrow(/runtime trace directory/);

    const target = path.join(fixture.runtime.traceDirectory, "target.jsonl");
    await writeFile(target, "", { mode: 0o600 });
    await rm(fixture.tracePath);
    await symlink(target, fixture.tracePath);
    await expect(supervisor.start({ ...fixture, startupTimeoutMs: 100 }))
      .rejects.toThrow(/symlink/);
  });
});

async function traceFixture(name = "trace.jsonl"): Promise<{
  readonly tracePath: string;
  readonly runtime: ProjectRuntimeLayout;
}> {
  const projectRoot = await temporaryDirectory();
  const stateRoot = path.join(projectRoot, ".zentra");
  const traceDirectory = path.join(stateRoot, "traces");
  const runtimeDirectory = path.join(stateRoot, "runtime");
  await mkdir(traceDirectory, { recursive: true, mode: 0o700 });
  await mkdir(runtimeDirectory, { mode: 0o700 });
  await chmod(stateRoot, 0o700);
  const tracePath = path.join(traceDirectory, name);
  await writeFile(tracePath, "", { mode: 0o600 });
  const runtime: ProjectRuntimeLayout = {
    schemaVersion: 1,
    projectRoot,
    stateRoot,
    versionPath: path.join(stateRoot, "VERSION"),
    schemaPath: path.join(stateRoot, "layout.json"),
    databasePath: path.join(stateRoot, "events.sqlite"),
    traceDirectory,
    runtimeDirectory,
    runtimeStatePath: path.join(runtimeDirectory, "state.json"),
    runtimeOwnerPath: path.join(runtimeDirectory, "state.json"),
  };
  expect((await lstat(tracePath)).mode & 0o777).toBe(0o600);
  return { tracePath, runtime };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "zentra-agenttrail-runtime-")));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForEvidence<T extends AgentTrailEvidence["type"]>(
  evidence: AgentTrailEvidence[],
  type: T,
): Promise<Extract<AgentTrailEvidence, { type: T }>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = evidence.find((event): event is Extract<AgentTrailEvidence, { type: T }> => event.type === type);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${type}`);
}

async function waitForReadyIncarnation(
  evidence: AgentTrailEvidence[],
  incarnation: string,
  timeoutMs = 10_000,
): Promise<Extract<AgentTrailEvidence, { type: "agenttrail.ready" }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = evidence.find((event): event is Extract<AgentTrailEvidence, { type: "agenttrail.ready" }> =>
      event.type === "agenttrail.ready" && event.incarnation === incarnation);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ready incarnation ${incarnation}`);
}

async function waitForRestartAttempt(
  evidence: AgentTrailEvidence[],
  attempt: number,
): Promise<Extract<AgentTrailEvidence, { type: "agenttrail.restarted" }>> {
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const found = evidence.find((event): event is Extract<AgentTrailEvidence, { type: "agenttrail.restarted" }> =>
      event.type === "agenttrail.restarted" && event.restartAttempt === attempt);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for restart attempt ${attempt}`);
}

async function waitForFailureIncarnation(
  evidence: AgentTrailEvidence[],
  incarnation: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (evidence.some((event) => event.type === "agenttrail.failed" && event.incarnation === incarnation)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for failed incarnation ${incarnation}`);
}
