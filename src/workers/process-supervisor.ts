import { spawn } from "node:child_process";
import type { WorkerAdapter, WorkerRequest, WorkerResult } from "./worker-adapter.js";

const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_STREAM_GRACE_MS = 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_FORCED_TERMINATION_MS = 1_000;
const GROUP_EXIT_POLL_MS = 10;

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
    this.streamGraceMs = options.streamGraceMs ?? DEFAULT_STREAM_GRACE_MS;
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.forcedTerminationMs = options.forcedTerminationMs ?? DEFAULT_FORCED_TERMINATION_MS;
  }

  execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
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
      let exited = false;
      let settled = false;
      let terminationStarted = false;
      let graceTimer: NodeJS.Timeout | undefined;

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
            child.kill(signalName);
          } catch {
            // Process already gone.
          }
        }
      };

      const waitForProcessGroupExit = async (timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        while (processGroupExists()) {
          const remaining = deadline - Date.now();
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
          if (await waitForProcessGroupExit(this.terminationGraceMs)) {
            settle();
            return;
          }
        }

        if (processGroupExists()) {
          signalProcessGroup("SIGKILL");
        }
        if (!(await waitForProcessGroupExit(this.forcedTerminationMs))) {
          const exitCode = decision?.kind === "exit" ? decision.code : null;
          decision = { kind: "descendant_survived", code: exitCode };
        }
        settle();
      };

      const decide = (candidate: Decision): void => {
        if (decision !== undefined) {
          if (decision.kind !== "exit" || candidate.kind !== "output_limit") {
            return;
          }
        }
        decision = candidate;
        if (candidate.kind !== "exit") {
          signalProcessGroup("SIGKILL");
        }
        if (exited) {
          void terminateAndSettle(false);
        }
      };

      const settle = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (graceTimer !== undefined) {
          clearTimeout(graceTimer);
        }
        signal.removeEventListener("abort", onAbort);
        const made = decision ?? { kind: "spawn_error", message: "no decision recorded" };
        resolve(buildResult(made, stdoutChunks, stderrChunks, this.maxOutputBytes));
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
          exited = true;
          settle();
        }
      });

      child.on("exit", (code) => {
        exited = true;
        if (decision === undefined) {
          decision = { kind: "exit", code };
        }
        graceTimer = setTimeout(
          () => void terminateAndSettle(decision?.kind === "exit"),
          this.streamGraceMs,
        );
      });

      child.on("close", (code) => {
        exited = true;
        decide({ kind: "exit", code });
        void terminateAndSettle(decision?.kind === "exit");
      });
    });
  }
}

function buildResult(
  decision: Decision,
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
