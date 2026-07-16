import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_FIXTURE_SHA256 = Object.freeze({
  "deterministic-worker.mjs": "9839f5c1ae46c984bd0a3180b4dcaa9967bf81b73610b024d0a38538f973ce22",
});

export type BundledFixtureName = keyof typeof BUNDLED_FIXTURE_SHA256;
export interface BundledFixture {
  readonly path: string;
  cleanup(): void;
}

const SOURCE_TAIL = ["src", "fixtures", "bundled-fixtures.ts"] as const;
const BUILT_TAIL = ["dist", "src", "fixtures", "bundled-fixtures.js"] as const;

export function resolveBundledFixture(
  name: BundledFixtureName,
  anchor: string | URL = import.meta.url,
): BundledFixture {
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
  if (!stat.isFile()) {
    throw new Error(`bundled fixture must be a regular non-symlink file: ${name}`);
  }

  let canonical: string;
  try {
    canonical = realpathSync(expected);
  } catch {
    throw new Error(`bundled fixture is unavailable or unreadable: ${name}`);
  }
  if (canonical !== expected) {
    throw new Error(`bundled fixture canonical path does not equal its expected path: ${name}`);
  }

  let sourceDescriptor: number;
  try {
    sourceDescriptor = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(`bundled fixture is unavailable or unreadable: ${name}`);
  }
  let bytes: Buffer;
  try {
    const opened = fstatSync(sourceDescriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error(`bundled fixture changed while it was opened: ${name}`);
    }
    bytes = readFileSync(sourceDescriptor);
  } finally {
    closeSync(sourceDescriptor);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== BUNDLED_FIXTURE_SHA256[name]) {
    throw new Error(`bundled fixture SHA-256 attestation failed: ${name}`);
  }

  const privateDirectory = mkdtempSync(path.join(tmpdir(), "zentra-fixture-"));
  try {
    chmodSync(privateDirectory, 0o700);
    const privatePath = path.join(privateDirectory, name);
    const destinationDescriptor = openSync(
      privatePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o500,
    );
    try {
      writeFileSync(destinationDescriptor, bytes);
      fsyncSync(destinationDescriptor);
    } finally {
      closeSync(destinationDescriptor);
    }
    chmodSync(privatePath, 0o500);
    let cleaned = false;
    return Object.freeze({
      path: privatePath,
      cleanup(): void {
        if (cleaned) return;
        rmSync(privateDirectory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 25,
        });
        cleaned = true;
      },
    });
  } catch (error) {
    rmSync(privateDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
    throw error;
  }
}

function hasExactTail(
  components: readonly string[],
  tail: readonly string[],
): boolean {
  return components.length >= tail.length &&
    tail.every((component, index) => component === components[components.length - tail.length + index]);
}
