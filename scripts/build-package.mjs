import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  collectBuildInputs,
  collectBuildOutputs,
  digestFiles,
  manifestPath,
  packageRoot,
  requiredBinaries,
} from "./package-files.mjs";

rmSync(path.join(packageRoot, "dist"), { recursive: true, force: true });
const tsc = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: packageRoot,
  shell: false,
  stdio: "inherit",
  env: minimalEnvironment(),
});
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

for (const binary of requiredBinaries) {
  try {
    chmodSync(path.join(packageRoot, binary), 0o755);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.error(`Package build failed: declared binary ${binary} was not emitted`);
      process.exit(1);
    }
    throw error;
  }
}
const manifest = {
  schemaVersion: 1,
  inputs: digestFiles(collectBuildInputs()),
  outputs: digestFiles(collectBuildOutputs()),
};
mkdirSync(path.dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

function minimalEnvironment() {
  const environment = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}
