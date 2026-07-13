import { chmodSync, rmSync, writeFileSync } from "node:fs";
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
  validatePackageDirectory,
  validatePackageFile,
} from "./package-files.mjs";

validatePackagedFile(requiredFixture);
validatePackagedFile("README.md");
validatePackagedFile("LICENSE");
const buildInputs = collectBuildInputs();
validatePackageDirectory("dist", { optional: true });
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
const presentPackagedFiles = packagedFiles
  .map((file) => validatePackagedFile(file))
  .filter((validated) => validated !== null);
for (const { absolutePath } of presentPackagedFiles) {
  chmodSync(absolutePath, 0o644);
}

for (const binary of requiredBinaries) {
  chmodSync(validatePackageFile(binary).absolutePath, 0o755);
}
const manifest = {
  schemaVersion: 1,
  inputs: digestFiles(buildInputs),
  outputs: digestFiles(buildOutputs),
};
validatePackageDirectory("dist");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
chmodSync(validatePackageFile("dist/package-manifest.json").absolutePath, 0o644);

function validatePackagedFile(file) {
  try {
    return validatePackageFile(file, { optional: file === "LICENSE" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (requiredBinaries.includes(file)) {
        failBuild(`declared binary ${file} was not emitted`);
      }
      failBuild(`required packaged path ${file} does not exist`);
    }
    throw error;
  }
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
