import { createHash } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";

import type { WorkerAdapter } from "../workers/worker-adapter.js";

const DigestPattern = /^[a-f0-9]{64}$/;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_VERSION_BYTES = 512;

export interface HostOpenCodeAttestationRequest {
  readonly executable: string;
  readonly home: string;
  readonly cwd: string;
  readonly expectedSha256: string;
  readonly expectedVersion: string;
  readonly timeoutMs: number;
}

export interface HostOpenCodeAttestation {
  readonly executable: string;
  readonly executableSha256: string;
  readonly version: string;
}

export async function attestHostOpenCode(
  worker: WorkerAdapter,
  request: HostOpenCodeAttestationRequest,
  signal: AbortSignal,
): Promise<HostOpenCodeAttestation> {
  try {
    if (!DigestPattern.test(request.expectedSha256) || !validVersion(request.expectedVersion)) throw new Error("invalid attestation");
    const executable = canonicalExecutable(request.executable);
    const home = canonicalDirectory(request.home);
    const cwd = canonicalDirectory(request.cwd);
    const before = await sha256File(executable);
    if (before !== request.expectedSha256) throw new Error("digest mismatch");
    const result = await worker.execute({
      taskId: "opencode-operator-attestation",
      executable,
      args: ["--version"],
      cwd,
      timeoutMs: request.timeoutMs,
      environment: { HOME: home },
    }, signal, "validation");
    const version = exactVersion(result.rawStdout);
    const after = await sha256File(executable);
    if (result.outcome !== "completed" || result.exitCode !== 0 || result.stderr !== "" ||
      version !== request.expectedVersion || after !== before) throw new Error("attestation mismatch");
    return Object.freeze({ executable, executableSha256: after, version });
  } catch {
    throw new Error("host OpenCode operator attestation failed");
  }
}

function validVersion(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_VERSION_BYTES &&
    !/[\r\n\u0000-\u001f\u007f]/.test(value);
}

function exactVersion(stdout: string): string {
  const version = stdout.endsWith("\r\n") ? stdout.slice(0, -2) : stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!validVersion(version) || /[\r\n]/.test(version)) throw new Error("invalid version output");
  return version;
}

function canonicalExecutable(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  const stat = statSync(canonical);
  if (candidate !== canonical || !stat.isFile() || (stat.mode & 0o111) === 0 || stat.size > MAX_EXECUTABLE_BYTES) {
    throw new Error("invalid executable");
  }
  return canonical;
}

function canonicalDirectory(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  if (candidate !== canonical || !statSync(canonical).isDirectory()) throw new Error("invalid directory");
  return canonical;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
