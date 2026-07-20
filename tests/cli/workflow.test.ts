import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import {
  WorkflowSurfaceError,
  type WorkflowSurface,
} from "../../src/surfaces/workflow-surface.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workflow CLI", () => {
  it("submits inline goals and canonical ticket directories through the injected surface", async () => {
    const workflow = fakeWorkflow();
    workflow.submitRun.mockResolvedValueOnce({ runId: "run-new" });
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-workflow-cli-"));
    directories.push(directory);
    const tickets = path.join(directory, "tickets");
    mkdirSync(tickets);

    const inline = await invoke(["run", "Fix the parser"], workflow.surface);
    const ticket = await invoke(["run", "--tickets", path.relative(process.cwd(), tickets), "--actor", "operator-2"], workflow.surface);

    expect(inline).toMatchObject({ code: 0, stderr: "", json: { command: "run", result: { runId: "run-new" } } });
    expect(ticket.code).toBe(0);
    expect(workflow.submitRun).toHaveBeenNthCalledWith(1,
      { kind: "inline_goal", commandId: expect.any(String), goal: "Fix the parser" }, { actorId: "zentra-local-operator", channel: "cli" });
    expect(workflow.submitRun).toHaveBeenNthCalledWith(2,
      { kind: "ticket_directory", commandId: expect.any(String), directoryPath: realpathSync.native(tickets) }, { actorId: "operator-2", channel: "cli" });
  });

  it("rejects missing, unsafe, and mixed run sources before calling the surface", async () => {
    const workflow = fakeWorkflow();
    const missing = path.join(tmpdir(), "zentra-missing-ticket-directory");

    for (const argv of [
      ["run", "--actor", "operator"],
      ["run", "goal", "--tickets", missing, "--actor", "operator"],
      ["run", "--tickets", missing, "--actor", "operator"],
    ]) {
      const result = await invoke(argv, workflow.surface);
      expect(result).toMatchObject({ code: 1, stdout: "", json: { command: "run", error: { code: "INVALID_COMMAND" } } });
    }
    expect(workflow.submitRun).not.toHaveBeenCalled();
  });

  it("lists, inspects, and cancels runs with exact command context", async () => {
    const workflow = fakeWorkflow();

    expect((await invoke(["list"], workflow.surface)).json).toEqual({ command: "list", runs: [{ runId: "run-1" }] });
    expect((await invoke(["status", "run-1"], workflow.surface)).json).toEqual({ command: "status", run: { run: { runId: "run-1" } } });
    const cancelled = await invoke([
      "cancel", "run-1", "--expected-version", "7", "--actor", "operator-1", "--command-id", "cancel-command",
    ], workflow.surface);

    expect(cancelled).toMatchObject({ code: 0, json: { command: "cancel", result: { outcome: "cancelled" } } });
    expect(workflow.cancelRun).toHaveBeenCalledWith({
      runId: "run-1", expectedVersion: 7, commandId: "cancel-command",
      cancellationId: "cancel-command",
    }, { actorId: "operator-1", channel: "cli" });
  });

  it("allows a separately bounded large workflow status projection", async () => {
    const workflow = fakeWorkflow();
    const plan = { tasks: [{ acceptanceCriteria: ["x".repeat(64 * 1024)] }] };
    workflow.getRun.mockReturnValueOnce({ run: { runId: "run-large" }, planning: { plan } });

    const result = await invoke(["status", "run-large"], workflow.surface);

    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeGreaterThan(16 * 1024);
    expect(result.json).toEqual({ command: "status", run: { run: { runId: "run-large" }, planning: { plan } } });
  });

  it("rejects workflow status beyond its separate 2 MiB ceiling", async () => {
    const workflow = fakeWorkflow();
    workflow.getRun.mockReturnValueOnce({
      run: { runId: "run-too-large" },
      planning: { plan: { tasks: [{ acceptanceCriteria: ["x".repeat(2 * 1024 * 1024)] }] } },
    });

    const result = await invoke(["status", "run-too-large"], workflow.surface);

    expect(result).toMatchObject({ code: 1, stdout: "", json: {
      command: "status",
      error: { code: "OUTPUT_TOO_LARGE", message: "Operational output exceeded the limit." },
    } });
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThan(512);
  });

  it("keeps workflow list and mutation output at the legacy 16 KiB ceiling", async () => {
    const workflow = fakeWorkflow();
    workflow.listRuns.mockReturnValueOnce([{ runId: "x".repeat(20 * 1024) }]);
    const listed = await invoke(["list"], workflow.surface);
    workflow.cancelRun.mockReturnValueOnce({ outcome: "cancelled", detail: "x".repeat(20 * 1024) });
    const cancelled = await invoke([
      "cancel", "run-1", "--expected-version", "7", "--actor", "operator-1", "--command-id", "cancel-command",
    ], workflow.surface);

    for (const result of [listed, cancelled]) {
      expect(result).toMatchObject({ code: 1, stdout: "", json: {
        error: { code: "OUTPUT_TOO_LARGE", message: "Operational output exceeded the limit." },
      } });
      expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThan(512);
    }
  });

  it("records mixed question and plan actions with exact versions and digests", async () => {
    const workflow = fakeWorkflow();
    const common = ["--run-id", "run-1", "--expected-version", "4", "--actor", "operator", "--command-id"];

    const answered = await invoke(["question", "answer", "question-1", ...common, "answer-1", "--option-id", "yes"], workflow.surface);
    const questionRejected = await invoke(["question", "reject", "question-2", ...common, "reject-question-2", "--reason", "Need clarification"], workflow.surface);
    const approved = await invoke(["plan", "approve", "approval-1", ...common, "approve-1",
      "--plan-digest", "a".repeat(64), "--envelope-digest", "b".repeat(64)], workflow.surface);
    const planRejected = await invoke(["plan", "reject", "approval-2", ...common, "reject-plan-2", "--reason", "Revise scope"], workflow.surface);

    expect([answered.code, questionRejected.code, approved.code, planRejected.code]).toEqual([0, 0, 0, 0]);
    expect(workflow.answerQuestion).toHaveBeenCalledWith({ runId: "run-1", decisionId: "question-1",
      expectedVersion: 4, commandId: "answer-1", optionId: "yes" }, { actorId: "operator", channel: "cli" });
    expect(workflow.rejectQuestion).toHaveBeenCalledWith({ runId: "run-1", decisionId: "question-2",
      expectedVersion: 4, commandId: "reject-question-2", reason: "Need clarification" }, { actorId: "operator", channel: "cli" });
    expect(workflow.approvePlan).toHaveBeenCalledWith({ runId: "run-1", decisionId: "approval-1",
      expectedVersion: 4, commandId: "approve-1", planDigest: "a".repeat(64), envelopeDigest: "b".repeat(64) },
    { actorId: "operator", channel: "cli" });
    expect(workflow.rejectPlan).toHaveBeenCalledWith({ runId: "run-1", decisionId: "approval-2",
      expectedVersion: 4, commandId: "reject-plan-2", reason: "Revise scope" }, { actorId: "operator", channel: "cli" });
  });

  it.each([
    "not_found", "stale", "consumed", "expired", "digest_mismatch",
    "invalid_transition", "uncertain", "unavailable", "internal",
  ] as const)("maps the workflow surface %s error to bounded CLI JSON", async (code) => {
    const workflow = fakeWorkflow();
    workflow.answerQuestion.mockImplementationOnce(() => {
      throw new WorkflowSurfaceError(code, `dependency detail for ${code} SECRET`);
    });

    const result = await invoke(["question", "answer", "question-1", "--run-id", "run-1",
      "--expected-version", "4", "--actor", "operator", "--command-id", "answer-1", "--option-id", "yes"], workflow.surface);

    expect(result).toMatchObject({ code: 1, stdout: "", json: { command: "question.answer", error: { code } } });
    expect(result.stderr).not.toContain("SECRET");
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThan(512);
  });

  it("awaits asynchronous surface rejections and reports missing injection as unavailable", async () => {
    const workflow = fakeWorkflow();
    workflow.submitRun.mockRejectedValueOnce(new WorkflowSurfaceError("stale", "async SECRET"));

    const rejected = await invoke(["run", "Fix asynchronously"], workflow.surface);
    workflow.submitRun.mockRejectedValueOnce(new Error("untyped async SECRET"));
    const internal = await invoke(["run", "Fail asynchronously"], workflow.surface);
    const unavailable = await invoke(["list"]);

    expect(rejected).toMatchObject({ code: 1, stdout: "", json: {
      command: "run", error: { code: "stale", message: "Workflow state changed before the command was recorded." },
    } });
    expect(rejected.stderr).not.toContain("SECRET");
    expect(internal).toMatchObject({ code: 1, stdout: "", json: {
      command: "run", error: { code: "internal", message: "Workflow operation failed." },
    } });
    expect(internal.stderr).not.toContain("SECRET");
    expect(unavailable).toMatchObject({ code: 1, stdout: "", json: {
      command: "list", error: { code: "unavailable", message: "Workflow service is unavailable." },
    } });
  });

  it("documents every workflow command without exposing channel or evidence options", async () => {
    let stdout = "";
    const code = await runCli(["--help"], { stdout: (value) => { stdout += value; }, stderr: () => {} });

    expect(code).toBe(0);
    expect(stdout).toContain("run [options] [goal]");
    expect(stdout).toContain("list");
    expect(stdout).toContain("status <run-id>");
    expect(stdout).toContain("cancel [options] <run-id>");
    expect(stdout).toContain("question");
    expect(stdout).toContain("plan");
    expect(stdout).not.toContain("--channel");
    expect(stdout).not.toContain("--evidence");
  });
});

function fakeWorkflow() {
  const methods = {
    submitRun: vi.fn<(...args: unknown[]) => unknown>(() => ({ runId: "run-new" })),
    listRuns: vi.fn<(...args: unknown[]) => unknown>(() => [{ runId: "run-1" }]),
    getRun: vi.fn<(...args: unknown[]) => unknown>((runId) => ({ run: { runId } })),
    getSourceText: vi.fn<(...args: unknown[]) => unknown>(),
    getDecision: vi.fn<(...args: unknown[]) => unknown>(),
    listAttention: vi.fn<(...args: unknown[]) => unknown>(),
    getChanges: vi.fn<(...args: unknown[]) => unknown>(),
    cancelRun: vi.fn<(...args: unknown[]) => unknown>(() => ({ outcome: "cancelled" })),
    answerQuestion: vi.fn<(...args: unknown[]) => unknown>(() => ({ decision: { status: "accepted" } })),
    rejectQuestion: vi.fn<(...args: unknown[]) => unknown>(() => ({ decision: { status: "rejected" } })),
    approvePlan: vi.fn<(...args: unknown[]) => unknown>(() => ({ decision: { status: "accepted" } })),
    rejectPlan: vi.fn<(...args: unknown[]) => unknown>(() => ({ decision: { status: "rejected" } })),
  };
  return { ...methods, surface: methods as unknown as WorkflowSurface };
}

async function invoke(argv: readonly string[], workflowSurface?: WorkflowSurface) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
    ...(workflowSurface === undefined ? {} : { workflowSurface }),
  });
  const serialized = `${stdout}${stderr}`.trim();
  return { code, stdout, stderr, json: JSON.parse(serialized) as Record<string, unknown> };
}
