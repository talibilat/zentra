import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const packageRoot = path.resolve(import.meta.dirname, "..");
export const manifestPath = path.join(packageRoot, "dist", "package-manifest.json");
export const requiredFixture = "fixtures/deterministic-worker.mjs";
export const requiredBinaries = collectDeclaredBinaries();

export function collectBuildInputs() {
  return [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
    ...walkFiles(path.join(packageRoot, "fixtures")).map((file) => relativePath(file)),
    ...walkFiles(path.join(packageRoot, "scripts")).map((file) => relativePath(file)),
    ...walkFiles(path.join(packageRoot, "src")).map((file) => relativePath(file)),
  ].sort();
}

export function collectBuildOutputs() {
  return walkFiles(path.join(packageRoot, "dist"))
    .map((file) => relativePath(file))
    .filter((file) => file !== "dist/package-manifest.json")
    .sort();
}

export function digestFiles(files) {
  return Object.fromEntries(files.map((file) => [
    file,
    createHash("sha256").update(readFileSync(path.join(packageRoot, file))).digest("hex"),
  ]));
}

function collectDeclaredBinaries() {
  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
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
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
    });
}

function relativePath(file) {
  return path.relative(packageRoot, file).split(path.sep).join("/");
}
