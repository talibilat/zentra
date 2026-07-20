import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AnalysisCompletedPayloadSchema,
  AnalysisObservedPayloadSchema,
  AnalysisRevisedPayloadSchema,
  AnalysisStartedPayloadSchema,
  analysisStreamId,
  type AnalysisBudget,
  type AnalysisUncertainty,
  type AnalysisUsage,
} from "../../src/analysis/analysis-contracts.js";
import { chargeAnalysisBudget, reserveAnalysisBudget } from "../../src/analysis/analysis-budget.js";
import { prepareAnalysisCompletion } from "../../src/analysis/analysis-completion.js";
import { combinedQuestionnaireOptions, questionnaireEvidenceSha256 } from "../../src/analysis/analysis-questionnaire.js";
import { AttentionService } from "../../src/attention/attention-service.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import { IntakeArtifactStore, computeRetainedAnalysisSourceSha256 } from "../../src/intake/intake-artifact-store.js";
import { IntakeService } from "../../src/intake/intake-service.js";
import { BoundedTicketIntake } from "../../src/intake/ticket-intake.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { PlanningCoordinator } from "../../src/planning/planning-coordinator.js";
import type { PlanningProposalInput } from "../../src/planning/planning-contracts.js";
import {
  APPROVED_VALIDATION_EXECUTABLE,
  ProjectConfigSchema,
  createValidationIdentitySnapshot,
} from "../../src/projects/project-config.js";
import { resolveProjectRevision } from "../../src/runs/project-revision.js";
import { RunService } from "../../src/runs/run-service.js";
import { ServiceLifecycleService } from "../../src/runs/service-lifecycle.js";
import { createLocalWorkflowSurface, type LocalWorkflowSurface } from "../../src/surfaces/local-workflow.js";
import type { RunAdvanceRequest, RunAdvancer } from "../../src/surfaces/workflow-surface.js";
import { seedAgentTrailReady } from "../fixtures/service-ready.js";

const ANALYSIS_BUDGET: AnalysisBudget = {
  maxRounds: 4,
  maxObservations: 8,
  maxQuestions: 4,
  maxOptionsPerQuestion: 4,
  maxQuestionnaireOptions: 8,
  maxOutputBytes: 64 * 1024,
  maxDurationMs: 30_000,
  maxInputTokens: 1_000,
  maxOutputTokens: 1_000,
  maxCostUsdNano: 0,
};

const CAPABILITIES = [{
  capabilityId: "acceptance-worker",
  agentId: "acceptance-worker",
  role: "implementer" as const,
  harness: "deterministic" as const,
}];

export const HOSTILE_TICKET_TEXT = `<script>document.documentElement.dataset.ticketAttack="executed"</script>\n<img src=x onerror="document.documentElement.dataset.ticketAttack='executed'">\n`;

export interface WorkflowAcceptanceFixture {
  readonly root: string;
  readonly database: string;
  readonly tickets: string;
  readonly journal: SqliteEventJournal;
  readonly surface: LocalWorkflowSurface;
  seedFirstQuestion(runId: string): Promise<void>;
  close(): void;
}

export async function createWorkflowAcceptanceFixture(existingRoot?: string): Promise<WorkflowAcceptanceFixture> {
  const root = existingRoot ?? createRepository();
  const database = path.join(root, "workflow-acceptance.sqlite");
  const tickets = path.join(root, "tickets");
  if (existingRoot === undefined) {
    mkdirSync(tickets);
    writeFileSync(path.join(tickets, "hostile-ticket.md"), HOSTILE_TICKET_TEXT);
  }
  const journal = new SqliteEventJournal(database);
  const processIdentity = { pid: 94, processIncarnation: `process-v2:${"9".repeat(64)}` };
  const revision = await resolveProjectRevision(root);
  const readyEventId = ensureServiceReady(journal, processIdentity);
  const runs = new RunService(journal);
  const attention = new AttentionService(journal, () => new Date("2026-07-20T12:00:00.000Z"));
  const project = ProjectConfigSchema.parse({
    projectId: `project-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`,
    repositoryPath: root,
    worktreeRoot: path.join(root, "worktrees"),
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
    secretHandling: ["Never expose secrets."],
    approvalRequiredOperations: ["external_effect"],
    releaseBoundary: "no_release_operations",
    stopAndAskConditions: ["forbidden_file_scope"],
  };
  const planning = new PlanningCoordinator(journal, runs, attention, CAPABILITIES);
  const artifacts = await IntakeArtifactStore.openProject(root);
  const intake = new IntakeService(journal, runs, new BoundedTicketIntake(), artifacts);
  const verificationByRun = new Map<string, Awaited<ReturnType<IntakeService["loadRetainedAnalysisSnapshot"]>>["artifactVerification"]>();

  const advancer: RunAdvancer = {
    advance: ({ runId }: RunAdvanceRequest): void => {
      const events = journal.readStream(analysisStreamId(runId));
      const observed = events.filter((event) => event.type === "analysis.observed");
      const latest = observed.at(-1);
      if (latest === undefined) throw new Error("acceptance analysis has no observed round to advance");
      const uncertainty = AnalysisObservedPayloadSchema.parse(latest.payload).uncertainties;
      appendRevision(journal, runs, attention, runId, uncertainty);
      if (observed.length < 2) {
        appendRound(journal, runs, attention, runId, observed.length + 1, sourceEvidence(events), true);
        return;
      }
      appendRound(journal, runs, attention, runId, observed.length + 1, sourceEvidence(events), false);
      completeAnalysisAndPlan({ journal, runs, planning, project, security, runId,
        artifactVerification: requiredVerification(verificationByRun, runId) });
    },
  };
  const surface = await createLocalWorkflowSurface({
    journal,
    process: processIdentity,
    serviceReadyEventId: readyEventId,
    projectRoot: root,
    projectRevision: revision,
    runAdvancer: advancer,
  });

  return {
    root,
    database,
    tickets,
    journal,
    surface,
    async seedFirstQuestion(runId: string): Promise<void> {
      const retained = await intake.loadRetainedAnalysisSnapshot(runId);
      verificationByRun.set(runId, retained.artifactVerification);
      const run = requiredRun(runs, runId);
      const intakeEvent = runs.readStream(runId).findLast((event) => event.type === "run.intake_completed");
      if (intakeEvent === undefined) throw new Error("acceptance run lacks intake completion");
      const sourceEvidenceSha256 = computeRetainedAnalysisSourceSha256(retained.snapshot);
      const streamId = analysisStreamId(runId);
      journal.append(streamId, 0, [{
        streamId,
        type: "analysis.started",
        correlationId: runId,
        causationId: intakeEvent.eventId,
        payload: AnalysisStartedPayloadSchema.parse({
          schemaVersion: 1,
          runId,
          snapshotSha256: retained.snapshot.snapshotSha256,
          sourceEvidenceSha256,
          budget: ANALYSIS_BUDGET,
          sourceCount: retained.snapshot.sources.length,
          commandId: `acceptance-analysis-start:${runId}`,
          authority: "none",
        }),
      }]);
      appendRound(journal, runs, attention, runId, 1, sourceEvidenceSha256, true);
      if (run.lifecycle !== "analyzing") throw new Error("acceptance analysis started from an invalid run lifecycle");
    },
    close: () => journal.close(),
  };
}

export function removeWorkflowAcceptanceFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function appendRound(
  journal: SqliteEventJournal,
  runs: RunService,
  attention: AttentionService,
  runId: string,
  round: number,
  sourceEvidenceSha256: string,
  material: boolean,
): void {
  const run = requiredRun(runs, runId);
  const events = journal.readStream(analysisStreamId(runId));
  const reservation = reserveAnalysisBudget({
    journal,
    runId,
    round,
    analysisExpectedVersion: events.length,
    analysisCausationId: events.at(-1)?.eventId ?? null,
    requestSha256: digest({ runId, round, fixture: "acceptance" }),
    sourceEvidenceSha256,
    budget: ANALYSIS_BUDGET,
    runStreamVersion: run.streamVersion,
  }).analysisEvent;
  const usage = usageFor(round);
  const uncertainties = material ? [uncertaintyFor(round)] : [];
  chargeAnalysisBudget({
    journal,
    runId,
    analysisExpectedVersion: events.length + 1,
    runExpectedVersion: run.streamVersion,
    usage,
    analysisEvent: {
      streamId: analysisStreamId(runId),
      type: "analysis.observed",
      correlationId: runId,
      causationId: reservation.eventId,
      payload: AnalysisObservedPayloadSchema.parse({
        schemaVersion: 1,
        runId,
        round,
        observations: [{
          observationId: `acceptance-observation:${round}`,
          summary: material
            ? `Durable fixture evidence requires operator choice ${round}.`
            : "Durable fixture evidence is ready for bounded planning.",
          sourceIds: [],
          repositoryPaths: material ? ["src/workflow.ts"] : [],
          affectedScopes: ["scope:workflow"],
        }],
        uncertainties,
        usage,
        sourceEvidenceSha256,
        reservationEventId: reservation.eventId,
        commandId: `acceptance-analysis-observe:${runId}:${round}`,
        authority: "none",
      }),
    },
  });
  if (!material) return;
  const question = requestQuestion(attention, runId, round, uncertainties);
  const current = requiredRun(runs, runId);
  runs.wait(runId, current.streamVersion, `acceptance-analysis-wait:${round}`, `analysis-questionnaire:${round}`);
  if (question.status !== "pending") throw new Error("acceptance questionnaire was not pending");
}

function appendRevision(
  journal: SqliteEventJournal,
  runs: RunService,
  attention: AttentionService,
  runId: string,
  uncertainties: readonly AnalysisUncertainty[],
): void {
  const run = requiredRun(runs, runId);
  if (run.lifecycle === "waiting" || run.lifecycle === "blocked") {
    runs.resume(runId, run.streamVersion, `acceptance-analysis-resume:${uncertainties[0]!.uncertaintyId}`);
  }
  const question = attention.poll(runId).find((item) => item.status === "pending") ??
    allResolvedDecision(attention, journal, runId);
  if (question.status !== "accepted" || question.resolution === null || !("optionId" in question.resolution)) {
    throw new Error("acceptance questionnaire requires an accepted answer");
  }
  const resolution = question.resolution;
  const decisionEvent = attention.readDecisionStream(question.decisionId)
    .findLast((event) => event.type === "decision.accepted");
  if (decisionEvent === undefined) throw new Error("acceptance answer lacks a decision event");
  const chosen = combinedQuestionnaireOptions(uncertainties, ANALYSIS_BUDGET.maxQuestionnaireOptions)
    .find((option) => option.optionId === resolution.optionId);
  if (chosen === undefined) throw new Error("acceptance answer is not a combined questionnaire option");
  const semantics = uncertainties.map((uncertainty) => {
    const selectedId = chosen.selections.find((selection) => selection.uncertaintyId === uncertainty.uncertaintyId)!.optionId;
    return {
      uncertaintyId: uncertainty.uncertaintyId,
      question: uncertainty.question,
      materiality: uncertainty.materiality,
      affectedScopes: uncertainty.affectedScopes,
      dependentScopes: uncertainty.dependentScopes,
      options: uncertainty.options,
      recommendation: uncertainty.recommendation,
      selectedOption: uncertainty.options.find((option) => option.optionId === selectedId)!,
    };
  });
  const packetSha256 = digestCanonical(question.packet);
  const streamId = analysisStreamId(runId);
  const events = journal.readStream(streamId);
  journal.append(streamId, events.length, [{
    streamId,
    type: "analysis.revised",
    correlationId: runId,
    causationId: decisionEvent.eventId,
    payload: AnalysisRevisedPayloadSchema.parse({
      schemaVersion: 1,
      runId,
      round: AnalysisObservedPayloadSchema.parse(events.findLast((event) => event.type === "analysis.observed")!.payload).round,
      answer: {
        decisionId: question.decisionId,
        decisionEventId: decisionEvent.eventId,
        optionId: resolution.optionId,
        actor: resolution.actor,
        evidenceSha256: resolution.evidenceSha256,
        packetSha256,
        selections: chosen.selections,
        semantics,
        semanticSha256: digest({ packetSha256, selectedCombinedOptionId: resolution.optionId, semantics }),
      },
      commandId: `acceptance-analysis-revise:${question.decisionId}`,
      authority: "none",
    }),
  }]);
}

function requestQuestion(
  attention: AttentionService,
  runId: string,
  round: number,
  uncertainties: readonly AnalysisUncertainty[],
) {
  const options = combinedQuestionnaireOptions(uncertainties, ANALYSIS_BUDGET.maxQuestionnaireOptions);
  const evidenceSha256 = questionnaireEvidenceSha256(runId, round, uncertainties);
  return attention.requestQuestion({
    decisionId: `acceptance-question:${digest({ runId, round }).slice(0, 32)}`,
    attentionId: `acceptance-attention:${digest({ runId, round }).slice(0, 32)}`,
    runId,
    question: uncertainties.map((item, index) => `${index + 1}. ${item.question}`).join("\n"),
    questions: uncertainties.map((item) => ({
      uncertaintyId: item.uncertaintyId,
      question: item.question,
      material: item.materiality === "material",
      affectedScopes: item.affectedScopes,
      dependentScopes: item.dependentScopes,
      options: item.options,
      recommendation: item.recommendation,
    })),
    options: options.map(({ optionId, label, impacts }) => ({ optionId, label, impacts })),
    recommendation: { optionId: options[0]!.optionId, rationale: "The deterministic fixture recommends the bounded option." },
    impacts: uncertainties.flatMap((item) => item.options.flatMap((option) => option.impacts)),
    affectedScopes: ["scope:workflow"],
    dependentScopes: ["scope:workflow-tests"],
    material: true,
    evidenceSha256,
    commandId: `acceptance-question:${round}:${evidenceSha256.slice(0, 16)}`,
  });
}

function completeAnalysisAndPlan(input: {
  readonly journal: SqliteEventJournal;
  readonly runs: RunService;
  readonly planning: PlanningCoordinator;
  readonly project: ReturnType<typeof ProjectConfigSchema.parse>;
  readonly security: {
    readonly allowedRepositories: readonly string[];
    readonly allowedFileScopes: readonly string[];
    readonly forbiddenPaths: readonly string[];
    readonly network: { readonly default: "denied"; readonly allowedDestinations: readonly string[] };
    readonly secretHandling: readonly string[];
    readonly approvalRequiredOperations: readonly string[];
    readonly releaseBoundary: string;
    readonly stopAndAskConditions: readonly string[];
  };
  readonly runId: string;
  readonly artifactVerification: Awaited<ReturnType<IntakeService["loadRetainedAnalysisSnapshot"]>>["artifactVerification"];
}): void {
  const streamId = analysisStreamId(input.runId);
  const events = input.journal.readStream(streamId);
  const observed = events.filter((event) => event.type === "analysis.observed");
  const finalObservation = observed.at(-1)!;
  const totalUsage = observed.map((event) => AnalysisObservedPayloadSchema.parse(event.payload).usage)
    .reduce(addUsage, zeroUsage());
  const completion = input.journal.append(streamId, events.length, [{
    streamId,
    type: "analysis.completed",
    correlationId: input.runId,
    causationId: finalObservation.eventId,
    payload: AnalysisCompletedPayloadSchema.parse({
      schemaVersion: 1,
      runId: input.runId,
      rounds: observed.length,
      observationCount: observed.length,
      evidenceSha256: digest(events.map((event) => ({ type: event.type, payload: event.payload }))),
      sourceEvidenceSha256: sourceEvidence(events),
      finalObservationEventId: finalObservation.eventId,
      totalUsage,
      commandId: `acceptance-analysis-complete:${input.runId}`,
      authority: "none",
    }),
  }])[0]!;
  const capability = prepareAnalysisCompletion(input.journal, input.runId, input.artifactVerification);
  const run = requiredRun(input.runs, input.runId);
  const planningRun = input.runs.completeAnalysis(input.runId, run.streamVersion,
    `acceptance-run-analysis-complete:${input.runId}`, capability);
  const payload = AnalysisCompletedPayloadSchema.parse(completion.payload);
  const proposal: PlanningProposalInput = {
    runId: input.runId,
    projectId: planningRun.projectId,
    projectRevision: planningRun.projectRevision,
    securityDigest: digestCanonical(input.security),
    capabilityCatalogDigest: digestCanonical(CAPABILITIES),
    analysisEvidence: {
      analysisStreamId: streamId,
      completionEventId: completion.eventId,
      evidenceSha256: payload.evidenceSha256,
      sourceEvidenceSha256: payload.sourceEvidenceSha256,
    },
    plan: {
      milestoneId: `milestone-${digest(input.runId).slice(0, 24)}`,
      projectId: planningRun.projectId,
      goal: "Implement the exact acceptance workflow plan",
      tasks: [{
        taskId: `task-${digest(input.runId).slice(0, 24)}`,
        title: "Implement bounded workflow",
        description: "Implement and verify only the retained workflow scope.",
        dependencies: [],
        ownedPaths: ["src/workflow.ts"],
        forbiddenPaths: ["secrets"],
        acceptanceCriteria: ["The focused workflow validation passes."],
        roleAssignment: { role: "implementer", agentId: "acceptance-worker", harness: "deterministic" },
        risk: { level: "medium", authority: "workspace_write", requiresReview: true, requiresApproval: true },
        budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 0, maxInputTokens: 100, maxOutputTokens: 100 },
      }],
    },
    taskSpecifications: [{
      taskId: `task-${digest(input.runId).slice(0, 24)}`,
      capabilityId: "acceptance-worker",
      broadReadPaths: ["src"],
      potentialWritePaths: ["src/workflow.ts"],
      evidenceRequirements: [
        { criterionIndex: 0, kind: "changed_paths", producerRole: "implementer", digestBound: true },
        { criterionIndex: 0, kind: "validation_report", producerRole: "validator", digestBound: true },
        { criterionIndex: 0, kind: "review_decision", producerRole: "reviewer", digestBound: true },
      ],
      requiredValidationIds: ["focused"],
    }],
    validationIdentities: [createValidationIdentitySnapshot(input.project, "focused")],
  };
  input.planning.propose({
    proposal,
    project: input.project,
    security: input.security,
    decisionId: `acceptance-approval:${digest(input.runId).slice(0, 24)}`,
    attentionId: `acceptance-plan-attention:${digest(input.runId).slice(0, 24)}`,
    expiresAt: "2027-07-20T00:00:00.000Z",
    commandId: `acceptance-plan:${digest(input.runId).slice(0, 24)}`,
  });
}

function uncertaintyFor(round: number): AnalysisUncertainty {
  return {
    uncertaintyId: `acceptance-uncertainty:${round}`,
    question: round === 1 ? "Preserve the bounded compatibility contract?" : "Keep writes within the reviewed workflow path?",
    materiality: "material",
    affectedScopes: ["scope:workflow"],
    dependentScopes: ["scope:workflow-tests"],
    options: [{
      optionId: `acceptance-option:${round}:bounded`,
      label: "Use the bounded interpretation",
      impacts: ["No authority is expanded."],
    }],
    recommendation: {
      optionId: `acceptance-option:${round}:bounded`,
      rationale: "The option preserves the retained authority boundary.",
    },
  };
}

function allResolvedDecision(attention: AttentionService, journal: SqliteEventJournal, runId: string) {
  const decisionIds = journal.readAll().filter((event) => event.correlationId === runId && event.type === "questionnaire.proposed")
    .map((event) => (event.payload as { readonly decisionId: string }).decisionId);
  const decision = decisionIds.map((decisionId) => attention.getDecision(decisionId)).findLast((item) => item?.status === "accepted");
  if (decision === undefined || decision === null) throw new Error("acceptance run lacks its resolved questionnaire");
  return decision;
}

function ensureServiceReady(
  journal: SqliteEventJournal,
  processIdentity: { readonly pid: number; readonly processIncarnation: string },
): string {
  const existing = journal.readAll().findLast((event) => event.type === "service.ready");
  if (existing !== undefined) return existing.eventId;
  const lifecycle = new ServiceLifecycleService(journal);
  const starting = lifecycle.start({
    serviceId: "zentra-acceptance-service",
    process: processIdentity,
    address: { host: "127.0.0.1", port: 43_294 },
    tokenExpiresAt: "2027-07-20T00:00:00.000Z",
    observation: "performed",
    commandId: "acceptance-service-start",
  });
  const agentTrail = seedAgentTrailReady(journal, {
    serviceId: "zentra-acceptance-service",
    serviceStartingEventId: starting.eventId,
    seed: "9",
  });
  return lifecycle.ready({
    serviceId: "zentra-acceptance-service",
    process: processIdentity,
    address: { host: "127.0.0.1", port: 43_294 },
    runtimeSchemaVersion: 1,
    journalSchemaVersion: 6,
    tokenExpiresAt: "2027-07-20T00:00:00.000Z",
    observation: "performed",
    commandId: "acceptance-service-ready",
    causationId: agentTrail.agentTrailReadyEventId,
    ...agentTrail,
  }).eventId;
}

function createRepository(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-ui-acceptance-")));
  execFileSync("/usr/bin/git", ["init", root], { env: { HOME: root }, stdio: "ignore" });
  execFileSync("/usr/bin/git", ["config", "user.name", "Zentra Acceptance"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["config", "user.email", "zentra@example.invalid"], { cwd: root, env: { HOME: root } });
  writeFileSync(path.join(root, "README.md"), "acceptance fixture\n");
  execFileSync("/usr/bin/git", ["add", "README.md"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["commit", "-m", "fixture"], { cwd: root, env: { HOME: root }, stdio: "ignore" });
  return root;
}

function sourceEvidence(events: readonly { readonly payload: unknown; readonly type: string }[]): string {
  const started = events.find((event) => event.type === "analysis.started");
  return AnalysisStartedPayloadSchema.parse(started!.payload).sourceEvidenceSha256;
}

function usageFor(round: number): AnalysisUsage {
  return {
    inputTokens: 10,
    outputTokens: 5,
    inputBytes: 100,
    outputBytes: 50,
    durationMs: 10,
    costUsdNano: 0,
    modelReceiptSha256: String(round).repeat(64),
  };
}

function zeroUsage(): AnalysisUsage {
  return { inputTokens: 0, outputTokens: 0, inputBytes: 0, outputBytes: 0,
    durationMs: 0, costUsdNano: 0, modelReceiptSha256: "0".repeat(64) };
}

function addUsage(left: AnalysisUsage, right: AnalysisUsage): AnalysisUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    inputBytes: left.inputBytes + right.inputBytes,
    outputBytes: left.outputBytes + right.outputBytes,
    durationMs: left.durationMs + right.durationMs,
    costUsdNano: left.costUsdNano + right.costUsdNano,
    modelReceiptSha256: right.modelReceiptSha256,
  };
}

function requiredRun(runs: RunService, runId: string) {
  const run = runs.get(runId);
  if (run === null) throw new Error(`acceptance run ${runId} not found`);
  return run;
}

function requiredVerification<T>(values: ReadonlyMap<string, T>, runId: string): T {
  const value = values.get(runId);
  if (value === undefined) throw new Error("acceptance run lacks retained artifact verification");
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
