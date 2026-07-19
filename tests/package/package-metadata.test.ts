import { spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const nodeExecutable = realpathSync(process.execPath);
const npmExecutable = realpathSync(path.join(path.dirname(nodeExecutable), "npm"));
const tarExecutable = realpathSync("/usr/bin/tar");
const require = createRequire(import.meta.url);
const npmInstallChecks = require(path.resolve(
  path.dirname(npmExecutable),
  "../node_modules/npm-install-checks",
)) as {
  checkEngine(target: PackageMetadata, npmVersion: string, nodeVersion: string): void;
};
const temporaryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-metadata-test-")));
const commandEnvironment = {
  PATH: [path.dirname(nodeExecutable), "/usr/bin", "/bin"].join(path.delimiter),
  HOME: temporaryRoot,
  TMPDIR: temporaryRoot,
  LANG: "C",
  LC_ALL: "C",
  npm_config_audit: "false",
  npm_config_cache: path.join(temporaryRoot, "npm-cache"),
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};

interface PackageMetadata {
  readonly _id?: string;
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly engines?: { readonly node?: string };
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
}

interface PackResult {
  readonly filename: string;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

async function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<CommandResult> {
  if (!path.isAbsolute(executable)) throw new Error(`test executable must be absolute: ${executable}`);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      detached: true,
      env: commandEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBuffer = 10 * 1_024 * 1_024;
    let outputBytes = 0;
    let settling = false;
    let closed = false;
    let resolveClosed: (() => void) | undefined;
    const closedPromise = new Promise<void>((resolveClose) => {
      resolveClosed = resolveClose;
    });

    const timer = setTimeout(() => void settle("ETIMEDOUT", false), timeoutMs);

    const capture = (destination: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxBuffer) {
        void settle("ENOBUFS", false);
        return;
      }
      destination.push(chunk);
    };

    const settle = async (code: number | string | null, graceful: boolean): Promise<void> => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      const pid = child.pid;
      try {
        if (pid !== undefined) await terminateProcessGroup(pid, graceful);
        if (!closed) {
          await new Promise<void>((resolveClose, rejectClose) => {
            const closeTimer = setTimeout(
              () => rejectClose(new Error("command streams did not close after process-group termination")),
              1_000,
            );
            void closedPromise.then(() => {
              clearTimeout(closeTimer);
              resolveClose();
            });
          });
        }
        const result = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
        if (code === 0) {
          resolve(result);
          return;
        }
        reject(Object.assign(new Error(`command failed with code ${String(code)}`), result, { code }));
      } catch (error) {
        reject(error);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      settling = true;
      reject(error);
    });
    child.on("exit", (code) => void settle(code, true));
    child.on("close", () => {
      closed = true;
      resolveClosed?.();
    });
  });
}

async function terminateProcessGroup(pid: number, graceful: boolean): Promise<void> {
  if (graceful && processGroupExists(pid)) {
    signalProcessGroup(pid, "SIGTERM");
    if (await waitForProcessGroupExit(pid, 250)) return;
  }
  if (processGroupExists(pid)) signalProcessGroup(pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(pid, 1_000))) {
    throw new Error(`command process group ${pid} survived bounded termination`);
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function runNpm(args: readonly string[], cwd: string) {
  return run(nodeExecutable, [npmExecutable, ...args], cwd);
}

function readMetadata(file: string): PackageMetadata {
  return JSON.parse(readFileSync(file, "utf8")) as PackageMetadata;
}

function copyPackageSource(destination: string): void {
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "README.md",
    "SECURITY.md",
    "tsconfig.json",
    "tsconfig.build.json",
  ]) {
    const source = path.join(repositoryRoot, name);
    if (existsSync(source)) copyFileSync(source, path.join(destination, name));
  }
  for (const name of ["agenttrail", "src", "fixtures", "scripts"]) {
    cpSync(path.join(repositoryRoot, name), path.join(destination, name), { recursive: true });
  }
  symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(destination, "node_modules"));
}

async function createTarball(): Promise<string> {
  const source = realpathSync(mkdtempSync(path.join(temporaryRoot, "source-")));
  const artifacts = path.join(source, "artifacts");
  mkdirSync(artifacts);
  copyPackageSource(source);
  const packed = await runNpm(["pack", "--silent", "--json", "--pack-destination", artifacts], source);
  const jsonStart = packed.stdout.lastIndexOf("\n[");
  const results = JSON.parse(packed.stdout.slice(jsonStart < 0 ? 0 : jsonStart + 1)) as PackResult[];
  expect(results).toHaveLength(1);
  return path.join(artifacts, results[0]!.filename);
}

async function readPackedMetadata(packageTarball: string): Promise<PackageMetadata> {
  const packedPackageJson = await run(
    tarExecutable,
    ["-xOf", packageTarball, "package/package.json"],
    temporaryRoot,
  );
  return JSON.parse(packedPackageJson.stdout) as PackageMetadata;
}

function createConsumer(name: string): string {
  const consumer = realpathSync(mkdtempSync(path.join(temporaryRoot, `${name}-`)));
  writeFileSync(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n', "utf8");
  return consumer;
}

function createSimulationPreload(name: string, source: string): string {
  const preload = path.join(temporaryRoot, `${name}.cjs`);
  writeFileSync(preload, `${source}\n`, "utf8");
  return preload;
}

const tarball = createTarball();

describe("MVP package platform metadata", () => {
  it("terminates and reaps command descendants before returning", async () => {
    const source = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "process.stdout.write(String(child.pid));",
      "child.unref();",
    ].join("\n");

    const result = await run(nodeExecutable, ["--eval", source], temporaryRoot, 1_000);
    const descendantPid = Number(result.stdout);

    expect(descendantPid).toBeGreaterThan(0);
    expect(() => process.kill(descendantPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("declares only the locally conformed Darwin arm64 target", () => {
    const metadata = readMetadata(path.join(repositoryRoot, "package.json"));

    expect(metadata.os).toEqual(["darwin"]);
    expect(metadata.cpu).toEqual(["arm64"]);
  });

  it("retains the platform constraints in the packed package", async () => {
    const packageTarball = await tarball;
    const metadata = await readPackedMetadata(packageTarball);

    expect(metadata.os).toEqual(["darwin"]);
    expect(metadata.cpu).toEqual(["arm64"]);
  }, 120_000);

  it("installs the packed package and loads its native dependency on the supported host", async () => {
    expect(process.platform).toBe("darwin");
    expect(process.arch).toBe("arm64");
    const packageTarball = await tarball;
    const consumer = createConsumer("supported-install");
    await runNpm(["install", "--no-audit", "--no-fund", packageTarball], consumer);

    const sqliteProbe = [
      'const Database = require("better-sqlite3");',
      'const database = new Database(":memory:");',
      'database.exec("select 1");',
      "database.close();",
    ].join("");
    await run(nodeExecutable, ["--eval", sqliteProbe], consumer);
    const help = await run(path.join(consumer, "node_modules", ".bin", "zentra"), ["--help"], consumer);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage: zentra");
  }, 120_000);

  it("makes npm reject installation for a controlled Linux target", async () => {
    const packageTarball = await tarball;
    const consumer = createConsumer("unsupported-linux");
    const preload = createSimulationPreload("linux-arm64", [
      'Object.defineProperty(process, "platform", { value: "linux" });',
      'Object.defineProperty(process, "arch", { value: "arm64" });',
    ].join("\n"));

    await expect(run(nodeExecutable, [
      "--require",
      preload,
      npmExecutable,
      "install",
      "--no-audit",
      "--no-fund",
      packageTarball,
    ], consumer)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/EBADPLATFORM[\s\S]*wanted.*darwin[\s\S]*actual.*linux/i),
    });
    expect(existsSync(path.join(consumer, "node_modules", "zentra"))).toBe(false);
  });
});

describe("MVP package license metadata", () => {
  it("declares the MIT SPDX license identifier", () => {
    const metadata = readMetadata(path.join(repositoryRoot, "package.json"));

    expect(metadata.license).toBe("MIT");
  });

  it("retains the MIT SPDX license identifier in the packed package", async () => {
    const packageTarball = await tarball;
    const metadata = await readPackedMetadata(packageTarball);

    expect(metadata.license).toBe("MIT");
  });
});

describe("MVP package Node.js metadata", () => {
  it("declares the exact supported Node.js range", () => {
    const metadata = readMetadata(path.join(repositoryRoot, "package.json"));

    expect(metadata.engines?.node).toBe(">=24 <27");
  });

  it("retains the exact Node.js range in the packed package", async () => {
    const metadata = await readPackedMetadata(await tarball);

    expect(metadata.engines?.node).toBe(">=24 <27");
  });

  it("aligns the selected better-sqlite3 release with Node.js 24, 25, and 26", () => {
    const dependencyMetadata = readMetadata(require.resolve("better-sqlite3/package.json"));

    expect(dependencyMetadata.version).toBe("12.11.1");
    expect(dependencyMetadata.engines?.node).toBe("20.x || 22.x || 23.x || 24.x || 25.x || 26.x");
    for (const nodeVersion of ["24.0.0", "25.0.0", "26.0.0"]) {
      expect(() => npmInstallChecks.checkEngine(dependencyMetadata, "11.8.0", nodeVersion)).not.toThrow();
    }
    expect(() => npmInstallChecks.checkEngine(dependencyMetadata, "11.8.0", "27.0.0"))
      .toThrow(expect.objectContaining({ code: "EBADENGINE" }));
  });

  it("makes strict npm installation reject a controlled Node.js 27 runtime", async () => {
    const consumer = createConsumer("unsupported-node-27");
    const preload = createSimulationPreload("node-27", [
      'Object.defineProperty(process, "version", { value: "v27.0.0" });',
      'Object.defineProperty(process, "versions", {',
      '  value: { ...process.versions, node: "27.0.0" },',
      "});",
    ].join("\n"));

    await expect(run(nodeExecutable, [
      "--require",
      preload,
      npmExecutable,
      "install",
      "--engine-strict",
      "--no-audit",
      "--no-fund",
      await tarball,
    ], consumer)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/EBADENGINE[\s\S]*required.*>=24 <27[\s\S]*actual.*v27\.0\.0/i),
    });
    expect(existsSync(path.join(consumer, "node_modules", "zentra"))).toBe(false);
  });
});
