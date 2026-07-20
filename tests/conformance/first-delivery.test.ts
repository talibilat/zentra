import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisAdapterRequest } from "../../src/analysis/analysis-contracts.js";
import { AnalysisExecutionError, type AnalysisAdapterResult } from "../../src/analysis/capsule-analysis-adapter.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import {
  ProductionRunAdvancer,
  type FirstDeliveryConfiguration,
  type FirstDeliveryFaultHooks,
  type FirstDeliveryPlannerRequest,
} from "../../src/first-delivery/production-run-advancer.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import type { EventJournal } from "../../src/journal/journal.js";
import { createValidationIdentitySnapshot, APPROVED_VALIDATION_EXECUTABLE, ProjectConfigSchema } from "../../src/projects/project-config.js";
import { resolveProjectRevision } from "../../src/runs/project-revision.js";
import { ServiceLifecycleService } from "../../src/runs/service-lifecycle.js";
import { createLocalWorkflowSurface } from "../../src/surfaces/local-workflow.js";
import { seedAgentTrailReady } from "../fixtures/service-ready.js";

const cleanup: string[] = [];
const processIdentity = { pid: 95, processIncarnation: `process-v2:${"9".repeat(64)}` } as const;
const noCodingEvents = [
  "milestone.created",
  "task.created",
  "task.started",
  "task.worktree_creation_started",
  "worker.started",
  "validation.started",
  "integration.started",
];

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("first-delivery production conformance", () => {
  it("runs the canonical repeated-question sequence to exact approval and stops before coding", async () => {
    const test = await fixture();
    const submitted = await test.surface.submitRun(
      { kind: "inline_goal", commandId: "canonical-submit", goal: "Implement the bounded parser behavior." },
      { actorId: "operator", channel: "cli" },
    );
    await test.advancer.waitForIdle(submitted.run.runId);

    const first = test.surface.getRun(submitted.run.runId)!;
    expect(first).toMatchObject({ run: { lifecycle: "waiting" }, analysis: { status: "awaiting_answer" } });
    const question = first.questions.find((item) => item.status === "pending")!;
    test.surface.answerQuestion({
      runId: submitted.run.runId,
      decisionId: question.decisionId,
      expectedVersion: question.streamVersion,
      commandId: "canonical-answer",
      optionId: question.recommendation!.optionId,
    }, { actorId: "operator", channel: "ui" });
    await test.advancer.waitForIdle(submitted.run.runId);

    const planned = test.surface.getRun(submitted.run.runId)!;
    expect(planned).toMatchObject({
      run: { lifecycle: "awaiting_approval" },
      analysis: { status: "completed", rounds: [{ round: 1 }, { round: 2 }] },
      planning: { status: "proposed", readiness: { ready: false, executionAuthority: "none" } },
    });
    const approval = planned.approvals.find((item) => item.status === "pending")!;
    const approved = test.surface.approvePlan({
      runId: submitted.run.runId,
      decisionId: approval.decisionId,
      expectedVersion: approval.streamVersion,
      commandId: "canonical-approval",
      planDigest: planned.planning.planDigest!,
      envelopeDigest: planned.planning.envelopeDigest!,
    }, { actorId: "operator", channel: "cli" });

    expect(approved).toMatchObject({
      run: { lifecycle: "approved_and_ready_for_execution", authority: { executionAuthority: "none" } },
      planning: { readiness: { ready: true, executionAuthority: "none" } },
    });
    expectSubsequence(test.journal.readAll().map((event) => event.type), [
      "workflow.run_submission_reserved",
      "workflow.run_submitted",
      "run.accepted",
      "preflight.started",
      "preflight.completed",
      "source.discovered",
      "intake.snapshot_closed",
      "run.intake_completed",
      "first_delivery.advance_reserved",
      "analysis.started",
      "analysis.invocation_reserved",
      "analysis.observed",
      "questionnaire.proposed",
      "decision.accepted",
      "analysis.revised",
      "analysis.invocation_reserved",
      "analysis.observed",
      "analysis.completed",
      "run.analysis_completed",
      "first_delivery.planner_reserved",
      "first_delivery.planner_observed",
      "plan.proposed",
      "run.approval_requested",
      "approval.requested",
      "approval.accepted",
      "run.ready_for_execution",
    ]);
    assertNoCoding(test.journal);
    expect(test.adapter.calls).toBe(2);
    expect(test.plannerCalls.count).toBe(1);
    test.journal.close();
  });

  it("fails closed with a durable operator diagnostic when providers are not configured", async () => {
    const test = await fixture({ configured: false });
    const submitted = await test.surface.submitRun(
      { kind: "inline_goal", commandId: "unconfigured-submit", goal: "Do not guess provider authority." },
      { actorId: "operator", channel: "cli" },
    );
    await test.advancer.waitForIdle(submitted.run.runId);

    expect(test.surface.getRun(submitted.run.runId)?.run).toMatchObject({
      lifecycle: "waiting",
      suspendedFrom: "analyzing",
    });
    expect(test.journal.readStream(`run:${submitted.run.runId}`).at(-1)?.payload)
      .toMatchObject({ reasonCode: "first_delivery_analysis_not_configured" });
    assertNoCoding(test.journal);
    test.journal.close();
  });

  it.each([
    { boundary: "submission", hook: "afterAdvanceReserved", expected: "analysis.started", plannerCalls: 1 },
    { boundary: "analysis reservation", hook: "afterAnalysisReservation", expected: "analysis.reconciliation_required", plannerCalls: 0 },
    { boundary: "analysis observation", hook: "afterAnalysis", expected: "analysis.observed", plannerCalls: 1 },
    { boundary: "plan reservation", hook: "afterPlannerReservation", expected: "first_delivery.planner_reconciliation_required", plannerCalls: 0 },
    { boundary: "plan observation", hook: "afterPlannerObservation", expected: "approval.requested", plannerCalls: 1 },
    { boundary: "plan proposal", hook: "afterPlanProposed", expected: "approval.requested", plannerCalls: 1 },
  ] as const)("restarts deterministically at the $boundary boundary", async ({ hook, expected, plannerCalls }) => {
    let crash = true;
    const hooks = {
      [hook]: () => {
        if (crash) {
          crash = false;
          throw new Error(`fault:${hook}`);
        }
      },
    } as FirstDeliveryFaultHooks;
    const test = await fixture({ hooks, questionnaire: false });
    const submitted = await test.surface.submitRun(
      { kind: "inline_goal", commandId: `fault-${hook}`, goal: "Exercise one restart boundary." },
      { actorId: "operator", channel: "cli" },
    );
    await expect(test.advancer.waitForIdle(submitted.run.runId)).rejects.toThrow(`fault:${hook}`);

    const restarted = await ProductionRunAdvancer.create({
      journal: test.journal,
      process: processIdentity,
      serviceReadyEventId: test.serviceReadyEventId,
      projectRoot: test.root,
      configuration: test.configuration!,
    });
    await restarted.resumeNonterminalRuns();
    await restarted.waitForIdle(submitted.run.runId);

    expect(test.journal.readAll().map((event) => event.type)).toContain(expected);
    expect(test.adapter.calls).toBe(hook === "afterAnalysisReservation" ? 0 : 1);
    expect(test.plannerCalls.count).toBe(plannerCalls);
    expect(test.journal.readAll().filter((event) => event.type === "analysis.invocation_reserved")).toHaveLength(1);
    expect(test.journal.readAll().filter((event) => event.type === "first_delivery.planner_reserved")).toHaveLength(plannerCalls === 0 && !hook.startsWith("afterPlanner") ? 0 : 1);
    assertNoCoding(test.journal);
    test.journal.close();
  });

  it("replays append-then-crash intake without duplicate source effects", async () => {
    const root = repository();
    const journal = new SqliteEventJournal(path.join(root, "events.sqlite"));
    const serviceReadyEventId = seedReady(journal);
    const configured = configuration(root, await resolveProjectRevision(root), false);
    const advancer = await ProductionRunAdvancer.create({ journal, process: processIdentity, serviceReadyEventId,
      projectRoot: root, configuration: configured.configuration });
    let crash = true;
    const crashingJournal: EventJournal = {
      append: (streamId, version, events) => {
        const stored = journal.append(streamId, version, events);
        if (crash && events.some((event) => event.type === "intake.snapshot_closed")) {
          crash = false;
          throw new Error("fault:intake");
        }
        return stored;
      },
      readStream: (streamId, afterVersion) => journal.readStream(streamId, afterVersion),
      readAll: (afterPosition) => journal.readAll(afterPosition),
    };
    const first = await createLocalWorkflowSurface({ journal: crashingJournal, process: processIdentity,
      serviceReadyEventId, projectRoot: root, projectRevision: await resolveProjectRevision(root), runAdvancer: advancer });
    const submission = { kind: "inline_goal" as const, commandId: "intake-restart", goal: "Resume intake." };
    await expect(first.submitRun(submission, { actorId: "operator", channel: "cli" })).rejects.toThrow();
    const runId = journal.readAll().find((event) => event.type === "run.accepted")!.correlationId;
    const restarted = await ProductionRunAdvancer.create({ journal, process: processIdentity, serviceReadyEventId,
      projectRoot: root, configuration: configured.configuration });
    await restarted.resumeNonterminalRuns();
    const resumed = await createLocalWorkflowSurface({ journal, process: processIdentity, serviceReadyEventId,
      projectRoot: root, projectRevision: await resolveProjectRevision(root), runAdvancer: restarted });

    expect(journal.readAll().filter((event) => event.type === "source.discovered")).toHaveLength(1);
    expect(journal.readAll().filter((event) => event.type === "intake.snapshot_closed")).toHaveLength(1);
    expect(resumed.getRun(runId)?.run.lifecycle).toBe("awaiting_approval");
    assertNoCoding(journal);
    journal.close();
  });

  it("coordinates cancellation with bounded abort and records one analysis terminal fact", async () => {
    const test = await fixture({ waitingAdapter: true, questionnaire: false });
    const submitted = await test.surface.submitRun(
      { kind: "inline_goal", commandId: "cancel-submit", goal: "Wait until cancelled." },
      { actorId: "operator", channel: "cli" },
    );
    await test.adapter.started;
    const current = test.surface.getRun(submitted.run.runId)!.run;
    const cancelled = test.surface.cancelRun({
      runId: submitted.run.runId,
      expectedVersion: current.streamVersion,
      commandId: "cancel-command",
      cancellationId: "cancel-id",
    }, { actorId: "operator", channel: "ui" });
    await test.advancer.waitForIdle(submitted.run.runId);

    expect(cancelled.run).toMatchObject({ lifecycle: "terminal", terminalOutcome: "cancelled" });
    const terminalAnalysis = test.journal.readStream(`analysis:${submitted.run.runId}`)
      .filter((event) => event.type === "analysis.cancelled" || event.type === "analysis.reconciliation_required");
    expect(terminalAnalysis).toHaveLength(1);
    expect(test.adapter.aborted).toBe(true);
    const restarted = await ProductionRunAdvancer.create({ journal: test.journal, process: processIdentity,
      serviceReadyEventId: test.serviceReadyEventId, projectRoot: test.root, configuration: test.configuration! });
    await restarted.resumeNonterminalRuns();
    expect(test.journal.readStream(`analysis:${submitted.run.runId}`)
      .filter((event) => event.type === "analysis.cancelled" || event.type === "analysis.reconciliation_required")).toHaveLength(1);
    assertNoCoding(test.journal);
    test.journal.close();
  });

  it("marks an unobserved planner result for reconciliation and never retries it", async () => {
    const root = repository();
    const journal = new SqliteEventJournal(path.join(root, "events.sqlite"));
    const serviceReadyEventId = seedReady(journal);
    const built = configuration(root, await resolveProjectRevision(root), false);
    let plannerCalls = 0;
    const configurationWithFailure: FirstDeliveryConfiguration = {
      ...built.configuration,
      planner: { plan: async () => { plannerCalls += 1; throw new Error("planner transport lost"); } },
    };
    const advancer = await ProductionRunAdvancer.create({ journal, process: processIdentity, serviceReadyEventId,
      projectRoot: root, configuration: configurationWithFailure });
    const surface = await createLocalWorkflowSurface({ journal, process: processIdentity, serviceReadyEventId,
      projectRoot: root, projectRevision: await resolveProjectRevision(root), runAdvancer: advancer });
    const submitted = await surface.submitRun({ kind: "inline_goal", commandId: "planner-uncertain",
      goal: "Do not retry an uncertain planner." }, { actorId: "operator", channel: "cli" });
    await expect(advancer.waitForIdle(submitted.run.runId)).rejects.toThrow("planner transport lost");

    const restarted = await ProductionRunAdvancer.create({ journal, process: processIdentity, serviceReadyEventId,
      projectRoot: root, configuration: configurationWithFailure });
    await restarted.resumeNonterminalRuns();
    expect(plannerCalls).toBe(1);
    expect(journal.readAll().filter((event) => event.type === "first_delivery.planner_reconciliation_required")).toHaveLength(1);
    expect(surface.getRun(submitted.run.runId)?.run).toMatchObject({ lifecycle: "waiting", suspendedFrom: "planning" });
    assertNoCoding(journal);
    journal.close();
  });

  it("keeps the executing operation visible when duplicate enqueue is cancelled", async () => {
    const test = await fixture({ waitingAdapter: true, questionnaire: false, cleanupTimeoutMs: 50 });
    const submitted = await test.surface.submitRun({ kind: "inline_goal", commandId: "duplicate-cancel",
      goal: "Cancel one running analysis." }, { actorId: "operator", channel: "cli" });
    await test.adapter.started;
    test.advancer.schedule({ runId: submitted.run.runId, advanceId: "duplicate-cancel-queued", stage: "restart" });
    test.advancer.schedule({ runId: submitted.run.runId, advanceId: "duplicate-cancel-queued", stage: "restart" });
    const current = test.surface.getRun(submitted.run.runId)!.run;
    test.surface.cancelRun({ runId: submitted.run.runId, expectedVersion: current.streamVersion,
      commandId: "duplicate-cancel-command", cancellationId: "duplicate-cancel-id" },
    { actorId: "operator", channel: "ui" });
    await test.advancer.waitForIdle(submitted.run.runId);

    expect(test.adapter.calls).toBe(1);
    expect(test.adapter.aborted).toBe(true);
    expect(test.journal.readAll().filter((event) => event.type === "analysis.invocation_reserved")).toHaveLength(1);
    expect(test.journal.readAll().filter((event) => event.type === "first_delivery.advance_reserved" &&
      (event.payload as { advanceId?: string }).advanceId === "duplicate-cancel-queued")).toHaveLength(1);
    expect(test.journal.readAll().filter((event) => event.type === "first_delivery.advance_completed" &&
      (event.payload as { advanceId?: string }).advanceId === "duplicate-cancel-queued")).toHaveLength(0);
    test.journal.close();
  });

  it("aborts the executing operation and suppresses duplicate dispatch during shutdown", async () => {
    const test = await fixture({ waitingAdapter: true, questionnaire: false, cleanupTimeoutMs: 50 });
    const submitted = await test.surface.submitRun({ kind: "inline_goal", commandId: "duplicate-shutdown",
      goal: "Stop one running analysis." }, { actorId: "operator", channel: "cli" });
    await test.adapter.started;
    test.advancer.schedule({ runId: submitted.run.runId, advanceId: "duplicate-shutdown-queued", stage: "restart" });
    await test.advancer.shutdown();

    expect(test.adapter.calls).toBe(1);
    expect(test.adapter.aborted).toBe(true);
    expect(test.journal.readAll().filter((event) => event.type === "first_delivery.advance_completed" &&
      (event.payload as { advanceId?: string }).advanceId === "duplicate-shutdown-queued")).toHaveLength(0);
    test.journal.close();
  });

  it("bounds a noncooperative analyzer and ignores its result after cancellation and journal teardown", async () => {
    const adapter = new NonCooperativeAnalysisAdapter();
    const test = await fixture({ analysisAdapter: adapter, questionnaire: false, cleanupTimeoutMs: 25 });
    const submitted = await test.surface.submitRun({ kind: "inline_goal", commandId: "noncooperative-analysis",
      goal: "Do not trust a late analyzer." }, { actorId: "operator", channel: "cli" });
    await adapter.started;
    const current = test.surface.getRun(submitted.run.runId)!.run;
    test.surface.cancelRun({ runId: submitted.run.runId, expectedVersion: current.streamVersion,
      commandId: "noncooperative-analysis-cancel", cancellationId: "noncooperative-analysis-id" },
    { actorId: "operator", channel: "ui" });
    await test.advancer.waitForIdle(submitted.run.runId);

    expect(test.journal.readStream(`analysis:${submitted.run.runId}`)
      .filter((event) => event.type === "analysis.reconciliation_required")).toHaveLength(1);
    const position = test.journal.readAll().at(-1)!.globalPosition;
    test.journal.close();
    adapter.release();
    await adapter.settled;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(position).toBeGreaterThan(0);
  });

  it("bounds a noncooperative planner and ignores its result after shutdown and journal teardown", async () => {
    const planner = new NonCooperativePlanner();
    const test = await fixture({ questionnaire: false, planner: planner.plan, cleanupTimeoutMs: 25 });
    const submitted = await test.surface.submitRun({ kind: "inline_goal", commandId: "noncooperative-planner",
      goal: "Do not trust a late planner." }, { actorId: "operator", channel: "cli" });
    await planner.started;
    await test.advancer.shutdown();

    expect(test.journal.readAll().filter((event) => event.type === "first_delivery.planner_reconciliation_required")).toHaveLength(1);
    expect(test.journal.readAll().filter((event) => event.type === "plan.proposed")).toHaveLength(0);
    test.journal.close();
    planner.release();
    await planner.settled;
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

async function fixture(options: {
  readonly configured?: boolean;
  readonly hooks?: FirstDeliveryFaultHooks;
  readonly questionnaire?: boolean;
  readonly waitingAdapter?: boolean;
  readonly analysisAdapter?: DeterministicAnalysisAdapter | NonCooperativeAnalysisAdapter;
  readonly planner?: (request: FirstDeliveryPlannerRequest, signal: AbortSignal) => Promise<ReturnType<typeof planningProposal>>;
  readonly cleanupTimeoutMs?: number;
} = {}) {
  const root = repository();
  const journal = new SqliteEventJournal(path.join(root, "events.sqlite"));
  const serviceReadyEventId = seedReady(journal);
  const revision = await resolveProjectRevision(root);
  const configured = configuration(root, revision, options.questionnaire ?? true, options.waitingAdapter ?? false,
    options.analysisAdapter, options.planner);
  const selected = options.configured === false ? undefined : configured.configuration;
  const advancer = await ProductionRunAdvancer.create({ journal, process: processIdentity, serviceReadyEventId,
    projectRoot: root, ...(selected === undefined ? {} : { configuration: selected }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: options.cleanupTimeoutMs }) });
  const surface = await createLocalWorkflowSurface({ journal, process: processIdentity, serviceReadyEventId,
    projectRoot: root, projectRevision: revision, runAdvancer: advancer });
  return { root, journal, serviceReadyEventId, advancer, surface, configuration: selected,
    adapter: configured.adapter, plannerCalls: configured.plannerCalls };
}

function configuration(
  root: string,
  revision: Awaited<ReturnType<typeof resolveProjectRevision>>,
  questionnaire: boolean,
  waiting = false,
  suppliedAdapter?: DeterministicAnalysisAdapter | NonCooperativeAnalysisAdapter,
  suppliedPlanner?: (request: FirstDeliveryPlannerRequest, signal: AbortSignal) => Promise<ReturnType<typeof planningProposal>>,
) {
  const projectId = `project-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
  const project = ProjectConfigSchema.parse({
    projectId,
    repositoryPath: root,
    worktreeRoot: path.join(root, ".zentra", "worktrees"),
    validations: {
      focused: [APPROVED_VALIDATION_EXECUTABLE, "--test"],
      full: [APPROVED_VALIDATION_EXECUTABLE, "--test"],
    },
  });
  const security = {
    allowedRepositories: [root],
    allowedFileScopes: ["src/**"],
    forbiddenPaths: ["secrets"],
    network: { default: "denied" as const, allowedDestinations: [] },
    secretHandling: ["No secrets are available."],
    approvalRequiredOperations: ["external_effect"],
    releaseBoundary: "no_release_operations",
    stopAndAskConditions: ["uncertain_effect"],
  };
  const capabilities = [{ capabilityId: "deterministic-worker", agentId: "deterministic-worker",
    role: "implementer" as const, harness: "deterministic" as const }];
  const adapter = suppliedAdapter ?? new DeterministicAnalysisAdapter(questionnaire, waiting);
  const plannerCalls = { count: 0 };
  const configuration: FirstDeliveryConfiguration = {
    analysis: adapter,
    analysisBudget: {
      maxRounds: 3, maxObservations: 16, maxQuestions: 8, maxOptionsPerQuestion: 4,
      maxQuestionnaireOptions: 16, maxOutputBytes: 64 * 1024, maxDurationMs: 10_000,
      maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsdNano: 0,
    },
    project,
    security,
    capabilities,
    approvalExpiresAt: () => "2099-01-01T00:00:00.000Z",
    planner: {
      plan: suppliedPlanner ?? (async (request: FirstDeliveryPlannerRequest) => {
        plannerCalls.count += 1;
        return planningProposal(request, projectId, revision, security, capabilities, project);
      }),
    },
  };
  return { configuration, adapter, plannerCalls };
}

function planningProposal(
  request: FirstDeliveryPlannerRequest,
  projectId: string,
  revision: Awaited<ReturnType<typeof resolveProjectRevision>>,
  security: FirstDeliveryConfiguration["security"],
  capabilities: FirstDeliveryConfiguration["capabilities"],
  project: FirstDeliveryConfiguration["project"],
) {
  return {
    runId: request.run.runId, projectId, projectRevision: revision,
    securityDigest: digestCanonical(security), capabilityCatalogDigest: digestCanonical(capabilities),
    analysisEvidence: request.analysisEvidence,
    plan: { milestoneId: `milestone-${request.run.runId}`, projectId, goal: "Implement the bounded parser behavior.", tasks: [{
      taskId: "parser", title: "Implement parser", description: "Implement and verify the bounded parser change.",
      dependencies: [], ownedPaths: ["src/parser.ts"], forbiddenPaths: ["secrets"],
      acceptanceCriteria: ["The parser passes validation."],
      roleAssignment: { role: "implementer" as const, agentId: "deterministic-worker", harness: "deterministic" as const },
      risk: { level: "medium" as const, authority: "workspace_write" as const, requiresReview: true, requiresApproval: true },
      budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 0, maxInputTokens: 200, maxOutputTokens: 100 },
    }] },
    taskSpecifications: [{ taskId: "parser", capabilityId: "deterministic-worker", broadReadPaths: ["src"],
      potentialWritePaths: ["src/parser.ts"], evidenceRequirements: [
        { criterionIndex: 0, kind: "changed_paths" as const, producerRole: "implementer" as const, digestBound: true as const },
        { criterionIndex: 0, kind: "validation_report" as const, producerRole: "validator" as const, digestBound: true as const },
        { criterionIndex: 0, kind: "review_decision" as const, producerRole: "reviewer" as const, digestBound: true as const },
      ], requiredValidationIds: ["focused"] }],
    validationIdentities: [createValidationIdentitySnapshot(project, "focused")],
  };
}

class DeterministicAnalysisAdapter {
  calls = 0;
  aborted = false;
  private start!: () => void;
  readonly started = new Promise<void>((resolve) => { this.start = resolve; });

  constructor(private readonly questionnaire: boolean, private readonly waiting: boolean) {}

  async analyze(request: AnalysisAdapterRequest, signal: AbortSignal): Promise<AnalysisAdapterResult> {
    this.calls += 1;
    this.start();
    if (this.waiting) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { this.aborted = true; resolve(); }, { once: true }));
      throw new AnalysisExecutionError("cancelled", "completed", usage(), "cancelled by conformance operator");
    }
    return {
      observations: [{ observationId: `observation-${request.round}`, summary: "Bounded source analysis.",
        sourceIds: [request.sources[0]!.sourceId], repositoryPaths: [], affectedScopes: ["scope:parser"] }],
      uncertainties: this.questionnaire && request.round === 1 ? [{
        uncertaintyId: "parser-policy",
        question: "Preserve parser compatibility?",
        materiality: "material",
        affectedScopes: ["scope:parser"],
        dependentScopes: ["scope:parser-tests"],
        options: [
          { optionId: "breaking", label: "Break compatibility", impacts: ["Requires migration authority."] },
          { optionId: "compatible", label: "Preserve compatibility", impacts: ["No migration is required."] },
        ],
        recommendation: { optionId: "compatible", rationale: "No migration authority was granted." },
      }] : [],
      usage: usage(),
    };
  }
}

class NonCooperativeAnalysisAdapter {
  calls = 0;
  readonly aborted = false;
  private start!: () => void;
  private finish!: (value: AnalysisAdapterResult) => void;
  private settledResolve!: () => void;
  readonly started = new Promise<void>((resolve) => { this.start = resolve; });
  readonly settled = new Promise<void>((resolve) => { this.settledResolve = resolve; });
  private readonly result = new Promise<AnalysisAdapterResult>((resolve) => { this.finish = resolve; });

  analyze(): Promise<AnalysisAdapterResult> {
    this.calls += 1;
    this.start();
    return this.result.finally(() => this.settledResolve());
  }

  release(): void {
    this.finish({ observations: [{ observationId: "late-observation", summary: "Late result.", sourceIds: [],
      repositoryPaths: [], affectedScopes: [] }], uncertainties: [], usage: usage() });
  }
}

class NonCooperativePlanner {
  private start!: () => void;
  private finish!: (value: ReturnType<typeof planningProposal>) => void;
  private settledResolve!: () => void;
  private request: FirstDeliveryPlannerRequest | null = null;
  readonly started = new Promise<void>((resolve) => { this.start = resolve; });
  readonly settled = new Promise<void>((resolve) => { this.settledResolve = resolve; });
  private readonly result = new Promise<ReturnType<typeof planningProposal>>((resolve) => { this.finish = resolve; });
  readonly plan = async (request: FirstDeliveryPlannerRequest): Promise<ReturnType<typeof planningProposal>> => {
    this.request = request;
    this.start();
    return this.result.finally(() => this.settledResolve());
  };

  release(): void {
    if (this.request === null) throw new Error("planner did not start");
    const run = this.request.run;
    this.finish(planningProposal(this.request, run.projectId, run.projectRevision, this.request.security,
      this.request.capabilities, this.request.project));
  }
}

function usage() {
  return { inputTokens: 10, outputTokens: 5, inputBytes: 100, outputBytes: 100, durationMs: 10,
    costUsdNano: 0, modelReceiptSha256: "a".repeat(64) };
}

function repository(): string {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-first-delivery-")));
  cleanup.push(root);
  execFileSync("/usr/bin/git", ["init", root], { env: { HOME: root }, stdio: "ignore" });
  execFileSync("/usr/bin/git", ["config", "user.name", "Zentra Test"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["config", "user.email", "zentra@example.invalid"], { cwd: root, env: { HOME: root } });
  writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("/usr/bin/git", ["add", "README.md"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["commit", "-m", "fixture"], { cwd: root, env: { HOME: root }, stdio: "ignore" });
  return root;
}

function seedReady(journal: SqliteEventJournal): string {
  const lifecycle = new ServiceLifecycleService(journal);
  const starting = lifecycle.start({
    serviceId: "first-delivery-service",
    process: processIdentity,
    address: { host: "127.0.0.1", port: 43_295 },
    tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    observation: "performed",
    commandId: "first-delivery-start",
  });
  const agentTrail = seedAgentTrailReady(journal, { serviceId: "first-delivery-service", serviceStartingEventId: starting.eventId });
  return lifecycle.ready({
    serviceId: "first-delivery-service",
    process: processIdentity,
    address: { host: "127.0.0.1", port: 43_295 },
    runtimeSchemaVersion: 1,
    journalSchemaVersion: 6,
    tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    observation: "performed",
    commandId: "first-delivery-ready",
    causationId: agentTrail.agentTrailReadyEventId,
    ...agentTrail,
  }).eventId;
}

function expectSubsequence(actual: readonly string[], expected: readonly string[]): void {
  let cursor = 0;
  for (const type of actual) if (type === expected[cursor]) cursor += 1;
  expect(cursor, `missing canonical event ${expected[cursor] ?? "unknown"}`).toBe(expected.length);
}

function assertNoCoding(journal: SqliteEventJournal): void {
  const types = journal.readAll().map((event) => event.type);
  for (const type of noCodingEvents) expect(types).not.toContain(type);
}
