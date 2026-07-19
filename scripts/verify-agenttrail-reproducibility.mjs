import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { runCommand } from "./run-command.mjs";

const root = path.resolve(import.meta.dirname, "..");
const packageRoot = path.join(root, "agenttrail", "package", "darwin-arm64");
const buildScript = path.join(root, "scripts", "build-agenttrail.mjs");
const node = realpathSync(process.execPath);

const first = buildAndSnapshot();
const second = buildAndSnapshot();
if (first.size !== second.size) {
  throw new Error("AgentTrail clean builds produced different package file sets");
}
for (const [relative, expected] of first) {
  const actual = second.get(relative);
  if (
    actual === undefined || actual.mode !== expected.mode ||
    actual.bytes.byteLength !== expected.bytes.byteLength ||
    !actual.bytes.equals(expected.bytes)
  ) {
    throw new Error(`AgentTrail clean builds differ at ${relative}`);
  }
}
const executable = first.get("agenttrail");
if (executable === undefined) throw new Error("AgentTrail clean build omitted its executable");
console.log(
  `Verified two byte-identical clean AgentTrail packages (${sha256(executable.bytes)}) with identical modes.`,
);

function buildAndSnapshot() {
  runCommand(node, [buildScript], {
    cwd: root,
    environment: buildEnvironment(),
    timeoutMs: 300_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return new Map(walk(packageRoot).map((absolute) => {
    const relative = path.relative(packageRoot, absolute).split(path.sep).join("/");
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`Unsafe AgentTrail clean-build output identity: ${relative}`);
    }
    return [relative, { mode: metadata.mode & 0o777, bytes: readFileSync(absolute) }];
  }));
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`AgentTrail package contains a symlink: ${absolute}`);
    return metadata.isDirectory() ? walk(absolute) : [absolute];
  }).sort();
}

function buildEnvironment() {
  const environment = {
    PATH: [path.dirname(node), "/usr/bin", "/bin"].join(path.delimiter),
    LANG: "C",
    LC_ALL: "C",
  };
  if (process.env.AGENTTRAIL_BUILD_PYTHON !== undefined) {
    environment.AGENTTRAIL_BUILD_PYTHON = process.env.AGENTTRAIL_BUILD_PYTHON;
  }
  return environment;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
