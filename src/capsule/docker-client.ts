import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { z } from "zod";
import { StringDecoder } from "node:string_decoder";

const DOCKER_ENTRYPOINT = "/usr/local/bin/docker";
const APPROVED_DOCKER_EXECUTABLE = "/Applications/Docker.app/Contents/Resources/bin/docker";
const MAX_DOCKER_OUTPUT_BYTES = 4 * 1024 * 1024;
const DOCKER_COMMAND_TIMEOUT_MS = 180_000;
const TERMINATION_GRACE_MS = 1_000;
const BROKER_TERMINATION_GRACE_MS = 1_000;
const MAX_BROKER_FRAME_BYTES = 256 * 1024;
const MAX_BROKER_RESPONSE_BYTES = 4 * 1024 * 1024;

const BrokerRequestIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const DockerBrokerFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("model_turn"), requestId: BrokerRequestIdSchema, prompt: z.string().min(1).max(256 * 1024) }),
  z.strictObject({ type: z.literal("research_request"), requestId: BrokerRequestIdSchema,
    capability: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/).default("web_research"), method: z.string().min(1).max(16).regex(/^[A-Z]+$/),
    url: z.string().min(1).max(16_384) }),
]);
export type DockerBrokerFrame = z.infer<typeof DockerBrokerFrameSchema>;

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

export class DockerBrokerTransportUncertainError extends Error {
  constructor() {
    super("Model broker did not acknowledge termination; transport outcome is uncertain");
    this.name = "DockerBrokerTransportUncertainError";
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

  runBrokered(
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs: number,
    exchange: (request: DockerBrokerFrame, signal: AbortSignal) => Promise<unknown>,
  ): Promise<DockerCommandResult> {
    return runBrokeredDockerProcess(this.executable, args, dockerEnvironment(), signal, timeoutMs, exchange);
  }
}

export function runBrokeredDockerProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
  exchange: (request: DockerBrokerFrame, signal: AbortSignal) => Promise<unknown>,
): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DockerCommandCancelledError());
    const child = spawn(executable, [...args], {
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: environment,
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let pendingLine = "";
    const frameDecoder = new StringDecoder("utf8");
    let reason: "cancelled" | "timed_out" | "output" | "protocol" | null = null;
    let chain: Promise<void> = Promise.resolve();
    const exchangeLifecycle = new AbortController();
    let processClosed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const terminate = (next: typeof reason): void => {
      if (reason !== null) return;
      reason = next;
      exchangeLifecycle.abort();
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), TERMINATION_GRACE_MS);
    };
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
    const handleLine = (line: string): void => {
      if (Buffer.byteLength(line, "utf8") > MAX_BROKER_FRAME_BYTES) return terminate("output");
      let raw: unknown;
      try { raw = JSON.parse(line) as unknown; } catch { return terminate("protocol"); }
      if (isOpenCodeResultFrame(raw)) return;
      const parsed = DockerBrokerFrameSchema.safeParse(raw);
      if (!parsed.success) return terminate("protocol");
      chain = chain.then(async () => {
        if (exchangeLifecycle.signal.aborted) return;
        const response = await exchange(parsed.data, exchangeLifecycle.signal);
        const serialized = `${JSON.stringify(response)}\n`;
        if (Buffer.byteLength(serialized, "utf8") > MAX_BROKER_RESPONSE_BYTES) throw new Error("broker response exceeds limit");
        await writeBrokerResponse(child.stdin, serialized, exchangeLifecycle.signal);
      }).catch(() => {
        if (!exchangeLifecycle.signal.aborted) terminate("protocol");
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
      if (reason !== null) return;
      pendingLine += frameDecoder.write(chunk);
      if (Buffer.byteLength(pendingLine, "utf8") > MAX_BROKER_FRAME_BYTES && !pendingLine.includes("\n")) {
        terminate("output");
        return;
      }
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = collect(stderr, chunk); });
    child.stdin.on("error", () => { if (!processClosed) terminate("protocol"); });
    child.stdin.on("close", () => { if (!processClosed && reason === null) terminate("protocol"); });
    const abort = (): void => terminate("cancelled");
    const deadline = setTimeout(() => terminate("timed_out"), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      processClosed = true;
      exchangeLifecycle.abort();
      settleExchanges(() => finish(() => reject(error)));
    });
    child.once("close", (code) => {
      processClosed = true;
      pendingLine += frameDecoder.end();
      if (reason === null && pendingLine.trim() !== "") reason = "protocol";
      exchangeLifecycle.abort();
      settleExchanges(() => finish(() => {
        if (reason === "cancelled") reject(new DockerCommandCancelledError());
        else if (reason === "timed_out") reject(new DockerCommandTimeoutError());
        else if (reason === "output") reject(new DockerOutputLimitError());
        else if (reason === "protocol") reject(new Error("broker protocol failed"));
        else resolve({ exitCode: code ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
      }));
    });
    function settleExchanges(action: () => void): void {
      let grace: NodeJS.Timeout;
      void Promise.race([
        chain.then(() => true),
        new Promise<boolean>((resolveGrace) => {
          grace = setTimeout(() => resolveGrace(false), BROKER_TERMINATION_GRACE_MS);
        }),
      ]).then((cooperated) => {
        if (cooperated) {
          clearTimeout(grace!);
          action();
        } else {
          finish(() => reject(new DockerBrokerTransportUncertainError()));
        }
      });
    }
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

function isOpenCodeResultFrame(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (value as Readonly<Record<string, unknown>>)["type"] === "opencode_result";
}

function writeBrokerResponse(
  stdin: NodeJS.WritableStream,
  response: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted || !stdin.writable) return reject(new Error("model broker stdin is unavailable"));
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
      stdin.removeListener("error", fail);
      stdin.removeListener("close", close);
      stdin.removeListener("drain", drain);
    };
    const done = (): void => { cleanup(); resolve(); };
    const fail = (): void => { cleanup(); reject(new Error("model broker stdin failed")); };
    const close = (): void => { cleanup(); reject(new Error("model broker stdin closed")); };
    const abort = (): void => { cleanup(); reject(new Error("model broker exchange aborted")); };
    const drain = (): void => done();
    signal.addEventListener("abort", abort, { once: true });
    stdin.once("error", fail);
    stdin.once("close", close);
    if (stdin.write(response, "utf8")) done();
    else stdin.once("drain", drain);
  });
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
