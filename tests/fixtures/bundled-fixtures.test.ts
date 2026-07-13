import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const filesystemInterposition = vi.hoisted(() => ({
  beforePrivateMaterialization: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => {
      filesystemInterposition.beforePrivateMaterialization?.();
      return actual.mkdtempSync(...args);
    },
  };
});

import {
  resolveBundledFixture,
  type BundledFixtureName,
} from "../../src/fixtures/bundled-fixtures.js";

const fixtureNames = ["deterministic-worker.mjs"] as const;
const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

afterEach(() => {
  filesystemInterposition.beforePrivateMaterialization = undefined;
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
    "returns a private byte-bound worker from the exact %s layout",
    (layout) => {
      const copied = copiedLayout(layout);

      for (const name of fixtureNames) {
        const fixture = resolveBundledFixture(name, copied.anchor);
        try {
          expect(fixture.path).not.toBe(realpathSync(copied.fixtures[name]));
          expect(statSync(path.dirname(fixture.path)).mode & 0o777).toBe(0o700);
          expect(statSync(fixture.path).mode & 0o777).toBe(0o500);
        } finally {
          fixture.cleanup();
        }
      }
    },
  );

  it.each(["source", "built"] as const)(
    "materializes only accepted bytes when the exact %s source changes after digest acceptance",
    (layout) => {
      const copied = copiedLayout(layout);
      const source = copied.fixtures["deterministic-worker.mjs"];
      let interposed = false;
      filesystemInterposition.beforePrivateMaterialization = () => {
        interposed = true;
        writeFileSync(source, 'throw new Error("UNATTESTED_INTERPOSITION_MARKER");\n', "utf8");
      };

      const fixture = resolveBundledFixture("deterministic-worker.mjs", copied.anchor);
      filesystemInterposition.beforePrivateMaterialization = undefined;
      try {
        expect(interposed).toBe(true);
        expect(readFileSync(source, "utf8")).toContain("UNATTESTED_INTERPOSITION_MARKER");
        expect(readFileSync(fixture.path, "utf8")).not.toContain("UNATTESTED_INTERPOSITION_MARKER");

        const workspace = path.join(copied.root, "interposition-workspace");
        mkdirSync(workspace);
        const result = spawnSync(process.execPath, [
          fixture.path,
          "--workspace",
          workspace,
          "--file",
          "greeting.txt",
          "--content",
          `${layout} accepted bytes executed\n`,
        ], { encoding: "utf8", shell: false });
        expect(result.status).toBe(0);
        expect(`${result.stdout}${result.stderr}`).not.toContain("UNATTESTED_INTERPOSITION_MARKER");
        expect(readFileSync(path.join(workspace, "greeting.txt"), "utf8"))
          .toBe(`${layout} accepted bytes executed\n`);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each(["replacement", "rename"] as const)(
    "executes only attested bytes after a source %s race",
    (race) => {
      const copied = copiedLayout("source");
      const source = copied.fixtures["deterministic-worker.mjs"];
      const fixture = resolveBundledFixture("deterministic-worker.mjs", copied.anchor);
      const malicious = path.join(copied.root, "malicious-worker.mjs");
      writeFileSync(malicious, 'throw new Error("UNATTESTED_MARKER");\n', "utf8");
      if (race === "replacement") {
        rmSync(source);
        copyFileSync(malicious, source);
      } else {
        renameSync(source, `${source}.attested`);
        renameSync(malicious, source);
      }

      try {
        const workspace = path.join(copied.root, "workspace");
        mkdirSync(workspace);
        const result = spawnSync(process.execPath, [
          fixture.path,
          "--workspace",
          workspace,
          "--file",
          "greeting.txt",
          "--content",
          "attested bytes executed\n",
        ], { encoding: "utf8", shell: false });
        expect(result.status).toBe(0);
        expect(`${result.stdout}${result.stderr}`).not.toContain("UNATTESTED_MARKER");
        expect(readFileSync(path.join(workspace, "greeting.txt"), "utf8"))
          .toBe("attested bytes executed\n");
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("copies bytes onto a distinct inode so later hard-link writes cannot alter execution", () => {
    const copied = copiedLayout("source");
    const source = copied.fixtures["deterministic-worker.mjs"];
    const linked = path.join(copied.root, "linked-worker.mjs");
    linkSync(source, linked);
    const fixture = resolveBundledFixture("deterministic-worker.mjs", copied.anchor);

    try {
      writeFileSync(linked, 'throw new Error("UNATTESTED_MARKER");\n', "utf8");
      expect(readFileSync(fixture.path, "utf8")).not.toContain("UNATTESTED_MARKER");
      expect(statSync(fixture.path).ino).not.toBe(statSync(source).ino);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when source permissions prevent reading", () => {
    const copied = copiedLayout("source");
    const source = copied.fixtures["deterministic-worker.mjs"];
    chmodSync(source, 0o000);

    expect(() => resolveBundledFixture("deterministic-worker.mjs", copied.anchor))
      .toThrow(/unavailable|read|permission/i);
  });

  it("removes the private executable and directory during bounded cleanup", () => {
    const copied = copiedLayout("source");
    const fixture = resolveBundledFixture("deterministic-worker.mjs", copied.anchor);
    const directory = path.dirname(fixture.path);

    fixture.cleanup();
    fixture.cleanup();

    expect(existsSync(fixture.path)).toBe(false);
    expect(existsSync(directory)).toBe(false);
  });

  it.each(fixtureNames)("rejects modified bytes for %s", (name) => {
    const copied = copiedLayout("source");
    writeFileSync(copied.fixtures[name], "modified fixture bytes\n", "utf8");

    expect(() => resolveBundledFixture(name, copied.anchor)).toThrow(/attestation|sha-?256|digest/i);
  });

  it("rejects an expected-path symlink even when its target has valid bytes", () => {
    const copied = copiedLayout("source");
    const expected = copied.fixtures["deterministic-worker.mjs"];
    const external = path.join(copied.root, "external-worker.mjs");
    copyFileSync(expected, external);
    rmSync(expected);
    symlinkSync(external, expected);

    expect(() => resolveBundledFixture("deterministic-worker.mjs", copied.anchor))
      .toThrow(/regular non-symlink|symbolic/i);
  });

  it("rejects unknown fixture names and anchors outside exact source or built tails", () => {
    const copied = copiedLayout("source");
    const wrongAnchor = pathToFileURL(path.join(copied.root, "lib", "bundled-fixtures.js"));

    expect(() => resolveBundledFixture("other.mjs" as BundledFixtureName, copied.anchor))
      .toThrow(/fixture name/i);
    expect(() => resolveBundledFixture(
      "deterministic-reviewer.mjs" as BundledFixtureName,
      copied.anchor,
    )).toThrow(/fixture name/i);
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
