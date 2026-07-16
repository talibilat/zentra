import { createHash } from "node:crypto";

import type { StoredEvent } from "../contracts/event.js";
import type { MilestoneRole } from "../contracts/milestone.js";
import type { EventJournal } from "../journal/journal.js";
import {
  OutcomeHistoryRecordSchema,
  RoutingSelectionSchema,
  type OutcomeHistoryRecord,
  type RoutingSelection,
} from "./routing-events.js";

const streamId = (executionId: string): string => `routing-execution/${executionId}`;

export class JournalOutcomeHistoryStore {
  constructor(private readonly journal: EventJournal) {}

  begin(input: Omit<RoutingSelection, "schemaVersion" | "algorithmVersion"> & {
    readonly correlationId: string;
  }): StoredEvent {
    const { correlationId, ...selectionInput } = input;
    const payload = RoutingSelectionSchema.parse({
      ...selectionInput,
      schemaVersion: 1,
      algorithmVersion: "approved-history-v1",
    });
    return this.journal.append(streamId(payload.executionId), 0, [{
      streamId: streamId(payload.executionId),
      type: "routing.model_selected",
      payload,
      causationId: null,
      correlationId,
    }])[0]!;
  }

  complete(input: {
    readonly executionId: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly durationMs: number;
    readonly outcome: OutcomeHistoryRecord["outcome"];
    readonly validation: OutcomeHistoryRecord["validation"];
    readonly review: OutcomeHistoryRecord["review"];
    readonly terminalEvidence: OutcomeHistoryRecord["terminalEvidence"];
    readonly causationId: string;
  }): StoredEvent {
    const events = this.journal.readStream(streamId(input.executionId));
    if (events.length !== 1 || events[0]!.type !== "routing.model_selected") {
      throw new Error("routing outcome requires exactly one incomplete selection");
    }
    const selection = RoutingSelectionSchema.parse(events[0]!.payload);
    assertTerminalEvidence(this.journal.readAll(), input.terminalEvidence, input.outcome, selection.taskId);
    const payload = OutcomeHistoryRecordSchema.parse({
      schemaVersion: 1,
      executionId: selection.executionId,
      taskId: selection.taskId,
      taskType: selection.taskType,
      role: selection.role,
      model: selection.model,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      outcome: input.outcome,
      validation: input.validation,
      review: input.review,
      terminalEvidence: input.terminalEvidence,
      selection: {
        eventId: events[0]!.eventId,
        modelSheetSha256: selection.modelSheetSha256,
      },
    });
    return this.journal.append(streamId(input.executionId), 1, [{
      streamId: streamId(input.executionId),
      type: "routing.outcome_recorded",
      payload,
      causationId: input.causationId,
      correlationId: events[0]!.correlationId,
    }])[0]!;
  }

  completeFromTask(executionId: string, taskEvents: readonly StoredEvent[]): StoredEvent {
    const selectionEvents = this.journal.readStream(streamId(executionId));
    if (selectionEvents.length !== 1) throw new Error("routing selection is not incomplete");
    const selection = RoutingSelectionSchema.parse(selectionEvents[0]!.payload);
    const writer = taskEvents.find((event) => event.type === "task.writer_completed");
    const terminal = taskEvents.findLast((event) => /^task\.(?:completed|cancelled|denied|timed_out|failed)$/.test(event.type));
    if (writer === undefined || terminal === undefined || terminal.streamId !== selection.taskId) {
      throw new Error("task outcome lacks writer or terminal evidence");
    }
    const writerPayload = objectPayload(writer);
    if (
      requiredString(writerPayload, "workerId") !== selection.model.capabilityId ||
      requiredString(writerPayload, "requestedModelSha256") !== selection.model.transportModelSha256
    ) {
      throw new Error("requested model identity contradicts routing selection");
    }
    const validationArtifact = taskEvents.findLast((event) => event.type === "artifact.validation_report_recorded");
    const reviewArtifact = taskEvents.findLast((event) => event.type === "artifact.review_report_recorded");
    const validation: OutcomeHistoryRecord["validation"] = validationArtifact === undefined
      ? { status: "not_observed" as const, evidenceSha256: null }
      : validationArtifactHistory(validationArtifact);
    const review: OutcomeHistoryRecord["review"] = reviewArtifact === undefined
      ? {
        status: taskEvents.some((event) => event.type === "task.review_requested")
          ? "not_observed" as const
          : "not_required" as const,
        evidenceSha256: null,
      }
      : reviewArtifactHistory(reviewArtifact);
    const startedAt = requiredString(writerPayload, "startedAt");
    const finishedAt = requiredString(writerPayload, "finishedAt");
    return this.complete({
      executionId,
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      outcome: terminal.type.slice(5) as OutcomeHistoryRecord["outcome"],
      validation,
      review,
      terminalEvidence: [{
        eventId: terminal.eventId,
        streamId: terminal.streamId,
        sha256: sha256(JSON.stringify(terminal.payload)),
      }],
      causationId: terminal.eventId,
    });
  }

  list(query: {
    readonly taskType: string;
    readonly role: MilestoneRole;
    readonly harness: "opencode";
  }): readonly OutcomeHistoryRecord[] {
    const all = this.journal.readAll();
    const byEventId = new Map(all.map((event) => [event.eventId, event] as const));
    const routingStreams = new Map<string, StoredEvent[]>();
    for (const event of all.filter((candidate) => candidate.streamId.startsWith("routing-execution/"))) {
      const list = routingStreams.get(event.streamId) ?? [];
      list.push(event);
      routingStreams.set(event.streamId, list);
    }
    const outcomes: OutcomeHistoryRecord[] = [];
    for (const [stream, events] of routingStreams) {
      events.sort((left, right) => left.streamVersion - right.streamVersion);
      if (events.length > 2 || events[0]?.type !== "routing.model_selected") {
        throw new Error("routing execution stream is invalid");
      }
      const selectionEvent = events[0]!;
      const selection = RoutingSelectionSchema.parse(selectionEvent.payload);
      if (stream !== streamId(selection.executionId) || selectionEvent.streamVersion !== 1) {
        throw new Error("routing selection stream identity is invalid");
      }
      const outcomeEvent = events[1];
      if (outcomeEvent === undefined) continue;
      if (outcomeEvent.type !== "routing.outcome_recorded" || outcomeEvent.streamVersion !== 2 ||
        outcomeEvent.correlationId !== selectionEvent.correlationId) {
        throw new Error("routing outcome ordering is invalid");
      }
      const outcome = OutcomeHistoryRecordSchema.parse(outcomeEvent.payload);
      if (!matches(selection, selectionEvent, outcome) ||
        !outcome.terminalEvidence.some((evidence) => evidence.eventId === outcomeEvent.causationId)) {
        throw new Error("routing outcome contradicts its selection or causation");
      }
      assertTerminalEvidence([...byEventId.values()], outcome.terminalEvidence, outcome.outcome, outcome.taskId);
      outcomes.push(outcome);
    }
    return Object.freeze(outcomes.filter((record) =>
      record.taskType === query.taskType &&
      record.role === query.role &&
      record.model.harness === query.harness));
  }
}

function matches(
  selection: RoutingSelection,
  selectionEvent: StoredEvent,
  outcome: OutcomeHistoryRecord,
): boolean {
  return selection.taskId === outcome.taskId &&
    selection.taskType === outcome.taskType &&
    selection.role === outcome.role &&
    JSON.stringify(selection.model) === JSON.stringify(outcome.model) &&
    selection.modelSheetSha256 === outcome.selection.modelSheetSha256 &&
    selectionEvent.eventId === outcome.selection.eventId;
}

function assertTerminalEvidence(
  events: readonly StoredEvent[],
  evidence: OutcomeHistoryRecord["terminalEvidence"],
  outcome: OutcomeHistoryRecord["outcome"],
  taskId: string,
): void {
  const byId = new Map(events.map((event) => [event.eventId, event] as const));
  for (const reference of evidence) {
    const event = byId.get(reference.eventId);
    const taskTerminal = event?.type === `task.${outcome}` && event.streamId === taskId;
    const milestoneTerminal = event?.type === "milestone.task_completed" &&
      typeof event.payload === "object" && event.payload !== null &&
      (event.payload as Record<string, unknown>)["taskId"] === taskId &&
      (event.payload as Record<string, unknown>)["outcome"] === outcome;
    const terminalMatches = taskTerminal || milestoneTerminal;
    if (
      event === undefined || event.streamId !== reference.streamId ||
      !terminalMatches ||
      (reference.sha256 !== null && reference.sha256 !== sha256(JSON.stringify(event.payload)))
    ) {
      throw new Error("routing terminal evidence is invalid");
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function objectPayload(event: StoredEvent): Readonly<Record<string, unknown>> {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new Error(`${event.type} payload is invalid`);
  }
  return event.payload as Readonly<Record<string, unknown>>;
}

function requiredString(payload: Readonly<Record<string, unknown>>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value === "") throw new Error(`history evidence lacks ${field}`);
  return value;
}

function validationArtifactHistory(event: StoredEvent): OutcomeHistoryRecord["validation"] {
  const payload = objectPayload(event);
  const artifact = payload["artifact"] as Readonly<Record<string, unknown>> | undefined;
  const evidence = payload["evidence"] as Readonly<Record<string, unknown>> | undefined;
  if (artifact === undefined || evidence === undefined) throw new Error("artifact history evidence is invalid");
  return {
    status: requiredString(evidence, "outcome") as OutcomeHistoryRecord["validation"]["status"],
    evidenceSha256: requiredString(artifact, "sha256"),
  };
}

function reviewArtifactHistory(event: StoredEvent): OutcomeHistoryRecord["review"] {
  const payload = objectPayload(event);
  const artifact = payload["artifact"] as Readonly<Record<string, unknown>> | undefined;
  const evidence = payload["evidence"] as Readonly<Record<string, unknown>> | undefined;
  if (artifact === undefined || evidence === undefined) throw new Error("artifact history evidence is invalid");
  const approved = evidence["approved"];
  if (typeof approved !== "boolean") throw new Error("review history evidence is invalid");
  return {
    status: approved ? "approved" : "denied",
    evidenceSha256: requiredString(artifact, "sha256"),
  };
}
