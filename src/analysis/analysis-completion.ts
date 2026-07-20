import { createHash } from "node:crypto";

import { DecisionAcceptedPayloadSchema, decisionStreamId } from "../attention/attention-contracts.js";
import { projectAttention } from "../attention/attention-projection.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import type { StoredEvent } from "../contracts/event.js";
import type { IntakeArtifactVerificationCapability } from "../intake/intake-artifact-store.js";
import { findAllEvent, readStreamEvents, type EventJournal } from "../journal/journal.js";
import {
  AnalysisBudgetExhaustedPayloadSchema,
  AnalysisBudgetReservedPayloadSchema,
  AnalysisBudgetChargedPayloadSchema,
  AnalysisBudgetRevisedPayloadSchema,
  AnalysisCancelledPayloadSchema,
  AnalysisCompletedPayloadSchema,
  AnalysisInvocationReservedPayloadSchema,
  AnalysisObservedPayloadSchema,
  AnalysisRevisedPayloadSchema,
  AnalysisReconciliationRequiredPayloadSchema,
  AnalysisReconciliationResolvedPayloadSchema,
  AnalysisStartedPayloadSchema,
  analysisStreamId,
  type AnalysisBudget,
} from "./analysis-contracts.js";
import { combinedQuestionnaireOptions, questionnaireEvidenceSha256 } from "./analysis-questionnaire.js";

declare const analysisCompletionBrand: unique symbol;
export interface AnalysisCompletionCapability { readonly [analysisCompletionBrand]: true }

interface VerifiedAnalysisCompletion {
  readonly runId: string;
  readonly analysisStreamId: string;
  readonly completionEventId: string;
  readonly evidenceSha256: string;
  readonly sourceEvidenceSha256: string;
  readonly intakeArtifactVerification: IntakeArtifactVerificationCapability;
}

const pending = new WeakMap<object, VerifiedAnalysisCompletion>();

export function prepareAnalysisCompletion(
  journal: EventJournal,
  runId: string,
  intakeArtifactVerification: IntakeArtifactVerificationCapability,
): AnalysisCompletionCapability {
  const verified = verifyAnalysisReplay(journal, runId);
  const capability = Object.freeze({});
  pending.set(capability, { ...verified, intakeArtifactVerification });
  return capability as AnalysisCompletionCapability;
}

export function consumeAnalysisCompletion(capability: AnalysisCompletionCapability): VerifiedAnalysisCompletion {
  const verified = typeof capability === "object" && capability !== null ? pending.get(capability) : undefined;
  if (verified === undefined) throw new Error("analysis completion capability is invalid or already consumed");
  pending.delete(capability);
  return verified;
}

function verifyAnalysisReplay(journal: EventJournal, runId: string): Omit<VerifiedAnalysisCompletion, "intakeArtifactVerification"> {
  const streamId = analysisStreamId(runId);
  const events = readStreamEvents(journal, streamId);
  if (events.length < 4) throw new Error("analysis completion evidence is incomplete");
  let started: ReturnType<typeof AnalysisStartedPayloadSchema.parse> | null = null;
  let budget: AnalysisBudget | null = null;
  let pendingReservation: { readonly event: StoredEvent; readonly payload: ReturnType<typeof AnalysisInvocationReservedPayloadSchema.parse> } | null = null;
  let lastObserved: ReturnType<typeof AnalysisObservedPayloadSchema.parse> | null = null;
  let finalObservationEvent: StoredEvent | null = null;
  let rounds = 0;
  let observations = 0;
  let totalUsage = zeroUsage();
  let completed: { readonly event: StoredEvent; readonly payload: ReturnType<typeof AnalysisCompletedPayloadSchema.parse> } | null = null;
  let exhausted: StoredEvent | null = null;
  let materialAnswered = true;
  const observationIds = new Set<string>();
  const uncertaintyIds = new Set<string>();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.streamId !== streamId || event.streamVersion !== index + 1 || event.correlationId !== runId) {
      throw new Error("analysis replay metadata is not contiguous or bound to its run");
    }
    if (completed !== null) throw new Error("analysis event follows completion");
    const prior = events[index - 1];
    switch (event.type) {
      case "analysis.started": {
        if (index !== 0) throw new Error("analysis start is not first");
        started = AnalysisStartedPayloadSchema.parse(event.payload);
        assertRun(started.runId, runId);
        const intake = findAllEvent(journal, (candidate) => candidate.eventId === event.causationId);
        if (intake?.type !== "run.intake_completed" || intake.correlationId !== runId) throw new Error("analysis start lacks intake causation");
        budget = started.budget;
        break;
      }
      case "analysis.invocation_reserved": {
        if (started === null || pendingReservation !== null || exhausted !== null || !materialAnswered || event.causationId !== prior?.eventId) {
          throw new Error("analysis invocation reservation transition is invalid");
        }
        const payload = AnalysisInvocationReservedPayloadSchema.parse(event.payload);
        assertRun(payload.runId, runId);
        if (payload.round !== rounds + 1 || payload.sourceEvidenceSha256 !== started.sourceEvidenceSha256 ||
          JSON.stringify(payload.budget) !== JSON.stringify(budget)) throw new Error("analysis invocation reservation contradicts replay state");
        const budgetReservation = findAllEvent(journal, (candidate) => candidate.eventId === payload.budgetReservationEventId);
        if (budgetReservation?.type !== "analysis.budget_reserved") throw new Error("analysis invocation lacks shared budget reservation");
        const reserved = AnalysisBudgetReservedPayloadSchema.parse(budgetReservation.payload);
        if (reserved.runId !== runId || reserved.reservationId !== payload.reservationId ||
          reserved.analysisReservationEventId !== event.eventId || reserved.analysisStreamVersion !== event.streamVersion) {
          throw new Error("analysis invocation contradicts shared budget reservation");
        }
        pendingReservation = { event, payload };
        break;
      }
      case "analysis.observed": {
        if (pendingReservation === null || event.causationId !== pendingReservation.event.eventId) throw new Error("analysis observation lacks reservation causation");
        const payload = AnalysisObservedPayloadSchema.parse(event.payload);
        assertRun(payload.runId, runId);
        if (payload.round !== pendingReservation.payload.round || payload.reservationEventId !== pendingReservation.event.eventId ||
          payload.sourceEvidenceSha256 !== pendingReservation.payload.sourceEvidenceSha256) throw new Error("analysis observation contradicts its reservation");
        const chargeEvent = findAllEvent(journal, (candidate) => candidate.type === "analysis.budget_charged" &&
          typeof candidate.payload === "object" && candidate.payload !== null &&
          (candidate.payload as { analysisEventId?: unknown }).analysisEventId === event.eventId);
        if (chargeEvent === undefined) throw new Error("analysis observation lacks shared budget charge");
        const charged = AnalysisBudgetChargedPayloadSchema.parse(chargeEvent.payload);
        if (charged.runId !== runId || charged.reservationId !== pendingReservation.payload.reservationId ||
          JSON.stringify(charged.usage) !== JSON.stringify(payload.usage)) throw new Error("analysis observation contradicts measured budget charge");
        rounds += 1;
        observations += payload.observations.length;
        for (const observation of payload.observations) {
          if (observationIds.has(observation.observationId)) throw new Error("analysis observation identity is duplicated across rounds");
          observationIds.add(observation.observationId);
        }
        for (const uncertainty of payload.uncertainties) {
          if (uncertaintyIds.has(uncertainty.uncertaintyId)) throw new Error("analysis uncertainty identity is duplicated across rounds");
          uncertaintyIds.add(uncertainty.uncertaintyId);
        }
        totalUsage = addUsage(totalUsage, payload.usage);
        lastObserved = payload;
        materialAnswered = !payload.uncertainties.some((item) => item.materiality === "material");
        finalObservationEvent = event;
        pendingReservation = null;
        exhausted = null;
        break;
      }
      case "analysis.revised": {
        if (lastObserved === null) throw new Error("analysis revision precedes observation");
        const payload = AnalysisRevisedPayloadSchema.parse(event.payload);
        assertRun(payload.runId, runId);
        if (materialAnswered) throw new Error("analysis revision has no unresolved material uncertainty");
        const decisionEvents = readStreamEvents(journal, decisionStreamId(payload.answer.decisionId));
        const decisionView = projectAttention(decisionEvents);
        const decision = decisionEvents.find((candidate) => candidate.eventId === payload.answer.decisionEventId);
        if (decision?.type !== "decision.accepted" || decision.eventId !== event.causationId) throw new Error("analysis revision lacks accepted decision causation");
        const accepted = DecisionAcceptedPayloadSchema.parse(decision.payload);
        if (accepted.runId !== runId || accepted.decisionId !== payload.answer.decisionId || accepted.optionId !== payload.answer.optionId ||
          JSON.stringify(accepted.actor) !== JSON.stringify(payload.answer.actor) || accepted.evidenceSha256 !== payload.answer.evidenceSha256) {
          throw new Error("analysis revision provenance contradicts durable decision");
        }
        if (decisionView?.kind !== "question" || decisionView.runId !== runId || decisionView.packet === null ||
          !("questions" in decisionView.packet) || JSON.stringify(decisionView.packet.questions) !== JSON.stringify(lastObserved.uncertainties.map((item) => ({
            uncertaintyId: item.uncertaintyId, question: item.question, material: item.materiality === "material",
            affectedScopes: item.affectedScopes, dependentScopes: item.dependentScopes, options: item.options, recommendation: item.recommendation,
          })))) throw new Error("analysis questionnaire does not preserve observed uncertainties");
        if (payload.answer.packetSha256 !== digestCanonical(decisionView.packet) ||
          decisionView.packet.evidenceSha256 !== questionnaireEvidenceSha256(runId, lastObserved.round, lastObserved.uncertainties)) {
          throw new Error("analysis questionnaire packet digest is invalid");
        }
        const chosen = combinedQuestionnaireOptions(lastObserved.uncertainties, 64)
          .find((option) => option.optionId === accepted.optionId);
        if (chosen === undefined || JSON.stringify(chosen.selections) !== JSON.stringify(payload.answer.selections)) {
          throw new Error("analysis answer selections do not match the accepted canonical combined option");
        }
        if (lastObserved.uncertainties.some((item) => item.materiality === "material") && accepted.actor.kind !== "operator") {
          throw new Error("material analysis questionnaire lacks an operator decision");
        }
        const expectedSemantics = lastObserved.uncertainties.map((uncertainty) => {
          const selectedId = chosen.selections.find((selection) => selection.uncertaintyId === uncertainty.uncertaintyId)!.optionId;
          return {
            uncertaintyId: uncertainty.uncertaintyId, question: uncertainty.question, materiality: uncertainty.materiality,
            affectedScopes: uncertainty.affectedScopes, dependentScopes: uncertainty.dependentScopes,
            options: uncertainty.options, recommendation: uncertainty.recommendation,
            selectedOption: uncertainty.options.find((option) => option.optionId === selectedId)!,
          };
        });
        const expectedSemanticSha256 = evidenceDigestValue({
          packetSha256: payload.answer.packetSha256, selectedCombinedOptionId: accepted.optionId, semantics: expectedSemantics,
        });
        if (JSON.stringify(payload.answer.semantics) !== JSON.stringify(expectedSemantics) ||
          payload.answer.semanticSha256 !== expectedSemanticSha256) {
          throw new Error("analysis answer semantic history is invalid");
        }
        const selectionIds = payload.answer.selections.map((item) => item.uncertaintyId);
        if (JSON.stringify(selectionIds) !== JSON.stringify(lastObserved.uncertainties.map((item) => item.uncertaintyId))) {
          throw new Error("analysis revision does not answer the complete questionnaire");
        }
        for (const selection of payload.answer.selections) {
          const uncertainty = lastObserved.uncertainties.find((item) => item.uncertaintyId === selection.uncertaintyId);
          if (uncertainty === undefined || !uncertainty.options.some((option) => option.optionId === selection.optionId)) {
            throw new Error("analysis revision selection is not an observed option");
          }
        }
        materialAnswered = true;
        break;
      }
      case "analysis.budget_exhausted": {
        const payload = AnalysisBudgetExhaustedPayloadSchema.parse(event.payload);
        assertRun(payload.runId, runId);
        if (event.causationId !== prior?.eventId) throw new Error("analysis budget exhaustion causation is invalid");
        exhausted = event;
        if (pendingReservation !== null && event.causationId === pendingReservation.event.eventId) pendingReservation = null;
        break;
      }
      case "analysis.budget_revised": {
        if (exhausted === null) throw new Error("analysis budget revision lacks exhaustion");
        const payload = AnalysisBudgetRevisedPayloadSchema.parse(event.payload);
        assertRun(payload.runId, runId);
        if (payload.exhaustionEventId !== exhausted.eventId || JSON.stringify(payload.priorBudget) !== JSON.stringify(budget) ||
          event.causationId !== payload.decisionEventId || !strictlyHigherBudget(payload.budget, payload.priorBudget)) {
          throw new Error("analysis budget revision is not a higher provenance-bound budget");
        }
        const decisionEvent = findAllEvent(journal, (candidate) => candidate.eventId === payload.decisionEventId);
        if (decisionEvent?.type !== "decision.accepted") throw new Error("analysis budget revision lacks an accepted decision");
        const accepted = DecisionAcceptedPayloadSchema.parse(decisionEvent.payload);
        const decisionView = projectAttention(readStreamEvents(journal, decisionEvent.streamId));
        const expectedEvidence = evidenceDigestValue({ runId, exhaustionEventId: exhausted.eventId, budget: payload.budget });
        if (accepted.runId !== runId || accepted.optionId !== "budget_revised" || accepted.actor.kind !== "operator" ||
          JSON.stringify(accepted.actor) !== JSON.stringify(payload.actor) || decisionView?.packet?.evidenceSha256 !== expectedEvidence ||
          payload.evidenceSha256 !== expectedEvidence) throw new Error("analysis budget revision decision is not bound to the exact operator-approved budget");
        assertUsageWithin(totalUsage, payload.budget);
        budget = payload.budget;
        exhausted = null;
        break;
      }
      case "analysis.reconciliation_required": {
        if (pendingReservation === null) throw new Error("analysis reconciliation lacks reservation");
        const payload = AnalysisReconciliationRequiredPayloadSchema.parse(event.payload);
        if (payload.runId !== runId || payload.reservationEventId !== pendingReservation.event.eventId || event.causationId !== pendingReservation.event.eventId) {
          throw new Error("analysis reconciliation evidence is invalid");
        }
        break;
      }
      case "analysis.reconciliation_resolved": {
        if (pendingReservation === null) throw new Error("analysis reconciliation resolution lacks reservation");
        const payload = AnalysisReconciliationResolvedPayloadSchema.parse(event.payload);
        if (payload.runId !== runId || payload.reservationEventId !== pendingReservation.event.eventId ||
          payload.actor.kind !== "operator" || event.causationId !== payload.reconciliationEventId) {
          throw new Error("analysis reconciliation resolution is invalid");
        }
        pendingReservation = null;
        break;
      }
      case "analysis.completed": {
        if (pendingReservation !== null || exhausted !== null || !materialAnswered || lastObserved === null || finalObservationEvent === null || observations === 0) {
          throw new Error("analysis cannot complete without settled observations");
        }
        if (lastObserved.uncertainties.some((item) => item.materiality === "material")) throw new Error("analysis completed with material uncertainty");
        const payload = AnalysisCompletedPayloadSchema.parse(event.payload);
        assertRun(payload.runId, runId);
        if (event.causationId !== finalObservationEvent.eventId || payload.finalObservationEventId !== finalObservationEvent.eventId ||
          payload.rounds !== rounds || payload.observationCount !== observations || payload.sourceEvidenceSha256 !== started!.sourceEvidenceSha256 ||
          JSON.stringify(payload.totalUsage) !== JSON.stringify(totalUsage) || payload.evidenceSha256 !== evidenceDigest(events.slice(0, index))) {
          throw new Error("analysis completion payload contradicts strict replay");
        }
        assertUsageWithin(totalUsage, budget!);
        completed = { event, payload };
        break;
      }
      case "analysis.cancelled":
        AnalysisCancelledPayloadSchema.parse(event.payload);
        throw new Error("cancelled analysis cannot issue completion evidence");
      default:
        throw new Error(`unknown analysis replay event ${event.type}`);
    }
  }
  if (completed === null || started === null) throw new Error("analysis completion event is missing");
  return {
    runId,
    analysisStreamId: streamId,
    completionEventId: completed.event.eventId,
    evidenceSha256: completed.payload.evidenceSha256,
    sourceEvidenceSha256: started.sourceEvidenceSha256,
  };
}

function addUsage(left: ReturnType<typeof zeroUsage>, right: ReturnType<typeof zeroUsage>): ReturnType<typeof zeroUsage> {
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

function zeroUsage() { return { inputTokens: 0, outputTokens: 0, inputBytes: 0, outputBytes: 0, durationMs: 0, costUsdNano: 0, modelReceiptSha256: "0".repeat(64) }; }

function assertUsageWithin(usage: ReturnType<typeof zeroUsage>, budget: AnalysisBudget): void {
  if (usage.inputTokens > budget.maxInputTokens || usage.outputTokens > budget.maxOutputTokens ||
    usage.outputBytes > budget.maxOutputBytes || usage.durationMs > budget.maxDurationMs || usage.costUsdNano > budget.maxCostUsdNano) {
    throw new Error("analysis completion usage exceeds durable budget");
  }
}

function strictlyHigherBudget(next: AnalysisBudget, prior: AnalysisBudget): boolean {
  const keys = Object.keys(prior) as Array<keyof AnalysisBudget>;
  return keys.every((key) => next[key] >= prior[key]) && keys.some((key) => next[key] > prior[key]);
}

function evidenceDigest(events: readonly StoredEvent[]): string {
  return createHash("sha256").update(JSON.stringify(events.map((event) => ({ type: event.type, payload: event.payload })))).digest("hex");
}

function assertRun(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("analysis payload belongs to a different run");
}

function evidenceDigestValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
