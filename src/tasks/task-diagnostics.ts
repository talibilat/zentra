import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import { ValidationReportSchema } from "../capabilities/validation-runner.js";
import { projectArtifacts, type ArtifactKind } from "../contracts/artifact.js";
import type { StoredEvent } from "../contracts/event.js";
import { isSafeWorktreeTaskIdentity } from "../contracts/task-identity.js";
import {
  cleanupFailureStoreReference,
  CleanupFailureEventRecordSchema,
  CleanupFailureRecordSchema,
  CleanupFailureStoreReferenceSchema,
  type CleanupFailureRecord,
  type CleanupFailureStoreReference,
} from "../integration/cleanup-failure-store.js";
import type { TerminalOutcome } from "../contracts/task.js";
import type { RecoveryDecision } from "../orchestration/recovery.js";
import { projectTask } from "./task-projection.js";

const DiagnosticStageSchema = z.enum([
  "setup",
  "worker",
  "artifact",
  "validation",
  "review",
  "commit",
  "integration",
  "cleanup",
  "completion",
  "recovery",
]);
const TerminalDiagnosticPayloadSchema = z.object({
  stage: DiagnosticStageSchema,
  reason: z.string(),
  validation: ValidationReportSchema.optional(),
});
const StageReasonPayloadSchema = z.object({
  stage: DiagnosticStageSchema,
  reason: z.string(),
});

export type DiagnosticStage = z.infer<typeof DiagnosticStageSchema>;
export type DiagnosticRecoveryAction = RecoveryDecision["action"];

export interface TaskDiagnosticArtifact {
  readonly kind: ArtifactKind;
  readonly artifactId: string;
  readonly sha256: string;
}

export interface TaskValidationDiagnostic {
  readonly name: string;
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
  readonly exitCode: number | null;
  readonly artifactId: string | null;
  readonly sha256: string | null;
}

export interface TaskDiagnostic {
  readonly taskId: string;
  readonly projectId: string;
  readonly lifecycle: string;
  readonly terminalOutcome: TerminalOutcome | null;
  readonly streamVersion: number;
  readonly stage: DiagnosticStage;
  readonly reasonCode: string;
  readonly message: string;
  readonly validation: TaskValidationDiagnostic | null;
  readonly recoveryAction: DiagnosticRecoveryAction;
  readonly artifacts: readonly TaskDiagnosticArtifact[];
  readonly cleanup: TaskCleanupDiagnostic | null;
  readonly worktree: { readonly branch: string; readonly path: string } | null;
}

export interface TaskCleanupDiagnostic {
  readonly recordsSha256: string;
  readonly historySha256: string;
  readonly recordCount: number;
  readonly unacknowledgedCount: number;
  readonly acknowledgedCount: number;
  readonly dispositions: readonly {
    readonly recordId: string;
    readonly acknowledgedAt: string;
    readonly dispositionEvidenceSha256: string;
  }[];
  readonly dispositionsTruncated: boolean;
}

export function projectTaskDiagnostic(
  events: readonly StoredEvent[],
  options: {
    readonly recoveryAction: DiagnosticRecoveryAction;
    readonly worktreeRoot: string;
    readonly cleanupFailureHistory?: readonly CleanupFailureRecord[];
  },
): TaskDiagnostic {
  const task = projectTask(events);
  if (task === null) throw new Error("task diagnostic requires one task stream");
  const artifactView = projectArtifacts(events);
  const latest = latestDiagnostic(
    events,
    task.terminalOutcome,
    options.cleanupFailureHistory,
    task.projectId,
    task.taskId,
  );
  const validationArtifact = artifactView.artifacts.findLast((artifact) =>
    artifact.kind === "validation_report") ?? null;
  const validationEvidence = validationArtifact === null
    ? latest.validation
    : ValidationReportSchema.parse(
        artifactView.evidenceByArtifactId[validationArtifact.artifactId],
      );

  return Object.freeze({
    taskId: task.taskId,
    projectId: task.projectId,
    lifecycle: task.lifecycle,
    terminalOutcome: task.terminalOutcome,
    streamVersion: task.streamVersion,
    stage: latest.stage,
    reasonCode: latest.reasonCode,
    message: diagnosticMessage(latest.stage, latest.reasonCode),
    validation: validationEvidence === null ? null : Object.freeze({
      name: validationEvidence.name,
      outcome: validationEvidence.outcome,
      exitCode: validationEvidence.exitCode,
      artifactId: validationArtifact?.artifactId ?? null,
      sha256: validationArtifact?.sha256 ?? null,
    }),
    recoveryAction: options.recoveryAction,
    artifacts: Object.freeze(artifactView.artifacts.map((artifact) => Object.freeze({
      kind: artifact.kind,
      artifactId: artifact.artifactId,
      sha256: artifact.sha256,
    }))),
    cleanup: latest.cleanup,
    worktree: safeWorktree(events, task.taskId, options.worktreeRoot),
  });
}

function latestDiagnostic(
  events: readonly StoredEvent[],
  terminalOutcome: TerminalOutcome | null,
  cleanupFailureHistory: readonly CleanupFailureRecord[] | undefined,
  projectId: string,
  taskId: string,
): {
  readonly stage: DiagnosticStage;
  readonly reasonCode: string;
  readonly validation: z.infer<typeof ValidationReportSchema> | null;
  readonly cleanup: TaskCleanupDiagnostic | null;
} {
  const latest = events.findLast((event) => isDiagnosticEvent(event.type)) ?? events.at(-1)!;
  if (latest.type === "task.effect_uncertain") {
    const payload = z.object({ boundary: DiagnosticStageSchema, reason: z.string() }).safeParse(latest.payload);
    if (!payload.success) throw new Error("diagnostic event payload is invalid");
    const latestIndex = events.lastIndexOf(latest);
    const observed = events[latestIndex - 1];
    if (payload.data.boundary === "cleanup" && observed?.type === "task.integration_observed") {
      return cleanupDiagnostic(observed.payload, cleanupFailureHistory, projectId, taskId);
    }
    return { stage: payload.data.boundary, reasonCode: `${payload.data.boundary}_uncertain`, validation: null, cleanup: null };
  }
  if (latest.type === "task.integration_observed") {
    return cleanupDiagnostic(latest.payload, cleanupFailureHistory, projectId, taskId);
  }
  if (latest.type === "task.cleanup_observed") {
    return { stage: "cleanup", reasonCode: "cleanup_reconciliation_required", validation: null, cleanup: null };
  }
  if (latest.type === "task.completed") {
    return { stage: "completion", reasonCode: "completed", validation: null, cleanup: null };
  }
  if (latest.type === "task.review_policy_blocked") {
    const payload = StageReasonPayloadSchema.safeParse(latest.payload);
    if (!payload.success) throw new Error("diagnostic event payload is invalid");
    return { stage: "review", reasonCode: "review_policy_blocked", validation: null, cleanup: null };
  }
  if (isTerminalEvent(latest.type)) {
    const payload = TerminalDiagnosticPayloadSchema.safeParse(latest.payload);
    if (!payload.success) throw new Error("diagnostic event payload is invalid");
    const outcome = latest.type.slice("task.".length);
    return {
      stage: payload.data.stage,
      reasonCode: `${payload.data.stage}_${outcome}`,
      validation: payload.data.validation ?? null,
      cleanup: null,
    };
  }
  const stage = stageForEvent(latest.type);
  return {
    stage,
    reasonCode: terminalOutcome === null ? `${stage}_incomplete` : `${stage}_${terminalOutcome}`,
    validation: null,
    cleanup: null,
  };
}

export function taskCleanupFailureStoreReference(
  events: readonly StoredEvent[],
): CleanupFailureStoreReference | null {
  const uncertainIndex = events.findLastIndex((event) => event.type === "task.effect_uncertain");
  const candidate = uncertainIndex === -1
    ? events.findLast((event) => event.type === "task.integration_observed")
    : events[uncertainIndex - 1]?.type === "task.integration_observed"
    ? events[uncertainIndex - 1]
    : undefined;
  if (candidate === undefined) return null;
  const evidence = parseCleanupEvidence(candidate.payload);
  return evidence.failures.length === 0 ? null : evidence.reference;
}

function cleanupDiagnostic(
  payload: unknown,
  currentHistory: readonly CleanupFailureRecord[] | undefined,
  projectId: string,
  taskId: string,
): {
  readonly stage: DiagnosticStage;
  readonly reasonCode: string;
  readonly validation: null;
  readonly cleanup: TaskCleanupDiagnostic | null;
} {
  const evidence = parseCleanupEvidence(payload);
  if (evidence.failures.some((failure) =>
    failure.projectId !== projectId || failure.taskId !== taskId
  )) throw new Error("cleanup failure diagnostic evidence contradicts the task identity");
  if (evidence.failures.length === 0) {
    return { stage: "integration", reasonCode: "integration_reconciliation_required", validation: null, cleanup: null };
  }
  if (currentHistory === undefined) throw new Error("cleanup failure diagnostic store history is missing");
  const current = currentHistory.map((record) => CleanupFailureRecordSchema.parse(record));
  if (current.length !== evidence.failures.length) {
    throw new Error("cleanup failure diagnostic store history is incomplete");
  }
  for (let index = 0; index < evidence.failures.length; index += 1) {
    const retained = evidence.failures[index]!;
    const stored = current[index]!;
    if (retained.recordId !== stored.recordId || JSON.stringify(retained) !== JSON.stringify({ ...stored, acknowledgement: null })) {
      throw new Error("cleanup failure diagnostic store history contradicts retained evidence");
    }
  }
  const acknowledged = current.filter((record) => record.acknowledgement !== null);
  const unacknowledged = current.length - acknowledged.length;
  const dispositions = acknowledged.slice(-16).map((record) => Object.freeze({
    recordId: record.recordId,
    acknowledgedAt: record.acknowledgement!.acknowledgedAt,
    dispositionEvidenceSha256: sha256(record.acknowledgement!.dispositionEvidence),
  }));
  return {
    stage: "cleanup",
    reasonCode: unacknowledged > 0
      ? "candidate_cleanup_unacknowledged"
      : "candidate_cleanup_acknowledged",
    validation: null,
    cleanup: Object.freeze({
      recordsSha256: evidence.reference.recordsSha256,
      historySha256: sha256(JSON.stringify(current)),
      recordCount: current.length,
      unacknowledgedCount: unacknowledged,
      acknowledgedCount: acknowledged.length,
      dispositions: Object.freeze(dispositions),
      dispositionsTruncated: acknowledged.length > dispositions.length,
    }),
  };
}

function parseCleanupEvidence(payload: unknown): {
  readonly failures: readonly CleanupFailureRecord[];
  readonly reference: CleanupFailureStoreReference;
} {
  const parsed = z.strictObject({
    cleanupFailures: z.array(CleanupFailureEventRecordSchema),
    cleanupFailureStore: CleanupFailureStoreReferenceSchema,
  }).passthrough().safeParse(payload);
  if (!parsed.success) throw new Error("cleanup failure diagnostic evidence is invalid");
  const failures = parsed.data.cleanupFailures.map((failure) => {
    const durable = CleanupFailureRecordSchema.safeParse(failure);
    if (!durable.success || durable.data.acknowledgement !== null) {
      throw new Error("cleanup failure diagnostic evidence is not an unacknowledged durable record");
    }
    return durable.data;
  });
  const expected = cleanupFailureStoreReference(failures);
  if (JSON.stringify(parsed.data.cleanupFailureStore) !== JSON.stringify(expected)) {
    throw new Error("cleanup failure diagnostic store reference is invalid");
  }
  return { failures, reference: parsed.data.cleanupFailureStore };
}

function diagnosticMessage(stage: DiagnosticStage, reasonCode: string): string {
  if (reasonCode === "completed") return "The task completed with verified retained evidence.";
  if (reasonCode === "review_policy_blocked") return "Review policy requires an explicit operator decision.";
  if (reasonCode === "candidate_cleanup_unacknowledged") {
    return "Candidate cleanup has durable unacknowledged failure evidence.";
  }
  if (reasonCode === "candidate_cleanup_acknowledged") {
    return "Candidate cleanup failure records have durable disposition acknowledgements.";
  }
  if (reasonCode.endsWith("_uncertain") || reasonCode.endsWith("_reconciliation_required")) {
    return `The ${stage} stage requires explicit reconciliation before another effect.`;
  }
  const outcome = reasonCode.slice(stage.length + 1);
  if (["failed", "cancelled", "denied", "timed_out"].includes(outcome)) {
    return `The task ${outcome.replace("_", " ")} during ${stage} execution.`;
  }
  return `The task stopped after the ${stage} stage.`;
}

function safeWorktree(
  events: readonly StoredEvent[],
  taskId: string,
  worktreeRoot: string,
): { readonly branch: string; readonly path: string } | null {
  if (
    !isSafeWorktreeTaskIdentity(taskId) ||
    !path.isAbsolute(worktreeRoot) ||
    path.normalize(worktreeRoot) !== worktreeRoot
  ) return null;
  const lease = events.findLast((event) => event.type === "task.leased");
  const workspace = z.object({ workspace: z.string() }).safeParse(lease?.payload).data?.workspace;
  if (workspace === undefined) return null;
  const expected = path.join(worktreeRoot, taskId);
  if (path.dirname(expected) !== worktreeRoot || workspace !== expected) return null;
  return Object.freeze({ branch: `ticket/${taskId}`, path: workspace });
}

function isDiagnosticEvent(type: string): boolean {
  return isTerminalEvent(type) || type === "task.effect_uncertain" ||
    type === "task.review_policy_blocked" || type === "task.integration_observed" ||
    type === "task.cleanup_observed";
}

function isTerminalEvent(type: string): boolean {
  return ["task.completed", "task.cancelled", "task.denied", "task.timed_out", "task.failed"].includes(type);
}

function stageForEvent(type: string): DiagnosticStage {
  if (type.includes("worktree") || type === "task.created" || type === "task.leased") return "setup";
  if (type.includes("writer") || type === "task.started") return "worker";
  if (type.includes("validation")) return "validation";
  if (type.includes("review")) return "review";
  if (type.includes("commit")) return "commit";
  if (type.includes("integration")) return "integration";
  if (type.includes("cleanup")) return "cleanup";
  return "recovery";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
