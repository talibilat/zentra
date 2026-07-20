import { randomUUID } from "node:crypto";

import type { NewEvent, StoredEvent } from "../contracts/event.js";
import { isAtomicEventJournal, readStreamEvents, type AtomicAppend, type EventJournal } from "../journal/journal.js";
import { runStreamId } from "../runs/run-contracts.js";
import {
  AnalysisBudgetChargedPayloadSchema,
  AnalysisBudgetReservedPayloadSchema,
  analysisBudgetStreamId,
  analysisStreamId,
  type AnalysisBudget,
  type AnalysisUsage,
} from "./analysis-contracts.js";

export interface AnalysisBudgetLedger {
  readonly streamVersion: number;
  readonly consumed: AnalysisUsage;
  readonly pending: { readonly event: StoredEvent; readonly payload: ReturnType<typeof AnalysisBudgetReservedPayloadSchema.parse> } | null;
  readonly lastEventId: string | null;
}

export function projectAnalysisBudget(journal: EventJournal, runId: string): AnalysisBudgetLedger {
  const events = readStreamEvents(journal, analysisBudgetStreamId(runId));
  let consumed = zeroUsage();
  let pending: AnalysisBudgetLedger["pending"] = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.streamId !== analysisBudgetStreamId(runId) || event.streamVersion !== index + 1 || event.correlationId !== runId) {
      throw new Error("analysis budget ledger metadata is invalid");
    }
    if (event.causationId !== (events[index - 1]?.eventId ?? null)) throw new Error("analysis budget ledger causation is invalid");
    if (event.type === "analysis.budget_reserved") {
      if (pending !== null) throw new Error("analysis budget has overlapping reservations");
      const payload = AnalysisBudgetReservedPayloadSchema.parse(event.payload);
      if (payload.runId !== runId) throw new Error("analysis budget reservation identity is invalid");
      pending = { event, payload };
    } else if (event.type === "analysis.budget_charged") {
      if (pending === null) throw new Error("analysis budget charge lacks reservation");
      const payload = AnalysisBudgetChargedPayloadSchema.parse(event.payload);
      if (payload.runId !== runId || payload.reservationId !== pending.payload.reservationId || payload.reservationEventId !== pending.event.eventId ||
        event.causationId !== pending.event.eventId) throw new Error("analysis budget charge contradicts reservation");
      consumed = addUsage(consumed, payload.usage);
      pending = null;
    } else throw new Error(`unknown analysis budget event ${event.type}`);
  }
  return { streamVersion: events.length, consumed, pending, lastEventId: events.at(-1)?.eventId ?? null };
}

export function reserveAnalysisBudget(input: {
  readonly journal: EventJournal;
  readonly runId: string;
  readonly round: number;
  readonly analysisExpectedVersion: number;
  readonly analysisCausationId: string | null;
  readonly requestSha256: string;
  readonly sourceEvidenceSha256: string;
  readonly budget: AnalysisBudget;
  readonly runStreamVersion: number;
}): { readonly analysisEvent: StoredEvent; readonly budgetEvent: StoredEvent; readonly limits: ReturnType<typeof AnalysisBudgetReservedPayloadSchema.parse>["limits"] } {
  if (!isAtomicEventJournal(input.journal)) throw new Error("analysis budget reservation requires an atomic journal");
  const ledger = projectAnalysisBudget(input.journal, input.runId);
  if (ledger.pending !== null) throw new Error("analysis budget reservation requires reconciliation");
  const limits = remaining(input.budget, ledger.consumed);
  const reservationId = `analysis-reservation:${randomUUID()}`;
  const analysisEventId = randomUUID();
  const budgetEventId = randomUUID();
  const analysisPayload = {
    schemaVersion: 1 as const, runId: input.runId, round: input.round, requestSha256: input.requestSha256,
    sourceEvidenceSha256: input.sourceEvidenceSha256, budget: input.budget, reservationId,
    budgetReservationEventId: budgetEventId, runStreamVersion: input.runStreamVersion,
    commandId: `analysis-reserve:${input.runId}:${input.round}`, authority: "none" as const,
  };
  const budgetPayload = AnalysisBudgetReservedPayloadSchema.parse({
    schemaVersion: 1, runId: input.runId, reservationId, round: input.round, limits,
    analysisStreamVersion: input.analysisExpectedVersion + 1, analysisReservationEventId: analysisEventId,
    commandId: `analysis-budget-reserve:${input.runId}:${input.round}`, authority: "none",
  });
  const stored = input.journal.appendAtomically([
    { streamId: analysisStreamId(input.runId), expectedVersion: input.analysisExpectedVersion, events: [{
      eventId: analysisEventId, streamId: analysisStreamId(input.runId), type: "analysis.invocation_reserved",
      payload: analysisPayload, causationId: input.analysisCausationId, correlationId: input.runId,
    } as NewEvent<string, unknown>] },
    { streamId: analysisBudgetStreamId(input.runId), expectedVersion: ledger.streamVersion, events: [{
      eventId: budgetEventId, streamId: analysisBudgetStreamId(input.runId), type: "analysis.budget_reserved",
      payload: budgetPayload, causationId: ledger.lastEventId, correlationId: input.runId,
    } as NewEvent<string, unknown>] },
    { streamId: runStreamId(input.runId), expectedVersion: input.runStreamVersion, events: [] },
  ]);
  return {
    analysisEvent: stored.find((event) => event.eventId === analysisEventId)!,
    budgetEvent: stored.find((event) => event.eventId === budgetEventId)!,
    limits,
  };
}

export function remainingAnalysisBudget(journal: EventJournal, runId: string, budget: AnalysisBudget) {
  const ledger = projectAnalysisBudget(journal, runId);
  if (ledger.pending !== null) throw new Error("analysis budget reservation requires reconciliation");
  return remaining(budget, ledger.consumed);
}

export function chargeAnalysisBudget(input: {
  readonly journal: EventJournal;
  readonly runId: string;
  readonly analysisExpectedVersion: number;
  readonly analysisEvent: NewEvent<string, unknown>;
  readonly usage: AnalysisUsage;
  readonly runExpectedVersion?: number;
}): { readonly analysisEvent: StoredEvent; readonly budgetEvent: StoredEvent } {
  if (!isAtomicEventJournal(input.journal)) throw new Error("analysis budget charge requires an atomic journal");
  const prepared = prepareAnalysisBudgetCharge(input);
  const stored = input.journal.appendAtomically(prepared.writes);
  return { analysisEvent: stored.find((event) => event.eventId === prepared.analysisEventId)!, budgetEvent: stored.find((event) => event.eventId === prepared.budgetEventId)! };
}

export function prepareAnalysisBudgetCharge(input: {
  readonly journal: EventJournal;
  readonly runId: string;
  readonly analysisExpectedVersion: number;
  readonly analysisEvent: NewEvent<string, unknown>;
  readonly usage: AnalysisUsage;
  readonly runExpectedVersion?: number;
}): { readonly writes: readonly AtomicAppend[]; readonly analysisEventId: string; readonly budgetEventId: string } {
  const ledger = projectAnalysisBudget(input.journal, input.runId);
  if (ledger.pending === null) throw new Error("analysis budget charge lacks a pending reservation");
  const analysisEventId = randomUUID();
  const budgetEventId = randomUUID();
  const charged = AnalysisBudgetChargedPayloadSchema.parse({
    schemaVersion: 1, runId: input.runId, reservationId: ledger.pending.payload.reservationId,
    reservationEventId: ledger.pending.event.eventId, analysisEventId, usage: input.usage,
    commandId: `analysis-budget-charge:${input.runId}:${ledger.pending.payload.round}`, authority: "none",
  });
  const writes: AtomicAppend[] = [
    { streamId: analysisStreamId(input.runId), expectedVersion: input.analysisExpectedVersion, events: [{ ...input.analysisEvent, eventId: analysisEventId } as NewEvent<string, unknown>] },
    { streamId: analysisBudgetStreamId(input.runId), expectedVersion: ledger.streamVersion, events: [{
      eventId: budgetEventId, streamId: analysisBudgetStreamId(input.runId), type: "analysis.budget_charged",
      payload: charged, causationId: ledger.pending.event.eventId, correlationId: input.runId,
    } as NewEvent<string, unknown>] },
    ...(input.runExpectedVersion === undefined ? [] : [{
      streamId: runStreamId(input.runId), expectedVersion: input.runExpectedVersion, events: [],
    }]),
  ];
  return { writes, analysisEventId, budgetEventId };
}

function remaining(budget: AnalysisBudget, consumed: AnalysisUsage) {
  const limits = {
    maxDurationMs: budget.maxDurationMs - consumed.durationMs,
    maxOutputBytes: budget.maxOutputBytes - consumed.outputBytes,
    maxInputTokens: budget.maxInputTokens - consumed.inputTokens,
    maxOutputTokens: budget.maxOutputTokens - consumed.outputTokens,
    maxCostUsdNano: budget.maxCostUsdNano - consumed.costUsdNano,
  };
  if (limits.maxDurationMs <= 0 || limits.maxOutputBytes <= 0 || limits.maxInputTokens <= 0 || limits.maxOutputTokens <= 0 || limits.maxCostUsdNano < 0) {
    throw new Error("analysis budget is exhausted");
  }
  return limits;
}

function zeroUsage(): AnalysisUsage {
  return { durationMs: 0, inputBytes: 0, outputBytes: 0, inputTokens: 0, outputTokens: 0, costUsdNano: 0, modelReceiptSha256: "0".repeat(64) };
}

function addUsage(left: AnalysisUsage, right: AnalysisUsage): AnalysisUsage {
  return {
    durationMs: left.durationMs + right.durationMs, inputBytes: left.inputBytes + right.inputBytes,
    outputBytes: left.outputBytes + right.outputBytes, inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens, costUsdNano: left.costUsdNano + right.costUsdNano,
    modelReceiptSha256: right.modelReceiptSha256,
  };
}
