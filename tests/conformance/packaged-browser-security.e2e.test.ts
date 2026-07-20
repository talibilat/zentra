import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ChromiumDriver, chromiumExecutable } from "./chromium-driver.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const nodeExecutable = realpathSync(process.execPath);
const npmExecutable = realpathSync(path.join(path.dirname(nodeExecutable), "npm"));
const gitExecutable = "/usr/bin/git";
const temporaryDirectories: string[] = [];
const SECRET_CANARY = "ZENTRA_SECRET_CANARY_95_7f6d";
const TOKEN_CANARY = "ZENTRA_TOKEN_CANARY_95_12ac";
const RAW_OUTPUT_CANARY = "ZENTRA_RAW_OUTPUT_CANARY_95_f930";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("packaged first-delivery browser and security conformance", () => {
  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64" || chromiumExecutable === null)(
    "packs, installs, restarts, recovers AgentTrail, and preserves the no-coding boundary",
    async () => {
      const root = temporary("zentra-packaged-conformance-");
      const source = packageSandbox(root);
      const artifactDirectory = path.join(source, "artifacts");
      mkdirSync(artifactDirectory);
      const packed = await runNode(npmExecutable, ["pack", "--silent", "--pack-destination", artifactDirectory], source, packageEnvironment(root));
      const tarballName = packed.stdout.trim().split("\n").at(-1)!;
      const tarball = path.join(artifactDirectory, tarballName);
      expect(existsSync(tarball)).toBe(true);

      const consumer = path.join(root, "consumer");
      mkdirSync(consumer);
      writeFileSync(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
      await runNode(npmExecutable, ["install", "--no-audit", "--no-fund", tarball], consumer, packageEnvironment(root));
      const installedRoot = path.join(consumer, "node_modules", "zentra");
      expect(existsSync(path.join(installedRoot, "agenttrail", "package", "darwin-arm64", "agenttrail"))).toBe(true);

      const project = createProject(consumer);
      const baseline = repositoryEvidence(project);
      const launcher = createLauncher(consumer);
      const runtime = controlledRuntime(root);
      let service = await startService(launcher, project, runtime);
      let browser = await launchBrowser(root, service.sessionUrl, "initial");
      const cliOutput: string[] = [service.output()];
      let browserEvidence = "";
      let sseEvidence = "";
      try {
        try {
          await browser.wait('document.documentElement.dataset.ready === "true"');
        } catch (error) {
          const state = await browser.evaluate('JSON.stringify({href:location.href,status:document.getElementById("status")?.textContent,body:document.body?.innerText?.slice(0,2000)})');
          throw new Error(`${(error as Error).message}: ${state}: ${browser.stderr()}`);
        }
        await submitGoal(browser, "Approve the bounded packaged first-delivery plan");
        await answerRecommendedQuestion(browser);
        await approveExactPlan(browser);
        await browser.wait('document.body.innerText.includes("Approved And Ready For Execution")');
        assertNoExecutionProcesses(service.pid);

        await submitTickets(browser, "tickets", 2);
        await browser.evaluate('[...document.querySelectorAll(".run-card")].find(card=>!card.innerText.includes("APPROVED_AND_READY_FOR_EXECUTION")).click()');
        await browser.wait('document.body.innerText.includes("Analyzing")');
        await browser.evaluate('document.getElementById("cancel-run").click()');
        try {
          await browser.wait('document.body.innerText.includes("TERMINAL OUTCOME") && document.body.innerText.includes("Cancelled")');
        } catch (error) {
          throw new Error(`${(error as Error).message}: ${await browser.evaluate('document.body.innerText')}`);
        }
        assertNoExecutionProcesses(service.pid);

        const firstEvents = await journalEvents(installedRoot, project);
        const ready = [...firstEvents].reverse().find((event) => event.type === "agenttrail.ready")!;
        const sidecarPid = Number((ready.payload as { pid: number }).pid);
        process.kill(sidecarPid, "SIGKILL");
        await waitForJournal(installedRoot, project, (events) => events.some((event) => event.type === "gateway.recovered"));
        await browser.wait('document.getElementById("agenttrail-status").textContent.toLowerCase().includes("recovered")', 30_000);

        browserEvidence = await browser.evaluate(`JSON.stringify({
          dom: document.documentElement.outerHTML,
          localStorage: Object.fromEntries(Object.entries(localStorage)),
          sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
          historyLength: history.length,
          href: location.href
        })`);
        sseEvidence = await browser.evaluate(`(async()=>{
          const controller=new AbortController();setTimeout(()=>controller.abort(),1500);
          try{return await (await fetch('/agenttrail/api/v1/events?cursor=0',{signal:controller.signal})).text()}catch{return ''}
        })()`);
      } finally {
        await browser.close();
        cliOutput.push(await service.stop());
      }

      service = await startService(launcher, project, runtime);
      browser = await launchBrowser(root, service.sessionUrl, "restart");
      cliOutput.push(service.output());
      let agentTrailResponses = "";
      let exportedEvents: { event_id: string; sequence: number }[] = [];
      let agreementHighWater = 0;
      let agreementJournalEventCount = 0;
      try {
        await browser.wait('document.documentElement.dataset.ready === "true"');
        const expected = (await journalEvents(installedRoot, project)).filter((event) => event.projectable);
        agreementHighWater = expected.at(-1)?.globalPosition ?? 0;
        agreementJournalEventCount = expected.length;
        await browser.wait(`document.getElementById("agenttrail-frame").contentDocument?.body != null`, 20_000);
        await waitFor(async () => {
          const result = await agentTrailExport(browser);
          exportedEvents = result.events;
          agentTrailResponses = result.responses;
          return exportedEvents.length === expected.length;
        }, 30_000, "AgentTrail did not catch up to the projectable journal high-water");
        expect(exportedEvents).toEqual(expected.map((event) => ({
          event_id: event.eventId,
          sequence: event.globalPosition,
        })));
        expect(new Set(exportedEvents.map((event) => event.event_id)).size).toBe(exportedEvents.length);
      } finally {
        await browser.close();
        cliOutput.push(await service.stop());
      }

      const allEvents = await journalEvents(installedRoot, project);
      const traceFiles = readdirSync(path.join(project, ".zentra", "traces")).map((name) =>
        readFileSync(path.join(project, ".zentra", "traces", name), "utf8")).join("\n");
      const sqlitePayloads = allEvents.map((event) => JSON.stringify(event.payload)).join("\n");
      const runtimeFiles = readTree(path.join(project, ".zentra"));
      const leakSurfaces = [cliOutput.join("\n"), browserEvidence, runtimeFiles, sqlitePayloads,
        traceFiles, sseEvidence, agentTrailResponses];
      for (const canary of [SECRET_CANARY, TOKEN_CANARY, RAW_OUTPUT_CANARY]) {
        for (const surface of leakSurfaces) expect(surface).not.toContain(canary);
      }
      const browserState = JSON.parse(browserEvidence) as { href: string; localStorage: object; sessionStorage: object };
      expect(browserState.href).not.toContain("#token=");
      expect(browserState.localStorage).toEqual({});
      expect(browserState.sessionStorage).toEqual({});

      const types = allEvents.map((event) => event.type);
      for (const type of ["task.created", "task.started", "worker.started", "validation.started", "integration.started"]) {
        expect(types).not.toContain(type);
      }
      expect(repositoryEvidence(project)).toEqual(baseline);
      expect(existsSync(path.join(project, ".zentra", "conformance-worktrees"))).toBe(false);
      expect(execFileSync(gitExecutable, ["branch", "--list", "ticket/*", "zentra/integration"], { cwd: project, encoding: "utf8" })).toBe("");

      const projectable = allEvents.filter((event) => event.projectable);
      const report = {
        schemaVersion: 1,
        environment: { platform: process.platform, arch: process.arch, node: process.version,
          pythonAvailable: false, packageSha256: createHash("sha256").update(readFileSync(tarball)).digest("hex") },
        matrix: [
          { case: "inline-goal-repeated-questionnaire-rounds-exact-approval", outcome: "completed" },
          { case: "ticket-directory-active-analysis-cancellation", outcome: "cancelled" },
          { case: "agenttrail-runtime-crash-backfill", outcome: "completed" },
          { case: "service-restart-replay", outcome: "completed" },
        ],
        journal: { highWater: allEvents.at(-1)?.globalPosition ?? 0, eventCount: allEvents.length,
          projectableEventCount: projectable.length },
        traceAgreement: { complete: true, missing: 0, duplicates: 0, reordered: 0,
          throughPosition: agreementHighWater, journalEventCount: agreementJournalEventCount,
          exportedEventCount: exportedEvents.length },
        security: { canariesAbsent: true, browserCredentialsAbsent: true, shellAbsent: true,
          writerAbsent: true, codingEventsAbsent: true, worktreesAbsent: true,
          ticketBranchesAbsent: true, integrationBranchAbsent: true, repositoryUnchanged: true },
        canonicalOutcomes: ["completed", "cancelled"],
      };
      const reportPath = process.env["ZENTRA_CONFORMANCE_REPORT"] ??
        path.join(tmpdir(), "zentra-first-delivery-conformance-report.json");
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      expect(lstatSync(reportPath).size).toBeLessThan(64 * 1024);
      expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual(report);
    },
    240_000,
  );
});

function temporary(prefix: string): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function packageSandbox(root: string): string {
  const sandbox = path.join(root, "source");
  mkdirSync(sandbox);
  for (const name of ["package.json", "pnpm-lock.yaml", "README.md", "SECURITY.md", "LICENSE", "tsconfig.json", "tsconfig.build.json"]) {
    const source = path.join(repositoryRoot, name);
    if (existsSync(source)) copyFileSync(source, path.join(sandbox, name));
  }
  for (const name of ["agenttrail", "src", "fixtures", "scripts"]) cpSync(path.join(repositoryRoot, name), path.join(sandbox, name), { recursive: true });
  symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(sandbox, "node_modules"));
  return sandbox;
}

function packageEnvironment(root: string): NodeJS.ProcessEnv {
  return { PATH: `${path.dirname(nodeExecutable)}:/usr/bin:/bin`, HOME: root, TMPDIR: root, LANG: "C", LC_ALL: "C",
    npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
}

function createProject(consumer: string): string {
  const project = path.join(consumer, "project");
  execFileSync(gitExecutable, ["init", "-b", "main", project], { env: { HOME: consumer }, stdio: "ignore" });
  execFileSync(gitExecutable, ["config", "user.name", "Zentra Conformance"], { cwd: project });
  execFileSync(gitExecutable, ["config", "user.email", "conformance@example.invalid"], { cwd: project });
  mkdirSync(path.join(project, "src"));
  mkdirSync(path.join(project, "tickets"));
  writeFileSync(path.join(project, ".gitignore"), ".zentra/\n");
  writeFileSync(path.join(project, "src", "fixture.ts"), "export const fixture = true;\n");
  writeFileSync(path.join(project, "tickets", "first-delivery.md"), "Cancel during ZENTRA_CONFORMANCE_ACTIVE_ANALYSIS.\n");
  execFileSync(gitExecutable, ["add", "."], { cwd: project });
  execFileSync(gitExecutable, ["commit", "-m", "conformance fixture"], { cwd: project, stdio: "ignore" });
  return realpathSync(project);
}

function createLauncher(consumer: string): string {
  const launcher = path.join(consumer, "launch-conformance.mjs");
  writeFileSync(launcher, [
    'import { createFirstDeliveryConformanceProfile, startZentraService } from "zentra";',
    'const project=process.argv[2];',
    'const profile=await createFirstDeliveryConformanceProfile(project);',
    'const service=await startZentraService({cwd:project,tokenTtlMs:120000},{firstDelivery:profile});',
    'process.stdout.write(JSON.stringify({sessionUrl:service.sessionUrl,origin:service.origin})+"\\n");',
    'const stop=()=>{void service.shutdown("signal").catch(()=>{})};',
    'process.on("SIGTERM",stop);process.on("SIGINT",stop);',
    'await service.closed;',
  ].join("\n"));
  return launcher;
}

function controlledRuntime(root: string) {
  const bin = path.join(root, "controlled-bin");
  const home = path.join(root, "runtime-home");
  const temporary = path.join(root, "runtime-tmp");
  mkdirSync(bin); mkdirSync(home); mkdirSync(temporary);
  symlinkSync(nodeExecutable, path.join(bin, "node"));
  return { PATH: bin, HOME: home, TMPDIR: temporary, LANG: "C", LC_ALL: "C",
    ZENTRA_CONFORMANCE_SECRET: SECRET_CANARY, ZENTRA_CONFORMANCE_TOKEN: TOKEN_CANARY,
    ZENTRA_CONFORMANCE_RAW_OUTPUT: RAW_OUTPUT_CANARY };
}

async function startService(launcher: string, project: string, env: NodeJS.ProcessEnv) {
  let stdout = ""; let stderr = "";
  const child = spawn(nodeExecutable, [launcher, project], { cwd: project, env, detached: true, shell: false,
    stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  await waitFor(() => stdout.includes("\n"), 30_000, `packaged service did not publish a session: ${stderr}`);
  const session = JSON.parse(stdout.split("\n", 1)[0]!) as { sessionUrl: string; origin: string };
  return { ...session, pid: child.pid!, output: () => `${stdout}${stderr}`, stop: async () => {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    await waitFor(() => child.exitCode !== null, 10_000, "packaged service did not stop");
    return `${stdout}${stderr}`;
  } };
}

async function launchBrowser(root: string, url: string, identity: string): Promise<ChromiumDriver> {
  const profile = path.join(root, `browser-${identity}`); const home = path.join(root, `browser-home-${identity}`);
  const temporary = path.join(root, `browser-tmp-${identity}`);
  mkdirSync(profile); mkdirSync(home); mkdirSync(temporary);
  return ChromiumDriver.launch(url, profile, home, temporary);
}

async function submitTickets(browser: ChromiumDriver, relativePath: string, expectedRuns = 1): Promise<void> {
  await browser.evaluate(`(()=>{const input=document.getElementById('ticket-path');input.value=${JSON.stringify(relativePath)};document.getElementById('tickets-form').requestSubmit()})()`);
  await browser.wait(`document.querySelectorAll('.run-card').length === ${expectedRuns}`);
}

async function submitGoal(browser: ChromiumDriver, goal: string): Promise<void> {
  await browser.evaluate(`(()=>{const input=document.getElementById('goal');input.value=${JSON.stringify(goal)};document.getElementById('goal-form').requestSubmit()})()`);
  await browser.wait('document.querySelectorAll(".run-card").length >= 1 && document.body.innerText.includes("Awaiting Answer")');
}

async function selectRun(browser: ChromiumDriver, title: string): Promise<void> {
  await browser.evaluate(`(()=>{const button=[...document.querySelectorAll('.run-card')].find(node=>node.innerText.includes(${JSON.stringify(title)}));if(!button)throw new Error('run unavailable');button.click()})()`);
}

async function answerRecommendedQuestion(browser: ChromiumDriver): Promise<void> {
  await browser.wait('document.querySelector(".attention-card") !== null');
  await browser.evaluate('document.querySelector(".attention-card").click()');
  try {
    await browser.wait(`[...document.querySelectorAll('#decision-option option')].some(option=>option.textContent.includes('Preserve compatibility'))`);
  } catch (error) {
    const detail = await browser.evaluate('document.getElementById("decision").outerHTML');
    throw new Error(`${(error as Error).message}: ${detail}`);
  }
  await browser.evaluate(`(()=>{const select=document.getElementById('decision-option');select.value=[...select.options].find(option=>option.textContent.includes('Preserve compatibility')).value;select.form.requestSubmit()})()`);
  try {
    await browser.wait('document.body.innerText.includes("Awaiting Approval")');
  } catch (error) {
    const detail = await browser.evaluate('document.body.innerText');
    throw new Error(`${(error as Error).message}: ${detail}`);
  }
}

async function approveExactPlan(browser: ChromiumDriver): Promise<void> {
  await browser.wait('document.querySelector(".attention-card") !== null');
  await browser.evaluate('document.querySelector(".attention-card").click()');
  await browser.wait('document.querySelector("form[data-action=approve-plan]") !== null');
  await browser.evaluate(`(()=>{const form=document.querySelector('form[data-action=approve-plan]');form.elements.planDigest.value=document.querySelector('[data-plan-digest]').textContent;form.elements.envelopeDigest.value=document.querySelector('[data-envelope-digest]').textContent;form.requestSubmit()})()`);
}

async function agentTrailExport(browser: ChromiumDriver): Promise<{ events: { event_id: string; sequence: number }[]; responses: string }> {
  return browser.evaluate(`(async()=>{const runs=await (await fetch('/agenttrail/api/v1/runs')).json();const details=[];for(const run of runs.runs)details.push(await (await fetch('/agenttrail/api/v1/runs/'+encodeURIComponent(run.trace_id))).json());return {events:details.flatMap(detail=>detail.events).map(({event_id,sequence})=>({event_id,sequence})).sort((a,b)=>a.sequence-b.sequence),responses:JSON.stringify({runs,details})}})()`);
}

async function journalEvents(installedRoot: string, project: string): Promise<any[]> {
  const module = await import(`${pathToFileURL(path.join(installedRoot, "dist", "src", "index.js")).href}?t=${Date.now()}`) as any;
  const journal = new module.SqliteEventJournal(path.join(project, ".zentra", "events.sqlite"), { readOnly: true });
  try { return journal.readAll().map((event: any) => ({ ...event, projectable: module.isAgentTailProjectableEventType(event.type) })); }
  finally { journal.close(); }
}

async function waitForJournal(installedRoot: string, project: string, predicate: (events: any[]) => boolean): Promise<void> {
  await waitFor(async () => predicate(await journalEvents(installedRoot, project)), 30_000, "journal condition was not reached");
}

function repositoryEvidence(project: string) {
  return {
    head: execFileSync(gitExecutable, ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim(),
    status: execFileSync(gitExecutable, ["status", "--porcelain", "--untracked-files=all"], { cwd: project, encoding: "utf8" }),
    branches: execFileSync(gitExecutable, ["for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"], { cwd: project, encoding: "utf8" }),
  };
}

function readTree(root: string): string {
  const values: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const candidate = path.join(directory, name); const metadata = lstatSync(candidate);
      if (metadata.isDirectory()) visit(candidate);
      else if (metadata.isFile() && !/\.sqlite(?:-wal|-shm)?$/.test(name) && metadata.size <= 16 * 1024 * 1024) {
        values.push(readFileSync(candidate).toString("utf8"));
      }
    }
  };
  visit(root); return values.join("\n");
}

function assertNoExecutionProcesses(servicePid: number): void {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).trim().split("\n")
    .map((line) => /^(\s*\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }));
  const descendants = new Set([servicePid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) {
      descendants.add(row.pid); changed = true;
    }
  }
  const commands = rows.filter((row) => row.pid !== servicePid && descendants.has(row.pid)).map((row) => row.command);
  expect(commands.some((command) => /deterministic-worker|(?:^|\s)(?:\/bin\/)?(?:sh|bash|zsh)(?:\s|$)/.test(command))).toBe(false);
}

async function runNode(script: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  return execFileAsync(nodeExecutable, [script, ...args], { cwd, env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(message);
}
