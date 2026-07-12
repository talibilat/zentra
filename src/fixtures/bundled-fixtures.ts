import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_FIXTURE_SHA256 = Object.freeze({
  "deterministic-worker.mjs": "9839f5c1ae46c984bd0a3180b4dcaa9967bf81b73610b024d0a38538f973ce22",
});

export type BundledFixtureName = keyof typeof BUNDLED_FIXTURE_SHA256;
export type BundledFixturePaths = Readonly<Record<BundledFixtureName, string>>;

const SOURCE_TAIL = ["src", "fixtures", "bundled-fixtures.ts"] as const;
const BUILT_TAIL = ["dist", "src", "fixtures", "bundled-fixtures.js"] as const;

export function resolveBundledFixture(
  name: BundledFixtureName,
  anchor: string | URL = import.meta.url,
): string {
  if (!Object.hasOwn(BUNDLED_FIXTURE_SHA256, name)) {
    throw new Error(`unknown bundled fixture name: ${String(name)}`);
  }

  const anchorPath = fileURLToPath(anchor);
  const components = anchorPath.split(path.sep).filter(Boolean);
  const sourceLayout = hasExactTail(components, SOURCE_TAIL);
  const builtLayout = hasExactTail(components, BUILT_TAIL);
  if (!sourceLayout && !builtLayout) {
    throw new Error("bundled fixture resolver anchor is outside the exact source or built layout");
  }

  const expected = path.resolve(
    path.dirname(anchorPath),
    builtLayout ? "../../../fixtures" : "../../fixtures",
    name,
  );
  let stat;
  try {
    stat = lstatSync(expected);
  } catch {
    throw new Error(`bundled fixture is unavailable or not a regular file: ${name}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`bundled fixture must be a regular non-symlink file: ${name}`);
  }

  const canonical = realpathSync(expected);
  if (canonical !== expected) {
    throw new Error(`bundled fixture canonical path does not equal its expected path: ${name}`);
  }
  const digest = createHash("sha256").update(readFileSync(canonical)).digest("hex");
  if (digest !== BUNDLED_FIXTURE_SHA256[name]) {
    throw new Error(`bundled fixture SHA-256 attestation failed: ${name}`);
  }
  return canonical;
}

export function resolveBundledFixtures(
  anchor: string | URL = import.meta.url,
): BundledFixturePaths {
  return Object.freeze({
    "deterministic-worker.mjs": resolveBundledFixture("deterministic-worker.mjs", anchor),
  });
}

function hasExactTail(
  components: readonly string[],
  tail: readonly string[],
): boolean {
  return components.length >= tail.length &&
    tail.every((component, index) => component === components[components.length - tail.length + index]);
}
