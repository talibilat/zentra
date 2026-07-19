import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const MAX_STATE_BYTES = 64 * 1024;
const STATE_FILE = "state.json";
const LOCK_FILE = "lifecycle.lock";
const LEGACY_OWNER = "owner.json";
const SQLITE_RESIDUES = ["state.sqlite", "state.sqlite-journal", "state.sqlite-wal", "state.sqlite-shm"] as const;
const PS_EXECUTABLE = "/bin/ps";
const LOCKF_EXECUTABLE = "/usr/bin/lockf";
const NODE_EXECUTABLE = realpathSync.native(process.execPath);
const OPERATION_PACKET = /^\.operation\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.packet$/;

const PublicStateSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  pid: z.number().int().positive(),
  processIncarnation: z.string().regex(/^process-v2:[a-f0-9]{64}$/),
  address: z.strictObject({
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1).max(65_535),
  }),
  tokenExpiresAt: z.iso.datetime({ offset: true }),
  startupStatus: z.enum(["starting", "ready", "stopping", "failed"]),
});

const StaleDecisionSchema = z.strictObject({
  pid: z.number().int().positive(),
  processIncarnation: z.string().regex(/^process-v2:[a-f0-9]{64}$/),
  reason: z.enum(["process_not_running", "process_incarnation_changed"]),
  detectedAt: z.iso.datetime({ offset: true }),
});

const DurableStateSchema = PublicStateSchema.extend({
  acquisitionId: z.uuid(),
  acquiredAt: z.iso.datetime({ offset: true }),
  publishedAt: z.iso.datetime({ offset: true }),
  processEvidence: z.string().regex(/^darwin-ps-v1:[a-f0-9]{64}$/),
  capabilityDigest: z.string().regex(/^[a-f0-9]{64}$/),
  staleDecision: StaleDecisionSchema.nullable(),
}).strict();

type PublicState = z.infer<typeof PublicStateSchema>;
type DurableState = z.infer<typeof DurableStateSchema>;
type RuntimeClaim = Pick<DurableState, "pid" | "processIncarnation">;

interface Request {
  readonly operation: "start" | "publish" | "read" | "ownership" | "remove";
  readonly payload: Record<string, unknown>;
}

interface ProcessRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly executableName: string;
}

process.umask(0o077);

if (process.argv[2] === "--operate") operate();
else launchLockedOperation();

function launchLockedOperation(): void {
  try {
    verifyWorkingDirectory(2);
    verifyCanonicalExecutable(LOCKF_EXECUTABLE, "Lifecycle lock executable");
    verifyCanonicalExecutable(NODE_EXECUTABLE, "Runtime worker executable");
    ensureLockFile();
    const requestText = readFileSync(0, "utf8");
    if (Buffer.byteLength(requestText) > MAX_STATE_BYTES) {
      throw new Error("Runtime operation request is too large");
    }
    const lockDescriptor = openSync(LOCK_FILE, constants.O_RDWR | constants.O_NOFOLLOW);
    const packetName = `.operation.${randomUUID()}.packet`;
    try {
      publishOperationPacket(packetName, requestText);
      verifyDescriptorMatchesPath(lockDescriptor, LOCK_FILE, "launcher runtime lifecycle lock");
      const workerPath = fileURLToPath(import.meta.url);
      const result = spawnSync(
        LOCKF_EXECUTABLE,
        [
          "-s",
          "-t",
          "5",
          "-k",
          "/dev/fd/3",
          NODE_EXECUTABLE,
          workerPath,
          "--operate",
          process.argv[2]!,
          process.argv[3]!,
          packetName,
        ],
        {
          cwd: ".",
          shell: false,
          env: minimalEnvironment(),
          stdio: ["pipe", 1, 2, lockDescriptor],
          input: requestText,
        },
      );
      if (result.error !== undefined) throw result.error;
      if (result.status !== 0) throw new Error("Runtime lifecycle lock could not be acquired");
      verifyDescriptorMatchesPath(lockDescriptor, LOCK_FILE, "runtime lifecycle lock");
    } finally {
      closeSync(lockDescriptor);
      removeOperationPacketIfPresent(packetName);
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "Runtime state operation failed",
    }));
  }
}

function operate(): void {
  try {
    verifyWorkingDirectory(3);
    verifyPrivateFile(LOCK_FILE, "runtime lifecycle lock");
    const requestText = readFileSync(0, "utf8");
    consumeOperationPacket(process.argv[5], requestText);
    rejectSqliteResidues();
    cleanInterruptedLegacyOwner();
    reconcileStateTempResidues();
    const request = JSON.parse(requestText) as Request;
    if (request.operation !== "read" && request.operation !== "ownership") {
      verifyMutationCaller(request);
    }
    const value = execute(request);
    verifyPrivateFileIfPresent(STATE_FILE, "runtime state");
    verifyPrivateFile(LOCK_FILE, "runtime lifecycle lock");
    if (
      request.operation === "start" &&
      request.payload["suppressResponse"] === true &&
      typeof value === "object" &&
      value !== null &&
      (value as { kind?: string; recovered?: boolean }).kind === "accepted" &&
      (value as { recovered?: boolean }).recovered === false
    ) return;
    process.stdout.write(JSON.stringify({ ok: true, value }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "Runtime state operation failed",
    }));
  }
}

function execute(request: Request): unknown {
  if (request.operation === "read") return publicState(readDurableState());
  if (request.operation === "ownership") {
    const state = readDurableState();
    return state === null ? null : {
      acquisitionId: state.acquisitionId,
      pid: state.pid,
      processIncarnation: state.processIncarnation,
    };
  }
  if (request.operation === "start") return start(request.payload);
  if (request.operation === "publish") return publish(request.payload);
  if (request.operation === "remove") {
    remove(request.payload);
    return null;
  }
  throw new Error("Runtime state operation is unsupported");
}

function start(payload: Record<string, unknown>): unknown {
  const input = payload["input"] as Omit<PublicState, "schemaVersion" | "processIncarnation">;
  const acquiredAt = requiredString(payload["occurredAt"], "acquisition time");
  const acquisitionId = requiredAcquisitionId(payload["acquisitionId"]);
  const processIncarnation = requiredString(payload["processIncarnation"], "process incarnation");
  const capability = requiredCapability(payload["capability"]);
  const capabilityDigest = digestCapability(capability);
  const callerPid = requiredPid(payload["callerPid"], "caller PID");
  if (input.pid !== callerPid) throw new Error("Start PID does not match the actual caller process");
  const startingEvidence = inspectProcessEvidence(input.pid);
  if (startingEvidence === null) throw new Error("Starting runtime process is not running");

  const existing = readDurableState();
  let stale: z.infer<typeof StaleDecisionSchema> | null = null;
  if (existing !== null) {
    if (existing.pid === input.pid && existing.processIncarnation === processIncarnation) {
      if (existing.acquisitionId !== acquisitionId) {
        return { kind: "reconcile_acquisition", acquisitionId: existing.acquisitionId };
      }
      if (!sameDigest(existing.capabilityDigest, capabilityDigest)) {
        throw new Error("Existing runtime owner requires an explicit capability handoff");
      }
      if (existing.processEvidence !== startingEvidence) {
        throw new Error("Existing runtime ownership assumptions changed");
      }
      return {
        kind: "accepted",
        claim: claimFromState(existing),
        state: publicState(existing),
        stale: existing.staleDecision,
        recovered: true,
        acquiredAt: existing.acquiredAt,
        publishedAt: existing.publishedAt,
      };
    }
    if (existing.pid !== input.pid) {
      const currentEvidence = inspectProcessEvidence(existing.pid);
      if (currentEvidence === existing.processEvidence) {
        throw new Error(`Runtime is already owned by live process ${existing.pid}`);
      }
      stale = {
        pid: existing.pid,
        processIncarnation: existing.processIncarnation,
        reason: currentEvidence === null
          ? "process_not_running"
          : "process_incarnation_changed",
        detectedAt: acquiredAt,
      };
    } else {
      stale = {
        pid: existing.pid,
        processIncarnation: existing.processIncarnation,
        reason: "process_incarnation_changed",
        detectedAt: acquiredAt,
      };
    }
  }

  const state = DurableStateSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    acquisitionId,
    acquiredAt,
    publishedAt: acquiredAt,
    pid: input.pid,
    processIncarnation,
    processEvidence: startingEvidence,
    capabilityDigest,
    staleDecision: stale,
    address: input.address,
    tokenExpiresAt: input.tokenExpiresAt,
    startupStatus: input.startupStatus,
  });
  publishState(state);
  return {
    kind: "accepted",
    claim: claimFromState(state),
    state: publicState(state),
    stale,
    recovered: false,
    acquiredAt: state.acquiredAt,
    publishedAt: state.publishedAt,
  };
}

function publish(payload: Record<string, unknown>): { state: PublicState; publishedAt: string } {
  const claim = payload["claim"] as RuntimeClaim;
  const capability = requiredCapability(payload["capability"]);
  const acquisitionId = requiredAcquisitionId(payload["acquisitionId"]);
  const publishedAt = requiredString(payload["occurredAt"], "publication time");
  const callerPid = requiredPid(payload["callerPid"], "caller PID");
  if (claim.pid !== callerPid) throw new Error("Publish claim is not owned by the actual caller process");
  const input = payload["input"] as Omit<PublicState, "schemaVersion" | "processIncarnation">;
  const existing = requireClaim(readDurableState(), claim);
  requireCapability(existing, capability, acquisitionId);
  const state = DurableStateSchema.parse({
    ...existing,
    publishedAt,
    pid: input.pid,
    address: input.address,
    tokenExpiresAt: input.tokenExpiresAt,
    startupStatus: input.startupStatus,
  });
  publishState(state);
  return { state: publicState(state)!, publishedAt: state.publishedAt };
}

function remove(payload: Record<string, unknown>): void {
  const claim = payload["claim"] as RuntimeClaim;
  const capability = requiredCapability(payload["capability"]);
  const acquisitionId = requiredAcquisitionId(payload["acquisitionId"]);
  const callerPid = requiredPid(payload["callerPid"], "caller PID");
  if (claim.pid !== callerPid) throw new Error("Remove claim is not owned by the actual caller process");
  requireCapability(requireClaim(readDurableState(), claim), capability, acquisitionId);
  verifyWorkingDirectory(3);
  unlinkSync(STATE_FILE);
  verifyWorkingDirectory(3);
  syncDirectory();
}

function readDurableState(): DurableState | null {
  if (!entryExists(STATE_FILE)) return null;
  const descriptor = openSync(STATE_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    verifyDescriptorMatchesPath(descriptor, STATE_FILE, "runtime state");
    const metadata = fstatSync(descriptor);
    if (metadata.size > MAX_STATE_BYTES) throw new Error("Runtime state is too large");
    return DurableStateSchema.parse(JSON.parse(readFileSync(descriptor, "utf8")));
  } catch (error) {
    if (error instanceof Error && /hard link|symlink|permissions|regular/.test(error.message)) throw error;
    throw new Error("Runtime state is malformed or has an unsupported schema");
  } finally {
    closeSync(descriptor);
  }
}

function publishState(state: DurableState): void {
  const temporary = `.${STATE_FILE}.${randomUUID()}.tmp`;
  verifyWorkingDirectory(3);
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(state)}\n`, "utf8");
    fsyncSync(descriptor);
    if (fstatSync(descriptor).nlink !== 1) throw new Error("Runtime state temp file was hard linked");
  } finally {
    closeSync(descriptor);
  }
  verifyWorkingDirectory(3);
  renameSync(temporary, STATE_FILE);
  verifyWorkingDirectory(3);
  verifyPrivateFile(STATE_FILE, "runtime state");
  syncDirectory();
}

function publicState(state: DurableState | null): PublicState | null {
  if (state === null) return null;
  const {
    acquisitionId: _acquisitionId,
    acquiredAt: _acquiredAt,
    publishedAt: _publishedAt,
    processEvidence: _processEvidence,
    capabilityDigest: _capabilityDigest,
    staleDecision: _staleDecision,
    ...result
  } = state;
  return PublicStateSchema.parse(result);
}

function claimFromState(state: DurableState): RuntimeClaim {
  return {
    pid: state.pid,
    processIncarnation: state.processIncarnation,
  };
}

function requireClaim(state: DurableState | null, claim: RuntimeClaim): DurableState {
  if (
    state === null ||
    state.pid !== claim.pid ||
    state.processIncarnation !== claim.processIncarnation
  ) {
    throw new Error("Runtime ownership claim is stale");
  }
  return state;
}

function requireCapability(
  state: DurableState,
  capability: string,
  acquisitionId: string,
): void {
  if (
    state.acquisitionId !== acquisitionId ||
    !sameDigest(state.capabilityDigest, digestCapability(capability))
  ) {
    throw new Error("Runtime mutation capability does not match the durable owner");
  }
}

function digestCapability(capability: string): string {
  return createHash("sha256").update(capability).digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function inspectProcessEvidence(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Runtime PID is invalid");
  verifyCanonicalExecutable(PS_EXECUTABLE, "Process inspection executable");
  const result = spawnSync(
    PS_EXECUTABLE,
    ["-p", String(pid), "-o", "lstart=", "-o", "uid=", "-o", "ucomm="],
    {
      shell: false,
      env: { LANG: "C", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status === 1 && result.stdout.trim() === "") return null;
  if (result.status !== 0) throw new Error("Process incarnation inspection failed");
  const normalized = result.stdout.trim().replace(/\s+/g, " ");
  if (normalized === "") return null;
  const fields = normalized.split(" ");
  if (
    fields.length < 7 ||
    !/^\d{1,2}$/.test(fields[2] ?? "") ||
    !/^\d{2}:\d{2}:\d{2}$/.test(fields[3] ?? "") ||
    !/^\d{4}$/.test(fields[4] ?? "") ||
    !/^\d+$/.test(fields[5] ?? "")
  ) {
    throw new Error("Process incarnation evidence is malformed");
  }
  // One kernel process-table observation binds independent start-time, UID,
  // and executable-name evidence without reading arguments or environment.
  const evidence = JSON.stringify({
    startTime: fields.slice(0, 5).join(" "),
    uid: fields[5],
    executableName: fields.slice(6).join(" "),
  });
  return `darwin-ps-v1:${createHash("sha256").update(evidence).digest("hex")}`;
}

function verifyMutationCaller(request: Request): void {
  const claimedCaller = requiredPid(request.payload["callerPid"], "caller PID");
  const actualCaller = actualCallerPid();
  if (claimedCaller !== actualCaller) {
    throw new Error(`Mutation caller PID ${claimedCaller} does not match actual caller ${actualCaller}`);
  }
}

function actualCallerPid(): number {
  const parent = inspectProcessRecord(process.ppid);
  if (parent === null) throw new Error("Runtime helper parent process is unavailable");
  const nodeName = pathBaseName(NODE_EXECUTABLE);

  // lockf may exec the Node operation directly or remain as its parent.
  const launcher = parent.executableName === "lockf"
    ? inspectProcessRecord(parent.parentPid)
    : parent;
  if (launcher === null || launcher.executableName !== nodeName) {
    throw new Error("Runtime helper ancestry is not the fixed Node launcher");
  }
  return launcher.parentPid;
}

function inspectProcessRecord(pid: number): ProcessRecord | null {
  const result = spawnSync(
    PS_EXECUTABLE,
    ["-p", String(pid), "-o", "ppid=", "-o", "ucomm="],
    {
      shell: false,
      env: { LANG: "C", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status === 1 && result.stdout.trim() === "") return null;
  if (result.status !== 0) throw new Error("Runtime helper ancestry inspection failed");
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(result.stdout);
  if (match === null) throw new Error("Runtime helper ancestry evidence is malformed");
  return {
    pid,
    parentPid: Number(match[1]),
    executableName: match[2]!,
  };
}

function pathBaseName(filePath: string): string {
  const separator = filePath.lastIndexOf("/");
  return separator === -1 ? filePath : filePath.slice(separator + 1);
}

function ensureLockFile(): void {
  if (!entryExists(LOCK_FILE)) {
    try {
      verifyWorkingDirectory(2);
      const descriptor = openSync(
        LOCK_FILE,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        FILE_MODE,
      );
      try {
        fsyncSync(descriptor);
        if (fstatSync(descriptor).nlink !== 1) throw new Error("Lifecycle lock was hard linked");
      } finally {
        closeSync(descriptor);
      }
      verifyWorkingDirectory(2);
      syncDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  verifyPrivateFile(LOCK_FILE, "runtime lifecycle lock");
}

function rejectSqliteResidues(): void {
  for (const residue of SQLITE_RESIDUES) {
    if (entryExists(residue)) throw new Error(`Unsafe SQLite sidecar or residue exists: ${residue}`);
  }
}

function cleanInterruptedLegacyOwner(): void {
  if (!entryExists(LEGACY_OWNER)) return;
  verifyPrivateFile(LEGACY_OWNER, "runtime owner residue");
  verifyWorkingDirectory(3);
  unlinkSync(LEGACY_OWNER);
  verifyWorkingDirectory(3);
  syncDirectory();
}

function reconcileStateTempResidues(): void {
  // State temp files are UUID-named and unpublished. Unknown files are never removed.
  const matcher = /^\.state\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
  for (const entry of readdirSync(".")) {
    if (!matcher.test(entry)) continue;
    verifyPrivateFile(entry, "runtime state temp residue");
    verifyWorkingDirectory(3);
    unlinkSync(entry);
    verifyWorkingDirectory(3);
  }
}

function verifyWorkingDirectory(argumentOffset: number): void {
  const expectedDevice = Number(process.argv[argumentOffset]);
  const expectedInode = Number(process.argv[argumentOffset + 1]);
  const actual = statSync(".");
  if (
    !actual.isDirectory() ||
    actual.dev !== expectedDevice ||
    actual.ino !== expectedInode ||
    (actual.mode & 0o777) !== 0o700
  ) {
    throw new Error("Runtime directory changed before operation");
  }
}

function verifyPrivateFileIfPresent(filePath: string, label: string): void {
  if (entryExists(filePath)) verifyPrivateFile(filePath, label);
}

function entryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function verifyPrivateFile(filePath: string, label: string): void {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (metadata.nlink !== 1) throw new Error(`${label} must not be a hard link`);
  if ((metadata.mode & 0o777) !== FILE_MODE) throw new Error(`${label} has unsafe permissions`);
}

function verifyDescriptorMatchesPath(descriptor: number, filePath: string, label: string): void {
  const opened = fstatSync(descriptor);
  verifyPrivateFile(filePath, label);
  const pathMetadata = lstatSync(filePath);
  if (opened.dev !== pathMetadata.dev || opened.ino !== pathMetadata.ino || opened.nlink !== 1) {
    throw new Error(`${label} changed during operation`);
  }
}

function syncDirectory(): void {
  const descriptor = openSync(".", constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function verifyCanonicalExecutable(executable: string, label: string): void {
  if (realpathSync.native(executable) !== executable) throw new Error(`${label} must be canonical`);
}

function publishOperationPacket(packetName: string, requestText: string): void {
  verifyWorkingDirectory(2);
  const descriptor = openSync(
    packetName,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    writeFileSync(descriptor, `${digestRequest(requestText)}\n`, "utf8");
    fsyncSync(descriptor);
    if (fstatSync(descriptor).nlink !== 1) throw new Error("Operation packet was hard linked");
  } finally {
    closeSync(descriptor);
  }
  verifyWorkingDirectory(2);
  syncDirectory();
}

function consumeOperationPacket(packetName: string | undefined, requestText: string): void {
  if (packetName === undefined || !OPERATION_PACKET.test(packetName)) {
    throw new Error("Internal operation packet is missing or malformed");
  }
  verifyPrivateFile(packetName, "internal operation packet");
  const packetDigest = readFileSync(packetName, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(packetDigest) || !sameDigest(packetDigest, digestRequest(requestText))) {
    throw new Error("Internal operation packet does not match the request");
  }
  verifyWorkingDirectory(3);
  unlinkSync(packetName);
  verifyWorkingDirectory(3);
  syncDirectory();
}

function removeOperationPacketIfPresent(packetName: string): void {
  if (!entryExists(packetName)) return;
  verifyPrivateFile(packetName, "internal operation packet");
  verifyWorkingDirectory(2);
  unlinkSync(packetName);
  verifyWorkingDirectory(2);
  syncDirectory();
}

function digestRequest(requestText: string): string {
  return createHash("sha256").update(requestText).digest("hex");
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C" };
  for (const key of ["HOME", "TMPDIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${label} is invalid`);
  return value;
}

function requiredCapability(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("Runtime mutation capability is missing or malformed");
  }
  return value;
}

function requiredAcquisitionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new Error("Runtime acquisition ID is missing or malformed");
  }
  return value;
}

function requiredPid(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} is invalid`);
  return value as number;
}
