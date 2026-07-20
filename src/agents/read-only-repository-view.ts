import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { controlledViewRoot } from "./opencode-resource-identity.js";
import type { GitClient } from "../workspaces/git-client.js";

const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;

export interface ReadOnlyRepositoryView {
  readonly path: string;
  readonly revision: string;
  readonly readableScopes: readonly string[];
  readonly forbiddenPaths: readonly string[];
}

export async function createReadOnlyRepositoryViewAtCommit(
  git: GitClient,
  repositoryPath: string,
  commit: string,
  readableScopes: readonly string[],
  forbiddenPaths: readonly string[],
  destinationPath: string,
  signal?: AbortSignal,
  remainingDurationMs?: () => number,
): Promise<ReadOnlyRepositoryView> {
  const repository = realpathSync.native(repositoryPath);
  if (repository !== repositoryPath || !statSync(repository).isDirectory() || !/^[a-f0-9]{40,64}$/.test(commit)) {
    throw new Error("read-only Git snapshot source is invalid");
  }
  const scopes = validateScopes(readableScopes, "readable scope", false);
  const forbidden = validateScopes(forbiddenPaths, "forbidden path", true);
  const options = () => {
    const remaining = remainingDurationMs?.() ?? 30_000;
    if (remaining <= 0) throw new Error("read-only Git snapshot preparation deadline exhausted");
    return { ...(signal === undefined ? {} : { signal }), timeoutMs: Math.max(1, Math.min(30_000, remaining)) };
  };
  const resolved = await git.run(repository, ["rev-parse", "--verify", `${commit}^{commit}`], options());
  const format = await git.run(repository, ["rev-parse", "--show-object-format"], options());
  if (resolved.exitCode !== 0 || resolved.termination !== null || resolved.truncated || resolved.stdout.trim() !== commit ||
    format.exitCode !== 0 || format.termination !== null || format.truncated ||
    (format.stdout.trim() !== "sha1" && format.stdout.trim() !== "sha256")) {
    throw new Error("read-only Git snapshot commit identity is invalid");
  }
  const tree = await git.run(repository, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...scopes.map(scopeBase)], options());
  if (tree.exitCode !== 0 || tree.termination !== null || tree.truncated || tree.stdoutBytes === undefined ||
    !Buffer.from(tree.stdout, "utf8").equals(tree.stdoutBytes)) {
    throw new Error("read-only Git snapshot tree could not be measured");
  }
  const entries = parseTree(tree.stdout).filter((entry) =>
    scopes.some((scope) => scopeContains(scope, entry.path)) && !isDenied(entry.path, forbidden));
  if (entries.length === 0 || entries.length > MAX_FILES) throw new Error("read-only Git snapshot has an invalid file count");
  const viewRoot = controlledViewRoot();
  if (path.dirname(destinationPath) !== viewRoot || path.normalize(destinationPath) !== destinationPath) {
    throw new Error("repository view path is outside the controlled root");
  }
  mkdirSync(destinationPath, { mode: 0o755 });
  const destination = realpathSync.native(destinationPath);
  let bytes = 0;
  try {
    for (const entry of entries) {
      if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
        throw new Error("read-only Git snapshot contains an unsupported entry");
      }
      const blob = await git.run(repository, ["cat-file", "blob", entry.oid], options());
      if (blob.exitCode !== 0 || blob.termination !== null || blob.truncated) throw new Error("read-only Git snapshot blob could not be read");
      const content = blob.stdoutBytes;
      if (content === undefined) throw new Error("read-only Git snapshot binary evidence is unavailable");
      bytes += content.length;
      if (bytes > MAX_BYTES || gitObjectId(format.stdout.trim() as "sha1" | "sha256", "blob", content) !== entry.oid) {
        throw new Error("read-only Git snapshot blob identity is invalid");
      }
      const target = path.join(destination, ...entry.path.split("/"));
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      writeFileSync(target, content, { mode: 0o444, flag: "wx" });
      chmodSync(target, 0o444);
    }
    return Object.freeze({
      path: destination,
      revision: createHash("sha256").update(commit, "utf8").digest("hex"),
      readableScopes: Object.freeze([...scopes]),
      forbiddenPaths: Object.freeze([...forbidden]),
    });
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export function createReadOnlyRepositoryView(
  repositoryPath: string,
  readableScopes: readonly string[],
  forbiddenPaths: readonly string[],
  destinationPath: string,
): ReadOnlyRepositoryView {
  const repository = realpathSync.native(repositoryPath);
  if (repository !== repositoryPath || !statSync(repository).isDirectory()) {
    throw new Error("read-only repository source must be a canonical directory");
  }
  const scopes = validateScopes(readableScopes, "readable scope", false);
  const forbidden = validateScopes(forbiddenPaths, "forbidden path", true);
  for (const scope of scopes) {
    for (const denied of forbidden) {
      if (scopeBase(scope) === scopeBase(denied)) throw new Error("readable scope overlaps a forbidden path");
    }
  }

  const viewRoot = controlledViewRoot();
  if (path.dirname(destinationPath) !== viewRoot || path.normalize(destinationPath) !== destinationPath) {
    throw new Error("repository view path is outside the controlled root");
  }
  mkdirSync(destinationPath, { mode: 0o755 });
  const destination = realpathSync.native(destinationPath);
  if (destination !== destinationPath) throw new Error("repository view path is not canonical");
  const digest = createHash("sha256");
  const copied = new Set<string>();
  let files = 0;
  let bytes = 0;

  try {
    const copy = (relative: string): void => {
      if (isDenied(relative, forbidden) || copied.has(relative)) return;
      assertNoSymlinkComponents(repository, relative);
      const source = path.join(repository, ...relative.split("/"));
      const entry = lstatSync(source);
      if (entry.isSymbolicLink()) throw new Error(`readable repository scope cannot contain symbolic links: ${relative}`);
      copied.add(relative);
      if (entry.isDirectory()) {
        const target = path.join(destination, ...relative.split("/"));
        mkdirSync(target, { recursive: true, mode: 0o755 });
        for (const child of readdirSync(source).sort()) copy(`${relative}/${child}`);
        return;
      }
      if (!entry.isFile()) throw new Error(`readable repository scope contains an unsupported entry: ${relative}`);
      const target = path.join(destination, ...relative.split("/"));
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      const descriptor = openRegularNoFollow(source);
      let content: Buffer;
      try {
        content = readFileSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      files += 1;
      bytes += content.length;
      if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error("read-only repository view exceeds its resource limit");
      writeFileSync(target, content, { mode: 0o444, flag: "wx" });
      chmodSync(target, 0o444);
      digest.update(relative).update("\0");
      digest.update(createHash("sha256").update(content).digest()).update("\0");
    };

    for (const scope of scopes) {
      const base = scopeBase(scope);
      assertNoSymlinkComponents(repository, base);
      const source = path.join(repository, ...base.split("/"));
      let entry;
      try {
        entry = lstatSync(source);
      } catch {
        throw new Error(`readable repository scope does not exist: ${scope}`);
      }
      if (entry.isSymbolicLink()) throw new Error(`readable repository scope cannot contain symbolic links: ${base}`);
      if (scope.endsWith("/**") && !entry.isDirectory()) throw new Error(`recursive readable scope is not a directory: ${scope}`);
      copy(base);
    }
    if (files === 0) throw new Error("read-only repository view contains no readable files");
    return Object.freeze({
      path: realpathSync.native(destination),
      revision: digest.digest("hex"),
      readableScopes: Object.freeze([...scopes]),
      forbiddenPaths: Object.freeze([...forbidden]),
    });
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function assertNoSymlinkComponents(repository: string, relative: string): void {
  let current = repository;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = lstatSync(current);
    } catch {
      return;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`readable repository scope cannot contain symbolic links: ${relative}`);
    }
  }
}

function openRegularNoFollow(filePath: string): number {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!fstatSync(descriptor).isFile()) {
    closeSync(descriptor);
    throw new Error("readable repository scope contains an unsupported entry");
  }
  return descriptor;
}

function validateScopes(values: readonly string[], name: string, allowEmpty: boolean): readonly string[] {
  if ((!allowEmpty && values.length === 0) || values.length > 256) throw new Error(`${name} list is invalid`);
  const unique = [...new Set(values)];
  if (unique.length !== values.length) throw new Error(`${name} list contains duplicates`);
  for (const value of unique) {
    const base = scopeBase(value);
    if (
      value.length === 0 || value.length > 4_096 || value.includes("\\") ||
      (value.includes("*") && !value.endsWith("/**")) ||
      base.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("*"))
    ) throw new Error(`${name} is unsafe`);
  }
  return Object.freeze(unique);
}

function scopeBase(scope: string): string {
  return scope.endsWith("/**") ? scope.slice(0, -3) : scope;
}

function isDenied(relative: string, forbidden: readonly string[]): boolean {
  return forbidden.some((scope) => {
    const base = scopeBase(scope);
    return relative === base || (scope.endsWith("/**") && relative.startsWith(`${base}/`));
  });
}

function scopeContains(scope: string, candidate: string): boolean {
  const base = scopeBase(scope);
  return candidate === base || (scope.endsWith("/**") && candidate.startsWith(`${base}/`));
}

function parseTree(output: string): readonly { readonly mode: string; readonly type: string; readonly oid: string; readonly path: string }[] {
  return output.split("\0").filter(Boolean).map((record) => {
    const match = /^(\d{6}) ([a-z]+) ([a-f0-9]{40,64})\t(.+)$/.exec(record);
    if (match === null || !isSafeTreePath(match[4]!)) throw new Error("read-only Git snapshot tree is invalid");
    return { mode: match[1]!, type: match[2]!, oid: match[3]!, path: match[4]! };
  });
}

function isSafeTreePath(value: string): boolean {
  return !value.includes("\\") && !value.includes("\0") && value.split("/").every((segment) =>
    segment !== "" && segment !== "." && segment !== "..");
}

function gitObjectId(format: "sha1" | "sha256", type: "blob", content: Buffer): string {
  return createHash(format).update(`${type} ${content.length}\0`, "utf8").update(content).digest("hex");
}
