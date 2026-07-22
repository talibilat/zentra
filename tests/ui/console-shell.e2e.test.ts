// tests/ui/console-shell.e2e.test.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { ChromiumWorkflowDriver, acceptanceBrowser } from "./chromium-acceptance.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function consoleShellWorkflow(root: string): Promise<{ readonly workflow: WorkflowSurface; readonly journal: SqliteEventJournal }> {
  execFileSync("/usr/bin/git", ["init", root], { env: { HOME: root }, stdio: "ignore" });
  execFileSync("/usr/bin/git", ["config", "user.name", "Zentra Browser Test"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["config", "user.email", "zentra@example.invalid"], { cwd: root, env: { HOME: root } });
  writeFileSync(path.join(root, "README.md"), "console shell fixture\n");
  execFileSync("/usr/bin/git", ["add", "README.md"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["commit", "-m", "fixture"], { cwd: root, env: { HOME: root }, stdio: "ignore" });
  const journal = new SqliteEventJournal(path.join(root, "workflow.sqlite"));
  const process = { pid: 123, processIncarnation: `process-v2:${"d".repeat(64)}` };
  const lifecycle = new ServiceLifecycleService(journal);
  const starting = lifecycle.start({
    serviceId: "zentra-console-shell-test", process, address: { host: "127.0.0.1", port: 43_220 },
    tokenExpiresAt: "2026-07-20T13:00:00.000Z", observation: "performed", commandId: "service-start",
  });
  const agentTrail = seedAgentTrailReady(journal, { serviceId: "zentra-console-shell-test", serviceStartingEventId: starting.eventId });
  const serviceReadyEventId = lifecycle.ready({
    serviceId: "zentra-console-shell-test", process, address: { host: "127.0.0.1", port: 43_220 },
    runtimeSchemaVersion: 1, journalSchemaVersion: 2, tokenExpiresAt: "2026-07-20T13:00:00.000Z",
    observation: "performed", commandId: "service-ready", causationId: agentTrail.agentTrailReadyEventId, ...agentTrail,
  }).eventId;
  const workflow = await createLocalWorkflowSurface({
    journal, process, serviceReadyEventId, projectRoot: root, projectRevision: await resolveProjectRevision(root),
  });
  return { workflow, journal };
}

describe.skipIf(acceptanceBrowser === null)("console shell, real browser", () => {
  it("submits a goal through the Controls section inside the new shell and shows it under the run detail", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      const runId = await driver.submitGoal("Prove the console shell still submits goals");
      expect(runId).toMatch(/^run-/);
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("switches to the Trail nav item and confirms the restyled chrome still targets the embedded AgentTrail route", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-trail-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.click('[data-nav-id="trail"]');
      await driver.waitFor(`document.querySelector('[data-section-id="trail"]')?.dataset.active === "true"`);
      const frameSrc = await driver.evaluate<string>(`document.getElementById("agenttrail-frame")?.getAttribute("src") || ""`);
      expect(frameSrc).toBe("/agenttrail/");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
});
