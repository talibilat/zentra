import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { digestCanonical } from "../contracts/authority-attention.js";
import { AttentionService } from "../attention/attention-service.js";
import { IntakeArtifactStore } from "../intake/intake-artifact-store.js";
import { IntakeService } from "../intake/intake-service.js";
import { BoundedTicketIntake, type TicketIntakeLimits, type TicketIntakeSource } from "../intake/ticket-intake.js";
import { readStreamEvents, type EventJournal } from "../journal/journal.js";
import { PlanningCoordinator } from "../planning/planning-coordinator.js";
import { projectRevisionMatches } from "../runs/project-revision.js";
import { RunPreflightCoordinator } from "../runs/run-preflight.js";
import type { ProjectRevision, RunProcess, RunSource } from "../runs/run-contracts.js";
import { RunService } from "../runs/run-service.js";
import {
  WorkflowSurface,
  type RunAdvancer,
  type RunSubmission,
  type WorkflowCallerContext,
  type WorkflowSubmissionCommandEvidence,
  type WorkflowRunDetail,
} from "./workflow-surface.js";

const DEFAULT_RUN_BUDGET = Object.freeze({
  maxDurationMs: 5 * 60_000,
  maxInputTokens: 100_000,
  maxOutputTokens: 20_000,
  maxCostUsdNano: 0,
  maxRetries: 0,
  maxSourceFiles: 100,
  maxSourceBytes: 10 * 1024 * 1024,
});

const DEFAULT_INTAKE_LIMITS: TicketIntakeLimits = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxFiles: 100,
  maxTotalBytes: 10 * 1024 * 1024,
  maxDepth: 8,
  maxEntries: 1_000,
  maxDirectoryEntries: 1_000,
});

const unavailableAdvancer: RunAdvancer = Object.freeze({
  advance: () => { throw new Error("run advancement is not configured"); },
});

export interface LocalWorkflowSurfaceOptions {
  readonly journal: EventJournal;
  readonly process: RunProcess;
  readonly serviceReadyEventId: string;
  readonly projectRoot: string;
  readonly projectRevision: ProjectRevision;
  readonly runAdvancer?: RunAdvancer;
  readonly traceProjectionFailed?: () => boolean;
  readonly afterSubmissionReserved?: (runId: string) => void | Promise<void>;
}

export type LocalWorkflowSurface = WorkflowSurface<Promise<WorkflowRunDetail>>;

export async function createLocalWorkflowSurface(
  options: LocalWorkflowSurfaceOptions,
): Promise<LocalWorkflowSurface> {
  const projectRoot = await canonicalDirectory(options.projectRoot);
  const artifacts = await IntakeArtifactStore.openProject(projectRoot);
  const runs = new RunService(options.journal);
  const attention = new AttentionService(options.journal);
  const planning = new PlanningCoordinator(options.journal, runs, attention, []);
  const intake = new IntakeService(
    options.journal,
    runs,
    new BoundedTicketIntake(),
    artifacts,
  );
  const preflight = new RunPreflightCoordinator(
    runs,
    options.traceProjectionFailed ?? (() => false),
    (revision) => projectRevisionMatches(projectRoot, revision),
  );
  const projectId = `project-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 24)}`;
  let surface!: LocalWorkflowSurface;
  surface = new WorkflowSurface(
    options.journal,
    runs,
    attention,
    planning,
    {
      submit: async (submission: RunSubmission, caller: WorkflowCallerContext): Promise<WorkflowRunDetail> => {
        const source = await canonicalSource(projectRoot, submission);
        const reference = source.kind === "inline_goal" ? source.goal : source.root;
        const referenceBytes = Buffer.from(reference, "utf8");
        const acceptedSource: RunSource = {
          kind: source.kind,
          referenceSha256: createHash("sha256").update(referenceBytes).digest("hex"),
          declaredBytes: referenceBytes.length,
        };
        const actor = { actorId: caller.actorId, kind: "operator" as const, channel: caller.channel };
        const reservation = reserveSubmission(options.journal, options.serviceReadyEventId, {
          commandId: submission.commandId,
          source: acceptedSource,
          actor,
        });
        const runId = reservation.runId;
        const acceptanceCommandId = submission.commandId;
        await options.afterSubmissionReserved?.(runId);
        recordSubmissionEvidence(options.journal, options.serviceReadyEventId, {
          runId,
          source: {
            kind: acceptedSource.kind,
            referenceSha256: acceptedSource.referenceSha256,
          },
          actor,
          acceptanceCommandId,
        });
        const current = runs.get(runId);
        if (current === null || current.lifecycle === "accepted" || current.lifecycle === "preflighting" || current.lifecycle === "intake") await preflight.prepareAndInvoke({
          runId,
          projectId,
          projectRevision: options.projectRevision,
          source: acceptedSource,
          actor: { actorId: caller.actorId, kind: "operator" },
          process: options.process,
          budget: DEFAULT_RUN_BUDGET,
          commandId: acceptanceCommandId,
          causationId: options.serviceReadyEventId,
        }, () => intake.intake({
          runId,
          projectRevision: options.projectRevision,
          source,
          limits: DEFAULT_INTAKE_LIMITS,
          commandId: derivedCommandId(submission.commandId, "intake"),
        }));
        const detail = surface.getRun(runId);
        if (detail === null) throw new Error("submitted run disappeared after durable reservation");
        return detail;
      },
    },
    options.runAdvancer ?? unavailableAdvancer,
    artifacts,
  );
  return surface;
}

interface SubmissionReservation {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly requestSha256: string;
  readonly runId: string;
  readonly source: RunSource;
  readonly actor: WorkflowSubmissionCommandEvidence["actor"];
}

function reserveSubmission(
  journal: EventJournal,
  serviceReadyEventId: string,
  input: Omit<SubmissionReservation, "schemaVersion" | "requestSha256" | "runId">,
): SubmissionReservation {
  const streamId = `workflow-submission:${digestCanonical({ schemaVersion: 1, commandId: input.commandId })}`;
  const requestSha256 = digestCanonical({ schemaVersion: 1, source: input.source, actor: input.actor });
  const existing = readStreamEvents(journal, streamId);
  if (existing.length > 0) return parseReservation(existing, input, requestSha256);
  const reservation: SubmissionReservation = {
    schemaVersion: 1, commandId: input.commandId, requestSha256, runId: `run-${randomUUID()}`,
    source: input.source, actor: input.actor,
  };
  try {
    journal.append(streamId, 0, [{ streamId, type: "workflow.run_submission_reserved",
      correlationId: reservation.runId, causationId: serviceReadyEventId, payload: reservation }]);
    return reservation;
  } catch (error) {
    const raced = readStreamEvents(journal, streamId);
    if (raced.length === 0) throw error;
    return parseReservation(raced, input, requestSha256);
  }
}

function parseReservation(
  events: ReturnType<typeof readStreamEvents>,
  input: Omit<SubmissionReservation, "schemaVersion" | "requestSha256" | "runId">,
  requestSha256: string,
): SubmissionReservation {
  if (events.length !== 1 || events[0]!.type !== "workflow.run_submission_reserved") {
    throw new Error("workflow submission reservation is contradictory");
  }
  const reservation = events[0]!.payload as SubmissionReservation;
  if (reservation.schemaVersion !== 1 || reservation.commandId !== input.commandId || reservation.requestSha256 !== requestSha256 ||
    digestCanonical({ schemaVersion: 1, source: reservation.source, actor: reservation.actor }) !== requestSha256 ||
    JSON.stringify(reservation.source) !== JSON.stringify(input.source) ||
    JSON.stringify(reservation.actor) !== JSON.stringify(input.actor) ||
    !/^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reservation.runId)) {
    throw new Error("workflow submission command identity was reused with different input");
  }
  return reservation;
}

function derivedCommandId(parent: string, stage: string): string {
  return `submission:${createHash("sha256").update(`${parent}\0${stage}`).digest("hex")}`;
}

async function canonicalSource(projectRoot: string, submission: RunSubmission): Promise<TicketIntakeSource> {
  if (submission.kind === "inline_goal") return { kind: submission.kind, goal: submission.goal };
  const supplied = path.isAbsolute(submission.directoryPath)
    ? submission.directoryPath
    : path.resolve(projectRoot, submission.directoryPath);
  const root = await canonicalDirectory(supplied);
  const relative = path.relative(projectRoot, root);
  if (relative !== "" && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
    throw new Error("ticket directory must equal or descend from the project root");
  }
  return { kind: submission.kind, root };
}

async function canonicalDirectory(supplied: string): Promise<string> {
  if (supplied.length === 0 || Buffer.byteLength(supplied, "utf8") > 4_096 || /[\u0000-\u001f\u007f]/.test(supplied)) {
    throw new Error("directory path is invalid");
  }
  const canonical = await realpath(path.resolve(supplied));
  const stat = await lstat(canonical);
  if (!path.isAbsolute(canonical) || path.normalize(canonical) !== canonical || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("directory path is not a canonical directory");
  }
  return canonical;
}

function recordSubmissionEvidence(
  journal: EventJournal,
  serviceReadyEventId: string,
  input: Omit<WorkflowSubmissionCommandEvidence, "kind" | "evidenceSha256">,
): void {
  const body = { kind: "run_submission" as const, ...input };
  const evidence: WorkflowSubmissionCommandEvidence = {
    ...body,
    evidenceSha256: digestCanonical(body),
  };
  const streamId = `workflow-command:${digestCanonical({
    runId: input.runId,
    commandId: input.acceptanceCommandId,
  })}`;
  const existing = readStreamEvents(journal, streamId);
  if (existing.length > 0) {
    if (existing.length !== 1 || existing[0]!.type !== "workflow.run_submitted" ||
      JSON.stringify(existing[0]!.payload) !== JSON.stringify(evidence)) {
      throw new Error("workflow submission command identity was reused with different input");
    }
    return;
  }
  journal.append(streamId, 0, [{
    streamId,
    type: "workflow.run_submitted",
    correlationId: input.runId,
    causationId: serviceReadyEventId,
    payload: evidence,
  }]);
}
