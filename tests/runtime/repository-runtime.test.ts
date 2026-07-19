import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  RUNTIME_SCHEMA_VERSION,
  RuntimeStateManager,
  discoverProject,
  initializeProjectRuntime,
} from "../../src/runtime/repository-runtime.js";

const cleanup: string[] = [];
const execFileAsync = promisify(execFile);
const runtimeModulePath = path.resolve(import.meta.dirname, "../../src/runtime/repository-runtime.ts");
const runtimeWorkerPath = path.resolve(import.meta.dirname, "../../src/runtime/runtime-store-worker.ts");
const bootstrapWorkerPath = path.resolve(import.meta.dirname, "../../src/runtime/runtime-bootstrap-worker.ts");
const competingProcessPath = path.resolve(import.meta.dirname, "competing-runtime-process.mjs");

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repository(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-runtime-"));
  cleanup.push(directory);
  const result = spawnSync("git", ["init", directory], {
    shell: false,
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return realpathSync(directory);
}

async function initializedRepository() {
  const root = repository();
  const discovery = await discoverProject(root);
  return { root, layout: await initializeProjectRuntime(discovery) };
}

function replaceDurableProcessIdentity(
  statePath: string,
  pid: number,
  processIncarnation: string,
  processEvidence = `darwin-ps-v1:${"a".repeat(64)}`,
): void {
  const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  state["pid"] = pid;
  state["processIncarnation"] = processIncarnation;
  state["processEvidence"] = processEvidence;
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function observedProcessEvidence(pid: number): string {
  const result = spawnSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart=", "-o", "uid=", "-o", "ucomm="],
    { shell: false, env: { LANG: "C", LC_ALL: "C" }, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  const fields = result.stdout.trim().replace(/\s+/g, " ").split(" ");
  const evidence = JSON.stringify({
    startTime: fields.slice(0, 5).join(" "),
    uid: fields[5],
    executableName: fields.slice(6).join(" "),
  });
  return `darwin-ps-v1:${createHash("sha256").update(evidence).digest("hex")}`;
}

const startingState = {
  address: { host: "127.0.0.1" as const, port: 43_219 },
  tokenExpiresAt: "2026-07-19T12:00:00.000Z",
  startupStatus: "starting" as const,
};
const CRASHED_INCARNATION = `process-v2:${"c".repeat(64)}`;
const REUSED_INCARNATION = `process-v2:${"d".repeat(64)}`;

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

describe("repository-local runtime bootstrap", () => {
  it("discovers the Git root from a nested directory and returns evidence", async () => {
    const root = repository();
    const nested = path.join(root, "nested", "deeper");
    mkdirSync(nested, { recursive: true });

    const discovered = await discoverProject(nested);

    expect(discovered.root).toBe(root);
    expect(discovered.evidence).toEqual({
      type: "project.discovered",
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      projectRoot: root,
      discoveredFrom: nested,
    });
  });

  it("rejects a location outside a Git worktree", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-not-git-"));
    cleanup.push(directory);
    await expect(discoverProject(directory)).rejects.toThrow(/Git worktree/);
  });

  it("initializes a restrictive fixed layout idempotently", async () => {
    const root = repository();
    const discovery = await discoverProject(root);
    const [first, second] = await Promise.all([
      initializeProjectRuntime(discovery),
      initializeProjectRuntime(discovery),
    ]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      projectRoot: root,
      stateRoot: path.join(root, ".zentra"),
      databasePath: path.join(root, ".zentra", "events.sqlite"),
      traceDirectory: path.join(root, ".zentra", "traces"),
      runtimeDirectory: path.join(root, ".zentra", "runtime"),
    });
    for (const directory of [first.stateRoot, first.traceDirectory, first.runtimeDirectory]) {
      await expect(
        (await import("node:fs/promises")).stat(directory).then((value) => value.mode & 0o777),
      ).resolves.toBe(0o700);
    }
    expect(readFileSync(first.versionPath, "utf8")).toBe(`${RUNTIME_SCHEMA_VERSION}\n`);
    expect(JSON.parse(readFileSync(first.schemaPath, "utf8"))).toEqual({
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      database: "events.sqlite",
      traces: "traces",
      runtime: "runtime",
    });
  });

  it("rejects symlinked state, unsafe permissions, and malformed versions", async () => {
    const symlinkRoot = repository();
    const outside = mkdtempSync(path.join(tmpdir(), "zentra-outside-"));
    cleanup.push(outside);
    symlinkSync(outside, path.join(symlinkRoot, ".zentra"));
    await expect(initializeProjectRuntime(await discoverProject(symlinkRoot))).rejects.toThrow(/symlink|canonical/i);
    expect(existsSync(path.join(outside, "runtime"))).toBe(false);

    const unsafeRoot = repository();
    const unsafe = await initializeProjectRuntime(await discoverProject(unsafeRoot));
    chmodSync(unsafe.stateRoot, 0o755);
    await expect(initializeProjectRuntime(await discoverProject(unsafeRoot))).rejects.toThrow(/permissions/);

    const malformedRoot = repository();
    const malformed = await initializeProjectRuntime(await discoverProject(malformedRoot));
    writeFileSync(malformed.versionPath, "version-next\n", "utf8");
    await expect(initializeProjectRuntime(await discoverProject(malformedRoot))).rejects.toThrow(/version/i);

    const linkedDatabaseRoot = repository();
    const linkedDatabase = await initializeProjectRuntime(await discoverProject(linkedDatabaseRoot));
    symlinkSync(outside, linkedDatabase.databasePath);
    await expect(initializeProjectRuntime(await discoverProject(linkedDatabaseRoot))).rejects.toThrow(/symlink/);
  });

  it("binds initialization effects to the intended .zentra inode", async () => {
    const root = repository();
    const discovery = await discoverProject(root);
    const stateRoot = path.join(root, ".zentra");
    const parked = path.join(root, ".zentra-parked");
    const outside = mkdtempSync(path.join(tmpdir(), "zentra-bootstrap-swap-"));
    cleanup.push(outside);
    let hookCalled = false;
    const initializeWithOptions = initializeProjectRuntime as unknown as (
      value: typeof discovery,
      options: { beforeBootstrap: () => void },
    ) => ReturnType<typeof initializeProjectRuntime>;

    await expect(initializeWithOptions(discovery, {
      beforeBootstrap: () => {
        hookCalled = true;
        renameSync(stateRoot, parked);
        symlinkSync(outside, stateRoot);
      },
    })).rejects.toThrow(/state directory changed|canonical/i);
    expect(hookCalled).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("preserves interrupted marker temp files for explicit reconciliation", async () => {
    const { layout } = await initializedRepository();
    const conforming = path.join(
      layout.stateRoot,
      ".VERSION.00000000-0000-4000-8000-000000000000.tmp",
    );
    const unknown = path.join(layout.stateRoot, ".VERSION.unknown.tmp");
    writeFileSync(conforming, "partial", { mode: 0o600 });
    writeFileSync(unknown, "unknown", { mode: 0o600 });
    utimesSync(conforming, new Date(0), new Date(0));

    await expect(initializeProjectRuntime(await discoverProject(layout.projectRoot))).rejects.toThrow(
      /unknown marker temp residue/i,
    );

    expect(existsSync(conforming)).toBe(true);
    expect(readFileSync(unknown, "utf8")).toBe("unknown");
    rmSync(unknown);
    await initializeProjectRuntime(await discoverProject(layout.projectRoot));
    expect(existsSync(conforming)).toBe(true);
  });

  it("serializes bootstrap workers while one has an active marker temp file", async () => {
    const root = repository();
    const stateRoot = path.join(root, ".zentra");
    mkdirSync(stateRoot, { mode: 0o700 });
    const identity = statSync(stateRoot);
    const ready = path.join(stateRoot, ".bootstrap-test-ready");
    const resume = path.join(stateRoot, ".bootstrap-test-continue");
    const environment = {
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      LANG: "C",
      LC_ALL: "C",
      ZENTRA_RUNTIME_TEST_BOOTSTRAP_PAUSE: "1",
    };
    const first = spawn(
      process.execPath,
      [bootstrapWorkerPath, String(identity.dev), String(identity.ino)],
      { cwd: stateRoot, shell: false, env: environment, stdio: ["ignore", "ignore", "pipe"] },
    );
    const firstExit = waitForExit(first);
    await waitForPath(ready);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const direct = spawn(
      process.execPath,
      [bootstrapWorkerPath, "--operate", String(identity.dev), String(identity.ino)],
      {
        cwd: stateRoot,
        shell: false,
        env: { HOME: environment.HOME, TMPDIR: environment.TMPDIR, LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    expect(await waitForExit(direct)).not.toBe(0);
    const second = spawn(
      process.execPath,
      [bootstrapWorkerPath, String(identity.dev), String(identity.ino)],
      {
        cwd: stateRoot,
        shell: false,
        env: { HOME: environment.HOME, TMPDIR: environment.TMPDIR, LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const secondExit = waitForExit(second);
    let secondExited = false;
    second.once("close", () => { secondExited = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(secondExited).toBe(false);
    expect(readdirSync(stateRoot).some((entry) => /^\.VERSION\..+\.tmp$/.test(entry))).toBe(true);
    writeFileSync(resume, "continue", { mode: 0o600 });
    expect(await firstExit).toBe(0);
    expect(await secondExit).toBe(0);
    expect(readFileSync(path.join(stateRoot, "VERSION"), "utf8")).toBe("1\n");
    expect(readdirSync(stateRoot).some((entry) => /^\.(?:VERSION|layout\.json)\..+\.tmp$/.test(entry))).toBe(false);
  }, 15_000);
});

describe("atomic runtime state", () => {
  it("elects one owner, publishes machine-readable state, and omits raw tokens", async () => {
    const { layout } = await initializedRepository();
    const first = new RuntimeStateManager(layout);
    const second = new RuntimeStateManager(layout);

    await expect(first.start({
      ...startingState,
      sessionToken: "session-token",
    } as typeof startingState & { sessionToken: string })).rejects.toThrow();

    const attempts = await Promise.allSettled([
      first.start(startingState),
      second.start(startingState),
    ]);
    expect(attempts.every((attempt) => attempt.status === "fulfilled")).toBe(true);
    const ownership = attempts[0]!.status === "fulfilled" ? attempts[0]!.value : undefined;
    const recovered = attempts[1]!.status === "fulfilled" ? attempts[1]!.value : undefined;
    expect(ownership).toBeDefined();
    expect(recovered?.claim).toEqual(ownership!.claim);
    expect(ownership!.claim.processIncarnation).toMatch(/^process-v2:[a-f0-9]{64}$/);
    expect(ownership!.evidence).toEqual([
      expect.objectContaining({ type: "service.starting", pid: process.pid }),
      expect.objectContaining({ type: "runtime.published", startupStatus: "starting" }),
    ]);
    expect(await first.read()).toEqual({
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      ...startingState,
      pid: process.pid,
      processIncarnation: ownership!.claim.processIncarnation,
    });
    expect(readFileSync(layout.runtimeStatePath, "utf8")).not.toContain("session-token");
    const durableState = JSON.parse(readFileSync(layout.runtimeStatePath, "utf8"));
    expect(durableState).not.toHaveProperty("ownerToken");
    expect(durableState).not.toHaveProperty("capability");
    expect(durableState.capabilityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(JSON.stringify(ownership!.claim))).toEqual({
      pid: process.pid,
      processIncarnation: ownership!.claim.processIncarnation,
    });

    const owner = first;
    const publication = await owner.publish(ownership!.claim, {
      ...startingState,
      startupStatus: "ready",
    });
    expect(publication).toMatchObject({ type: "runtime.published", startupStatus: "ready" });
    expect((await first.read())?.startupStatus).toBe("ready");
    await owner.remove(ownership!.claim);
    expect(await first.read()).toBeNull();
  });

  it("detects and replaces crash leftovers without signaling an unknown process", async () => {
    const { layout } = await initializedRepository();
    const crashed = new RuntimeStateManager(layout);
    const old = await crashed.start(startingState);
    expect(old.staleEvidence).toBeNull();
    replaceDurableProcessIdentity(layout.runtimeStatePath, 999_999, CRASHED_INCARNATION);

    const recovering = new RuntimeStateManager(layout);
    const current = await recovering.start(startingState);

    expect(current.staleEvidence).toMatchObject({
      type: "runtime.stale_detected",
      stalePid: 999_999,
      reason: "process_not_running",
      processSignalled: false,
    });
    expect((await recovering.read())?.pid).toBe(process.pid);
  });

  it("rejects malformed, escaped, symlinked, or permissive runtime state", async () => {
    const malformedSetup = await initializedRepository();
    writeFileSync(malformedSetup.layout.runtimeStatePath, "not-json", { mode: 0o600 });
    await expect(new RuntimeStateManager(malformedSetup.layout).read()).rejects.toThrow(/runtime state|database/i);

    const linkedSetup = await initializedRepository();
    const outside = path.join(path.dirname(linkedSetup.root), "outside-state.json");
    writeFileSync(outside, JSON.stringify({ schemaVersion: RUNTIME_SCHEMA_VERSION, ...startingState }), { mode: 0o600 });
    cleanup.push(outside);
    symlinkSync(outside, linkedSetup.layout.runtimeStatePath);
    await expect(new RuntimeStateManager(linkedSetup.layout).read()).rejects.toThrow(/symlink/);

    const permissiveSetup = await initializedRepository();
    writeFileSync(permissiveSetup.layout.runtimeStatePath, JSON.stringify({ schemaVersion: RUNTIME_SCHEMA_VERSION, ...startingState }), { mode: 0o644 });
    await expect(new RuntimeStateManager(permissiveSetup.layout).read()).rejects.toThrow(/permissions/);

    const escapedSetup = await initializedRepository();
    const escapedLayout = {
      ...escapedSetup.layout,
      runtimeStatePath: path.join(path.dirname(escapedSetup.root), "escaped-state.json"),
    };
    await expect(new RuntimeStateManager(escapedLayout).read()).rejects.toThrow(/outside the project root/);
  });

  it("keeps effects in the initialized runtime inode during an ancestor symlink swap", async () => {
    const { root, layout } = await initializedRepository();
    const parked = path.join(root, ".zentra", "runtime-parked");
    const outside = mkdtempSync(path.join(tmpdir(), "zentra-runtime-swap-"));
    cleanup.push(outside);
    let hookCalled = false;
    const options = {
      beforeCommand: async () => {
        hookCalled = true;
        renameSync(layout.runtimeDirectory, parked);
        symlinkSync(outside, layout.runtimeDirectory);
      },
    };

    await expect(new RuntimeStateManager(layout, options).start(startingState)).rejects.toThrow(
      /runtime directory changed|canonical/i,
    );
    expect(hookCalled).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("does not follow a swapped final runtime-state symlink", async () => {
    const { layout } = await initializedRepository();
    const outside = path.join(path.dirname(layout.projectRoot), "outside-runtime-state");
    writeFileSync(outside, "unchanged", { mode: 0o600 });
    cleanup.push(outside);
    let hookCalled = false;
    const manager = new RuntimeStateManager(layout, {
      beforeCommand: () => {
        hookCalled = true;
        symlinkSync(outside, layout.runtimeStatePath);
      },
    });

    await expect(manager.start(startingState)).rejects.toThrow(/symlink|state/i);
    expect(hookCalled).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
    expect(lstatSync(layout.runtimeStatePath).isSymbolicLink()).toBe(true);
  });

  it("atomically serializes concurrent stale takeovers", async () => {
    const { layout } = await initializedRepository();
    const crashed = new RuntimeStateManager(layout);
    await crashed.start(startingState);
    replaceDurableProcessIdentity(layout.runtimeStatePath, 999_998, CRASHED_INCARNATION);

    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        new RuntimeStateManager(layout).start(startingState)
      ),
    );
    const owners = attempts.filter((attempt) => attempt.status === "fulfilled");

    expect(owners).toHaveLength(12);
    expect(new Set(owners.map((attempt) =>
      attempt.status === "fulfilled" ? attempt.value.claim.processIncarnation : "unreachable"
    )).size).toBe(1);
    expect(owners.every((attempt) =>
      attempt.status === "fulfilled" && attempt.value.staleEvidence !== null
    )).toBe(true);
    expect(owners.filter((attempt) =>
      attempt.status === "fulfilled" && attempt.value.evidence[1].observation === "performed"
    )).toHaveLength(1);
    expect(owners.filter((attempt) =>
      attempt.status === "fulfilled" && attempt.value.evidence[1].observation === "reconciled"
    )).toHaveLength(11);
    expect(await new RuntimeStateManager(layout).read()).toMatchObject({
      processIncarnation: owners[0]!.status === "fulfilled"
        ? owners[0]!.value.claim.processIncarnation
        : "unreachable",
    });
  });

  it("reclaims a reused PID only when its verifiable incarnation differs", async () => {
    const { layout } = await initializedRepository();
    const old = new RuntimeStateManager(layout);
    await old.start(startingState);
    replaceDurableProcessIdentity(layout.runtimeStatePath, process.pid, REUSED_INCARNATION);

    const replacement = new RuntimeStateManager(layout);
    const ownership = await replacement.start(startingState);

    expect(ownership.staleEvidence).toMatchObject({
      reason: "process_incarnation_changed",
      staleProcessIncarnation: REUSED_INCARNATION,
    });
  });

  it("fails closed when a different PID still has matching OS evidence", async () => {
    const { layout } = await initializedRepository();
    await new RuntimeStateManager(layout).start(startingState);
    replaceDurableProcessIdentity(
      layout.runtimeStatePath,
      1,
      CRASHED_INCARNATION,
      observedProcessEvidence(1),
    );
    const durable = readFileSync(layout.runtimeStatePath, "utf8");

    await expect(new RuntimeStateManager(layout).start(startingState)).rejects.toThrow(
      /already owned by live process 1/i,
    );
    expect(readFileSync(layout.runtimeStatePath, "utf8")).toBe(durable);
  });

  it("recovers an interrupted owner publication without accepting malformed ownership", async () => {
    const { layout } = await initializedRepository();
    writeFileSync(path.join(layout.runtimeDirectory, "owner.json"), "{\"schemaVersion\":1", {
      mode: 0o600,
    });

    const ownership = await new RuntimeStateManager(layout).start(startingState);

    expect(ownership.claim.pid).toBe(process.pid);
    expect(await new RuntimeStateManager(layout).read()).toMatchObject({ pid: process.pid });
  });

  it("serializes concurrent publication and removal without orphaning state", async () => {
    const { layout } = await initializedRepository();
    const manager = new RuntimeStateManager(layout);
    const ownership = await manager.start(startingState);

    await Promise.allSettled([
      manager.publish(ownership.claim, { ...startingState, startupStatus: "ready" }),
      manager.remove(ownership.claim),
    ]);

    expect(await manager.read()).toBeNull();
    await expect(manager.publish(ownership.claim, startingState)).rejects.toThrow(
      /stale|owned|owner|capability|claim/i,
    );
  });

  it("reconciles a durably published start after the helper response is lost", async () => {
    const { layout } = await initializedRepository();
    let dropResponse = true;
    const options = {
      beforeCommand: () => undefined,
      dropStartResponseOnce: () => {
        if (!dropResponse) return false;
        dropResponse = false;
        return true;
      },
    };
    const manager = new RuntimeStateManager(layout, options);

    await expect(manager.start(startingState)).rejects.toThrow(/response|output|uncertain/i);
    const durableBeforeRetry = readFileSync(layout.runtimeStatePath, "utf8");
    const parsedBeforeRetry = JSON.parse(durableBeforeRetry) as {
      processIncarnation: string;
    };

    const recoveryManager = new RuntimeStateManager(layout);
    const recovered = await recoveryManager.start(startingState);

    expect(recovered.claim).toEqual({
      pid: process.pid,
      processIncarnation: parsedBeforeRetry.processIncarnation,
    });
    expect(readFileSync(layout.runtimeStatePath, "utf8")).toBe(durableBeforeRetry);
    await recoveryManager.publish(recovered.claim, { ...startingState, startupStatus: "ready" });
    await recoveryManager.remove(recovered.claim);
    expect(await recoveryManager.read()).toBeNull();
  });

  it("rejects publish and remove from another OS process that copied the claim", async () => {
    const { root, layout } = await initializedRepository();
    await new RuntimeStateManager(layout).start(startingState);
    const durable = readFileSync(layout.runtimeStatePath, "utf8");

    for (const action of ["publish", "remove"]) {
      const result = await execFileAsync(
        process.execPath,
        [competingProcessPath, runtimeWorkerPath, root, action],
        {
          cwd: root,
          shell: false,
          env: {
            HOME: process.env.HOME ?? "",
            TMPDIR: process.env.TMPDIR ?? "",
            LANG: "C",
            LC_ALL: "C",
          },
        },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        accepted: false,
        error: expect.stringMatching(/caller|owner|pid|process|capability/i),
      });
      expect(readFileSync(layout.runtimeStatePath, "utf8")).toBe(durable);
    }

    const runtimeDirectory = layout.runtimeDirectory;
    const lockReady = path.join(runtimeDirectory, ".held-lock-ready");
    const lockContinue = path.join(runtimeDirectory, ".held-lock-continue");
    const holderScript = `const fs=require("node:fs");const [ready,resume]=process.argv.slice(1);fs.writeFileSync(ready,"ready",{mode:0o600});while(!fs.existsSync(resume))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`;
    const holder = spawn(
      "/usr/bin/lockf",
      ["-k", "lifecycle.lock", process.execPath, "-e", holderScript, lockReady, lockContinue],
      {
        cwd: runtimeDirectory,
        shell: false,
        env: { LANG: "C", LC_ALL: "C" },
        stdio: "ignore",
      },
    );
    const holderExit = waitForExit(holder);
    await waitForPath(lockReady);
    const bypass = await execFileAsync(
      process.execPath,
      [competingProcessPath, runtimeWorkerPath, root, "direct-publish"],
      {
        cwd: root,
        shell: false,
        env: { HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "", LANG: "C", LC_ALL: "C" },
      },
    );
    writeFileSync(lockContinue, "continue", { mode: 0o600 });
    expect(await holderExit).toBe(0);
    expect(JSON.parse(bypass.stdout)).toMatchObject({
      accepted: false,
      error: expect.stringMatching(/packet|capability|internal operation/i),
    });
    expect(readFileSync(layout.runtimeStatePath, "utf8")).toBe(durable);
  });

  it("requires explicit handoff for separately loaded ESM copies", async () => {
    const { root, layout } = await initializedRepository();
    const first = await new RuntimeStateManager(layout).start(startingState);
    const copy = await import(
      `${pathToFileURL(runtimeModulePath).href}?copy=${Date.now()}`
    ) as typeof import("../../src/runtime/repository-runtime.js");
    const copyLayout = await copy.initializeProjectRuntime(await copy.discoverProject(root));

    const durable = readFileSync(layout.runtimeStatePath, "utf8");
    expect((await new copy.RuntimeStateManager(copyLayout).read())?.processIncarnation)
      .toBe(first.claim.processIncarnation);
    await expect(new copy.RuntimeStateManager(copyLayout).start(startingState)).rejects.toThrow(
      /capability|handoff|owned/i,
    );
    expect(readFileSync(layout.runtimeStatePath, "utf8")).toBe(durable);
  });

  it("does not authorize a claim after package-safe serialization", async () => {
    const { layout } = await initializedRepository();
    const manager = new RuntimeStateManager(layout);
    const ownership = await manager.start(startingState);
    const serializedClaim = JSON.parse(JSON.stringify(ownership.claim));

    await expect(manager.publish(serializedClaim, {
      ...startingState,
      startupStatus: "ready",
    })).rejects.toThrow(/capability|claim/i);
  });

  it("rejects a claim acquired for a different runtime directory", async () => {
    const first = await initializedRepository();
    const second = await initializedRepository();
    const firstOwnership = await new RuntimeStateManager(first.layout).start(startingState);
    const secondManager = new RuntimeStateManager(second.layout);
    const secondOwnership = await secondManager.start({
      ...startingState,
      address: { host: "127.0.0.1", port: 43_221 },
    });
    const secondDurable = readFileSync(second.layout.runtimeStatePath, "utf8");

    await expect(secondManager.publish(firstOwnership.claim, {
      ...startingState,
      startupStatus: "ready",
    })).rejects.toThrow(/runtime|layout|directory|capability/i);
    await expect(secondManager.remove(firstOwnership.claim)).rejects.toThrow(
      /runtime|layout|directory|capability/i,
    );
    expect(readFileSync(second.layout.runtimeStatePath, "utf8")).toBe(secondDurable);
    await secondManager.remove(secondOwnership.claim);
  });

  it("revokes an old claim when removal is followed by a new acquisition", async () => {
    const { layout } = await initializedRepository();
    const manager = new RuntimeStateManager(layout);
    const first = await manager.start(startingState);
    const firstAcquisition = JSON.parse(readFileSync(layout.runtimeStatePath, "utf8")).acquisitionId;
    await manager.remove(first.claim);

    const second = await manager.start(startingState);
    const secondAcquisition = JSON.parse(readFileSync(layout.runtimeStatePath, "utf8")).acquisitionId;

    expect(secondAcquisition).not.toBe(firstAcquisition);
    await expect(manager.publish(first.claim, {
      ...startingState,
      startupStatus: "ready",
    })).rejects.toThrow(/revoked|capability|claim/i);
    await manager.publish(second.claim, { ...startingState, startupStatus: "ready" });
  });

  it("reconciles lost stale-takeover evidence with original durable timestamps", async () => {
    const { layout } = await initializedRepository();
    await new RuntimeStateManager(layout).start(startingState);
    replaceDurableProcessIdentity(layout.runtimeStatePath, 999_996, CRASHED_INCARNATION);
    let dropResponse = true;
    const uncertainManager = new RuntimeStateManager(layout, {
      dropStartResponseOnce: () => {
        if (!dropResponse) return false;
        dropResponse = false;
        return true;
      },
    });

    await expect(uncertainManager.start(startingState)).rejects.toThrow(/response|output/i);
    const durable = readFileSync(layout.runtimeStatePath, "utf8");
    const accepted = JSON.parse(durable) as {
      acquiredAt: string;
      publishedAt: string;
      staleDecision: {
        pid: number;
        processIncarnation: string;
        reason: string;
        detectedAt: string;
      };
    };

    const recovered = await new RuntimeStateManager(layout).start(startingState);

    expect(recovered.evidence[0]).toMatchObject({
      observation: "reconciled",
      occurredAt: accepted.acquiredAt,
    });
    expect(recovered.evidence[1]).toMatchObject({
      observation: "reconciled",
      occurredAt: accepted.publishedAt,
    });
    expect(recovered.staleEvidence).toMatchObject({
      stalePid: accepted.staleDecision.pid,
      staleProcessIncarnation: accepted.staleDecision.processIncarnation,
      reason: accepted.staleDecision.reason,
      detectedAt: accepted.staleDecision.detectedAt,
    });
    expect(readFileSync(layout.runtimeStatePath, "utf8")).toBe(durable);
  });

  it("rejects hard-linked markers, database, owner, and state files", async () => {
    const markerSetup = await initializedRepository();
    linkSync(markerSetup.layout.versionPath, path.join(markerSetup.root, "version-alias"));
    await expect(initializeProjectRuntime(await discoverProject(markerSetup.root))).rejects.toThrow(/hard link/);

    const databaseSetup = await initializedRepository();
    writeFileSync(databaseSetup.layout.databasePath, "database", { mode: 0o600 });
    linkSync(databaseSetup.layout.databasePath, path.join(databaseSetup.root, "database-alias"));
    await expect(initializeProjectRuntime(await discoverProject(databaseSetup.root))).rejects.toThrow(/hard link/);

    const ownerSetup = await initializedRepository();
    writeFileSync(ownerSetup.layout.runtimeOwnerPath, "partial owner", { mode: 0o600 });
    linkSync(ownerSetup.layout.runtimeOwnerPath, path.join(ownerSetup.root, "owner-alias"));
    await expect(new RuntimeStateManager(ownerSetup.layout).start(startingState)).rejects.toThrow(/hard link/);

    const stateSetup = await initializedRepository();
    const manager = new RuntimeStateManager(stateSetup.layout);
    await manager.start(startingState);
    linkSync(stateSetup.layout.runtimeStatePath, path.join(stateSetup.root, "state-alias"));
    await expect(manager.read()).rejects.toThrow(/hard link/);
  });

  it("rejects caller-supplied PID authority", async () => {
    const { layout } = await initializedRepository();

    await expect(new RuntimeStateManager(layout).start({
      ...startingState,
      pid: 1,
    } as typeof startingState & { pid: number })).rejects.toThrow(/pid|unrecognized/i);
    expect(await new RuntimeStateManager(layout).read()).toBeNull();
  });

  it("validates durable state before replacing a stale owner", async () => {
    const { layout } = await initializedRepository();
    const manager = new RuntimeStateManager(layout);
    await manager.start(startingState);
    writeFileSync(layout.runtimeStatePath, "not-json", { mode: 0o600 });

    await expect(new RuntimeStateManager(layout).start(startingState)).rejects.toThrow(
      /malformed|schema|state/i,
    );
  });

  it("rejects unsafe SQLite sidecar paths before opening state", async () => {
    const { layout } = await initializedRepository();
    const outside = path.join(path.dirname(layout.projectRoot), "outside-journal");
    writeFileSync(outside, "unchanged", { mode: 0o600 });
    cleanup.push(outside);
    symlinkSync(outside, path.join(layout.runtimeDirectory, "state.sqlite-journal"));

    await expect(new RuntimeStateManager(layout).start(startingState)).rejects.toThrow(
      /sidecar|symlink/i,
    );
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
  });
});

describe("Git discovery executable identity", () => {
  it("does not resolve Git from ambient PATH", async () => {
    const root = repository();
    const fakeBin = mkdtempSync(path.join(tmpdir(), "zentra-fake-git-"));
    cleanup.push(fakeBin);
    const marker = path.join(fakeBin, "invoked");
    const fakeGit = path.join(fakeBin, "git");
    writeFileSync(fakeGit, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");\nprocess.stdout.write(${JSON.stringify(`${root}\n${path.join(root, ".git")}\ntrue\n`)});\n`, { mode: 0o700 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    try {
      expect((await discoverProject(root)).root).toBe(root);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});
