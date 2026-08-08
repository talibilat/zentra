// tests/ui/console-shell.e2e.test.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { PodRegistry } from "../../src/pods/pod-registry.js";
import { charter } from "../pods/pod-fixtures.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";
import type { MilestonePlan } from "../../src/contracts/milestone.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Mirrors the client-side `label()` formatter embedded in controls-section.ts so the test's expectation is derived the same way the UI derives it, without depending on the UI's own rendered output as its oracle. */
function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function milestonePlanFixture(milestoneId: string, taskId: string): MilestonePlan {
  return {
    milestoneId,
    projectId: "zentra",
    goal: `Goal for ${milestoneId}`,
    tasks: [{
      taskId,
      title: "Task",
      description: "Task description.",
      dependencies: [],
      ownedPaths: ["src/**"],
      forbiddenPaths: [".env"],
      acceptanceCriteria: ["Done."],
      roleAssignment: { role: "planner", agentId: "opencode-general", harness: "opencode" },
      risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
      budget: { maxSeconds: 300, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1000, maxOutputTokens: 1000 },
    }],
  };
}

/**
 * A small fake AgentTrail HTTP backend for e2e use, scoped to this file. Mirrors the shape of
 * `fakeAgentTrail` in tests/gateway/loopback-gateway.test.ts (that helper is not exported, so this
 * is a smaller standalone copy) - it serves exactly the `GET /api/v1/runs/:traceId` endpoint that
 * LoopbackGateway#trailResult proxies through when reshaping Trail data for the console.
 *
 * The two fixture events use distinct actors ("pod-a" and "pod-b") so that clicking the first
 * actor filter pill in the rendered UI actually narrows the visible event count - a fixture with a
 * single shared actor across both events would make that filter a no-op.
 */
async function fakeAgentTrailForE2e(traceId: string): Promise<{
  readonly address: { readonly host: "127.0.0.1"; readonly port: number };
  close(): Promise<void>;
}> {
  const { createServer: createHttpServer } = await import("node:http");
  const server = createHttpServer((request, response) => {
    if (request.url === `/api/v1/runs/${traceId}`) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        run: { trace_id: traceId },
        duration_seconds: 12,
        events: [
          {
            event_id: "evt-1", offset_seconds: 1, sequence: 1, kind: "tool.call.attempt",
            actor: { id: "pod-a" }, operation: { status: "running", name: "run_tests" },
            relationships: [], payload: { preview: { ok: true } },
          },
          {
            event_id: "evt-2", offset_seconds: 2, sequence: 2, kind: "verification.finished",
            actor: { id: "pod-b" }, operation: { status: "failed", error: "assertion mismatch" },
            relationships: [{ type: "caused_by", event_id: "evt-1" }], payload: { preview: { detail: "boom" } },
          },
        ],
        actors: [{ id: "pod-a", role: "implementation" }, { id: "pod-b", role: "verification" }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") { reject(new Error("fake AgentTrail did not bind")); return; }
      resolve(address.port);
    });
  });
  return {
    address: { host: "127.0.0.1", port },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

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
    databasePath: path.join(root, "workflow.sqlite"),
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
      const detailText = await driver.evaluate<string>(`document.getElementById("run-detail")?.textContent || ""`);
      expect(detailText).toContain("Prove the console shell still submits goals");
      expect(detailText).toContain("Project");
      expect(detailText).toContain("Repository");
      expect(detailText).toContain("Submitted from");
      expect(detailText).toContain(root);
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("switches to the Trail nav item and shows a prompt to select a run when none is selected", async () => {
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
      await driver.waitFor(`document.getElementById("trail-events")?.textContent.includes("Select a run to see its trail.")`);
      const disabledTabs = await driver.evaluate<number>(`document.querySelectorAll('[data-trail-view][disabled]').length`);
      expect(disabledTabs).toBe(3);
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("shows the honest AgentTrail-unavailable state when a run is selected but AgentTrail is down", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-trail-unavailable-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      // Deliberately never calls gateway.setAgentTrailAddress(...), so a run IS selected but
      // AgentTrail itself is unavailable - a genuinely different scenario from "no run selected"
      // above, and one that must produce its own honest message rather than reusing that one.
      await driver.submitGoal("Prove Trail shows an honest unavailable state, not a filtered-empty one");
      await driver.click('[data-nav-id="trail"]');
      await driver.waitFor(`document.querySelector('[data-section-id="trail"]')?.dataset.active === "true"`);
      await driver.evaluate(`window.__consoleSections.trail.load()`);
      await driver.waitFor(`document.getElementById("trail-events")?.textContent.includes("Trace evidence unavailable.")`);
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("renders real Trail events and inspector detail from a live AgentTrail backend", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-trail-events-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    let upstream: Awaited<ReturnType<typeof fakeAgentTrailForE2e>> | null = null;
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      // The console's own workflow run id is what the gateway forwards verbatim as the upstream
      // AgentTrail path segment (see LoopbackGateway#trailResult), so the fake AgentTrail backend
      // is keyed by the real submitted run id rather than an invented trace id. This also avoids
      // reaching for the page's module-scoped `state` object, which is not reachable from outside
      // the console script's IIFE closure and therefore cannot be poked via `driver.evaluate`.
      const submittedRunId = await driver.submitGoal("Prove Trail renders real events");
      upstream = await fakeAgentTrailForE2e(submittedRunId);
      gateway.setAgentTrailAddress(upstream.address);
      await driver.click('[data-nav-id="trail"]');
      await driver.waitFor(`document.querySelector('[data-section-id="trail"]')?.dataset.active === "true"`);
      await driver.evaluate(`window.__consoleSections.trail.load()`);
      await driver.waitFor(`document.getElementById("trail-event-count")?.textContent === "2 of 2 events"`);
      await driver.click('#trail-filter-pills button');
      await driver.waitFor(`document.getElementById("trail-event-count")?.textContent === "1 of 2 events"`);
      await driver.click('#trail-filter-pills button');
      await driver.waitFor(`document.getElementById("trail-event-count")?.textContent === "2 of 2 events"`);
      // Topbar search narrows Trail's events the same way a filter pill does, without a new fetch
      // (see shell.ts's console-search listener, which calls Trail's pure `.render()` path). Only
      // the "run_tests" event (pod-a, tool.call.attempt) matches this substring; the other fixture
      // event (pod-b, verification.finished / "assertion mismatch") does not.
      await driver.evaluate(`(()=>{const input=document.getElementById("console-search");input.value="run_tests";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
      await driver.waitFor(`document.getElementById("trail-event-count")?.textContent === "1 of 2 events"`);
      await driver.evaluate(`(()=>{const input=document.getElementById("console-search");input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
      await driver.waitFor(`document.getElementById("trail-event-count")?.textContent === "2 of 2 events"`);
      const eventButtons = await driver.evaluate<number>(`document.querySelectorAll("#trail-events button").length`);
      expect(eventButtons).toBe(2);
      await driver.evaluate(`document.querySelectorAll("#trail-events button")[1].click()`);
      // The inspector's structured fields (event_id/actor/status/sequence/evidence) don't surface
      // `operation.error`; only the raw payload JSON and the event list row's summary column do
      // (see trail-section.ts's renderTrailInspectorEvent vs. renderTrailEvents). So the oracle
      // here is the payload's distinctive "boom" detail flowing all the way from the fake
      // AgentTrail backend, through the gateway's real reshape, into the rendered inspector panel.
      await driver.waitFor(`document.getElementById("trail-inspector")?.textContent.includes("evt-2") && document.getElementById("trail-inspector")?.textContent.includes("boom")`);
      expect(submittedRunId).toMatch(/^run-/);
    } finally {
      await gateway.close();
      if (upstream !== null) await upstream.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("switches to the Overview nav item and renders the selected run's real title and lifecycle badge", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-overview-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      const runId = await driver.submitGoal("Confirm Overview renders the selected run's real data");

      // Independent oracle: read the run straight from the same workflow surface the gateway is backed
      // by, rather than from another rendered panel, so this cannot pass by cross-checking one buggy
      // render against another.
      const detail = fixture.workflow.getRun(runId);
      if (detail === null) throw new Error("submitted run is missing from the workflow surface");
      const expectedBadge = label(detail.run.lifecycle);

      await driver.click('[data-nav-id="overview"]');
      await driver.waitFor(`document.querySelector('[data-section-id="overview"]')?.dataset.active === "true"`);

      const heading = await driver.evaluate<string>(`document.querySelector("#overview-root h1")?.textContent || ""`);
      expect(heading).toBe(detail.run.title);

      const badgeText = await driver.evaluate<string>(`document.querySelector("#overview-root .badge")?.textContent || ""`);
      expect(badgeText).toBe(expectedBadge);
      expect(badgeText).not.toBe("");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("shows the submitted run in the topbar run switcher and lists it in the dropdown", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-topbar-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      const runId = await driver.submitGoal("Confirm the topbar run switcher shows the real run");

      const switcherTitle = await driver.evaluate<string>(`document.getElementById("run-switcher-title")?.textContent || ""`);
      expect(switcherTitle).toBe("Confirm the topbar run switcher shows the real run");

      await driver.click("#run-switcher-button");
      await driver.waitFor(`document.getElementById("run-switcher-menu")?.hidden === false`);
      const rowText = await driver.evaluate<string>(`document.getElementById("run-switcher-rows")?.textContent || ""`);
      expect(rowText).toContain("Confirm the topbar run switcher shows the real run");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("renders Overview's metric tiles as an honest placeholder, not fabricated numbers", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-overview-metrics-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.submitGoal("Confirm Overview metric tiles are honest placeholders");
      await driver.click('[data-nav-id="overview"]');
      await driver.waitFor(`document.querySelector('[data-section-id="overview"]')?.dataset.active === "true"`);

      const placeholderCount = await driver.evaluate<number>(
        `Array.from(document.querySelectorAll("#overview-root")[0].querySelectorAll("div")).filter(el => el.textContent === "—").length`
      );
      expect(placeholderCount).toBeGreaterThanOrEqual(5);

      const warningsText = await driver.evaluate<string>(`document.getElementById("overview-root")?.textContent || ""`);
      expect(warningsText).toContain("Warning triage has no real backend yet - the Warnings section shows a static preview.");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("renders all six static preview sections and confirms their action controls are genuinely inert", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-static-sections-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      const sections: Array<[string, string]> = [
        ["warnings", "Warning triage"],
        ["security", "Taint security audit"],
        ["cost", "Outcome cost attribution"],
        ["compare", "Run comparison"],
        ["imports", "Session imports"],
        ["policies", "Warning policies"],
      ];
      for (const [navId, heading] of sections) {
        await driver.click(`[data-nav-id="${navId}"]`);
        await driver.waitFor(`document.querySelector('[data-section-id="${navId}"]')?.dataset.active === "true"`);
        const headingText = await driver.evaluate<string>(`document.querySelector('[data-section-id="${navId}"] h1')?.textContent || ""`);
        expect(headingText).toBe(heading);
      }
      await driver.click('[data-nav-id="warnings"]');
      await driver.waitFor(`document.querySelector('[data-section-id="warnings"]')?.dataset.active === "true"`);
      const ackDisabled = await driver.evaluate<boolean>(`[...document.querySelectorAll('[data-section-id="warnings"] button')].some(button=>button.textContent==="Acknowledge"&&button.disabled===true)`);
      expect(ackDisabled).toBe(true);
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("enables the Pods nav item and renders a registered pod's detail on click", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-pods-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    new PodRegistry(fixture.journal).register({ charter: charter({ podId: "pod-e2e" }), correlationId: "trace-e2e" });
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.click('[data-nav-id="pods"]');
      await driver.waitFor(`document.querySelector('[data-section-id="pods"]')?.dataset.active === "true"`);
      await driver.waitFor(`document.getElementById("pods-list")?.textContent.includes("pod-e2e")`);
      await driver.click('#pods-list button.run-card');
      await driver.waitFor(`document.getElementById("pod-detail")?.textContent.includes("Implement the pod aggregate.")`);
      const detailText = await driver.evaluate<string>(`document.getElementById("pod-detail")?.textContent || ""`);
      expect(detailText).toContain("pod-e2e");
      expect(detailText).toContain("Registered");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("enables the Milestones nav item and renders a registered milestone's plan on click", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-milestones-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    new MilestoneRegistry(fixture.journal).register({
      milestoneId: "milestone-e2e", projectId: "zentra", title: "E2E milestone",
      correlationId: "trace-milestone-e2e", tracePath: "/tmp/milestone-e2e.jsonl",
      plan: milestonePlanFixture("milestone-e2e", "task-e2e"),
    });
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.click('[data-nav-id="milestones"]');
      await driver.waitFor(`document.querySelector('[data-section-id="milestones"]')?.dataset.active === "true"`);
      await driver.waitFor(`document.getElementById("milestones-list")?.textContent.includes("E2E milestone")`);
      await driver.click('#milestones-list button.run-card');
      await driver.waitFor(`document.getElementById("milestone-detail")?.textContent.includes("Goal for milestone-e2e")`);
      const detailText = await driver.evaluate<string>(`document.getElementById("milestone-detail")?.textContent || ""`);
      expect(detailText).toContain("milestone-e2e");
      expect(detailText).toContain("Ready");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("enables the GitHub broker nav item and renders real broker activity on click", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-github-broker-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const action = {
      operation: "push" as const, repository: "talibilat/zentra", targetRef: "refs/heads/zentra/grant-e2e",
      sourceCommit: "1".repeat(40), expectedOldOid: "0".repeat(40), force: false as const,
    };
    const actionDigest = createHash("sha256").update(JSON.stringify(action), "utf8").digest("hex");
    const common = { requestId: "grant-e2e", grantId: "grant-e2e", actionDigest };
    fixture.journal.append("github-grant:grant-e2e", 0, [{
      streamId: "github-grant:grant-e2e", type: "capsule.github_grant_consumed",
      payload: { ...common, audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", policyDigest: "a".repeat(64) },
      causationId: null, correlationId: "grant-e2e",
    }, {
      streamId: "github-grant:grant-e2e", type: "capsule.github_broker_accepted",
      payload: { ...common, policyDigest: "a".repeat(64), ...action }, causationId: null, correlationId: "grant-e2e",
    }, {
      streamId: "github-grant:grant-e2e", type: "capsule.github_broker_reconciled",
      payload: { ...common, ...action, attempt: 1, outcome: "completed", observedRemoteOid: action.sourceCommit },
      causationId: null, correlationId: "grant-e2e",
    }]);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.click('[data-nav-id="github"]');
      await driver.waitFor(`document.querySelector('[data-section-id="github"]')?.dataset.active === "true"`);
      await driver.waitFor(`document.getElementById("github-broker-list")?.textContent.includes("talibilat/zentra")`);
      await driver.click('#github-broker-list button.run-card');
      await driver.waitFor(`document.getElementById("github-broker-detail")?.textContent.includes("grant-e2e")`);
      const detailText = await driver.evaluate<string>(`document.getElementById("github-broker-detail")?.textContent || ""`);
      expect(detailText).toContain("Push");
      expect(detailText).toContain("Completed");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("enables the Journal nav item and renders real retention and recovery status", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-journal-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.click('[data-nav-id="journal"]');
      await driver.waitFor(`document.querySelector('[data-section-id="journal"]')?.dataset.active === "true"`);
      await driver.waitFor(`document.getElementById("journal-retention")?.textContent.includes("Clean")`);
      const retentionText = await driver.evaluate<string>(`document.getElementById("journal-retention")?.textContent || ""`);
      expect(retentionText).toContain("Retain Forever");
      // consoleShellWorkflow's journal is a plain SqliteEventJournal, not wrapped in a
      // ProjectingEventJournal, so the honest-unavailable path for the projection card is
      // itself the real end-to-end behavior being proven here, not a compromise.
      const projectionText = await driver.evaluate<string>(`document.getElementById("journal-projection")?.textContent || ""`);
      expect(projectionText).toContain("Projection status unavailable in this environment.");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
});
