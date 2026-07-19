import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCommand } from "./run-command.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(root, "agenttrail", "upstream");
const packageRoot = path.join(root, "agenttrail", "package", "darwin-arm64");
const lock = JSON.parse(readFileSync(path.join(root, "agenttrail", "build-lock.json"), "utf8"));
const importManifest = JSON.parse(readFileSync(path.join(root, "agenttrail", "import-manifest.json"), "utf8"));
const python = canonicalExecutable(
  process.env.AGENTTRAIL_BUILD_PYTHON ?? "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12",
  "build Python",
);
const temporaryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-agenttrail-build-")));

try {
  verifyBuildInputs();
  const probe = JSON.parse(runCommand(python, ["-c", [
    "import json, platform, sys",
    "print(json.dumps({'implementation': platform.python_implementation(), 'version': platform.python_version(), 'machine': platform.machine()}))",
  ].join("; ")], {
    cwd: root,
    environment: buildEnvironment(),
    timeoutMs: 10_000,
    maxBuffer: 64 * 1024,
  }).stdout);
  if (
    probe.implementation !== lock.python.implementation ||
    probe.version !== lock.python.version ||
    probe.machine !== "arm64" ||
    sha256(readFileSync(python)) !== lock.python.executableSha256
  ) {
    throw new Error(`build Python does not match pinned ${lock.python.implementation} ${lock.python.version} darwin-arm64`);
  }

  const environment = buildEnvironment();
  const virtualEnvironment = path.join(temporaryRoot, "venv");
  runCommand(python, ["-m", "venv", virtualEnvironment], {
    cwd: root,
    environment,
    timeoutMs: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const isolatedPython = path.join(virtualEnvironment, "bin", "python3");
  runCommand(isolatedPython, [
    "-m", "pip", "install", "--disable-pip-version-check", "--no-deps",
    "--only-binary=:all:", "--require-hashes",
    "--requirement", path.join(root, "agenttrail", "build-requirements.txt"),
  ], {
    cwd: root,
    environment,
    timeoutMs: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  rmSync(packageRoot, { recursive: true, force: true });
  mkdirSync(path.join(packageRoot, "web"), { recursive: true });
  const workPath = path.join(temporaryRoot, "work");
  const specPath = path.join(temporaryRoot, "spec");
  runCommand(isolatedPython, [
    "-m", "PyInstaller",
    "--clean",
    "--noconfirm",
    "--onefile",
    "--name", "agenttrail",
    "--paths", path.join(sourceRoot, "src"),
    "--add-data", `${path.join(sourceRoot, "src", "agent_tail", "web", "index.html")}:agent_tail/web`,
    "--distpath", packageRoot,
    "--workpath", workPath,
    "--specpath", specPath,
    path.join(root, "agenttrail", "entrypoint.py"),
  ], {
    cwd: root,
    environment,
    timeoutMs: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const webSource = path.join(sourceRoot, "src", "agent_tail", "web", "index.html");
  const webDestination = path.join(packageRoot, "web", "index.html");
  copyFileSync(webSource, webDestination);
  chmodSync(path.join(packageRoot, "agenttrail"), 0o755);
  chmodSync(webDestination, 0o644);
  const manifest = {
    schemaVersion: 1,
    product: "AgentTrail",
    compatibilityExecutable: "agent-tail",
    platform: "darwin",
    architecture: "arm64",
    source: {
      repository: importManifest.source.repository,
      commit: importManifest.source.commit,
      treeSha256: importManifest.treeSha256,
      license: importManifest.license.spdx,
    },
    build: {
      sourceDateEpoch: lock.sourceDateEpoch,
      python: lock.python,
      packages: lock.packages,
      inputsSha256: digestInputs(),
    },
    files: Object.fromEntries(["agenttrail", "web/index.html"].map((relative) => {
      const bytes = readFileSync(path.join(packageRoot, relative));
      return [relative, {
        bytes: bytes.byteLength,
        mode: relative === "agenttrail" ? "100755" : "100644",
        sha256: sha256(bytes),
      }];
    })),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(packageRoot, "manifest.json"), manifestBytes, { mode: 0o644 });
  const attestation = {
    schemaVersion: 1,
    statementType: "zentra.agenttrail.package.v1",
    manifestSha256: sha256(manifestBytes),
    sourceTreeSha256: importManifest.treeSha256,
  };
  writeFileSync(path.join(packageRoot, "attestation.json"), `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o644 });
  console.log(`Built AgentTrail ${manifest.files.agenttrail.sha256} for darwin-arm64.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function buildEnvironment() {
  return {
    HOME: temporaryRoot,
    TMPDIR: temporaryRoot,
    LANG: "C",
    LC_ALL: "C",
    PYTHONHASHSEED: "0",
    SOURCE_DATE_EPOCH: String(lock.sourceDateEpoch),
  };
}

function digestInputs() {
  const relativeFiles = [
    "agenttrail/build-lock.json",
    "agenttrail/build-requirements.txt",
    "agenttrail/entrypoint.py",
    "agenttrail/import-manifest.json",
    ...Object.keys(importManifest.files).map((file) => `agenttrail/upstream/${file}`),
  ].sort();
  const hash = createHash("sha256");
  for (const relative of relativeFiles) {
    const bytes = readFileSync(path.join(root, relative));
    hash.update(`${relative}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function verifyBuildInputs() {
  const reviewed = [
    ["agenttrail/import-manifest.json", lock.inputs.importManifestSha256],
    ["agenttrail/build-requirements.txt", lock.inputs.buildRequirementsSha256],
    ["agenttrail/entrypoint.py", lock.inputs.entrypointSha256],
  ];
  for (const [relative, expected] of reviewed) {
    if (sha256(readFileSync(path.join(root, relative))) !== expected) {
      throw new Error(`reviewed AgentTrail build input changed: ${relative}`);
    }
  }

  const actualFiles = walkRegularFiles(sourceRoot);
  const expectedFiles = Object.keys(importManifest.files).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("imported AgentTrail source file set does not match its manifest");
  }
  const tree = createHash("sha256");
  for (const relative of expectedFiles) {
    const absolute = path.join(sourceRoot, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || realpathSync(absolute) !== absolute) {
      throw new Error(`unsafe imported AgentTrail source identity: ${relative}`);
    }
    const bytes = readFileSync(absolute);
    const record = importManifest.files[relative];
    const mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
    const digest = sha256(bytes);
    if (record.mode !== mode || record.bytes !== bytes.byteLength || record.sha256 !== digest) {
      throw new Error(`imported AgentTrail source does not match its manifest: ${relative}`);
    }
    tree.update(`${mode} ${digest} ${bytes.byteLength} ${relative}\n`);
  }
  if (tree.digest("hex") !== importManifest.treeSha256) {
    throw new Error("imported AgentTrail source tree digest does not match its manifest");
  }

  const requirements = readFileSync(path.join(root, "agenttrail", "build-requirements.txt"), "utf8")
    .trim().split("\n");
  const lockedPackages = Object.entries(lock.packages).sort(([left], [right]) => left.localeCompare(right));
  for (const [name, version] of lockedPackages) {
    const prefix = `${name}==${version} --hash=sha256:`;
    if (!requirements.some((line) => line.startsWith(prefix) && /^[a-f0-9]{64}$/.test(line.slice(prefix.length)))) {
      throw new Error(`AgentTrail build requirement lacks its reviewed hash: ${name}`);
    }
  }
  if (requirements.length !== lockedPackages.length) {
    throw new Error("AgentTrail build requirements and package lock disagree");
  }
}

function walkRegularFiles(directory, relative = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const child = path.join(directory, entry.name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error(`imported AgentTrail source contains a symlink: ${childRelative}`);
    if (stat.isDirectory()) return walkRegularFiles(child, childRelative);
    if (!stat.isFile()) throw new Error(`imported AgentTrail source contains a non-file: ${childRelative}`);
    return [childRelative];
  }).sort();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalExecutable(candidate, label) {
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be absolute`);
  const stat = lstatSync(candidate);
  const canonical = realpathSync(candidate);
  if (stat.isSymbolicLink() || canonical !== candidate || !stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`${label} must be a canonical executable regular file`);
  }
  return canonical;
}
