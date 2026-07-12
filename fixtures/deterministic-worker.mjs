#!/usr/bin/env node
// Deterministic worker fixture for supervisor tests.
// Accepts only: --workspace <absolute path> --file <relative path> --content <string>

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";

function fail(message) {
  process.stderr.write(`deterministic-worker: ${message}\n`);
  process.exit(1);
}

const allowedFlags = new Set(["--workspace", "--file", "--content"]);
const values = new Map();

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const flag = argv[i];
  if (!allowedFlags.has(flag)) {
    fail(`unknown flag: ${flag}`);
  }
  if (values.has(flag)) {
    fail(`duplicate flag: ${flag}`);
  }
  const value = argv[i + 1];
  if (value === undefined) {
    fail(`missing value for flag: ${flag}`);
  }
  values.set(flag, value);
}

for (const flag of allowedFlags) {
  if (!values.has(flag)) {
    fail(`missing required flag: ${flag}`);
  }
}

const workspace = values.get("--workspace");
const file = values.get("--file");
const content = values.get("--content");

if (!path.isAbsolute(workspace)) {
  fail(`--workspace must be an absolute path: ${workspace}`);
}
const canonicalWorkspace = realpathSync(workspace);
if (!lstatSync(canonicalWorkspace).isDirectory()) {
  fail(`--workspace must be a directory: ${workspace}`);
}
if (file === "") {
  fail("--file must not be empty");
}
if (path.isAbsolute(file)) {
  fail(`--file must be a relative path: ${file}`);
}
// MVP fixture scope is deliberately one root-level file, currently greeting.txt.
if (file.includes("/") || file.includes("\\")) {
  fail(`--file must be one root-level filename without slashes: ${file}`);
}
const segments = file.split(/[\\/]/);
if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
  fail(`--file contains an unsafe path segment: ${file}`);
}
const resolved = path.resolve(canonicalWorkspace, file);
if (resolved === canonicalWorkspace || !resolved.startsWith(canonicalWorkspace + path.sep)) {
  fail(`--file escapes the workspace: ${file}`);
}

let parent = canonicalWorkspace;
for (const segment of segments.slice(0, -1)) {
  const candidate = path.join(parent, segment);
  if (existsSync(candidate)) {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`--file parent must be a real directory: ${candidate}`);
    }
  } else {
    mkdirSync(candidate);
  }
  parent = realpathSync(candidate);
  if (!parent.startsWith(canonicalWorkspace + path.sep)) {
    fail(`--file parent escapes the workspace: ${file}`);
  }
}
const target = path.join(parent, segments.at(-1));
if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
  fail(`--file target must not be a symbolic link: ${file}`);
}

if (content === "__WAIT__") {
  // Wait indefinitely until terminated so cancellation and timeout can be tested.
  setInterval(() => {}, 1000);
} else {
  let descriptor;
  let writeError;
  try {
    descriptor = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    const bytes = Buffer.from(content, "utf8");
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(descriptor, bytes, written, bytes.length - written);
    }
  } catch (error) {
    writeError = error instanceof Error ? error.message : String(error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (writeError !== undefined) fail(`safe write failed: ${writeError}`);
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  process.stdout.write(`${JSON.stringify({ type: "artifact.ready", path: file, sha256 })}\n`);
  process.exit(0);
}
