import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createReadOnlyRepositoryView } from "../../src/agents/read-only-repository-view.js";
import { openCodeResourceIdentity } from "../../src/agents/opencode-resource-identity.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createReadOnlyRepositoryView", () => {
  it("copies only planned readable paths and excludes forbidden and unrelated files", () => {
    const root = fixture();
    const view = createReadOnlyRepositoryView(root, ["src/**", "README.md"], ["src/private/**"], viewPath(root, 1));
    roots.push(view.path);

    expect(readFileSync(path.join(view.path, "src/public.ts"), "utf8")).toBe("public evidence\n");
    expect(readFileSync(path.join(view.path, "README.md"), "utf8")).toBe("read me\n");
    expect(existsSync(path.join(view.path, "src/private/secret.ts"))).toBe(false);
    expect(existsSync(path.join(view.path, ".env"))).toBe(false);
    expect(existsSync(path.join(view.path, "other.txt"))).toBe(false);
    expect(view).toMatchObject({
      readableScopes: ["src/**", "README.md"],
      forbiddenPaths: ["src/private/**"],
    });
    expect(view.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a selected symlink without reading or copying its external target", () => {
    const root = fixture();
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.txt`);
    writeFileSync(outside, "external secret\n");
    roots.push(outside);
    symlinkSync(outside, path.join(root, "src/escape.ts"));

    expect(() => createReadOnlyRepositoryView(root, ["src/**"], [], viewPath(root, 2))).toThrow("symbolic links");

    const outsideDirectory = path.join(path.dirname(root), `outside-${path.basename(root)}`);
    mkdirSync(outsideDirectory);
    writeFileSync(path.join(outsideDirectory, "nested.ts"), "nested external secret\n");
    roots.push(outsideDirectory);
    symlinkSync(outsideDirectory, path.join(root, "linked"));
    expect(() => createReadOnlyRepositoryView(root, ["linked/nested.ts"], [], viewPath(root, 3))).toThrow("symbolic links");
  });

  it("rejects unsafe, overlapping, and missing exact scopes", () => {
    const root = fixture();
    expect(() => createReadOnlyRepositoryView(root, ["../secret"], [], viewPath(root, 4))).toThrow();
    expect(() => createReadOnlyRepositoryView(root, ["src/**"], ["src/**"], viewPath(root, 5))).toThrow("overlaps");
    expect(() => createReadOnlyRepositoryView(root, ["missing.txt"], [], viewPath(root, 6))).toThrow("does not exist");
  });
});

function fixture(): string {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-read-view-source-")));
  roots.push(root);
  mkdirSync(path.join(root, "src/private"), { recursive: true });
  writeFileSync(path.join(root, "src/public.ts"), "public evidence\n");
  writeFileSync(path.join(root, "src/private/secret.ts"), "private\n");
  writeFileSync(path.join(root, "README.md"), "read me\n");
  writeFileSync(path.join(root, ".env"), "credential\n");
  writeFileSync(path.join(root, "other.txt"), "unrelated\n");
  return root;
}

function viewPath(root: string, attempt: number): string {
  return openCodeResourceIdentity(root, "view-test", attempt).repositoryViewPath;
}
