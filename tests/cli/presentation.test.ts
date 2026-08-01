import { describe, expect, it } from "vitest";

import {
  formatRunList,
  formatRunStatus,
  formatTimestamp,
  supportsColour,
  truncateMiddle,
} from "../../src/cli/presentation.js";

describe("workflow CLI presentation", () => {
  it("formats active, completed, failed, and cancelled list rows without internal fields", () => {
    const output = formatRunList([
      summary("run-active", "analyzing", null, "Active goal"),
      summary("run-complete", "terminal", "completed", "Completed goal"),
      summary("run-failed", "terminal", "failed", "Failed goal"),
      summary("run-cancelled", "terminal", "cancelled", "Cancelled goal"),
    ], { width: 156 });

    expect(output).toContain("Running");
    expect(output).toContain("Completed");
    expect(output).toContain("Failed");
    expect(output).toContain("Cancelled");
    expect(output).toContain("4 runs");
    expect(output).not.toContain("project-internal");
    expect(output).not.toContain("referenceSha256");
  });

  it("safely truncates long labels and paths at narrow terminal widths", () => {
    const hostileTitle = `A very long title ${"x".repeat(100)}\u001b[31m`;
    const output = formatRunList([
      {
        ...summary("run-12345678-1234-4234-8234-123456789abc", "analyzing", null, hostileTitle),
        presentation: {
          title: hostileTitle,
          projectName: `A very long project ${"y".repeat(100)}`,
          workspace: `/Users/operator/${"deep/".repeat(60)}zentra`,
          sourceLabel: "Inline goal",
        },
      },
    ], { width: 60 });

    expect(output).toContain("…");
    expect(output).not.toContain("\u001b");
    for (const line of output.trimEnd().split("\n")) expect(Array.from(line).length).toBeLessThanOrEqual(60);
  });

  it("renders safe failed, cancelled, question, and approval status summaries", () => {
    const failed = formatRunStatus(detail("terminal", "failed"));
    const cancelled = formatRunStatus(detail("terminal", "cancelled"));
    const question = formatRunStatus(detail("waiting", null, "question"));
    const approval = formatRunStatus(detail("awaiting_approval", null, "approval"));

    expect(failed).toContain("The run failed during analysis.");
    expect(failed).not.toContain("secret diagnostic");
    expect(cancelled).toContain("cancelled by the operator during analysis");
    expect(question).toContain("Question requires a response");
    expect(question).toContain("Analysis:  Waiting for answer");
    expect(approval).toContain("Approval required");
    expect(approval).toContain("Approval:  Waiting");
  });

  it("keeps verbose output public and deterministic", () => {
    const first = formatRunStatus(detail("terminal", "cancelled"), { verbose: true });
    const second = formatRunStatus(detail("terminal", "cancelled"), { verbose: true });

    expect(first).toBe(second);
    expect(first).toContain("Details");
    expect(first).toContain("Project ID:        project-internal");
    expect(first).not.toContain("process-v2");
    expect(first).not.toContain("pid");
  });

  it("formats timestamps and Unicode truncation deterministically", () => {
    expect(formatTimestamp("2026-07-28T15:55:46.257Z", "long")).toMatch(/^28 July 2026 at /);
    expect(truncateMiddle("run-😀-123456789", 10)).toHaveLength(11);
    expect(Array.from(truncateMiddle("run-😀-123456789", 10))).toHaveLength(10);
  });

  it("never makes colour part of redirected or NO_COLOR output", () => {
    expect(supportsColour({ isTTY: false })).toBe(false);
    expect(supportsColour({ isTTY: true, noColor: "1" })).toBe(false);
    expect(formatRunList([summary("run-1", "analyzing", null, "Goal")])).not.toMatch(/\u001b\[/u);
  });
});

function summary(runId: string, lifecycle: string, terminalOutcome: string | null, title: string) {
  return {
    schemaVersion: 1,
    runId,
    projectId: "project-internal",
    title,
    project: { schemaVersion: 1, projectId: "project-internal", title: "Zentra", repositoryPath: "/Users/operator/Projects/zentra" },
    source: {
      kind: "inline_goal",
      referenceSha256: "a".repeat(64),
      declaredBytes: 10,
      submittedFrom: { path: "/Users/operator/Projects/zentra/packages/cli", projectRelativePath: "packages/cli" },
    },
    lifecycle,
    terminalOutcome,
    streamVersion: 6,
    approvalState: "not_proposed",
    acceptedAt: "2026-07-28T15:55:46.257Z",
    presentation: {
      title,
      projectName: "Zentra",
      workspace: "/Users/operator/Projects/zentra",
      sourceLabel: "Inline goal",
    },
  };
}

function detail(lifecycle: string, terminalOutcome: string | null, attentionKind?: "question" | "approval") {
  const attention = attentionKind === undefined ? [] : [{
    kind: attentionKind,
    status: "pending",
    material: true,
  }];
  return {
    schemaVersion: 1,
    acceptedAt: "2026-07-28T15:55:46.257Z",
    updatedAt: "2026-07-28T15:58:00.000Z",
    presentation: summary("run-1", lifecycle, terminalOutcome, "Fix authentication").presentation,
    run: {
      runId: "run-1",
      projectId: "project-internal",
      title: "Fix authentication",
      project: { schemaVersion: 1, projectId: "project-internal", title: "Zentra", repositoryPath: "/Users/operator/Projects/zentra" },
      source: { kind: "inline_goal", submittedFrom: { path: "/Users/operator/Projects/zentra/packages/cli", projectRelativePath: "packages/cli" } },
      lifecycle,
      terminalOutcome,
      suspendedFrom: lifecycle === "waiting" ? "analyzing" : null,
      streamVersion: 6,
      authority: { approvalState: lifecycle === "awaiting_approval" ? "approval_pending" : "not_proposed" },
      cancellation: terminalOutcome === "cancelled" ? { reasonCode: "operator_requested", observedLifecycle: "analyzing" } : null,
      process: { pid: 42, processIncarnation: "process-v2:secret diagnostic" },
    },
    intake: { status: "closed", sourceCount: 1, rejectedCount: 0 },
    analysis: { status: attentionKind === "question" ? "awaiting_answer" : terminalOutcome === "failed" ? "failed" : "cancelled" },
    planning: { status: "not_started" },
    attention,
  };
}
