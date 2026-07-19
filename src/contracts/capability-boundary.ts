import { z } from "zod";

import { digestCanonical } from "./authority-attention.js";
import { TerminalOutcomeSchema } from "./task.js";
import type { StoredEvent } from "./event.js";
import { readStreamEvents, type EventJournal } from "../journal/journal.js";
import {
  RoleCapabilityBindingSchema,
  RoleCapabilityDecisionSchema,
  RoleCapabilityEnvelopeService,
  parseRoleCapabilityEventPayload,
  roleCapabilityStreamId,
  type RoleCapabilityBinding,
  type RoleCapabilityDecision,
} from "../workers/role-capability-envelope.js";
import { projectWorkerLifecycle, workerStreamId } from "../workers/worker-lifecycle.js";
import { projectTask } from "../tasks/task-projection.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentitySchema = z.string().min(1).max(512);

const EvaluationReferenceSchema = z.strictObject({
  streamId: IdentitySchema,
  eventId: IdentitySchema,
  streamVersion: z.number().int().positive(),
  payloadDigest: DigestSchema,
});

export const CapabilityTaskHeadSchema = z.strictObject({
  streamId: IdentitySchema,
  streamVersion: z.number().int().positive(),
  eventId: IdentitySchema,
  eventType: IdentitySchema,
  payloadDigest: DigestSchema,
  lifecycle: z.enum(["queued", "leased", "running", "validating", "awaiting_review", "integration_ready", "integrating", "terminal"]),
  terminalOutcome: TerminalOutcomeSchema.nullable(),
}).superRefine((head, context) => {
  if ((head.lifecycle === "terminal") !== (head.terminalOutcome !== null)) context.addIssue({ code: "custom", message: "capability task head terminal state is invalid" });
});

const WorkerSettlementSchema = z.strictObject({
  workerId: IdentitySchema,
  cleanup: z.literal("completed"),
  terminalOutcome: TerminalOutcomeSchema,
  evidenceDigest: DigestSchema,
});

const CapabilityBoundaryBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  milestoneId: IdentitySchema,
  projectId: IdentitySchema,
  taskId: IdentitySchema,
  bindingDigest: DigestSchema,
  phase: z.enum(["pre_effect", "post_worker"]),
  status: z.enum(["attention", "replan"]),
  reason: z.enum(["forbidden_path", "forbidden_effect", "network_disabled", "network_destination_not_allowed", "network_method_not_allowed", "network_capability_not_allowed", "self_review", "stale_evidence", "path_not_owned"]),
  decisionId: DigestSchema,
  requestDigest: DigestSchema,
  evaluation: EvaluationReferenceSchema,
  workerSettlement: WorkerSettlementSchema.nullable(),
  requestedBy: z.literal("zentra-capability-boundary"),
  operatorDecision: z.enum(["provide_exact_authority_or_revise_plan", "revise_plan_within_envelope"]),
  priorTaskLifecycle: z.enum(["queued", "leased", "running", "validating", "awaiting_review", "integration_ready", "integrating", "terminal"]),
  taskHead: CapabilityTaskHeadSchema,
});

export const CapabilityBoundaryOccurrenceSchema = CapabilityBoundaryBodySchema.extend({
  attentionId: DigestSchema,
}).superRefine((occurrence, context) => {
  const expectedOperatorDecision = occurrence.status === "attention"
    ? "provide_exact_authority_or_revise_plan"
    : "revise_plan_within_envelope";
  if (occurrence.operatorDecision !== expectedOperatorDecision) context.addIssue({ code: "custom", message: "capability boundary operator decision is invalid" });
  if ((occurrence.phase === "post_worker") !== (occurrence.workerSettlement !== null)) context.addIssue({ code: "custom", message: "capability boundary worker settlement is invalid" });
  if (occurrence.taskHead.streamId !== occurrence.taskId || occurrence.taskHead.lifecycle !== occurrence.priorTaskLifecycle) context.addIssue({ code: "custom", message: "capability boundary task head identity is invalid" });
  if (occurrence.attentionId !== occurrenceId(occurrence)) context.addIssue({ code: "custom", message: "capability boundary identity is invalid" });
});

export const CapabilityBoundaryPausedPayloadSchema = z.strictObject({
  occurrence: CapabilityBoundaryOccurrenceSchema,
  evidence: z.unknown().nullable(),
}).superRefine((payload, context) => {
  if (payload.occurrence.phase === "pre_effect" && payload.evidence !== null) context.addIssue({ code: "custom", message: "pre-effect capability pause cannot claim effect evidence" });
  if (payload.occurrence.phase === "post_worker" && (payload.evidence === null || payload.occurrence.workerSettlement?.evidenceDigest !== digestCanonical(payload.evidence))) {
    context.addIssue({ code: "custom", message: "post-worker capability pause evidence digest mismatch" });
  }
});

const CapabilityBoundaryResolutionBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  milestoneId: IdentitySchema,
  projectId: IdentitySchema,
  taskId: IdentitySchema,
  attentionId: DigestSchema,
  bindingDigest: DigestSchema,
  decisionId: DigestSchema,
  pauseEventId: IdentitySchema,
  pauseStreamVersion: z.number().int().positive(),
  action: z.enum(["abandon_request", "supersede_for_replan", "stale_task_state"]),
  decidedBy: IdentitySchema,
  competingTaskHead: CapabilityTaskHeadSchema.nullable(),
});

export const CapabilityBoundaryResolutionSchema = CapabilityBoundaryResolutionBodySchema.extend({
  resolutionId: DigestSchema,
}).superRefine((resolution, context) => {
  if (resolution.resolutionId !== resolutionId(resolution)) context.addIssue({ code: "custom", message: "capability boundary resolution identity is invalid" });
  if ((resolution.action === "stale_task_state") !== (resolution.competingTaskHead !== null)) context.addIssue({ code: "custom", message: "capability boundary stale task resolution is invalid" });
});

export const CapabilityBoundaryResolvedPayloadSchema = z.strictObject({ resolution: CapabilityBoundaryResolutionSchema });

export type CapabilityBoundaryOccurrence = z.infer<typeof CapabilityBoundaryOccurrenceSchema>;
export type CapabilityBoundaryResolution = z.infer<typeof CapabilityBoundaryResolutionSchema>;

export function createCapabilityBoundaryOccurrence(input: {
  readonly binding: RoleCapabilityBinding;
  readonly decision: RoleCapabilityDecision;
  readonly evaluationEvent: StoredEvent;
  readonly phase: "pre_effect" | "post_worker";
  readonly workerSettlement?: Omit<z.infer<typeof WorkerSettlementSchema>, "evidenceDigest">;
  readonly evidence?: unknown;
  readonly taskHead: z.infer<typeof CapabilityTaskHeadSchema>;
}): CapabilityBoundaryOccurrence {
  const binding = RoleCapabilityBindingSchema.parse(input.binding);
  const decision = RoleCapabilityDecisionSchema.parse(input.decision);
  if (decision.status === "allowed") throw new Error("allowed capability evaluation cannot create attention");
  const evaluation = parseRoleCapabilityEventPayload(input.evaluationEvent.type, input.evaluationEvent.payload) as {
    readonly bindingDigest: string;
    readonly decision: RoleCapabilityDecision;
  };
  if (input.evaluationEvent.type !== "capability_envelope.evaluated" ||
    input.evaluationEvent.streamId !== roleCapabilityStreamId(binding) ||
    evaluation.bindingDigest !== binding.digest ||
    digestCanonical(evaluation.decision) !== digestCanonical(decision)) {
    throw new Error("capability boundary evaluation reference is invalid");
  }
  const taskHead = CapabilityTaskHeadSchema.parse(input.taskHead);
  if (taskHead.streamId !== binding.taskId) throw new Error("capability boundary task head is invalid");
  const body = CapabilityBoundaryBodySchema.parse({
    schemaVersion: 1,
    milestoneId: binding.milestoneId,
    projectId: binding.projectId,
    taskId: binding.taskId,
    bindingDigest: binding.digest,
    phase: input.phase,
    status: decision.status,
    reason: decision.reason,
    decisionId: decision.decisionId,
    requestDigest: decision.requestDigest,
    evaluation: {
      streamId: input.evaluationEvent.streamId,
      eventId: input.evaluationEvent.eventId,
      streamVersion: input.evaluationEvent.streamVersion,
      payloadDigest: digestCanonical(input.evaluationEvent.payload),
    },
    workerSettlement: input.workerSettlement === undefined ? null : {
      ...input.workerSettlement,
      evidenceDigest: digestCanonical(input.evidence),
    },
    requestedBy: "zentra-capability-boundary",
    operatorDecision: decision.status === "attention" ? "provide_exact_authority_or_revise_plan" : "revise_plan_within_envelope",
    priorTaskLifecycle: taskHead.lifecycle,
    taskHead,
  });
  return CapabilityBoundaryOccurrenceSchema.parse({ ...body, attentionId: occurrenceId(body) });
}

export function createCapabilityBoundaryResolution(input: Omit<z.input<typeof CapabilityBoundaryResolutionBodySchema>, "schemaVersion" | "competingTaskHead"> & {
  readonly competingTaskHead?: z.infer<typeof CapabilityTaskHeadSchema> | null;
}): CapabilityBoundaryResolution {
  const body = CapabilityBoundaryResolutionBodySchema.parse({ schemaVersion: 1, ...input, competingTaskHead: input.competingTaskHead ?? null });
  return CapabilityBoundaryResolutionSchema.parse({ ...body, resolutionId: resolutionId(body) });
}

export function verifyCapabilityBoundaryOccurrence(journal: EventJournal, raw: CapabilityBoundaryOccurrence): CapabilityBoundaryOccurrence {
  const occurrence = CapabilityBoundaryOccurrenceSchema.parse(raw);
  const stream = readStreamEvents(journal, occurrence.evaluation.streamId);
  const accepted = stream[0];
  const evaluationEvent = stream.find((event) => event.streamVersion === occurrence.evaluation.streamVersion);
  if (accepted?.type !== "capability_envelope.accepted" || evaluationEvent === undefined ||
    evaluationEvent.eventId !== occurrence.evaluation.eventId ||
    digestCanonical(evaluationEvent.payload) !== occurrence.evaluation.payloadDigest) {
    throw new Error("capability boundary evaluation occurrence is stale or forged");
  }
  const acceptedPayload = parseRoleCapabilityEventPayload(accepted.type, accepted.payload) as { readonly binding: RoleCapabilityBinding };
  const binding = RoleCapabilityBindingSchema.parse(acceptedPayload.binding);
  if (binding.digest !== occurrence.bindingDigest || binding.milestoneId !== occurrence.milestoneId ||
    binding.projectId !== occurrence.projectId || binding.taskId !== occurrence.taskId ||
    roleCapabilityStreamId(binding) !== occurrence.evaluation.streamId) {
    throw new Error("capability boundary binding occurrence is stale or forged");
  }
  new RoleCapabilityEnvelopeService(journal).inspect(binding);
  const evaluation = parseRoleCapabilityEventPayload(evaluationEvent.type, evaluationEvent.payload) as { readonly decision: RoleCapabilityDecision };
  const decision = RoleCapabilityDecisionSchema.parse(evaluation.decision);
  if (decision.status === "allowed" || decision.decisionId !== occurrence.decisionId ||
    decision.requestDigest !== occurrence.requestDigest || decision.bindingDigest !== occurrence.bindingDigest ||
    decision.status !== occurrence.status || decision.reason !== occurrence.reason) {
    throw new Error("capability boundary decision occurrence is stale or forged");
  }
  const workers = Object.values(projectWorkerLifecycle(readStreamEvents(journal, workerStreamId(occurrence.taskId))).workers);
  if (workers.some((worker) => worker.status !== "terminal")) throw new Error("capability boundary requires settled workers");
  if (occurrence.workerSettlement !== null) {
    const worker = workers.find((candidate) => candidate.workerId === occurrence.workerSettlement!.workerId);
    if (worker === undefined || worker.status !== "terminal" || worker.cleanup !== "completed" ||
      worker.terminalOutcome !== occurrence.workerSettlement.terminalOutcome) {
      throw new Error("capability boundary worker settlement is stale or forged");
    }
  }
  verifyTaskHeadReference(journal, occurrence.taskHead);
  return occurrence;
}

export function capabilityTaskHead(events: readonly StoredEvent[]): z.infer<typeof CapabilityTaskHeadSchema> {
  if (events.length === 0) throw new Error("capability task head requires a nonempty task stream prefix");
  const event = events.at(-1)!;
  if (events.some((candidate, index) => candidate.streamId !== event.streamId || candidate.streamVersion !== index + 1)) {
    throw new Error("capability task head requires one contiguous task stream prefix");
  }
  const task = projectTask(events);
  if (task === null || task.streamVersion !== event.streamVersion) throw new Error("capability task head projection is invalid");
  return CapabilityTaskHeadSchema.parse({
    streamId: event.streamId,
    streamVersion: event.streamVersion,
    eventId: event.eventId,
    eventType: event.type,
    payloadDigest: digestCanonical(event.payload),
    lifecycle: task.lifecycle,
    terminalOutcome: task.terminalOutcome,
  });
}

export function verifyCurrentCapabilityTaskHead(journal: EventJournal, occurrence: CapabilityBoundaryOccurrence): StoredEvent {
  verifyCapabilityBoundaryOccurrence(journal, occurrence);
  const events = readStreamEvents(journal, occurrence.taskId);
  const head = events.at(-1);
  if (head === undefined || digestCanonical(capabilityTaskHead(events)) !== digestCanonical(occurrence.taskHead)) throw new Error("capability boundary task head is stale");
  return head;
}

export function verifyCapabilityPauseSource(journal: EventJournal, occurrence: CapabilityBoundaryOccurrence): StoredEvent {
  verifyCapabilityBoundaryOccurrence(journal, occurrence);
  const milestoneEvents = readStreamEvents(journal, occurrence.milestoneId);
  if (milestoneEvents[0]?.type !== "milestone.created") throw new Error("task capability pause requires an authoritative milestone stream");
  const source = milestoneEvents.find((event) => {
    if (event.type !== "milestone.capability_boundary_paused") return false;
    const parsed = CapabilityBoundaryPausedPayloadSchema.safeParse(event.payload);
    return parsed.success && parsed.data.occurrence.attentionId === occurrence.attentionId;
  });
  if (source === undefined) throw new Error("task capability pause requires its authoritative milestone source");
  const parsed = CapabilityBoundaryPausedPayloadSchema.parse(source.payload);
  if (digestCanonical(parsed.occurrence) !== digestCanonical(occurrence)) throw new Error("task capability pause source is stale or forged");
  return source;
}

export function verifyCapabilityResolutionSource(journal: EventJournal, resolution: CapabilityBoundaryResolution): StoredEvent {
  const parsed = CapabilityBoundaryResolutionSchema.parse(resolution);
  const source = readStreamEvents(journal, parsed.milestoneId).find((event) => {
    if (event.type !== "milestone.capability_boundary_resolved") return false;
    const payload = CapabilityBoundaryResolvedPayloadSchema.safeParse(event.payload);
    return payload.success && payload.data.resolution.resolutionId === parsed.resolutionId;
  });
  if (source === undefined || digestCanonical(CapabilityBoundaryResolvedPayloadSchema.parse(source.payload).resolution) !== digestCanonical(parsed)) {
    throw new Error("task capability resolution requires its authoritative milestone source");
  }
  if (parsed.competingTaskHead !== null) verifyTaskHeadReference(journal, parsed.competingTaskHead);
  return source;
}

function verifyTaskHeadReference(journal: EventJournal, head: z.infer<typeof CapabilityTaskHeadSchema>): StoredEvent {
  const stream = readStreamEvents(journal, head.streamId);
  const prefix = stream.filter((candidate) => candidate.streamVersion <= head.streamVersion);
  const event = prefix.at(-1);
  if (event === undefined || !taskHeadEventMatches(head, event) || digestCanonical(capabilityTaskHead(prefix)) !== digestCanonical(head)) {
    throw new Error("capability boundary task head reference is stale or forged");
  }
  return event;
}

function taskHeadEventMatches(head: z.infer<typeof CapabilityTaskHeadSchema>, event: StoredEvent): boolean {
  return event.streamId === head.streamId && event.streamVersion === head.streamVersion && event.eventId === head.eventId &&
    event.type === head.eventType && digestCanonical(event.payload) === head.payloadDigest;
}

function occurrenceId(value: z.input<typeof CapabilityBoundaryBodySchema> & { readonly attentionId?: string }): string {
  const { attentionId: _attentionId, ...body } = value;
  return digestCanonical(body);
}

function resolutionId(value: z.input<typeof CapabilityBoundaryResolutionBodySchema> & { readonly resolutionId?: string }): string {
  const { resolutionId: _resolutionId, ...body } = value;
  return digestCanonical(body);
}
