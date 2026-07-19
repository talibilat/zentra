import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

async function runNonzero(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  try {
    await run(executable, args, cwd, env);
    throw new Error("expected command to fail");
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") throw error;
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
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
Allowed Destinations:
- https://www.iana.org

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
    const programmaticScript = path.join(consumer, "programmatic-safe-composition.mjs");
    const programmaticDatabase = path.join(consumer, "programmatic.sqlite");
    const programmaticTrace = path.join(consumer, "programmatic.jsonl");
    writeFileSync(programmaticScript, [
      'import { AgentTailJsonlFileSink, DisabledModelBroker, MilestoneRegistry, OpenCodeReadOnlyProgram, SqliteEventJournal, loadSecuritySheet } from "zentra";',
      'import { realpathSync } from "node:fs";',
      `const repository = ${JSON.stringify(project.repository)};`,
      `const databasePath = ${JSON.stringify(programmaticDatabase)};`,
      `const tracePath = ${JSON.stringify(programmaticTrace)};`,
      `const securitySheetPath = ${JSON.stringify(project.securitySheet)};`,
      "const journal = new SqliteEventJournal(databasePath);",
      "const sink = AgentTailJsonlFileSink.open(realpathSync(new URL('.', import.meta.url)), tracePath, 'package-trace');",
      "const security = loadSecuritySheet(securitySheetPath);",
      "const models = { models: [{ id: 'package-researcher', harness: 'opencode', model: 'fixture/model', roles: ['researcher'], specialties: [], costTier: 'low', contextTokens: 1000, maxConcurrency: 1, toolPermissions: ['read_repository'], network: 'denied', fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } }] };",
      "new MilestoneRegistry(journal).register({ milestoneId: 'package-milestone', projectId: 'package-project', title: 'Safe composition', correlationId: 'package-trace', plan: { milestoneId: 'package-milestone', projectId: 'package-project', goal: 'Pause before effects', tasks: [{ taskId: 'package-research', title: 'Research', description: 'Research safely.', dependencies: [], ownedPaths: ['greeting.txt'], forbiddenPaths: ['.env'], acceptanceCriteria: ['No effect runs without approval.'], roleAssignment: { role: 'researcher', agentId: 'package-researcher', harness: 'opencode' }, risk: { level: 'low', authority: 'read_only', requiresReview: false, requiresApproval: true }, budget: { maxSeconds: 5, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 } }] } });",
      "const program = new OpenCodeReadOnlyProgram(journal, sink, new DisabledModelBroker(), models, security);",
      "const result = await program.run({ milestoneId: 'package-milestone', taskId: 'package-research', repositoryPath: repository, role: 'researcher', rolePrompt: 'Research.', budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 }, timeoutMs: 1000, signal: new AbortController().signal });",
      "sink.close();",
      "journal.close();",
      "process.stdout.write(JSON.stringify({ status: result.status, reason: result.status === 'paused' ? result.attention.reason : null }));",
    ].join("\n"), "utf8");
    const programmatic = await run(nodeExecutable, [programmaticScript], consumer);
    expect(programmatic.stderr).toBe("");
    expect(JSON.parse(programmatic.stdout)).toEqual({ status: "paused", reason: "missing_authority" });
    expect(existsSync(programmaticDatabase)).toBe(true);
    const programmaticLines = readFileSync(programmaticTrace, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { readonly trace_id: string; readonly kind: string });
    expect(programmaticLines).toEqual([
      expect.objectContaining({ trace_id: "package-trace", kind: "milestone.created" }),
      expect.objectContaining({ trace_id: "package-trace", kind: "milestone.plan_created" }),
    ]);

    const milestoneRoot = path.join(consumer, "installed-milestone");
    mkdirSync(milestoneRoot);
    const milestoneProject = await initializeProject(milestoneRoot);
    const milestoneModels = path.join(milestoneRoot, "MODELS.md");
    const milestoneProvider = path.join(milestoneRoot, "azure.json");
    const milestoneTrace = path.join(milestoneRoot, "milestone.jsonl");
    const milestoneOpenCode = path.join(milestoneRoot, "opencode");
    const milestoneOpenCodeHome = path.join(milestoneRoot, "opencode-home");
    const milestonePreload = path.join(milestoneRoot, "intercept-azure.mjs");
    const milestoneWriterObservation = path.join(milestoneRoot, "writer-observation.json");
    const milestoneNetworkObservation = path.join(milestoneRoot, "network-observation.json");
    mkdirSync(milestoneOpenCodeHome);
    writeFileSync(milestoneModels, `# Models

## Models
| id | harness | model | roles | specialties | cost | context | concurrency | tools | network | fallback | quality |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| planner | opencode | zentra-deployment | planner | planning | low | 128000 | 1 | read_repository | denied | none | 1/1 |
| researcher | opencode | zentra-deployment | researcher | research | low | 128000 | 1 | read_repository,web_research | declared | none | 1/1 |
| implementer | opencode | fixture/implementer | implementer | coding | low | 128000 | 1 | read_repository,write_worktree | denied | none | 1/1 |
| reviewer | opencode | zentra-deployment | reviewer | review | low | 128000 | 1 | read_repository,review_diff | denied | none | 1/1 |
`, "utf8");
    writeFileSync(milestoneProvider, JSON.stringify({
      provider: "azure", endpoint: "https://zentra-test.openai.azure.com", deployment: "zentra-deployment",
      apiVersion: "2025-04-01-preview", credentialEnv: "ZENTRA_TEST_AZURE_OPENAI_API_KEY", timeoutMs: 5000,
      maxResponseBytes: 1048576, maxInputTokens: 100000, maxOutputTokens: 10000, maxToolCalls: 4,
      expectedProviderModels: ["provider-model"],
      inputTokenRateUsdPerMillion: "1", outputTokenRateUsdPerMillion: "2",
    }) + "\n", "utf8");
    writeFileSync(milestoneOpenCode, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") { process.stdout.write("package-opencode 1\\n"); process.exit(0); }
const packet = JSON.parse(args[10]);
writeFileSync(${JSON.stringify(milestoneWriterObservation)}, JSON.stringify({ home: process.env.HOME, ambient: process.env.ZENTRA_AMBIENT_SECRET ?? null, brief: packet.brief }));
const target = path.join(args[9], packet.ownedPaths[0]);
writeFileSync(target, readFileSync(target, "utf8").replace("hello", "hello from package"));
process.stdout.write(JSON.stringify({ type: "step_finish" }) + "\\n");
`, { mode: 0o755 });
    writeFileSync(milestonePreload, [
      'import { createHash } from "node:crypto";',
      'import dns from "node:dns";',
      'import https from "node:https";',
      'import { registerHooks, syncBuiltinESMExports } from "node:module";',
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { fileURLToPath } from "node:url";',
      `const networkObservation=${JSON.stringify(milestoneNetworkObservation)};`,
      'let researchCalls=0;',
      'globalThis.__ZENTRA_PACKED_RESEARCH_TRANSPORT__={dispatch:async input=>{if(input.method!=="GET"||input.url.href!=="https://www.iana.org/help/example-domains")throw new Error("unexpected governed research request");researchCalls+=1;writeFileSync(networkObservation,JSON.stringify({researchCalls,method:input.method,url:input.url.href,realNetwork:false}));const body=Buffer.from("Controlled IANA documentation fixture.");return{status:200,headers:{"content-type":"text/plain"},body,compressedBytes:body.length,decompressedBytes:body.length,resolvedAddress:"192.0.43.8",tls:true,dispatched:true}}};',
      'dns.promises.lookup=async()=>{throw new Error("unexpected public DNS")};',
      'https.request=()=>{throw new Error("unexpected HTTPS socket")};',
      'syncBuiltinESMExports();',
      'registerHooks({ load(url, context, nextLoad) {',
      '  if(url.endsWith("/dist/src/agents/opencode-read-only-agent.js")){const source=readFileSync(fileURLToPath(url),"utf8");const transportTransformed=source.replace("new NodeHttpsResearchTransport()","globalThis.__ZENTRA_PACKED_RESEARCH_TRANSPORT__");const transformed=transportTransformed.replace("}, researchCapability));","}, researchCapability===undefined?undefined:{execute:(raw,policy,researchSignal)=>researchCapability.execute({...raw,trace:packet.trace},policy,researchSignal)}));");if(transportTransformed===source||transformed===transportTransformed)throw new Error("private research transport or trace interception did not apply");return{format:"module",shortCircuit:true,source:transformed}}',
      '  if (url.endsWith("/dist/src/providers/azure-openai-model-broker.js")) return { format: "module", shortCircuit: true, source: `import { createHash } from "node:crypto"; export const AzureOpenAIProviderConfigSchema={parse(value){if(value?.provider!=="azure")throw new Error("invalid provider");return value}}; export class AzureOpenAIModelBroker { static create(config,environment){if(!environment[config.credentialEnv])throw new Error("credential unavailable");return new AzureOpenAIModelBroker(config)} constructor(config){this.config=config} async execute(request,signal){if(signal.aborted)return{outcome:"cancelled",response:null,model:null,usage:null};if(process.env.ZENTRA_TEST_PROVIDER_FAILURE==="1")return{outcome:"failed",response:null,model:null,usage:null};let content="Use only the explicitly owned file.";if(request.prompt.includes("requiredResponse")){const challenge=JSON.parse(request.prompt);content=JSON.stringify({schemaVersion:1,reviewerId:challenge.request.reviewerId,decision:"approve",requestSha256:createHash("sha256").update(JSON.stringify(challenge.request),"utf8").digest("hex"),diffSha256:challenge.request.diffSha256,validationSha256:challenge.request.validationSha256,decidedAt:"2026-07-17T12:00:00.000Z",reason:"The installed package exact diff is approved."})}const configurationDigest=createHash("sha256").update(JSON.stringify(this.config),"utf8").digest("hex");return{outcome:"completed",response:{type:"text",text:content},model:{id:this.config.deployment,provider:"azure",name:"provider-model",configurationDigest},usage:{inputTokens:20,outputTokens:20,costUsd:0.00006,costUsdNano:60000}}} }` };',
      '  if (!url.endsWith("/dist/src/capsule/opencode-read-only-capsule.js")) return nextLoad(url, context);',
      '  return { format: "module", shortCircuit: true, source: `export class DockerOpenCodeReadOnlyCapsule { async execute(request, broker, signal, observe, research) { observe?.({ type: "resources_prepared", payload: { capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel, containerName: request.resources.containerName, containerId: "b".repeat(64), imageName: request.resources.imageName, imageId: "sha256:" + "c".repeat(64), repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision } }); const receipt = await broker.execute({ modelId: request.transportModelId, prompt: request.rolePrompt, maxInputTokens: request.budget.maxInputTokens, maxOutputTokens: request.budget.maxOutputTokens, maxCostUsd: request.budget.maxCostUsd }, signal); let source=null;if(request.role==="researcher"){const requestId="package-research";observe?.({type:"research_started",requestId});const result=await research.execute({schemaVersion:1,requestId,taskId:request.taskId,workerId:request.capsuleId,role:request.role,modelId:request.transportModelId,tool:"zentra_web_research",method:"GET",url:"https://www.iana.org/help/example-domains",envelopeDigest:request.webResearchEnvelopeDigest,policyDigest:request.webResearch.digest},request.webResearch,signal);observe?.({type:"research_completed",requestId,result});source=result.evidence} observe?.({ type: "cleanup_observed", payload: { capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel, containerName: request.resources.containerName, containerId: "b".repeat(64), imageName: request.resources.imageName, imageId: "sha256:" + "c".repeat(64), repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision, outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: false } }); const summary=receipt.response?.type === "text"?receipt.response.text+(source===null?"":" [source:"+source.evidenceId+"]"):null;return { outcome: receipt.outcome === "completed"&&summary!==null ? "completed" : "failed", openCode: { version: "1.18.3", executableSha256: "d".repeat(64) }, model: receipt.model, evidence: summary===null?[]:[{ kind: request.role === "reviewer" ? "review" : request.role === "researcher" ? "research" : "plan", summary, ...(source===null?{}:{sourceEvidenceIds:[source.evidenceId]}) }], cleanup: "completed", brokerTransport: receipt.outcome === "uncertain" ? "uncertain" : "completed" }; } } export function parseOpenCodeFinalAssistantText() { throw new Error("not used by external test capsule"); }` };',
      '} });',
    ].join("\n"), "utf8");
    const installedMilestone = await run(binary, [
      "milestone", "run", "--goal", "Update the package greeting",
      "--config", milestoneProject.config,
      "--database", milestoneProject.database,
      "--model-sheet", milestoneModels,
      "--security-sheet", milestoneProject.securitySheet,
      "--provider", milestoneProvider,
      "--opencode", realpathSync.native(milestoneOpenCode),
      "--opencode-home", realpathSync.native(milestoneOpenCodeHome),
      "--opencode-sha256", createHash("sha256").update(readFileSync(milestoneOpenCode)).digest("hex"),
      "--opencode-version", "package-opencode 1",
      "--agent-tail-jsonl", milestoneTrace,
      "--file", "greeting.txt",
    ], consumer, {
      ...subprocessEnvironment,
      NODE_OPTIONS: `--import=${pathToFileURL(milestonePreload).href}`,
      ZENTRA_TEST_AZURE_OPENAI_API_KEY: "package-provider-secret",
      ZENTRA_AMBIENT_SECRET: "must-not-reach-writer",
    });
    expect(installedMilestone.stdout).toContain('"kind":"milestone.created"');
    const installedTerminal = JSON.parse(installedMilestone.stderr) as any;
    expect(installedTerminal).toMatchObject({
      command: "milestone.run",
      projectId: "package-project",
      lifecycle: "terminal",
      outcome: "completed",
      tracePath: milestoneTrace,
      trace: { path: milestoneTrace, outcome: "emitted" },
    });
    expect(`${installedMilestone.stdout}${installedMilestone.stderr}`).not.toContain("package-provider-secret");
    expect(`${installedMilestone.stdout}${installedMilestone.stderr}`).not.toContain(repositoryRoot);
    expect(installedMilestone.stdout).toBe(readFileSync(milestoneTrace, "utf8"));
    expect(Buffer.concat([
      readFileSync(milestoneProject.database),
      readFileSync(milestoneTrace),
    ]).toString("utf8")).not.toContain("package-provider-secret");
    expect(JSON.parse(readFileSync(milestoneWriterObservation, "utf8"))).toEqual({
      home: milestoneOpenCodeHome,
      ambient: null,
      brief: expect.stringContaining("Update the package greeting"),
    });
    const installedTrace = readFileSync(milestoneTrace, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as any);
    const installedRootWorkers = installedTrace.filter((event) => event.kind === "worker.bound")
      .map((event) => event.payload).filter((payload) => payload.parentWorkerId === null);
    expect(installedRootWorkers).toHaveLength(4);
    expect(new Set(installedRootWorkers.map((payload) => payload.role)))
      .toEqual(new Set(["planner", "researcher", "implementer", "reviewer"]));
    expect(installedTrace.filter((event) => event.kind === "worker.bound")
      .every((event) => event.payload.parentWorkerId === null)).toBe(true);
    const installedSourceEvent = installedTrace.find((event) => event.kind === "web_research.observed");
    expect(installedSourceEvent).toMatchObject({
      operation: { status: "completed" }, payload: {
        identity: { role: "researcher", tool: "zentra_web_research" }, usage: { requests: 1 },
        evidence: { sourceHost: "www.iana.org", method: "GET", status: 200,
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          compressedBytes: Buffer.byteLength("Controlled IANA documentation fixture."),
          decompressedBytes: Buffer.byteLength("Controlled IANA documentation fixture.") },
      },
    });
    expect(installedSourceEvent.trace_id).toBe(installedTrace[0].trace_id);
    expect(installedSourceEvent.payload.identity.trace).toEqual({
      traceId: installedSourceEvent.trace_id,
      correlationId: installedSourceEvent.trace_id,
    });
    expect(JSON.parse(readFileSync(milestoneNetworkObservation, "utf8"))).toEqual({
      researchCalls: 1, method: "GET", url: "https://www.iana.org/help/example-domains", realNetwork: false,
    });
    expect(JSON.stringify(installedSourceEvent)).not.toContain("example-domains");
    const installedResearch = installedTrace.find((event) =>
      (event.kind === "milestone.task_completed" || event.kind === "milestone.agent_execution_completed") &&
      event.payload.role === "researcher");
    expect(installedResearch.payload.evidence[0]).toMatchObject({
      sourceEvidenceIds: [installedSourceEvent.payload.evidence.evidenceId],
      sourceEvidenceCount: 1,
    });
    expect(installedResearch.payload.evidence[0]).not.toHaveProperty("summary");
    expect(installedTrace.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "task.writer_completed", "task.validation_completed", "task.review_requested", "task.review_approved",
      "task.integration_started", "task.integration_prepared", "task.integration_observed", "task.cleanup_completed",
    ]));
    expect((await run(gitExecutable, ["show", "zentra/integration:greeting.txt"], milestoneProject.repository)).stdout)
      .toBe("hello from package\n");
    expect((await run(gitExecutable, ["show", "main:greeting.txt"], milestoneProject.repository)).stdout)
      .toBe("hello\n");
    expect((await run(gitExecutable, ["diff", "--name-only", "main..zentra/integration"], milestoneProject.repository)).stdout)
      .toBe("greeting.txt\n");
    expect((await run(gitExecutable, ["branch", "--list", "ticket/*"], milestoneProject.repository)).stdout.trim()).toBe("");
    expect(existsSync(path.join(milestoneRoot, "worktrees")) ? readdirSync(path.join(milestoneRoot, "worktrees")) : [])
      .toEqual([]);
    const installedStatus = await run(binary, [
      "milestone", "status", "--database", milestoneProject.database, "--milestone-id", installedTerminal.milestoneId,
    ], consumer);
    expect(JSON.parse(installedStatus.stdout)).toMatchObject({
      command: "milestone.status",
      milestone: { milestoneId: installedTerminal.milestoneId, lifecycle: "terminal", terminalOutcome: "completed" },
    });

    const legacyProvider = path.join(milestoneRoot, "unsupported-provider.json");
    const legacyDatabase = path.join(milestoneRoot, "legacy-provider.sqlite");
    const legacyTrace = path.join(milestoneRoot, "legacy-provider.jsonl");
    writeFileSync(legacyProvider, '{"provider":"unsupported","credentialEnv":"UNAVAILABLE_PROVIDER_KEY","timeoutMs":5000}\n', "utf8");
    const rejectedLegacy = await runNonzero(binary, [
      "milestone", "run", "--goal", "Reject legacy provider",
      "--config", milestoneProject.config, "--database", legacyDatabase,
      "--model-sheet", milestoneModels, "--security-sheet", milestoneProject.securitySheet,
      "--provider", legacyProvider, "--opencode", realpathSync.native(milestoneOpenCode),
      "--opencode-home", realpathSync.native(milestoneOpenCodeHome), "--agent-tail-jsonl", legacyTrace,
      "--opencode-sha256", createHash("sha256").update(readFileSync(milestoneOpenCode)).digest("hex"),
      "--opencode-version", "package-opencode 1",
      "--file", "greeting.txt",
    ], consumer, { ...subprocessEnvironment, NODE_OPTIONS: `--import=${pathToFileURL(milestonePreload).href}` });
    expect(rejectedLegacy.code).toBe(1);
    expect(JSON.parse(rejectedLegacy.stderr)).toMatchObject({ error: { code: "INVALID_PROVIDER_CONFIG" } });
    expect(existsSync(legacyDatabase)).toBe(false);
    expect(existsSync(legacyTrace)).toBe(false);

    const pauseModels = path.join(milestoneRoot, "PAUSE-MODELS.md");
    const pauseDatabase = path.join(milestoneRoot, "pause.sqlite");
    const pauseTrace = path.join(milestoneRoot, "pause.jsonl");
    writeFileSync(pauseModels, readFileSync(milestoneModels, "utf8").replace(
      "zentra-deployment | planner | planning | low | 128000",
      "zentra-deployment | planner | planning | low | 100",
    ), "utf8");
    const baseMilestoneArgs = [
      "--config", milestoneProject.config,
      "--security-sheet", milestoneProject.securitySheet,
      "--provider", milestoneProvider,
      "--opencode", realpathSync.native(milestoneOpenCode),
      "--opencode-home", realpathSync.native(milestoneOpenCodeHome),
      "--opencode-sha256", createHash("sha256").update(readFileSync(milestoneOpenCode)).digest("hex"),
      "--opencode-version", "package-opencode 1",
      "--file", "greeting.txt",
    ];
    const harnessEnvironment = {
      ...subprocessEnvironment,
      NODE_OPTIONS: `--import=${pathToFileURL(milestonePreload).href}`,
      ZENTRA_TEST_AZURE_OPENAI_API_KEY: "package-provider-secret",
    };
    const pausedRun = await runNonzero(binary, [
      "milestone", "run", "--goal", "Pause at exact authority", ...baseMilestoneArgs,
      "--database", pauseDatabase, "--model-sheet", pauseModels, "--agent-tail-jsonl", pauseTrace,
    ], consumer, harnessEnvironment);
    expect(pausedRun.code).toBe(1);
    expect(JSON.parse(pausedRun.stderr)).toMatchObject({
      command: "milestone.run", lifecycle: "ready", outcome: null, tracePath: pauseTrace,
    });

    const failureDatabase = path.join(milestoneRoot, "provider-failure.sqlite");
    const failureTrace = path.join(milestoneRoot, "provider-failure.jsonl");
    const failedRun = await runNonzero(binary, [
      "milestone", "run", "--goal", "Record provider failure", ...baseMilestoneArgs,
      "--database", failureDatabase, "--model-sheet", milestoneModels, "--agent-tail-jsonl", failureTrace,
    ], consumer, { ...harnessEnvironment, ZENTRA_TEST_PROVIDER_FAILURE: "1" });
    expect(failedRun.code).toBe(1);
    expect(JSON.parse(failedRun.stderr)).toMatchObject({
      command: "milestone.run", lifecycle: "terminal", outcome: "failed", tracePath: failureTrace,
    });
    expect(`${failedRun.stdout}${failedRun.stderr}${readFileSync(failureTrace, "utf8")}`)
      .not.toContain("package-provider-secret");

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
