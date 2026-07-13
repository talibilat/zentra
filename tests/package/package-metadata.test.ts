import { execFile } from "node:child_process";
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
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const nodeExecutable = realpathSync(process.execPath);
const npmExecutable = realpathSync(path.join(path.dirname(nodeExecutable), "npm"));
const tarExecutable = realpathSync("/usr/bin/tar");
const require = createRequire(import.meta.url);
const npmInstallChecks = require(path.resolve(
  path.dirname(npmExecutable),
  "../node_modules/npm-install-checks",
)) as {
  checkPlatform(
    target: PackageMetadata,
    force: boolean,
    environment: { readonly os: string; readonly cpu: string },
  ): void;
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
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
}

interface PackResult {
  readonly filename: string;
}

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

async function run(executable: string, args: readonly string[], cwd: string) {
  if (!path.isAbsolute(executable)) throw new Error(`test executable must be absolute: ${executable}`);
  return execFileAsync(executable, [...args], {
    cwd,
    env: commandEnvironment,
    maxBuffer: 10 * 1_024 * 1_024,
    timeout: 120_000,
  });
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
    "tsconfig.json",
    "tsconfig.build.json",
  ]) {
    const source = path.join(repositoryRoot, name);
    if (existsSync(source)) copyFileSync(source, path.join(destination, name));
  }
  for (const name of ["src", "fixtures", "scripts"]) {
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

const tarball = createTarball();

describe("MVP package platform metadata", () => {
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
  });

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

  it("makes npm reject the packed package for a controlled Linux target", async () => {
    const packageTarball = await tarball;
    const metadata = await readPackedMetadata(packageTarball);

    expect(() => npmInstallChecks.checkPlatform(metadata, false, {
      os: "linux",
      cpu: "arm64",
    })).toThrow(expect.objectContaining({
      code: "EBADPLATFORM",
      message: "Unsupported platform",
      current: expect.objectContaining({ os: "linux", cpu: "arm64" }),
      required: expect.objectContaining({ os: ["darwin"], cpu: ["arm64"] }),
    }));
    expect(existsSync(path.join(temporaryRoot, "node_modules", "zentra"))).toBe(false);
  });
});
