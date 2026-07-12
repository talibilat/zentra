import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveBundledFixture,
  type BundledFixtureName,
} from "../../src/fixtures/bundled-fixtures.js";

const fixtureNames = [
  "deterministic-worker.mjs",
  "deterministic-reviewer.mjs",
] as const;
const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function copiedLayout(
  layout: "source" | "built",
  options: { readonly copyExpected?: boolean } = {},
): {
  readonly anchor: URL;
  readonly root: string;
  readonly fixtures: Readonly<Record<BundledFixtureName, string>>;
} {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-bundle-resolver-")));
  temporaryDirectories.push(root);
  const moduleDirectory = layout === "source"
    ? path.join(root, "src", "fixtures")
    : path.join(root, "dist", "src", "fixtures");
  const moduleName = layout === "source" ? "bundled-fixtures.ts" : "bundled-fixtures.js";
  const fixtureDirectory = path.join(root, "fixtures");
  mkdirSync(moduleDirectory, { recursive: true });
  mkdirSync(fixtureDirectory);
  const anchorPath = path.join(moduleDirectory, moduleName);
  writeFileSync(anchorPath, "// isolated resolver anchor\n", "utf8");
  const fixtures = Object.fromEntries(fixtureNames.map((name) => [
    name,
    path.join(fixtureDirectory, name),
  ])) as Record<BundledFixtureName, string>;
  if (options.copyExpected !== false) {
    for (const name of fixtureNames) {
      copyFileSync(path.join(repositoryRoot, "fixtures", name), fixtures[name]);
    }
  }
  return { anchor: pathToFileURL(anchorPath), root, fixtures };
}

describe("resolveBundledFixture", () => {
  it.each(["source", "built"] as const)(
    "returns canonical attested worker and reviewer paths from the exact %s layout",
    (layout) => {
      const copied = copiedLayout(layout);

      for (const name of fixtureNames) {
        expect(resolveBundledFixture(name, copied.anchor)).toBe(realpathSync(copied.fixtures[name]));
      }
    },
  );

  it.each(fixtureNames)("rejects modified bytes for %s", (name) => {
    const copied = copiedLayout("source");
    writeFileSync(copied.fixtures[name], "modified fixture bytes\n", "utf8");

    expect(() => resolveBundledFixture(name, copied.anchor)).toThrow(/attestation|sha-?256|digest/i);
  });

  it("rejects an expected-path symlink even when its target has valid bytes", () => {
    const copied = copiedLayout("source");
    const expected = copied.fixtures["deterministic-reviewer.mjs"];
    const external = path.join(copied.root, "external-reviewer.mjs");
    copyFileSync(expected, external);
    rmSync(expected);
    symlinkSync(external, expected);

    expect(() => resolveBundledFixture("deterministic-reviewer.mjs", copied.anchor))
      .toThrow(/regular non-symlink|symbolic/i);
  });

  it("rejects unknown fixture names and anchors outside exact source or built tails", () => {
    const copied = copiedLayout("source");
    const wrongAnchor = pathToFileURL(path.join(copied.root, "lib", "bundled-fixtures.js"));

    expect(() => resolveBundledFixture("other.mjs" as BundledFixtureName, copied.anchor))
      .toThrow(/fixture name/i);
    expect(() => resolveBundledFixture("deterministic-worker.mjs", wrongAnchor))
      .toThrow(/layout/i);
  });

  it("rejects a stale dist fixture shadow instead of searching for the first existing file", () => {
    const copied = copiedLayout("built", { copyExpected: false });
    const staleDirectory = path.join(copied.root, "dist", "fixtures");
    mkdirSync(staleDirectory);
    for (const name of fixtureNames) {
      copyFileSync(
        path.join(repositoryRoot, "fixtures", name),
        path.join(staleDirectory, name),
      );
    }

    expect(() => resolveBundledFixture("deterministic-worker.mjs", copied.anchor))
      .toThrow(/bundled fixture|regular file|unavailable/i);
  });
});
