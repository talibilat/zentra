import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/main.js";
import type { GatewaySession } from "../../src/gateway/loopback-gateway.js";
import type { WorkflowRunDetail } from "../../src/surfaces/workflow-surface.js";
import {
  HOSTILE_TICKET_TEXT,
  createWorkflowAcceptanceFixture,
  removeWorkflowAcceptanceFixture,
  type WorkflowAcceptanceFixture,
} from "./workflow-acceptance-fixture.js";
import { acceptanceBrowser, ChromiumWorkflowDriver } from "./chromium-acceptance.js";
import { resetDaemonJournalForInProcessRestart, startLiveWorkflowDaemon } from "./live-workflow-daemon.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeWorkflowAcceptanceFixture(root);
});

describe("workflow UI and CLI acceptance", () => {
  it("drives one durable workflow through rendered browser controls and the live CLI transport", async () => {
    expect(acceptanceBrowser, "Chromium is required for the UI acceptance gate").not.toBeNull();
    let fixture = await createWorkflowAcceptanceFixture();
    roots.push(fixture.root);
    let daemon = await startLiveWorkflowDaemon(fixture.root, fixture.surface);
    let browser = await ChromiumWorkflowDriver.open(daemon.service.sessionUrl, fixture.root);

    const inlineRunId = await browser.submitGoal("Verify one exact cross-surface workflow.");
    await fixture.seedFirstQuestion(inlineRunId);
    const firstQuestion = pendingQuestion(fixture, inlineRunId);

    const stale = await cli([
      "question", "answer", firstQuestion.decisionId,
      "--run-id", inlineRunId,
      "--expected-version", String(firstQuestion.streamVersion - 1),
      "--actor", "cli-stale-operator",
      "--command-id", "cli-stale-round-one",
      "--option-id", firstQuestion.options[0]!.optionId,
    ], fixture.root);
    expect(stale).toMatchObject({ code: 1, json: { error: { code: "stale" } } });

    await browser.answerPendingQuestion(inlineRunId);
    const double = await cli([
      "question", "answer", firstQuestion.decisionId,
      "--run-id", inlineRunId,
      "--expected-version", String(firstQuestion.streamVersion),
      "--actor", "cli-double-operator",
      "--command-id", "cli-double-round-one",
      "--option-id", firstQuestion.options[0]!.optionId,
    ], fixture.root);
    expect(double).toMatchObject({ code: 1, json: { error: { code: "consumed" } } });

    const secondQuestion = pendingQuestion(fixture, inlineRunId);
    expect((await cli([
      "question", "answer", secondQuestion.decisionId,
      "--run-id", inlineRunId,
      "--expected-version", String(secondQuestion.streamVersion),
      "--actor", "cli-round-two-operator",
      "--command-id", "cli-answer-round-two",
      "--option-id", secondQuestion.options[0]!.optionId,
    ], fixture.root)).code).toBe(0);

    const ticketSubmission = await cli([
      "run", "--tickets", fixture.tickets, "--actor", "cli-ticket-operator",
    ], fixture.root);
    expect(ticketSubmission.code).toBe(0);
    const ticket = ticketSubmission.json.result as WorkflowRunDetail;
    await fixture.seedFirstQuestion(ticket.run.runId);
    const ticketFirst = pendingQuestion(fixture, ticket.run.runId);
    expect((await cli([
      "question", "answer", ticketFirst.decisionId,
      "--run-id", ticket.run.runId,
      "--expected-version", String(ticketFirst.streamVersion),
      "--actor", "cli-ticket-operator",
      "--command-id", "cli-ticket-round-one",
      "--option-id", ticketFirst.options[0]!.optionId,
    ], fixture.root)).code).toBe(0);
    const draft = "Keep this unsubmitted operator draft.";
    await browser.prepareInteractiveRefresh(ticket.run.runId, draft);
    const refreshEvents = fixture.journal.append("acceptance-ui-refresh", 0, Array.from({ length: 205 }, (_, index) => ({
      streamId: "acceptance-ui-refresh",
      type: "acceptance.ui_refresh",
      payload: { index },
      causationId: null,
      correlationId: "acceptance-ui-refresh",
    })));
    const preserved = await browser.interactionAfterCursor(refreshEvents.at(-1)!.globalPosition);
    expect(preserved).toEqual({
      draft,
      focusedId: "goal",
      sourceText: HOSTILE_TICKET_TEXT,
      decisionVisible: true,
    });
    await browser.answerPendingQuestion(ticket.run.runId);

    await browser.rejectPendingPlan(ticket.run.runId, "Keep the correction within the reviewed workflow path.");
    const rejected = fixture.surface.getRun(ticket.run.runId)!;
    expect(rejected).toMatchObject({
      run: { lifecycle: "planning", authority: { approvalState: "rejected" } },
      planning: { status: "correction_pending" },
    });
    await browser.cancelRun(ticket.run.runId);
    expect(fixture.surface.getRun(ticket.run.runId)?.run.terminalOutcome).toBe("cancelled");

    const inlineReady = fixture.surface.getRun(inlineRunId)!;
    const approval = inlineReady.approvals.find((decision) => decision.status === "pending")!;
    const mismatch = await cli([
      "plan", "approve", approval.decisionId,
      "--run-id", inlineRunId,
      "--expected-version", String(approval.streamVersion),
      "--actor", "cli-mismatch-operator",
      "--command-id", "cli-mismatched-plan",
      "--plan-digest", "0".repeat(64),
      "--envelope-digest", inlineReady.planning.envelopeDigest!,
    ], fixture.root);
    expect(mismatch).toMatchObject({ code: 1, json: { error: { code: "digest_mismatch" } } });

    const restartCursor = fixture.journal.readAll().at(-1)!.globalPosition;
    await browser.close();
    await daemon.service.shutdown("test_requested");
    resetDaemonJournalForInProcessRestart(daemon);
    fixture.close();

    fixture = await createWorkflowAcceptanceFixture(fixture.root);
    daemon = await startLiveWorkflowDaemon(fixture.root, fixture.surface);
    browser = await ChromiumWorkflowDriver.open(daemon.service.sessionUrl, fixture.root);
    await browser.approvePendingPlan(inlineRunId);

    const browserResult = await browser.inspectHostileSource(ticket.run.runId);
    expect(browserResult.accessibleNames).toEqual(expect.arrayContaining([
      "textbox:Goal",
      "button:Submit goal",
      "textbox:Project-relative folder",
      "button:Submit tickets",
      "button:Cancel run",
      "Iframe:AgentTrail evidence views",
    ]));
    expect(browserResult.focusOrder.slice(0, 7)).toEqual([
      "a::Skip to operations",
      "a::Controls",
      "a::AgentTrail",
      "textarea:goal:Goal",
      "button::Submit goal",
      "input:ticket-path:Project-relative folder",
      "button::Submit tickets",
    ]);
    expect(browserResult.viewport).toEqual({ width: 390, documentWidth: 390, offenders: [] });
    expect(browserResult.sourceText).toBe(HOSTILE_TICKET_TEXT);
    expect(browserResult.hostileExecuted).toBe(false);
    await browser.close();

    const session = daemon.gateway.rotateSession();
    const auth = await establish(session);
    const events = await fetch(`${session.origin}/api/v1/zentra/events`, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${auth.bearerToken}`,
        "last-event-id": String(restartCursor),
      },
    });
    const backfill = await events.text();
    expect(events.status).toBe(200);
    expect(backfill).toContain("approval.accepted");
    expect(backfill).toContain("run.ready");
    const positions = [...backfill.matchAll(/^id: ([0-9]+)$/gm)].map((match) => Number(match[1]));
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.every((position) => position > restartCursor)).toBe(true);

    const cliStatus = await cli(["status", inlineRunId], fixture.root);
    const httpStatus = await json<WorkflowRunDetail>(await uiGet(session, auth, `/runs/${encodeURIComponent(inlineRunId)}`));
    expect(JSON.stringify(cliStatus.json.run)).toBe(JSON.stringify(httpStatus));
    expect(httpStatus).toMatchObject({
      run: { source: { kind: "inline_goal" }, lifecycle: "approved_and_ready_for_execution" },
      analysis: { status: "completed" },
      planning: { status: "proposed", readiness: { ready: true } },
    });
    expect(httpStatus.analysis.answers).toHaveLength(2);
    expect(httpStatus.analysis.rounds).toHaveLength(3);
    expect(httpStatus.run.authority.executionAuthority).toBe("none");
    expect(fixture.surface.getRun(ticket.run.runId)).toMatchObject({
      run: { source: { kind: "ticket_directory" }, terminalOutcome: "cancelled" },
      planning: { status: "correction_pending" },
    });

    await daemon.service.shutdown("test_requested");
    fixture.close();
  }, 90_000);
});

interface BrowserAuth {
  readonly bearerToken: string;
  readonly csrfToken: string;
}

async function establish(session: GatewaySession): Promise<BrowserAuth> {
  const response = await fetch(`${session.origin}/api/v1/session`, {
    method: "POST",
    headers: { origin: session.origin, "content-type": "application/json" },
    body: JSON.stringify({ token: new URL(session.url).hash.slice("#token=".length) }),
  });
  expect(response.status).toBe(201);
  return await response.json() as BrowserAuth;
}

function uiGet(session: GatewaySession, auth: BrowserAuth, path: string): Promise<Response> {
  return fetch(`${session.origin}/api/v1/zentra${path}`, {
    headers: { authorization: `Bearer ${auth.bearerToken}`, accept: "application/json" },
  });
}

function pendingQuestion(fixture: WorkflowAcceptanceFixture, runId: string) {
  const question = fixture.surface.getRun(runId)?.questions.find((decision) => decision.status === "pending");
  if (question === undefined) throw new Error(`run ${runId} has no pending question`);
  return question;
}

async function cli(argv: readonly string[], root: string) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd: root,
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  });
  const serialized = `${stdout}${stderr}`.trim();
  return { code, stdout, stderr, json: JSON.parse(serialized) as Record<string, any> };
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}
