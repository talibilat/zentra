import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const packageRoot = path.resolve(import.meta.dirname, "..");
export const manifestPath = path.join(packageRoot, "dist", "package-manifest.json");
export const requiredBinary = "dist/src/cli/main.js";
export const requiredFixture = "fixtures/deterministic-worker.mjs";

export function collectBuildInputs() {
  return [
    "tsconfig.build.json",
    requiredFixture,
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
