#!/usr/bin/env node
// Deterministic worker fixture for supervisor tests.
// Accepts only: --workspace <absolute path> --file <relative path> --content <string>

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
if (file === "") {
  fail("--file must not be empty");
}
if (path.isAbsolute(file)) {
  fail(`--file must be a relative path: ${file}`);
}
const segments = file.split(/[\\/]/);
if (segments.includes("..")) {
  fail(`--file must not contain ".." traversal: ${file}`);
}
const resolved = path.resolve(workspace, file);
if (resolved === workspace || !resolved.startsWith(workspace + path.sep)) {
  fail(`--file escapes the workspace: ${file}`);
}

if (content === "__WAIT__") {
  // Wait indefinitely until terminated so cancellation and timeout can be tested.
  setInterval(() => {}, 1000);
} else {
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, content, "utf8");
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  process.stdout.write(`${JSON.stringify({ type: "artifact.ready", path: file, sha256 })}\n`);
  process.exit(0);
}
