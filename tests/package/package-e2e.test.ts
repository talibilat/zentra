import { execFile, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
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
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

interface PackResult {
  readonly filename: string;
  readonly files: readonly { readonly path: string; readonly mode: number }[];
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return execFileAsync(executable, [...args], {
    cwd,
    env,
    maxBuffer: 10 * 1_024 * 1_024,
  });
}

function packageSandbox(): string {
  const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-package-source-")));
  temporaryDirectories.push(sandbox);
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
  ]) {
    const source = path.join(repositoryRoot, name);
    if (existsSync(source)) copyFileSync(source, path.join(sandbox, name));
  }
  for (const name of ["src", "fixtures", "scripts"]) {
    const source = path.join(repositoryRoot, name);
    if (existsSync(source)) cpSync(source, path.join(sandbox, name), { recursive: true });
  }
  symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(sandbox, "node_modules"));
  return sandbox;
}

async function pack(sandbox: string): Promise<{ readonly tarball: string; readonly result: PackResult }> {
  const destination = path.join(sandbox, "artifacts");
  mkdirSync(destination);
  const packed = await run(
    "npm",
    ["pack", "--silent", "--json", "--pack-destination", destination],
    sandbox,
  );
  const jsonStart = packed.stdout.lastIndexOf("\n[");
  const results = JSON.parse(packed.stdout.slice(jsonStart < 0 ? 0 : jsonStart + 1)) as PackResult[];
  expect(results).toHaveLength(1);
  return {
    tarball: path.join(destination, results[0]!.filename),
    result: results[0]!,
  };
}

async function initializeProject(baseDirectory: string): Promise<{
  readonly config: string;
  readonly database: string;
  readonly repository: string;
}> {
  const repository = path.join(baseDirectory, "project");
  await run("git", ["init", "-b", "main", repository], baseDirectory);
  await run("git", ["config", "user.name", "Zentra Package Test"], repository);
  await run("git", ["config", "user.email", "package-test@zentra.local"], repository);
  mkdirSync(path.join(repository, "test"));
  writeFileSync(path.join(repository, "greeting.txt"), "hello\n", "utf8");
  writeFileSync(
    path.join(repository, "test", "greeting.test.mjs"),
    'import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\ntest("greeting", async () => assert.equal(await readFile(new URL("../greeting.txt", import.meta.url), "utf8"), "hello from package\\n"));\n',
    "utf8",
  );
  await run("git", ["add", "--", "."], repository);
  await run("git", ["commit", "-m", "initial package fixture"], repository);

  const config = path.join(baseDirectory, "zentra.project.json");
  const database = path.join(baseDirectory, "journal.sqlite");
  writeFileSync(config, `${JSON.stringify({
    projectId: "package-project",
    repositoryPath: repository,
    integrationBranch: "zentra/integration",
    worktreeRoot: path.join(baseDirectory, "worktrees"),
    validations: {
      focused: [realpathSync(process.execPath), "--test", "test/greeting.test.mjs"],
      full: [realpathSync(process.execPath), "--test"],
    },
  }, null, 2)}\n`, "utf8");
  return { config, database, repository };
}

describe("publishable CLI package", () => {
  it("packs from clean output, installs into an empty consumer, and runs a SQLite-backed task", async () => {
    const sandbox = packageSandbox();
    expect(existsSync(path.join(sandbox, "dist"))).toBe(false);

    const { tarball, result } = await pack(sandbox);
    const packedCli = result.files.find((file) => file.path === "dist/src/cli/main.js");
    expect(packedCli).toBeDefined();
    expect(packedCli!.mode & 0o111).not.toBe(0);
    expect(result.files.some((file) => file.path === "fixtures/deterministic-worker.mjs")).toBe(true);
    expect(result.files.some((file) => file.path === "dist/package-manifest.json")).toBe(true);

    const consumer = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-package-consumer-")));
    temporaryDirectories.push(consumer);
    writeFileSync(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n', "utf8");
    await run("npm", ["install", "--no-audit", "--no-fund", tarball], consumer);

    const installedRoot = path.join(consumer, "node_modules", "zentra");
    const installedCli = path.join(installedRoot, "dist", "src", "cli", "main.js");
    const binary = path.join(consumer, "node_modules", ".bin", "zentra");
    expect(readFileSync(installedCli, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(lstatSync(binary).mode & 0o111).not.toBe(0);
    expect(existsSync(path.join(installedRoot, "fixtures", "deterministic-worker.mjs"))).toBe(true);
    await import(pathToFileURL(path.join(installedRoot, "dist", "src", "journal", "sqlite-journal.js")).href);

    const help = await run(binary, ["--help"], consumer);
    expect(help.stderr).toBe("");
    expect(help.stdout).toMatch(/\btask\b/);

    const reviewer = path.join(consumer, "reviewer.mjs");
    copyFileSync(path.join(repositoryRoot, "tests", "fixtures", "content-aware-reviewer.mjs"), reviewer);
    const project = await initializeProject(consumer);
    const fixtureTemp = path.join(consumer, "fixture-temp");
    mkdirSync(fixtureTemp, { mode: 0o700 });
    const operational = await run(binary, [
      "task", "run",
      "--config", project.config,
      "--database", project.database,
      "--task-id", "packaged-task",
      "--title", "Run installed package",
      "--file", "greeting.txt",
      "--content", "hello from package\n",
      "--reviewer-executable", realpathSync(process.execPath),
      "--reviewer-argument", reviewer,
      "--reviewer-id", "package-reviewer",
    ], consumer, { ...process.env, TMPDIR: fixtureTemp });
    expect(operational.stderr).toBe("");
    expect(JSON.parse(operational.stdout)).toMatchObject({
      command: "task.run",
      outcome: "completed",
      task: { taskId: "packaged-task", terminalOutcome: "completed" },
    });
    expect(existsSync(project.database)).toBe(true);
    expect((await run("git", ["show", "zentra/integration:greeting.txt"], project.repository)).stdout)
      .toBe("hello from package\n");

    const installedFixtureModule = await import(pathToFileURL(
      path.join(installedRoot, "dist", "src", "fixtures", "bundled-fixtures.js"),
    ).href) as {
      resolveBundledFixture(name: "deterministic-worker.mjs"): {
        readonly path: string;
        cleanup(): void;
      };
    };
    const installedSource = path.join(installedRoot, "fixtures", "deterministic-worker.mjs");
    const attestedBytes = readFileSync(installedSource);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      writeFileSync(installedSource, attestedBytes);
      const fixture = installedFixtureModule.resolveBundledFixture("deterministic-worker.mjs");
      const privateDirectory = path.dirname(fixture.path);
      try {
        writeFileSync(installedSource, 'throw new Error("UNATTESTED_PACKAGE_MARKER");\n', "utf8");
        const workspace = path.join(consumer, `replacement-workspace-${attempt}`);
        mkdirSync(workspace);
        const result = spawnSync(process.execPath, [
          fixture.path,
          "--workspace",
          workspace,
          "--file",
          "greeting.txt",
          "--content",
          `attested package attempt ${attempt}\n`,
        ], { encoding: "utf8", shell: false });
        expect(result.status).toBe(0);
        expect(`${result.stdout}${result.stderr}`).not.toContain("UNATTESTED_PACKAGE_MARKER");
      } finally {
        fixture.cleanup();
      }
      expect(existsSync(fixture.path)).toBe(false);
      expect(existsSync(privateDirectory)).toBe(false);
    }
    writeFileSync(installedSource, attestedBytes);
    expect(readdirSync(fixtureTemp)).toEqual([]);
  }, 120_000);

  it("fails npm pack when the declared binary target is not produced", async () => {
    const sandbox = packageSandbox();
    const packageJsonPath = path.join(sandbox, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    packageJson.bin = { zentra: "./dist/src/cli/missing.js" };
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    const destination = path.join(sandbox, "artifacts");
    mkdirSync(destination);

    await expect(run(
      "npm",
      ["pack", "--silent", "--json", "--pack-destination", destination],
      sandbox,
    )).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "Package build failed: declared binary dist/src/cli/missing.js was not emitted",
      ),
    });
    expect(existsSync(path.join(destination, "zentra-0.1.0.tgz"))).toBe(false);
  }, 30_000);

  it.each([
    ["missing binary", (sandbox: string) => rmSync(path.join(sandbox, "dist", "src", "cli", "main.js"))],
    ["missing fixture", (sandbox: string) => rmSync(path.join(sandbox, "fixtures", "deterministic-worker.mjs"))],
    ["stale package metadata", (sandbox: string) => writeFileSync(
      path.join(sandbox, "package.json"),
      `${readFileSync(path.join(sandbox, "package.json"), "utf8")}\n`,
      "utf8",
    )],
    ["stale inherited TypeScript configuration", (sandbox: string) => writeFileSync(
      path.join(sandbox, "tsconfig.json"),
      `${readFileSync(path.join(sandbox, "tsconfig.json"), "utf8")}\n`,
      "utf8",
    )],
    ["stale source", (sandbox: string) => writeFileSync(
      path.join(sandbox, "src", "contracts", "ids.ts"),
      `${readFileSync(path.join(sandbox, "src", "contracts", "ids.ts"), "utf8")}\n`,
      "utf8",
    )],
  ] as const)("rejects %s after a production build", async (_name, invalidate) => {
    const sandbox = packageSandbox();
    await run("npm", ["run", "build"], sandbox);
    invalidate(sandbox);

    await expect(run("npm", ["run", "package:verify"], sandbox)).rejects.toMatchObject({
      code: 1,
    });
  }, 30_000);
});
