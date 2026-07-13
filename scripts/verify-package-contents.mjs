import { spawn } from "node:child_process";
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
import { pathToFileURL } from "node:url";

import {
  collectBuildInputs,
  validatePackageDirectory,
  validatePackageFile,
} from "./package-files.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const nodeExecutable = canonicalExecutable(process.execPath, "Node.js");
const npmExecutable = canonicalExecutable(path.join(path.dirname(nodeExecutable), "npm"), "npm");
const tarExecutable = canonicalExecutable("/usr/bin/tar", "tar");
const commandTimeoutMs = 120_000;
const terminationGraceMs = 250;
const forcedTerminationMs = 1_000;
const processGroupPollMs = 10;
let temporaryRoot;
let commandEnvironment;
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

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}

async function main() {
  temporaryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-package-contents-")));
  commandEnvironment = minimalEnvironment();
  try {
    const first = await createAndInspectPackage("umask-022", 0o022);
    const second = await createAndInspectPackage("umask-077", 0o077);
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
}

async function createAndInspectPackage(label, umask) {
  const previousUmask = process.umask(umask);
  try {
    return await inspectPackage(label);
  } finally {
    process.umask(previousUmask);
  }
}

async function inspectPackage(label) {
  const runRoot = path.join(temporaryRoot, label);
  const sourceRoot = path.join(runRoot, "source");
  const artifactRoot = path.join(runRoot, "artifacts");
  const extractedRoot = path.join(runRoot, "extracted");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(artifactRoot);
  mkdirSync(extractedRoot);
  copyPackageSource(sourceRoot);
  seedCanaries(sourceRoot);

  const packed = await run(
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
  await run(tarExecutable, ["-xzf", tarball, "-C", extractedRoot, "-p"], sourceRoot);
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
  const sourceFiles = [
    "package.json",
    "pnpm-lock.yaml",
    "README.md",
    "tsconfig.json",
    "tsconfig.build.json",
  ].map((name) => [name, validatePackageFile(name).absolutePath]);
  const license = validatePackageFile("LICENSE", { optional: true });
  const sourceDirectories = ["fixtures", "scripts", "src"]
    .map((name) => [name, validatePackageDirectory(name).absolutePath]);

  // Validate every recursive entry before any copy can follow a changed source path.
  collectBuildInputs();
  for (const [name, source] of sourceFiles) {
    copyFileSync(source, path.join(destination, name));
  }
  if (license !== null) {
    copyFileSync(license.absolutePath, path.join(destination, "LICENSE"));
  }
  for (const [name, source] of sourceDirectories) {
    cpSync(source, path.join(destination, name), { recursive: true });
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

export function run(executable, args, cwd, {
  environment = commandEnvironment,
  timeoutMs = commandTimeoutMs,
} = {}) {
  const command = formatCommand(executable, args);
  const maxBuffer = 10 * 1_024 * 1_024;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      detached: true,
      shell: false,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let decided = false;
    let closed = false;
    let resolveClosed;
    const closedPromise = new Promise((resolveClose) => {
      resolveClosed = resolveClose;
    });
    const timer = setTimeout(() => decide({ kind: "timeout" }), timeoutMs);

    const capture = (destination, chunk) => {
      const remaining = maxBuffer - capturedBytes;
      if (remaining > 0) {
        const retained = Math.min(remaining, chunk.byteLength);
        destination.push(retained === chunk.byteLength ? chunk : chunk.subarray(0, retained));
        capturedBytes += retained;
      }
      if (chunk.byteLength > remaining) decide({ kind: "output_limit" });
    };

    const decide = (decision) => {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      void settle(decision);
    };

    const settle = async (decision) => {
      const pid = child.pid;
      try {
        if (pid !== undefined) {
          await terminateProcessGroup(pid, decision.kind === "exit");
        }
        if (!closed) {
          await waitForClose(closedPromise, forcedTerminationMs);
        }
      } catch (error) {
        reject(new Error(`${command} cleanup could not confirm subprocess-tree exit: ${errorMessage(error)}`));
        return;
      }

      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        status: decision.kind === "exit" ? decision.status : null,
        signal: decision.kind === "exit" ? decision.signal : null,
      };
      if (decision.kind === "timeout") {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      if (decision.kind === "output_limit") {
        reject(new Error(`${command} exceeded the ${maxBuffer}-byte output limit`));
        return;
      }
      if (decision.kind === "spawn_error") {
        reject(new Error(`${command} failed to start: ${decision.error.message}`));
        return;
      }
      if (result.status !== 0) {
        const termination = result.signal === null ? `exit ${result.status}` : `signal ${result.signal}`;
        reject(new Error(`${command} failed with ${termination}:\n${result.stderr || result.stdout}`));
        return;
      }
      resolve(result);
    };

    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.on("error", (error) => decide({ kind: "spawn_error", error }));
    child.on("exit", (status, signal) => decide({ kind: "exit", status, signal }));
    child.on("close", () => {
      closed = true;
      resolveClosed();
    });
  });
}

async function terminateProcessGroup(pid, graceful) {
  if (graceful && processGroupExists(pid)) {
    signalProcessGroup(pid, "SIGTERM");
    if (await waitForProcessGroupExit(pid, terminationGraceMs)) return;
  }
  if (processGroupExists(pid)) signalProcessGroup(pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(pid, forcedTerminationMs))) {
    throw new Error(`process group ${pid} survived bounded termination`);
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

// Checks process-group membership only. A descendant that uses detached:true again to create a
// new session is a documented residual risk outside the Trusted-Project MVP threat model; AGENTS.md
// already disclaims sandboxing against deliberate actions by an approved, trusted executable.
async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  while (processGroupExists(pid)) {
    const remainingNs = deadline - process.hrtime.bigint();
    if (remainingNs <= 0n) return false;
    const remainingMs = Number((remainingNs + 999_999n) / 1_000_000n);
    await new Promise((resolve) => setTimeout(resolve, Math.min(processGroupPollMs, remainingMs)));
  }
  return true;
}

async function waitForClose(closedPromise, timeoutMs) {
  let timer;
  await Promise.race([
    closedPromise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("subprocess streams did not close after termination")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
