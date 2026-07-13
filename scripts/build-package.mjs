import { chmodSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

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
import { runCommand } from "./run-command.mjs";

const commandTimeoutMs = 120_000;
const commandMaxBuffer = 10 * 1_024 * 1_024;

validatePackagedFile(requiredFixture);
validatePackagedFile("README.md");
validatePackagedFile("SECURITY.md");
validatePackagedFile("LICENSE");
const buildInputs = collectBuildInputs();
validatePackageDirectory("dist", { optional: true });
rmSync(path.join(packageRoot, "dist"), { recursive: true, force: true });
const tsc = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
try {
  runCommand(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: packageRoot,
    environment: minimalEnvironment(),
    maxBuffer: commandMaxBuffer,
    timeoutMs: commandTimeoutMs,
  });
} catch (error) {
  failBuild(error instanceof Error ? error.message : String(error));
}

const buildOutputs = collectBuildOutputs();
const packagedFiles = [...new Set([
  ...buildOutputs,
  ...requiredBinaries,
  requiredFixture,
  "package.json",
  "README.md",
  "SECURITY.md",
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
  return {
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    LANG: "C",
    LC_ALL: "C",
  };
}
