import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const packageRoot = path.join(root, "agenttrail", "package", "darwin-arm64");
const executable = path.join(packageRoot, "agenttrail");
const manifestPath = path.join(packageRoot, "manifest.json");
const attestationPath = path.join(packageRoot, "attestation.json");
const reviewedManifestSha256 = "c2c1e2aded2399cf9bde5808824b930bd437857be561eab8c2c917d651b4a74d";
const reviewedExecutableSha256 = "c1469d5feb7d6a6a4e79db6d1446014205255ea88dcdcb5fb59d40ca4f773e49";
const reviewedBuildInputsSha256 = "04248f5801b8b18b7533be6ae186e7d2a00d29302b01d211599a92fce7e68fb9";

try {
  canonicalDirectory(packageRoot);
  const manifestBytes = regularFile(manifestPath, 0o644);
  const attestationBytes = regularFile(attestationPath, 0o644);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const attestation = JSON.parse(attestationBytes.toString("utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.product !== "AgentTrail" ||
    manifest.platform !== "darwin" ||
    manifest.architecture !== "arm64" ||
    manifest.source?.treeSha256 !== "5008e9046d5767fe9e1017d81fdf3da8c4dbfc86e68ce3778fec338efb580c49" ||
    manifest.build?.inputsSha256 !== reviewedBuildInputsSha256 ||
    sha256(manifestBytes) !== reviewedManifestSha256
  ) throw new Error("manifest identity is malformed or unsupported");
  if (
    attestation.schemaVersion !== 1 ||
    attestation.statementType !== "zentra.agenttrail.package.v1" ||
    attestation.manifestSha256 !== sha256(manifestBytes) ||
    attestation.sourceTreeSha256 !== manifest.source.treeSha256
  ) throw new Error("manifest is unsigned or has stale attestation");
  for (const [relative, expectedMode] of [["agenttrail", 0o755], ["web/index.html", 0o644]]) {
    const expected = manifest.files?.[relative];
    const bytes = regularFile(path.join(packageRoot, relative), expectedMode);
    if (expected?.bytes !== bytes.byteLength || expected?.sha256 !== sha256(bytes)) {
      throw new Error(`${relative} does not match its manifest digest`);
    }
  }
  const executableBytes = readFileSync(executable);
  if (executableBytes.readUInt32LE(0) !== 0xfeedfacf || executableBytes.readUInt32LE(4) !== 0x0100000c) {
    throw new Error("executable is not an arm64 Mach-O file");
  }
  if (sha256(executableBytes) !== reviewedExecutableSha256) {
    throw new Error("executable does not match the reviewed package identity");
  }
  await smoke();
  console.log(`Verified AgentTrail ${manifest.files.agenttrail.sha256} with no Python on PATH.`);
} catch (error) {
  console.error(`AgentTrail package verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function canonicalDirectory(directory) {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(directory) !== directory) {
    throw new Error(`package directory is not canonical: ${directory}`);
  }
}

function regularFile(file, mode) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== mode) {
    throw new Error(`unsafe packaged file identity: ${file}`);
  }
  if (realpathSync(file) !== file) throw new Error(`packaged file is not canonical: ${file}`);
  return readFileSync(file);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function smoke() {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--help"], {
      cwd: packageRoot,
      shell: false,
      env: { PATH: "/usr/bin:/bin", HOME: packageRoot, TMPDIR: "/tmp", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Python-free smoke test timed out"));
    }, 60_000);
    const capture = (chunk) => {
      bytes += chunk.byteLength;
      if (bytes <= 1024 * 1024) output.push(chunk);
      else child.kill("SIGKILL");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(output).toString("utf8");
      if (code !== 0 || !text.includes("agent-tail")) reject(new Error("Python-free executable smoke test failed"));
      else resolve();
    });
  });
}
