import { createHash } from "node:crypto";

import type { StoredEvent } from "../contracts/event.js";
import type { DecisionActor } from "../attention/attention-contracts.js";
import type { AttentionService } from "../attention/attention-service.js";
import type { AttentionView } from "../attention/attention-projection.js";
import type { IntakeService } from "../intake/intake-service.js";
import { computeRetainedAnalysisSourceSha256 } from "../intake/intake-artifact-store.js";
import type { TicketIntakeSnapshot } from "../intake/ticket-intake.js";
import { readStreamEvents, type EventJournal } from "../journal/journal.js";
import type { RunService } from "../runs/run-service.js";
import { prepareAnalysisCompletion } from "./analysis-completion.js";
import {
  ANALYSIS_SCHEMA_VERSION,
  AnalysisBudgetExhaustedPayloadSchema,
  AnalysisBudgetRevisedPayloadSchema,
  AnalysisBudgetSchema,
  AnalysisCancelledPayloadSchema,
  AnalysisCompletedPayloadSchema,
  AnalysisInvocationReservedPayloadSchema,
  AnalysisObservedPayloadSchema,
  AnalysisRevisedPayloadSchema,
  AnalysisStartedPayloadSchema,
  RetainedAnalysisSourceSchema,
  analysisStreamId,
  type AnalysisAdapterRequest,
  type AnalysisAnswer,
  type AnalysisBudget,
  type AnalysisObservation,
  type AnalysisUncertainty,
  type RetainedAnalysisSource,
} from "./analysis-contracts.js";
import { AnalysisExecutionError, SupervisedAnalysisAdapter } from "./supervised-analysis-adapter.js";

const activeReservations = new Set<string>();

export type AnalysisCoordinatorResult =
  | { readonly status: "waiting"; readonly round: number; readonly decisionId: string }
  | { readonly status: "reconciling"; readonly round: number }
  | { readonly status: "completed"; readonly round: number }
  | { readonly status: "cancelled"; readonly round: number }
  | { readonly status: "budget_exhausted"; readonly round: number; readonly decisionId: string };

interface AnalysisState {
  readonly started: ReturnType<typeof AnalysisStartedPayloadSchema.parse> | null;
  readonly observations: readonly ReturnType<typeof AnalysisObservedPayloadSchema.parse>[];
  readonly observationEvents: readonly StoredEvent[];
  readonly answers: readonly AnalysisAnswer[];
  readonly pendingReservation: { readonly event: StoredEvent; readonly payload: ReturnType<typeof AnalysisInvocationReservedPayloadSchema.parse> } | null;
  readonly completed: boolean;
  readonly cancelled: boolean;
  readonly exhaustion: { readonly event: StoredEvent; readonly payload: ReturnType<typeof AnalysisBudgetExhaustedPayloadSchema.parse> } | null;
  readonly budget: AnalysisBudget | null;
}

export class AnalysisCoordinator {
  constructor(
    private readonly journal: EventJournal,
    private readonly runs: RunService,
    private readonly attention: AttentionService,
    private readonly intake: IntakeService,
    private readonly analyzer: SupervisedAnalysisAdapter,
  ) {}

  async advance(input: { readonly runId: string; readonly budget: AnalysisBudget; readonly signal: AbortSignal }): Promise<AnalysisCoordinatorResult> {
    const requestedBudget = AnalysisBudgetSchema.parse(input.budget);
    const streamId = analysisStreamId(input.runId);
    let events = readStreamEvents(this.journal, streamId);
    let state = projectAnalysis(events, input.runId);
    const run = this.requireRun(input.runId);
    assertBudgetWithinRun(requestedBudget, run.budget);

    if (run.terminalOutcome === "cancelled") {
      if (!state.cancelled && !state.completed) {
        const cancellation = this.runs.readStream(input.runId).findLast((event) => event.type === "run.cancelled")!;
        events = this.append(events, "analysis.cancelled", AnalysisCancelledPayloadSchema.parse({
          schemaVersion: 1, runId: input.runId, reason: "run_cancelled", cancellationEventId: cancellation.eventId,
          commandId: `analysis-cancel:${input.runId}`, authority: "none",
        }), cancellation.eventId);
      }
      return { status: "cancelled", round: state.observations.length };
    }
    if (run.lifecycle === "terminal") throw new Error("analysis cannot continue a terminal run");
    if (state.completed && run.lifecycle === "planning") return { status: "completed", round: state.observations.length };
    if (state.cancelled) return { status: "cancelled", round: state.observations.length };

    const retained = await this.loadRetained(input.runId);
    if (state.started === null) {
      if (run.lifecycle !== "analyzing") throw new Error(`analysis requires run lifecycle analyzing, got ${run.lifecycle}`);
      const intakeEvent = this.runs.readStream(input.runId).find((event) => event.type === "run.intake_completed");
      if (intakeEvent === undefined) throw new Error("analysis requires durable intake completion");
      try {
        events = this.append(events, "analysis.started", AnalysisStartedPayloadSchema.parse({
          schemaVersion: 1,
          runId: input.runId,
          snapshotSha256: retained.snapshot.snapshotSha256,
          sourceEvidenceSha256: retained.sourceEvidenceSha256,
          budget: requestedBudget,
          sourceCount: retained.sources.length,
          commandId: `analysis-start:${input.runId}`,
          authority: "none",
        }), intakeEvent.eventId);
      } catch (error) {
        if (!isOptimisticConflict(error)) throw error;
        events = readStreamEvents(this.journal, streamId);
      }
      state = projectAnalysis(events, input.runId);
    }
    if (state.started === null || state.budget === null) throw new Error("analysis start is missing after reservation");
    if (JSON.stringify(requestedBudget) !== JSON.stringify(state.budget)) throw new Error("analysis request budget contradicts durable budget");
    if (retained.snapshot.snapshotSha256 !== state.started.snapshotSha256 || retained.sources.length !== state.started.sourceCount ||
      retained.sourceEvidenceSha256 !== state.started.sourceEvidenceSha256) throw new Error("retained intake snapshot contradicts durable analysis start");

    if (state.completed) {
      await this.finishRun(input.runId, retained.artifactVerification);
      return { status: "completed", round: state.observations.length };
    }
    if (state.pendingReservation !== null) {
      if (!activeReservations.has(state.pendingReservation.event.eventId)) this.ensureWaiting(input.runId, "analysis_invocation_reconciliation");
      return { status: "reconciling", round: state.pendingReservation.payload.round };
    }

    if (state.exhaustion !== null) return this.handleExhaustion(input.runId, state);

    const unanswered = unansweredMaterial(state);
    if (unanswered !== null) {
      const questionnaire = this.ensureQuestionnaire(input.runId, unanswered.round, unanswered.uncertainties);
      if (questionnaire.status === "pending") {
        this.ensureWaiting(input.runId, `analysis-questionnaire:${unanswered.round}`);
        return { status: "waiting", round: unanswered.round, decisionId: questionnaire.decisionId };
      }
      if (questionnaire.status !== "accepted" || questionnaire.resolution === null || !("optionId" in questionnaire.resolution)) {
        return this.cancelFromDecision(input.runId, state, questionnaire);
      }
      const decisionEvent = this.decisionTerminalEvent(questionnaire);
      if (decisionEvent === undefined) throw new Error("analysis answer lacks durable decision evidence");
      const resolution = questionnaire.resolution;
      const selections = questionnaireOptions(unanswered.uncertainties).find((option) => option.optionId === resolution.optionId)?.selections;
      if (selections === undefined) throw new Error("analysis answer is not a deterministic questionnaire option");
      this.resumeIfWaiting(input.runId, `analysis-resume:${unanswered.round}`);
      events = this.append(events, "analysis.revised", AnalysisRevisedPayloadSchema.parse({
        schemaVersion: 1, runId: input.runId, round: unanswered.round,
        answer: {
          decisionId: questionnaire.decisionId, decisionEventId: decisionEvent.eventId, optionId: resolution.optionId,
          actor: resolution.actor, evidenceSha256: resolution.evidenceSha256, selections,
        },
        commandId: `analysis-revise:${input.runId}:${unanswered.round}`, authority: "none",
      }), decisionEvent.eventId);
      state = projectAnalysis(events, input.runId);
    }

    const beforeReason = consumedBudgetReason(state, state.budget!, true);
    if (beforeReason !== null) return this.exhaust(input.runId, events, state, beforeReason);
    if (input.signal.aborted) return this.cancelSafely(input.runId, events, state, "aborted", null);

    const request = analysisRequest(input.runId, state, retained.sources);
    const requestSha256 = digest(request);
    let reservation: StoredEvent;
    try {
      const next = this.append(events, "analysis.invocation_reserved", AnalysisInvocationReservedPayloadSchema.parse({
        schemaVersion: 1, runId: input.runId, round: request.round, requestSha256,
        sourceEvidenceSha256: retained.sourceEvidenceSha256, budget: state.budget,
        commandId: `analysis-reserve:${input.runId}:${request.round}`, authority: "none",
      }), events.at(-1)?.eventId ?? null);
      reservation = next.at(-1)!;
      events = next;
      activeReservations.add(reservation.eventId);
    } catch (error) {
      if (!isOptimisticConflict(error)) throw error;
      const concurrent = projectAnalysis(readStreamEvents(this.journal, streamId), input.runId);
      if (concurrent.pendingReservation !== null) return { status: "reconciling", round: concurrent.pendingReservation.payload.round };
      throw error;
    }

    let result;
    try {
      result = await this.analyzer.analyze(request, input.signal);
    } catch (error) {
      activeReservations.delete(reservation.eventId);
      if (error instanceof AnalysisExecutionError && error.outcome === "cancelled") {
        return this.cancelSafely(input.runId, events, state, "aborted", reservation.eventId);
      }
      if (error instanceof AnalysisExecutionError && error.outcome === "timed_out") {
        return this.exhaust(input.runId, events, state, "duration", reservation.eventId);
      }
      return this.cancelSafely(input.runId, events, state, "analyzer_failed", reservation.eventId);
    }
    activeReservations.delete(reservation.eventId);
    if (input.signal.aborted) return this.cancelSafely(input.runId, events, state, "aborted", reservation.eventId);

    events = this.append(events, "analysis.observed", AnalysisObservedPayloadSchema.parse({
      schemaVersion: 1, runId: input.runId, round: request.round, observations: result.observations,
      uncertainties: result.uncertainties, usage: result.usage, sourceEvidenceSha256: retained.sourceEvidenceSha256,
      reservationEventId: reservation.eventId, commandId: `analysis-observe:${input.runId}:${request.round}`, authority: "none",
    }), reservation.eventId);
    state = projectAnalysis(events, input.runId);
    const afterReason = consumedBudgetReason(state, state.budget!, false);
    if (afterReason !== null) return this.exhaust(input.runId, events, state, afterReason);

    if (result.uncertainties.length > 0) {
      const questionnaire = this.ensureQuestionnaire(input.runId, request.round, result.uncertainties);
      if (result.uncertainties.some((item) => item.materiality === "material")) {
        this.ensureWaiting(input.runId, `analysis-questionnaire:${request.round}`);
        return { status: "waiting", round: request.round, decisionId: questionnaire.decisionId };
      }
    }

    const totalUsage = sumUsage(state.observations);
    const finalObservation = state.observationEvents.at(-1)!;
    events = this.append(events, "analysis.completed", AnalysisCompletedPayloadSchema.parse({
      schemaVersion: 1, runId: input.runId, rounds: state.observations.length,
      observationCount: state.observations.reduce((total, item) => total + item.observations.length, 0),
      evidenceSha256: evidenceDigest(events), sourceEvidenceSha256: retained.sourceEvidenceSha256,
      finalObservationEventId: finalObservation.eventId, totalUsage,
      commandId: `analysis-complete:${input.runId}`, authority: "none",
    }), finalObservation.eventId);
    await this.finishRun(input.runId, retained.artifactVerification);
    return { status: "completed", round: request.round };
  }

  reviseBudget(input: {
    readonly runId: string;
    readonly budget: AnalysisBudget;
    readonly actor: DecisionActor;
    readonly commandId: string;
    readonly evidenceSha256: string;
  }): AnalysisCoordinatorResult {
    const events = readStreamEvents(this.journal, analysisStreamId(input.runId));
    const state = projectAnalysis(events, input.runId);
    if (state.exhaustion === null || state.budget === null) throw new Error("analysis has no exhausted budget to revise");
    const run = this.requireRun(input.runId);
    const budget = AnalysisBudgetSchema.parse(input.budget);
    assertBudgetWithinRun(budget, run.budget);
    if (!strictlyHigherBudget(budget, state.budget)) throw new Error("revised analysis budget must be strictly higher");
    const exhaustionAttention = this.ensureBudgetAttention(input.runId, state.exhaustion.payload);
    if (exhaustionAttention.status !== "accepted" || exhaustionAttention.resolution === null ||
      !("optionId" in exhaustionAttention.resolution) || exhaustionAttention.resolution.optionId !== "await_budget_revision") {
      throw new Error("budget revision requires the durable await_budget_revision decision");
    }
    const gate = this.ensureBudgetRevisionGate(input.runId, state.exhaustion.payload);
    if (gate.status !== "pending") throw new Error("budget revision gate is already consumed");
    const accepted = this.attention.answer(gate.decisionId, {
      runId: input.runId, expectedVersion: gate.streamVersion, optionId: "budget_revised", actor: input.actor,
      commandId: `${input.commandId}:gate`, evidenceSha256: input.evidenceSha256,
    });
    const decisionEvent = this.decisionTerminalEvent(accepted)!;
    this.append(events, "analysis.budget_revised", AnalysisBudgetRevisedPayloadSchema.parse({
      schemaVersion: 1, runId: input.runId, priorBudget: state.budget, budget,
      exhaustionEventId: state.exhaustion.event.eventId, decisionEventId: decisionEvent.eventId,
      actor: input.actor, evidenceSha256: input.evidenceSha256, commandId: input.commandId, authority: "none",
    }), decisionEvent.eventId);
    this.resumeIfWaiting(input.runId, `${input.commandId}:resume`);
    return { status: "waiting", round: state.observations.length, decisionId: accepted.decisionId };
  }

  private async loadRetained(runId: string): Promise<{
    readonly snapshot: TicketIntakeSnapshot;
    readonly sources: readonly RetainedAnalysisSource[];
    readonly sourceEvidenceSha256: string;
    readonly artifactVerification: Awaited<ReturnType<IntakeService["loadRetainedAnalysisSnapshot"]>>["artifactVerification"];
  }> {
    const retained = await this.intake.loadRetainedAnalysisSnapshot(runId);
    const sources = retained.snapshot.sources.map((source) => {
      if (source.artifact === null) throw new Error("retained intake source lacks an artifact");
      const normalizedContentSha256 = createHash("sha256").update(Buffer.from(source.quotedText, "utf8")).digest("hex");
      return RetainedAnalysisSourceSchema.parse({
        sourceId: source.sourceId, relativePath: source.relativePath, artifactId: source.artifact.artifactId,
        sha256: source.sha256, normalizedContentSha256, quotedText: source.quotedText, trust: source.trust,
        provenanceSha256: digest(source.provenance),
      });
    }).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const sourceEvidenceSha256 = computeRetainedAnalysisSourceSha256(retained.snapshot);
    return { ...retained, sources, sourceEvidenceSha256 };
  }

  private handleExhaustion(runId: string, state: AnalysisState): AnalysisCoordinatorResult {
    const exhausted = state.exhaustion!;
    const attention = this.ensureBudgetAttention(runId, exhausted.payload);
    if (attention.status === "pending") {
      this.ensureWaiting(runId, "analysis_budget_exhausted");
      return { status: "budget_exhausted", round: state.observations.length, decisionId: attention.decisionId };
    }
    if (attention.status !== "accepted" || attention.resolution === null || !("optionId" in attention.resolution)) {
      return this.cancelFromDecision(runId, state, attention);
    }
    if (attention.resolution.optionId === "cancel_analysis") return this.cancelFromDecision(runId, state, attention, "budget_cancelled");
    const gate = this.ensureBudgetRevisionGate(runId, exhausted.payload);
    this.ensureWaiting(runId, "analysis_budget_revision_required");
    return { status: "budget_exhausted", round: state.observations.length, decisionId: gate.decisionId };
  }

  private exhaust(
    runId: string,
    events: readonly StoredEvent[],
    state: AnalysisState,
    reason: ReturnType<typeof AnalysisBudgetExhaustedPayloadSchema.parse>["reason"],
    causationId = events.at(-1)?.eventId ?? null,
  ): AnalysisCoordinatorResult {
    const uncertainties = state.observations.at(-1)?.uncertainties ?? [];
    const material = uncertainties.filter((item) => item.materiality === "material");
    const payload = AnalysisBudgetExhaustedPayloadSchema.parse({
      schemaVersion: 1, runId, round: state.observations.length, reason,
      affectedScopes: canonical(material.flatMap((item) => item.affectedScopes)),
      dependentScopes: canonical(material.flatMap((item) => item.dependentScopes)),
      evidenceSha256: digest({ reason, budget: state.budget, usage: sumUsage(state.observations) }),
      commandId: `analysis-budget:${runId}:${state.observations.length}:${reason}`, authority: "none",
    });
    this.append(events, "analysis.budget_exhausted", payload, causationId);
    const attention = this.ensureBudgetAttention(runId, payload);
    this.ensureWaiting(runId, "analysis_budget_exhausted");
    return { status: "budget_exhausted", round: state.observations.length, decisionId: attention.decisionId };
  }

  private cancelSafely(
    runId: string,
    events: readonly StoredEvent[],
    state: AnalysisState,
    reason: "aborted" | "analyzer_failed",
    causationId: string | null,
  ): AnalysisCoordinatorResult {
    this.append(events, "analysis.cancelled", AnalysisCancelledPayloadSchema.parse({
      schemaVersion: 1, runId, reason, cancellationEventId: null,
      commandId: `analysis-cancel:${runId}:${state.observations.length + 1}`, authority: "none",
    }), causationId);
    return { status: "cancelled", round: state.observations.length };
  }

  private cancelFromDecision(
    runId: string,
    state: AnalysisState,
    attention: AttentionView,
    reason: "budget_cancelled" | "decision_rejected" | "decision_expired" = attention.status === "expired" ? "decision_expired" : "decision_rejected",
  ): AnalysisCoordinatorResult {
    const decisionEvent = this.decisionTerminalEvent(attention);
    const run = this.requireRun(runId);
    const actor = attention.resolution !== null && "actor" in attention.resolution
      ? { actorId: attention.resolution.actor.actorId, kind: attention.resolution.actor.kind }
      : { actorId: "zentra-analysis", kind: "service" as const };
    const cancelled = this.runs.cancel(runId, {
      expectedVersion: run.streamVersion, commandId: `analysis-run-cancel:${attention.decisionId}`,
      causationId: decisionEvent?.eventId ?? null, process: run.activeProcess,
    }, { cancellationId: `analysis-cancel:${attention.decisionId}`, requestedBy: actor, reasonCode: "operator_requested" });
    const cancellationEvent = this.runs.readStream(runId).findLast((event) => event.type === "run.cancelled")!;
    const events = readStreamEvents(this.journal, analysisStreamId(runId));
    this.append(events, "analysis.cancelled", AnalysisCancelledPayloadSchema.parse({
      schemaVersion: 1, runId, reason, cancellationEventId: cancellationEvent.eventId,
      commandId: `analysis-cancel:${attention.decisionId}`, authority: "none",
    }), cancellationEvent.eventId);
    return { status: "cancelled", round: state.observations.length };
  }

  private ensureQuestionnaire(runId: string, round: number, uncertaintiesInput: readonly AnalysisUncertainty[]): AttentionView {
    const uncertainties = [...uncertaintiesInput].sort((left, right) => left.uncertaintyId.localeCompare(right.uncertaintyId));
    const options = questionnaireOptions(uncertainties);
    const packetDigest = digest({ runId, round, uncertainties });
    const decisionId = `analysis-question:${packetDigest.slice(0, 32)}`;
    const existing = this.attention.getDecision(decisionId);
    if (existing !== null) return existing;
    const recommendedSelections = uncertainties.map((item) => ({ uncertaintyId: item.uncertaintyId, optionId: item.recommendation.optionId }));
    const recommended = options.find((option) => JSON.stringify(option.selections) === JSON.stringify(recommendedSelections));
    if (recommended === undefined) throw new Error("questionnaire recommendations are invalid");
    const material = uncertainties.filter((item) => item.materiality === "material");
    return this.attention.requestQuestion({
      decisionId, attentionId: `analysis-attention:${packetDigest.slice(0, 32)}`, runId,
      question: uncertainties.map((item, index) => `${index + 1}. ${item.question}`).join("\n"),
      questions: uncertainties.map((item) => ({
        uncertaintyId: item.uncertaintyId, question: item.question, material: item.materiality === "material",
        affectedScopes: item.affectedScopes, dependentScopes: item.dependentScopes, options: item.options,
        recommendation: item.recommendation,
      })),
      options: options.map(({ optionId, label, impacts }) => ({ optionId, label, impacts })),
      recommendation: { optionId: recommended.optionId, rationale: "Combines each retained per-question recommendation." },
      impacts: canonical(uncertainties.flatMap((item) => item.options.flatMap((option) => option.impacts))),
      affectedScopes: canonical(material.flatMap((item) => item.affectedScopes)),
      dependentScopes: canonical(material.flatMap((item) => item.dependentScopes)),
      material: material.length > 0, evidenceSha256: packetDigest,
      commandId: `analysis-question:${round}:${packetDigest.slice(0, 16)}`,
    });
  }

  private ensureBudgetAttention(runId: string, exhausted: ReturnType<typeof AnalysisBudgetExhaustedPayloadSchema.parse>): AttentionView {
    const decisionId = `analysis-budget:${exhausted.evidenceSha256.slice(0, 32)}`;
    return this.attention.getDecision(decisionId) ?? this.attention.requestQuestion({
      decisionId, attentionId: `analysis-budget-attention:${exhausted.evidenceSha256.slice(0, 32)}`, runId,
      question: "The bounded analysis budget is exhausted. How should this scope proceed?",
      options: [
        { optionId: "await_budget_revision", label: "Wait for an explicit higher budget", impacts: ["No analyzer runs before a provenance-bound revision"] },
        { optionId: "cancel_analysis", label: "Cancel analysis", impacts: ["The run is durably cancelled"] },
      ],
      recommendation: { optionId: "await_budget_revision", rationale: "No certainty is fabricated." },
      impacts: ["Affected scopes remain paused"], affectedScopes: exhausted.affectedScopes,
      dependentScopes: exhausted.dependentScopes, material: true, evidenceSha256: exhausted.evidenceSha256,
      commandId: `analysis-budget-question:${exhausted.round}:${exhausted.reason}`,
    });
  }

  private ensureBudgetRevisionGate(runId: string, exhausted: ReturnType<typeof AnalysisBudgetExhaustedPayloadSchema.parse>): AttentionView {
    const decisionId = `analysis-budget-revision:${exhausted.evidenceSha256.slice(0, 32)}`;
    return this.attention.getDecision(decisionId) ?? this.attention.requestQuestion({
      decisionId, attentionId: `analysis-budget-revision-attention:${exhausted.evidenceSha256.slice(0, 32)}`, runId,
      question: "Provide and confirm an explicit higher bounded analysis budget.",
      options: [{ optionId: "budget_revised", label: "Apply the supplied higher budget", impacts: ["Bounded analysis may resume"] }],
      recommendation: null, impacts: ["Scopes remain paused until this exact gate is consumed"],
      affectedScopes: exhausted.affectedScopes, dependentScopes: exhausted.dependentScopes,
      material: true, evidenceSha256: exhausted.evidenceSha256,
      commandId: `analysis-budget-revision-question:${exhausted.round}:${exhausted.reason}`,
    });
  }

  private async finishRun(runId: string, artifactVerification: Awaited<ReturnType<IntakeService["loadRetainedAnalysisSnapshot"]>>["artifactVerification"]): Promise<void> {
    const run = this.requireRun(runId);
    if (run.lifecycle === "planning") return;
    if (run.lifecycle !== "analyzing") throw new Error(`completed analysis cannot transition run from ${run.lifecycle}`);
    const capability = prepareAnalysisCompletion(this.journal, runId, artifactVerification);
    this.runs.completeAnalysis(runId, run.streamVersion, `analysis-transition:${runId}`, capability);
  }

  private ensureWaiting(runId: string, reason: string): void {
    const run = this.requireRun(runId);
    if (run.lifecycle !== "waiting" && run.lifecycle !== "blocked") this.runs.wait(runId, run.streamVersion, `analysis-wait:${reason}`, reason);
  }

  private resumeIfWaiting(runId: string, commandId: string): void {
    const run = this.requireRun(runId);
    if (run.lifecycle === "waiting" || run.lifecycle === "blocked") this.runs.resume(runId, run.streamVersion, commandId);
  }

  private decisionTerminalEvent(view: AttentionView): StoredEvent | undefined {
    return this.attention.readDecisionStream(view.decisionId).findLast((event) =>
      event.type === "decision.accepted" || event.type === "decision.rejected" || event.type === "decision.expired");
  }

  private requireRun(runId: string) {
    const run = this.runs.get(runId);
    if (run === null) throw new Error(`run ${runId} not found`);
    return run;
  }

  private append(events: readonly StoredEvent[], type: string, payload: unknown, causationId: string | null): readonly StoredEvent[] {
    const runId = (payload as { readonly runId: string }).runId;
    const stored = this.journal.append(analysisStreamId(runId), events.length, [{
      streamId: analysisStreamId(runId), type, payload, causationId, correlationId: runId,
    }]);
    return [...events, ...stored];
  }
}

function projectAnalysis(events: readonly StoredEvent[], runId: string): AnalysisState {
  let started: AnalysisState["started"] = null;
  let budget: AnalysisBudget | null = null;
  let pendingReservation: AnalysisState["pendingReservation"] = null;
  let exhaustion: AnalysisState["exhaustion"] = null;
  const observations: ReturnType<typeof AnalysisObservedPayloadSchema.parse>[] = [];
  const observationEvents: StoredEvent[] = [];
  const answers: AnalysisAnswer[] = [];
  let completed = false;
  let cancelled = false;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const prior = events[index - 1];
    if (event.streamId !== analysisStreamId(runId) || event.streamVersion !== index + 1 || event.correlationId !== runId) {
      throw new Error("analysis event metadata is not contiguous or bound to its run");
    }
    if (completed || cancelled) throw new Error("analysis event follows terminal analysis state");
    switch (event.type) {
      case "analysis.started":
        if (index !== 0) throw new Error("analysis can start only once");
        started = AnalysisStartedPayloadSchema.parse(event.payload);
        budget = started.budget;
        break;
      case "analysis.invocation_reserved": {
        if (pendingReservation !== null || exhaustion !== null || event.causationId !== prior?.eventId) throw new Error("analysis reservation transition is invalid");
        const payload = AnalysisInvocationReservedPayloadSchema.parse(event.payload);
        pendingReservation = { event, payload };
        break;
      }
      case "analysis.observed": {
        const payload = AnalysisObservedPayloadSchema.parse(event.payload);
        if (pendingReservation === null || event.causationId !== pendingReservation.event.eventId ||
          payload.reservationEventId !== pendingReservation.event.eventId || payload.round !== observations.length + 1) {
          throw new Error("analysis observation does not consume its exact reservation");
        }
        observations.push(payload);
        observationEvents.push(event);
        pendingReservation = null;
        break;
      }
      case "analysis.revised": {
        const payload = AnalysisRevisedPayloadSchema.parse(event.payload);
        if (payload.round !== observations.length || event.causationId !== payload.answer.decisionEventId) throw new Error("analysis revision transition is invalid");
        answers.push(payload.answer);
        break;
      }
      case "analysis.budget_exhausted": {
        const payload = AnalysisBudgetExhaustedPayloadSchema.parse(event.payload);
        if (event.causationId !== prior?.eventId) throw new Error("analysis budget exhaustion causation is invalid");
        exhaustion = { event, payload };
        if (pendingReservation !== null && event.causationId === pendingReservation.event.eventId) pendingReservation = null;
        break;
      }
      case "analysis.budget_revised": {
        const payload = AnalysisBudgetRevisedPayloadSchema.parse(event.payload);
        if (exhaustion === null || payload.exhaustionEventId !== exhaustion.event.eventId || event.causationId !== payload.decisionEventId ||
          JSON.stringify(payload.priorBudget) !== JSON.stringify(budget)) throw new Error("analysis budget revision transition is invalid");
        budget = payload.budget;
        exhaustion = null;
        break;
      }
      case "analysis.completed":
        AnalysisCompletedPayloadSchema.parse(event.payload);
        completed = true;
        break;
      case "analysis.cancelled":
        AnalysisCancelledPayloadSchema.parse(event.payload);
        cancelled = true;
        break;
      default:
        throw new Error(`unknown analysis event type ${event.type}`);
    }
    const payloadRunId = typeof event.payload === "object" && event.payload !== null ? (event.payload as { runId?: unknown }).runId : undefined;
    if (payloadRunId !== runId) throw new Error("analysis payload belongs to a different run");
  }
  return { started, observations, observationEvents, answers, pendingReservation, completed, cancelled, exhaustion, budget };
}

function analysisRequest(runId: string, state: AnalysisState, sources: readonly RetainedAnalysisSource[]): AnalysisAdapterRequest {
  const usage = sumUsage(state.observations);
  return Object.freeze({
    runId, round: state.observations.length + 1, sources,
    priorObservations: Object.freeze(state.observations.flatMap((item) => item.observations)),
    answers: Object.freeze([...state.answers]), budget: state.budget!,
    invocationLimits: Object.freeze({
      timeoutMs: Math.max(1, state.budget!.maxDurationMs - usage.durationMs),
      maxOutputBytes: Math.max(1, state.budget!.maxOutputBytes - usage.outputBytes),
    }),
    securityBoundary: Object.freeze({
      authority: "none", effects: "none", tools: Object.freeze([]) as readonly [], secrets: Object.freeze([]) as readonly [],
      environment: Object.freeze({}), sourceInstructions: "untrusted_data_only", retainHiddenReasoning: false,
    }),
  });
}

function unansweredMaterial(state: AnalysisState): { readonly round: number; readonly uncertainties: readonly AnalysisUncertainty[] } | null {
  const latest = state.observations.at(-1);
  if (latest === undefined || state.answers.length >= state.observations.length) return null;
  return latest.uncertainties.some((item) => item.materiality === "material")
    ? { round: latest.round, uncertainties: latest.uncertainties }
    : null;
}

function questionnaireOptions(uncertainties: readonly AnalysisUncertainty[]) {
  let combinations: Array<{ labels: string[]; impacts: string[]; selections: Array<{ uncertaintyId: string; optionId: string }> }> = [
    { labels: [], impacts: [], selections: [] },
  ];
  for (const uncertainty of uncertainties) combinations = combinations.flatMap((combination) => uncertainty.options.map((option) => ({
    labels: [...combination.labels, `${uncertainty.uncertaintyId}: ${option.label}`], impacts: [...combination.impacts, ...option.impacts],
    selections: [...combination.selections, { uncertaintyId: uncertainty.uncertaintyId, optionId: option.optionId }],
  })));
  return combinations.map((item) => ({
    optionId: `choice:${digest(item.selections).slice(0, 24)}`, label: item.labels.join("; "), impacts: item.impacts, selections: item.selections,
  }));
}

function consumedBudgetReason(
  state: AnalysisState,
  budget: AnalysisBudget,
  beforeInvocation: boolean,
): ReturnType<typeof AnalysisBudgetExhaustedPayloadSchema.parse>["reason"] | null {
  const usage = sumUsage(state.observations);
  const observationCount = state.observations.reduce((total, item) => total + item.observations.length, 0);
  const questionCount = state.observations.reduce((total, item) => total + item.uncertainties.length, 0);
  if (beforeInvocation ? state.observations.length >= budget.maxRounds : state.observations.length > budget.maxRounds) return "rounds";
  if (observationCount > budget.maxObservations) return "observations";
  if (questionCount > budget.maxQuestions) return "questions";
  if (state.observations.some((item) => item.uncertainties.some((question) => question.options.length > budget.maxOptionsPerQuestion))) return "options";
  if (state.observations.some((item) => item.uncertainties.reduce((total, question) => total * question.options.length, 1) > budget.maxQuestionnaireOptions)) return "options";
  if (state.observations.some((item) => questionnaireShapeExceedsAttention(item.uncertainties))) return "output";
  if (usage.outputBytes > budget.maxOutputBytes) return "output";
  if (usage.durationMs > budget.maxDurationMs) return "duration";
  if (usage.inputTokens > budget.maxInputTokens) return "input_tokens";
  if (usage.outputTokens > budget.maxOutputTokens) return "output_tokens";
  if (usage.costUsdNano > budget.maxCostUsdNano) return "cost";
  return null;
}

function sumUsage(observations: readonly ReturnType<typeof AnalysisObservedPayloadSchema.parse>[]) {
  return observations.reduce((total, item) => ({
    inputTokens: total.inputTokens + item.usage.inputTokens,
    outputTokens: total.outputTokens + item.usage.outputTokens,
    outputBytes: total.outputBytes + item.usage.outputBytes,
    durationMs: total.durationMs + item.usage.durationMs,
    costUsdNano: total.costUsdNano + item.usage.costUsdNano,
  }), { inputTokens: 0, outputTokens: 0, outputBytes: 0, durationMs: 0, costUsdNano: 0 });
}

function assertBudgetWithinRun(budget: AnalysisBudget, run: { maxDurationMs: number; maxInputTokens: number; maxOutputTokens: number; maxCostUsdNano: number }): void {
  if (budget.maxDurationMs > run.maxDurationMs || budget.maxInputTokens > run.maxInputTokens ||
    budget.maxOutputTokens > run.maxOutputTokens || budget.maxCostUsdNano > run.maxCostUsdNano) {
    throw new Error("analysis budget exceeds authoritative run budget");
  }
}

function strictlyHigherBudget(next: AnalysisBudget, prior: AnalysisBudget): boolean {
  const keys = Object.keys(prior) as Array<keyof AnalysisBudget>;
  return keys.every((key) => next[key] >= prior[key]) && keys.some((key) => next[key] > prior[key]);
}

function evidenceDigest(events: readonly StoredEvent[]): string {
  return digest(events.map((event) => ({ type: event.type, payload: event.payload })));
}

function canonical(values: readonly string[]): string[] { return [...new Set(values)].sort(); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function isOptimisticConflict(error: unknown): boolean { return error instanceof Error && /^expected version \d+, actual \d+$/.test(error.message); }

function questionnaireShapeExceedsAttention(uncertainties: readonly AnalysisUncertainty[]): boolean {
  if (uncertainties.length === 0) return false;
  const question = uncertainties.map((item, index) => `${index + 1}. ${item.question}`).join("\n");
  const options = questionnaireOptions(uncertainties);
  return Buffer.byteLength(question, "utf8") > 4_096 ||
    new Set(uncertainties.flatMap((item) => item.options.flatMap((option) => option.impacts))).size > 64 ||
    options.some((option) => Buffer.byteLength(option.label, "utf8") > 4_096 || option.impacts.length > 64);
}
