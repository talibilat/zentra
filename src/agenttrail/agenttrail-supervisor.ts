import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";

import type { ProjectRuntimeLayout } from "../runtime/repository-runtime.js";
import {
  AGENTTRAIL_EVENT_SCHEMA_VERSION,
  AgentTrailEvidenceSchema,
  type AgentTrailEvidence,
  type AgentTrailFailedEvidence,
  type AgentTrailReadyEvidence,
  type AgentTrailRestartedEvidence,
  type AgentTrailStartingEvidence,
} from "./agenttrail-events.js";
import { resolvePackagedAgentTrail, type PackagedAgentTrail } from "./package-attestation.js";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_RESTART_BACKOFF_MS = [100, 500, 2_000, 5_000] as const;
const TERMINATION_GRACE_MS = 500;
const FORCED_TERMINATION_MS = 1_000;
const PROCESS_POLL_MS = 10;
const READINESS_RETRY_MS = 25;
const READY_PATTERN = /AgentTrail serve mode listening on http:\/\/127\.0\.0\.1:(\d+)\//;

export type {
  AgentTrailEvidence,
  AgentTrailFailedEvidence,
  AgentTrailReadyEvidence,
  AgentTrailRestartedEvidence,
  AgentTrailStartingEvidence,
} from "./agenttrail-events.js";

export interface AgentTrailReady {
  readonly pid: number;
  readonly incarnation: string;
  readonly executableSha256: string;
  readonly address: { readonly host: "127.0.0.1"; readonly port: number };
}

export interface AgentTrailStartRequest {
  readonly tracePath: string;
  readonly runtime: ProjectRuntimeLayout;
  readonly startupTimeoutMs: number;
}

export interface AgentTrailSupervisorOptions {
  readonly evidence: (event: AgentTrailEvidence) => void | Promise<void>;
  readonly maxOutputBytes?: number;
  readonly restartBackoffMs?: readonly number[];
}

interface AgentTrailSupervisorTestSeam {
  readonly beforeSpawn?: (executablePath: string) => void | Promise<void>;
  readonly afterSpawn?: (pid: number) => void | Promise<void>;
  readonly beforeTerminate?: (pid: number) => void | Promise<void>;
}

const TEST_SEAM_AUTHORITY = Symbol("AgentTrailSupervisorTestSeam");

interface RunningProcess {
  readonly child: ChildProcess & { readonly stdout: Readable; readonly stderr: Readable };
  readonly package: PackagedAgentTrail;
  readonly incarnation: string;
  readonly startedAt: number;
  ready: boolean;
  expectedExit: boolean;
  outputExceeded: boolean;
  cancelStartup: ((error: Error) => void) | null;
  readonly executableDescriptor: FileHandle;
  executableDescriptorClosed: boolean;
}

interface MaterializedExecutable {
  readonly path: string;
  readonly descriptor: FileHandle;
}

export class AgentTrailSupervisor {
  private readonly emit: (event: AgentTrailEvidence) => void | Promise<void>;
  private readonly maxOutputBytes: number;
  private readonly restartBackoffMs: readonly number[];
  private running: RunningProcess | null = null;
  private request: AgentTrailStartRequest | null = null;
  private shuttingDown = false;
  private restartAttempt = 0;
  private outputStdout = Buffer.alloc(0);
  private outputStderr = Buffer.alloc(0);
  private environment: Readonly<Record<string, string>> | null = null;
  private environmentRoot: string | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private evidenceTail = Promise.resolve();
  private lastEvidenceFailure: Error | null = null;

  constructor(
    options: AgentTrailSupervisorOptions,
    testSeam: AgentTrailSupervisorTestSeam = {},
    testAuthority?: symbol,
  ) {
    if (Object.keys(testSeam).length > 0 && testAuthority !== TEST_SEAM_AUTHORITY) {
      throw new Error("AgentTrail internal test seam is unavailable in production composition");
    }
    if (typeof options?.evidence !== "function") throw new Error("AgentTrail evidence sink is required");
    const unknown = Object.keys(options).filter((key) =>
      key !== "evidence" && key !== "maxOutputBytes" && key !== "restartBackoffMs");
    if (unknown.length > 0) throw new Error(`AgentTrail supervisor received unknown option: ${unknown[0]}`);
    this.emit = options.evidence;
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes");
    this.restartBackoffMs = (options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS)
      .map((value) => nonnegativeDuration(value, "restartBackoffMs"));
    this.testSeam = testSeam;
  }

  private readonly testSeam: AgentTrailSupervisorTestSeam;

  async start(request: AgentTrailStartRequest): Promise<AgentTrailReady> {
    if (this.running !== null || this.request !== null) throw new Error("AgentTrail supervisor is already started");
    nonnegativeDuration(request.startupTimeoutMs, "startupTimeoutMs");
    const tracePath = await validateTracePath(request.runtime, request.tracePath);
    this.request = { ...request, tracePath };
    this.shuttingDown = false;
    this.restartAttempt = 0;
    try {
      await this.createEnvironment();
      return await this.launch(false, null, 0);
    } catch (error) {
      this.request = null;
      if (this.running === null) {
        await this.removeEnvironment();
      }
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.request = null;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const running = this.running;
    if (running !== null) {
      running.cancelStartup?.(new Error("AgentTrail startup was cancelled by shutdown"));
      running.expectedExit = true;
      await this.terminate(running.child.pid);
      await this.closeExecutable(running);
      if (this.running === running) this.running = null;
    }
    if (this.running === null) {
      await this.removeEnvironment();
    }
  }

  acceptingTasks(): true {
    return true;
  }

  stdout(): string {
    return this.outputStdout.toString("utf8");
  }

  stderr(): string {
    return this.outputStderr.toString("utf8");
  }

  environmentKeys(): readonly string[] {
    return Object.keys(this.environment ?? {}).sort();
  }

  evidenceFailure(): Error | null {
    return this.lastEvidenceFailure;
  }

  private async launch(
    restarted: boolean,
    previousIncarnation: string | null,
    backoffMs: number,
  ): Promise<AgentTrailReady> {
    const request = this.request;
    if (request === null || this.shuttingDown) throw new Error("AgentTrail supervisor is stopping");
    if (this.running !== null) throw new Error("AgentTrail launch refused while a process identity is retained");
    const packaged = await resolvePackagedAgentTrail();
    const incarnation = `agenttrail-v1:${randomUUID()}`;
    const startedAt = performance.now();
    await this.emitEvidence({
      type: "agenttrail.starting",
      ...evidenceIdentity(packaged, incarnation),
      pid: null,
      startupDeadlineMs: request.startupTimeoutMs,
      tracePathSha256: createHash("sha256").update(request.tracePath).digest("hex"),
    });
    if (restarted && previousIncarnation !== null) {
      await this.emitEvidence({
        type: "agenttrail.restarted",
        ...evidenceIdentity(packaged, incarnation),
        pid: null,
        previousIncarnation,
        restartAttempt: this.restartAttempt,
        backoffMs,
      });
    }
    if (this.shuttingDown || this.request !== request || this.running !== null) {
      throw new Error("AgentTrail supervisor stopped before replacement spawn");
    }
    this.outputStdout = Buffer.alloc(0);
    this.outputStderr = Buffer.alloc(0);
    let child: RunningProcess["child"];
    let materialized: MaterializedExecutable | null = null;
    try {
      materialized = await this.materializeExecutable(packaged, incarnation);
      await this.testSeam.beforeSpawn?.(materialized.path);
      await this.assertMaterializedPathIdentity(materialized, packaged.executableSha256);
      child = spawn(materialized.path, [
        "serve", request.tracePath,
        "--host", "127.0.0.1",
        "--port", "0",
        "--metadata-only",
      ], {
        cwd: this.environmentRoot ?? undefined,
        detached: true,
        shell: false,
        env: this.environment ?? {},
        stdio: ["ignore", "pipe", "pipe"],
      }) as RunningProcess["child"];
    } catch (error) {
      await materialized?.descriptor.close();
      await this.recordPreSpawnFailure(packaged, incarnation, startedAt, error);
      throw new Error("AgentTrail failed to start");
    }
    const running: RunningProcess = {
      child,
      package: packaged,
      incarnation,
      startedAt,
      ready: false,
      expectedExit: false,
      outputExceeded: false,
      cancelStartup: null,
      executableDescriptor: materialized.descriptor,
      executableDescriptorClosed: false,
    };
    this.running = running;

    let startupSettled = false;
    let probeStarted = false;
    let readyEvidencePending = false;
    let readinessBuffer = "";
    let resolveStartup!: (ready: AgentTrailReady) => void;
    let rejectStartup!: (error: Error) => void;
    const readinessAbort = new AbortController();
    const startup = new Promise<AgentTrailReady>((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    const deadlineAt = performance.now() + request.startupTimeoutMs;
    const deadline = setTimeout(() => {
      void failStartup("readiness_timeout", "AgentTrail readiness deadline exceeded", null, null);
    }, request.startupTimeoutMs);
    running.cancelStartup = (error) => {
      if (startupSettled) return;
      startupSettled = true;
      running.cancelStartup = null;
      clearTimeout(deadline);
      readinessAbort.abort();
      rejectStartup(error);
    };

    const failStartup = async (
      code: AgentTrailFailedEvidence["failure"]["code"],
      message: string,
      exitCode: number | null,
      signal: string | null,
    ): Promise<void> => {
      if (startupSettled) return;
      startupSettled = true;
      running.cancelStartup = null;
      clearTimeout(deadline);
      readinessAbort.abort();
      try {
        await this.failAndTerminate(running, "startup", code, { message, exitCode, signal });
      } catch (error) {
        this.rememberEvidenceFailure(error);
      }
      rejectStartup(new Error(message));
    };

    const probeReadiness = async (port: number): Promise<void> => {
      while (!startupSettled && this.running === running && !this.shuttingDown) {
        const remaining = deadlineAt - performance.now();
        if (remaining <= 0) return;
        if (await probeLoopback(
          port,
          Math.min(1_000, Math.max(1, Math.floor(remaining))),
          readinessAbort.signal,
        )) {
          if (readyEvidencePending || startupSettled) return;
          readyEvidencePending = true;
          readinessAbort.abort();
          const ready: AgentTrailReady = {
            pid: child.pid ?? -1,
            incarnation,
            executableSha256: packaged.executableSha256,
            address: { host: "127.0.0.1", port },
          };
          try {
            await this.emitEvidence({
              type: "agenttrail.ready",
              ...evidenceIdentity(running.package, running.incarnation),
              pid: ready.pid,
              address: ready.address,
              startupMs: elapsedMs(startedAt),
            });
            if (
              startupSettled || this.shuttingDown || this.running !== running ||
              child.pid === undefined || !processGroupExists(child.pid)
            ) {
              return;
            }
            running.ready = true;
            startupSettled = true;
            running.cancelStartup = null;
            clearTimeout(deadline);
            resolveStartup(ready);
          } catch (error) {
            if (startupSettled) return;
            startupSettled = true;
            running.cancelStartup = null;
            clearTimeout(deadline);
            this.rememberEvidenceFailure(error);
            running.expectedExit = true;
            try {
              await this.terminate(child.pid);
              await this.closeExecutable(running);
            } catch (terminationError) {
              this.rememberEvidenceFailure(terminationError);
            } finally {
              if ((child.pid === undefined || !processGroupExists(child.pid)) && this.running === running) {
                this.running = null;
              }
            }
            rejectStartup(asError(error));
          }
          return;
        }
        await delay(Math.min(READINESS_RETRY_MS, Math.max(1, deadlineAt - performance.now())));
      }
    };

    const capture = (destination: "stdout" | "stderr", chunk: Buffer): void => {
      const current = destination === "stdout" ? this.outputStdout : this.outputStderr;
      const retained = Buffer.concat([current, chunk]).subarray(0, this.maxOutputBytes);
      if (destination === "stdout") this.outputStdout = retained;
      else this.outputStderr = retained;
      if (destination === "stdout" && !running.ready && !probeStarted) {
        readinessBuffer = `${readinessBuffer}${chunk.toString("utf8")}`.slice(-4_096);
        const match = READY_PATTERN.exec(readinessBuffer);
        if (match !== null) {
          probeStarted = true;
          void probeReadiness(Number(match[1]));
        }
      }
      if (!running.outputExceeded && current.byteLength + chunk.byteLength > this.maxOutputBytes) {
        running.outputExceeded = true;
        if (!startupSettled) {
          void failStartup("output_limit", "AgentTrail output exceeded its bounded capture limit", null, null);
        } else {
          void this.handleRuntimeFailure(running, "output_limit", {
            message: "AgentTrail output exceeded its bounded capture limit",
            exitCode: null,
            signal: null,
          });
        }
      }
    };

    // Listener installation is deliberately the first operation after spawn.
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", (error) => {
      if (!startupSettled) void failStartup("spawn_error", "AgentTrail failed to start", null, null);
      else this.rememberEvidenceFailure(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      if (running.expectedExit || this.shuttingDown) return;
      if (!startupSettled) {
        void failStartup("process_exit", "AgentTrail exited before readiness", code, signal);
      } else if (running.ready && !running.outputExceeded) {
        void this.handleRuntimeFailure(running, "process_exit", {
          message: "AgentTrail exited after readiness",
          exitCode: code,
          signal,
        });
      }
    });

    await this.testSeam.afterSpawn?.(child.pid ?? -1);
    if (startupSettled || this.shuttingDown || running.expectedExit || this.running !== running) {
      return startup;
    }

    return startup;
  }

  private async handleRuntimeFailure(
    running: RunningProcess,
    code: AgentTrailFailedEvidence["failure"]["code"],
    failure: Omit<AgentTrailFailedEvidence["failure"], "code">,
  ): Promise<void> {
    let failureRecorded = false;
    try {
      await this.failAndTerminate(running, "runtime", code, failure);
      failureRecorded = true;
    } catch (error) {
      this.rememberEvidenceFailure(error);
    }
    if (failureRecorded) {
      await this.scheduleRestart(running.incarnation);
    }
  }

  private async failAndTerminate(
    running: RunningProcess,
    phase: AgentTrailFailedEvidence["phase"],
    code: AgentTrailFailedEvidence["failure"]["code"],
    failure: Omit<AgentTrailFailedEvidence["failure"], "code">,
  ): Promise<void> {
    running.expectedExit = true;
    await this.terminate(running.child.pid);
    await this.closeExecutable(running);
    await this.recordFailure(running, phase, code, failure);
  }

  private async recordFailure(
    running: RunningProcess,
    phase: AgentTrailFailedEvidence["phase"],
    code: AgentTrailFailedEvidence["failure"]["code"],
    failure: Omit<AgentTrailFailedEvidence["failure"], "code">,
  ): Promise<void> {
    if (this.running === running) this.running = null;
    await this.emitEvidence({
      type: "agenttrail.failed",
      ...evidenceIdentity(running.package, running.incarnation),
      pid: running.child.pid ?? null,
      phase,
      uptimeMs: elapsedMs(running.startedAt),
      failure: { code, ...failure, message: redactFailure(failure.message) },
    });
  }

  private async scheduleRestart(previousIncarnation: string): Promise<void> {
    if (this.shuttingDown || this.request === null || this.restartTimer !== null) return;
    const backoffMs = this.restartBackoffMs[this.restartAttempt];
    if (backoffMs === undefined) return;
    this.restartAttempt += 1;
    await new Promise<void>((resolve) => {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        resolve();
      }, backoffMs);
    });
    if (this.shuttingDown || this.request === null) return;
    try {
      await this.launch(true, previousIncarnation, backoffMs);
    } catch (error) {
      this.rememberEvidenceFailure(error);
    }
  }

  private async createEnvironment(): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), "zentra-agenttrail-"));
    try {
      const canonicalRoot = await realpath(root);
      const home = path.join(canonicalRoot, "home");
      const temporary = path.join(canonicalRoot, "tmp");
      await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(temporary, { mode: 0o700 })]);
      this.environmentRoot = canonicalRoot;
      this.environment = { HOME: home, TMPDIR: temporary, LANG: "C", LC_ALL: "C" };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  private async removeEnvironment(): Promise<void> {
    const root = this.environmentRoot;
    this.environmentRoot = null;
    this.environment = null;
    if (root !== null) await rm(root, { recursive: true, force: true });
  }

  private async materializeExecutable(
    packaged: PackagedAgentTrail,
    incarnation: string,
  ): Promise<MaterializedExecutable> {
    const root = this.environmentRoot;
    if (root === null) throw new Error("AgentTrail private environment is unavailable");
    const executablePath = path.join(root, `agenttrail-${incarnation.slice("agenttrail-v1:".length)}`);
    const descriptor = await open(
      executablePath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o700,
    );
    try {
      await descriptor.writeFile(packaged.executableBytes);
      await descriptor.sync();
      const before = await descriptor.stat();
      const verifiedBytes = Buffer.alloc(packaged.executableBytes.byteLength);
      const read = await descriptor.read(verifiedBytes, 0, verifiedBytes.byteLength, 0);
      const after = await descriptor.stat();
      if (
        !before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o700 ||
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        read.bytesRead !== verifiedBytes.byteLength ||
        createHash("sha256").update(verifiedBytes).digest("hex") !== packaged.executableSha256
      ) {
        throw new Error("Materialized AgentTrail executable has an unsafe identity");
      }
      const metadata = await lstat(executablePath);
      const canonical = await realpath(executablePath);
      if (
        canonical !== executablePath || !metadata.isFile() || metadata.nlink !== 1 ||
        (metadata.mode & 0o777) !== 0o700
      ) {
        throw new Error("Materialized AgentTrail executable does not match reviewed bytes");
      }
      return { path: canonical, descriptor };
    } catch (error) {
      await descriptor.close();
      throw error;
    }
  }

  private async recordPreSpawnFailure(
    packaged: PackagedAgentTrail,
    incarnation: string,
    startedAt: number,
    error: unknown,
  ): Promise<void> {
    await this.emitEvidence({
      type: "agenttrail.failed",
      ...evidenceIdentity(packaged, incarnation),
      pid: null,
      phase: "startup",
      uptimeMs: elapsedMs(startedAt),
      failure: {
        code: "spawn_error",
        message: redactFailure(asError(error).message || "AgentTrail failed to start"),
        exitCode: null,
        signal: null,
      },
    });
  }

  private async assertMaterializedPathIdentity(
    materialized: MaterializedExecutable,
    executableSha256: string,
  ): Promise<void> {
    const [descriptorMetadata, pathMetadata, canonical] = await Promise.all([
      materialized.descriptor.stat(),
      lstat(materialized.path),
      realpath(materialized.path),
    ]);
    const bytes = Buffer.alloc(descriptorMetadata.size);
    const read = await materialized.descriptor.read(bytes, 0, bytes.byteLength, 0);
    if (
      canonical !== materialized.path || pathMetadata.isSymbolicLink() || !pathMetadata.isFile() ||
      pathMetadata.nlink !== 1 || (pathMetadata.mode & 0o777) !== 0o700 ||
      pathMetadata.dev !== descriptorMetadata.dev || pathMetadata.ino !== descriptorMetadata.ino ||
      pathMetadata.size !== descriptorMetadata.size || read.bytesRead !== bytes.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== executableSha256
    ) {
      throw new Error("Materialized AgentTrail launch pathname changed after descriptor verification");
    }
  }

  private async terminate(pid: number | undefined): Promise<void> {
    if (pid === undefined) return;
    await this.testSeam.beforeTerminate?.(pid);
    await terminateProcessGroup(pid);
  }

  private async closeExecutable(running: RunningProcess): Promise<void> {
    if (running.executableDescriptorClosed) return;
    await running.executableDescriptor.close();
    running.executableDescriptorClosed = true;
  }

  private async emitEvidence(candidate: AgentTrailEvidence): Promise<void> {
    const event = AgentTrailEvidenceSchema.parse(candidate);
    const result = this.evidenceTail.then(() => this.emit(event));
    this.evidenceTail = result.then(() => undefined, () => undefined);
    await result;
  }

  private rememberEvidenceFailure(error: unknown): void {
    this.lastEvidenceFailure = asError(error);
  }
}

function evidenceIdentity(packaged: PackagedAgentTrail, incarnation: string) {
  return {
    schemaVersion: AGENTTRAIL_EVENT_SCHEMA_VERSION,
    executableSha256: packaged.executableSha256,
    manifestSha256: packaged.manifestSha256,
    incarnation,
    occurredAt: new Date().toISOString(),
  } as const;
}

export function createAgentTrailSupervisorForTesting(
  options: AgentTrailSupervisorOptions,
  seam: AgentTrailSupervisorTestSeam,
): AgentTrailSupervisor {
  return new AgentTrailSupervisor(options, seam, TEST_SEAM_AUTHORITY);
}

async function validateTracePath(runtime: ProjectRuntimeLayout, candidate: string): Promise<string> {
  const expectedStateRoot = path.join(runtime.projectRoot, ".zentra");
  const expectedTraceRoot = path.join(expectedStateRoot, "traces");
  if (runtime.stateRoot !== expectedStateRoot || runtime.traceDirectory !== expectedTraceRoot) {
    throw new Error("AgentTrail requires the repository runtime trace directory");
  }
  const traceRoot = await realpath(runtime.traceDirectory);
  if (traceRoot !== runtime.traceDirectory || path.dirname(candidate) !== traceRoot) {
    throw new Error("AgentTrail trace path must be a direct child of the runtime trace directory");
  }
  const rootMetadata = await lstat(traceRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory() || (rootMetadata.mode & 0o777) !== 0o700) {
    throw new Error("AgentTrail runtime trace directory has an unsafe identity");
  }
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) throw new Error("AgentTrail trace path must not be a symlink");
  if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("AgentTrail trace path must be a regular single-link file");
  if ((metadata.mode & 0o777) !== 0o600) throw new Error("AgentTrail trace path has unsafe permissions");
  const canonical = await realpath(candidate);
  if (canonical !== candidate) throw new Error("AgentTrail trace path must have a canonical identity");
  return canonical;
}

function probeLoopback(port: number, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(ready);
    };
    const request = get({
      host: "127.0.0.1",
      port,
      path: "/",
      timeout: timeoutMs,
      agent: false,
    }, (response) => {
      response.resume();
      finish(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 500);
    });
    const abort = (): void => {
      request.destroy();
      finish(false);
    };
    signal.addEventListener("abort", abort, { once: true });
    request.once("timeout", () => request.destroy());
    request.once("error", () => finish(false));
  });
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function nonnegativeDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`${label} must be a finite nonnegative duration`);
  }
  return value;
}

function redactFailure(message: string): string {
  return message
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .replace(/\/(?:[^\s/:]+\/)+[^\s/:]*/g, "[path]")
    .slice(0, 512);
}

async function terminateProcessGroup(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (processGroupExists(pid)) {
    signalProcessGroup(pid, "SIGTERM");
    if (await waitForProcessGroupExit(pid, TERMINATION_GRACE_MS)) return;
  }
  if (processGroupExists(pid)) signalProcessGroup(pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(pid, FORCED_TERMINATION_MS))) {
    throw new Error("AgentTrail process group survived bounded termination");
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (processGroupExists(pid)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(PROCESS_POLL_MS, remaining));
  }
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
