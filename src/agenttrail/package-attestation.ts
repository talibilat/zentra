import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const IMPORTED_SOURCE_TREE_SHA256 = "5008e9046d5767fe9e1017d81fdf3da8c4dbfc86e68ce3778fec338efb580c49";
const REVIEWED_MANIFEST_SHA256 = "c2c1e2aded2399cf9bde5808824b930bd437857be561eab8c2c917d651b4a74d";
const REVIEWED_EXECUTABLE_SHA256 = "c1469d5feb7d6a6a4e79db6d1446014205255ea88dcdcb5fb59d40ca4f773e49";
const REVIEWED_BUILD_INPUTS_SHA256 = "04248f5801b8b18b7533be6ae186e7d2a00d29302b01d211599a92fce7e68fb9";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MACH_O_64_MAGIC = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;

const FileRecordSchema = z.strictObject({
  bytes: z.number().int().nonnegative(),
  mode: z.enum(["100644", "100755"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const ManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  product: z.literal("AgentTrail"),
  compatibilityExecutable: z.literal("agent-tail"),
  platform: z.literal("darwin"),
  architecture: z.literal("arm64"),
  source: z.strictObject({
    repository: z.literal("https://github.com/talibilat/agent-trail.git"),
    commit: z.literal("f7d3e20ac1c7a8be3b572161058480df10ab4ffb"),
    treeSha256: z.literal(IMPORTED_SOURCE_TREE_SHA256),
    license: z.literal("MIT"),
  }),
  build: z.strictObject({
    sourceDateEpoch: z.literal(1767225600),
    python: z.strictObject({
      implementation: z.literal("CPython"),
      version: z.literal("3.12.0"),
      platform: z.literal("darwin-arm64"),
      executableSha256: z.literal("f4cd716d4b54f205398bec6932cc59361b087494ca2ddb157a5e8631d4d6f863"),
    }),
    packages: z.strictObject({
      altgraph: z.literal("0.17.4"),
      macholib: z.literal("1.16.3"),
      packaging: z.literal("25.0"),
      pyinstaller: z.literal("6.14.2"),
      "pyinstaller-hooks-contrib": z.literal("2025.5"),
      setuptools: z.literal("80.9.0"),
    }),
    inputsSha256: z.literal(REVIEWED_BUILD_INPUTS_SHA256),
  }),
  files: z.strictObject({
    agenttrail: FileRecordSchema.extend({ mode: z.literal("100755") }),
    "web/index.html": FileRecordSchema.extend({ mode: z.literal("100644") }),
  }),
});

const AttestationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  statementType: z.literal("zentra.agenttrail.package.v1"),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceTreeSha256: z.literal(IMPORTED_SOURCE_TREE_SHA256),
});

export interface PackagedAgentTrail {
  readonly packageRoot: string;
  readonly executablePath: string;
  readonly executableBytes: Buffer;
  readonly webAssetPath: string;
  readonly executableSha256: string;
  readonly manifestSha256: string;
  readonly architecture: "arm64";
}

export async function packagedAgentTrailRoot(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL("../../agenttrail/package/darwin-arm64", import.meta.url)),
    fileURLToPath(new URL("../../../agenttrail/package/darwin-arm64", import.meta.url)),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return await canonicalDirectory(candidate, "AgentTrail package root");
    } catch {
      // Source and production builds place this module at different depths.
    }
  }
  throw new Error("Canonical packaged AgentTrail root is missing");
}

export async function resolvePackagedAgentTrail(): Promise<PackagedAgentTrail> {
  return verifyAgentTrailPackageRoot(await packagedAgentTrailRoot());
}

// Package verification tests may inspect a copied package, but production supervision never calls
// this helper and therefore cannot launch an alternate package identity.
export async function verifyAgentTrailPackageRoot(
  candidateRoot: string,
  candidateExecutablePath?: string,
): Promise<PackagedAgentTrail> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Packaged AgentTrail supports Darwin arm64 only");
  }
  if (!path.isAbsolute(candidateRoot)) {
    throw new Error("AgentTrail package root must be absolute");
  }
  const packageRoot = await canonicalDirectory(candidateRoot, "AgentTrail package root");
  const executablePath = path.join(packageRoot, "agenttrail");
  if (candidateExecutablePath !== undefined && candidateExecutablePath !== executablePath) {
    throw new Error("AgentTrail alternate executable identity is forbidden");
  }
  const webAssetPath = path.join(packageRoot, "web", "index.html");
  const manifestPath = path.join(packageRoot, "manifest.json");
  const attestationPath = path.join(packageRoot, "attestation.json");
  const [manifestBytes, attestationBytes] = await Promise.all([
    readBoundedRegularFile(manifestPath, "AgentTrail manifest", 0o644),
    readBoundedRegularFile(attestationPath, "AgentTrail package attestation", 0o644),
  ]);
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== REVIEWED_MANIFEST_SHA256) {
    throw new Error("AgentTrail package identity does not match the reviewed manifest");
  }
  let manifest: z.infer<typeof ManifestSchema>;
  let attestation: z.infer<typeof AttestationSchema>;
  try {
    manifest = ManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    attestation = AttestationSchema.parse(JSON.parse(attestationBytes.toString("utf8")));
  } catch {
    throw new Error("AgentTrail manifest or package attestation is unsigned or malformed");
  }
  if (attestation.manifestSha256 !== manifestSha256) {
    throw new Error("AgentTrail package attestation does not sign the current manifest");
  }

  const [executableBytes, webAssetBytes] = await Promise.all([
    readAttestedFile(executablePath, "AgentTrail executable", manifest.files.agenttrail, 0o755),
    readAttestedFile(webAssetPath, "AgentTrail web asset", manifest.files["web/index.html"], 0o644),
  ]);
  assertArm64MachO(executableBytes);
  if (sha256(executableBytes) !== REVIEWED_EXECUTABLE_SHA256) {
    throw new Error("AgentTrail executable identity does not match the reviewed package");
  }
  return {
    packageRoot,
    executablePath,
    executableBytes: Buffer.from(executableBytes),
    webAssetPath,
    executableSha256: sha256(executableBytes),
    manifestSha256,
    architecture: "arm64",
  };
}

async function canonicalDirectory(candidate: string, label: string): Promise<string> {
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be absolute`);
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`);
  const canonical = await realpath(candidate);
  if (canonical !== candidate) throw new Error(`${label} must be canonical and contain no symlink components`);
  return canonical;
}

async function readAttestedFile(
  filePath: string,
  label: string,
  record: z.infer<typeof FileRecordSchema>,
  mode: number,
): Promise<Buffer> {
  const bytes = await readBoundedRegularFile(filePath, label, mode, record.bytes);
  if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) {
    throw new Error(`${label} does not match its attested digest`);
  }
  return bytes;
}

async function readBoundedRegularFile(
  filePath: string,
  label: string,
  mode: number,
  expectedBytes = MAX_MANIFEST_BYTES,
): Promise<Buffer> {
  const pathMetadata = await lstat(filePath);
  if (pathMetadata.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  let descriptor: FileHandle;
  try {
    descriptor = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`${label} must not be a symlink`);
    throw error;
  }
  try {
    const before = await descriptor.stat();
    assertSafeFileMetadata(before, label, mode, expectedBytes);
    const canonical = await realpath(filePath);
    if (canonical !== filePath) throw new Error(`${label} must have a canonical identity`);
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat();
    assertSafeFileMetadata(after, label, mode, expectedBytes);
    if (!sameFileIdentity(before, after) || bytes.byteLength !== after.size) {
      throw new Error(`${label} changed during attestation`);
    }
    return bytes;
  } finally {
    await descriptor.close();
  }
}

function assertSafeFileMetadata(
  metadata: Stats,
  label: string,
  mode: number,
  expectedBytes: number,
): void {
  if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`${label} must be a regular single-link file`);
  if ((metadata.mode & 0o777) !== mode) throw new Error(`${label} has unsafe or unexpected mode`);
  if (metadata.size > expectedBytes) throw new Error(`${label} exceeds its attested size bound`);
}

function sameFileIdentity(
  before: Stats,
  after: Stats,
): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mode === after.mode && before.nlink === after.nlink &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function assertArm64MachO(bytes: Buffer): void {
  if (
    bytes.byteLength < 32 ||
    bytes.readUInt32LE(0) !== MACH_O_64_MAGIC ||
    bytes.readUInt32LE(4) !== CPU_TYPE_ARM64
  ) {
    throw new Error("AgentTrail executable must be a native arm64 Mach-O executable, not a wrapper");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
