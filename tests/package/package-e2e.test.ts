import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const nodeExecutable = realpathSync(process.execPath);
const npmExecutable = realpathSync(path.join(path.dirname(nodeExecutable), "npm"));
const gitExecutable = realpathSync("/usr/bin/git");
const subprocessHome = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-package-test-home-")));
const subprocessEnvironment = {
  PATH: [path.dirname(nodeExecutable), "/usr/bin", "/bin"].join(path.delimiter),
  HOME: subprocessHome,
  TMPDIR: tmpdir(),
  LANG: "C",
  LC_ALL: "C",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};
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

afterAll(() => {
  rmSync(subprocessHome, { recursive: true, force: true });
});

async function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = subprocessEnvironment,
) {
  if (!path.isAbsolute(executable)) throw new Error(`test executable must be absolute: ${executable}`);
  return execFileAsync(executable, [...args], {
    cwd,
    env,
    maxBuffer: 10 * 1_024 * 1_024,
    timeout: 120_000,
  });
}

function runNpm(args: readonly string[], cwd: string) {
  return run(nodeExecutable, [npmExecutable, ...args], cwd);
}

function packageSandbox(): string {
  const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-package-source-")));
  temporaryDirectories.push(sandbox);
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "README.md",
    "SECURITY.md",
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
  const packed = await runNpm(["pack", "--silent", "--json", "--pack-destination", destination], sandbox);
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
  readonly securitySheet: string;
}> {
  const repository = path.join(baseDirectory, "project");
  await run(gitExecutable, ["init", "-b", "main", repository], baseDirectory);
  await run(gitExecutable, ["config", "user.name", "Zentra Package Test"], repository);
  await run(gitExecutable, ["config", "user.email", "package-test@zentra.local"], repository);
  mkdirSync(path.join(repository, "test"));
  writeFileSync(path.join(repository, "greeting.txt"), "hello\n", "utf8");
  writeFileSync(
    path.join(repository, "test", "greeting.test.mjs"),
    'import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\ntest("greeting", async () => assert.equal(await readFile(new URL("../greeting.txt", import.meta.url), "utf8"), "hello from package\\n"));\n',
    "utf8",
  );
  await run(gitExecutable, ["add", "--", "."], repository);
  await run(gitExecutable, ["commit", "-m", "initial package fixture"], repository);

  const config = path.join(baseDirectory, "zentra.project.json");
  const database = path.join(baseDirectory, "journal.sqlite");
  const securitySheet = path.join(baseDirectory, "SECURITY-SHEET.md");
  writeFileSync(config, `${JSON.stringify({
    projectId: "package-project",
    repositoryPath: repository,
    integrationBranch: "zentra/integration",
    worktreeRoot: path.join(baseDirectory, "worktrees"),
    validations: {
      focused: [nodeExecutable, "--test", "test/greeting.test.mjs"],
      full: [nodeExecutable, "--test"],
    },
  }, null, 2)}\n`, "utf8");
  writeFileSync(securitySheet, `# Zentra Security Sheet

## Allowed Repositories
- ${realpathSync.native(repository)}

## Allowed File Scopes
- greeting.txt

## Forbidden Paths
- .env

## Network
Default: denied

## Secret Handling
- Do not inherit parent secrets.

## Approval Required Operations
- external_effect

## Release Boundary
local_preparation_only

## Stop And Ask Conditions
- missing_authority
- forbidden_file_scope
`, "utf8");
  return { config, database, repository, securitySheet };
}

describe("publishable CLI package", () => {
  it("packs from clean output, installs into an empty consumer, and runs a SQLite-backed task", async () => {
    const sandbox = packageSandbox();
    const securityPolicy = path.join(sandbox, "SECURITY.md");
    chmodSync(securityPolicy, 0o600);
    expect(existsSync(path.join(sandbox, "dist"))).toBe(false);

    const { tarball, result } = await pack(sandbox);
    const packedCli = result.files.find((file) => file.path === "dist/src/cli/main.js");
    expect(packedCli).toBeDefined();
    expect(packedCli!.mode & 0o111).not.toBe(0);
    expect(result.files.some((file) => file.path === "fixtures/deterministic-worker.mjs")).toBe(true);
    expect(result.files.some((file) => file.path === "dist/package-manifest.json")).toBe(true);
    expect(lstatSync(securityPolicy).mode & 0o777).toBe(0o644);

    const consumer = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-package-consumer-")));
    temporaryDirectories.push(consumer);
    writeFileSync(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n', "utf8");
    await runNpm(["install", "--no-audit", "--no-fund", tarball], consumer);

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
      "--security-sheet", project.securitySheet,
    ], consumer, { ...subprocessEnvironment, TMPDIR: fixtureTemp });
    expect(operational.stderr).toBe("");
    expect(JSON.parse(operational.stdout)).toMatchObject({
      command: "task.run",
      outcome: "completed",
      task: { taskId: "packaged-task", terminalOutcome: "completed" },
    });
    expect(existsSync(project.database)).toBe(true);
    expect((await run(gitExecutable, ["show", "zentra/integration:greeting.txt"], project.repository)).stdout)
      .toBe("hello from package\n");

    const installedFixtureModuleUrl = pathToFileURL(
      path.join(installedRoot, "dist", "src", "fixtures", "bundled-fixtures.js"),
    ).href;
    const installedFixtureModule = await import(installedFixtureModuleUrl) as {
      resolveBundledFixture(name: "deterministic-worker.mjs"): {
        readonly path: string;
        cleanup(): void;
      };
    };
    const installedSource = path.join(installedRoot, "fixtures", "deterministic-worker.mjs");
    const attestedBytes = readFileSync(installedSource);
    const interpositionWorkspace = path.join(consumer, "digest-interposition-workspace");
    mkdirSync(interpositionWorkspace);
    const interpositionProgram = [
      'import fs from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      'import path from "node:path";',
      'import { syncBuiltinESMExports } from "node:module";',
      `const source = ${JSON.stringify(installedSource)};`,
      `const resolverUrl = ${JSON.stringify(installedFixtureModuleUrl)};`,
      `const workspace = ${JSON.stringify(interpositionWorkspace)};`,
      'const marker = "UNATTESTED_PACKAGE_INTERPOSITION_MARKER";',
      "const acceptedBytes = fs.readFileSync(source);",
      "const originalMkdtempSync = fs.mkdtempSync;",
      "let fixture;",
      "let interposed = false;",
      "try {",
      "  fs.mkdtempSync = (...args) => {",
      "    interposed = true;",
      "    fs.writeFileSync(source, `throw new Error(\"${marker}\");\\n`, \"utf8\");",
      "    return originalMkdtempSync(...args);",
      "  };",
      "  syncBuiltinESMExports();",
      "  const resolver = await import(resolverUrl);",
      '  fixture = resolver.resolveBundledFixture("deterministic-worker.mjs");',
      "  fs.mkdtempSync = originalMkdtempSync;",
      "  syncBuiltinESMExports();",
      "  if (!interposed) throw new Error(\"private materialization was not interposed\");",
      "  if (fs.readFileSync(fixture.path, \"utf8\").includes(marker)) {",
      "    throw new Error(\"unattested bytes were materialized\");",
      "  }",
      "  const execution = spawnSync(process.execPath, [",
      "    fixture.path,",
      '    "--workspace", workspace,',
      '    "--file", "greeting.txt",',
      '    "--content", "packed accepted bytes executed\\n",',
      "  ], { encoding: \"utf8\", shell: false });",
      "  if (execution.status !== 0 || `${execution.stdout}${execution.stderr}`.includes(marker)) {",
      "    throw new Error(`private execution failed: ${execution.stdout}${execution.stderr}`);",
      "  }",
      "  const privatePath = fixture.path;",
      "  const privateDirectory = path.dirname(privatePath);",
      "  fixture.cleanup();",
      "  fixture = undefined;",
      "  if (fs.existsSync(privatePath) || fs.existsSync(privateDirectory)) {",
      "    throw new Error(\"private materialization was not cleaned\");",
      "  }",
      "  process.stdout.write(JSON.stringify({ interposed, executed: true }));",
      "} finally {",
      "  fs.mkdtempSync = originalMkdtempSync;",
      "  syncBuiltinESMExports();",
      "  fixture?.cleanup();",
      "  fs.writeFileSync(source, acceptedBytes);",
      "}",
    ].join("\n");
    const interposition = await run(nodeExecutable, [
      "--input-type=module",
      "--eval",
      interpositionProgram,
    ], consumer, { ...subprocessEnvironment, TMPDIR: fixtureTemp });
    expect(interposition.stderr).toBe("");
    expect(JSON.parse(interposition.stdout)).toEqual({ interposed: true, executed: true });
    expect(readFileSync(path.join(interpositionWorkspace, "greeting.txt"), "utf8"))
      .toBe("packed accepted bytes executed\n");

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

    await expect(runNpm(
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
    ["fixture", "fixtures/deterministic-worker.mjs"],
    ["security policy", "SECURITY.md"],
  ] as const)("rejects a symlinked packaged %s without modifying or packaging its external target", async (
    _, packagedPath,
  ) => {
    const sandbox = packageSandbox();
    const externalTarget = path.join(sandbox, "external-target.mjs");
    const packagedFile = path.join(sandbox, packagedPath);
    writeFileSync(externalTarget, "external target\n", "utf8");
    chmodSync(externalTarget, 0o600);
    rmSync(packagedFile);
    symlinkSync(externalTarget, packagedFile);
    const destination = path.join(sandbox, "artifacts");
    mkdirSync(destination);

    await expect(runNpm(
      ["pack", "--silent", "--json", "--pack-destination", destination],
      sandbox,
    )).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        `${packagedPath} must be a regular non-symlink file`,
      ),
    });
    expect(statSync(externalTarget).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(destination, "zentra-0.1.0.tgz"))).toBe(false);
  }, 30_000);

  it("rejects a symlinked packaged ancestor without modifying its external target", async () => {
    const sandbox = packageSandbox();
    const externalFixtures = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-external-fixtures-")));
    temporaryDirectories.push(externalFixtures);
    const externalTarget = path.join(externalFixtures, "deterministic-worker.mjs");
    writeFileSync(externalTarget, "external target\n", "utf8");
    chmodSync(externalTarget, 0o600);
    rmSync(path.join(sandbox, "fixtures"), { recursive: true });
    symlinkSync(externalFixtures, path.join(sandbox, "fixtures"));
    const destination = path.join(sandbox, "artifacts");
    mkdirSync(destination);

    await expect(runNpm(
      ["pack", "--silent", "--json", "--pack-destination", destination],
      sandbox,
    )).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "packaged path fixtures/deterministic-worker.mjs has symbolic-link component fixtures",
      ),
    });
    expect(statSync(externalTarget).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(destination, "zentra-0.1.0.tgz"))).toBe(false);
  }, 30_000);

  it("does not resolve package verification tools from ambient PATH", async () => {
    const fakeBin = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-package-fake-bin-")));
    temporaryDirectories.push(fakeBin);
    const marker = path.join(fakeBin, "invoked");
    for (const executable of ["npm", "tar"]) {
      const fakeExecutable = path.join(fakeBin, executable);
      writeFileSync(fakeExecutable, `#!/bin/sh\ntouch '${marker}'\nexit 97\n`, "utf8");
      chmodSync(fakeExecutable, 0o755);
    }

    await execFileAsync(nodeExecutable, [
      path.join(repositoryRoot, "scripts", "verify-package-contents.mjs"),
    ], {
      cwd: repositoryRoot,
      env: { ...subprocessEnvironment, PATH: `${fakeBin}${path.delimiter}${subprocessEnvironment.PATH}` },
      maxBuffer: 10 * 1_024 * 1_024,
      timeout: 120_000,
    });
    expect(existsSync(marker)).toBe(false);
  }, 130_000);

  it("does not pass ambient npm configuration into package verification", async () => {
    const result = await execFileAsync(nodeExecutable, [
      path.join(repositoryRoot, "scripts", "verify-package-contents.mjs"),
    ], {
      cwd: repositoryRoot,
      env: { ...subprocessEnvironment, npm_config_ignore_scripts: "true" },
      maxBuffer: 10 * 1_024 * 1_024,
      timeout: 120_000,
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("deterministic package files");
  }, 130_000);

  it("rejects a symlinked top-level source file before reading external content", async () => {
    const sandbox = packageSandbox();
    const externalRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-external-package-file-")));
    temporaryDirectories.push(externalRoot);
    const externalPackageJson = path.join(externalRoot, "package.json");
    writeFileSync(externalPackageJson, "external content must not be parsed\n", "utf8");
    rmSync(path.join(sandbox, "package.json"));
    symlinkSync(externalPackageJson, path.join(sandbox, "package.json"));

    await expect(run(
      nodeExecutable,
      [path.join(sandbox, "scripts", "verify-package-contents.mjs")],
      sandbox,
    )).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "packaged path package.json must be a regular non-symlink file",
      ),
    });
  }, 30_000);

  it("rejects a symlinked source ancestor before reading external content", async () => {
    const sandbox = packageSandbox();
    const externalSource = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-external-source-")));
    temporaryDirectories.push(externalSource);
    writeFileSync(path.join(externalSource, "invalid.ts"), "external content must not be compiled\n", "utf8");
    rmSync(path.join(sandbox, "src"), { recursive: true });
    symlinkSync(externalSource, path.join(sandbox, "src"));

    const verification = run(
      nodeExecutable,
      [path.join(sandbox, "scripts", "verify-package-contents.mjs")],
      sandbox,
    );
    await expect(verification).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "packaged path src has symbolic-link component src",
      ),
    });
    await expect(verification).rejects.toMatchObject({
      stderr: expect.not.stringContaining("npm-cli.js"),
    });
  }, 30_000);

  it("terminates package build subprocesses after their configured timeout", async () => {
    const helper = pathToFileURL(path.join(repositoryRoot, "scripts", "run-command.mjs")).href;
    const program = [
      `import { runCommand } from ${JSON.stringify(helper)};`,
      `runCommand(${JSON.stringify(nodeExecutable)}, ['-e', 'setInterval(() => {}, 1_000)'], {`,
      `  cwd: ${JSON.stringify(repositoryRoot)},`,
      "  environment: {},",
      "  maxBuffer: 1_024,",
      "  timeoutMs: 20,",
      "});",
    ].join("\n");

    await expect(run(
      nodeExecutable,
      ["--input-type=module", "--eval", program],
      repositoryRoot,
    )).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("timed out after 20ms"),
    });
  }, 30_000);

  it("confirms same-process-group package-verifier descendants exit before reporting a timeout", async () => {
    const pidFile = path.join(packageSandbox(), "timed-out-descendant.pid");
    const descendantProgram = "setInterval(() => {}, 1_000)";
    const parentProgram = [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const descendant = spawn(process.execPath, ["--eval", ${JSON.stringify(descendantProgram)}], { stdio: "ignore" });`,
      'if (descendant.pid === undefined) throw new Error("descendant pid unavailable");',
      `writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid), "utf8");`,
      "descendant.unref();",
      "setInterval(() => {}, 1_000);",
    ].join("\n");
    const verifierUrl = pathToFileURL(
      path.join(repositoryRoot, "scripts", "verify-package-contents.mjs"),
    ).href;
    const verifier = await import(verifierUrl) as {
      run(
        executable: string,
        args: readonly string[],
        cwd: string,
        options: { readonly environment: NodeJS.ProcessEnv; readonly timeoutMs: number },
      ): Promise<unknown>;
    };
    let descendantPid: number | undefined;

    try {
      await expect(verifier.run(
        nodeExecutable,
        ["--input-type=module", "--eval", parentProgram],
        repositoryRoot,
        { environment: subprocessEnvironment, timeoutMs: 1_000 },
      )).rejects.toThrow("timed out after 1000ms");
      descendantPid = Number(readFileSync(pidFile, "utf8"));

      expect(descendantPid).toBeGreaterThan(0);
      expect(() => process.kill(descendantPid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      if (descendantPid !== undefined) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
  }, 30_000);

  it("terminates package build subprocesses that exceed their output limit", async () => {
    const helper = pathToFileURL(path.join(repositoryRoot, "scripts", "run-command.mjs")).href;
    const noisyProgram = "process.stdout.write('x'.repeat(4_096))";
    const program = [
      `import { runCommand } from ${JSON.stringify(helper)};`,
      `runCommand(${JSON.stringify(nodeExecutable)}, ['-e', ${JSON.stringify(noisyProgram)}], {`,
      `  cwd: ${JSON.stringify(repositoryRoot)},`,
      "  environment: {},",
      "  maxBuffer: 128,",
      "  timeoutMs: 1_000,",
      "});",
    ].join("\n");

    await expect(run(
      nodeExecutable,
      ["--input-type=module", "--eval", program],
      repositoryRoot,
    )).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("exceeded the 128-byte output limit"),
    });
  }, 30_000);

  it("rejects a symlinked production-output ancestor during package verification", async () => {
    const sandbox = packageSandbox();
    await runNpm(["run", "build"], sandbox);
    const externalRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-external-cli-")));
    temporaryDirectories.push(externalRoot);
    const externalCli = path.join(externalRoot, "cli");
    const cliDirectory = path.join(sandbox, "dist", "src", "cli");
    cpSync(cliDirectory, externalCli, { recursive: true });
    rmSync(cliDirectory, { recursive: true });
    symlinkSync(externalCli, cliDirectory);

    await expect(runNpm(["run", "package:verify"], sandbox)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "packaged path dist/src/cli/main.js has symbolic-link component dist/src/cli",
      ),
    });
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
    await runNpm(["run", "build"], sandbox);
    invalidate(sandbox);

    await expect(runNpm(["run", "package:verify"], sandbox)).rejects.toMatchObject({
      code: 1,
    });
  }, 30_000);
});
