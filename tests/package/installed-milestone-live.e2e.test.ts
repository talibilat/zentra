import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = realpathSync.native(path.resolve(import.meta.dirname, "../.."));
const nodeExecutable = realpathSync.native(process.execPath);
const npmExecutable = realpathSync.native(path.join(path.dirname(nodeExecutable), "npm"));
const gitExecutable = realpathSync.native("/usr/bin/git");
const dockerExecutable = "/Applications/Docker.app/Contents/Resources/bin/docker";
const liveEnvironmentNames = [
  "ZENTRA_LIVE_AZURE_OPENAI_API_KEY",
  "ZENTRA_LIVE_AZURE_OPENAI_ENDPOINT",
  "ZENTRA_LIVE_AZURE_OPENAI_DEPLOYMENT",
  "ZENTRA_LIVE_AZURE_OPENAI_API_VERSION",
  "ZENTRA_LIVE_AZURE_OPENAI_EXPECTED_PROVIDER_MODELS",
  "ZENTRA_LIVE_AZURE_OPENAI_INPUT_TOKEN_RATE_USD_PER_MILLION",
  "ZENTRA_LIVE_AZURE_OPENAI_OUTPUT_TOKEN_RATE_USD_PER_MILLION",
  "ZENTRA_LIVE_OPENCODE_EXECUTABLE",
  "ZENTRA_LIVE_OPENCODE_HOME",
  "ZENTRA_LIVE_OPENCODE_SHA256",
  "ZENTRA_LIVE_OPENCODE_VERSION",
  "ZENTRA_LIVE_IMPLEMENTER_MODEL",
] as const;
const liveGateEnabled = process.env.ZENTRA_LIVE_OPENCODE_E2E === "1";
const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!liveGateEnabled)(
  `installed milestone live conformance${liveGateEnabled ? "" : " skipped: set ZENTRA_LIVE_OPENCODE_E2E=1 to run"}`,
  () => {
    it("packs and installs the real CLI, completes an authenticated milestone, and leaves no capsule resources", async () => {
      expect(process.platform).toBe("darwin");
      expect(process.arch).toBe("arm64");
      const live = await liveConfiguration();
      const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-installed-live-")));
      roots.push(root);
      const home = path.join(root, "consumer-home");
      const artifacts = path.join(root, "artifacts");
      const consumer = path.join(root, "consumer");
      mkdirSync(home);
      mkdirSync(artifacts);
      mkdirSync(consumer);
      writeFileSync(path.join(consumer, "package.json"), "{\"private\":true,\"type\":\"module\"}\n", "utf8");
      const baseEnvironment = commandEnvironment(home);

      const packed = await run(nodeExecutable, [
        npmExecutable,
        "pack",
        "--silent",
        "--json",
        "--pack-destination",
        artifacts,
      ], repositoryRoot, baseEnvironment, 180_000);
      const packResults = JSON.parse(packed.stdout) as readonly { readonly filename: string }[];
      if (packResults.length !== 1 || packResults[0]?.filename === undefined) {
        throw new Error("live conformance did not produce exactly one package tarball");
      }
      const tarball = path.join(artifacts, packResults[0].filename);
      const installed = await run(nodeExecutable, [
        npmExecutable,
        "install",
        "--no-audit",
        "--no-fund",
        tarball,
      ], consumer, baseEnvironment, 180_000);
      const binary = path.join(consumer, "node_modules", ".bin", "zentra");
      if (!statSync(binary).isFile() || (statSync(binary).mode & 0o111) === 0) {
        throw new Error("installed Zentra binary is not executable");
      }

      const project = path.join(root, "project");
      const worktrees = path.join(root, "worktrees");
      const database = path.join(root, "journal.sqlite");
      const trace = path.join(root, "trace.jsonl");
      const config = path.join(root, "zentra.project.json");
      const modelSheet = path.join(root, "MODELS.md");
      const securitySheet = path.join(root, "SECURITY-SHEET.md");
      const provider = path.join(root, "azure.json");
      const ownedFile = "src/greeting.mjs";
      await git(root, ["init", "-b", "main", project], baseEnvironment);
      await git(project, ["config", "user.name", "Zentra Live Test"], baseEnvironment);
      await git(project, ["config", "user.email", "live-test@zentra.local"], baseEnvironment);
      mkdirSync(path.join(project, "src"));
      mkdirSync(path.join(project, "test"));
      writeFileSync(path.join(project, ownedFile), "export const greeting = 'hello';\n", "utf8");
      writeFileSync(
        path.join(project, "test", "greeting.test.mjs"),
        "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { greeting } from '../src/greeting.mjs';\ntest('live greeting', () => assert.equal(greeting, 'hello from live milestone'));\n",
        "utf8",
      );
      await git(project, ["add", "--", "."], baseEnvironment);
      await git(project, ["commit", "-m", "initial live fixture"], baseEnvironment);
      const mainOid = (await git(project, ["rev-parse", "main"], baseEnvironment)).stdout.trim();

      writeFileSync(config, `${JSON.stringify({
        projectId: "installed-live-project",
        repositoryPath: realpathSync.native(project),
        integrationBranch: "zentra/integration",
        worktreeRoot: worktrees,
        validations: {
          focused: [nodeExecutable, "--test", "test/greeting.test.mjs"],
          full: [nodeExecutable, "--test"],
        },
      }, null, 2)}\n`, "utf8");
      writeFileSync(modelSheet, `# Models

## Models
| id | harness | model | roles | specialties | cost | context | concurrency | tools | network | fallback | quality |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| live-planner | opencode | ${live.azureDeployment} | planner | planning | low | 128000 | 1 | read_repository | denied | none | 1/1 |
| live-researcher | opencode | ${live.azureDeployment} | researcher | research | low | 128000 | 1 | read_repository | denied | none | 1/1 |
| live-implementer | opencode | ${live.implementerModel} | implementer | coding | low | 128000 | 1 | read_repository,write_worktree | denied | none | 1/1 |
| live-reviewer | opencode | ${live.azureDeployment} | reviewer | review | low | 128000 | 1 | read_repository,review_diff | denied | none | 1/1 |
`, "utf8");
      writeFileSync(securitySheet, `# Zentra Security Sheet

## Allowed Repositories
- ${realpathSync.native(project)}

## Allowed File Scopes
- ${ownedFile}

## Forbidden Paths
- .env
- .git/**

## Network
Default: denied

## Secret Handling
- Do not retain or expose credentials.

## Approval Required Operations
- external_effect

## Release Boundary
local_preparation_only

## Stop And Ask Conditions
- missing_authority
- forbidden_file_scope
`, "utf8");
      writeFileSync(
        provider,
        `${JSON.stringify({
          provider: "azure",
          endpoint: live.azureEndpoint,
          deployment: live.azureDeployment,
          apiVersion: live.azureApiVersion,
          credentialEnv: "ZENTRA_LIVE_AZURE_OPENAI_API_KEY",
          timeoutMs: 120000,
          maxResponseBytes: 4 * 1024 * 1024,
          maxInputTokens: 128000,
          maxOutputTokens: 16000,
          maxToolCalls: 4,
          expectedProviderModels: live.azureExpectedProviderModels,
          inputTokenRateUsdPerMillion: live.inputTokenRateUsdPerMillion,
          outputTokenRateUsdPerMillion: live.outputTokenRateUsdPerMillion,
        })}\n`,
        "utf8",
      );

      await attestOpenCodeIdentity(live);
      const execution = await runStreaming(binary, [
        "milestone",
        "run",
        "--goal",
        `Change only ${ownedFile} so it exports greeting as 'hello from live milestone'. Do not change any other file.`,
        "--config",
        config,
        "--database",
        database,
        "--model-sheet",
        modelSheet,
        "--security-sheet",
        securitySheet,
        "--provider",
        provider,
        "--opencode",
        live.openCodeExecutable,
        "--opencode-home",
        live.openCodeHome,
        "--opencode-sha256",
        live.expectedSha256,
        "--opencode-version",
        live.expectedVersion,
        "--agent-tail-jsonl",
        trace,
        "--file",
        ownedFile,
      ], consumer, {
        ...baseEnvironment,
        ZENTRA_LIVE_AZURE_OPENAI_API_KEY: live.azureApiKey,
      }, database);
      if (execution.code !== 0) {
        throw new Error(`authenticated installed milestone exited ${execution.code} without completing`);
      }
      const traceBytes = readFileSync(trace);
      const packageOutput = Buffer.from(
        `${packed.stdout}${packed.stderr}${installed.stdout}${installed.stderr}`,
        "utf8",
      );
      const executionOutput = Buffer.concat([execution.stdout, execution.stderr]);
      for (const bytes of [packageOutput, executionOutput, traceBytes, ...sqliteFiles(database)]) {
        assertBytesAbsent(bytes, live.azureApiKey, "credential appeared in retained acceptance evidence");
        assertBytesAbsent(bytes, repositoryRoot, "source checkout path appeared in retained acceptance evidence");
      }
      expect(execution.observedNonterminalJournalState).toBe(true);
      expect(execution.stdout.equals(traceBytes)).toBe(true);
      const envelopes = parseJsonLines(execution.stdout);
      expect(envelopes.length).toBeGreaterThan(0);
      expect(new Set(envelopes.map((event) => event.event_id)).size).toBe(envelopes.length);
      expect(envelopes.every((event) => event.schema_version === "1.0")).toBe(true);
      expect(envelopes.every((event) => event.trace_id === envelopes[0]!.trace_id)).toBe(true);
      for (let index = 1; index < envelopes.length; index += 1) {
        expect(envelopes[index]!.sequence).toBeGreaterThan(envelopes[index - 1]!.sequence);
      }
      expect(envelopes.at(-1)).toMatchObject({
        kind: "milestone.completed",
        operation: { status: "completed" },
      });
      const azureCompletions = envelopes.filter((event) => event.kind === "milestone.task_completed")
        .map((event) => event.payload as any).filter((payload) => payload.model?.provider === "azure");
      expect(azureCompletions).toHaveLength(2);
      expect(azureCompletions.every((payload) => /^[a-f0-9]{64}$/.test(payload.model.configurationDigest) &&
        payload.evidence.every((item: any) => item.provenance.providerConfigurationDigest === payload.model.configurationDigest)))
        .toBe(true);
      const measuredModelCosts = envelopes.filter((event) => event.kind === "worker.observed")
        .map((event) => (event.payload as any).observation).filter((observation) => observation?.kind === "model" && observation.phase === "completed")
        .map((observation) => observation.usage);
      expect(measuredModelCosts.length).toBeGreaterThan(0);
      expect(measuredModelCosts.every((usage) => Number.isSafeInteger(usage.costUsdNano) &&
        usage.costUsdNano >= 0 && usage.costUsd === usage.costUsdNano / 1_000_000_000)).toBe(true);
      const terminal = parseSingleJson(execution.stderr) as {
        readonly command: string;
        readonly milestoneId: string;
        readonly lifecycle: string;
        readonly outcome: string;
        readonly tracePath: string;
        readonly trace: { readonly outcome: string };
      };
      expect(terminal).toMatchObject({
        command: "milestone.run",
        lifecycle: "terminal",
        outcome: "completed",
        tracePath: trace,
        trace: { outcome: "emitted" },
      });

      const status = await run(binary, [
        "milestone",
        "status",
        "--database",
        database,
        "--milestone-id",
        terminal.milestoneId,
      ], consumer, baseEnvironment, 30_000);
      expect(parseSingleJson(Buffer.from(status.stdout, "utf8"))).toMatchObject({
        command: "milestone.status",
        milestone: {
          milestoneId: terminal.milestoneId,
          lifecycle: "terminal",
          terminalOutcome: "completed",
          result: { outcome: "completed", trace: { path: trace, outcome: "emitted" } },
        },
      });
      expect((await git(project, ["rev-parse", "main"], baseEnvironment)).stdout.trim()).toBe(mainOid);
      expect((await git(project, ["diff", "--name-only", "main..zentra/integration"], baseEnvironment)).stdout)
        .toBe(`${ownedFile}\n`);
      expect((await git(project, ["show", `zentra/integration:${ownedFile}`], baseEnvironment)).stdout)
        .toBe("export const greeting = 'hello from live milestone';\n");
      expect((await git(project, ["show", `main:${ownedFile}`], baseEnvironment)).stdout)
        .toBe("export const greeting = 'hello';\n");
      const remainingWorktreeEntries = existsSync(worktrees) ? readdirSync(worktrees) : [];
      expect(remainingWorktreeEntries).toEqual([]);
      const registeredWorktrees = (await git(project, ["worktree", "list", "--porcelain"], baseEnvironment)).stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length));
      expect(registeredWorktrees).toEqual([realpathSync.native(project)]);
      expect(registeredWorktrees.some((candidate) =>
        candidate.includes("ticket/") || candidate.includes(".zentra-integration-") ||
        candidate.includes("release-") || candidate.startsWith(worktrees))).toBe(false);
      expect((await git(project, ["branch", "--list", "ticket/*"], baseEnvironment)).stdout.trim()).toBe("");

      const retainedOutput = Buffer.concat([
        packageOutput,
        execution.stdout,
        execution.stderr,
        Buffer.from(status.stdout, "utf8"),
        Buffer.from(status.stderr, "utf8"),
      ]);
      for (const bytes of [retainedOutput, traceBytes, ...sqliteFiles(database)]) {
        assertBytesAbsent(bytes, live.azureApiKey, "credential appeared in retained acceptance evidence");
        assertBytesAbsent(bytes, repositoryRoot, "source checkout path appeared in retained evidence");
      }

      const intents = envelopes.filter((event) => event.kind === "milestone.agent_resource_intent");
      const cleanups = envelopes.filter((event) => event.kind === "milestone.agent_cleanup_observed");
      expect(intents.length).toBeGreaterThan(0);
      expect(cleanups).toHaveLength(intents.length);
      for (const intent of intents) {
        const payload = intent.payload as {
          readonly capsuleId: string;
          readonly resourceLabel: string;
          readonly repositoryViewPath: string;
        };
        const cleanup = cleanups.find((event) =>
          (event.payload as { readonly capsuleId?: string }).capsuleId === payload.capsuleId);
        expect(cleanup?.payload).toMatchObject({
          outcome: "completed",
          containerAbsent: true,
          imageAbsent: true,
          repositoryViewAbsent: true,
        });
        expect(existsSync(payload.repositoryViewPath)).toBe(false);
        const containers = await run(dockerExecutable, [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=${payload.resourceLabel}`,
        ], consumer, baseEnvironment, 30_000);
        const images = await run(dockerExecutable, [
          "image",
          "ls",
          "--quiet",
          "--filter",
          `label=${payload.resourceLabel}`,
        ], consumer, baseEnvironment, 30_000);
        expect(containers.stdout.trim()).toBe("");
        expect(images.stdout.trim()).toBe("");
      }
    }, 15 * 60_000);
  },
);

interface AgentTailEnvelope {
  readonly schema_version: string;
  readonly event_id: string;
  readonly trace_id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly operation: { readonly status: string };
  readonly payload: unknown;
}

async function liveConfiguration() {
  const missing = liveEnvironmentNames.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`live conformance prerequisites are incomplete: missing ${missing.join(", ")}`);
  }
  const azureApiKey = requiredEnvironment("ZENTRA_LIVE_AZURE_OPENAI_API_KEY", 4_096);
  if (/\s|[\u0000-\u001f\u007f]/.test(azureApiKey)) {
    throw new Error("ZENTRA_LIVE_AZURE_OPENAI_API_KEY must be one bounded credential value");
  }
  const requestedExecutable = requiredEnvironment("ZENTRA_LIVE_OPENCODE_EXECUTABLE", 4_096);
  const requestedHome = requiredEnvironment("ZENTRA_LIVE_OPENCODE_HOME", 4_096);
  let openCodeExecutable: string;
  let openCodeHome: string;
  try {
    openCodeExecutable = realpathSync.native(requestedExecutable);
    openCodeHome = realpathSync.native(requestedHome);
  } catch {
    throw new Error("live OpenCode executable and home prerequisites must exist");
  }
  if (requestedExecutable !== openCodeExecutable || !statSync(openCodeExecutable).isFile() ||
    (statSync(openCodeExecutable).mode & 0o111) === 0) {
    throw new Error("ZENTRA_LIVE_OPENCODE_EXECUTABLE must be a canonical executable file");
  }
  if (statSync(openCodeExecutable).size > 512 * 1_048_576) {
    throw new Error("ZENTRA_LIVE_OPENCODE_EXECUTABLE exceeds the attestation size bound");
  }
  if (requestedHome !== openCodeHome || !statSync(openCodeHome).isDirectory()) {
    throw new Error("ZENTRA_LIVE_OPENCODE_HOME must be a canonical dedicated directory");
  }
  let canonicalDocker: string;
  try {
    canonicalDocker = realpathSync.native("/usr/local/bin/docker");
  } catch {
    throw new Error("the approved Docker Desktop executable is unavailable");
  }
  if (canonicalDocker !== dockerExecutable) {
    throw new Error("the approved Docker Desktop executable is unavailable");
  }
  const expectedSha256 = requiredEnvironment("ZENTRA_LIVE_OPENCODE_SHA256", 64);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("ZENTRA_LIVE_OPENCODE_SHA256 must be one lowercase SHA-256 digest");
  }
  const expectedVersion = requiredEnvironment("ZENTRA_LIVE_OPENCODE_VERSION", 512);
  if (/[\r\n\u0000]/.test(expectedVersion)) {
    throw new Error("ZENTRA_LIVE_OPENCODE_VERSION must be one bounded exact version line");
  }
  const azureEndpoint = requiredEnvironment("ZENTRA_LIVE_AZURE_OPENAI_ENDPOINT", 512);
  const azureDeployment = requiredModel("ZENTRA_LIVE_AZURE_OPENAI_DEPLOYMENT");
  const azureApiVersion = requiredEnvironment("ZENTRA_LIVE_AZURE_OPENAI_API_VERSION", 32);
  const azureExpectedProviderModels = requiredEnvironment("ZENTRA_LIVE_AZURE_OPENAI_EXPECTED_PROVIDER_MODELS", 1024).split(",");
  if (azureExpectedProviderModels.length === 0 || azureExpectedProviderModels.some((model, index) =>
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254}[A-Za-z0-9])?$/.test(model) || (index > 0 && azureExpectedProviderModels[index - 1]! >= model))) {
    throw new Error("ZENTRA_LIVE_AZURE_OPENAI_EXPECTED_PROVIDER_MODELS must be a sorted comma-separated model allowlist");
  }
  const inputTokenRateUsdPerMillion = requiredRate("ZENTRA_LIVE_AZURE_OPENAI_INPUT_TOKEN_RATE_USD_PER_MILLION");
  const outputTokenRateUsdPerMillion = requiredRate("ZENTRA_LIVE_AZURE_OPENAI_OUTPUT_TOKEN_RATE_USD_PER_MILLION");
  const implementerModel = requiredModel("ZENTRA_LIVE_IMPLEMENTER_MODEL");
  await attestOpenCodeIdentity({ openCodeExecutable, openCodeHome, expectedSha256, expectedVersion });
  return {
    azureApiKey,
    azureEndpoint,
    azureDeployment,
    azureApiVersion,
    azureExpectedProviderModels,
    inputTokenRateUsdPerMillion,
    outputTokenRateUsdPerMillion,
    openCodeExecutable,
    openCodeHome,
    expectedSha256,
    expectedVersion,
    implementerModel,
  };
}

function requiredRate(name: string): string {
  const encoded = requiredEnvironment(name, 32);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(encoded)) throw new Error(`${name} must be a bounded decimal rate`);
  const rate = Number(encoded);
  if (!Number.isFinite(rate) || rate > 1_000_000) throw new Error(`${name} must be a bounded decimal rate`);
  return encoded;
}

async function attestOpenCodeIdentity(input: {
  readonly openCodeExecutable: string;
  readonly openCodeHome: string;
  readonly expectedSha256: string;
  readonly expectedVersion: string;
}): Promise<void> {
  let measuredSha256: string;
  try {
    measuredSha256 = await sha256File(input.openCodeExecutable);
  } catch {
    throw new Error("live OpenCode executable digest measurement failed");
  }
  if (measuredSha256 !== input.expectedSha256) {
    throw new Error("live OpenCode operator-attested executable SHA-256 mismatch");
  }
  let version: { readonly stdout: string; readonly stderr: string };
  try {
    version = await execFileAsync(input.openCodeExecutable, ["--version"], {
      cwd: input.openCodeHome,
      env: {
        PATH: [path.dirname(nodeExecutable), "/usr/bin", "/bin"].join(path.delimiter),
        HOME: input.openCodeHome,
        TMPDIR: tmpdir(),
        LANG: "C",
        LC_ALL: "C",
      },
      timeout: 30_000,
      maxBuffer: 64 * 1_024,
    });
  } catch {
    throw new Error("live OpenCode operator-attested version probe failed");
  }
  const measuredVersion = version.stdout.endsWith("\r\n")
    ? version.stdout.slice(0, -2)
    : version.stdout.endsWith("\n")
      ? version.stdout.slice(0, -1)
      : version.stdout;
  if (version.stderr !== "" || /[\r\n]/.test(measuredVersion) || measuredVersion !== input.expectedVersion) {
    throw new Error("live OpenCode operator-attested exact version mismatch");
  }
}

function requiredEnvironment(name: string, maxBytes: number): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${name} must be a nonempty bounded live conformance prerequisite`);
  }
  return value;
}

function requiredModel(name: string): string {
  const value = requiredEnvironment(name, 512);
  if (/[\s|]/.test(value)) throw new Error(`${name} must be one Markdown-table-safe model identity`);
  return value;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function commandEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: [path.dirname(nodeExecutable), "/usr/bin", "/bin"].join(path.delimiter),
    HOME: home,
    TMPDIR: tmpdir(),
    LANG: "C",
    LC_ALL: "C",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

async function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
) {
  if (!path.isAbsolute(executable)) throw new Error("test subprocess executable must be absolute");
  return execFileAsync(executable, [...args], { cwd, env, timeout, maxBuffer: 16 * 1_048_576 });
}

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return run(gitExecutable, args, cwd, env, 30_000);
}

function runStreaming(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  databasePath: string,
): Promise<{
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly observedNonterminalJournalState: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let pending = "";
    let observedNonterminalJournalState = false;
    let observationFailed = false;
    const terminalKinds = new Set([
      "milestone.completed",
      "milestone.cancelled",
      "milestone.denied",
      "milestone.timed_out",
      "milestone.failed",
    ]);
    const deadline = setTimeout(() => child.kill("SIGTERM"), 14 * 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        try {
          const event = JSON.parse(line) as Partial<AgentTailEnvelope>;
          if (!observedNonterminalJournalState && event.schema_version === "1.0" &&
            typeof event.event_id === "string" && typeof event.trace_id === "string" &&
            typeof event.sequence === "number" && typeof event.kind === "string" &&
            !terminalKinds.has(event.kind)) {
            const database = new Database(databasePath, { readonly: true, fileMustExist: true });
            try {
              const rows = database.prepare(
                "SELECT event_id, type FROM events WHERE stream_id = ? ORDER BY stream_version ASC LIMIT 1000",
              ).all(event.trace_id) as readonly { readonly event_id: string; readonly type: string }[];
              if (!rows.some((row) => row.event_id === event.event_id) ||
                rows.some((row) => terminalKinds.has(row.type))) {
                throw new Error("live JSONL did not correspond to a concurrently nonterminal milestone snapshot");
              }
              observedNonterminalJournalState = true;
            } finally {
              database.close();
            }
          }
        } catch {
          observationFailed = true;
          child.kill("SIGTERM");
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (observationFailed) {
        reject(new Error("live nonterminal JSONL and SQLite observation failed"));
        return;
      }
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        observedNonterminalJournalState,
      });
    });
  });
}

function parseJsonLines(bytes: Buffer): readonly AgentTailEnvelope[] {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("live stdout JSONL ended with an incomplete line");
  return text.slice(0, -1).split("\n").map((line) => JSON.parse(line) as AgentTailEnvelope);
}

function parseSingleJson(bytes: Buffer): unknown {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw new Error("expected exactly one newline-terminated JSON result");
  }
  return JSON.parse(text);
}

function assertBytesAbsent(bytes: Buffer, forbidden: string, message: string): void {
  if (bytes.includes(Buffer.from(forbidden, "utf8"))) throw new Error(message);
}

function sqliteFiles(database: string): readonly Buffer[] {
  return [database, `${database}-wal`, `${database}-shm`]
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => readFileSync(candidate));
}
