import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { chmod, link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import {
  IntakeArtifactReferenceSchema,
  IntakeTextArtifactEnvelopeSchema,
  computeIntakeArtifactAggregateSha256,
  type IntakeArtifactReference,
} from "./intake-contracts.js";
import type { TicketIntakeSnapshot } from "./ticket-intake.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_TEMP_ENTRIES = 10_000;
declare const verificationCapabilityBrand: unique symbol;
const synchronousArtifactVerifier = Symbol("zentra.intake.synchronous-artifact-verifier");
const pendingVerifications = new WeakMap<object, {
  readonly store: IntakeArtifactStore;
  readonly snapshot: TicketIntakeSnapshot;
  readonly sourceStreamId: string;
  readonly closureEventId: string;
}>();

export interface VerifiedIntakeArtifacts {
  readonly runId: string;
  readonly snapshotSha256: string;
  readonly sourceStreamId: string;
  readonly closureEventId: string;
  readonly artifactAggregateSha256: string;
  readonly retainedSourceAggregateSha256: string;
}

export interface IntakeArtifactVerificationCapability {
  readonly [verificationCapabilityBrand]: true;
}

export interface PreparedIntakeArtifact {
  readonly artifact: IntakeArtifactReference;
  readonly temporaryName: string;
}

/** A fixed-layout Trusted-Project store that validates same-user tampering but cannot prevent it as an OS sandbox. */
export class IntakeArtifactStore {
  private constructor(
    private readonly projectRoot: string,
    private readonly intakeRoot: string,
    private readonly temporaryRoot: string,
    private readonly artifactRoot: string,
    private readonly hooks: { readonly afterPublishLink?: () => void | Promise<void> },
  ) {}

  static async openProject(
    suppliedProjectRoot: string,
    hooks: { readonly afterPublishLink?: () => void | Promise<void> } = {},
  ): Promise<IntakeArtifactStore> {
    if (!path.isAbsolute(suppliedProjectRoot)) throw new Error("intake artifact project root must be absolute");
    const rootStat = await lstat(suppliedProjectRoot, { bigint: true });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("intake artifact project root is invalid");
    const projectRoot = await realpath(suppliedProjectRoot);
    const stateRoot = path.join(projectRoot, ".zentra");
    const intakeRoot = path.join(stateRoot, "intake");
    const temporaryRoot = path.join(intakeRoot, "tmp");
    const artifactRoot = path.join(intakeRoot, "artifacts");
    for (const directory of [stateRoot, intakeRoot, temporaryRoot, artifactRoot]) {
      await ensurePrivateDirectory(directory, projectRoot);
    }
    return new IntakeArtifactStore(projectRoot, intakeRoot, temporaryRoot, artifactRoot, hooks);
  }

  async stage(quotedText: string): Promise<PreparedIntakeArtifact> {
    await this.validateLayout();
    const bytes = Buffer.from(quotedText, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifact = IntakeArtifactReferenceSchema.parse({
      artifactId: `intake-text-v1:${sha256}`,
      sha256,
      sizeBytes: bytes.length,
    });
    const envelope = IntakeTextArtifactEnvelopeSchema.parse({
      schemaVersion: 1,
      mediaType: "text/plain; charset=utf-8",
      trust: "untrusted_planning_data",
      sha256,
      sizeBytes: bytes.length,
      quotedText,
    });
    const temporaryName = `${sha256}.${randomUUID()}.tmp`;
    const temporaryPath = this.temporaryPath(temporaryName);
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      FILE_MODE,
    );
    try {
      await handle.chmod(FILE_MODE);
      await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(this.temporaryRoot);
    return Object.freeze({ artifact, temporaryName });
  }

  async publish(prepared: PreparedIntakeArtifact): Promise<IntakeArtifactReference> {
    await this.validateLayout();
    const artifact = IntakeArtifactReferenceSchema.parse(prepared.artifact);
    if (!prepared.temporaryName.startsWith(`${artifact.sha256}.`) || !prepared.temporaryName.endsWith(".tmp")) {
      throw new Error("intake artifact temporary identity is invalid");
    }
    const temporaryPath = this.temporaryPath(prepared.temporaryName);
    await this.readEnvelope(temporaryPath, artifact, false);
    const destination = this.artifactPath(artifact.sha256);
    let linked = false;
    try {
      await link(temporaryPath, destination);
      linked = true;
      await fsyncDirectory(this.artifactRoot);
      await this.hooks.afterPublishLink?.();
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      await this.readEnvelope(destination, artifact, false);
    }
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
    await fsyncDirectory(this.temporaryRoot);
    if (linked) await fsyncDirectory(this.artifactRoot);
    await this.readEnvelope(destination, artifact, false);
    return artifact;
  }

  async load(artifactInput: IntakeArtifactReference): Promise<{
    readonly quotedText: string;
    readonly artifact: IntakeArtifactReference;
  }> {
    await this.validateLayout();
    const artifact = IntakeArtifactReferenceSchema.parse(artifactInput);
    await this.reconcile(artifact);
    const envelope = await this.readEnvelope(this.artifactPath(artifact.sha256), artifact, false);
    return Object.freeze({ quotedText: envelope.quotedText, artifact });
  }

  reservedSourceRoots(): readonly string[] {
    return Object.freeze([
      path.join(this.projectRoot, ".zentra"),
      this.intakeRoot,
      this.temporaryRoot,
      this.artifactRoot,
    ]);
  }

  private async reconcile(artifact: IntakeArtifactReference): Promise<void> {
    const destination = this.artifactPath(artifact.sha256);
    let destinationStat: BigIntStats | null = null;
    try {
      destinationStat = await lstat(destination, { bigint: true });
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    const candidates = await this.temporaryCandidates(artifact.sha256);
    if (destinationStat === null) {
      if (candidates.length === 0) throw new Error("intake artifact is missing");
      for (const candidate of candidates) {
        await this.readEnvelope(this.temporaryPath(candidate), artifact, false);
      }
      await this.publish({ artifact, temporaryName: candidates[0]! });
      await this.removeEquivalentCandidates(artifact, candidates.slice(1));
      return;
    }
    if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) throw new Error("intake artifact is symbolic or special");
    if (destinationStat.nlink > 1n) {
      let removed = 0;
      for (const candidate of candidates) {
        const candidatePath = this.temporaryPath(candidate);
        const candidateStat = await lstat(candidatePath, { bigint: true });
        if (candidateStat.dev === destinationStat.dev && candidateStat.ino === destinationStat.ino) {
          await unlink(candidatePath);
          removed += 1;
        }
      }
      if (removed !== 1) throw new Error("intake artifact has an unexplained link count");
      await fsyncDirectory(this.temporaryRoot);
      await fsyncDirectory(this.artifactRoot);
    }
    const remaining = await this.temporaryCandidates(artifact.sha256);
    await this.removeEquivalentCandidates(artifact, remaining);
  }

  private async removeEquivalentCandidates(
    artifact: IntakeArtifactReference,
    candidates: readonly string[],
  ): Promise<void> {
    for (const candidate of candidates) {
      const candidatePath = this.temporaryPath(candidate);
      await this.readEnvelope(candidatePath, artifact, false);
    }
    for (const candidate of candidates) await unlink(this.temporaryPath(candidate));
    if (candidates.length > 0) await fsyncDirectory(this.temporaryRoot);
  }

  private async temporaryCandidates(sha256: string): Promise<string[]> {
    const directory = await opendir(this.temporaryRoot, { bufferSize: 1 });
    const candidates: string[] = [];
    let examined = 0;
    try {
      for await (const entry of directory) {
        examined += 1;
        if (examined > MAX_TEMP_ENTRIES) throw new Error("intake artifact temporary directory exceeds its bound");
        if (entry.name.startsWith(`${sha256}.`) && entry.name.endsWith(".tmp")) candidates.push(entry.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return candidates.sort();
  }

  private async readEnvelope(
    filename: string,
    artifact: IntakeArtifactReference,
    allowMultipleLinks: boolean,
  ): Promise<ReturnType<typeof IntakeTextArtifactEnvelopeSchema.parse>> {
    const stat = await lstat(filename, { bigint: true }).catch((error: unknown) => {
      if (isCode(error, "ENOENT")) throw new Error("intake artifact is missing");
      throw error;
    });
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("intake artifact is symbolic or special");
    if ((stat.mode & 0o777n) !== 0o600n) throw new Error("intake artifact permissions are invalid");
    if (!allowMultipleLinks && stat.nlink !== 1n) throw new Error("intake artifact link count is invalid");
    if (stat.size > BigInt(artifact.sizeBytes) * 6n + 4096n) throw new Error("intake artifact envelope exceeds its bound");
    const canonical = await realpath(filename);
    if (!isContained(this.intakeRoot, canonical)) throw new Error("intake artifact escaped its fixed layout");
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const descriptorStat = await handle.stat({ bigint: true });
      if (descriptorStat.dev !== stat.dev || descriptorStat.ino !== stat.ino || descriptorStat.size !== stat.size) {
        throw new Error("intake artifact changed while opening");
      }
      const encoded = await handle.readFile("utf8");
      let decoded: unknown;
      try {
        decoded = JSON.parse(encoded) as unknown;
      } catch {
        throw new Error("intake artifact schema is invalid");
      }
      const envelope = IntakeTextArtifactEnvelopeSchema.parse(decoded);
      const bytes = Buffer.from(envelope.quotedText, "utf8");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== artifact.sha256
        || envelope.sha256 !== artifact.sha256
        || bytes.length !== artifact.sizeBytes
        || envelope.sizeBytes !== artifact.sizeBytes) {
        throw new Error("intake artifact digest or size is invalid");
      }
      return envelope;
    } finally {
      await handle.close();
    }
  }

  private artifactPath(sha256: string): string {
    return containedChild(this.artifactRoot, `${sha256}.json`);
  }

  private temporaryPath(name: string): string {
    if (!/^[a-f0-9]{64}\.[0-9a-f-]{36}\.tmp$/.test(name)) throw new Error("invalid intake artifact temporary name");
    return containedChild(this.temporaryRoot, name);
  }

  private async validateLayout(): Promise<void> {
    for (const directory of [
      path.join(this.projectRoot, ".zentra"),
      this.intakeRoot,
      this.temporaryRoot,
      this.artifactRoot,
    ]) {
      const stat = await lstat(directory, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777n) !== 0o700n) {
        throw new Error("intake artifact fixed layout changed or became unsafe");
      }
      if (await realpath(directory) !== directory || !isContained(this.projectRoot, directory)) {
        throw new Error("intake artifact fixed layout escaped project root");
      }
    }
  }

  [synchronousArtifactVerifier](artifactInput: IntakeArtifactReference): string {
    const artifact = IntakeArtifactReferenceSchema.parse(artifactInput);
    this.validateLayoutSync();
    const filename = this.artifactPath(artifact.sha256);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(filename, { bigint: true });
    } catch (error) {
      if (isCode(error, "ENOENT")) throw new Error("intake artifact is missing");
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("intake artifact is symbolic or special");
    if ((stat.mode & 0o777n) !== 0o600n || stat.nlink !== 1n) throw new Error("intake artifact permissions or link count are invalid");
    const canonical = realpathSync.native(filename);
    if (!isContained(this.intakeRoot, canonical)) throw new Error("intake artifact escaped its fixed layout");
    const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (!sameFileIdentity(stat, before)) throw new Error("intake artifact changed while opening");
      const encoded = readFileSync(descriptor, "utf8");
      let decoded: unknown;
      try {
        decoded = JSON.parse(encoded) as unknown;
      } catch {
        throw new Error("intake artifact schema is invalid");
      }
      const envelope = IntakeTextArtifactEnvelopeSchema.parse(decoded);
      const bytes = Buffer.from(envelope.quotedText, "utf8");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const after = fstatSync(descriptor, { bigint: true });
      const finalPath = lstatSync(filename, { bigint: true });
      if (!sameFileIdentity(before, after)
        || !sameFileIdentity(after, finalPath)
        || digest !== artifact.sha256
        || envelope.sha256 !== artifact.sha256
        || bytes.length !== artifact.sizeBytes
        || envelope.sizeBytes !== artifact.sizeBytes) {
        throw new Error("intake artifact digest, size, or identity is invalid");
      }
      return envelope.quotedText;
    } finally {
      closeSync(descriptor);
    }
  }

  private validateLayoutSync(): void {
    for (const directory of [
      path.join(this.projectRoot, ".zentra"),
      this.intakeRoot,
      this.temporaryRoot,
      this.artifactRoot,
    ]) {
      const stat = lstatSync(directory, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777n) !== 0o700n) {
        throw new Error("intake artifact fixed layout changed or became unsafe");
      }
      if (realpathSync.native(directory) !== directory || !isContained(this.projectRoot, directory)) {
        throw new Error("intake artifact fixed layout escaped project root");
      }
    }
  }
}

export function prepareIntakeArtifactVerification(
  store: IntakeArtifactStore,
  snapshot: TicketIntakeSnapshot,
  sourceStreamId: string,
  closureEventId: string,
): IntakeArtifactVerificationCapability {
  const capability = Object.freeze({});
  pendingVerifications.set(capability, { store, snapshot, sourceStreamId, closureEventId });
  return capability as IntakeArtifactVerificationCapability;
}

export function consumeAndVerifyIntakeArtifacts(
  capability: IntakeArtifactVerificationCapability,
): VerifiedIntakeArtifacts {
  const pending = typeof capability === "object" && capability !== null
    ? pendingVerifications.get(capability)
    : undefined;
  if (pending === undefined) throw new Error("intake artifact verification capability is invalid or already consumed");
  pendingVerifications.delete(capability);
  return verifySnapshotArtifacts(pending.store, pending.snapshot, pending.sourceStreamId, pending.closureEventId);
}

function verifySnapshotArtifacts(
  store: IntakeArtifactStore,
  snapshot: TicketIntakeSnapshot,
  sourceStreamId: string,
  closureEventId: string,
): VerifiedIntakeArtifacts {
  const aggregate: Array<{
    readonly sourceId: string;
    readonly relativePath: string;
    readonly artifact: IntakeArtifactReference;
  }> = [];
  for (const source of snapshot.sources) {
    if (source.artifact === null) throw new Error("intake snapshot source lacks durable artifact evidence");
    const quotedText = store[synchronousArtifactVerifier](source.artifact);
    if (quotedText !== source.quotedText) throw new Error("intake artifact content contradicts reconstructed snapshot");
    aggregate.push({ sourceId: source.sourceId, relativePath: source.relativePath, artifact: source.artifact });
  }
  return Object.freeze({
    runId: snapshot.runId,
    snapshotSha256: snapshot.snapshotSha256,
    sourceStreamId,
    closureEventId,
    artifactAggregateSha256: computeIntakeArtifactAggregateSha256(aggregate),
    retainedSourceAggregateSha256: computeRetainedAnalysisSourceSha256(snapshot),
  });
}

export function computeRetainedAnalysisSourceSha256(snapshot: TicketIntakeSnapshot): string {
  return createHash("sha256").update(JSON.stringify([...snapshot.sources]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    .map((source) => {
      if (source.artifact === null) throw new Error("retained intake source lacks an artifact");
      return {
        sourceId: source.sourceId,
        relativePath: source.relativePath,
        artifactId: source.artifact.artifactId,
        sha256: source.sha256,
        normalizedContentSha256: source.artifact.sha256,
        provenanceSha256: createHash("sha256").update(JSON.stringify(source.provenance)).digest("hex"),
      };
    }))).digest("hex");
}

async function ensurePrivateDirectory(directory: string, projectRoot: string): Promise<void> {
  let created = true;
  await mkdir(directory, { mode: DIRECTORY_MODE }).catch((error: unknown) => {
    if (!isCode(error, "EEXIST")) throw error;
    created = false;
  });
  if (created) await chmod(directory, DIRECTORY_MODE);
  const stat = await lstat(directory, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777n) !== 0o700n) {
    throw new Error("intake artifact directory is unsafe");
  }
  const canonical = await realpath(directory);
  if (!isContained(projectRoot, canonical)) throw new Error("intake artifact directory escaped project root");
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function containedChild(parent: string, name: string): string {
  const candidate = path.join(parent, name);
  if (path.dirname(candidate) !== parent) throw new Error("intake artifact path escaped its fixed layout");
  return candidate;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}
