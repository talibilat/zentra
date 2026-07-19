import type { StoredEvent } from "../contracts/event.js";
import { projectArtifacts } from "../contracts/artifact.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import {
  MilestoneTerminalResultSchema,
  type MilestoneEvidenceReference,
  type MilestoneTerminalResult,
} from "../contracts/milestone-result.js";
import { UncertainEffectPayloadSchema } from "../contracts/uncertain-effect.js";
import { assertBoundedProjectionEntries, iterateAllEvents, readStreamEvents, type EventJournal } from "../journal/journal.js";
import { projectTask } from "../tasks/task-projection.js";
import type { MilestoneRecord } from "./milestone-registry.js";

export function buildMilestoneTerminalResult(input: {
  readonly journal: EventJournal;
  readonly milestone: MilestoneRecord;
  readonly outcome: MilestoneTerminalResult["outcome"];
}): MilestoneTerminalResult {
  const { journal, milestone, outcome } = input;
  if (milestone.plan === null && outcome === "completed") {
    throw new Error("successful terminal milestone result requires an accepted plan");
  }
  const plannedTasks = milestone.plan?.tasks ?? [];
  const milestoneEvents = readStreamEvents(journal, milestone.milestoneId);
  const traceId = milestoneEvents[0]?.correlationId;
  if (traceId === undefined || traceId !== milestone.traceId) throw new Error("milestone trace identity is invalid");
  if (outcome !== "completed") assertNonSuccessOutcomeEvidence(milestone, outcome);

  const implementerIds = new Set(plannedTasks
    .filter((task) => task.roleAssignment.role === "implementer")
    .map((task) => task.taskId));
  const integratedWriterIds = new Set(plannedTasks
    .filter((task) => task.roleAssignment.role === "implementer" && plannedTasks.some((candidate) =>
      candidate.roleAssignment.role === "reviewer" && candidate.dependencies.includes(task.taskId)))
    .map((task) => task.taskId));
  const correlatedTaskStreams = new Set<string>();
  for (const event of iterateAllEvents(journal)) {
    if (event.correlationId === traceId && event.type.startsWith("task.")) {
      correlatedTaskStreams.add(event.streamId);
      assertBoundedProjectionEntries(correlatedTaskStreams.size, "milestone task streams");
    }
  }
  for (const streamId of correlatedTaskStreams) {
    if (!implementerIds.has(streamId)) throw new Error(`unexpected task stream in milestone trace: ${streamId}`);
  }

  const integratedCommits: MilestoneTerminalResult["integratedCommits"][number][] = [];
  const validations: MilestoneTerminalResult["validations"][number][] = [];
  const reviews: MilestoneTerminalResult["reviews"][number][] = [];
  const uncertainties: MilestoneTerminalResult["uncertainties"][number][] = [];

  for (const task of plannedTasks.filter((candidate) => candidate.roleAssignment.role === "implementer")) {
    const events = readStreamEvents(journal, task.taskId);
    if (events.length === 0) continue;
    if (events.some((event) => event.streamId !== task.taskId || event.correlationId !== traceId)) {
      throw new Error(`task stream ${task.taskId} is not bound to the milestone trace`);
    }
    projectTask(events);
    collectUncertainties(task.taskId, events, uncertainties);
    const artifacts = projectArtifacts(events);
    const validationArtifact = artifacts.artifacts.find((artifact) => artifact.kind === "validation_report");
    if (validationArtifact !== undefined) {
      const report = record(artifacts.evidenceByArtifactId[validationArtifact.artifactId], "validation evidence");
      const event = exactEvent(events, "artifact.validation_report_recorded");
      validations.push(validationResult(task.taskId, "focused", report, event));
    }
    const reviewArtifact = artifacts.artifacts.find((artifact) => artifact.kind === "review_report");
    if (reviewArtifact !== undefined) {
      const review = record(artifacts.evidenceByArtifactId[reviewArtifact.artifactId], "review evidence");
      const event = exactEvent(events, "artifact.review_report_recorded");
      const reviewerId = stringValue(review, "reviewerId");
      const paired = plannedTasks.find((candidate) =>
        candidate.roleAssignment.role === "reviewer" && candidate.dependencies.includes(task.taskId));
      if (paired === undefined || paired.roleAssignment.agentId !== reviewerId || reviewerId === task.roleAssignment.agentId) {
        throw new Error(`task ${task.taskId} lacks exact independent review evidence`);
      }
      reviews.push({
        taskId: task.taskId,
        reviewerId,
        approved: booleanValue(review, "approved"),
        diffDigest: digestValue(review, "diffSha256"),
        validationDigest: digestValue(review, "validationSha256"),
        evidence: reference(event),
      });
    }
    const integration = events.filter((event) => event.type === "task.integration_observed").at(-1);
    if (integration !== undefined) {
      const payload = record(integration.payload, "integration observation");
      const receipt = record(payload["receipt"], "integration receipt");
      if (payload["verification"] !== "verified" || receipt["taskId"] !== task.taskId ||
        receipt["projectId"] !== milestone.projectId || receipt["outcome"] !== "completed") {
        throw new Error(`task ${task.taskId} integration receipt is not verified`);
      }
      const full = record(receipt["validation"], "full validation evidence");
      validations.push(validationResult(task.taskId, "full", full, integration));
      integratedCommits.push({
        taskId: task.taskId,
        sourceCommit: commitValue(receipt, "sourceCommit"),
        resultCommit: commitValue(receipt, "resultCommit"),
        evidence: reference(integration),
      });
    }
  }

  const pauses = milestoneEvents.filter((event) => event.type === "milestone.paused").map((event) => ({
    reason: pauseReason(event.payload),
    evidence: reference(event),
  }));
  const decisionTypes = new Set([
    "milestone.plan_revised", "milestone.plan_replaced", "milestone.replanning_resolved",
    "milestone.writer_integration_completed", "milestone.writer_terminal_released",
  ]);
  const decisions = milestoneEvents.filter((event) => decisionTypes.has(event.type)).map((event) => ({
    kind: event.type,
    evidence: reference(event),
  }));
  const finalTraceOutcomes = new Map<string, "emitted" | "failed">();
  for (const event of milestoneEvents.filter((candidate) => candidate.type === "milestone.agent_trace_observed")) {
    const payload = record(event.payload, "agent trace observation");
    const taskId = stringValue(payload, "taskId");
    const traceOutcome = payload["outcome"];
    if (traceOutcome !== "emitted" && traceOutcome !== "failed") throw new Error("agent trace outcome is invalid");
    finalTraceOutcomes.set(taskId, traceOutcome);
    decisions.push({
      kind: traceOutcome === "failed" ? "milestone.agent_trace_failed" : "milestone.agent_trace_emitted",
      evidence: reference(event),
    });
  }
  for (const event of milestoneEvents.filter((candidate) => candidate.type === "milestone.agent_cleanup_observed")) {
    const payload = record(event.payload, "agent cleanup observation");
    if (payload["outcome"] === "uncertain") {
      const capsuleId = stringValue(payload, "capsuleId");
      const resolution = milestoneEvents.find((candidate) => {
        if (candidate.type !== "milestone.agent_cleanup_observed" || candidate.streamVersion <= event.streamVersion) return false;
        const candidatePayload = record(candidate.payload, "agent cleanup reconciliation");
        return candidatePayload["capsuleId"] === capsuleId && candidatePayload["outcome"] === "completed";
      });
      uncertainties.push({
        taskId: stringValue(payload, "taskId"),
        boundary: "cleanup",
        resolved: resolution !== undefined,
        evidence: reference(event),
        resolution: resolution === undefined ? null : reference(resolution),
      });
      if (resolution !== undefined) decisions.push({
        kind: "milestone.agent_cleanup_reconciled",
        evidence: reference(resolution),
      });
    }
  }

  if (outcome === "completed") {
    if (plannedTasks.some((task) => milestone.tasks[task.taskId]?.terminalOutcome !== "completed")) {
      throw new Error("successful milestone result requires every planned task completed");
    }
    if (Object.values(milestone.writerOwnership).some((ownership) => ownership.status !== "integrated")) {
      throw new Error("successful milestone result requires every writer integration resolved");
    }
    if (milestone.hasActiveEffects || milestone.hasUncertainEffects || uncertainties.some((item) => !item.resolved)) {
      throw new Error("successful milestone result cannot retain active or uncertain effects");
    }
    if (milestone.hasTraceFailure) throw new Error("successful milestone result cannot complete after trace projection failed");
    if (integratedCommits.length !== integratedWriterIds.size || reviews.length !== integratedWriterIds.size ||
      validations.filter((item) => item.name === "focused").length !== integratedWriterIds.size ||
      validations.filter((item) => item.name === "full").length !== integratedWriterIds.size) {
      throw new Error("successful milestone result lacks complete integration, validation, or review evidence");
    }
  }

  return MilestoneTerminalResultSchema.parse({
    schemaVersion: 1,
    milestoneId: milestone.milestoneId,
    projectId: milestone.projectId,
    outcome,
    tasks: plannedTasks.map((task) => {
      const view = milestone.tasks[task.taskId];
      const completion = milestoneEvents.findLast((event) => event.type === "milestone.task_completed" &&
        record(event.payload, "task completion")["taskId"] === task.taskId);
      return {
        taskId: task.taskId,
        role: task.roleAssignment.role,
        status: view?.status ?? "planned",
        outcome: view?.terminalOutcome ?? null,
        evidence: completion === undefined ? [] : [reference(completion)],
      };
    }),
    integratedCommits,
    validations,
    reviews,
    trace: {
      traceId,
      path: milestone.tracePath,
      outcome: [...finalTraceOutcomes.values()].some((item) => item === "failed")
        ? "failed"
        : finalTraceOutcomes.size > 0 ? "emitted" : "not_observed",
    },
    pauses,
    uncertainties,
    decisions,
  });
}

function assertNonSuccessOutcomeEvidence(
  milestone: MilestoneRecord,
  outcome: Exclude<MilestoneTerminalResult["outcome"], "completed">,
): void {
  const selected = milestone.plan?.tasks
    .map((task) => milestone.tasks[task.taskId]?.terminalOutcome)
    .find((candidate) => candidate !== null && candidate !== undefined && candidate !== "completed");
  if (selected === undefined) {
    if (outcome === "failed" && milestone.hasTraceFailure) return;
    throw new Error("non-success milestone outcome requires matching retained task evidence");
  }
  if (selected !== outcome) throw new Error(`retained task evidence selects ${selected}, not ${outcome}`);
}

export function verifyMilestoneTerminalResult(
  journal: EventJournal,
  milestone: MilestoneRecord,
  retained: MilestoneTerminalResult,
): void {
  const rebuilt = buildMilestoneTerminalResult({ journal, milestone, outcome: retained.outcome });
  if (digestCanonical(retained) !== digestCanonical(rebuilt)) {
    throw new Error("milestone terminal result contradicts retained journal evidence");
  }
}

function collectUncertainties(
  taskId: string,
  events: readonly StoredEvent[],
  target: MilestoneTerminalResult["uncertainties"][number][],
): void {
  for (const event of events.filter((candidate) => candidate.type === "task.effect_uncertain")) {
    const uncertain = UncertainEffectPayloadSchema.parse(event.payload);
    const resolution = events.find((candidate) => candidate.type === "task.effect_reconciled" &&
      candidate.streamVersion > event.streamVersion);
    target.push({
      taskId,
      boundary: uncertain.boundary,
      resolved: resolution !== undefined,
      evidence: reference(event),
      resolution: resolution === undefined ? null : reference(resolution),
    });
  }
}

function validationResult(
  taskId: string,
  name: "focused" | "full",
  report: Readonly<Record<string, unknown>>,
  event: StoredEvent,
): MilestoneTerminalResult["validations"][number] {
  if (report["name"] !== name) throw new Error(`expected ${name} validation evidence`);
  const provenance = record(report["provenance"], "validation provenance");
  const outcome = report["outcome"];
  if (outcome !== "completed" && outcome !== "cancelled" && outcome !== "timed_out" && outcome !== "failed") {
    throw new Error("validation outcome is not canonical");
  }
  const exitCode = report["exitCode"];
  if (exitCode !== null && !Number.isInteger(exitCode)) throw new Error("validation exit code is invalid");
  const subject = provenance["subjectSha256"];
  if (subject !== null && (typeof subject !== "string" || !/^[a-f0-9]{1,64}$/.test(subject))) {
    throw new Error("validation subject digest is invalid");
  }
  return {
    taskId,
    name,
    outcome,
    exitCode: exitCode as number | null,
    argvDigest: digestValue(report, "argvSha256"),
    outputDigest: digestValue(report, "outputSha256"),
    subjectDigest: subject as string | null,
    evidence: reference(event),
  };
}

function exactEvent(events: readonly StoredEvent[], type: string): StoredEvent {
  const matching = events.filter((event) => event.type === type);
  if (matching.length !== 1) throw new Error(`task stream requires exactly one ${type}`);
  return matching[0]!;
}

function reference(event: StoredEvent): MilestoneEvidenceReference {
  return {
    streamId: event.streamId,
    eventId: event.eventId,
    eventType: event.type,
    streamVersion: event.streamVersion,
    payloadDigest: digestCanonical(event.payload),
  };
}

function pauseReason(payload: unknown): string {
  const attention = record(record(payload, "pause payload")["attention"], "pause attention");
  return stringValue(attention, "reason");
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function stringValue(value: Readonly<Record<string, unknown>>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`${key} must be a nonempty string`);
  return candidate;
}

function digestValue(value: Readonly<Record<string, unknown>>, key: string): string {
  const candidate = stringValue(value, key);
  if (!/^[a-f0-9]{64}$/.test(candidate)) throw new Error(`${key} must be a SHA-256 digest`);
  return candidate;
}

function commitValue(value: Readonly<Record<string, unknown>>, key: string): string {
  const candidate = stringValue(value, key);
  if (!/^[a-f0-9]{40,64}$/.test(candidate)) throw new Error(`${key} must be a commit identity`);
  return candidate;
}

function booleanValue(value: Readonly<Record<string, unknown>>, key: string): boolean {
  const candidate = value[key];
  if (typeof candidate !== "boolean") throw new Error(`${key} must be boolean`);
  return candidate;
}
