import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import type { StoredEvent } from "./event.js";

const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;
const MAX_TEXT_LENGTH = 4_096;
const MAX_COMMAND_ARGUMENTS = 256;
export const MAX_RETAINED_ARTIFACT_BYTES = 1_024 * 1_024;
const ValidationTimeoutSchema = z.number().int().min(100).max(30 * 60 * 1_000);

const IdentitySchema = z.string().min(1).max(MAX_ID_LENGTH);
const BoundedTextSchema = z.string().max(MAX_TEXT_LENGTH);
const Sha256Schema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.string().max(64).datetime({ offset: true });
const SafeLogicalPathSchema = z.string().min(1).max(MAX_PATH_LENGTH).refine(isSafeLogicalPath, {
  message: "artifact path must be a safe logical relative path",
});
const RetainedTextSchema = z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_RETAINED_ARTIFACT_BYTES,
  { message: "retained artifact text exceeds the UTF-8 byte limit" },
);

export const ArtifactKindSchema = z.enum([
  "patch",
  "validation_report",
  "review_report",
  "integration_receipt",
]);

export const ArtifactSchema = z.strictObject({
  artifactId: IdentitySchema,
  taskId: IdentitySchema,
  kind: ArtifactKindSchema,
  path: SafeLogicalPathSchema,
  sha256: Sha256Schema,
  createdAt: TimestampSchema,
});

const PatchEvidenceSchema = z.strictObject({
  diff: z.string().min(1).refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_RETAINED_ARTIFACT_BYTES,
    { message: "retained patch exceeds the UTF-8 byte limit" },
  ),
  diffSha256: Sha256Schema,
  changedPath: SafeLogicalPathSchema,
  changedContentSha256: Sha256Schema,
});

const ValidationEvidenceSchema = z.strictObject({
  name: IdentitySchema,
  outcome: z.enum(["completed", "cancelled", "timed_out", "failed"]),
  exitCode: z.number().int().nullable(),
  stdout: RetainedTextSchema,
  stderr: RetainedTextSchema,
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  command: z.array(BoundedTextSchema).min(1).max(MAX_COMMAND_ARGUMENTS),
  argvSha256: Sha256Schema,
  outputSha256: Sha256Schema,
  timeoutMs: ValidationTimeoutSchema.optional(),
  provenance: z.strictObject({
    invocationId: IdentitySchema,
    canonicalCwd: z.string().min(1).max(MAX_PATH_LENGTH),
    subjectSha256: z.string().min(1).max(64).nullable(),
    timeoutMs: ValidationTimeoutSchema.optional(),
  }),
}).superRefine((report, context) => {
  if (report.timeoutMs !== report.provenance.timeoutMs) {
    context.addIssue({
      code: "custom",
      message: "validation timeout must match provenance",
    });
  }
  if (report.outcome === "completed" && report.exitCode !== 0) {
    context.addIssue({ code: "custom", message: "completed validation requires exitCode 0" });
  }
  if (report.outcome === "failed" && report.exitCode === 0) {
    context.addIssue({ code: "custom", message: "failed validation cannot have exitCode 0" });
  }
  if (
    (report.outcome === "cancelled" || report.outcome === "timed_out") &&
    report.exitCode !== null
  ) {
    context.addIssue({ code: "custom", message: `${report.outcome} validation requires null exitCode` });
  }
  if (Date.parse(report.finishedAt) < Date.parse(report.startedAt)) {
    context.addIssue({ code: "custom", message: "validation finishedAt precedes startedAt" });
  }
});

const ReviewEvidenceSchema = z.strictObject({
  reviewerId: IdentitySchema,
  approved: z.boolean(),
  diffSha256: Sha256Schema,
  validationSha256: Sha256Schema,
  decidedAt: TimestampSchema,
  reason: z.string().min(1).max(MAX_TEXT_LENGTH),
});

const IntegrationReceiptEvidenceSchema = z.strictObject({
  taskId: IdentitySchema,
  projectId: IdentitySchema,
  sourceCommit: z.string().max(64).regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  originalIntegrationCommit: z.string().max(64).regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
  resultCommit: z.string().max(64).regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
  review: ReviewEvidenceSchema,
  validation: ValidationEvidenceSchema,
  outcome: z.enum(["completed", "cancelled", "timed_out", "failed"]),
});

const ArtifactProtocolMarkerSchema = z.strictObject({
  artifactProtocolVersion: z.literal(1),
  artifactId: IdentitySchema,
  kind: ArtifactKindSchema,
  sha256: Sha256Schema,
});

function artifactFor<TKind extends z.infer<typeof ArtifactKindSchema>>(kind: TKind) {
  return ArtifactSchema.extend({ kind: z.literal(kind) });
}

export const PatchArtifactRecordedEventSchema = z.strictObject({
  artifact: artifactFor("patch"),
  evidence: PatchEvidenceSchema,
});
export const ValidationReportArtifactRecordedEventSchema = z.strictObject({
  artifact: artifactFor("validation_report"),
  evidence: ValidationEvidenceSchema,
});
export const ReviewReportArtifactRecordedEventSchema = z.strictObject({
  artifact: artifactFor("review_report"),
  evidence: ReviewEvidenceSchema,
});
export const IntegrationReceiptArtifactRecordedEventSchema = z.strictObject({
  artifact: artifactFor("integration_receipt"),
  evidence: IntegrationReceiptEvidenceSchema,
  phase: z.enum(["prepared", "final"]).optional(),
});

export const ArtifactRecordedEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("artifact.patch_recorded"),
    payload: PatchArtifactRecordedEventSchema,
  }),
  z.strictObject({
    type: z.literal("artifact.validation_report_recorded"),
    payload: ValidationReportArtifactRecordedEventSchema,
  }),
  z.strictObject({
    type: z.literal("artifact.review_report_recorded"),
    payload: ReviewReportArtifactRecordedEventSchema,
  }),
  z.strictObject({
    type: z.literal("artifact.integration_receipt_recorded"),
    payload: IntegrationReceiptArtifactRecordedEventSchema,
  }),
]);

export type Artifact = z.infer<typeof ArtifactSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type ArtifactRecordedEvent = z.infer<typeof ArtifactRecordedEventSchema>;
export type PatchArtifactEvidence = z.infer<typeof PatchEvidenceSchema>;

export interface ArtifactView {
  readonly artifacts: readonly Artifact[];
  readonly evidenceByArtifactId: Readonly<Record<string, unknown>>;
  readonly phaseByArtifactId: Readonly<Record<string, "prepared" | "final">>;
}

const ARTIFACT_EVENT_TYPES = new Set([
  "artifact.patch_recorded",
  "artifact.validation_report_recorded",
  "artifact.review_report_recorded",
  "artifact.integration_receipt_recorded",
]);
export const ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE = "task.artifact_recording";

export function isArtifactRecordedEventType(type: string): boolean {
  return ARTIFACT_EVENT_TYPES.has(type);
}

export function artifactEvidenceSha256(
  kind: ArtifactKind,
  evidence: unknown,
): string {
  if (kind === "patch") {
    const patch = parseEvidence(PatchEvidenceSchema, evidence, "patch");
    const diffSha256 = sha256(patch.diff);
    if (diffSha256 !== patch.diffSha256) {
      throw new Error("patch artifact contains a contradictory diff digest");
    }
    return diffSha256;
  }
  if (kind === "validation_report") {
    const report = parseEvidence(ValidationEvidenceSchema, evidence, "validation_report");
    const argvSha256 = sha256(JSON.stringify(report.command));
    const outputSha256 = sha256(JSON.stringify({ stdout: report.stdout, stderr: report.stderr }));
    if (argvSha256 !== report.argvSha256 || outputSha256 !== report.outputSha256) {
      throw new Error("validation artifact contains contradictory command or output digests");
    }
    return sha256(JSON.stringify({
      name: report.name,
      outcome: report.outcome,
      exitCode: report.exitCode,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      command: report.command,
      stdout: report.stdout,
      stderr: report.stderr,
      argvSha256,
      outputSha256,
      provenance: report.provenance,
    }));
  }
  if (kind === "review_report") {
    return sha256(JSON.stringify(parseEvidence(ReviewEvidenceSchema, evidence, kind)));
  }
  return sha256(JSON.stringify(parseEvidence(IntegrationReceiptEvidenceSchema, evidence, kind)));
}

export function projectArtifacts(
  events: readonly StoredEvent[],
): ArtifactView {
  const artifacts: Artifact[] = [];
  const evidenceByArtifactId = new Map<string, unknown>();
  const phaseByArtifactId = new Map<string, "prepared" | "final">();
  const byKind = new Map<ArtifactKind, {
    artifact: Artifact;
    evidence: unknown;
    phase: "prepared" | "final";
  }>();
  const ids = new Set<string>();
  let artifactMode = hasArtifactEventGap(events);
  let terminal = false;
  let pendingMarker: z.infer<typeof ArtifactProtocolMarkerSchema> | null = null;
  let pendingConsumer: {
    readonly kind: ArtifactKind;
    readonly eventTypes: readonly string[];
    readonly evidenceField: "validation" | "review" | "receipt" | null;
  } | null = null;

  for (const event of events) {
    if (
      pendingMarker !== null &&
      event.type !== `artifact.${pendingMarker.kind}_recorded`
    ) {
      throw missingMarkedArtifact(pendingMarker.kind);
    }
    if (pendingConsumer !== null) {
      const payload = objectPayload(event);
      if (
        !pendingConsumer.eventTypes.includes(event.type) ||
        (pendingConsumer.evidenceField !== null &&
          !(pendingConsumer.evidenceField in payload))
      ) {
        throw missingMarkedArtifactConsumer(pendingConsumer.kind);
      }
      pendingConsumer = null;
    }
    if (
      terminal &&
      (artifactMode || isArtifactRecordedEventType(event.type) ||
        event.type === ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE)
    ) {
      throw new Error("artifact replay encountered an event after task terminalization");
    }
    if (event.type.startsWith("task.") && isTerminalEvent(event.type)) terminal = true;

    if (event.type === ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE) {
      artifactMode = true;
      const parsed = ArtifactProtocolMarkerSchema.safeParse(event.payload);
      if (!parsed.success) throw new Error("invalid task.artifact_recording payload");
      pendingMarker = parsed.data;
      continue;
    }

    if (isArtifactRecordedEventType(event.type)) {
      artifactMode = true;
      const parsed = ArtifactRecordedEventSchema.safeParse({
        type: event.type,
        payload: event.payload,
      });
      if (!parsed.success) {
        throw new Error(`invalid ${event.type} payload`);
      }
      const { artifact, evidence } = parsed.data.payload;
      const explicitPhase = artifact.kind === "integration_receipt" &&
          "phase" in parsed.data.payload
        ? parsed.data.payload.phase
        : undefined;
      const phase = explicitPhase ?? (
          artifact.kind === "integration_receipt" &&
          hasMatchingLaterPreparation(events, event.streamVersion, artifact.sha256)
        ? "prepared"
        : "final"
      );
      if (
        pendingMarker !== null &&
        (pendingMarker.artifactId !== artifact.artifactId ||
          pendingMarker.kind !== artifact.kind ||
          pendingMarker.sha256 !== artifact.sha256)
      ) {
        throw new Error("artifact protocol marker contradicts its recorded artifact");
      }
      if (artifact.taskId !== event.streamId) {
        throw new Error(`${event.type} artifact taskId does not match its stream`);
      }
      if (ids.has(artifact.artifactId)) {
        throw new Error("duplicate artifact identity");
      }
      const previousKind = byKind.get(artifact.kind);
      const replacesPreparedReceipt = artifact.kind === "integration_receipt" &&
        phase === "final" && previousKind?.phase === "prepared";
      if (previousKind !== undefined && !replacesPreparedReceipt) {
        throw new Error(`duplicate artifact kind: ${artifact.kind}`);
      }
      const expectedDigest = artifactEvidenceSha256(artifact.kind, evidence);
      if (artifact.sha256 !== expectedDigest) {
        throw new Error(`${artifact.kind} artifact digest contradicts its evidence`);
      }
      assertArtifactOrder(event.type, events, event.streamVersion);
      validateArtifactChain(artifact.kind, evidence, phase, byKind, event, events);
      ids.add(artifact.artifactId);
      if (replacesPreparedReceipt) {
        const priorIndex = artifacts.findIndex((candidate) =>
          candidate.artifactId === previousKind.artifact.artifactId);
        if (priorIndex !== -1) artifacts.splice(priorIndex, 1);
        evidenceByArtifactId.delete(previousKind.artifact.artifactId);
        phaseByArtifactId.delete(previousKind.artifact.artifactId);
      }
      byKind.set(artifact.kind, { artifact, evidence, phase });
      artifacts.push(artifact);
      evidenceByArtifactId.set(artifact.artifactId, evidence);
      phaseByArtifactId.set(artifact.artifactId, phase);
      if (pendingMarker !== null) {
        pendingConsumer = requiredMarkedArtifactConsumer(
          artifact.kind,
          evidence,
          phase,
          byKind.get("patch")?.artifact.sha256 ?? null,
        );
      }
      pendingMarker = null;
      continue;
    }

    if (artifactMode) {
      validateLifecycleArtifactReference(event, byKind);
      const payload = objectPayload(event);
      if (
        event.type === "task.integration_observed" &&
        payload.verification === "verified"
      ) {
        const receipt = requireArtifact(byKind, "integration_receipt", event.type);
        phaseByArtifactId.set(receipt.artifact.artifactId, "final");
      }
    }
  }

  if (pendingMarker !== null) {
    throw missingMarkedArtifact(pendingMarker.kind);
  }
  if (pendingConsumer !== null) {
    throw missingMarkedArtifactConsumer(pendingConsumer.kind);
  }

  return Object.freeze({
    artifacts: Object.freeze([...artifacts]),
    evidenceByArtifactId: Object.freeze(Object.fromEntries(evidenceByArtifactId)),
    phaseByArtifactId: Object.freeze(Object.fromEntries(phaseByArtifactId)),
  });
}

function validateLifecycleArtifactReference(
  event: StoredEvent,
  byKind: ReadonlyMap<ArtifactKind, {
    artifact: Artifact;
    evidence: unknown;
    phase: "prepared" | "final";
  }>,
): void {
  const payload = objectPayload(event);
  if (event.type === "task.validation_started") {
    const patch = requireArtifact(byKind, "patch", event.type);
    const patchEvidence = PatchEvidenceSchema.parse(patch.evidence);
    const workerPatch = typeof payload.patch === "object" && payload.patch !== null
      ? payload.patch as Record<string, unknown>
      : {};
    if (payload.diffSha256 !== patch.artifact.sha256) {
      throw new Error("task.validation_started references a contradictory patch digest");
    }
    if (
      workerPatch.path !== patchEvidence.changedPath ||
      workerPatch.sha256 !== patchEvidence.changedContentSha256
    ) {
      throw new Error("task.validation_started references contradictory changed-file evidence");
    }
  }
  if (event.type === "task.review_requested" && !("validation" in payload)) {
    throw new Error("task.review_requested payload must carry validation evidence");
  }
  if (event.type === "task.review_requested" || "validation" in payload) {
    if ("validation" in payload) {
      const validation = requireArtifact(byKind, "validation_report", "lifecycle event");
      if (artifactEvidenceSha256("validation_report", payload.validation) !== validation.artifact.sha256) {
        throw new Error("lifecycle event references contradictory validation evidence");
      }
      if (event.type === "task.review_requested") {
        const report = ValidationEvidenceSchema.parse(payload.validation);
        if (report.name !== "focused") {
          throw new Error("task.review_requested requires successful focused validation evidence");
        }
        if (report.outcome !== "completed" || report.exitCode !== 0) {
          throw new Error("task.review_requested requires successful validation evidence");
        }
      }
    }
  }
  if (
    (event.type === "task.review_approved" || event.type === "task.integration_started") &&
    !("review" in payload)
  ) {
    throw new Error(`${event.type} payload must carry review evidence`);
  }
  if (event.type === "task.review_approved" || event.type === "task.integration_started" || "review" in payload) {
    if ("review" in payload) {
      const review = requireArtifact(byKind, "review_report", "lifecycle event");
      if (sha256(JSON.stringify(payload.review)) !== review.artifact.sha256) {
        throw new Error("lifecycle event references contradictory review evidence");
      }
      if (
        (event.type === "task.review_approved" || event.type === "task.integration_started") &&
        !ReviewEvidenceSchema.parse(payload.review).approved
      ) {
        throw new Error(`${event.type} requires approved review evidence`);
      }
    }
  }
  if (event.type === "task.integration_prepared" && !("receipt" in payload)) {
    throw new Error("task.integration_prepared payload must carry receipt evidence");
  }
  if (event.type === "task.integration_prepared" && "receipt" in payload) {
    const receipt = requireArtifact(byKind, "integration_receipt", event.type);
    if (
      receipt.phase !== "prepared" ||
      sha256(JSON.stringify(payload.receipt)) !== receipt.artifact.sha256
    ) {
      throw new Error("task.integration_prepared references contradictory prepared receipt evidence");
    }
    assertSuccessfulPreparedReceipt(IntegrationReceiptEvidenceSchema.parse(payload.receipt));
  }
  if (
    event.type === "task.integration_observed" &&
    payload.verification === "verified" &&
    "receipt" in payload
  ) {
    const receipt = requireArtifact(byKind, "integration_receipt", event.type);
    if (sha256(JSON.stringify(payload.receipt)) !== receipt.artifact.sha256) {
      throw new Error("task.integration_observed references contradictory final receipt evidence");
    }
  }
  if (
    event.type === "task.completed" ||
    "receipt" in payload
  ) {
    if (
      "receipt" in payload &&
      event.type !== "task.integration_prepared" &&
      event.type !== "task.integration_observed"
    ) {
      const receipt = requireArtifact(byKind, "integration_receipt", "lifecycle event");
      if (sha256(JSON.stringify(payload.receipt)) !== receipt.artifact.sha256) {
        throw new Error("lifecycle event references contradictory integration receipt evidence");
      }
      if (
        isTerminalEvent(event.type) &&
        IntegrationReceiptEvidenceSchema.parse(payload.receipt).outcome !== event.type.slice(5)
      ) {
        throw new Error(`${event.type} contradicts integration receipt outcome`);
      }
    }
  }
}

function validateArtifactChain(
  kind: ArtifactKind,
  evidence: unknown,
  phase: "prepared" | "final",
  byKind: ReadonlyMap<ArtifactKind, {
    artifact: Artifact;
    evidence: unknown;
    phase: "prepared" | "final";
  }>,
  event: StoredEvent,
  events: readonly StoredEvent[],
): void {
  if (kind === "validation_report") {
    const report = ValidationEvidenceSchema.parse(evidence);
    const patch = requireArtifact(byKind, "patch", "validation_report artifact");
    if (
      report.provenance.subjectSha256 !== patch.artifact.sha256 &&
      !isImmediateValidationFailure(report, event, events)
    ) {
      throw new Error("validation report artifact contradicts the patch artifact");
    }
  }
  if (kind === "review_report") {
    const decision = ReviewEvidenceSchema.parse(evidence);
    const patch = requireArtifact(byKind, "patch", "review_report artifact");
    const validation = requireArtifact(byKind, "validation_report", "review_report artifact");
    const request = priorEvent(events, event.streamVersion, "task.review_requested");
    if (
      decision.diffSha256 !== patch.artifact.sha256 ||
      decision.validationSha256 !== validation.artifact.sha256 ||
      decision.reviewerId !== objectPayload(request).reviewerId
    ) {
      throw new Error("review report artifact contradicts its patch, validation, or requested reviewer evidence");
    }
  }
  if (kind === "integration_receipt") {
    const receipt = IntegrationReceiptEvidenceSchema.parse(evidence);
    const review = requireArtifact(byKind, "review_report", "integration_receipt artifact");
    const created = priorEvent(events, event.streamVersion, "task.created");
    const integrationStarted = priorEvent(events, event.streamVersion, "task.integration_started");
    const prepared = optionalPriorEvent(events, event.streamVersion, "task.integration_prepared");
    const preparedValue = prepared === null ? null : objectPayload(prepared).receipt;
    const preparedReceipt = typeof preparedValue === "object" && preparedValue !== null
      ? preparedValue as Record<string, unknown>
      : null;
    const expectedValidationSubject = receipt.resultCommit ??
      (typeof preparedReceipt?.resultCommit === "string" ? preparedReceipt.resultCommit : null);
    const validationSubjectMatches = expectedValidationSubject === null
      ? phase === "final" && receipt.outcome !== "completed"
      : receipt.validation.provenance.subjectSha256 === expectedValidationSubject;
    const preservesPreparedEvidence = preparedReceipt === null ||
      JSON.stringify({ ...receipt, outcome: preparedReceipt.outcome }) ===
        JSON.stringify(preparedReceipt);
    if (phase === "prepared") assertSuccessfulPreparedReceipt(receipt);
    if (
      receipt.taskId !== event.streamId ||
      receipt.projectId !== objectPayload(created).projectId ||
      receipt.sourceCommit !== objectPayload(integrationStarted).sourceCommit ||
      JSON.stringify(receipt.review) !== JSON.stringify(review.evidence) ||
      JSON.stringify(receipt.review) !== JSON.stringify(objectPayload(integrationStarted).review) ||
      receipt.validation.name !== "full" ||
      !validationSubjectMatches ||
      !preservesPreparedEvidence ||
      (receipt.outcome === "completed" &&
        preparedReceipt !== null &&
        JSON.stringify(receipt) !== JSON.stringify(preparedReceipt))
    ) {
      throw new Error("integration receipt artifact contradicts task, project, source, result, review, or validation provenance");
    }
  }
}

function isImmediateValidationFailure(
  report: z.infer<typeof ValidationEvidenceSchema>,
  artifactEvent: StoredEvent,
  events: readonly StoredEvent[],
): boolean {
  const next = events.find((candidate) =>
    candidate.streamVersion === artifactEvent.streamVersion + 1);
  if (next?.type !== "task.failed") return false;
  const validation = objectPayload(next).validation;
  const parsed = ValidationEvidenceSchema.safeParse(validation);
  return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(report);
}

function assertSuccessfulPreparedReceipt(
  receipt: z.infer<typeof IntegrationReceiptEvidenceSchema>,
): void {
  if (
    receipt.outcome !== "completed" ||
    !receipt.review.approved ||
    receipt.originalIntegrationCommit === null ||
    receipt.resultCommit === null ||
    receipt.validation.name !== "full" ||
    receipt.validation.outcome !== "completed" ||
    receipt.validation.exitCode !== 0 ||
    receipt.validation.provenance.subjectSha256 !== receipt.resultCommit
  ) {
    throw new Error("task.integration_prepared requires successful prepared receipt evidence");
  }
}

function priorEvent(
  events: readonly StoredEvent[],
  version: number,
  type: string,
): StoredEvent {
  const found = optionalPriorEvent(events, version, type);
  if (found === null) throw new Error(`integration evidence references missing ${type}`);
  return found;
}

function optionalPriorEvent(
  events: readonly StoredEvent[],
  version: number,
  type: string,
): StoredEvent | null {
  return events.findLast((candidate) =>
    candidate.streamVersion < version && candidate.type === type) ?? null;
}

function hasMatchingLaterPreparation(
  events: readonly StoredEvent[],
  version: number,
  receiptSha256: string,
): boolean {
  return events.some((candidate) =>
    candidate.streamVersion > version &&
    candidate.type === "task.integration_prepared" &&
    sha256(JSON.stringify(objectPayload(candidate).receipt)) === receiptSha256);
}

function missingMarkedArtifact(kind: ArtifactKind): Error {
  return new Error(`artifact protocol marker references missing ${kind} artifact`);
}

function missingMarkedArtifactConsumer(kind: ArtifactKind): Error {
  return new Error(`marked ${kind} artifact requires an immediate consuming lifecycle event`);
}

function requiredMarkedArtifactConsumer(
  kind: ArtifactKind,
  evidence: unknown,
  phase: "prepared" | "final",
  patchSha256: string | null,
): {
  readonly kind: ArtifactKind;
  readonly eventTypes: readonly string[];
  readonly evidenceField: "validation" | "review" | "receipt" | null;
} {
  if (kind === "patch") {
    return { kind, eventTypes: ["task.validation_started"], evidenceField: null };
  }
  if (kind === "validation_report") {
    const report = ValidationEvidenceSchema.parse(evidence);
    const subjectMismatch = report.provenance.subjectSha256 !== patchSha256;
    return {
      kind,
      eventTypes: subjectMismatch
        ? ["task.failed"]
        : report.outcome === "completed"
        ? ["task.review_requested", "task.failed"]
        : [`task.${report.outcome}`],
      evidenceField: "validation",
    };
  }
  if (kind === "review_report") {
    const decision = ReviewEvidenceSchema.parse(evidence);
    return {
      kind,
      eventTypes: [decision.approved ? "task.review_approved" : "task.denied"],
      evidenceField: "review",
    };
  }
  const receipt = IntegrationReceiptEvidenceSchema.parse(evidence);
  return {
    kind,
    eventTypes: [phase === "prepared" ? "task.integration_prepared" : `task.${receipt.outcome}`],
    evidenceField: "receipt",
  };
}

function requireArtifact(
  byKind: ReadonlyMap<ArtifactKind, {
    artifact: Artifact;
    evidence: unknown;
    phase: "prepared" | "final";
  }>,
  kind: ArtifactKind,
  eventType: string,
): { artifact: Artifact; evidence: unknown; phase: "prepared" | "final" } {
  const artifact = byKind.get(kind);
  if (artifact === undefined) {
    throw new Error(`${eventType} references missing ${kind} artifact`);
  }
  return artifact;
}

function assertArtifactOrder(type: string, events: readonly StoredEvent[], version: number): void {
  const priorTypes = new Set(events.filter((event) => event.streamVersion < version).map((event) => event.type));
  const forbiddenPrior: Record<string, string> = {
    "artifact.patch_recorded": "task.validation_started",
    "artifact.validation_report_recorded": "task.review_requested",
    "artifact.review_report_recorded": "task.review_approved",
  };
  const requiredPrior: Record<string, string> = {
    "artifact.patch_recorded": "task.started",
    "artifact.validation_report_recorded": "task.validation_started",
    "artifact.review_report_recorded": "task.review_requested",
    "artifact.integration_receipt_recorded": "task.integration_started",
  };
  if (!priorTypes.has(requiredPrior[type]!)) throw new Error(`${type} is out of order`);
  if (priorTypes.has(forbiddenPrior[type]!)) throw new Error(`${type} is out of order`);
}

function objectPayload(event: StoredEvent): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null
    ? event.payload as Record<string, unknown>
    : {};
}

function isTerminalEvent(type: string): boolean {
  return new Set([
    "task.completed",
    "task.cancelled",
    "task.denied",
    "task.timed_out",
    "task.failed",
  ]).has(type);
}

function hasArtifactEventGap(events: readonly StoredEvent[]): boolean {
  return events.some((event, index) => {
    const previous = events[index - 1];
    return previous !== undefined && event.streamVersion !== previous.streamVersion + 1;
  });
}

function isSafeLogicalPath(candidate: string): boolean {
  if (
    candidate.includes("\0") ||
    candidate.includes("\n") ||
    candidate.includes("\r") ||
    candidate.includes("\\") ||
    path.posix.isAbsolute(candidate)
  ) return false;
  const segments = candidate.split("/");
  return (
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    path.posix.normalize(candidate) === candidate
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseEvidence<TSchema extends z.ZodType>(
  schema: TSchema,
  evidence: unknown,
  kind: ArtifactKind,
): z.infer<TSchema> {
  const parsed = schema.safeParse(evidence);
  if (!parsed.success) {
    throw new Error(`invalid ${kind} artifact evidence`);
  }
  return parsed.data;
}
