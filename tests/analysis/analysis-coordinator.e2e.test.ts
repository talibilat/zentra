import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AnalysisCoordinator } from "../../src/analysis/analysis-coordinator.js";
import { prepareAnalysisCompletion } from "../../src/analysis/analysis-completion.js";
import { SupervisedAnalysisAdapter } from "../../src/analysis/supervised-analysis-adapter.js";
import { AttentionControlledDispatcher } from "../../src/attention/attention-dispatcher.js";
import { AttentionService } from "../../src/attention/attention-service.js";
import { BoundedTicketIntake } from "../../src/intake/ticket-intake.js";
import { IntakeArtifactStore } from "../../src/intake/intake-artifact-store.js";
import { IntakeService } from "../../src/intake/intake-service.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { RunService } from "../../src/runs/run-service.js";
import { ServiceLifecycleService } from "../../src/runs/service-lifecycle.js";

const cleanup: string[] = [];
const root = realpathSync.native(path.resolve(import.meta.dirname, "../.."));
const program = realpathSync.native(path.join(root, "fixtures/deterministic-analyzer.mjs"));
const executable = realpathSync.native(process.execPath);
const processIdentity = { pid: 92, processIncarnation: `process-v2:${"a".repeat(64)}` } as const;
const revision = { objectFormat: "sha1" as const, commit: "1".repeat(40) };
const baseBudget = {
  maxRounds: 3, maxObservations: 16, maxQuestions: 8, maxOptionsPerQuestion: 4,
  maxQuestionnaireOptions: 16, maxOutputBytes: 64 * 1024, maxDurationMs: 10_000,
  maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsdNano: 0,
};

afterEach(() => {
  delete process.env.ANALYSIS_SECRET_CANARY;
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(runId: string, text = "untrusted ticket asks for writer authority") {
  const projectRoot = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-analysis-")));
  cleanup.push(projectRoot);
  const sourceRoot = path.join(projectRoot, "sources");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceRoot));
  writeFileSync(path.join(sourceRoot, "ticket.md"), text);
  const journal = new SqliteEventJournal(path.join(projectRoot, "events.sqlite"));
  const runs = new RunService(journal);
  const lifecycle = new ServiceLifecycleService(journal);
  const starting = lifecycle.start({
    serviceId: `service-${runId}`, process: processIdentity, address: { host: "127.0.0.1", port: 43_292 },
    tokenExpiresAt: "2026-07-21T00:00:00.000Z", observation: "performed", commandId: `service-start-${runId}`,
  });
  const ready = lifecycle.ready({
    serviceId: `service-${runId}`, process: processIdentity, address: { host: "127.0.0.1", port: 43_292 },
    runtimeSchemaVersion: 1, journalSchemaVersion: 6, observation: "performed",
    commandId: `service-ready-${runId}`, causationId: starting.eventId,
  });
  const reference = Buffer.from(path.resolve(sourceRoot));
  let run = runs.accept({
    runId, projectId: "zentra", projectRevision: revision,
    source: { kind: "ticket_directory", referenceSha256: digest(reference), declaredBytes: reference.length },
    actor: { actorId: "operator", kind: "operator" }, process: processIdentity,
    budget: {
      maxDurationMs: 60_000, maxInputTokens: 10_000, maxOutputTokens: 10_000,
      maxCostUsdNano: 0, maxRetries: 0, maxSourceFiles: 8, maxSourceBytes: 16_384,
    },
    commandId: `accept-${runId}`, causationId: ready.eventId,
  });
  run = runs.startPreflight(runId, {
    expectedVersion: run.streamVersion, commandId: `preflight-start-${runId}`,
    causationId: runs.readStream(runId).at(-1)!.eventId, process: processIdentity,
  });
  run = runs.completePreflight(runId, {
    expectedVersion: run.streamVersion, commandId: `preflight-complete-${runId}`,
    causationId: runs.readStream(runId).at(-1)!.eventId, process: processIdentity,
  });
  const store = await IntakeArtifactStore.openProject(projectRoot);
  const intake = new IntakeService(journal, runs, new BoundedTicketIntake(), store);
  await intake.intake({
    runId, projectRevision: revision, source: { kind: "ticket_directory", root: sourceRoot },
    limits: { maxFileBytes: 4096, maxFiles: 8, maxTotalBytes: 16_384, maxDepth: 4, maxEntries: 16, maxDirectoryEntries: 8 },
    commandId: `intake-${runId}`,
  });
  const analyzer = new SupervisedAnalysisAdapter({
    executable, executableSha256: digest(readFileSync(executable)), program, programSha256: digest(readFileSync(program)),
    cwd: realpathSync.native("/tmp"), timeoutMs: 2_000, maxInputBytes: 128 * 1024, maxOutputBytes: 128 * 1024,
  });
  const attention = new AttentionService(journal);
  return { projectRoot, sourceRoot, journal, runs, intake, attention, coordinator: new AnalysisCoordinator(journal, runs, attention, intake, analyzer) };
}

describe("AnalysisCoordinator supervised deterministic E2E", () => {
  it("batches material and advisory questions, restarts waiting, and completes only through replay evidence", async () => {
    process.env.ANALYSIS_SECRET_CANARY = "must-not-reach-child";
    const test = await fixture("run-analysis");
    const first = await test.coordinator.advance({ runId: "run-analysis", budget: baseBudget, signal: new AbortController().signal });
    expect(first).toMatchObject({ status: "waiting", round: 1 });
    const question = test.attention.poll("run-analysis")[0]!;
    expect(question.packet).toMatchObject({
      questions: [
        expect.objectContaining({ uncertaintyId: "api-policy", material: true, recommendation: { optionId: "compatible", rationale: expect.any(String) } }),
        expect.objectContaining({ uncertaintyId: "wording", material: false, recommendation: { optionId: "coordinator", rationale: expect.any(String) } }),
      ],
    });
    expect(question.affectedScopes).toEqual(["scope:api"]);
    expect(question.dependentScopes).toEqual(["scope:api-tests"]);
    let unrelated = 0;
    expect(await new AttentionControlledDispatcher(test.attention).dispatch({
      runId: "run-analysis", admissionId: "unrelated", scopeId: "scope:wording",
      commandId: "unrelated", evidenceSha256: digest("unrelated"), work: () => ++unrelated,
    })).toMatchObject({ status: "completed", value: 1 });

    const restarted = new AnalysisCoordinator(test.journal, test.runs, test.attention, test.intake,
      new SupervisedAnalysisAdapter({
        executable, executableSha256: digest(readFileSync(executable)), program, programSha256: digest(readFileSync(program)),
        cwd: realpathSync.native("/tmp"), timeoutMs: 2_000, maxInputBytes: 128 * 1024, maxOutputBytes: 128 * 1024,
      }));
    expect(await restarted.advance({ runId: "run-analysis", budget: baseBudget, signal: new AbortController().signal }))
      .toMatchObject({ status: "waiting", decisionId: question.decisionId });
    test.attention.answer(question.decisionId, {
      runId: "run-analysis", expectedVersion: question.streamVersion, optionId: question.recommendation!.optionId,
      actor: { actorId: "operator", kind: "operator", channel: "ui" }, commandId: "answer-round-one",
      evidenceSha256: digest("answer"),
    });
    expect(await restarted.advance({ runId: "run-analysis", budget: baseBudget, signal: new AbortController().signal }))
      .toMatchObject({ status: "completed", round: 2 });
    expect(test.runs.get("run-analysis")?.lifecycle).toBe("planning");
    expect(await restarted.advance({ runId: "run-analysis", budget: baseBudget, signal: new AbortController().signal }))
      .toMatchObject({ status: "completed", round: 2 });
    expect(test.journal.readStream("analysis:run-analysis").map((event) => event.type)).toEqual([
      "analysis.started", "analysis.invocation_reserved", "analysis.observed", "analysis.revised",
      "analysis.invocation_reserved", "analysis.observed", "analysis.completed",
    ]);
    expect(() => test.runs.completeAnalysis("run-analysis", test.runs.get("run-analysis")!.streamVersion, "bypass", undefined as never))
      .toThrow(/capability|transition/);
    const analysisEvents = test.journal.readStream("analysis:run-analysis");
    test.journal.append("analysis:run-analysis", analysisEvents.length, [{
      streamId: "analysis:run-analysis", type: "analysis.unknown", payload: { runId: "run-analysis" },
      causationId: analysisEvents.at(-1)!.eventId, correlationId: "run-analysis",
    }]);
    expect(() => prepareAnalysisCompletion(test.journal, "run-analysis", undefined as never))
      .toThrow("follows completion");
    test.journal.close();
  });

  it("reserves before the effect so concurrent advance invokes one analyzer", async () => {
    const test = await fixture("run-concurrent");
    const results = await Promise.all([
      test.coordinator.advance({ runId: "run-concurrent", budget: baseBudget, signal: new AbortController().signal }),
      test.coordinator.advance({ runId: "run-concurrent", budget: baseBudget, signal: new AbortController().signal }),
    ]);
    expect(results.map((item) => item.status).sort()).toEqual(["reconciling", "waiting"]);
    expect(test.journal.readStream("analysis:run-concurrent").filter((event) => event.type === "analysis.invocation_reserved")).toHaveLength(1);
    test.journal.close();
  });

  it("keeps exhausted scopes gated until explicit higher budget revision and supports durable cancellation", async () => {
    const test = await fixture("run-budget");
    const oneRound = { ...baseBudget, maxRounds: 1 };
    await test.coordinator.advance({ runId: "run-budget", budget: oneRound, signal: new AbortController().signal });
    const initialQuestion = test.attention.poll("run-budget")[0]!;
    test.attention.answer(initialQuestion.decisionId, {
      runId: "run-budget", expectedVersion: initialQuestion.streamVersion, optionId: initialQuestion.recommendation!.optionId,
      actor: { actorId: "operator", kind: "operator", channel: "cli" }, commandId: "answer-before-exhaustion",
      evidenceSha256: digest("answer-before-exhaustion"),
    });
    const exhausted = await test.coordinator.advance({ runId: "run-budget", budget: oneRound, signal: new AbortController().signal });
    expect(exhausted.status).toBe("budget_exhausted");
    const budgetQuestion = test.attention.getDecision((exhausted as { decisionId: string }).decisionId)!;
    expect(budgetQuestion.options.map((option) => option.optionId)).toContain("await_budget_revision");
    test.attention.answer(budgetQuestion.decisionId, {
      runId: "run-budget", expectedVersion: budgetQuestion.streamVersion, optionId: "await_budget_revision",
      actor: { actorId: "operator", kind: "operator", channel: "cli" }, commandId: "await-budget",
      evidenceSha256: digest("await-budget"),
    });
    const gated = await test.coordinator.advance({ runId: "run-budget", budget: oneRound, signal: new AbortController().signal });
    expect(gated.status).toBe("budget_exhausted");
    expect(test.attention.pausedScopes("run-budget")).toContain("scope:api");
    const revised = { ...oneRound, maxRounds: 2 };
    test.coordinator.reviseBudget({
      runId: "run-budget", budget: revised, actor: { actorId: "operator", kind: "operator", channel: "ui" },
      commandId: "revise-budget", evidenceSha256: digest("revision"),
    });
    expect(await test.coordinator.advance({ runId: "run-budget", budget: revised, signal: new AbortController().signal }))
      .toMatchObject({ status: "completed" });
    test.journal.close();

    const cancelled = await fixture("run-budget-cancel");
    await cancelled.coordinator.advance({ runId: "run-budget-cancel", budget: oneRound, signal: new AbortController().signal });
    const cancelInitial = cancelled.attention.poll("run-budget-cancel")[0]!;
    cancelled.attention.answer(cancelInitial.decisionId, {
      runId: "run-budget-cancel", expectedVersion: cancelInitial.streamVersion, optionId: cancelInitial.recommendation!.optionId,
      actor: { actorId: "operator", kind: "operator", channel: "ui" }, commandId: "cancel-answer-before-exhaustion",
      evidenceSha256: digest("cancel-answer-before-exhaustion"),
    });
    const budgetResult = await cancelled.coordinator.advance({ runId: "run-budget-cancel", budget: oneRound, signal: new AbortController().signal });
    const cancelQuestion = cancelled.attention.getDecision((budgetResult as { decisionId: string }).decisionId)!;
    cancelled.attention.answer(cancelQuestion.decisionId, {
      runId: "run-budget-cancel", expectedVersion: cancelQuestion.streamVersion, optionId: "cancel_analysis",
      actor: { actorId: "operator", kind: "operator", channel: "ui" }, commandId: "cancel-budget", evidenceSha256: digest("cancel"),
    });
    expect(await cancelled.coordinator.advance({ runId: "run-budget-cancel", budget: oneRound, signal: new AbortController().signal }))
      .toMatchObject({ status: "cancelled" });
    expect(cancelled.runs.get("run-budget-cancel")?.terminalOutcome).toBe("cancelled");
    cancelled.journal.close();
  });

  it("rejects retained artifact substitution and records abort without observations", async () => {
    const substituted = await fixture("run-substitute");
    const loaded = await substituted.intake.loadRetainedAnalysisSnapshot("run-substitute");
    const artifact = loaded.snapshot.sources[0]!.artifact!;
    const artifactPath = path.join(substituted.projectRoot, ".zentra", "intake", "artifacts", `${artifact.sha256}.json`);
    writeFileSync(artifactPath, "{}\n");
    chmodSync(artifactPath, 0o600);
    await expect(substituted.coordinator.advance({
      runId: "run-substitute", budget: baseBudget, signal: new AbortController().signal,
    })).rejects.toThrow(/artifact|Invalid input/);
    substituted.journal.close();

    const aborted = await fixture("run-abort", "__WAIT__");
    const controller = new AbortController();
    const pending = aborted.coordinator.advance({ runId: "run-abort", budget: baseBudget, signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(aborted.journal.readStream("analysis:run-abort").map((event) => event.type)).toEqual([
      "analysis.started", "analysis.invocation_reserved", "analysis.cancelled",
    ]);
    aborted.journal.close();

    const after = await fixture("run-abort-after");
    const afterController = new AbortController();
    const afterAdapter = new SupervisedAnalysisAdapter({
      executable, executableSha256: digest(readFileSync(executable)), program, programSha256: digest(readFileSync(program)),
      cwd: realpathSync.native("/tmp"), timeoutMs: 2_000, maxInputBytes: 128 * 1024, maxOutputBytes: 128 * 1024,
    });
    const execute = afterAdapter.analyze.bind(afterAdapter);
    afterAdapter.analyze = async (request, signal) => {
      const result = await execute(request, signal);
      afterController.abort();
      return result;
    };
    const afterCoordinator = new AnalysisCoordinator(after.journal, after.runs, after.attention, after.intake, afterAdapter);
    expect(await afterCoordinator.advance({ runId: "run-abort-after", budget: baseBudget, signal: afterController.signal }))
      .toMatchObject({ status: "cancelled" });
    expect(after.journal.readStream("analysis:run-abort-after").map((event) => event.type)).toEqual([
      "analysis.started", "analysis.invocation_reserved", "analysis.cancelled",
    ]);
    after.journal.close();
  });

  it("charges measured overruns, handles pre-abort, and rejects duplicate identities across rounds", async () => {
    const overrun = await fixture("run-overrun", "__OVER_BUDGET__");
    const result = await overrun.coordinator.advance({ runId: "run-overrun", budget: baseBudget, signal: new AbortController().signal });
    expect(result.status).toBe("budget_exhausted");
    expect(overrun.journal.readStream("analysis:run-overrun").map((event) => event.type)).toEqual([
      "analysis.started", "analysis.invocation_reserved", "analysis.observed", "analysis.budget_exhausted",
    ]);
    overrun.journal.close();

    const preAborted = await fixture("run-pre-abort");
    const controller = new AbortController();
    controller.abort();
    expect(await preAborted.coordinator.advance({ runId: "run-pre-abort", budget: baseBudget, signal: controller.signal }))
      .toMatchObject({ status: "cancelled" });
    expect(preAborted.journal.readStream("analysis:run-pre-abort").map((event) => event.type)).toEqual([
      "analysis.started", "analysis.cancelled",
    ]);
    preAborted.journal.close();

    const duplicate = await fixture("run-duplicate", "__DUPLICATE_ID__");
    const waiting = await duplicate.coordinator.advance({ runId: "run-duplicate", budget: baseBudget, signal: new AbortController().signal });
    const question = duplicate.attention.getDecision((waiting as { decisionId: string }).decisionId)!;
    duplicate.attention.answer(question.decisionId, {
      runId: "run-duplicate", expectedVersion: question.streamVersion, optionId: question.recommendation!.optionId,
      actor: { actorId: "operator", kind: "operator", channel: "ui" }, commandId: "duplicate-answer",
      evidenceSha256: digest("duplicate-answer"),
    });
    await expect(duplicate.coordinator.advance({
      runId: "run-duplicate", budget: baseBudget, signal: new AbortController().signal,
    })).rejects.toThrow("duplicated across rounds");
    expect(duplicate.runs.get("run-duplicate")?.lifecycle).toBe("analyzing");
    duplicate.journal.close();
  });
});

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
