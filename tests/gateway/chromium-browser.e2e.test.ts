import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LoopbackGateway } from "../../src/gateway/loopback-gateway.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { resolveProjectRevision } from "../../src/runs/project-revision.js";
import { ServiceLifecycleService } from "../../src/runs/service-lifecycle.js";
import { createLocalWorkflowSurface } from "../../src/surfaces/local-workflow.js";
import type { WorkflowSurface } from "../../src/surfaces/workflow-surface.js";
import { seedAgentTrailReady } from "../fixtures/service-ready.js";

const HEADLESS_SHELL = "/Users/talibilat/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const GOOGLE_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = canonicalBrowser(HEADLESS_SHELL, "--headless") ?? canonicalBrowser(GOOGLE_CHROME, "--headless=new");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Chromium operations UI", () => {
  it.skipIf(browser === null)("keeps multi-megabyte hostile source text out of initial run detail", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-chromium-e2e-")));
    temporaryDirectories.push(root);
    const profile = path.join(root, "profile");
    const home = path.join(root, "home");
    const temporary = path.join(root, "tmp");
    mkdirSync(profile, { mode: 0o700 });
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(temporary, { mode: 0o700 });
    const ticketText = (`<script>document.documentElement.dataset.ticketAttack="executed"</script>\n` +
      `<img src=x onerror="document.documentElement.dataset.ticketAttack='executed'">\n`).repeat(5_000);
    expect(Buffer.byteLength(ticketText, "utf8")).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(ticketText, "utf8") * 3).toBeGreaterThan(2 * 1024 * 1024);
    const fixture = await realBrowserWorkflow(root, ticketText);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const page = await runChromium(session.url, profile, home, temporary);
      expect(page.href).toBe(`${session.origin}/`);
      expect(page.dom).toContain(`data-location="${session.origin}/"`);
      expect(page.dom).not.toContain(new URL(session.url).hash.slice("#token=".length));
      expect(page.dom).toContain('src="/agenttrail/"');
      expect(page.dom).not.toContain("agentTrailToken");
      expect(page.dom).not.toContain("/agenttrail/?token=");
      expect(page.dom).toContain("Secure local session established.");
      expect(page.dom).toContain('id="goal-form"');
      expect(page.dom).toContain('id="cancel-run"');
      expect(page.dom).toContain("Expand source text");
      expect(page.dom).toContain("untrusted_planning_data");
      expect(page.dom).not.toContain("&lt;script&gt;document.documentElement.dataset.ticketAttack");
      expect(Buffer.byteLength(page.dom, "utf8")).toBeLessThan(256 * 1024);
      expect(page.dom).not.toContain("<script>document.documentElement.dataset.ticketAttack");
      expect(page.dom).not.toContain("<img src=\"x\" onerror=");
      expect(page.dom).not.toContain('data-ticket-attack="executed"');
      expect((await handoffAgain(session)).status).toBe(401);
      expect((await fetch(session.origin)).status).toBe(200);
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it.skipIf(browser === null)("keeps labeled keyboard-native controls and mobile viewport semantics", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-chromium-mobile-")));
    temporaryDirectories.push(root);
    const profile = path.join(root, "profile"); const home = path.join(root, "home"); const temporary = path.join(root, "tmp");
    mkdirSync(profile, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
    const gateway = new LoopbackGateway({ workflow: layoutWorkflow() });
    const session = await gateway.start(); gateway.setReadiness("ready");
    try {
      const page = await runChromium(session.url, profile, home, temporary, ["--window-size=390,844"]);
      expect(page.dom).toContain('name="viewport" content="width=device-width,initial-scale=1"');
      expect(page.dom).toContain('<label class="field-label" for="goal">Goal</label>');
      expect(page.dom).toContain('<label class="field-label" for="ticket-path">Project-relative folder</label>');
      expect(page.dom).toContain('data-nav-id="controls"');
      expect(page.dom).toContain('aria-live="polite"');
      expect(page.dom).not.toMatch(/<option[^>]+selected/);
      expect(page.dom).toContain("Source kind</dt><dd>Inline Goal");
      expect(page.dom).toContain("Source count</dt><dd>2");
      expect(page.dom).toContain("Analysis status</dt><dd>Awaiting Answer");
      expect(page.dom).toContain("Analysis rounds</dt><dd>2");
      expect(page.dom).toContain("Readiness</dt><dd>Ready");
      expect(page.dom).toContain("Approval</dt><dd>Approved");
      expect(page.dom).toContain("Terminal outcome</dt><dd>Failed");
      expect(page.dom).toContain("Stale by stale-operator via cli");
      expect(page.dom).toContain("Rejected by rejecting-operator via ui");
      expect(page.dom).toMatch(/<button id="cancel-run"[^>]*disabled/);
      expect(page.dom).not.toContain("[object Object]");
    } finally { await gateway.close(); }
  }, 60_000);

  it.skipIf(browser === null)("renders cancelled terminal outcome and disables cancellation", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-chromium-cancelled-")));
    temporaryDirectories.push(root);
    const profile = path.join(root, "profile"); const home = path.join(root, "home"); const temporary = path.join(root, "tmp");
    mkdirSync(profile, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
    const gateway = new LoopbackGateway({ workflow: layoutWorkflow("cancelled") });
    const session = await gateway.start(); gateway.setReadiness("ready");
    try {
      const page = await runChromium(session.url, profile, home, temporary);
      expect(page.dom).toContain("Lifecycle</dt><dd>Terminal");
      expect(page.dom).toContain("Terminal outcome</dt><dd>Cancelled");
      expect(page.dom).toContain("Run ended with Cancelled");
      expect(page.dom).toMatch(/<button id="cancel-run"[^>]*disabled/);
      expect(page.dom).not.toContain("[object Object]");
    } finally { await gateway.close(); }
  }, 60_000);
});

async function runChromium(
  url: string,
  profile: string,
  home: string,
  temporary: string,
  extraArgs: readonly string[] = [],
): Promise<{ readonly href: string; readonly dom: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(browser!.executable, [
      browser!.headlessFlag, "--disable-background-networking", "--disable-breakpad",
      "--disable-component-update", "--disable-default-apps", "--disable-extensions",
      "--disable-gpu", "--disable-sync", "--metrics-recording-only", "--no-proxy-server", "--virtual-time-budget=2000",
      "--no-default-browser-check", "--no-first-run", "--no-sandbox", `--user-data-dir=${profile}`,
      ...extraArgs, "--dump-dom", url,
    ], {
      detached: true,
      shell: false,
      env: { HOME: home, TMPDIR: temporary, LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const complete = async (error: Error | null): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await terminateGroup(child.pid);
      if (error !== null) {
        reject(error);
        return;
      }
      const href = /data-location="([^"]+)"/.exec(stdout)?.[1];
      if (href === undefined) {
        reject(new Error("Chromium dump DOM omitted the clean location marker"));
        return;
      }
      resolve({ href, dom: stdout });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        void complete(new Error("Chromium browser E2E output exceeded its limit"));
      } else if (stdout.includes('data-ready="true"') && stdout.includes("</html>")) {
        void complete(null);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    child.once("error", () => { void complete(new Error("Chromium browser E2E failed to start")); });
    child.once("exit", (code) => {
      if (!settled && code !== 0) void complete(new Error(`Chromium browser E2E exited ${code}: ${stderr.slice(0, 512)}`));
    });
    const timer = setTimeout(() => {
      void complete(new Error(`Chromium browser E2E exceeded its deadline: ${stderr.slice(0, 512)}`));
    }, 30_000);
  });
}

async function realBrowserWorkflow(root: string, ticketText: string): Promise<{
  readonly workflow: WorkflowSurface;
  readonly journal: SqliteEventJournal;
}> {
  execFileSync("/usr/bin/git", ["init", root], { env: { HOME: root }, stdio: "ignore" });
  execFileSync("/usr/bin/git", ["config", "user.name", "Zentra Browser Test"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["config", "user.email", "zentra@example.invalid"], { cwd: root, env: { HOME: root } });
  writeFileSync(path.join(root, "README.md"), "browser fixture\n");
  execFileSync("/usr/bin/git", ["add", "README.md"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["commit", "-m", "fixture"], { cwd: root, env: { HOME: root }, stdio: "ignore" });
  const tickets = path.join(root, "tickets");
  mkdirSync(tickets);
  writeFileSync(path.join(tickets, "hostile.html"), ticketText);
  writeFileSync(path.join(tickets, "hostile-two.html"), ticketText);
  writeFileSync(path.join(tickets, "hostile-three.html"), ticketText);
  const journal = new SqliteEventJournal(path.join(root, "workflow.sqlite"));
  const process = { pid: 123, processIncarnation: `process-v2:${"c".repeat(64)}` };
  const lifecycle = new ServiceLifecycleService(journal);
  const starting = lifecycle.start({
    serviceId: "zentra-browser-test",
    process,
    address: { host: "127.0.0.1", port: 43_219 },
    tokenExpiresAt: "2026-07-20T13:00:00.000Z",
    observation: "performed",
    commandId: "service-start",
  });
  const agentTrail = seedAgentTrailReady(journal, {
    serviceId: "zentra-browser-test",
    serviceStartingEventId: starting.eventId,
  });
  const serviceReadyEventId = lifecycle.ready({
    serviceId: "zentra-browser-test",
    process,
    address: { host: "127.0.0.1", port: 43_219 },
    runtimeSchemaVersion: 1,
    journalSchemaVersion: 2,
    tokenExpiresAt: "2026-07-20T13:00:00.000Z",
    observation: "performed",
    commandId: "service-ready",
    causationId: agentTrail.agentTrailReadyEventId,
    ...agentTrail,
  }).eventId;
  const workflow = await createLocalWorkflowSurface({
    journal,
    process,
    serviceReadyEventId,
    projectRoot: root,
    projectRevision: await resolveProjectRevision(root),
  });
  await workflow.submitRun(
    { kind: "ticket_directory", commandId: "browser-fixture-submit", directoryPath: "tickets" },
    { actorId: "browser-operator", channel: "ui" },
  );
  return { workflow, journal };
}

function layoutWorkflow(terminalOutcome: "failed" | "cancelled" = "failed"): WorkflowSurface {
  let changeRequests = 0;
  return {
    listRuns: () => [{ runId: "run-browser", goal: "Mobile layout", lifecycle: "terminal", terminalOutcome }],
    getRun: (runId: string) => ({ run: { runId, lifecycle: "terminal", terminalOutcome, streamVersion: 1 },
      intake: { sourceKind: "inline_goal", sourceCount: 2, sources: [] },
      analysis: { status: "awaiting_answer", rounds: [{ round: 1 }, { round: 2 }] },
      planning: { readiness: { ready: true, lifecycle: "terminal", approvalState: "approved" } },
      attention: [{ decisionId: "pending-1", kind: "question", status: "pending" }],
      decisions: [
        { decisionId: "stale-1", kind: "approval", status: "stale", packet: { summary: "Superseded approval" }, resolution: { actor: { actorId: "stale-operator", channel: "cli" } } },
        { decisionId: "rejected-1", kind: "question", status: "rejected", packet: { question: "Use unsafe scope?" }, resolution: { actor: { actorId: "rejecting-operator", channel: "ui" } } },
      ] }),
    listAttention: () => [], getDecision: () => null,
    submitRun: () => ({}), cancelRun: () => ({}), answerQuestion: () => ({}), rejectQuestion: () => ({}), approvePlan: () => ({}), rejectPlan: () => ({}),
    getChanges: (afterPosition: number) => {
      changeRequests += 1;
      if (changeRequests === 1) return { schemaVersion: 1, afterPosition, cursor: 5, nextCursor: 5,
        highWaterPosition: 5, hasMore: false, changes: [
          { globalPosition: 2, eventId: "event-2", streamId: "gateway:fixture", streamVersion: 1,
            type: "gateway.degraded", correlationId: "service-1", causationId: "failure-1",
            recordedAt: "2026-07-20T12:00:00.000Z", payload: {} },
          { globalPosition: 3, eventId: "event-3", streamId: "gateway:fixture", streamVersion: 2,
            type: "gateway.backfill_target", correlationId: "service-1", causationId: "event-2",
            recordedAt: "2026-07-20T12:00:01.000Z", payload: {} },
          { globalPosition: 4, eventId: "event-4", streamId: "gateway:fixture", streamVersion: 3,
            type: "gateway.recovered", correlationId: "service-1", causationId: "event-3",
            recordedAt: "2026-07-20T12:00:02.000Z", payload: {} },
          { globalPosition: 5, eventId: "event-5", streamId: "run:run-browser", streamVersion: 1,
            type: "run.accepted", correlationId: "run-browser", causationId: null,
            recordedAt: "2026-07-20T12:00:03.000Z", payload: {} },
        ] };
      if (afterPosition === 5) return { schemaVersion: 1, afterPosition, cursor: 5, nextCursor: 5,
        highWaterPosition: 5, hasMore: false, changes: [] };
      return { schemaVersion: 1, afterPosition, cursor: afterPosition,
        nextCursor: afterPosition, highWaterPosition: afterPosition, hasMore: false, changes: [] };
    },
  } as unknown as WorkflowSurface;
}

function handoffAgain(session: { origin: string; url: string }): Promise<Response> {
  return fetch(`${session.origin}/api/v1/session`, { method: "POST", headers: { origin: session.origin, "content-type": "application/json" }, body: JSON.stringify({ token: new URL(session.url).hash.slice("#token=".length) }) });
}

function canonicalBrowser(candidate: string, headlessFlag: "--headless" | "--headless=new") {
  if (!existsSync(candidate)) return null;
  try {
    const metadata = statSync(candidate);
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0 || realpathSync(candidate) !== candidate) return null;
    return { executable: candidate, headlessFlag } as const;
  } catch {
    return null;
  }
}

async function terminateGroup(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGTERM"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { process.kill(-pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
