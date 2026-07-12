import { spawn } from "node:child_process";

const ENVIRONMENT_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;

const MAX_CAPTURED_BYTES_PER_STREAM = 1024 * 1024;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** True when captured output exceeded the per-stream limit and was cut off. */
  readonly truncated: boolean;
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
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export class GitClient {
  run(cwd: string, args: readonly string[]): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn("git", [...args], {
        cwd,
        shell: false,
        env: minimalEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout = new BoundedCollector();
      const stderr = new BoundedCollector();
      child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: code ?? -1,
          truncated: stdout.truncated || stderr.truncated,
        });
      });
    });
  }
}
