import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";

const DOCKER_ENTRYPOINT = "/usr/local/bin/docker";
const APPROVED_DOCKER_EXECUTABLE = "/Applications/Docker.app/Contents/Resources/bin/docker";
const MAX_DOCKER_OUTPUT_BYTES = 4 * 1024 * 1024;
const DOCKER_COMMAND_TIMEOUT_MS = 180_000;
const TERMINATION_GRACE_MS = 1_000;

export interface DockerCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class DockerCommandTimeoutError extends Error {
  constructor() {
    super("Docker command timed out");
    this.name = "DockerCommandTimeoutError";
  }
}

export class DockerCommandCancelledError extends Error {
  constructor() {
    super("Docker command was cancelled");
    this.name = "DockerCommandCancelledError";
  }
}

export class DockerOutputLimitError extends Error {
  constructor() {
    super("Docker command output exceeded its limit");
    this.name = "DockerOutputLimitError";
  }
}

export class DockerClient {
  readonly executable: string;

  constructor() {
    this.executable = realpathSync.native(DOCKER_ENTRYPOINT);
    const stat = statSync(this.executable);
    if (
      this.executable !== APPROVED_DOCKER_EXECUTABLE ||
      !stat.isFile() ||
      (stat.mode & 0o111) === 0
    ) throw new Error("approved Docker executable identity is unavailable");
  }

  run(args: readonly string[], signal: AbortSignal, timeoutMs = DOCKER_COMMAND_TIMEOUT_MS): Promise<DockerCommandResult> {
    return runBoundedProcess(this.executable, args, dockerEnvironment(), signal, timeoutMs);
  }
}

export function runBoundedProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
  cwd?: string,
): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DockerCommandCancelledError());
      return;
    }
    const child = spawn(executable, [...args], {
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
      ...(cwd === undefined ? {} : { cwd }),
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let reason: "cancelled" | "timed_out" | "output" | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const terminate = (terminationReason: typeof reason): void => {
      if (reason !== null) return;
      reason = terminationReason;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), TERMINATION_GRACE_MS);
    };
    const abort = (): void => terminate("cancelled");
    const deadline = setTimeout(() => terminate("timed_out"), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });

    const collect = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (current.length + chunk.length > MAX_DOCKER_OUTPUT_BYTES) {
        terminate("output");
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = collect(stderr, chunk); });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      if (reason === "cancelled") reject(new DockerCommandCancelledError());
      else if (reason === "timed_out") reject(new DockerCommandTimeoutError());
      else if (reason === "output") reject(new DockerOutputLimitError());
      else resolve({ exitCode: code ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    }));

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      action();
    }
  });
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
  if (process.env.HOME !== undefined) environment.HOME = process.env.HOME;
  return environment;
}
