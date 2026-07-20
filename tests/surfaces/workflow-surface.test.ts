import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AttentionService } from "../../src/attention/attention-service.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import { computeIntakeSnapshotSha256 } from "../../src/intake/intake-contracts.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { PlanningCoordinator } from "../../src/planning/planning-coordinator.js";
import { APPROVED_VALIDATION_EXECUTABLE, ProjectConfigSchema, createValidationIdentitySnapshot } from "../../src/projects/project-config.js";
import { RunService } from "../../src/runs/run-service.js";
import {
  WorkflowSurface,
  WorkflowSurfaceError,
  type RunAdvanceRequest,
  type RunAdvancer,
  type RunSubmission,
  type RunSubmitter,
  type WorkflowChannel,
} from "../../src/surfaces/workflow-surface.js";
import { planningProposalFixture } from "../planning/planning-fixture.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("WorkflowSurface", () => {
  it("delegates each validated intake submission exactly once with the caller channel", () => {
    const fixture = basicFixture();
    const submit = vi.fn((input: RunSubmission, _caller: { readonly actorId: string; readonly channel: WorkflowChannel }) => ({ runId: input.kind }));
    const surface = surfaceFor(fixture.journal, { submit });

    expect(surface.submitRun({ kind: "inline_goal", commandId: "submit-inline", goal: "Fix the parser" }, { actorId: "operator", channel: "cli" }))
      .toEqual({ runId: "inline_goal" });
    expect(surface.submitRun({ kind: "ticket_directory", commandId: "submit-tickets", directoryPath: "/tmp/tickets" }, { actorId: "operator", channel: "ui" }))
      .toEqual({ runId: "ticket_directory" });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[1]).toEqual({ actorId: "operator", channel: "ui" });
    fixture.journal.close();
  });

  it("lists accepted streams by bounded replay and rebuilds stable detail after restart", () => {
    const directory = temporaryDirectory();
    const database = path.join(directory, "workflow.sqlite");
    const journal = new SqliteEventJournal(database);
    seedAcceptedRun(journal, "run-old", "inline_goal");
    seedAcceptedRun(journal, "run-new", "ticket_directory");
    const attention = new AttentionService(journal);
    attention.requestQuestion(question("run-new", "question-new", "attention-new", false));
    const first = surfaceFor(journal).getRun("run-new");

    expect(surfaceFor(journal).listRuns().map((run) => run.runId)).toEqual(["run-new", "run-old"]);
    expect(first).toMatchObject({
      schemaVersion: 1,
      run: { runId: "run-new", lifecycle: "accepted" },
      intake: { status: "pending", sourceKind: "ticket_directory", sources: [] },
      analysis: { status: "not_started", rounds: [] },
      questions: [{ decisionId: "question-new", status: "pending" }],
      planning: { status: "not_started", readiness: { ready: false } },
    });
    expect(JSON.stringify(first)).not.toContain("quotedText");
    journal.close();

    const reopened = new SqliteEventJournal(database);
    expect(surfaceFor(reopened).getRun("run-new")).toEqual(first);
    reopened.close();
  });

  it("keeps run detail metadata-only and reads verified text through exact run and source binding", () => {
    const fixture = basicFixture();
    seedIntakeAndAnalysisRun(fixture.journal);

    const readRetainedText = vi.fn(() => "Raw ticket contents");
    const surface = surfaceFor(fixture.journal, undefined, undefined, { readRetainedText });
    const detail = surface.getRun("run-detail");

    expect(detail).toMatchObject({
      intake: {
        status: "closed", sourceCount: 1, rejectedCount: 0, totalBytes: 19,
        sources: [{ status: "accepted", relativePath: "ticket.md", sizeBytes: 19,
          trust: "untrusted_planning_data",
          mediaType: "text/plain; charset=utf-8",
          provenance: { sourceKind: "ticket_directory" } }],
      },
      analysis: {
        status: "awaiting_answer", streamVersion: 3,
        rounds: [{ round: 1, observations: [{ observationId: "observation-1" }],
          uncertainties: [{ uncertaintyId: "uncertainty-1", materiality: "material" }],
          usage: { inputTokens: 10, outputTokens: 5 } }],
      },
    });
    expect(readRetainedText).not.toHaveBeenCalled();
    const source = detail!.intake.sources[0]!;
    expect(surface.getSourceText("run-detail", source.sourceId)).toEqual({
      schemaVersion: 1,
      runId: "run-detail",
      sourceId: source.sourceId,
      relativePath: "ticket.md",
      sizeBytes: 19,
      acceptedMaxBytes: 10_000,
      digest: source.digest,
      mediaType: "text/plain; charset=utf-8",
      trust: "untrusted_planning_data",
      artifact: source.artifact,
      text: "Raw ticket contents",
    });
    expect(readRetainedText).toHaveBeenCalledOnce();
    expect(() => surface.getSourceText("run-old", source.sourceId)).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(() => surface.getSourceText("run-detail", "source-v1:" + "0".repeat(64)))
      .toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(JSON.stringify(surface.listRuns())).not.toContain("Raw ticket contents");
    expect(JSON.stringify(detail)).not.toContain("Raw ticket contents");
    expect(JSON.stringify(detail)).not.toContain("quotedText");
    fixture.journal.close();
  });

  it.each(["cli", "ui"] as const)("answers questions through the %s channel with canonical evidence", (channel) => {
    const fixture = questionFixture(channel);
    const result = fixture.surface.answerQuestion({
      runId: fixture.runId,
      decisionId: fixture.decisionId,
      expectedVersion: fixture.version,
      commandId: "answer-command",
      optionId: "yes",
    }, { actorId: "operator-1", channel });

    expect(result).toMatchObject({ schemaVersion: 1, decision: { status: "accepted" }, run: { runId: fixture.runId } });
    expect(result.decision.resolution).toMatchObject({ optionId: "yes", actor: { channel } });
    const evidence = (result.decision.resolution as { evidenceSha256: string }).evidenceSha256;
    expect(evidence).toBe(digestCanonical({
      schemaVersion: 1,
      action: "answer_question",
      input: { runId: fixture.runId, decisionId: fixture.decisionId, expectedVersion: fixture.version,
        commandId: "answer-command", optionId: "yes" },
      actor: { actorId: "operator-1", kind: "operator", channel },
    }));
    fixture.journal.close();
  });

  it("rejects stale and double question decisions while preserving the accepted decision", () => {
    const fixture = questionFixture("cli");
    const command = { runId: fixture.runId, decisionId: fixture.decisionId, commandId: "reject-command", reason: "Need another route." };

    expect(() => fixture.surface.rejectQuestion({ ...command, expectedVersion: fixture.version - 1 },
      { actorId: "operator", channel: "cli" })).toThrow(/expected version/i);
    const rejected = fixture.surface.rejectQuestion({ ...command, expectedVersion: fixture.version },
      { actorId: "operator", channel: "cli" });
    expect(rejected.decision.status).toBe("rejected");
    expect(() => fixture.surface.rejectQuestion({ ...command, commandId: "reject-again", expectedVersion: fixture.version },
      { actorId: "operator", channel: "ui" })).toThrow(/already consumed/i);
    expect(fixture.surface.getDecision(fixture.decisionId)?.status).toBe("rejected");
    fixture.journal.close();
  });

  it("advances exactly once per answered or rejected question across multiple rounds and retries idempotently", () => {
    const { journal } = basicFixture();
    const runId = "run-rounds";
    seedAcceptedRun(journal, runId, "inline_goal");
    const attention = new AttentionService(journal);
    const first = attention.requestQuestion(question(runId, "decision-round-1", "attention-round-1", false));
    let failFirstAdvance = true;
    const advance = vi.fn((request: RunAdvanceRequest) => {
      if (request.decisionId === "decision-round-1" && failFirstAdvance) {
        failFirstAdvance = false;
        throw new Error("coordinator restarting");
      }
      if (request.decisionId === "decision-round-1" && attention.getDecision("decision-round-2") === null) {
        attention.requestQuestion(question(runId, "decision-round-2", "attention-round-2", false));
      }
    });
    const surface = surfaceFor(journal, undefined, { advance });
    const firstCommand = { runId, decisionId: "decision-round-1", expectedVersion: first.streamVersion,
      commandId: "answer-round-1", optionId: "yes" };

    expect(() => surface.answerQuestion(firstCommand, { actorId: "operator", channel: "cli" }))
      .toThrowError(expect.objectContaining({ code: "unavailable" }));
    const retried = surface.answerQuestion(firstCommand, { actorId: "operator", channel: "cli" });
    expect(retried.decision.status).toBe("accepted");
    expect(surface.answerQuestion(firstCommand, { actorId: "operator", channel: "cli" })).toEqual(retried);
    const second = surface.getDecision("decision-round-2")!;
    const rejected = surface.rejectQuestion({ runId, decisionId: second.decisionId,
      expectedVersion: second.streamVersion, commandId: "reject-round-2", reason: "Use the first interpretation." },
    { actorId: "operator", channel: "ui" });

    expect(rejected.decision.status).toBe("rejected");
    expect(advance.mock.calls.map(([request]) => request.decisionId)).toEqual([
      "decision-round-1", "decision-round-1", "decision-round-2",
    ]);
    expect(new Set(advance.mock.calls.map(([request]) => request.advanceId)).size).toBe(2);
    expect(surface.getRun(runId)?.questions).toHaveLength(2);
    journal.close();
  });

  it("recovers answer and rejection crashes after decision consumption but before advancement intent", () => {
    const { journal, directory } = basicFixture();
    const runId = "run-consumed-recovery";
    seedAcceptedRun(journal, runId, "inline_goal");
    const attention = new AttentionService(journal);
    const answeredRequest = attention.requestQuestion(question(runId, "decision-consumed-answer", "attention-consumed-answer", false));
    const rejectedRequest = attention.requestQuestion(question(runId, "decision-consumed-reject", "attention-consumed-reject", false));
    const actor = { actorId: "operator", kind: "operator" as const, channel: "cli" as const };
    const answerInput = { runId, decisionId: answeredRequest.decisionId, expectedVersion: answeredRequest.streamVersion,
      commandId: "consumed-answer", optionId: "yes" };
    const rejectInput = { runId, decisionId: rejectedRequest.decisionId, expectedVersion: rejectedRequest.streamVersion,
      commandId: "consumed-reject", reason: "Use another interpretation." };

    attention.answer(answerInput.decisionId, { ...answerInput, actor,
      evidenceSha256: decisionEvidence("answer_question", answerInput, actor) });
    attention.reject(rejectInput.decisionId, { ...rejectInput, actor,
      evidenceSha256: decisionEvidence("reject_question", rejectInput, actor) });
    expect(journal.readAll().map((event) => event.type)).not.toContain("workflow.run_advancement_requested");
    journal.close();

    const advance = vi.fn();
    const reopened = new SqliteEventJournal(path.join(directory, "events.sqlite"));
    const surface = surfaceFor(reopened, undefined, { advance });
    const answered = surface.answerQuestion(answerInput, { actorId: actor.actorId, channel: actor.channel });
    const rejected = surface.rejectQuestion(rejectInput, { actorId: actor.actorId, channel: actor.channel });

    expect(answered.decision.status).toBe("accepted");
    expect(rejected.decision.status).toBe("rejected");
    expect(advance).toHaveBeenCalledTimes(2);
    expect(surface.answerQuestion(answerInput, { actorId: actor.actorId, channel: actor.channel })).toEqual(answered);
    expect(surface.rejectQuestion(rejectInput, { actorId: actor.actorId, channel: actor.channel })).toEqual(rejected);
    expect(advance).toHaveBeenCalledTimes(2);
    const advancementTypes = reopened.readAll().map((event) => event.type)
      .filter((type) => type.startsWith("workflow.run_advance"));
    expect(advancementTypes).toEqual([
      "workflow.run_advancement_requested", "workflow.run_advanced",
      "workflow.run_advancement_requested", "workflow.run_advanced",
    ]);
    reopened.close();
  });

  it("rejects mismatched answer and rejection retries in the pre-intent crash window", () => {
    const { journal } = basicFixture();
    const runId = "run-consumed-mismatch";
    seedAcceptedRun(journal, runId, "inline_goal");
    const attention = new AttentionService(journal);
    const answeredRequest = attention.requestQuestion(question(runId, "decision-mismatch-answer", "attention-mismatch-answer", false));
    const rejectedRequest = attention.requestQuestion(question(runId, "decision-mismatch-reject", "attention-mismatch-reject", false));
    const actor = { actorId: "operator", kind: "operator" as const, channel: "ui" as const };
    const answerInput = { runId, decisionId: answeredRequest.decisionId, expectedVersion: answeredRequest.streamVersion,
      commandId: "mismatch-answer", optionId: "yes" };
    const rejectInput = { runId, decisionId: rejectedRequest.decisionId, expectedVersion: rejectedRequest.streamVersion,
      commandId: "mismatch-reject", reason: "Original reason." };
    attention.answer(answerInput.decisionId, { ...answerInput, actor,
      evidenceSha256: decisionEvidence("answer_question", answerInput, actor) });
    attention.reject(rejectInput.decisionId, { ...rejectInput, actor,
      evidenceSha256: decisionEvidence("reject_question", rejectInput, actor) });
    const advance = vi.fn();
    const surface = surfaceFor(journal, undefined, { advance });

    const answerMismatch = captureError(() => surface.answerQuestion({ ...answerInput, optionId: "no" },
      { actorId: actor.actorId, channel: actor.channel }));
    const rejectionMismatch = captureError(() => surface.rejectQuestion({ ...rejectInput, reason: "Changed reason." },
      { actorId: actor.actorId, channel: actor.channel }));

    expect(answerMismatch).toMatchObject({ code: "digest_mismatch" });
    expect(rejectionMismatch).toMatchObject({ code: "digest_mismatch" });
    expect(advance).not.toHaveBeenCalled();
    expect(journal.readAll().map((event) => event.type)).not.toContain("workflow.run_advancement_requested");
    journal.close();
  });

  it("pages every journal change with stable cursors and resumes from high-water after restart", () => {
    const directory = temporaryDirectory();
    const database = path.join(directory, "changes.sqlite");
    const journal = new SqliteEventJournal(database);
    seedAcceptedRun(journal, "run-changes", "inline_goal");
    const attention = new AttentionService(journal);
    attention.requestQuestion(question("run-changes", "decision-changes", "attention-changes", false));
    const surface = surfaceFor(journal);
    const first = surface.getChanges(0, 2);
    const second = surface.getChanges(first.nextCursor, 2);

    expect(first.changes).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(second.afterPosition).toBe(first.nextCursor);
    expect(second.highWaterPosition).toBe(first.highWaterPosition);
    const initialChanges = [...first.changes, ...second.changes];
    let cursor = second.nextCursor;
    while (cursor < second.highWaterPosition) {
      const page = surface.getChanges(cursor, 2);
      initialChanges.push(...page.changes);
      cursor = page.nextCursor;
    }
    expect(initialChanges.map((change) => change.type)).toContain("questionnaire.proposed");
    journal.close();

    const reopened = new SqliteEventJournal(database);
    const resumed = surfaceFor(reopened);
    resumed.cancelRun({ runId: "run-changes", expectedVersion: 1, commandId: "cancel-from-cli",
      cancellationId: "cancel-changes" }, { actorId: "operator", channel: "cli" });
    const appended = resumed.getChanges(cursor, 100);
    expect(appended.afterPosition).toBe(cursor);
    expect(appended.highWaterPosition).toBeGreaterThan(cursor);
    expect(appended.changes.map((change) => change.type)).toEqual([
      "workflow.cancel_requested", "run.cancelled",
    ]);
    expect(appended.nextCursor).toBe(appended.highWaterPosition);
    reopened.close();
  });

  it("normalizes domain failures into the closed shared error vocabulary", () => {
    const fixture = questionFixture("cli");
    const stale = captureError(() => fixture.surface.answerQuestion({ runId: fixture.runId,
      decisionId: fixture.decisionId, expectedVersion: fixture.version - 1, commandId: "stale-error", optionId: "yes" },
    { actorId: "operator", channel: "cli" }));
    expect(stale).toMatchObject({ code: "stale" });
    expect(stale).toBeInstanceOf(WorkflowSurfaceError);

    const missing = captureError(() => fixture.surface.cancelRun({ runId: "missing-run", expectedVersion: 1,
      commandId: "missing", cancellationId: "missing" }, { actorId: "operator", channel: "ui" }));
    expect(missing).toMatchObject({ code: "not_found" });

    fixture.surface.answerQuestion({ runId: fixture.runId, decisionId: fixture.decisionId,
      expectedVersion: fixture.version, commandId: "consume-error", optionId: "yes" },
    { actorId: "operator", channel: "cli" });
    const consumed = captureError(() => fixture.surface.rejectQuestion({ runId: fixture.runId,
      decisionId: fixture.decisionId, expectedVersion: fixture.version, commandId: "consumed-error", reason: "No." },
    { actorId: "operator", channel: "cli" }));
    expect(consumed).toMatchObject({ code: "consumed" });

    const invalid = captureError(() => fixture.surface.submitRun({ kind: "inline_goal", commandId: "invalid-goal", goal: " " },
      { actorId: "operator", channel: "cli" }));
    expect(invalid).toMatchObject({ code: "invalid_transition" });

    const attention = new AttentionService(fixture.journal);
    const expiredDecision = attention.requestQuestion({
      ...question(fixture.runId, "decision-expired", "attention-expired", false),
      expiryPolicy: { kind: "at" as const, expiresAt: "2026-07-20T11:00:00.000Z" },
    });
    const expired = captureError(() => fixture.surface.answerQuestion({ runId: fixture.runId,
      decisionId: expiredDecision.decisionId, expectedVersion: expiredDecision.streamVersion,
      commandId: "expired-error", optionId: "yes" }, { actorId: "operator", channel: "ui" }));
    expect(expired).toMatchObject({ code: "expired" });

    const broken = surfaceFor(fixture.journal, { submit: () => { throw new Error("adapter rupture"); } });
    const internal = captureError(() => broken.submitRun({ kind: "inline_goal", commandId: "broken-submit", goal: "Valid goal" },
      { actorId: "operator", channel: "cli" }));
    expect(internal).toMatchObject({ code: "internal" });
    fixture.journal.close();
  });

  it("cancels with the expected run version and replays the terminal projection", () => {
    const fixture = basicFixture();
    seedAcceptedRun(fixture.journal, "run-cancel", "inline_goal");
    const surface = surfaceFor(fixture.journal);

    expect(() => surface.cancelRun({ runId: "run-cancel", expectedVersion: 0, commandId: "cancel-stale",
      cancellationId: "cancel-1" }, { actorId: "operator", channel: "ui" })).toThrow(/expected version/i);
    const cancelled = surface.cancelRun({ runId: "run-cancel", expectedVersion: 1, commandId: "cancel-run",
      cancellationId: "cancel-1" }, { actorId: "operator", channel: "ui" });
    expect(cancelled.run).toMatchObject({ lifecycle: "terminal", terminalOutcome: "cancelled" });
    expect(cancelled.commandEvidence).toEqual([expect.objectContaining({
      kind: "cancellation_requested", commandId: "cancel-run", actor: { actorId: "operator", kind: "operator", channel: "ui" },
      evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    expect(new RunService(fixture.journal).reopen("run-cancel")).toEqual(cancelled.run);
    fixture.journal.close();
    const reopened = new SqliteEventJournal(path.join(fixture.directory, "events.sqlite"));
    expect(surfaceFor(reopened).getRun("run-cancel")?.commandEvidence).toEqual(cancelled.commandEvidence);
    reopened.close();
  });

  it("approves only exact planning digests and rejects plans through PlanningCoordinator", () => {
    const approvedFixture = planningFixture("approve");
    const mismatch = captureError(() => approvedFixture.surface.approvePlan({
      runId: "run-93", decisionId: approvedFixture.approval.decisionId,
      expectedVersion: approvedFixture.approval.streamVersion, commandId: "approve-wrong",
      planDigest: "0".repeat(64), envelopeDigest: approvedFixture.planning.envelopeDigest,
    }, { actorId: "operator", channel: "cli" }));
    expect(mismatch).toMatchObject({ code: "digest_mismatch" });
    const approved = approvedFixture.surface.approvePlan({
      runId: "run-93", decisionId: approvedFixture.approval.decisionId,
      expectedVersion: approvedFixture.approval.streamVersion, commandId: "approve-exact",
      planDigest: approvedFixture.planning.planDigest, envelopeDigest: approvedFixture.planning.envelopeDigest,
    }, { actorId: "operator", channel: "ui" });
    expect(approved).toMatchObject({
      decision: { status: "accepted", resolution: { actor: { channel: "ui" } } },
      run: { lifecycle: "approved_and_ready_for_execution" },
      planning: { readiness: { ready: true }, dag: { milestoneId: "milestone-93" } },
    });
    approvedFixture.journal.close();

    const rejectedFixture = planningFixture("reject");
    const rejected = rejectedFixture.surface.rejectPlan({
      runId: "run-93", decisionId: rejectedFixture.approval.decisionId,
      expectedVersion: rejectedFixture.approval.streamVersion, commandId: "reject-plan",
      reason: "Keep the correction within reviewed scope.",
    }, { actorId: "operator", channel: "cli" });
    expect(rejected).toMatchObject({
      decision: { status: "rejected", resolution: { actor: { channel: "cli" } } },
      run: { lifecycle: "planning", authority: { approvalState: "rejected" } },
      planning: { status: "correction_pending", rejection: { reason: "Keep the correction within reviewed scope." } },
    });
    expect(rejectedFixture.planningCoordinator.get("run-93")?.lifecycle).toBe("correction_pending");
    rejectedFixture.journal.close();
  });
});

function basicFixture() {
  const directory = temporaryDirectory();
  return { directory, journal: new SqliteEventJournal(path.join(directory, "events.sqlite")) };
}

function surfaceFor<TResult = unknown>(journal: SqliteEventJournal, submitter: RunSubmitter<TResult> = {
  submit: () => { throw new Error("run submitter was not configured"); },
}, advancer: RunAdvancer = { advance: () => undefined }, artifactTextReader?: {
  readonly readRetainedText: (artifact: { readonly artifactId: string; readonly sha256: string; readonly sizeBytes: number }) => string;
}): WorkflowSurface<TResult> {
  const runs = new RunService(journal);
  const attention = new AttentionService(journal, () => new Date("2026-07-20T12:00:00.000Z"));
  return new WorkflowSurface(journal, runs, attention, new PlanningCoordinator(journal, runs, attention, []), submitter, advancer,
    artifactTextReader);
}

function questionFixture(channel: WorkflowChannel) {
  const { journal } = basicFixture();
  const runId = `run-question-${channel}`;
  const decisionId = `decision-${channel}`;
  seedAcceptedRun(journal, runId, "inline_goal");
  const attention = new AttentionService(journal);
  const requested = attention.requestQuestion(question(runId, decisionId, `attention-${channel}`, false));
  return { journal, runId, decisionId, version: requested.streamVersion, surface: surfaceFor(journal) };
}

function question(runId: string, decisionId: string, attentionId: string, material: boolean) {
  return {
    decisionId, attentionId, runId, question: "Proceed with this interpretation?",
    options: [
      { optionId: "yes", label: "Proceed", impacts: ["Uses the proposed interpretation."] },
      { optionId: "no", label: "Stop", impacts: ["Stops this path."] },
    ],
    recommendation: { optionId: "yes", rationale: "It is bounded." },
    impacts: ["Changes analysis state."], affectedScopes: ["scope:one"], dependentScopes: [],
    material, evidenceSha256: "4".repeat(64), commandId: `request-${decisionId}`,
  };
}

function seedAcceptedRun(journal: SqliteEventJournal, runId: string, kind: "inline_goal" | "ticket_directory"): void {
  const streamId = `run:${runId}`;
  journal.append(streamId, 0, [{
    streamId, type: "run.accepted", causationId: "service-ready", correlationId: runId,
    payload: {
      schemaVersion: 1, runVersion: 1, runId, projectId: "zentra",
      projectRevision: { objectFormat: "sha1", commit: "a".repeat(40) },
      source: { kind, referenceSha256: "7".repeat(64), declaredBytes: 12 },
      actor: { actorId: "operator", kind: "operator" },
      process: { pid: 123, processIncarnation: `process-v2:${"d".repeat(64)}` },
      budget: { maxDurationMs: 60_000, maxInputTokens: 1_000, maxOutputTokens: 1_000,
        maxCostUsdNano: 1_000_000_000, maxRetries: 1, maxSourceFiles: 10, maxSourceBytes: 10_000 },
      authority: { approvalState: "not_proposed", planDigest: null, envelopeDigest: null,
        approvalDecisionId: null, executionAuthority: "none" }, commandId: `accept-${runId}`,
    },
  }]);
}

function seedIntakeAndAnalysisRun(journal: SqliteEventJournal): void {
  const runId = "run-detail";
  seedAcceptedRun(journal, runId, "ticket_directory");
  const process = { pid: 123, processIncarnation: `process-v2:${"d".repeat(64)}` };
  const runStream = `run:${runId}`;
  const sourceStream = `source-intake:${createHash("sha256").update(runId).digest("hex")}`;
  const contentDigest = createHash("sha256").update("Raw ticket contents").digest("hex");
  const provenance = {
    runId, projectId: "zentra", projectRevision: { objectFormat: "sha1" as const, commit: "a".repeat(40) },
    sourceKind: "ticket_directory" as const, rootIdentitySha256: "1".repeat(64),
    device: "1", inode: "2", modifiedNanoseconds: "3", changedNanoseconds: "4",
  };
  const limits = { maxFileBytes: 10_000, maxFiles: 10, maxTotalBytes: 10_000,
    maxDepth: 4, maxEntries: 20, maxDirectoryEntries: 20 };
  const source = {
    schemaVersion: 1 as const, runId, projectId: "zentra", commandId: "intake-detail",
    requestSha256: "2".repeat(64), eventIndex: 0, evidenceCount: 1,
    sourceKind: "ticket_directory" as const, limits, snapshotTotalBytes: 19, path: "ticket.md", provenance,
    sourceId: `source-v1:${createHash("sha256").update(`${runId}\0ticket.md\0${contentDigest}`).digest("hex")}`,
    sizeBytes: 19, digest: contentDigest, trust: "untrusted_planning_data" as const,
    mediaType: "text/plain; charset=utf-8" as const,
    artifact: { artifactId: `intake-text-v1:${contentDigest}`, sha256: contentDigest, sizeBytes: 19 },
  };
  const snapshotSha256 = computeIntakeSnapshotSha256({
    closure: { schemaVersion: 1, runId, projectId: "zentra", projectRevision: provenance.projectRevision,
      commandId: "intake-detail", requestSha256: "2".repeat(64), sourceKind: "ticket_directory",
      limits, totalBytes: 19 },
    discovered: [source], rejected: [],
  });
  const closureEventId = "00000000-0000-4000-8000-000000000094";
  journal.append(sourceStream, 0, [
    { streamId: sourceStream, type: "source.discovered", payload: source,
      causationId: "preflight-detail", correlationId: runId },
    { streamId: sourceStream, type: "intake.snapshot_closed", causationId: null, correlationId: runId,
      eventId: closureEventId, payload: {
        schemaVersion: 1, runId, projectId: "zentra", projectRevision: provenance.projectRevision,
        commandId: "intake-detail", requestSha256: "2".repeat(64), sourceKind: "ticket_directory",
        limits, snapshotSha256, sourceCount: 1, rejectedCount: 0, totalBytes: 19, evidenceCount: 1,
      } },
  ]);
  const intake = { sourceStreamId: sourceStream, closureEventId, snapshotSha256, sourceCount: 1, rejectedCount: 0, totalBytes: 19 };
  journal.append(runStream, 1, [
    { streamId: runStream, type: "preflight.started", causationId: null, correlationId: runId,
      payload: { schemaVersion: 1, runId, process, commandId: "detail-preflight-start", executionAuthority: "none" } },
    { streamId: runStream, type: "preflight.completed", causationId: null, correlationId: runId,
      payload: { schemaVersion: 1, runId, process, commandId: "detail-preflight-complete", executionAuthority: "none" } },
    { streamId: runStream, type: "run.intake_completed", causationId: closureEventId, correlationId: runId,
      payload: { schemaVersion: 1, commandId: "detail-intake-complete", intake, executionAuthority: "none" } },
  ]);
  const analysisStream = `analysis:${runId}`;
  const budget = { maxRounds: 3, maxObservations: 10, maxQuestions: 5, maxOptionsPerQuestion: 4,
    maxQuestionnaireOptions: 10, maxOutputBytes: 10_000, maxDurationMs: 10_000,
    maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsdNano: 1_000_000 };
  const usage = { inputTokens: 10, outputTokens: 5, inputBytes: 100, outputBytes: 50,
    durationMs: 100, costUsdNano: 50, modelReceiptSha256: "3".repeat(64) };
  journal.append(analysisStream, 0, [
    { streamId: analysisStream, type: "analysis.started", causationId: closureEventId, correlationId: runId,
      payload: { schemaVersion: 1, runId, snapshotSha256, sourceEvidenceSha256: "4".repeat(64),
        budget, sourceCount: 1, commandId: "analysis-start", authority: "none" } },
    { streamId: analysisStream, type: "analysis.invocation_reserved", causationId: null, correlationId: runId,
      eventId: "00000000-0000-4000-8000-000000000095", payload: { schemaVersion: 1, runId, round: 1,
        requestSha256: "5".repeat(64), sourceEvidenceSha256: "4".repeat(64), budget,
        reservationId: "reservation-1", budgetReservationEventId: "budget-reservation-1",
        runStreamVersion: 4, commandId: "analysis-reserve", authority: "none" } },
    { streamId: analysisStream, type: "analysis.observed", causationId: "00000000-0000-4000-8000-000000000095", correlationId: runId,
      payload: { schemaVersion: 1, runId, round: 1,
        observations: [{ observationId: "observation-1", summary: "The parser needs one bounded change.",
          sourceIds: [source.sourceId], repositoryPaths: ["src/parser.ts"], affectedScopes: ["scope:parser"] }],
        uncertainties: [{ uncertaintyId: "uncertainty-1", question: "Which behavior is intended?", materiality: "material",
          affectedScopes: ["scope:parser"], dependentScopes: [],
          options: [{ optionId: "strict", label: "Use strict behavior", impacts: ["Rejects invalid input."] }],
          recommendation: { optionId: "strict", rationale: "It is bounded." } }],
        usage, sourceEvidenceSha256: "4".repeat(64), commandId: "analysis-observe",
        authority: "none", reservationEventId: "00000000-0000-4000-8000-000000000095" },
    },
  ]);
}

function planningFixture(suffix: string) {
  const { directory, journal } = basicFixture();
  seedPlanningRun(journal);
  const project = ProjectConfigSchema.parse({
    projectId: "zentra", repositoryPath: directory, worktreeRoot: path.join(directory, "worktrees"),
    validations: { focused: [APPROVED_VALIDATION_EXECUTABLE, "--test"], full: [APPROVED_VALIDATION_EXECUTABLE, "--test"] },
  });
  const security = {
    allowedRepositories: [directory], allowedFileScopes: ["src/**"], forbiddenPaths: ["secrets"],
    network: { default: "denied" as const, allowedDestinations: [] }, secretHandling: ["Never expose secrets."],
    approvalRequiredOperations: ["external_effect"], releaseBoundary: "no_release_operations",
    stopAndAskConditions: ["forbidden_file_scope"],
  };
  const capabilities = [{ capabilityId: "worker-1", agentId: "worker-1", role: "implementer" as const, harness: "deterministic" as const }];
  const proposal = planningProposalFixture();
  proposal.analysisEvidence.completionEventId = analysisCompletionEventId;
  proposal.securityDigest = digestCanonical(security);
  proposal.capabilityCatalogDigest = digestCanonical(capabilities);
  proposal.validationIdentities = [createValidationIdentitySnapshot(project, "focused")];
  const runs = new RunService(journal);
  const attention = new AttentionService(journal, () => new Date("2026-07-20T12:00:00.000Z"));
  const planningCoordinator = new PlanningCoordinator(journal, runs, attention, capabilities);
  const requested = planningCoordinator.propose({ proposal, project, security,
    decisionId: `approval-${suffix}`, attentionId: `attention-${suffix}`,
    expiresAt: "2026-07-21T00:00:00.000Z", commandId: `proposal-${suffix}` });
  return {
    journal, planningCoordinator, planning: requested.planning, approval: requested.approval,
    surface: new WorkflowSurface(journal, runs, attention, planningCoordinator,
      { submit: () => null }, { advance: () => undefined }),
  };
}

function seedPlanningRun(journal: SqliteEventJournal): void {
  const streamId = "run:run-93";
  const process = { pid: 123, processIncarnation: `process-v2:${"d".repeat(64)}` };
  const intake = { sourceStreamId: `source-intake:${"1".repeat(64)}`, closureEventId: "intake-closure-93",
    snapshotSha256: "2".repeat(64), sourceCount: 1, rejectedCount: 0, totalBytes: 12 };
  const base = { streamId, correlationId: "run-93" };
  journal.append(streamId, 0, [
    { ...base, type: "run.accepted", causationId: "service-ready", payload: {
      schemaVersion: 1, runVersion: 1, runId: "run-93", projectId: "zentra",
      projectRevision: { objectFormat: "sha1", commit: "a".repeat(40) },
      source: { kind: "inline_goal", referenceSha256: "7".repeat(64), declaredBytes: 12 },
      actor: { actorId: "operator-1", kind: "operator" }, process,
      budget: { maxDurationMs: 60_000, maxInputTokens: 1_000, maxOutputTokens: 1_000,
        maxCostUsdNano: 1_000_000_000, maxRetries: 1, maxSourceFiles: 10, maxSourceBytes: 10_000 },
      authority: { approvalState: "not_proposed", planDigest: null, envelopeDigest: null,
        approvalDecisionId: null, executionAuthority: "none" }, commandId: "accept-run-93",
    } },
    { ...base, type: "preflight.started", causationId: "accepted", payload: {
      schemaVersion: 1, runId: "run-93", process, commandId: "preflight-start", executionAuthority: "none" } },
    { ...base, type: "preflight.completed", causationId: "preflight", payload: {
      schemaVersion: 1, runId: "run-93", process, commandId: "preflight-complete", executionAuthority: "none" } },
    { ...base, type: "run.intake_completed", causationId: intake.closureEventId, payload: {
      schemaVersion: 1, commandId: "intake-complete", intake, executionAuthority: "none" } },
    { ...base, type: "run.analysis_completed", causationId: analysisCompletionEventId, payload: {
      schemaVersion: 1, commandId: "analysis-complete", intake, analysisStreamId: "analysis:run-93",
      analysisCompletionEventId, analysisEvidenceSha256: "b".repeat(64), sourceEvidenceSha256: "c".repeat(64), executionAuthority: "none" } },
  ]);
  journal.append("analysis:run-93", 0, [{
    streamId: "analysis:run-93", type: "analysis.completed", causationId: "observation-1", correlationId: "run-93",
    eventId: analysisCompletionEventId, payload: {
      schemaVersion: 1, runId: "run-93", rounds: 1, observationCount: 1, evidenceSha256: "b".repeat(64),
      sourceEvidenceSha256: "c".repeat(64), finalObservationEventId: "observation-1",
      totalUsage: { durationMs: 10, inputTokens: 10, outputTokens: 10, inputBytes: 100, outputBytes: 100,
        costUsdNano: 10, modelReceiptSha256: "6".repeat(64) }, commandId: "analysis-completed", authority: "none",
    },
  }]);
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-surface-"));
  directories.push(directory);
  return directory;
}

function captureError(operation: () => unknown): WorkflowSurfaceError {
  try {
    operation();
  } catch (error) {
    if (error instanceof WorkflowSurfaceError) return error;
    throw error;
  }
  throw new Error("expected operation to fail");
}

function decisionEvidence(
  action: "answer_question" | "reject_question",
  input: object,
  actor: { readonly actorId: string; readonly kind: "operator"; readonly channel: WorkflowChannel },
): string {
  return digestCanonical({ schemaVersion: 1, action, input, actor });
}

const analysisCompletionEventId = "00000000-0000-4000-8000-000000000093";
