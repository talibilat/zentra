import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { MAX_RETAINED_ARTIFACT_BYTES } from "../contracts/artifact.js";

const ENVIRONMENT_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;

const MAX_CAPTURED_BYTES_PER_STREAM = MAX_RETAINED_ARTIFACT_BYTES;

export interface CommandResult {
  readonly stdout: string;
  readonly stdoutBytes?: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
  /** True when captured output exceeded the per-stream limit and was cut off. */
  readonly truncated: boolean;
  readonly termination: "cancelled" | "timed_out" | null;
}

export interface GitRunOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function minimalEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENVIRONMENT_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Git must never hang waiting for interactive credentials.
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_MERGE_AUTOEDIT"] = "no";
  env["GIT_EDITOR"] = "false";
  env["GIT_SEQUENCE_EDITOR"] = "false";
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  env["GIT_CONFIG_GLOBAL"] = nullDevice;
  env["GIT_ATTR_NOSYSTEM"] = "1";
  env["GIT_NO_REPLACE_OBJECTS"] = "1";
  // Git has no dedicated environment switch for its per-user attributes
  // file, so inject only that config key while repository attributes remain active.
  env["GIT_CONFIG_COUNT"] = "1";
  env["GIT_CONFIG_KEY_0"] = "core.attributesFile";
  env["GIT_CONFIG_VALUE_0"] = nullDevice;
  return env;
}

class BoundedCollector {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private wasTruncated = false;

  append(chunk: Buffer): void {
    if (this.bytes >= MAX_CAPTURED_BYTES_PER_STREAM) {
      if (chunk.byteLength > 0) {
        this.wasTruncated = true;
      }
      return;
    }
    const remaining = MAX_CAPTURED_BYTES_PER_STREAM - this.bytes;
    const bounded = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    if (bounded.byteLength < chunk.byteLength) {
      this.wasTruncated = true;
    }
    this.chunks.push(bounded);
    this.bytes += bounded.byteLength;
  }

  get truncated(): boolean {
    return this.wasTruncated;
  }

  toString(): string {
    return this.toBuffer().toString("utf8");
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export class GitClient {
  run(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      if (options.signal?.aborted) {
        resolve({
          stdout: "",
          stdoutBytes: Buffer.alloc(0),
          stderr: "Git execution cancelled before start",
          exitCode: -1,
          truncated: false,
          termination: "cancelled",
        });
        return;
      }
      const child = spawn("git", [...args], {
        cwd,
        shell: false,
        detached: process.platform !== "win32",
        env: minimalEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout = new BoundedCollector();
      const stderr = new BoundedCollector();
      child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

      let termination: CommandResult["termination"] = null;
      let timeout: NodeJS.Timeout | undefined;
      let forceKill: NodeJS.Timeout | undefined;
      let settled = false;
      const killGroup = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch {
          // The process may have exited between observation and termination.
        }
      };
      const terminate = (reason: Exclude<CommandResult["termination"], null>): void => {
        if (termination !== null) return;
        termination = reason;
        killGroup("SIGTERM");
        forceKill = setTimeout(() => killGroup("SIGKILL"), 1_000);
        forceKill.unref();
      };
      const onAbort = (): void => terminate("cancelled");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => terminate("timed_out"), options.timeoutMs);
        timeout.unref();
      }
      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        if (forceKill !== undefined) clearTimeout(forceKill);
        options.signal?.removeEventListener("abort", onAbort);
      };

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (termination !== null) killGroup("SIGKILL");
        cleanup();
        resolve({
          stdout: stdout.toString(),
          stdoutBytes: stdout.toBuffer(),
          stderr: stderr.toString(),
          exitCode: termination === null ? (code ?? -1) : -1,
          truncated: stdout.truncated || stderr.truncated,
          termination,
        });
      });
    });
  }
}

export async function assertNoGitObjectSubstitution(
  git: GitClient,
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  const replacements = await git.run(cwd, [
    "--no-optional-locks",
    "--no-replace-objects",
    "for-each-ref",
    "--format=%(refname)",
    "--count=1",
    "--",
    "refs/replace/",
  ], { timeoutMs });
  assertCompleteGitRead(replacements, "replacement ref inspection");
  if (replacements.stdout !== "") {
    throw new Error("Git replacement refs are not allowed for object evidence");
  }

  const commonDirectory = await git.run(cwd, [
    "--no-optional-locks",
    "--no-replace-objects",
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ], { timeoutMs });
  assertCompleteGitRead(commonDirectory, "Git common directory inspection");
  const lines = commonDirectory.stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || !path.isAbsolute(lines[0]!)) {
    throw new Error("Git common directory evidence is malformed");
  }
  try {
    if ((await readFile(path.join(lines[0]!, "info", "grafts"))).byteLength > 0) {
      throw new Error("nonempty Git graft evidence is not allowed");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertCompleteGitRead(result: CommandResult, operation: string): void {
  if (result.termination !== null || result.truncated || result.exitCode !== 0) {
    throw new Error(`${operation} failed closed`);
  }
}
