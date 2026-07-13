import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-package-contents-")));
const nodeExecutable = canonicalExecutable(process.execPath, "Node.js");
const npmExecutable = canonicalExecutable(path.join(path.dirname(nodeExecutable), "npm"), "npm");
const tarExecutable = canonicalExecutable("/usr/bin/tar", "tar");
const commandEnvironment = minimalEnvironment();
const commandTimeoutMs = 120_000;
const forbiddenCanaries = [
  ".env",
  ".worktrees/package-canary.txt",
  "coverage/package-canary.txt",
  "docs/execution/package-canary.md",
  "docs/issues/package-canary.md",
  "fixtures/package-canary.js.map",
  "package-canary.db",
  "tests/package-canary.test.js",
];

try {
  const first = createAndInspectPackage("umask-022", 0o022);
  const second = createAndInspectPackage("umask-077", 0o077);
  assertEqual("normalized archive entries", first.entries, second.entries);
  assertEqual("package metadata", first.packageJson, second.packageJson);
  console.log(`Verified ${first.entries.length} deterministic package files across clean packs with umasks 022 and 077.`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Package content verification failed: ${message}`);
  process.exitCode = 1;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function createAndInspectPackage(label, umask) {
  const previousUmask = process.umask(umask);
  try {
    return inspectPackage(label);
  } finally {
    process.umask(previousUmask);
  }
}

function inspectPackage(label) {
  const runRoot = path.join(temporaryRoot, label);
  const sourceRoot = path.join(runRoot, "source");
  const artifactRoot = path.join(runRoot, "artifacts");
  const extractedRoot = path.join(runRoot, "extracted");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(artifactRoot);
  mkdirSync(extractedRoot);
  copyPackageSource(sourceRoot);
  seedCanaries(sourceRoot);

  const packed = run(
    nodeExecutable,
    [npmExecutable, "pack", "--silent", "--json", "--pack-destination", artifactRoot],
    sourceRoot,
  );
  const jsonStart = packed.stdout.lastIndexOf("\n[");
  const results = JSON.parse(packed.stdout.slice(jsonStart < 0 ? 0 : jsonStart + 1));
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error("npm pack did not return exactly one package result");
  }
  const result = results[0];
  const listedFiles = result.files.map(({ path: file, mode }) => ({ path: file, mode }));
  assertPackageManifest(sourceRoot, listedFiles);

  const tarball = path.join(artifactRoot, result.filename);
  run(tarExecutable, ["-xzf", tarball, "-C", extractedRoot, "-p"], sourceRoot);
  const extractedPackage = path.join(extractedRoot, "package");
  const entries = walkFiles(extractedPackage).map((file) => {
    const relative = relativePath(extractedPackage, file);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`archive entry must be a regular non-symlink file: ${relative}`);
    }
    return {
      path: relative,
      mode: stat.mode & 0o777,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    };
  });
  assertEqual(
    "npm file list and extracted archive paths/modes",
    listedFiles,
    entries.map(({ path: file, mode }) => ({ path: file, mode })),
  );
  assertExpectedModes(entries, sourceRoot);

  const packageJson = JSON.parse(readFileSync(path.join(extractedPackage, "package.json"), "utf8"));
  const sourcePackageJson = JSON.parse(readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  assertEqual("packed and source package metadata", packageJson, sourcePackageJson);
  return { entries, packageJson };
}

function copyPackageSource(destination) {
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "README.md",
    "tsconfig.json",
    "tsconfig.build.json",
  ]) {
    copyFileSync(path.join(packageRoot, name), path.join(destination, name));
  }
  if (existsSync(path.join(packageRoot, "LICENSE"))) {
    copyFileSync(path.join(packageRoot, "LICENSE"), path.join(destination, "LICENSE"));
  }
  for (const name of ["fixtures", "scripts", "src"]) {
    cpSync(path.join(packageRoot, name), path.join(destination, name), { recursive: true });
  }
  symlinkSync(path.join(packageRoot, "node_modules"), path.join(destination, "node_modules"));
}

function seedCanaries(sourceRoot) {
  for (const file of forbiddenCanaries) {
    const target = path.join(sourceRoot, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `forbidden package canary: ${file}\n`, "utf8");
  }
  mkdirSync(path.join(sourceRoot, "dist"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "dist", "stale-output.js"), "stale output\n", "utf8");
  if (!existsSync(path.join(sourceRoot, "LICENSE"))) {
    writeFileSync(path.join(sourceRoot, "LICENSE"), "Prospective package license fixture.\n", "utf8");
  }
}

function assertPackageManifest(sourceRoot, listedFiles) {
  const expected = [
    "LICENSE",
    "README.md",
    ...walkFiles(path.join(sourceRoot, "dist")).map((file) => relativePath(sourceRoot, file)),
    "fixtures/deterministic-worker.mjs",
    "package.json",
  ].sort();
  const actual = listedFiles.map(({ path: file }) => file);
  assertEqual("explicit package file allowlist", actual, expected);
  for (const forbidden of [...forbiddenCanaries, "dist/stale-output.js"]) {
    if (actual.includes(forbidden)) throw new Error(`forbidden file was packed: ${forbidden}`);
  }
}

function assertExpectedModes(entries, sourceRoot) {
  const packageJson = JSON.parse(readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  const binaryTargets = typeof packageJson.bin === "string"
    ? [packageJson.bin]
    : Object.values(packageJson.bin ?? {});
  const binaries = new Set(binaryTargets.map((file) => path.posix.normalize(file.replace(/^\.\//, ""))));
  for (const entry of entries) {
    const expected = binaries.has(entry.path) ? 0o755 : 0o644;
    if (entry.mode !== expected) {
      throw new Error(`${entry.path} has mode ${entry.mode.toString(8)}, expected ${expected.toString(8)}`);
    }
  }
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
    })
    .sort();
}

function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function run(executable, args, cwd) {
  const command = formatCommand(executable, args);
  const result = spawnSync(executable, args, {
    cwd,
    shell: false,
    env: commandEnvironment,
    encoding: "utf8",
    maxBuffer: 10 * 1_024 * 1_024,
    timeout: commandTimeoutMs,
  });
  if (result.error !== undefined) {
    if ("code" in result.error && result.error.code === "ETIMEDOUT") {
      throw new Error(`${command} timed out after ${commandTimeoutMs}ms`);
    }
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const termination = result.signal === null ? `exit ${result.status}` : `signal ${result.signal}`;
    throw new Error(`${command} failed with ${termination}:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function canonicalExecutable(candidate, label) {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${label} executable path must be absolute: ${candidate}`);
  }
  let canonical;
  try {
    canonical = realpathSync(candidate);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot resolve canonical ${label} executable ${candidate}: ${detail}`);
  }
  const stat = lstatSync(canonical);
  if (!path.isAbsolute(canonical) || stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`${label} executable must resolve to an executable regular file: ${canonical}`);
  }
  return canonical;
}

function minimalEnvironment() {
  const userConfig = path.join(temporaryRoot, "user.npmrc");
  const globalConfig = path.join(temporaryRoot, "global.npmrc");
  writeFileSync(userConfig, "", "utf8");
  writeFileSync(globalConfig, "", "utf8");
  return {
    PATH: [path.dirname(nodeExecutable), "/usr/bin", "/bin"].join(path.delimiter),
    HOME: temporaryRoot,
    TMPDIR: temporaryRoot,
    LANG: "C",
    LC_ALL: "C",
    npm_config_audit: "false",
    npm_config_cache: path.join(temporaryRoot, "npm-cache"),
    npm_config_fund: "false",
    npm_config_globalconfig: globalConfig,
    npm_config_ignore_scripts: "false",
    npm_config_update_notifier: "false",
    npm_config_userconfig: userConfig,
  };
}

function formatCommand(executable, args) {
  return [executable, ...args].map((argument) => JSON.stringify(argument)).join(" ");
}

function assertEqual(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} differs:\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`);
  }
}
