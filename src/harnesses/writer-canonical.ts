import { createHash } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";

/**
 * Shared canonicalization and digest helpers used by every harness writer
 * adapter (OpenCodeWriter, ClaudeCodeWriter, ...). Kept in one place so the
 * canonical-path invariants they enforce cannot drift between adapters.
 */

export function canonicalDirectory(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  if (!statSync(canonical).isDirectory()) throw new Error("harness writer cwd must be a directory");
  return canonical;
}

export function canonicalExecutable(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  const stat = statSync(canonical);
  if (candidate !== canonical || !stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error("harness writer executable must be a canonical executable file");
  }
  return canonical;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
