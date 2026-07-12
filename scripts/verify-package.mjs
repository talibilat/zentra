import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  collectBuildInputs,
  collectBuildOutputs,
  digestFiles,
  manifestPath,
  packageRoot,
  requiredBinary,
  requiredFixture,
} from "./package-files.mjs";

try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) throw new Error("unsupported production manifest");
  assertRegularFile(requiredBinary);
  assertRegularFile(requiredFixture);
  const binary = path.join(packageRoot, requiredBinary);
  if (!readFileSync(binary, "utf8").startsWith("#!/usr/bin/env node\n")) {
    throw new Error("production CLI has no Node.js shebang");
  }
  if ((lstatSync(binary).mode & 0o111) === 0) {
    throw new Error("production CLI is not executable");
  }
  assertExactHashes("input", manifest.inputs, digestFiles(collectBuildInputs()));
  assertExactHashes("output", manifest.outputs, digestFiles(collectBuildOutputs()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Package verification failed: ${message}`);
  process.exitCode = 1;
}

function assertRegularFile(file) {
  const stat = lstatSync(path.join(packageRoot, file));
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${file} must be a regular non-symlink file`);
  }
}

function assertExactHashes(kind, expected, actual) {
  if (
    expected === null ||
    typeof expected !== "object" ||
    JSON.stringify(expected) !== JSON.stringify(actual)
  ) {
    throw new Error(`production ${kind} is missing or stale`);
  }
}
