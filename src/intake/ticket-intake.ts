import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { ProjectRevision } from "../runs/run-contracts.js";
import type { RunView } from "../runs/run-projection.js";
import type { IntakeArtifactReference } from "./intake-contracts.js";

const INTAKE_SCHEMA_VERSION = 1;
const MAX_RELATIVE_PATH_BYTES = 1024;
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;

export interface TicketIntakeLimits {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxDepth: number;
  readonly maxEntries?: number;
  readonly maxDirectoryEntries?: number;
}

export type EffectiveTicketIntakeLimits = Readonly<Required<TicketIntakeLimits>>;

export type TicketIntakeSource =
  | { readonly kind: "inline_goal"; readonly goal: string }
  | { readonly kind: "ticket_directory"; readonly root: string };

export interface TicketIntakeRequest {
  readonly run: RunView;
  readonly source: TicketIntakeSource;
  readonly limits: TicketIntakeLimits;
}

export type SourceRejectionReason =
  | "aggregate_size_exceeded"
  | "binary"
  | "changed_during_read"
  | "directory_too_many_entries"
  | "depth_exceeded"
  | "entry_limit_exceeded"
  | "file_too_large"
  | "invalid_encoding"
  | "path_escape"
  | "path_too_long"
  | "reserved_runtime_state"
  | "source_count_exceeded"
  | "special_file"
  | "symlink";

export interface SourceProvenance {
  readonly runId: string;
  readonly projectId: string;
  readonly projectRevision: ProjectRevision;
  readonly sourceKind: "inline_goal" | "ticket_directory";
  readonly rootIdentitySha256: string;
  readonly device: string | null;
  readonly inode: string | null;
  readonly modifiedNanoseconds: string | null;
  readonly changedNanoseconds: string | null;
}

export interface DiscoveredTicketSource {
  readonly sourceId: string;
  readonly relativePath: string;
  readonly quotedText: string;
  readonly trust: "untrusted_planning_data";
  readonly mediaType: "text/plain; charset=utf-8";
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly artifact: IntakeArtifactReference | null;
  readonly provenance: SourceProvenance;
}

export interface RejectedTicketSource {
  readonly relativePath: string;
  readonly reason: SourceRejectionReason;
  readonly sizeBytes: number | null;
  readonly digest: string | null;
  readonly bytesRead: number;
  readonly provenance: SourceProvenance;
}

interface SourceDiscoveredPayload {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly trust: "untrusted_planning_data";
  readonly provenance: SourceProvenance;
}

interface SourceRejectedPayload {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly path: string;
  readonly reason: SourceRejectionReason;
  readonly sizeBytes: number | null;
  readonly digest: string | null;
  readonly bytesRead: number;
  readonly provenance: SourceProvenance;
}

export type SourceIntakeEvent =
  | { readonly type: "source.discovered"; readonly payload: SourceDiscoveredPayload }
  | { readonly type: "source.rejected"; readonly payload: SourceRejectedPayload };

export interface TicketIntakeSnapshot {
  readonly schemaVersion: 1;
  readonly closed: true;
  readonly runId: string;
  readonly projectId: string;
  readonly projectRevision: ProjectRevision;
  readonly sourceKind: "inline_goal" | "ticket_directory";
  readonly limits: EffectiveTicketIntakeLimits;
  readonly sources: readonly DiscoveredTicketSource[];
  readonly rejected: readonly RejectedTicketSource[];
  readonly events: readonly SourceIntakeEvent[];
  readonly totalBytes: number;
  readonly snapshotSha256: string;
}

export type TicketTextDecodeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "binary" | "invalid_encoding" };

export class IntakeError extends Error {
  readonly name = "IntakeError";

  constructor(
    readonly code:
      | "empty_source"
      | "invalid_limits"
      | "invalid_root"
      | "no_accepted_sources"
      | "run_not_in_intake"
      | "source_reference_mismatch",
    message: string,
    readonly rejections: readonly RejectedTicketSource[] = [],
    readonly bytesRead = 0,
  ) {
    super(message);
    Object.freeze(this.rejections);
  }
}

/** Trusted-project race hardening; this is not an OS sandbox against a malicious same-user process. */
export class BoundedTicketIntake {
  private readonly readChunkBytes: number;
  private readonly testHooks: {
    readonly beforeFileOpen?: (relativePath: string) => void | Promise<void>;
    readonly beforeDescriptorOpen?: (relativePath: string) => void | Promise<void>;
    readonly afterDirectoryEnumerated?: (relativePath: string) => void | Promise<void>;
  };

  constructor(options: {
    readonly readChunkBytes?: number;
    readonly testHooks?: {
      readonly beforeFileOpen?: (relativePath: string) => void | Promise<void>;
      readonly beforeDescriptorOpen?: (relativePath: string) => void | Promise<void>;
      readonly afterDirectoryEnumerated?: (relativePath: string) => void | Promise<void>;
    };
  } = {}) {
    const chunkBytes = options.readChunkBytes ?? DEFAULT_READ_CHUNK_BYTES;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024) {
      throw new IntakeError("invalid_limits", "intake read chunk limit is invalid");
    }
    this.readChunkBytes = chunkBytes;
    this.testHooks = options.testHooks ?? {};
  }

  async collect(
    request: TicketIntakeRequest,
    reservedRoots: readonly string[] = [],
  ): Promise<TicketIntakeSnapshot> {
    assertRunBoundary(request);
    const run = pinRun(request.run);
    const limits = resolveTicketIntakeLimits(run, request.limits);
    if (request.source.kind === "inline_goal") {
      return this.collectInline(run, request.source.goal, limits);
    }
    return this.collectDirectory(run, request.source.root, limits, reservedRoots);
  }

  private collectInline(run: RunView, goal: string, limits: EffectiveTicketIntakeLimits): TicketIntakeSnapshot {
    const bytes = Buffer.from(goal, "utf8");
    assertReference(run, bytes);
    const provenance = provenanceFor(run, "inline_goal", sha256("inline-goal"), null);
    const rejected: RejectedTicketSource[] = [];
    if (bytes.length > limits.maxFileBytes) {
      rejected.push(rejection("$inline", "file_too_large", bytes.length, null, provenance));
    } else if (bytes.length > limits.maxTotalBytes) {
      rejected.push(rejection("$inline", "aggregate_size_exceeded", bytes.length, sha256(bytes), provenance, bytes.length));
    } else {
      const decoded = decodeTicketText(bytes);
      if (!decoded.ok) rejected.push(rejection("$inline", decoded.reason, bytes.length, sha256(bytes), provenance, bytes.length));
      else if (decoded.text.length === 0) throw new IntakeError("empty_source", "inline source is empty");
      else {
        const source = discovered(run, "$inline", bytes, decoded.text, provenance);
        return snapshot(run, limits, [source], []);
      }
    }
    throw new IntakeError(
      "no_accepted_sources",
      "inline source was rejected",
      deepFreeze(rejected),
      rejected.reduce((sum, item) => sum + item.bytesRead, 0),
    );
  }

  private async collectDirectory(
    run: RunView,
    suppliedRoot: string,
    limits: EffectiveTicketIntakeLimits,
    reservedRoots: readonly string[],
  ): Promise<TicketIntakeSnapshot> {
    if (!path.isAbsolute(suppliedRoot)) throw new IntakeError("invalid_root", "ticket directory root must be absolute");
    const root = path.resolve(suppliedRoot);
    assertReference(run, Buffer.from(root, "utf8"));

    let rootFrame: DirectoryFrame;
    try {
      rootFrame = await openDirectoryFrame(root);
    } catch (error) {
      if (error instanceof IntakeError) throw error;
      throw new IntakeError("invalid_root", "ticket directory root is unavailable");
    }

    const rootIdentity = identity(rootFrame.stat);
    const rootIdentitySha256 = sha256([
      rootFrame.canonicalPath,
      rootIdentity.device,
      rootIdentity.inode,
      rootFrame.stat.mode.toString(),
      rootFrame.stat.size.toString(),
      rootFrame.stat.mtimeNs.toString(),
      rootFrame.stat.ctimeNs.toString(),
    ].join("\0"));
    const sources: DiscoveredTicketSource[] = [];
    const rejected: RejectedTicketSource[] = [];
    let totalBytes = 0;
    let examinedEntries = 0;
    let stopped = false;
    const reservedCanonicalRoots = new Set<string>();
    for (const reservedRoot of reservedRoots) {
      if (!path.isAbsolute(reservedRoot)) throw new IntakeError("invalid_root", "reserved intake root must be absolute");
      try {
        reservedCanonicalRoots.add(await realpath(reservedRoot));
      } catch {
        // A configured reserved root that does not exist cannot be traversed.
      }
    }

    const reject = (
      relativePath: string,
      reason: SourceRejectionReason,
      sizeBytes: number | null,
      digest: string | null,
      stat: BigIntStats | null,
      bytesRead = 0,
    ): void => {
      rejected.push(rejection(
        boundedPath(relativePath),
        reason,
        sizeBytes,
        digest,
        provenanceFor(run, "ticket_directory", rootIdentitySha256, stat),
        bytesRead,
      ));
    };

    if (isReservedPath(rootFrame.canonicalPath, reservedCanonicalRoots)) {
      reject("$root", "reserved_runtime_state", null, null, rootFrame.stat);
      await rootFrame.handle.close().catch(() => undefined);
      throw new IntakeError(
        "no_accepted_sources",
        "ticket source root is reserved runtime state",
        deepFreeze(rejected),
      );
    }

    const scan = async (frames: readonly DirectoryFrame[], relativeDirectory: string, depth: number): Promise<void> => {
      if (stopped) return;
      const current = frames.at(-1)!;
      let names: string[];
      try {
        await validateDirectoryFrames(frames);
        const directory = await opendir(current.expectedPath, { bufferSize: 1 });
        names = [];
        let directoryOverflow = false;
        let globalOverflow = false;
        try {
          for await (const entry of directory) {
            examinedEntries += 1;
            if (examinedEntries > limits.maxEntries) {
              globalOverflow = true;
              break;
            }
            if (names.length >= limits.maxDirectoryEntries) {
              directoryOverflow = true;
              break;
            }
            names.push(entry.name);
          }
        } finally {
          await directory.close().catch(() => undefined);
        }
        await this.testHooks.afterDirectoryEnumerated?.(relativeDirectory || "$root");
        await validateDirectoryFrames(frames);
        if (globalOverflow) {
          reject(relativeDirectory || "$root", "entry_limit_exceeded", null, null, current.stat);
          stopped = true;
          return;
        }
        if (directoryOverflow) {
          reject(relativeDirectory || "$root", "directory_too_many_entries", null, null, current.stat);
          return;
        }
        names.sort(compareCodeUnits);
      } catch {
        reject(relativeDirectory || "$root", "changed_during_read", null, null, null);
        throw new DirectoryChangedError();
      }

      const sourceStart = sources.length;
      const rejectedStart = rejected.length;
      for (const name of names) {
        if (stopped) break;
        const rawRelative = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
        const relativePath = normalizeSourceRelativePath(rawRelative);
        if (relativePath === null) {
          reject(rawRelative, rawRelative.includes("\0") || Buffer.byteLength(rawRelative) > MAX_RELATIVE_PATH_BYTES
            ? "path_too_long"
            : "path_escape", null, null, null);
          continue;
        }

        const absolute = path.join(current.expectedPath, name);
        let stat: BigIntStats;
        try {
          await validateDirectoryFrames(frames);
          stat = await lstat(absolute, { bigint: true });
        } catch {
          reject(relativePath, "changed_during_read", null, null, null);
          continue;
        }
        if (stat.isSymbolicLink()) {
          reject(relativePath, "symlink", null, null, stat);
          continue;
        }
        if (stat.isDirectory()) {
          let canonicalDirectory: string;
          try {
            canonicalDirectory = await realpath(absolute);
          } catch {
            reject(relativePath, "changed_during_read", null, null, stat);
            continue;
          }
          if (isReservedPath(canonicalDirectory, reservedCanonicalRoots)) {
            reject(relativePath, "reserved_runtime_state", null, null, stat);
            continue;
          }
          if (depth + 1 > limits.maxDepth) reject(relativePath, "depth_exceeded", null, null, stat);
          else {
            try {
              const frame = await openDirectoryFrame(absolute);
              try {
                await scan([...frames, frame], relativePath, depth + 1);
              } finally {
                await frame.handle.close().catch(() => undefined);
              }
            } catch (error) {
              if (error instanceof DirectoryChangedError) throw error;
              reject(relativePath, "changed_during_read", null, null, stat);
            }
          }
          continue;
        }
        if (stat.isFile() && sources.length >= limits.maxFiles) {
          reject(relativePath, "source_count_exceeded", null, null, stat);
          stopped = true;
          break;
        }
        if (!stat.isFile()) {
          reject(relativePath, "special_file", sizeNumber(stat), null, stat);
          continue;
        }

        const sizeBytes = sizeNumber(stat);
        if (sizeBytes > limits.maxFileBytes) {
          reject(relativePath, "file_too_large", sizeBytes, null, stat);
          continue;
        }
        if (totalBytes + sizeBytes > limits.maxTotalBytes) {
          reject(relativePath, "aggregate_size_exceeded", sizeBytes, null, stat);
          stopped = true;
          break;
        }
        let canonicalFile: string;
        try {
          canonicalFile = await realpath(absolute);
        } catch {
          reject(relativePath, "changed_during_read", sizeBytes, null, stat);
          continue;
        }
        if (!isContained(rootFrame.canonicalPath, canonicalFile)) {
          reject(relativePath, "path_escape", sizeBytes, null, stat);
          continue;
        }

        const read = await this.readStableFile(
          absolute,
          relativePath,
          canonicalFile,
          frames,
          stat,
          Math.min(limits.maxFileBytes, limits.maxTotalBytes - totalBytes),
        );
        totalBytes += read.bytesRead;
        if (!read.ok) {
          reject(relativePath, "changed_during_read", sizeBytes, null, stat, read.bytesRead);
          continue;
        }
        const digest = sha256(read.bytes);
        const decoded = decodeTicketText(read.bytes);
        if (!decoded.ok) {
          reject(relativePath, decoded.reason, read.bytes.length, digest, read.stat, read.bytesRead);
          continue;
        }
        const source = discovered(
          run,
          relativePath,
          read.bytes,
          decoded.text,
          provenanceFor(run, "ticket_directory", rootIdentitySha256, read.stat),
        );
        sources.push(source);
      }

      try {
        await validateDirectoryFrames(frames);
      } catch {
        sources.splice(sourceStart);
        rejected.splice(rejectedStart);
        reject(relativeDirectory || "$root", "changed_during_read", null, null, null);
        throw new DirectoryChangedError();
      }
    };

    try {
      await scan([rootFrame], "", 0);
      await validateDirectoryFrames([rootFrame]);
    } catch {
      throw new IntakeError("invalid_root", "ticket directory root changed during intake", deepFreeze(rejected));
    } finally {
      await rootFrame.handle.close().catch(() => undefined);
    }

    sources.sort((left, right) => compareCodeUnits(left.relativePath, right.relativePath));
    rejected.sort((left, right) => compareCodeUnits(left.relativePath, right.relativePath));
    if (sources.length === 0) {
      const code = examinedEntries === 0 && rejected.length === 0 ? "empty_source" : "no_accepted_sources";
      throw new IntakeError(
        code,
        code === "empty_source" ? "ticket directory is empty" : "ticket directory has no accepted text sources",
        deepFreeze(rejected),
        totalBytes,
      );
    }
    return snapshot(run, limits, sources, rejected, totalBytes);
  }

  private async readStableFile(
    filename: string,
    relativePath: string,
    expectedCanonicalPath: string,
    frames: readonly DirectoryFrame[],
    pathStat: BigIntStats,
    maxReadableBytes: number,
  ): Promise<
    | { readonly ok: true; readonly bytes: Buffer; readonly stat: BigIntStats; readonly bytesRead: number }
    | { readonly ok: false; readonly bytesRead: number }
  > {
    let handle: FileHandle | undefined;
    let total = 0;
    try {
      await validateDirectoryFrames(frames);
      await this.testHooks.beforeFileOpen?.(relativePath);
      await validateDirectoryFrames(frames);
      if (await realpath(filename) !== expectedCanonicalPath) return { ok: false, bytesRead: total };
      await this.testHooks.beforeDescriptorOpen?.(relativePath);
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || !sameIdentity(pathStat, before)) return { ok: false, bytesRead: total };
      await validateDirectoryFrames(frames);
      if (await realpath(filename) !== expectedCanonicalPath) return { ok: false, bytesRead: total };
      const chunks: Buffer[] = [];
      const expectedBytes = sizeNumber(pathStat);
      if (expectedBytes > maxReadableBytes) return { ok: false, bytesRead: total };
      while (total < expectedBytes) {
        const buffer = Buffer.allocUnsafe(Math.min(this.readChunkBytes, expectedBytes - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        chunks.push(buffer.subarray(0, bytesRead));
        total += bytesRead;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const after = await handle.stat({ bigint: true });
      const finalPath = await lstat(filename, { bigint: true });
      await validateDirectoryFrames(frames);
      if (await realpath(filename) !== expectedCanonicalPath
        || !sameIdentity(before, after)
        || !sameIdentity(after, finalPath)
        || BigInt(total) !== after.size) {
        return { ok: false, bytesRead: total };
      }
      return { ok: true, bytes: Buffer.concat(chunks, total), stat: after, bytesRead: total };
    } catch {
      return { ok: false, bytesRead: total };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

export function decodeTicketText(bytes: Uint8Array): TicketTextDecodeResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, reason: "invalid_encoding" };
  }
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0
      || (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13)
      || (codePoint >= 127 && codePoint <= 159)) {
      return { ok: false, reason: "binary" };
    }
  }
  return { ok: true, text };
}

export function normalizeSourceRelativePath(candidate: string): string | null {
  if (candidate.length === 0
    || candidate.includes("\0")
    || candidate.includes("\\")
    || path.posix.isAbsolute(candidate)
    || path.win32.isAbsolute(candidate)) {
    return null;
  }
  const portable = candidate.replaceAll("\\", "/");
  const components = portable.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) return null;
  const normalized = components.join("/");
  return Buffer.byteLength(normalized, "utf8") <= MAX_RELATIVE_PATH_BYTES ? normalized : null;
}

function assertRunBoundary(request: TicketIntakeRequest): void {
  if (request.run.lifecycle !== "intake") {
    throw new IntakeError("run_not_in_intake", "source intake requires a run in intake lifecycle");
  }
  if (request.run.source.kind !== request.source.kind) {
    throw new IntakeError("source_reference_mismatch", "source kind differs from the accepted run");
  }
}

function pinRun(run: RunView): RunView {
  return deepFreeze({
    ...run,
    projectRevision: { ...run.projectRevision },
    source: { ...run.source },
    actor: { ...run.actor },
    acceptedBy: { ...run.acceptedBy },
    activeProcess: { ...run.activeProcess },
    budget: { ...run.budget },
    authority: { ...run.authority },
    cancellation: run.cancellation === null
      ? null
      : {
          ...run.cancellation,
          requestedBy: { ...run.cancellation.requestedBy },
          process: { ...run.cancellation.process },
        },
  });
}

export function resolveTicketIntakeLimits(run: RunView, requested: TicketIntakeLimits): EffectiveTicketIntakeLimits {
  const maxEntries = requested.maxEntries ?? Math.min(100_000, Math.max(64, requested.maxFiles * 4));
  const maxDirectoryEntries = requested.maxDirectoryEntries ?? Math.min(10_000, Math.max(32, requested.maxFiles * 2));
  const values = [
    requested.maxFileBytes,
    requested.maxFiles,
    requested.maxTotalBytes,
    requested.maxDepth,
    maxEntries,
    maxDirectoryEntries,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)
    || requested.maxFileBytes < 1
    || requested.maxFiles < 1
    || requested.maxTotalBytes < 1
    || requested.maxDepth > 64
    || maxEntries > 100_000
    || maxDirectoryEntries > 10_000) {
    throw new IntakeError("invalid_limits", "ticket intake limits are invalid");
  }
  return deepFreeze({
    maxFileBytes: Math.min(requested.maxFileBytes, run.budget.maxSourceBytes),
    maxFiles: Math.min(requested.maxFiles, run.budget.maxSourceFiles),
    maxTotalBytes: Math.min(requested.maxTotalBytes, run.budget.maxSourceBytes),
    maxDepth: requested.maxDepth,
    maxEntries,
    maxDirectoryEntries,
  });
}

function assertReference(run: RunView, reference: Uint8Array): void {
  if (run.source.referenceSha256 !== sha256(reference) || run.source.declaredBytes !== reference.byteLength) {
    throw new IntakeError("source_reference_mismatch", "source reference differs from the accepted run");
  }
}

function discovered(
  run: RunView,
  relativePath: string,
  bytes: Buffer,
  quotedText: string,
  provenance: SourceProvenance,
): DiscoveredTicketSource {
  const contentSha256 = sha256(bytes);
  return deepFreeze({
    sourceId: `source-v1:${sha256(`${run.runId}\0${relativePath}\0${contentSha256}`)}`,
    relativePath,
    quotedText,
    trust: "untrusted_planning_data",
    mediaType: "text/plain; charset=utf-8",
    sizeBytes: bytes.length,
    sha256: contentSha256,
    artifact: null,
    provenance,
  });
}

function rejection(
  relativePath: string,
  reason: SourceRejectionReason,
  sizeBytes: number | null,
  digest: string | null,
  provenance: SourceProvenance,
  bytesRead = 0,
): RejectedTicketSource {
  return deepFreeze({ relativePath, reason, sizeBytes, digest, bytesRead, provenance });
}

function provenanceFor(
  run: RunView,
  sourceKind: "inline_goal" | "ticket_directory",
  rootIdentitySha256: string,
  stat: BigIntStats | null,
): SourceProvenance {
  return deepFreeze({
    runId: run.runId,
    projectId: run.projectId,
    projectRevision: deepFreeze({ ...run.projectRevision }),
    sourceKind,
    rootIdentitySha256,
    device: stat === null ? null : stat.dev.toString(),
    inode: stat === null ? null : stat.ino.toString(),
    modifiedNanoseconds: stat === null ? null : stat.mtimeNs.toString(),
    changedNanoseconds: stat === null ? null : stat.ctimeNs.toString(),
  });
}

function snapshot(
  run: RunView,
  limits: EffectiveTicketIntakeLimits,
  sources: readonly DiscoveredTicketSource[],
  rejected: readonly RejectedTicketSource[],
  totalBytes = sources.reduce((sum, source) => sum + source.sizeBytes, 0),
): TicketIntakeSnapshot {
  const events: SourceIntakeEvent[] = [
    ...sources.map((source): SourceIntakeEvent => ({
      type: "source.discovered",
      payload: {
        schemaVersion: INTAKE_SCHEMA_VERSION,
        runId: run.runId,
        projectId: run.projectId,
        sourceId: source.sourceId,
        path: source.relativePath,
        sizeBytes: source.sizeBytes,
        digest: source.sha256,
        trust: source.trust,
        provenance: source.provenance,
      },
    })),
    ...rejected.map((item): SourceIntakeEvent => ({
      type: "source.rejected",
      payload: {
        schemaVersion: INTAKE_SCHEMA_VERSION,
        runId: run.runId,
        projectId: run.projectId,
        path: item.relativePath,
        reason: item.reason,
        sizeBytes: item.sizeBytes,
        digest: item.digest,
        bytesRead: item.bytesRead,
        provenance: item.provenance,
      },
    })),
  ].sort((left, right) => compareCodeUnits(left.payload.path, right.payload.path));
  const digestInput = {
    schemaVersion: INTAKE_SCHEMA_VERSION,
    runId: run.runId,
    projectId: run.projectId,
    projectRevision: run.projectRevision,
    sourceKind: run.source.kind,
    limits,
    sources: sources.map(({ sourceId, relativePath, sizeBytes, sha256: digest, provenance }) => ({
      sourceId, relativePath, sizeBytes, digest, provenance,
    })),
    rejected,
    totalBytes,
  };
  return deepFreeze({
    schemaVersion: INTAKE_SCHEMA_VERSION,
    closed: true,
    runId: run.runId,
    projectId: run.projectId,
    projectRevision: { ...run.projectRevision },
    sourceKind: run.source.kind,
    limits,
    sources: [...sources],
    rejected: [...rejected],
    events,
    totalBytes,
    snapshotSha256: sha256(JSON.stringify(digestInput)),
  });
}

function identity(stat: BigIntStats): { readonly device: string; readonly inode: string } {
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sizeNumber(stat: BigIntStats): number {
  return stat.size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(stat.size);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isReservedPath(candidate: string, reservedRoots: ReadonlySet<string>): boolean {
  for (const reservedRoot of reservedRoots) {
    const relative = path.relative(reservedRoot, candidate);
    if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
      return true;
    }
  }
  return false;
}

function boundedPath(relativePath: string): string {
  if (relativePath.length > 0
    && !relativePath.includes("\0")
    && !relativePath.includes("\\")
    && Buffer.byteLength(relativePath, "utf8") <= MAX_RELATIVE_PATH_BYTES) {
    return relativePath;
  }
  return `$path-sha256:${sha256(relativePath)}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface DirectoryFrame {
  readonly expectedPath: string;
  readonly canonicalPath: string;
  readonly stat: BigIntStats;
  readonly handle: FileHandle;
}

class DirectoryChangedError extends Error {}

async function openDirectoryFrame(expectedPath: string): Promise<DirectoryFrame> {
  const pathStat = await lstat(expectedPath, { bigint: true });
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) throw new DirectoryChangedError();
  const canonicalPath = await realpath(expectedPath);
  const handle = await open(expectedPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const descriptorStat = await handle.stat({ bigint: true });
    if (!descriptorStat.isDirectory() || !sameIdentity(pathStat, descriptorStat)) throw new DirectoryChangedError();
    return { expectedPath, canonicalPath, stat: descriptorStat, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function validateDirectoryFrames(frames: readonly DirectoryFrame[]): Promise<void> {
  // Node does not expose openat(2); repeated descriptor and canonical checks harden this
  // Trusted-Project Darwin boundary but are not an OS sandbox against malicious same-user races.
  for (const frame of frames) {
    const retainedStat = await frame.handle.stat({ bigint: true });
    const pathStat = await lstat(frame.expectedPath, { bigint: true });
    if (!sameIdentity(frame.stat, retainedStat)
      || pathStat.isSymbolicLink()
      || !pathStat.isDirectory()
      || !sameIdentity(frame.stat, pathStat)
      || await realpath(frame.expectedPath) !== frame.canonicalPath) {
      throw new DirectoryChangedError();
    }
    const handle = await open(frame.expectedPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const descriptorStat = await handle.stat({ bigint: true });
      if (!sameIdentity(frame.stat, descriptorStat)) throw new DirectoryChangedError();
    } finally {
      await handle.close();
    }
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
