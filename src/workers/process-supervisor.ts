import { spawn } from "node:child_process";
import type { WorkerAdapter, WorkerRequest, WorkerResult } from "./worker-adapter.js";

const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

type Decision =
  | { readonly kind: "exit"; readonly code: number | null }
  | { readonly kind: "timed_out" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "output_limit" }
  | { readonly kind: "spawn_error"; readonly message: string };

export interface ProcessSupervisorOptions {
  readonly maxOutputBytes?: number;
}

export class ProcessSupervisor implements WorkerAdapter {
  private readonly maxOutputBytes: number;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
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
      let graceTimer: NodeJS.Timeout | undefined;

      const timer = setTimeout(() => decide({ kind: "timed_out" }), request.timeoutMs);

      const onAbort = (): void => decide({ kind: "cancelled" });
      signal.addEventListener("abort", onAbort, { once: true });

      const killProcessGroup = (): void => {
        const pid = child.pid;
        if (pid === undefined) {
          return;
        }
        try {
          // detached:true puts the child in its own process group; kill the whole group.
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process already gone.
          }
        }
      };

      const decide = (candidate: Decision): void => {
        if (decision !== undefined) {
          if (decision.kind !== "exit" || candidate.kind !== "output_limit") {
            return;
          }
        }
        decision = candidate;
        if (candidate.kind !== "exit") {
          killProcessGroup();
        }
        if (exited) {
          settle();
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
        // A descendant that escaped the process group can hold the stdio pipes
        // open past the child's exit; give the streams a short flush window
        // instead of waiting on "close" indefinitely.
        graceTimer = setTimeout(settle, 1_000);
      });

      child.on("close", (code) => {
        exited = true;
        decide({ kind: "exit", code });
        settle();
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
