import { spawn } from "node:child_process";
import { ReviewDecisionSchema } from "../reviews/reviewer-adapter.js";
import type {
  InvocationKind,
  WorkerAdapter,
  WorkerRequest,
  WorkerResult,
} from "./worker-adapter.js";

const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_STREAM_GRACE_MS = 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_FORCED_TERMINATION_MS = 1_000;
const GROUP_EXIT_POLL_MS = 10;
const MAX_TIMER_MS = 2_147_483_647;
const NS_PER_MS = 1_000_000n;
type Decision =
  | { readonly kind: "exit"; readonly code: number | null }
  | { readonly kind: "timed_out" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "output_limit" }
  | { readonly kind: "descendant_survived"; readonly code: number | null }
  | { readonly kind: "spawn_error"; readonly message: string };

export interface ProcessSupervisorOptions {
  readonly maxOutputBytes?: number;
  readonly streamGraceMs?: number;
  readonly terminationGraceMs?: number;
  readonly forcedTerminationMs?: number;
}

export class ProcessSupervisor implements WorkerAdapter {
  private readonly maxOutputBytes: number;
  private readonly streamGraceMs: number;
  private readonly terminationGraceMs: number;
  private readonly forcedTerminationMs: number;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.streamGraceMs = validDuration(
      "streamGraceMs",
      options.streamGraceMs ?? DEFAULT_STREAM_GRACE_MS,
    );
    this.terminationGraceMs = validDuration(
      "terminationGraceMs",
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    );
    this.forcedTerminationMs = validDuration(
      "forcedTerminationMs",
      options.forcedTerminationMs ?? DEFAULT_FORCED_TERMINATION_MS,
    );
  }

  execute(
    request: WorkerRequest,
    signal: AbortSignal,
    kind: InvocationKind,
  ): Promise<WorkerResult> {
    try {
      validDuration("timeoutMs", request.timeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal.aborted) {
      return Promise.resolve({
        outcome: "cancelled",
        exitCode: null,
        events: [],
        stdout: "",
        rawStdout: "",
        stderr: "",
      });
    }

    return new Promise((resolve) => {
      const env: Record<string, string> = {};
      for (const key of ENV_ALLOWLIST) {
        const value = process.env[key];
        if (value !== undefined) {
          env[key] = value;
        }
      }

      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        shell: false,
        detached: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let capturedBytes = 0;
      let decision: Decision | undefined;
      let settled = false;
      let terminationStarted = false;
      let streamsClosed = false;

      const timer = setTimeout(() => decide({ kind: "timed_out" }), request.timeoutMs);

      const onAbort = (): void => decide({ kind: "cancelled" });
      signal.addEventListener("abort", onAbort, { once: true });

      const processGroupExists = (): boolean => {
        const pid = child.pid;
        if (pid === undefined) {
          return false;
        }
        try {
          process.kill(-pid, 0);
          return true;
        } catch (error) {
          // Only ESRCH proves that the owned group no longer exists.
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      };

      const signalProcessGroup = (signalName: NodeJS.Signals): void => {
        const pid = child.pid;
        if (pid === undefined) {
          return;
        }
        try {
          // detached:true makes the leader the process-group owner on macOS.
          process.kill(-pid, signalName);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            return;
          }
          try {
            process.kill(pid, signalName);
          } catch (leaderError) {
            if ((leaderError as NodeJS.ErrnoException).code === "ESRCH") {
              return;
            }
            // Denial is handled by the bounded absence confirmation below.
          }
        }
      };

      const waitForProcessGroupExit = async (
        timeoutMs: number,
        continueWaiting: () => boolean = () => true,
      ): Promise<boolean> => {
        const deadline = monotonicDeadline(timeoutMs);
        while (processGroupExists()) {
          if (!continueWaiting()) {
            return false;
          }
          const remaining = remainingMs(deadline);
          if (remaining <= 0) {
            return false;
          }
          await new Promise((resolveSleep) =>
            setTimeout(resolveSleep, Math.min(GROUP_EXIT_POLL_MS, remaining)),
          );
        }
        return true;
      };

      const terminateAndSettle = async (graceful: boolean): Promise<void> => {
        if (terminationStarted || settled) {
          return;
        }
        terminationStarted = true;

        if (graceful && processGroupExists()) {
          signalProcessGroup("SIGTERM");
          if (
            await waitForProcessGroupExit(
              this.terminationGraceMs,
              () => decision?.kind === "exit",
            )
          ) {
            settle();
            return;
          }
        }

        if (processGroupExists()) {
          signalProcessGroup("SIGKILL");
        }
        if (
          !(await waitForProcessGroupExit(this.forcedTerminationMs)) &&
          decision?.kind === "exit"
        ) {
          const exitCode = decision?.kind === "exit" ? decision.code : null;
          decision = { kind: "descendant_survived", code: exitCode };
        }
        settle();
      };

      const decide = (candidate: Decision): void => {
        if (decision !== undefined) {
          if (decision.kind !== "exit" || candidate.kind === "exit") {
            return;
          }
        }
        decision = candidate;
        if (candidate.kind !== "exit") {
          signalProcessGroup("SIGKILL");
          void terminateAndSettle(false);
        }
      };

      const settle = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const made = decision ?? { kind: "spawn_error", message: "no decision recorded" };
        resolve(buildResult(made, kind, stdoutChunks, stderrChunks, this.maxOutputBytes));
      };

      const waitForStreamGrace = async (): Promise<void> => {
        const deadline = monotonicDeadline(this.streamGraceMs);
        while (!streamsClosed && decision?.kind === "exit") {
          const remaining = remainingMs(deadline);
          if (remaining <= 0) {
            break;
          }
          await new Promise((resolveSleep) => setTimeout(resolveSleep, remaining));
        }
        if (decision?.kind === "exit") {
          void terminateAndSettle(true);
        }
      };

      const capture = (chunks: Buffer[], chunk: Buffer): void => {
        const remaining = this.maxOutputBytes - capturedBytes;
        if (remaining > 0) {
          const retainedBytes = Math.min(remaining, chunk.byteLength);
          chunks.push(
            retainedBytes === chunk.byteLength
              ? chunk
              : Buffer.from(chunk.subarray(0, retainedBytes)),
          );
          capturedBytes += retainedBytes;
        }
        if (chunk.byteLength > remaining) {
          decide({ kind: "output_limit" });
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        capture(stdoutChunks, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        capture(stderrChunks, chunk);
      });

      child.on("error", (error) => {
        decide({ kind: "spawn_error", message: error.message });
        if (child.pid === undefined) {
          settle();
        }
      });

      child.on("exit", (code) => {
        if (decision === undefined) {
          decision = { kind: "exit", code };
        }
        void waitForStreamGrace();
      });

      child.on("close", (code) => {
        streamsClosed = true;
        decide({ kind: "exit", code });
        void terminateAndSettle(decision?.kind === "exit");
      });
    });
  }
}

function buildResult(
  decision: Decision,
  kind: InvocationKind,
  stdoutChunks: readonly Buffer[],
  stderrChunks: readonly Buffer[],
  maxOutputBytes: number,
): WorkerResult {
  const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  switch (decision.kind) {
    case "timed_out":
      // Discard any output parsed after the kill decision; no stale worker events.
      return {
        outcome: "timed_out",
        exitCode: null,
        events: [],
        stdout: "",
        rawStdout: "",
        stderr: "",
      };
    case "cancelled":
      return {
        outcome: "cancelled",
        exitCode: null,
        events: [],
        stdout: "",
        rawStdout: "",
        stderr: "",
      };
    case "output_limit":
      return {
        outcome: "failed",
        exitCode: null,
        events: [],
        stdout: rawStdout,
        rawStdout,
        stderr: `${stderr}${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}process supervisor: output limit of ${maxOutputBytes} bytes exceeded\n`,
      };
    case "spawn_error":
      return {
        outcome: "failed",
        exitCode: null,
        events: [],
        stdout: rawStdout,
        rawStdout,
        stderr: `${stderr}${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}process supervisor: ${decision.message}\n`,
      };
    case "descendant_survived":
      return {
        outcome: "failed",
        exitCode: decision.code,
        events: [],
        stdout: rawStdout,
        rawStdout,
        stderr: `${stderr}${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}process supervisor: process group survived bounded termination\n`,
      };
    case "exit": {
      if (decision.code === 0) {
        const { events, plain } = parseJsonLines(rawStdout);
        const protocolError = validateProtocolOutput(kind, events);
        if (protocolError !== undefined) {
          return {
            outcome: "failed",
            exitCode: 0,
            events: [],
            stdout: rawStdout,
            rawStdout,
            stderr: appendSupervisorError(stderr, protocolError),
          };
        }
        return {
          outcome: "completed",
          exitCode: 0,
          events,
          stdout: plain,
          rawStdout,
          stderr,
        };
      }
      return {
        outcome: "failed",
        exitCode: decision.code,
        events: [],
        stdout: rawStdout,
        rawStdout,
        stderr,
      };
    }
  }
}

function validDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be a finite duration between 0 and ${MAX_TIMER_MS} ms`);
  }
  return value;
}

function monotonicDeadline(timeoutMs: number): bigint {
  return process.hrtime.bigint() + BigInt(Math.ceil(timeoutMs)) * NS_PER_MS;
}

function remainingMs(deadline: bigint): number {
  const remainingNs = deadline - process.hrtime.bigint();
  if (remainingNs <= 0n) {
    return 0;
  }
  return Number((remainingNs + NS_PER_MS - 1n) / NS_PER_MS);
}

function appendSupervisorError(stderr: string, message: string): string {
  return `${stderr}${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}process supervisor: ${message}\n`;
}

function validateProtocolOutput(
  kind: InvocationKind,
  events: readonly unknown[],
): string | undefined {
  switch (kind) {
    case "validation":
      return undefined;
    case "reviewer":
      return isReviewDecision(events)
        ? undefined
        : `reviewer protocol requires exactly one valid review decision, received ${events.length}`;
    case "worker":
      return isArtifactReady(events)
        ? undefined
        : `worker protocol requires exactly one valid artifact.ready event, received ${events.length}`;
  }
}

function isArtifactReady(events: readonly unknown[]): boolean {
  if (events.length !== 1 || !isRecord(events[0])) {
    return false;
  }
  const event = events[0];
  return (
    Object.keys(event).length === 3 &&
    event["type"] === "artifact.ready" &&
    typeof event["path"] === "string" &&
    event["path"].length > 0 &&
    typeof event["sha256"] === "string" &&
    /^[a-f0-9]{64}$/.test(event["sha256"])
  );
}

function isReviewDecision(events: readonly unknown[]): boolean {
  return events.length === 1 && ReviewDecisionSchema.safeParse(events[0]).success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLines(stdout: string): { events: readonly unknown[]; plain: string } {
  const events: unknown[] = [];
  const plainLines: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        events.push(JSON.parse(trimmed));
        continue;
      } catch {
        // Fall through to plain stdout.
      }
    }
    plainLines.push(line);
  }
  return { events, plain: plainLines.join("\n") };
}
