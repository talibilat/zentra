import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  collectBuildInputs,
  collectBuildOutputs,
  digestFiles,
  manifestPath,
  packageRoot,
  requiredBinaries,
  requiredFixture,
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

const buildOutputs = collectBuildOutputs();
const packagedFiles = [...new Set([
  ...buildOutputs,
  ...requiredBinaries,
  requiredFixture,
  "package.json",
  "README.md",
  "LICENSE",
])];
const presentPackagedFiles = packagedFiles.filter((file) => assertPackagedFile(file));
for (const file of presentPackagedFiles) {
  chmodSync(path.join(packageRoot, file), 0o644);
}

for (const binary of requiredBinaries) {
  chmodSync(path.join(packageRoot, binary), 0o755);
}
const manifest = {
  schemaVersion: 1,
  inputs: digestFiles(collectBuildInputs()),
  outputs: digestFiles(buildOutputs),
};
mkdirSync(path.dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
chmodSync(manifestPath, 0o644);

function assertPackagedFile(file) {
  let stat;
  try {
    stat = lstatSync(path.join(packageRoot, file));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (file === "LICENSE") return false;
      if (requiredBinaries.includes(file)) {
        failBuild(`declared binary ${file} was not emitted`);
      }
      failBuild(`required packaged path ${file} does not exist`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    failBuild(`packaged path ${file} must be a regular non-symlink file`);
  }
  return true;
}

function failBuild(message) {
  console.error(`Package build failed: ${message}`);
  process.exit(1);
}

function minimalEnvironment() {
  const environment = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}
