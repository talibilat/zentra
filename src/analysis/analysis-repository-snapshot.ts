import { createHash } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { chmod, mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

import { createReadOnlyRepositoryViewAtCommit, type ReadOnlyRepositoryView } from "../agents/read-only-repository-view.js";
import { openCodeResourceIdentity } from "../agents/opencode-resource-identity.js";
import { GitClient } from "../workspaces/git-client.js";
import type { AnalysisAdapterRequest } from "./analysis-contracts.js";

const SOURCE_CHUNK_CHARS = 16 * 1024;

export interface PreparedAnalysisSnapshot {
  readonly view: ReadOnlyRepositoryView;
  readonly sourceBundleSha256: string;
  readonly sourceManifestPath: string;
  release(): void;
}

export interface AnalysisRepositorySnapshotProvider {
  prepare(request: AnalysisAdapterRequest, signal: AbortSignal, limits: AnalysisSnapshotPreparationLimits): Promise<PreparedAnalysisSnapshot>;
}

export interface AnalysisSnapshotPreparationLimits { readonly remainingDurationMs: () => number }
export interface GitAnalysisRepositorySnapshotProviderOptions {
  readonly beforeSourceWrite?: (sourceId: string, index: number) => void;
}

export class GitAnalysisRepositorySnapshotProvider implements AnalysisRepositorySnapshotProvider {
  constructor(
    private readonly repositoryPath: string,
    private readonly readableScopes: readonly string[],
    private readonly protectedPaths: readonly string[],
    private readonly options: GitAnalysisRepositorySnapshotProviderOptions = {},
  ) {}

  async prepare(request: AnalysisAdapterRequest, signal: AbortSignal, limits: AnalysisSnapshotPreparationLimits): Promise<PreparedAnalysisSnapshot> {
    const identity = openCodeResourceIdentity("analysis", `${request.runId}-${request.round}`, 1);
    const forbidden = [...new Set([".git/**", ".zentra/**", ...this.protectedPaths])].sort();
    const view = await createReadOnlyRepositoryViewAtCommit(
      new GitClient(), this.repositoryPath, request.projectRevision.commit,
      this.readableScopes, forbidden, identity.repositoryViewPath, signal,
      limits.remainingDurationMs,
    );
    const expectedRevision = createHash("sha256").update(request.projectRevision.commit).digest("hex");
    if (view.revision !== expectedRevision) {
      rmSync(view.path, { recursive: true, force: true });
      throw new Error("analysis repository snapshot revision contradicts authoritative run revision");
    }
    const bundleRoot = path.join(view.path, ".analysis-sources");
    try {
      assertAvailable(signal, limits);
      const declaredBytes = request.sources.reduce((total, source) => total + source.sizeBytes, 0);
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes > request.sourceByteBudget) {
        throw new Error("analysis source bundle exceeds reserved aggregate source-byte budget");
      }
      await mkdir(bundleRoot, { mode: 0o755 });
      const manifest: Array<Record<string, unknown>> = [];
      let aggregateBytes = 0;
      for (let index = 0; index < request.sources.length; index += 1) {
        const source = request.sources[index]!;
        assertAvailable(signal, limits);
        this.options.beforeSourceWrite?.(source.sourceId, index);
        const identity = createHash("sha256").update(source.sourceId).update("\0").update(source.normalizedContentSha256).digest("hex");
        const name = `${identity}-${source.normalizedContentSha256}.txt`;
        const target = path.join(bundleRoot, name);
        const streamed = await streamSource(target, source.quotedText, signal, limits, request.sourceByteBudget - aggregateBytes);
        aggregateBytes += streamed.bytes;
        if (streamed.bytes !== source.sizeBytes || streamed.sha256 !== source.normalizedContentSha256) {
          throw new Error("analysis source bundle content digest or size changed");
        }
        manifest.push({
          sourceId: source.sourceId, relativePath: source.relativePath,
          path: `.analysis-sources/${name}`, sha256: source.sha256,
          normalizedContentSha256: source.normalizedContentSha256, provenanceSha256: source.provenanceSha256,
        });
      }
      const encoded = `${JSON.stringify(manifest)}\n`;
      const sourceBundleSha256 = createHash("sha256").update(encoded).digest("hex");
      const manifestPath = path.join(bundleRoot, "manifest.json");
      assertAvailable(signal, limits);
      await writeFile(manifestPath, encoded, { mode: 0o444, flag: "wx" });
      await chmod(manifestPath, 0o444);
      await chmod(bundleRoot, 0o555);
      assertAvailable(signal, limits);
      return {
      view: Object.freeze({ ...view, readableScopes: Object.freeze([...view.readableScopes, ".analysis-sources/**"]) }),
      sourceBundleSha256,
      sourceManifestPath: ".analysis-sources/manifest.json",
      release: () => {
        chmodSync(bundleRoot, 0o755);
        rmSync(view.path, { recursive: true, force: true });
      },
      };
    } catch (error) {
      try { chmodSync(bundleRoot, 0o755); } catch { /* partial bundle may not exist */ }
      rmSync(view.path, { recursive: true, force: true });
      throw error;
    }
  }
}

async function streamSource(
  target: string,
  text: string,
  signal: AbortSignal,
  limits: AnalysisSnapshotPreparationLimits,
  remainingByteBudget: number,
): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const handle = await open(target, "wx", 0o444);
  const hash = createHash("sha256");
  let bytes = 0;
  let offset = 0;
  try {
    while (offset < text.length) {
      assertAvailable(signal, limits);
      let end = Math.min(text.length, offset + SOURCE_CHUNK_CHARS);
      if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
      const chunk = Buffer.from(text.slice(offset, end), "utf8");
      bytes += chunk.length;
      if (bytes > remainingByteBudget) throw new Error("analysis source bundle exceeded reserved bytes while streaming");
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        assertAvailable(signal, limits);
        const result = await handle.write(chunk, written, chunk.length - written);
        if (result.bytesWritten <= 0) throw new Error("analysis source bundle write made no progress");
        written += result.bytesWritten;
        assertAvailable(signal, limits);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      assertAvailable(signal, limits);
      offset = end;
    }
    await handle.sync();
    assertAvailable(signal, limits);
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

function assertAvailable(signal: AbortSignal, limits: AnalysisSnapshotPreparationLimits): void {
  if (signal.aborted) throw new Error("analysis source bundle cancelled");
  if (limits.remainingDurationMs() <= 0) throw new Error("analysis source bundle deadline exhausted");
}

function isHighSurrogate(value: number): boolean { return value >= 0xd800 && value <= 0xdbff; }
function isLowSurrogate(value: number): boolean { return value >= 0xdc00 && value <= 0xdfff; }
