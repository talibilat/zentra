import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

export const packageRoot = path.resolve(import.meta.dirname, "..");
export const manifestPath = path.join(packageRoot, "dist", "package-manifest.json");
export const requiredFixture = "fixtures/deterministic-worker.mjs";
const canonicalPackageRoot = validatePackageRoot();
export const requiredBinaries = collectDeclaredBinaries();

export function collectBuildInputs() {
  const files = [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
    "agenttrail/build-lock.json",
    "agenttrail/build-requirements.txt",
    "agenttrail/entrypoint.py",
    "agenttrail/import-manifest.json",
    ...walkFiles("agenttrail/package"),
    ...walkFiles("fixtures"),
    ...walkFiles("scripts"),
    ...walkFiles("src"),
  ].sort();
  for (const file of files) validatePackageFile(file);
  return files;
}

export function collectBuildOutputs() {
  return walkFiles("dist")
    .filter((file) => file !== "dist/package-manifest.json")
    .sort();
}

export function digestFiles(files) {
  return Object.fromEntries(files.map((file) => [
    file,
    createHash("sha256").update(readFileSync(validatePackageFile(file).absolutePath)).digest("hex"),
  ]));
}

export function validatePackageFile(file, options = {}) {
  return validatePackagePath(file, "file", options);
}

export function validatePackageDirectory(file, options = {}) {
  return validatePackagePath(file, "directory", options);
}

function collectDeclaredBinaries() {
  const packageJsonPath = validatePackageFile("package.json").absolutePath;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const targets = typeof packageJson.bin === "string"
    ? [packageJson.bin]
    : Object.values(packageJson.bin ?? {});
  if (targets.length === 0 || targets.some((target) => typeof target !== "string")) {
    throw new Error("package.json must declare at least one string-valued bin target");
  }
  return [...new Set(targets.map((target) => normalizePackagePath(target)))].sort();
}

function normalizePackagePath(file) {
  const normalized = path.posix.normalize(file.replace(/^\.\//, ""));
  if (
    normalized === "." ||
    path.posix.isAbsolute(file) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("\\")
  ) {
    throw new Error(`package.json bin target must stay inside the package: ${file}`);
  }
  return normalized;
}

function walkFiles(directory) {
  const validatedDirectory = validatePackageDirectory(directory);
  return readdirSync(validatedDirectory.absolutePath)
    .flatMap((name) => {
      const entry = `${directory}/${name}`;
      const validatedEntry = validatePackagePath(entry, "entry");
      return validatedEntry.stat.isDirectory() ? walkFiles(entry) : [entry];
    });
}

function validatePackageRoot() {
  const stat = lstatSync(packageRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`package root must be a non-symlink directory: ${packageRoot}`);
  }
  return realpathSync(packageRoot);
}

function validatePackagePath(file, kind, { optional = false } = {}) {
  if (validatePackageRoot() !== canonicalPackageRoot) {
    throw new Error(`package root changed while validating packaged path: ${packageRoot}`);
  }
  const normalized = normalizeRelativePath(file);
  const components = normalized.split("/");
  let current = packageRoot;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (
        optional &&
        index === components.length - 1 &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
    const component = components.slice(0, index + 1).join("/");
    if (stat.isSymbolicLink()) {
      if (index === components.length - 1 && kind === "file") {
        throw new Error(`packaged path ${normalized} must be a regular non-symlink file`);
      }
      throw new Error(`packaged path ${normalized} has symbolic-link component ${component}`);
    }
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw new Error(`packaged path ${normalized} has non-directory component ${component}`);
    }
    if (index === components.length - 1) {
      if (kind === "file" && !stat.isFile()) {
        throw new Error(`packaged path ${normalized} must be a regular non-symlink file`);
      }
      if (kind === "directory" && !stat.isDirectory()) {
        throw new Error(`packaged path ${normalized} must be a non-symlink directory`);
      }
      if (kind === "entry" && !stat.isFile() && !stat.isDirectory()) {
        throw new Error(`packaged path ${normalized} must be a regular file or directory`);
      }
      const resolved = realpathSync(current);
      if (!isWithinPackageRoot(resolved)) {
        throw new Error(`packaged path ${normalized} resolves outside the package root`);
      }
      return { absolutePath: current, stat };
    }
  }
  throw new Error(`invalid packaged path: ${file}`);
}

function normalizeRelativePath(file) {
  if (typeof file !== "string" || file.length === 0 || file.includes("\\")) {
    throw new Error(`packaged path must be a nonempty portable relative path: ${String(file)}`);
  }
  const normalized = path.posix.normalize(file.replace(/^\.\//, ""));
  if (
    normalized === "." ||
    path.posix.isAbsolute(file) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`packaged path must stay inside the package: ${file}`);
  }
  return normalized;
}

function isWithinPackageRoot(candidate) {
  return candidate === canonicalPackageRoot || candidate.startsWith(`${canonicalPackageRoot}${path.sep}`);
}
