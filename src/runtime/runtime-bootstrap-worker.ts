import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
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

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const VERSION = "1\n";
const LAYOUT = `${JSON.stringify({
  schemaVersion: 1,
  database: "events.sqlite",
  traces: "traces",
  runtime: "runtime",
})}\n`;
const TEMP_RESIDUE = /^\.(?:VERSION|layout\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const LOCK_FILE = ".bootstrap.lock";
const LOCKF_EXECUTABLE = "/usr/bin/lockf";
const NODE_EXECUTABLE = realpathSync.native(process.execPath);
const OPERATION_PACKET = /^\.bootstrap-operation\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.packet$/;
const TEST_READY = ".bootstrap-test-ready";
const TEST_CONTINUE = ".bootstrap-test-continue";

process.umask(0o077);

if (process.argv[2] === "--operate") operate();
else launchLockedBootstrap();

function launchLockedBootstrap(): void {
  try {
    verifyWorkingDirectory(2);
    verifyCanonicalExecutable(LOCKF_EXECUTABLE, "Bootstrap lock executable");
    verifyCanonicalExecutable(NODE_EXECUTABLE, "Bootstrap worker executable");
    ensureLockFile();
    const lockDescriptor = openSync(LOCK_FILE, constants.O_RDWR | constants.O_NOFOLLOW);
    const packetName = `.bootstrap-operation.${randomUUID()}.packet`;
    const packetSecret = randomUUID();
    try {
      publishOperationPacket(packetName, packetSecret);
      verifyDescriptorMatchesPath(lockDescriptor, LOCK_FILE, "bootstrap lock");
      const result = spawnSync(
        LOCKF_EXECUTABLE,
        [
          "-s",
          "-t",
          "5",
          "-k",
          "/dev/fd/3",
          NODE_EXECUTABLE,
          fileURLToPath(import.meta.url),
          "--operate",
          process.argv[2]!,
          process.argv[3]!,
          packetName,
          packetSecret,
        ],
        {
          cwd: ".",
          shell: false,
          env: minimalEnvironment(),
          stdio: ["ignore", "ignore", 2, lockDescriptor],
        },
      );
      if (result.error !== undefined) throw result.error;
      if (result.status !== 0) throw new Error("Bootstrap lock could not be acquired");
      verifyDescriptorMatchesPath(lockDescriptor, LOCK_FILE, "bootstrap lock");
    } finally {
      closeSync(lockDescriptor);
      removeOperationPacketIfPresent(packetName);
    }
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : "Runtime bootstrap failed");
    process.exitCode = 1;
  }
}

function operate(): void {
  try {
    verifyWorkingDirectory(3);
    verifyPrivateFile(LOCK_FILE, "bootstrap lock");
    consumeOperationPacket(process.argv[5], process.argv[6]);
    reconcileMarkerResidues();
    ensurePrivateDirectory("traces");
    ensurePrivateDirectory("runtime");
    ensureMarker("VERSION", VERSION);
    ensureMarker("layout.json", LAYOUT);
    syncDirectory();
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : "Runtime bootstrap failed");
    process.exitCode = 1;
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
    (actual.mode & 0o777) !== DIRECTORY_MODE
  ) {
    throw new Error("Runtime state directory changed before bootstrap");
  }
}

function reconcileMarkerResidues(): void {
  const entries = readdirSync(".");
  for (const entry of entries) {
    const markerTempCandidate =
      (entry.startsWith(".VERSION.") || entry.startsWith(".layout.json.")) &&
      entry.endsWith(".tmp");
    if (!markerTempCandidate) continue;
    if (!TEMP_RESIDUE.test(entry)) {
      throw new Error(`Unknown marker temp residue must be inspected manually: ${entry}`);
    }
  }
  // UUID-shaped unpublished residues are preserved for explicit reconciliation.
  // Their unique names do not conflict with idempotent marker publication.
}

function ensurePrivateDirectory(directory: "traces" | "runtime"): void {
  try {
    verifyWorkingDirectory(3);
    mkdirSync(directory, { mode: DIRECTORY_MODE });
    verifyWorkingDirectory(3);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Runtime bootstrap path must be a real directory: ${directory}`);
  }
  if ((metadata.mode & 0o777) !== DIRECTORY_MODE) {
    throw new Error(`Runtime bootstrap directory has unsafe permissions: ${directory}`);
  }
}

function ensureMarker(fileName: "VERSION" | "layout.json", expected: string): void {
  if (entryExists(fileName)) {
    verifyPrivateFile(fileName, `${fileName} marker`);
    if (readFileSync(fileName, "utf8") !== expected) {
      throw new Error(`${fileName} marker is malformed or unsupported`);
    }
    return;
  }

  const temporary = `.${fileName}.${randomUUID()}.tmp`;
  verifyWorkingDirectory(3);
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    writeFileSync(descriptor, expected, "utf8");
    fsyncSync(descriptor);
    if (fstatSync(descriptor).nlink !== 1) throw new Error("Marker temp file was hard linked");
    if (fileName === "VERSION") pauseAfterMarkerTempForTest();
  } finally {
    closeSync(descriptor);
  }
  verifyWorkingDirectory(3);
  renameSync(temporary, fileName);
  verifyWorkingDirectory(3);
  verifyPrivateFile(fileName, `${fileName} marker`);
  syncDirectory();
}

function pauseAfterMarkerTempForTest(): void {
  if (process.env["ZENTRA_RUNTIME_TEST_BOOTSTRAP_PAUSE"] !== "1") return;
  verifyWorkingDirectory(3);
  const readyDescriptor = openSync(
    TEST_READY,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    writeFileSync(readyDescriptor, "ready", "utf8");
    fsyncSync(readyDescriptor);
  } finally {
    closeSync(readyDescriptor);
  }
  verifyWorkingDirectory(3);
  syncDirectory();
  const deadline = Date.now() + 10_000;
  while (!entryExists(TEST_CONTINUE)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting to resume bootstrap test");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  verifyWorkingDirectory(3);
  unlinkSync(TEST_READY);
  unlinkSync(TEST_CONTINUE);
  verifyWorkingDirectory(3);
  syncDirectory();
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
        if (fstatSync(descriptor).nlink !== 1) throw new Error("Bootstrap lock was hard linked");
      } finally {
        closeSync(descriptor);
      }
      verifyWorkingDirectory(2);
      syncDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  verifyPrivateFile(LOCK_FILE, "bootstrap lock");
}

function publishOperationPacket(packetName: string, packetSecret: string): void {
  verifyWorkingDirectory(2);
  const descriptor = openSync(
    packetName,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    writeFileSync(descriptor, `${digest(packetSecret)}\n`, "utf8");
    fsyncSync(descriptor);
    if (fstatSync(descriptor).nlink !== 1) throw new Error("Bootstrap operation packet was hard linked");
  } finally {
    closeSync(descriptor);
  }
  verifyWorkingDirectory(2);
  syncDirectory();
}

function consumeOperationPacket(packetName: string | undefined, packetSecret: string | undefined): void {
  if (
    packetName === undefined ||
    packetSecret === undefined ||
    !OPERATION_PACKET.test(packetName) ||
    !/^[0-9a-f-]{36}$/.test(packetSecret)
  ) {
    throw new Error("Internal bootstrap operation packet is missing or malformed");
  }
  verifyPrivateFile(packetName, "internal bootstrap operation packet");
  const expected = readFileSync(packetName, "utf8").trim();
  const actual = digest(packetSecret);
  if (!/^[a-f0-9]{64}$/.test(expected) || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))) {
    throw new Error("Internal bootstrap operation packet does not match");
  }
  verifyWorkingDirectory(3);
  unlinkSync(packetName);
  verifyWorkingDirectory(3);
  syncDirectory();
}

function removeOperationPacketIfPresent(packetName: string): void {
  if (!entryExists(packetName)) return;
  verifyPrivateFile(packetName, "internal bootstrap operation packet");
  verifyWorkingDirectory(2);
  unlinkSync(packetName);
  verifyWorkingDirectory(2);
  syncDirectory();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
  const current = lstatSync(filePath);
  if (opened.dev !== current.dev || opened.ino !== current.ino || opened.nlink !== 1) {
    throw new Error(`${label} changed during operation`);
  }
}

function verifyCanonicalExecutable(executable: string, label: string): void {
  if (realpathSync.native(executable) !== executable) throw new Error(`${label} must be canonical`);
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C" };
  for (const key of ["HOME", "TMPDIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (process.env["ZENTRA_RUNTIME_TEST_BOOTSTRAP_PAUSE"] === "1") {
    environment["ZENTRA_RUNTIME_TEST_BOOTSTRAP_PAUSE"] = "1";
  }
  return environment;
}

function syncDirectory(): void {
  const descriptor = openSync(".", constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
