import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const RUNTIME_SCHEMA_VERSION = 1;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_METADATA_BYTES = 64 * 1024;
const VERSION_CONTENT = `${RUNTIME_SCHEMA_VERSION}\n`;
const GIT_EXECUTABLE = "/usr/bin/git";
const NODE_EXECUTABLE = realpathSync.native(process.execPath);
const PROCESS_INCARNATION = `process-v2:${createHash("sha256").update(JSON.stringify({
  pid: process.pid,
  executable: NODE_EXECUTABLE,
  timeOrigin: performance.timeOrigin,
})).digest("hex")}`;
const RUNTIME_MASTER_SECRET = randomBytes(32);

const LayoutMarkerSchema = z.strictObject({
  schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
  database: z.literal("events.sqlite"),
  traces: z.literal("traces"),
  runtime: z.literal("runtime"),
});

const RuntimeStateSchema = z.strictObject({
  schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
  pid: z.number().int().positive(),
  processIncarnation: z.string().regex(/^process-v2:[a-f0-9]{64}$/),
  address: z.strictObject({
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1).max(65_535),
  }),
  tokenExpiresAt: z.iso.datetime({ offset: true }),
  startupStatus: z.enum(["starting", "ready", "stopping", "failed"]),
});

const RuntimeStateInputSchema = RuntimeStateSchema.omit({
  schemaVersion: true,
  pid: true,
  processIncarnation: true,
}).strict();

const RuntimeClaimSchema = z.strictObject({
  pid: z.number().int().positive(),
  processIncarnation: z.string().regex(/^process-v2:[a-f0-9]{64}$/),
});

const StoreResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(false), error: z.string().min(1).max(1_024) }),
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
]);

export type RuntimeState = z.infer<typeof RuntimeStateSchema>;
export type RuntimeStateInput = z.input<typeof RuntimeStateInputSchema>;

export interface ProjectDiscoveredEvidence {
  readonly type: "project.discovered";
  readonly schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
  readonly projectRoot: string;
  readonly discoveredFrom: string;
}

export interface ProjectDiscovery {
  readonly root: string;
  readonly gitDirectory: string;
  readonly evidence: ProjectDiscoveredEvidence;
}

export interface ProjectRuntimeLayout {
  readonly schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly versionPath: string;
  readonly schemaPath: string;
  readonly databasePath: string;
  readonly traceDirectory: string;
  readonly runtimeDirectory: string;
  readonly runtimeStatePath: string;
  readonly runtimeOwnerPath: string;
}

export interface RuntimeClaim {
  readonly pid: number;
  readonly processIncarnation: string;
}

export interface ServiceStartingEvidence {
  readonly type: "service.starting";
  readonly schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
  readonly pid: number;
  readonly processIncarnation: string;
  readonly address: RuntimeState["address"];
  readonly tokenExpiresAt: string;
  readonly occurredAt: string;
  readonly observation: "performed" | "reconciled";
}

export interface RuntimePublicationEvidence {
  readonly type: "runtime.published";
  readonly schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
  readonly pid: number;
  readonly processIncarnation: string;
  readonly startupStatus: RuntimeState["startupStatus"];
  readonly statePath: string;
  readonly occurredAt: string;
  readonly observation: "performed" | "reconciled";
}

export interface StaleRuntimeEvidence {
  readonly type: "runtime.stale_detected";
  readonly schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
  readonly stalePid: number;
  readonly staleProcessIncarnation: string;
  readonly reason: "process_not_running" | "process_incarnation_changed";
  readonly processSignalled: false;
  readonly detectedAt: string;
}

export interface RuntimeOwnership {
  readonly claim: RuntimeClaim;
  readonly state: RuntimeState;
  readonly staleEvidence: StaleRuntimeEvidence | null;
  readonly evidence: readonly [ServiceStartingEvidence, RuntimePublicationEvidence];
}

interface RuntimeStateManagerOptions {
  readonly beforeCommand?: (operation: "start" | "publish" | "read" | "remove") => void | Promise<void>;
  readonly dropStartResponseOnce?: () => boolean;
  readonly now?: () => Date;
}

interface InitializeRuntimeOptions {
  readonly beforeBootstrap?: () => void | Promise<void>;
}

interface RuntimeDirectoryIdentity {
  readonly device: number;
  readonly inode: number;
}

interface ClaimAuthority {
  readonly capability: string;
  readonly acquisitionId: string;
  readonly layoutIdentity: string;
}

interface AcceptedStoreStartResult {
  readonly kind: "accepted";
  readonly claim: RuntimeClaim;
  readonly state: RuntimeState;
  readonly recovered: boolean;
  readonly acquiredAt: string;
  readonly publishedAt: string;
  readonly stale: {
    readonly pid: number;
    readonly processIncarnation: string;
    readonly reason: StaleRuntimeEvidence["reason"];
    readonly detectedAt: string;
  } | null;
}

interface ReconcileStoreStartResult {
  readonly kind: "reconcile_acquisition";
  readonly acquisitionId: string;
}

type StoreStartResult = AcceptedStoreStartResult | ReconcileStoreStartResult;

interface StorePublishResult {
  readonly state: RuntimeState;
  readonly publishedAt: string;
}

const runtimeIdentities = new WeakMap<ProjectRuntimeLayout, RuntimeDirectoryIdentity>();
const claimAuthorities = new WeakMap<object, ClaimAuthority>();
const layoutMarker = LayoutMarkerSchema.parse({
  schemaVersion: RUNTIME_SCHEMA_VERSION,
  database: "events.sqlite",
  traces: "traces",
  runtime: "runtime",
});

if (realpathSync.native(GIT_EXECUTABLE) !== GIT_EXECUTABLE) {
  throw new Error("Git discovery executable must be canonical");
}

export async function discoverProject(startPath: string): Promise<ProjectDiscovery> {
  const requested = path.resolve(startPath);
  let discoveredFrom: string;
  try {
    discoveredFrom = await realpath(requested);
    if (!(await stat(discoveredFrom)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Project discovery path is not a canonical directory: ${requested}`);
  }

  const result = await runGitDiscovery(discoveredFrom);
  if (result.exitCode !== 0) {
    throw new Error(`Project discovery path is not inside a Git worktree: ${discoveredFrom}`);
  }
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  if (lines.length !== 3 || lines[2] !== "true") {
    throw new Error("Git worktree discovery returned malformed evidence");
  }

  const root = await canonicalDirectory(lines[0] ?? "", "Git worktree root");
  const gitDirectoryCandidate = lines[1] ?? "";
  const gitDirectory = await realpath(path.isAbsolute(gitDirectoryCandidate)
    ? gitDirectoryCandidate
    : path.resolve(discoveredFrom, gitDirectoryCandidate));
  if (!(await stat(gitDirectory)).isDirectory()) throw new Error("Git directory is not a directory");
  if (discoveredFrom !== root && !discoveredFrom.startsWith(`${root}${path.sep}`)) {
    throw new Error("Discovered path escapes the Git worktree root");
  }

  return {
    root,
    gitDirectory,
    evidence: {
      type: "project.discovered",
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      projectRoot: root,
      discoveredFrom,
    },
  };
}

export async function initializeProjectRuntime(
  discovery: ProjectDiscovery,
  options: InitializeRuntimeOptions = {},
): Promise<ProjectRuntimeLayout> {
  const projectRoot = await canonicalDirectory(discovery.root, "Project root");
  if (projectRoot !== discovery.root) throw new Error("Project root must be canonical");
  const verified = await discoverProject(projectRoot);
  if (verified.root !== discovery.root || verified.gitDirectory !== discovery.gitDirectory) {
    throw new Error("Project discovery evidence does not match the Git worktree");
  }
  const layout = createLayout(projectRoot);

  await ensurePrivateDirectory(layout.stateRoot);
  const stateIdentity = await directoryIdentity(layout.stateRoot);
  await options.beforeBootstrap?.();
  await runBootstrapWorker(layout.stateRoot, stateIdentity);
  await validateLayout(layout);
  runtimeIdentities.set(layout, await directoryIdentity(layout.runtimeDirectory));
  return layout;
}

export class RuntimeStateManager {
  private readonly identity: RuntimeDirectoryIdentity | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly layout: ProjectRuntimeLayout,
    private readonly options: RuntimeStateManagerOptions = {},
  ) {
    this.identity = runtimeIdentities.get(layout);
    this.now = options.now ?? (() => new Date());
  }

  async start(untrustedInput: RuntimeStateInput): Promise<RuntimeOwnership> {
    const input = RuntimeStateInputSchema.parse(untrustedInput);
    if (input.startupStatus !== "starting") {
      throw new Error("Initial runtime startup status must be starting");
    }
    const identity = this.requireIdentity();
    const layoutIdentity = runtimeLayoutIdentity(this.layout, identity);
    let acquisitionId: string = randomUUID();
    let capability = deriveCapability(layoutIdentity, acquisitionId);
    let value: StoreStartResult;
    for (let attempt = 0; ; attempt++) {
      value = await this.command<StoreStartResult>("start", {
        input: { ...input, pid: process.pid },
        processIncarnation: PROCESS_INCARNATION,
        acquisitionId,
        capability,
        occurredAt: this.now().toISOString(),
        suppressResponse: this.options.dropStartResponseOnce?.() ?? false,
      });
      if (value.kind === "accepted") break;
      if (attempt !== 0) throw new Error("Runtime acquisition reconciliation did not converge");
      acquisitionId = value.acquisitionId;
      capability = deriveCapability(layoutIdentity, acquisitionId);
    }
    const claim = RuntimeClaimSchema.parse(value.claim);
    claimAuthorities.set(claim, { capability, acquisitionId, layoutIdentity });
    const state = RuntimeStateSchema.parse(value.state);
    const staleEvidence: StaleRuntimeEvidence | null = value.stale === null ? null : {
      type: "runtime.stale_detected",
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      stalePid: value.stale.pid,
      staleProcessIncarnation: value.stale.processIncarnation,
      reason: value.stale.reason,
      processSignalled: false,
      detectedAt: value.stale.detectedAt,
    };
    return {
      claim,
      state,
      staleEvidence,
      evidence: [
        {
          type: "service.starting",
          schemaVersion: RUNTIME_SCHEMA_VERSION,
          pid: state.pid,
          processIncarnation: state.processIncarnation,
          address: state.address,
          tokenExpiresAt: state.tokenExpiresAt,
          occurredAt: value.acquiredAt,
          observation: value.recovered ? "reconciled" : "performed",
        },
        publicationEvidence(
          this.layout,
          state,
          value.publishedAt,
          value.recovered ? "reconciled" : "performed",
        ),
      ],
    };
  }

  async publish(
    claimInput: RuntimeClaim,
    untrustedInput: RuntimeStateInput,
  ): Promise<RuntimePublicationEvidence> {
    const authority = authorityForClaim(claimInput, this.layout, this.requireIdentity());
    const claim = RuntimeClaimSchema.parse(claimInput);
    const input = RuntimeStateInputSchema.parse(untrustedInput);
    const result = await this.command<StorePublishResult>("publish", {
      claim,
      capability: authority.capability,
      acquisitionId: authority.acquisitionId,
      input: { ...input, pid: claim.pid },
      occurredAt: this.now().toISOString(),
    });
    const state = RuntimeStateSchema.parse(result.state);
    return publicationEvidence(this.layout, state, result.publishedAt, "performed");
  }

  async read(): Promise<RuntimeState | null> {
    const value = await this.command<RuntimeState | null>("read", {});
    return value === null ? null : RuntimeStateSchema.parse(value);
  }

  async remove(claimInput: RuntimeClaim): Promise<void> {
    const authority = authorityForClaim(claimInput, this.layout, this.requireIdentity());
    const claim = RuntimeClaimSchema.parse(claimInput);
    await this.command("remove", {
      claim,
      capability: authority.capability,
      acquisitionId: authority.acquisitionId,
    });
    claimAuthorities.delete(claimInput);
  }

  private async command<T = unknown>(
    operation: "start" | "publish" | "read" | "remove",
    payload: unknown,
  ): Promise<T> {
    await validateLayout(this.layout);
    if (this.identity === undefined) {
      throw new Error("Runtime layout was not initialized in this process");
    }
    await this.options.beforeCommand?.(operation);
    const result = await runStoreWorker(this.layout, this.identity, {
      operation,
      payload: { ...(payload as Record<string, unknown>), callerPid: process.pid },
    });
    await assertDirectoryIdentity(this.layout.runtimeDirectory, this.identity);
    if (!result.ok) throw new Error(result.error);
    return result.value as T;
  }

  private requireIdentity(): RuntimeDirectoryIdentity {
    if (this.identity === undefined) throw new Error("Runtime layout was not initialized in this process");
    return this.identity;
  }
}

function authorityForClaim(
  claim: RuntimeClaim,
  layout: ProjectRuntimeLayout,
  identity: RuntimeDirectoryIdentity,
): ClaimAuthority {
  if (typeof claim !== "object" || claim === null) throw new Error("Runtime claim is invalid");
  const authority = claimAuthorities.get(claim);
  if (authority === undefined) {
    throw new Error("Runtime claim does not carry an in-memory mutation capability");
  }
  if (authority.layoutIdentity !== runtimeLayoutIdentity(layout, identity)) {
    throw new Error("Runtime claim belongs to a different runtime directory identity");
  }
  return authority;
}

function runtimeLayoutIdentity(
  layout: ProjectRuntimeLayout,
  identity: RuntimeDirectoryIdentity,
): string {
  return JSON.stringify({
    path: layout.runtimeDirectory,
    device: identity.device,
    inode: identity.inode,
  });
}

function deriveCapability(layoutIdentity: string, acquisitionId: string): string {
  return createHmac("sha256", RUNTIME_MASTER_SECRET)
    .update(layoutIdentity)
    .update("\0")
    .update(acquisitionId)
    .digest("base64url");
}

function publicationEvidence(
  layout: ProjectRuntimeLayout,
  state: RuntimeState,
  occurredAt: string,
  observation: "performed" | "reconciled",
): RuntimePublicationEvidence {
  return {
    type: "runtime.published",
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    pid: state.pid,
    processIncarnation: state.processIncarnation,
    startupStatus: state.startupStatus,
    statePath: layout.runtimeStatePath,
    occurredAt,
    observation,
  };
}

function createLayout(projectRoot: string): ProjectRuntimeLayout {
  const stateRoot = path.join(projectRoot, ".zentra");
  const runtimeDirectory = path.join(stateRoot, "runtime");
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    projectRoot,
    stateRoot,
    versionPath: path.join(stateRoot, "VERSION"),
    schemaPath: path.join(stateRoot, "layout.json"),
    databasePath: path.join(stateRoot, "events.sqlite"),
    traceDirectory: path.join(stateRoot, "traces"),
    runtimeDirectory,
    runtimeStatePath: path.join(runtimeDirectory, "state.json"),
    runtimeOwnerPath: path.join(runtimeDirectory, "state.json"),
  };
}

async function validateLayout(layout: ProjectRuntimeLayout): Promise<void> {
  const expected = createLayout(layout.projectRoot);
  if (
    layout.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
    Object.keys(expected).some((key) =>
      layout[key as keyof ProjectRuntimeLayout] !== expected[key as keyof ProjectRuntimeLayout])
  ) {
    throw new Error("Runtime layout contains state outside the project root");
  }
  if ((await realpath(layout.projectRoot)) !== layout.projectRoot) {
    throw new Error("Runtime project root must be canonical");
  }
  await assertPrivateDirectory(layout.stateRoot);
  await assertPrivateDirectory(layout.traceDirectory);
  await assertPrivateDirectory(layout.runtimeDirectory);
  if (await readPrivateFile(layout.versionPath, "runtime version") !== VERSION_CONTENT) {
    throw new Error("Runtime version marker is malformed or unsupported");
  }
  try {
    LayoutMarkerSchema.parse(JSON.parse(await readPrivateFile(layout.schemaPath, "runtime schema")));
  } catch (error) {
    if (error instanceof Error && error.message.includes("hard link")) throw error;
    throw new Error("Runtime schema marker is malformed or unsupported");
  }
  await assertPrivateFileIfPresent(layout.databasePath, "runtime database");
  await assertPrivateFileIfPresent(layout.runtimeStatePath, "runtime state");
  await assertPrivateFileIfPresent(layout.runtimeOwnerPath, "runtime owner");
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  await assertPrivateDirectory(directory);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink()) throw new Error(`Runtime directory must not be a symlink: ${directory}`);
  if (!metadata.isDirectory()) throw new Error(`Runtime path must be a directory: ${directory}`);
  if ((metadata.mode & 0o777) !== DIRECTORY_MODE) {
    throw new Error(`Runtime directory has unsafe permissions: ${directory}`);
  }
  if (await realpath(directory) !== directory) {
    throw new Error(`Runtime directory must be canonical: ${directory}`);
  }
}

async function readPrivateFile(filePath: string, label: string): Promise<string> {
  const metadata = await lstat(filePath);
  assertPrivateFileMetadata(metadata, label);
  if (metadata.size > MAX_METADATA_BYTES) throw new Error(`${label} is too large`);
  const descriptor = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await descriptor.stat();
    assertPrivateFileMetadata(opened, label);
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error(`${label} changed during inspection`);
    }
    return await descriptor.readFile("utf8");
  } finally {
    await descriptor.close();
  }
}

async function assertPrivateFileIfPresent(filePath: string, label: string): Promise<void> {
  try {
    assertPrivateFileMetadata(await lstat(filePath), label);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function assertPrivateFileMetadata(
  metadata: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  if (metadata.nlink !== 1) throw new Error(`${label} must not be a hard link`);
  if ((Number(metadata.mode) & 0o777) !== FILE_MODE) {
    throw new Error(`${label} has unsafe permissions`);
  }
}

async function directoryIdentity(directory: string): Promise<RuntimeDirectoryIdentity> {
  const metadata = await lstat(directory);
  return { device: metadata.dev, inode: metadata.ino };
}

async function assertDirectoryIdentity(
  directory: string,
  expected: RuntimeDirectoryIdentity,
  label = "Runtime directory",
): Promise<void> {
  let actual: RuntimeDirectoryIdentity;
  try {
    actual = await directoryIdentity(directory);
  } catch {
    throw new Error(`${label} changed during operation`);
  }
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error(`${label} changed during operation`);
  }
}

async function canonicalDirectory(candidate: string, label: string): Promise<string> {
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be absolute`);
  const canonical = await realpath(candidate);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}

async function runBootstrapWorker(
  stateRoot: string,
  identity: RuntimeDirectoryIdentity,
): Promise<void> {
  const workerPath = resolveRuntimeWorker("runtime-bootstrap-worker");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(NODE_EXECUTABLE, [workerPath, String(identity.device), String(identity.inode)], {
      cwd: stateRoot,
      shell: false,
      env: minimalRuntimeEnvironment(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_METADATA_BYTES) stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (stderrBytes > MAX_METADATA_BYTES) {
        reject(new Error("Runtime bootstrap worker output exceeded its limit"));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Runtime bootstrap failed: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolve();
    });
  });
  await assertDirectoryIdentity(stateRoot, identity, "Runtime state directory");
}

async function runStoreWorker(
  layout: ProjectRuntimeLayout,
  identity: RuntimeDirectoryIdentity,
  request: unknown,
): Promise<z.infer<typeof StoreResultSchema>> {
  const workerPath = resolveRuntimeWorker("runtime-store-worker");
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_EXECUTABLE, [workerPath, String(identity.device), String(identity.inode)], {
      cwd: layout.runtimeDirectory,
      shell: false,
      env: minimalRuntimeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_METADATA_BYTES) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_METADATA_BYTES) stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (stdoutBytes > MAX_METADATA_BYTES || stderrBytes > MAX_METADATA_BYTES) {
        reject(new Error("Runtime state worker output exceeded its limit"));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Runtime state worker failed: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      try {
        resolve(StoreResultSchema.parse(JSON.parse(Buffer.concat(stdout).toString("utf8"))));
      } catch {
        reject(new Error("Runtime state worker returned malformed output"));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function resolveRuntimeWorker(name: "runtime-bootstrap-worker" | "runtime-store-worker"): string {
  const workerJavaScript = fileURLToPath(new URL(`./${name}.js`, import.meta.url));
  return existsSync(workerJavaScript)
    ? workerJavaScript
    : fileURLToPath(new URL(`./${name}.ts`, import.meta.url));
}

function runGitDiscovery(cwd: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(GIT_EXECUTABLE, [
      "rev-parse", "--show-toplevel", "--git-dir", "--is-inside-work-tree",
    ], {
      cwd,
      shell: false,
      env: minimalGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_METADATA_BYTES) stdout.push(chunk);
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => {
      if (stdoutBytes > MAX_METADATA_BYTES) {
        reject(new Error("Git worktree discovery output exceeded its limit"));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), exitCode: code ?? -1 });
    });
  });
}

function minimalGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function minimalRuntimeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C" };
  for (const key of ["HOME", "TMPDIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
