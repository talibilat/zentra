import { readFileSync } from "node:fs";

import {
  collectBuildInputs,
  collectBuildOutputs,
  digestFiles,
  requiredBinaries,
  requiredFixture,
  validatePackageFile,
} from "./package-files.mjs";

try {
  const validatedManifest = validatePackageFile("dist/package-manifest.json");
  const manifest = JSON.parse(readFileSync(validatedManifest.absolutePath, "utf8"));
  if (manifest.schemaVersion !== 1) throw new Error("unsupported production manifest");
  validatePackageFile(requiredFixture);
  for (const requiredBinary of requiredBinaries) {
    const { absolutePath: binary, stat } = validatePackageFile(requiredBinary);
    if (!readFileSync(binary, "utf8").startsWith("#!/usr/bin/env node\n")) {
      throw new Error(`${requiredBinary} has no Node.js shebang`);
    }
    if ((stat.mode & 0o111) === 0) {
      throw new Error(`${requiredBinary} is not executable`);
    }
  }
  assertExactHashes("input", manifest.inputs, digestFiles(collectBuildInputs()));
  assertExactHashes("output", manifest.outputs, digestFiles(collectBuildOutputs()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Package verification failed: ${message}`);
  process.exitCode = 1;
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
