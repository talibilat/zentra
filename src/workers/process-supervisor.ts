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
      return Promise.resolve({ outcome: "cancelled", events: [], stdout: "", stderr: "" });
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
      let stdoutBytes = 0;
      let stderrBytes = 0;
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
          return;
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

      const capture = (
        chunks: Buffer[],
        counted: number,
        chunk: Buffer,
      ): number => {
        const total = counted + chunk.byteLength;
        chunks.push(chunk);
        if (total > this.maxOutputBytes) {
          decide({ kind: "output_limit" });
        }
        return total;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes = capture(stdoutChunks, stdoutBytes, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes = capture(stderrChunks, stderrBytes, chunk);
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
  const stdout = Buffer.concat(stdoutChunks).subarray(0, maxOutputBytes).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).subarray(0, maxOutputBytes).toString("utf8");

  switch (decision.kind) {
    case "timed_out":
      // Discard any output parsed after the kill decision; no stale worker events.
      return { outcome: "timed_out", events: [], stdout: "", stderr: "" };
    case "cancelled":
      return { outcome: "cancelled", events: [], stdout: "", stderr: "" };
    case "output_limit":
      return {
        outcome: "failed",
        events: [],
        stdout,
        stderr: `${stderr}${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}process supervisor: output limit of ${maxOutputBytes} bytes exceeded\n`,
      };
    case "spawn_error":
      return {
        outcome: "failed",
        events: [],
        stdout,
        stderr: `${stderr}${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}process supervisor: ${decision.message}\n`,
      };
    case "exit": {
      if (decision.code === 0) {
        const { events, plain } = parseJsonLines(stdout);
        return { outcome: "completed", events, stdout: plain, stderr };
      }
      return { outcome: "failed", events: [], stdout, stderr };
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
