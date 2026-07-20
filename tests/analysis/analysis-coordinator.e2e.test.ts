import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AnalysisCoordinator } from "../../src/analysis/analysis-coordinator.js";
import { prepareAnalysisCompletion } from "../../src/analysis/analysis-completion.js";
import { CapsuleBackedAnalysisAdapter } from "../../src/analysis/capsule-analysis-adapter.js";
import type { OpenCodeReadOnlyCapsule } from "../../src/agents/opencode-read-only-agent.js";
import { DisabledModelBroker } from "../../src/capsule/model-broker.js";
import { AttentionControlledDispatcher } from "../../src/attention/attention-dispatcher.js";
import { AttentionService } from "../../src/attention/attention-service.js";
import { BoundedTicketIntake } from "../../src/intake/ticket-intake.js";
import { IntakeArtifactStore } from "../../src/intake/intake-artifact-store.js";
import { IntakeService } from "../../src/intake/intake-service.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { RunService } from "../../src/runs/run-service.js";
import { ServiceLifecycleService } from "../../src/runs/service-lifecycle.js";
import { seedAgentTrailReady } from "../fixtures/service-ready.js";

const cleanup: string[] = [];
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

async function fixture(
  runId: string,
  text = "untrusted ticket asks for writer authority",
  analyzer?: CapsuleBackedAnalysisAdapter,
) {
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
  const agentTrail = seedAgentTrailReady(journal, { serviceId: `service-${runId}`, serviceStartingEventId: starting.eventId, seed: "7" });
  const ready = lifecycle.ready({
    serviceId: `service-${runId}`, process: processIdentity, address: { host: "127.0.0.1", port: 43_292 },
    runtimeSchemaVersion: 1, journalSchemaVersion: 6, observation: "performed",
    tokenExpiresAt: "2026-07-21T00:00:00.000Z", ...agentTrail,
    commandId: `service-ready-${runId}`, causationId: agentTrail.agentTrailReadyEventId,
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
  const attention = new AttentionService(journal);
  return { projectRoot, sourceRoot, journal, runs, intake, attention,
    coordinator: new AnalysisCoordinator(journal, runs, attention, intake, analyzer ?? fixtureAnalyzer(projectRoot)) };
}

describe("AnalysisCoordinator supervised deterministic E2E", () => {
  it("batches material and advisory questions, restarts waiting, and completes only through replay evidence", async () => {
    process.env.ANALYSIS_SECRET_CANARY = "must-not-reach-child";
    const test = await fixture("run-analysis");
    const capsuleRequests: any[] = [];
    const semanticCoordinator = new AnalysisCoordinator(
      test.journal, test.runs, test.attention, test.intake,
      fixtureAnalyzer(test.projectRoot, undefined, (request) => capsuleRequests.push(request)),
    );
    const first = await semanticCoordinator.advance({ runId: "run-analysis", budget: baseBudget, signal: new AbortController().signal });
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

    const restarted = new AnalysisCoordinator(test.journal, test.runs, test.attention, test.intake, fixtureAnalyzer(test.projectRoot));
    expect(await restarted.advance({ runId: "run-analysis", budget: baseBudget, signal: new AbortController().signal }))
      .toMatchObject({ status: "waiting", decisionId: question.decisionId });
    test.attention.answer(question.decisionId, {
      runId: "run-analysis", expectedVersion: question.streamVersion, optionId: question.recommendation!.optionId,
      actor: { actorId: "operator", kind: "operator", channel: "ui" }, commandId: "answer-round-one",
      evidenceSha256: digest("answer"),
    });
    const roundTwoCoordinator = new AnalysisCoordinator(
      test.journal, test.runs, test.attention, test.intake,
      fixtureAnalyzer(test.projectRoot, undefined, (request) => capsuleRequests.push(request)),
    );
    expect(await roundTwoCoordinator.advance({ runId: "run-analysis", budget: baseBudget, signal: new AbortController().signal }))
      .toMatchObject({ status: "completed", round: 2 });
    expect(capsuleRequests[1].answers[0]).toMatchObject({
      semantics: [
        expect.objectContaining({
          uncertaintyId: "api-policy", question: "Preserve compatibility?", materiality: "material",
          options: [
            { optionId: "breaking", label: "Break", impacts: ["Migration"] },
            { optionId: "compatible", label: "Preserve", impacts: ["No migration"] },
          ],
          recommendation: { optionId: "compatible", rationale: "No migration authority." },
          selectedOption: { optionId: "compatible", label: "Preserve", impacts: ["No migration"] },
          affectedScopes: ["scope:api"], dependentScopes: ["scope:api-tests"],
        }),
        expect.objectContaining({ uncertaintyId: "wording", materiality: "advisory" }),
      ],
      semanticSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
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
    expect(test.journal.readStream("analysis-budget:run-concurrent").filter((event) => event.type === "analysis.budget_reserved")).toHaveLength(1);
    test.journal.close();
  });

  it("marks the reservation active before the post-reservation barrier without premature reconciliation", async () => {
    const test = await fixture("run-reservation-barrier");
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let invocations = 0;
    const firstCoordinator = new AnalysisCoordinator(
      test.journal, test.runs, test.attention, test.intake,
      fixtureAnalyzer(test.projectRoot, undefined, () => { invocations += 1; }),
      { afterReservation: () => barrier },
    );
    const first = firstCoordinator.advance({
      runId: "run-reservation-barrier", budget: baseBudget, signal: new AbortController().signal,
    });
    await waitForEvent(test.journal, "analysis:run-reservation-barrier", "analysis.invocation_reserved");
    const secondCoordinator = new AnalysisCoordinator(
      test.journal, test.runs, test.attention, test.intake,
      fixtureAnalyzer(test.projectRoot, undefined, () => { invocations += 1; }),
    );
    expect(await secondCoordinator.advance({
      runId: "run-reservation-barrier", budget: baseBudget, signal: new AbortController().signal,
    })).toMatchObject({ status: "reconciling", round: 1 });
    expect(invocations).toBe(0);
    expect(test.journal.readStream("analysis:run-reservation-barrier").map((event) => event.type))
      .not.toContain("analysis.reconciliation_required");
    releaseBarrier();
    expect(await first).toMatchObject({ status: "waiting", round: 1 });
    expect(invocations).toBe(1);
    expect(test.journal.readStream("analysis-budget:run-reservation-barrier").map((event) => event.type)).toEqual([
      "analysis.budget_reserved", "analysis.budget_charged",
    ]);
    test.journal.close();
  });

  it("loses reservation atomically when cancellation wins after lifecycle read", async () => {
    const test = await fixture("run-cancel-before-reserve");
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let reachedBarrier!: () => void;
    const reached = new Promise<void>((resolve) => { reachedBarrier = resolve; });
    let invocations = 0;
    const coordinator = new AnalysisCoordinator(
      test.journal, test.runs, test.attention, test.intake,
      fixtureAnalyzer(test.projectRoot, undefined, () => { invocations += 1; }),
      { beforeReservation: () => { reachedBarrier(); return barrier; } },
    );
    const pending = coordinator.advance({
      runId: "run-cancel-before-reserve", budget: baseBudget, signal: new AbortController().signal,
    });
    await reached;
    const run = test.runs.get("run-cancel-before-reserve")!;
    test.runs.cancel("run-cancel-before-reserve", {
      expectedVersion: run.streamVersion, commandId: "cancel-before-reserve", causationId: null, process: processIdentity,
    }, { cancellationId: "cancel-before-reserve", requestedBy: { actorId: "operator", kind: "operator" }, reasonCode: "operator_requested" });
    releaseBarrier();
    expect(await pending).toMatchObject({ status: "cancelled", round: 0 });
    expect(invocations).toBe(0);
    expect(test.journal.readStream("analysis:run-cancel-before-reserve").map((event) => event.type)).toEqual(["analysis.started"]);
    expect(test.journal.readStream("analysis-budget:run-cancel-before-reserve")).toEqual([]);
    expect(test.runs.get("run-cancel-before-reserve")?.terminalOutcome).toBe("cancelled");
    test.journal.close();
  });

  it("charges once and suppresses observations when external cancellation wins during analyzer await", async () => {
    const test = await fixture("run-external-cancel");
    let analyzerStarted!: () => void;
    const started = new Promise<void>((resolve) => { analyzerStarted = resolve; });
    let releaseAnalyzer!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseAnalyzer = resolve; });
    const coordinator = new AnalysisCoordinator(
      test.journal, test.runs, test.attention, test.intake,
      fixtureAnalyzer(test.projectRoot, undefined, () => analyzerStarted(), () => barrier),
    );
    const pending = coordinator.advance({
      runId: "run-external-cancel", budget: baseBudget, signal: new AbortController().signal,
    });
    await started;
    const run = test.runs.get("run-external-cancel")!;
    test.runs.cancel("run-external-cancel", {
      expectedVersion: run.streamVersion, commandId: "external-cancel", causationId: null, process: processIdentity,
    }, { cancellationId: "external-cancel", requestedBy: { actorId: "operator", kind: "operator" }, reasonCode: "operator_requested" });
    releaseAnalyzer();
    expect(await pending).toMatchObject({ status: "cancelled" });
    const analysisTypes = test.journal.readStream("analysis:run-external-cancel").map((event) => event.type);
    expect(analysisTypes).toEqual(["analysis.started", "analysis.invocation_reserved", "analysis.cancelled"]);
    expect(analysisTypes).not.toContain("analysis.observed");
    expect(analysisTypes).not.toContain("analysis.completed");
    expect(test.journal.readStream("analysis-budget:run-external-cancel").map((event) => event.type)).toEqual([
      "analysis.budget_reserved", "analysis.budget_charged",
    ]);
    const reopened = new AnalysisCoordinator(test.journal, test.runs, test.attention, test.intake, fixtureAnalyzer(test.projectRoot));
    expect(await reopened.advance({ runId: "run-external-cancel", budget: baseBudget, signal: new AbortController().signal }))
      .toMatchObject({ status: "cancelled" });
    expect(test.journal.readStream("analysis-budget:run-external-cancel").filter((event) => event.type === "analysis.budget_charged"))
      .toHaveLength(1);
    test.journal.close();
  });

  it("durably raises reconciliation after a crash immediately following reservation", async () => {
    const test = await fixture("run-reservation-crash");
    const crashing = new AnalysisCoordinator(
      test.journal, test.runs, test.attention, test.intake, fixtureAnalyzer(test.projectRoot),
      { afterReservation: () => { throw new Error("crash after reservation"); } },
    );
    await expect(crashing.advance({
      runId: "run-reservation-crash", budget: baseBudget, signal: new AbortController().signal,
    })).rejects.toThrow("crash after reservation");
    expect(test.journal.readStream("analysis:run-reservation-crash").map((event) => event.type)).toEqual([
      "analysis.started", "analysis.invocation_reserved", "analysis.reconciliation_required",
    ]);
    const reopened = new AnalysisCoordinator(test.journal, test.runs, test.attention, test.intake, fixtureAnalyzer(test.projectRoot));
    expect(await reopened.advance({ runId: "run-reservation-crash", budget: baseBudget, signal: new AbortController().signal }))
      .toMatchObject({ status: "reconciling" });
    expect(test.journal.readStream("analysis:run-reservation-crash").filter((event) => event.type === "analysis.reconciliation_required"))
      .toHaveLength(1);
    expect(await reopened.advance({ runId: "run-reservation-crash", budget: baseBudget, signal: new AbortController().signal }))
      .toMatchObject({ status: "reconciling" });
    expect(reopened.inspectReconciliation("run-reservation-crash")).toEqual({
      status: "required", effectState: "known_no_effect", actions: ["release_and_retry"],
    });
    expect(reopened.reconcileInvocation({
      runId: "run-reservation-crash", action: "release_and_retry",
      actor: { actorId: "operator", kind: "operator", channel: "ui" },
      commandId: "reconcile-crash", evidenceSha256: digest("reconcile-crash"),
    })).toMatchObject({ status: "reconciling" });
    expect(test.runs.get("run-reservation-crash")?.lifecycle).toBe("analyzing");
    expect(await reopened.advance({ runId: "run-reservation-crash", budget: baseBudget, signal: new AbortController().signal }))
      .toMatchObject({ status: "waiting", round: 1 });
    test.journal.close();
  });

  it("does not consume or advance a material questionnaire answered by a service actor", async () => {
    const test = await fixture("run-service-material");
    const waiting = await test.coordinator.advance({ runId: "run-service-material", budget: baseBudget, signal: new AbortController().signal });
    const question = test.attention.getDecision((waiting as { decisionId: string }).decisionId)!;
    expect(() => test.attention.answer(question.decisionId, {
      runId: "run-service-material", expectedVersion: question.streamVersion,
      optionId: question.recommendation!.optionId,
      actor: { actorId: "zentra-service", kind: "service", channel: "api" },
      commandId: "service-material-answer", evidenceSha256: digest("service-material"),
    })).toThrow("material question requires an operator actor");
    expect(test.attention.getDecision(question.decisionId)).toMatchObject({ status: "pending" });
    expect(test.runs.get("run-service-material")?.lifecycle).toBe("waiting");
    expect(await test.coordinator.advance({ runId: "run-service-material", budget: baseBudget, signal: new AbortController().signal }))
      .toMatchObject({ status: "waiting", decisionId: question.decisionId });
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
    expect(test.runs.get("run-budget")?.lifecycle).toBe("waiting");
    const revised = { ...oneRound, maxRounds: 2 };
    const revisionDecision = test.coordinator.proposeBudgetRevision({ runId: "run-budget", budget: revised });
    test.attention.answer(revisionDecision.decisionId, {
      runId: "run-budget", expectedVersion: revisionDecision.streamVersion, optionId: "budget_revised",
      actor: { actorId: "operator", kind: "operator", channel: "ui" }, commandId: "approve-revised-budget",
      evidenceSha256: digest("revision"),
    });
    test.coordinator.reviseBudget({ runId: "run-budget", budget: revised, commandId: "revise-budget" });
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
    const afterAdapter = fixtureAnalyzer(after.projectRoot);
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

  it("rejects a 64 by 16 questionnaire before Cartesian allocation", async () => {
    const uncertainties = Array.from({ length: 64 }, (_, questionIndex) => ({
      uncertaintyId: `q${questionIndex.toString().padStart(2, "0")}`,
      question: "Choose one option?", materiality: "material" as const, affectedScopes: ["scope:large"], dependentScopes: [],
      options: Array.from({ length: 16 }, (_, optionIndex) => ({
        optionId: `q${questionIndex.toString().padStart(2, "0")}-o${optionIndex.toString().padStart(2, "0")}`,
        label: `Option ${optionIndex}`, impacts: ["Bounded impact"],
      })),
      recommendation: { optionId: `q${questionIndex.toString().padStart(2, "0")}-o00`, rationale: "Deterministic." },
    }));
    const adapter = fixtureAnalyzer("/tmp", () => ({ observations: [], uncertainties }));
    const test = await fixture("run-cartesian", "large", adapter);
    const budget = { ...baseBudget, maxQuestions: 64, maxOptionsPerQuestion: 16, maxQuestionnaireOptions: 64 };
    const started = performance.now();
    const result = await test.coordinator.advance({ runId: "run-cartesian", budget, signal: new AbortController().signal });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.status).toBe("budget_exhausted");
    expect(test.journal.readStream("analysis:run-cartesian").map((event) => event.type)).not.toContain("questionnaire.proposed");
    expect(test.attention.poll("run-cartesian")).toHaveLength(1);
    test.journal.close();
  });

  it("maps known capsule terminals to the run and leaves uncertain cleanup for reconciliation across restart", async () => {
    for (const [marker, expected] of [["__TIMEOUT__", "timed_out"], ["__FAIL__", "failed"]] as const) {
      const test = await fixture(`run-${expected}`, marker);
      expect(await test.coordinator.advance({ runId: `run-${expected}`, budget: baseBudget, signal: new AbortController().signal }))
        .toMatchObject({ status: expected });
      expect(test.runs.get(`run-${expected}`)?.terminalOutcome).toBe(expected);
      expect(await test.coordinator.advance({ runId: `run-${expected}`, budget: baseBudget, signal: new AbortController().signal }))
        .toMatchObject({ status: expected });
      test.journal.close();
    }
    const uncertain = await fixture("run-uncertain", "__UNCERTAIN__");
    expect(await uncertain.coordinator.advance({ runId: "run-uncertain", budget: baseBudget, signal: new AbortController().signal }))
      .toMatchObject({ status: "reconciling" });
    expect(uncertain.runs.get("run-uncertain")?.lifecycle).toBe("waiting");
    const restarted = new AnalysisCoordinator(uncertain.journal, uncertain.runs, uncertain.attention, uncertain.intake, fixtureAnalyzer(uncertain.projectRoot));
    expect(await restarted.advance({ runId: "run-uncertain", budget: baseBudget, signal: new AbortController().signal }))
      .toMatchObject({ status: "reconciling" });
    expect(restarted.inspectReconciliation("run-uncertain")).toEqual({ status: "required", effectState: "uncertain", actions: ["charge_and_fail"] });
    expect(() => restarted.reconcileInvocation({
      runId: "run-uncertain", action: "release_and_retry", actor: { actorId: "operator", kind: "operator", channel: "ui" },
      commandId: "unsafe-retry", evidenceSha256: digest("unsafe"),
    })).toThrow("cannot be retried");
    expect(restarted.reconcileInvocation({
      runId: "run-uncertain", action: "charge_and_fail", actor: { actorId: "operator", kind: "operator", channel: "ui" },
      commandId: "reconcile-failed", evidenceSha256: digest("failed"),
    })).toMatchObject({ status: "failed" });
    expect(uncertain.runs.get("run-uncertain")?.terminalOutcome).toBe("failed");
    uncertain.journal.close();
  });

  it("rejects service self-approval of an exact budget revision", async () => {
    const test = await fixture("run-budget-service");
    const oneRound = { ...baseBudget, maxRounds: 1 };
    await test.coordinator.advance({ runId: "run-budget-service", budget: oneRound, signal: new AbortController().signal });
    const question = test.attention.poll("run-budget-service")[0]!;
    test.attention.answer(question.decisionId, {
      runId: "run-budget-service", expectedVersion: question.streamVersion, optionId: question.recommendation!.optionId,
      actor: { actorId: "operator", kind: "operator", channel: "ui" }, commandId: "service-budget-question", evidenceSha256: digest("q"),
    });
    const exhausted = await test.coordinator.advance({ runId: "run-budget-service", budget: oneRound, signal: new AbortController().signal });
    const budgetQuestion = test.attention.getDecision((exhausted as { decisionId: string }).decisionId)!;
    test.attention.answer(budgetQuestion.decisionId, {
      runId: "run-budget-service", expectedVersion: budgetQuestion.streamVersion, optionId: "await_budget_revision",
      actor: { actorId: "operator", kind: "operator", channel: "ui" }, commandId: "service-await", evidenceSha256: digest("await"),
    });
    await test.coordinator.advance({ runId: "run-budget-service", budget: oneRound, signal: new AbortController().signal });
    const revised = { ...oneRound, maxRounds: 2 };
    const proposal = test.coordinator.proposeBudgetRevision({ runId: "run-budget-service", budget: revised });
    expect(() => test.attention.answer(proposal.decisionId, {
      runId: "run-budget-service", expectedVersion: proposal.streamVersion, optionId: "budget_revised",
      actor: { actorId: "zentra", kind: "service", channel: "api" }, commandId: "service-self-answer", evidenceSha256: digest("self"),
    })).toThrow("material question requires an operator actor");
    expect(() => test.coordinator.reviseBudget({ runId: "run-budget-service", budget: revised, commandId: "service-revise" }))
      .toThrow("operator-only");
    expect(test.journal.readStream("analysis:run-budget-service").map((event) => event.type)).not.toContain("analysis.budget_revised");
    expect(test.runs.get("run-budget-service")?.lifecycle).toBe("waiting");
    test.journal.close();
  });
});

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForEvent(journal: SqliteEventJournal, streamId: string, type: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!journal.readStream(streamId).some((event) => event.type === type)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function fixtureAnalyzer(
  repositoryPath: string,
  overrideRound?: () => { observations: any[]; uncertainties: any[] },
  observeRequest: (request: any) => void = () => {},
  beforeResult: () => Promise<void> = async () => {},
): CapsuleBackedAnalysisAdapter {
  const sourceText = repositoryPath === "/tmp" ? "large" : readFileSync(path.join(repositoryPath, "sources", "ticket.md"), "utf8");
  const execute: OpenCodeReadOnlyCapsule["execute"] = async (capsuleRequest, _broker, signal) => {
    const request = JSON.parse(capsuleRequest.rolePrompt.slice(capsuleRequest.rolePrompt.indexOf("\n") + 1));
    observeRequest(request);
    await beforeResult();
    if (sourceText.includes("__WAIT__")) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return capsuleResult("cancelled", null, 0);
    }
    if (sourceText.includes("__TIMEOUT__")) return capsuleResult("timed_out", null, 0);
    if (sourceText.includes("__FAIL__")) return capsuleResult("failed", null, 0);
    if (sourceText.includes("__UNCERTAIN__")) return { ...capsuleResult("uncertain", null, 0), cleanup: "uncertain" };
    await new Promise((resolve) => setTimeout(resolve, 20));
    const first = request.answers.length === 0;
    const round = overrideRound?.() ?? (first ? {
      observations: [{ observationId: "obs-api", summary: "The retained source leaves API choices open.", sourceIds: [], repositoryPaths: ["src/index.ts"], affectedScopes: ["scope:api"] }],
      uncertainties: [
        { uncertaintyId: "api-policy", question: "Preserve compatibility?", materiality: "material" as const,
          affectedScopes: ["scope:api"], dependentScopes: ["scope:api-tests"],
          options: [{ optionId: "breaking", label: "Break", impacts: ["Migration"] }, { optionId: "compatible", label: "Preserve", impacts: ["No migration"] }],
          recommendation: { optionId: "compatible", rationale: "No migration authority." } },
        { uncertaintyId: "wording", question: "Choose wording?", materiality: "advisory" as const,
          affectedScopes: ["scope:wording"], dependentScopes: [], options: [{ optionId: "coordinator", label: "Coordinator", impacts: ["No behavior change"] }],
          recommendation: { optionId: "coordinator", rationale: "Matches the role." } },
      ],
    } : {
      observations: [{ observationId: sourceText.includes("__DUPLICATE_ID__") ? "obs-api" : "obs-resolved",
        summary: "The durable answer resolves material uncertainty.", sourceIds: [], repositoryPaths: [], affectedScopes: ["scope:api"] }],
      uncertainties: [],
    });
    return capsuleResult("completed", round, sourceText.includes("__OVER_BUDGET__") ? 5_000 : first ? 120 : 80);
  };
  return CapsuleBackedAnalysisAdapter.composeTrusted({ execute }, new DisabledModelBroker(), {
    snapshots: { prepare: async (request) => ({
      view: { path: `${repositoryPath}/sanitized-analysis-view`, revision: digest(request.projectRevision.commit),
        readableScopes: ["src/**", ".analysis-sources/**"], forbiddenPaths: [".git/**", ".zentra/**"] },
      sourceBundleSha256: "b".repeat(64), sourceManifestPath: ".analysis-sources/manifest.json", release: () => {},
    }) },
    capabilityId: "analysis", transportModelId: "zentra/analysis", imageName: "zentra-opencode-readonly:analysis",
  });
}

function capsuleResult(
  outcome: "completed" | "cancelled" | "timed_out" | "failed" | "uncertain",
  round: { observations: any[]; uncertainties: any[] } | null,
  inputTokens: number,
): any {
  return {
    outcome: outcome === "uncertain" ? "failed" : outcome,
    openCode: outcome === "completed" ? { version: "1.18.3", executableSha256: "a".repeat(64) } : null,
    model: outcome === "completed" ? { id: "zentra/analysis", provider: "fixture", name: "analysis" } : null,
    evidence: round === null ? [] : [{ kind: "plan", summary: JSON.stringify(round) }], cleanup: "completed",
    brokerTransport: outcome === "uncertain" ? "uncertain" : "completed",
    usage: { seconds: 0.02, inputTokens, outputTokens: 40, costUsd: 0, costUsdNano: 0, toolCalls: 0, modelTurns: 1 },
  };
}
