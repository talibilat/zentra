import { createHash } from "node:crypto";

import { digestCanonical } from "../contracts/authority-attention.js";
import {
  AnalysisBudgetExhaustedPayloadSchema,
  AnalysisBudgetRevisedPayloadSchema,
  AnalysisCancelledPayloadSchema,
  AnalysisCompletedPayloadSchema,
  AnalysisObservedPayloadSchema,
  AnalysisReconciliationRequiredPayloadSchema,
  AnalysisReconciliationResolvedPayloadSchema,
  AnalysisRevisedPayloadSchema,
  AnalysisStartedPayloadSchema,
  AnalysisTerminalPayloadSchema,
  analysisStreamId,
  type AnalysisAnswer,
  type AnalysisBudget,
  type AnalysisObservation,
  type AnalysisUncertainty,
  type AnalysisUsage,
} from "../analysis/analysis-contracts.js";
import type { AttentionView } from "../attention/attention-projection.js";
import type { DecisionActor } from "../attention/attention-contracts.js";
import { AttentionService } from "../attention/attention-service.js";
import {
  IntakeSnapshotClosedPayloadSchema,
  SourceDiscoveredPayloadSchema,
  SourceRejectedPayloadSchema,
  type IntakeArtifactReference,
  type IntakeLimits,
  type SourceDiscoveredPayload,
} from "../intake/intake-contracts.js";
import {
  assertBoundedProjectionEntries,
  iterateAllEvents,
  readAllPageCompatible,
  readStreamEvents,
  type EventJournal,
} from "../journal/journal.js";
import type { PlanningAuthorityEnvelope } from "../planning/planning-contracts.js";
import type { PlanningView } from "../planning/planning-projection.js";
import { PlanningCoordinator } from "../planning/planning-coordinator.js";
import {
  RunIntakeCompletedPayloadSchema,
  runStreamId,
} from "../runs/run-contracts.js";
import type { RunView } from "../runs/run-projection.js";
import { RunService } from "../runs/run-service.js";

export type WorkflowChannel = "cli" | "ui";

export interface WorkflowCallerContext {
  readonly actorId: string;
  readonly channel: WorkflowChannel;
}

export type RunSubmission =
  | { readonly kind: "inline_goal"; readonly commandId: string; readonly goal: string }
  | { readonly kind: "ticket_directory"; readonly commandId: string; readonly directoryPath: string };

export interface RunSubmitter<TResult = unknown> {
  submit(input: RunSubmission, caller: WorkflowCallerContext): TResult;
}

export interface RunAdvanceRequest {
  readonly advanceId: string;
  readonly runId: string;
  readonly decisionId: string;
  readonly decisionVersion: number;
  readonly commandId: string;
}

/** Implementations must treat advanceId as an idempotency key across process restarts. */
export interface RunAdvancer {
  advance(input: RunAdvanceRequest): void;
}

export interface IntakeArtifactTextReader {
  readRetainedText(artifact: IntakeArtifactReference): string;
}

export type WorkflowSurfaceErrorCode =
  | "not_found"
  | "stale"
  | "consumed"
  | "expired"
  | "digest_mismatch"
  | "invalid_transition"
  | "uncertain"
  | "unavailable"
  | "internal";

export class WorkflowSurfaceError extends Error {
  readonly name = "WorkflowSurfaceError";

  constructor(
    readonly code: WorkflowSurfaceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface WorkflowCommand {
  readonly runId: string;
  readonly expectedVersion: number;
  readonly commandId: string;
}

export interface WorkflowDecisionCommand extends WorkflowCommand {
  readonly decisionId: string;
}

export interface WorkflowRunSummary {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly source: RunView["source"];
  readonly lifecycle: RunView["lifecycle"];
  readonly terminalOutcome: RunView["terminalOutcome"];
  readonly streamVersion: number;
  readonly approvalState: RunView["authority"]["approvalState"];
  readonly acceptedAt: string;
}

export interface WorkflowIntakeSource {
  readonly status: "accepted";
  readonly sourceId: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly mediaType: "text/plain; charset=utf-8";
  readonly trust: "untrusted_planning_data";
  readonly artifact: IntakeArtifactReference;
  readonly provenance: SourceDiscoveredPayload["provenance"];
}

export interface WorkflowSourceText {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sourceId: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly acceptedMaxBytes: number;
  readonly digest: string;
  readonly mediaType: "text/plain; charset=utf-8";
  readonly trust: "untrusted_planning_data";
  readonly artifact: IntakeArtifactReference;
  readonly text: string;
}

export interface WorkflowRejectedIntakeSource {
  readonly status: "rejected";
  readonly relativePath: string;
  readonly reason: string;
  readonly sizeBytes: number | null;
  readonly bytesRead: number;
  readonly digest: string | null;
  readonly provenance: SourceDiscoveredPayload["provenance"];
}

export interface WorkflowIntakeView {
  readonly status: "pending" | "closed";
  readonly sourceKind: RunView["source"]["kind"];
  readonly snapshotSha256: string | null;
  readonly sourceCount: number;
  readonly rejectedCount: number;
  readonly totalBytes: number;
  readonly limits: IntakeLimits | null;
  readonly sources: readonly WorkflowIntakeSource[];
  readonly rejectedSources: readonly WorkflowRejectedIntakeSource[];
}

export interface WorkflowAnalysisRound {
  readonly round: number;
  readonly observations: readonly AnalysisObservation[];
  readonly uncertainties: readonly AnalysisUncertainty[];
  readonly usage: AnalysisUsage;
  readonly sourceEvidenceSha256: string;
}

export interface WorkflowAnalysisView {
  readonly status: "not_started" | "running" | "awaiting_answer" | "budget_exhausted" |
    "reconciliation_required" | "completed" | "cancelled" | "timed_out" | "failed";
  readonly streamVersion: number;
  readonly budget: AnalysisBudget | null;
  readonly rounds: readonly WorkflowAnalysisRound[];
  readonly answers: readonly AnalysisAnswer[];
  readonly completion: ReturnType<typeof AnalysisCompletedPayloadSchema.parse> | null;
  readonly exhaustion: ReturnType<typeof AnalysisBudgetExhaustedPayloadSchema.parse> | null;
  readonly reconciliation: ReturnType<typeof AnalysisReconciliationRequiredPayloadSchema.parse> | null;
}

export interface WorkflowPlanningView {
  readonly status: "not_started" | PlanningView["lifecycle"];
  readonly revision: number | null;
  readonly streamVersion: number;
  readonly dag: PlanningView["proposal"]["plan"] | null;
  readonly envelope: PlanningAuthorityEnvelope | null;
  readonly planDigest: string | null;
  readonly envelopeDigest: string | null;
  readonly rejection: PlanningView["rejection"];
  readonly readiness: {
    readonly ready: boolean;
    readonly lifecycle: RunView["lifecycle"];
    readonly approvalState: RunView["authority"]["approvalState"];
    readonly executionAuthority: "none";
    readonly blockingDecisionIds: readonly string[];
  };
}

export interface WorkflowRunDetail {
  readonly schemaVersion: 1;
  readonly run: RunView;
  readonly intake: WorkflowIntakeView;
  readonly analysis: WorkflowAnalysisView;
  readonly decisions: readonly AttentionView[];
  readonly questions: readonly AttentionView[];
  readonly approvals: readonly AttentionView[];
  readonly attention: readonly AttentionView[];
  readonly commandEvidence: readonly WorkflowCommandEvidence[];
  readonly planning: WorkflowPlanningView;
}

export interface WorkflowDecisionMutation {
  readonly schemaVersion: 1;
  readonly run: RunView;
  readonly decision: AttentionView;
  readonly planning: WorkflowPlanningView;
}

export interface WorkflowChange {
  readonly globalPosition: number;
  readonly eventId: string;
  readonly streamId: string;
  readonly streamVersion: number;
  readonly type: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly recordedAt: string;
  readonly payload: unknown;
}

export interface WorkflowChangePage {
  readonly schemaVersion: 1;
  readonly afterPosition: number;
  readonly cursor: number;
  readonly nextCursor: number;
  readonly highWaterPosition: number;
  readonly hasMore: boolean;
  readonly changes: readonly WorkflowChange[];
}

export interface WorkflowCancellationCommandEvidence {
  readonly kind: "cancellation_requested";
  readonly runId: string;
  readonly expectedVersion: number;
  readonly commandId: string;
  readonly cancellationId: string;
  readonly reasonCode: "operator_requested" | "service_shutdown" | "source_withdrawn" | "superseded";
  readonly actor: DecisionActor;
  readonly evidenceSha256: string;
}

export interface WorkflowSubmissionCommandEvidence {
  readonly kind: "run_submission";
  readonly runId: string;
  readonly source: {
    readonly kind: RunView["source"]["kind"];
    readonly referenceSha256: string;
  };
  readonly actor: DecisionActor;
  readonly acceptanceCommandId: string;
  readonly evidenceSha256: string;
}

export type WorkflowCommandEvidence = WorkflowCancellationCommandEvidence | WorkflowSubmissionCommandEvidence;

export class WorkflowSurface<TResult = unknown> {
  constructor(
    private readonly journal: EventJournal,
    private readonly runs: RunService,
    private readonly attentionService: AttentionService,
    private readonly planningCoordinator: PlanningCoordinator,
    private readonly submitter: RunSubmitter<TResult>,
    private readonly runAdvancer: RunAdvancer,
    private readonly artifactTextReader?: IntakeArtifactTextReader,
  ) {}

  submitRun(input: RunSubmission, caller: WorkflowCallerContext): TResult {
    const result = this.guard(() => this.submitter.submit(validateSubmission(input), validateCaller(caller)));
    if (isPromiseLike(result)) {
      return result.catch((error: unknown) => { throw normalizeSurfaceError(error); }) as TResult;
    }
    return result;
  }

  listRuns(): readonly WorkflowRunSummary[] {
    return this.guard(() => this.listRunsProjection());
  }

  private listRunsProjection(): readonly WorkflowRunSummary[] {
    const accepted = new Map<string, { readonly position: number; readonly recordedAt: string }>();
    for (const event of iterateAllEvents(this.journal)) {
      if (event.type !== "run.accepted" || accepted.has(event.streamId)) continue;
      accepted.set(event.streamId, { position: event.globalPosition, recordedAt: event.recordedAt });
      assertBoundedProjectionEntries(accepted.size, "workflow run listing");
    }
    return json([...accepted.entries()]
      .map(([streamId, metadata]) => {
        const runId = streamId.startsWith("run:") ? streamId.slice(4) : "";
        const run = runId === "" ? null : this.runs.reopen(runId);
        if (run === null || runStreamId(run.runId) !== streamId) {
          throw new Error("run.accepted stream identity is contradictory");
        }
        return { run, metadata };
      })
      .sort((left, right) => right.metadata.position - left.metadata.position)
      .map(({ run, metadata }) => ({
        schemaVersion: 1 as const,
        runId: run.runId,
        projectId: run.projectId,
        source: run.source,
        lifecycle: run.lifecycle,
        terminalOutcome: run.terminalOutcome,
        streamVersion: run.streamVersion,
        approvalState: run.authority.approvalState,
        acceptedAt: metadata.recordedAt,
      })));
  }

  getRun(runId: string): WorkflowRunDetail | null {
    return this.guard(() => this.runDetail(runId));
  }

  getSourceText(runId: string, sourceId: string): WorkflowSourceText {
    return this.guard(() => {
      const run = requireRun(this.runs, runId);
      const completionEvent = this.runs.readStream(runId).findLast((event) => event.type === "run.intake_completed");
      if (completionEvent === undefined) throw new Error(`source ${sourceId} not found`);
      const completion = RunIntakeCompletedPayloadSchema.parse(completionEvent.payload);
      const events = readStreamEvents(this.journal, completion.intake.sourceStreamId);
      const closureEvent = events.find((event) => event.eventId === completion.intake.closureEventId);
      if (closureEvent === undefined) throw new Error("run intake closure event is missing");
      const closure = IntakeSnapshotClosedPayloadSchema.parse(closureEvent.payload);
      if (closure.runId !== runId || closureEvent.correlationId !== runId ||
        completion.intake.snapshotSha256 !== closure.snapshotSha256 ||
        completion.intake.sourceCount !== closure.sourceCount ||
        completion.intake.rejectedCount !== closure.rejectedCount ||
        completion.intake.totalBytes !== closure.totalBytes) {
        throw new Error("run intake closure binding is contradictory");
      }
      const discovered = events.filter((event) => event.streamVersion < closureEvent.streamVersion && event.type === "source.discovered")
        .map((event) => SourceDiscoveredPayloadSchema.parse(event.payload))
      if (discovered.length !== closure.sourceCount) throw new Error("run intake source count is contradictory");
      const matches = discovered.filter((source) => source.sourceId === sourceId);
      if (matches.length !== 1) throw new Error(`source ${sourceId} not found`);
      const source = matches[0]!;
      if (source.runId !== runId || source.artifact.sha256 !== source.digest ||
        source.artifact.sizeBytes !== source.sizeBytes || source.artifact.artifactId !== `intake-text-v1:${source.digest}`) {
        throw new Error("run source artifact binding is contradictory");
      }
      if (this.artifactTextReader === undefined) throw new WorkflowSurfaceError("unavailable", "source text reader is unavailable");
      const text = this.artifactTextReader.readRetainedText(source.artifact);
      const bytes = Buffer.from(text, "utf8");
      if (bytes.length !== source.sizeBytes || bytes.length > closure.limits.maxFileBytes ||
        createTextDigest(bytes) !== source.digest) {
        throw new Error("verified source text contradicts its exact artifact binding");
      }
      return json({
        schemaVersion: 1 as const,
        runId,
        sourceId,
        relativePath: source.path,
        sizeBytes: source.sizeBytes,
        acceptedMaxBytes: closure.limits.maxFileBytes,
        digest: source.digest,
        mediaType: source.mediaType,
        trust: source.trust,
        artifact: source.artifact,
        text,
      });
    });
  }

  private runDetail(runId: string): WorkflowRunDetail | null {
    const run = this.runs.reopen(runId);
    if (run === null) return null;
    const decisions = this.allAttention(runId);
    return json({
      schemaVersion: 1 as const,
      run,
      intake: this.intake(run),
      analysis: this.analysis(runId),
      decisions: decisions.filter((item) => item.kind !== "advisory"),
      questions: decisions.filter((item) => item.kind === "question"),
      approvals: decisions.filter((item) => item.kind === "approval"),
      attention: decisions,
      commandEvidence: this.commandEvidence(run),
      planning: this.planning(run, decisions),
    });
  }

  getDecision(decisionId: string): AttentionView | null {
    return this.guard(() => {
      const decision = this.attentionService.getDecision(decisionId);
      return decision === null ? null : json(decision);
    });
  }

  listAttention(runId: string): readonly AttentionView[] {
    return this.guard(() => {
      requireRun(this.runs, runId);
      return json(this.allAttention(runId).filter((item) => item.status === "pending"));
    });
  }

  getChanges(afterPosition = 0, limit = 100): WorkflowChangePage {
    return this.guard(() => {
      if (!Number.isSafeInteger(afterPosition) || afterPosition < 0) {
        throw new Error("workflow change cursor is invalid");
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("workflow change page limit is invalid");
      }
      const page = readAllPageCompatible(this.journal, afterPosition, {
        maxEvents: limit,
        maxBytes: 16 * 1024 * 1024,
      });
      if (page.highWaterPosition === undefined && page.hasMore) {
        throw new WorkflowSurfaceError("unavailable", "journal cannot provide a stable workflow high-water position");
      }
      const nextCursor = page.events.at(-1)?.globalPosition ?? afterPosition;
      return json({
        schemaVersion: 1 as const,
        afterPosition,
        cursor: nextCursor,
        nextCursor,
        highWaterPosition: page.highWaterPosition ?? nextCursor,
        hasMore: nextCursor < (page.highWaterPosition ?? nextCursor),
        changes: page.events.map((event) => ({
          globalPosition: event.globalPosition,
          eventId: event.eventId,
          streamId: event.streamId,
          streamVersion: event.streamVersion,
          type: event.type,
          correlationId: event.correlationId,
          causationId: event.causationId,
          recordedAt: event.recordedAt,
          payload: event.payload,
        })),
      });
    });
  }

  cancelRun(input: WorkflowCommand & {
    readonly cancellationId: string;
    readonly reasonCode?: "operator_requested" | "service_shutdown" | "source_withdrawn" | "superseded";
  }, caller: WorkflowCallerContext): WorkflowRunDetail {
    return this.guard(() => {
      const actor = decisionActor(caller);
      const current = requireRun(this.runs, input.runId);
      if (current.lifecycle !== "terminal" && input.expectedVersion !== current.streamVersion) {
        throw new Error(`expected version ${input.expectedVersion}, actual ${current.streamVersion}`);
      }
      const evidence = this.recordCancellationEvidence(input, actor);
      this.runs.cancel(input.runId, {
        expectedVersion: input.expectedVersion,
        commandId: input.commandId,
        causationId: null,
        process: current.activeProcess,
      }, {
        cancellationId: input.cancellationId,
        requestedBy: { actorId: actor.actorId, kind: "operator" },
        reasonCode: evidence.reasonCode,
      });
      return requiredDetail(this.runDetail(input.runId));
    });
  }

  answerQuestion(input: WorkflowDecisionCommand & { readonly optionId: string }, caller: WorkflowCallerContext): WorkflowDecisionMutation {
    return this.guard(() => {
      const actor = decisionActor(caller);
      const replay = this.completedAdvance("answer_question", input, actor);
      if (replay !== null) return replay;
      const recovered = this.recoverConsumedQuestion("answer_question", input, actor);
      if (recovered !== null) {
        this.advanceRun("answer_question", input, actor, recovered);
        return this.mutation(input.runId, recovered);
      }
      const decision = this.attentionService.answer(input.decisionId, {
        runId: input.runId,
        expectedVersion: input.expectedVersion,
        actor,
        commandId: input.commandId,
        optionId: input.optionId,
        evidenceSha256: mutationDigest("answer_question", input, actor),
      });
      this.advanceRun("answer_question", input, actor, decision);
      return this.mutation(input.runId, decision);
    });
  }

  rejectQuestion(input: WorkflowDecisionCommand & { readonly reason: string }, caller: WorkflowCallerContext): WorkflowDecisionMutation {
    return this.guard(() => {
      const actor = decisionActor(caller);
      const replay = this.completedAdvance("reject_question", input, actor);
      if (replay !== null) return replay;
      const recovered = this.recoverConsumedQuestion("reject_question", input, actor);
      if (recovered !== null) {
        this.advanceRun("reject_question", input, actor, recovered);
        return this.mutation(input.runId, recovered);
      }
      const current = this.attentionService.getDecision(input.decisionId);
      if (current?.kind !== "question") throw new Error("decision is not a question");
      const decision = this.attentionService.reject(input.decisionId, {
        runId: input.runId,
        expectedVersion: input.expectedVersion,
        actor,
        commandId: input.commandId,
        reason: input.reason,
        evidenceSha256: mutationDigest("reject_question", input, actor),
      });
      this.advanceRun("reject_question", input, actor, decision);
      return this.mutation(input.runId, decision);
    });
  }

  approvePlan(input: WorkflowDecisionCommand & {
    readonly planDigest: string;
    readonly envelopeDigest: string;
  }, caller: WorkflowCallerContext): WorkflowDecisionMutation {
    return this.guard(() => {
      const actor = decisionActor(caller);
      const decision = this.attentionService.acceptApproval(input.decisionId, {
        runId: input.runId,
        expectedVersion: input.expectedVersion,
        actor,
        commandId: input.commandId,
        planDigest: input.planDigest,
        envelopeDigest: input.envelopeDigest,
        evidenceSha256: mutationDigest("approve_plan", input, actor),
      });
      return this.mutation(input.runId, decision);
    });
  }

  rejectPlan(input: WorkflowDecisionCommand & { readonly reason: string }, caller: WorkflowCallerContext): WorkflowDecisionMutation {
    return this.guard(() => {
      const actor = decisionActor(caller);
      const planning = this.planningCoordinator.reject(input.decisionId, {
        runId: input.runId,
        expectedVersion: input.expectedVersion,
        actor,
        commandId: input.commandId,
        reason: input.reason,
        evidenceSha256: mutationDigest("reject_plan", input, actor),
      });
      const decision = this.attentionService.getDecision(input.decisionId);
      if (decision === null) throw new Error("planning rejection decision disappeared");
      const run = requireRun(this.runs, input.runId);
      return json({ schemaVersion: 1 as const, run, decision, planning: this.planning(run, this.allAttention(input.runId), planning) });
    });
  }

  private mutation(runId: string, decision: AttentionView): WorkflowDecisionMutation {
    const run = requireRun(this.runs, runId);
    return json({ schemaVersion: 1 as const, run, decision, planning: this.planning(run, this.allAttention(runId)) });
  }

  private completedAdvance(
    action: "answer_question" | "reject_question",
    input: WorkflowDecisionCommand & ({ readonly optionId: string } | { readonly reason: string }),
    actor: DecisionActor,
  ): WorkflowDecisionMutation | null {
    const streamId = advanceStreamId(input.decisionId, input.commandId);
    const events = readStreamEvents(this.journal, streamId);
    if (events.length === 0) return null;
    const requested = record(events[0]!.payload);
    if (requested["inputSha256"] !== mutationDigest(action, input, actor)) {
      throw new Error("workflow advancement command identity was reused with different input");
    }
    const decision = this.attentionService.getDecision(input.decisionId);
    if (decision === null) throw new Error(`decision ${input.decisionId} not found`);
    const expectedStatus = action === "answer_question" ? "accepted" : "rejected";
    if (decision.status !== expectedStatus) {
      if (decision.status === "pending") return null;
      throw new Error("workflow advancement contradicts its decision state");
    }
    if (!events.some((event) => event.type === "workflow.run_advanced")) {
      this.advanceRun(action, input, actor, decision);
    }
    return this.mutation(input.runId, decision);
  }

  private recoverConsumedQuestion(
    action: "answer_question" | "reject_question",
    input: WorkflowDecisionCommand & ({ readonly optionId: string } | { readonly reason: string }),
    actor: DecisionActor,
  ): AttentionView | null {
    const decision = this.attentionService.getDecision(input.decisionId);
    if (decision === null || decision.status === "pending") return null;
    if (decision.kind !== "question" || decision.runId !== input.runId) {
      throw new Error("decision replay digest mismatch with durable question identity");
    }
    const expectedStatus = action === "answer_question" ? "accepted" : "rejected";
    if (decision.status !== expectedStatus) {
      throw new Error("decision is already consumed");
    }
    const expectedType = action === "answer_question" ? "decision.accepted" : "decision.rejected";
    const event = this.attentionService.readDecisionStream(input.decisionId)
      .find((candidate) => candidate.type === expectedType);
    if (event === undefined) throw new Error("durable question decision payload is missing");
    const payload = record(event.payload);
    if (payload["commandId"] !== input.commandId) throw new Error("decision is already consumed");
    const valueMatches = action === "answer_question"
      ? payload["optionId"] === (input as { readonly optionId: string }).optionId
      : payload["reason"] === (input as { readonly reason: string }).reason;
    if (payload["decisionId"] !== input.decisionId || payload["runId"] !== input.runId ||
      JSON.stringify(payload["actor"]) !== JSON.stringify(actor) ||
      payload["evidenceSha256"] !== mutationDigest(action, input, actor) || !valueMatches) {
      throw new Error("decision replay digest mismatch with durable decision payload");
    }
    return decision;
  }

  private advanceRun(
    action: "answer_question" | "reject_question",
    input: WorkflowDecisionCommand & ({ readonly optionId: string } | { readonly reason: string }),
    actor: DecisionActor,
    decision: AttentionView,
  ): void {
    const advanceId = digestCanonical({ schemaVersion: 1, decisionId: input.decisionId, commandId: input.commandId });
    const streamId = advanceStreamId(input.decisionId, input.commandId);
    let events = readStreamEvents(this.journal, streamId);
    const inputSha256 = mutationDigest(action, input, actor);
    if (events.length === 0) {
      this.journal.append(streamId, 0, [{
        streamId,
        type: "workflow.run_advancement_requested",
        correlationId: input.runId,
        causationId: this.attentionService.readDecisionStream(input.decisionId).at(-1)?.eventId ?? null,
        payload: {
          schemaVersion: 1,
          advanceId,
          runId: input.runId,
          decisionId: input.decisionId,
          decisionVersion: decision.streamVersion,
          commandId: input.commandId,
          inputSha256,
        },
      }]);
      events = readStreamEvents(this.journal, streamId);
    } else if (record(events[0]!.payload)["inputSha256"] !== inputSha256) {
      throw new Error("workflow advancement command identity was reused with different input");
    }
    if (events.some((event) => event.type === "workflow.run_advanced")) return;
    try {
      this.runAdvancer.advance({
        advanceId,
        runId: input.runId,
        decisionId: input.decisionId,
        decisionVersion: decision.streamVersion,
        commandId: input.commandId,
      });
    } catch (error) {
      throw new WorkflowSurfaceError("unavailable", "run advancement is unavailable", { cause: error });
    }
    try {
      this.journal.append(streamId, events.at(-1)!.streamVersion, [{
        streamId,
        type: "workflow.run_advanced",
        correlationId: input.runId,
        causationId: events[0]!.eventId,
        payload: {
          schemaVersion: 1,
          advanceId,
          runId: input.runId,
          decisionId: input.decisionId,
          decisionVersion: decision.streamVersion,
          commandId: input.commandId,
        },
      }]);
    } catch (error) {
      const replay = readStreamEvents(this.journal, streamId);
      if (!replay.some((event) => event.type === "workflow.run_advanced")) throw error;
    }
  }

  private recordCancellationEvidence(
    input: WorkflowCommand & {
      readonly cancellationId: string;
      readonly reasonCode?: "operator_requested" | "service_shutdown" | "source_withdrawn" | "superseded";
    },
    actor: DecisionActor,
  ): WorkflowCancellationCommandEvidence {
    const reasonCode = input.reasonCode ?? "operator_requested";
    const body = {
      kind: "cancellation_requested" as const,
      runId: input.runId,
      expectedVersion: input.expectedVersion,
      commandId: input.commandId,
      cancellationId: input.cancellationId,
      reasonCode,
      actor,
    };
    const evidence = json({ ...body, evidenceSha256: digestCanonical(body) });
    const streamId = cancellationEvidenceStreamId(input.runId, input.commandId);
    const existing = readStreamEvents(this.journal, streamId);
    if (existing.length > 0) {
      if (existing.length !== 1 || existing[0]!.type !== "workflow.cancel_requested" ||
        JSON.stringify(existing[0]!.payload) !== JSON.stringify(evidence)) {
        throw new Error("workflow cancellation command identity was reused with different input");
      }
      return evidence;
    }
    this.journal.append(streamId, 0, [{
      streamId,
      type: "workflow.cancel_requested",
      correlationId: input.runId,
      causationId: null,
      payload: evidence,
    }]);
    return evidence;
  }

  private commandEvidence(run: RunView): readonly WorkflowCommandEvidence[] {
    const evidence: WorkflowCommandEvidence[] = [];
    const accepted = this.runs.readStream(run.runId)[0];
    if (accepted?.type !== "run.accepted") throw new Error("run acceptance evidence is missing");
    const acceptanceCommandId = stringField(record(accepted.payload), "commandId");
    for (const event of iterateAllEvents(this.journal)) {
      if (event.correlationId !== run.runId ||
        (event.type !== "workflow.run_submitted" && event.type !== "workflow.cancel_requested")) continue;
      const payload = event.payload as WorkflowCommandEvidence;
      const { evidenceSha256, ...body } = payload;
      if (digestCanonical(body) !== evidenceSha256) {
        throw new Error("workflow command evidence digest is invalid");
      }
      if (event.type === "workflow.run_submitted") {
        if (payload.kind !== "run_submission" || payload.runId !== run.runId ||
          payload.source.kind !== run.source.kind ||
          payload.source.referenceSha256 !== run.source.referenceSha256 ||
          payload.actor.actorId !== run.actor.actorId || payload.actor.kind !== run.actor.kind ||
          (payload.actor.channel !== "cli" && payload.actor.channel !== "ui") ||
          payload.acceptanceCommandId !== acceptanceCommandId) {
          throw new Error("workflow submission evidence contradicts the accepted run");
        }
      } else if (payload.kind !== "cancellation_requested") {
        throw new Error("workflow cancellation evidence kind is invalid");
      }
      evidence.push(payload);
      assertBoundedProjectionEntries(evidence.length, "workflow command evidence");
    }
    return evidence;
  }

  private guard<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      throw normalizeSurfaceError(error);
    }
  }

  private allAttention(runId: string): readonly AttentionView[] {
    const identities = new Map<string, { readonly kind: "decision" | "advisory"; readonly id: string; readonly position: number }>();
    for (const event of iterateAllEvents(this.journal)) {
      if (event.correlationId !== runId) continue;
      const payload = record(event.payload);
      if (event.type === "questionnaire.proposed" || event.type === "approval.requested") {
        const id = stringField(payload, "decisionId");
        identities.set(`decision:${id}`, { kind: "decision", id, position: event.globalPosition });
      } else if (event.type === "attention.raised" && payload["source"] === "agenttrail") {
        const id = stringField(payload, "attentionId");
        identities.set(`advisory:${id}`, { kind: "advisory", id, position: event.globalPosition });
      }
      assertBoundedProjectionEntries(identities.size, "workflow attention listing");
    }
    return [...identities.values()]
      .sort((left, right) => left.position - right.position)
      .map((identity) => identity.kind === "decision"
        ? this.attentionService.getDecision(identity.id)
        : this.attentionService.getAdvisory(identity.id))
      .map((view) => {
        if (view === null || view.runId !== runId) throw new Error("attention stream identity is contradictory");
        return view;
      });
  }

  private intake(run: RunView): WorkflowIntakeView {
    const completionEvent = this.runs.readStream(run.runId).findLast((event) => event.type === "run.intake_completed");
    if (completionEvent === undefined) return {
      status: "pending", sourceKind: run.source.kind, snapshotSha256: null,
      sourceCount: 0, rejectedCount: 0, totalBytes: 0, limits: null, sources: [], rejectedSources: [],
    };
    const completion = RunIntakeCompletedPayloadSchema.parse(completionEvent.payload);
    const events = readStreamEvents(this.journal, completion.intake.sourceStreamId);
    const closureEvent = events.find((event) => event.eventId === completion.intake.closureEventId);
    if (closureEvent === undefined) throw new Error("run intake closure event is missing");
    const closure = IntakeSnapshotClosedPayloadSchema.parse(closureEvent.payload);
    const sources = events.filter((event) => event.type === "source.discovered").map((event) => {
      const source = SourceDiscoveredPayloadSchema.parse(event.payload);
      return {
        status: "accepted" as const, sourceId: source.sourceId, relativePath: source.path,
        sizeBytes: source.sizeBytes, digest: source.digest, mediaType: source.mediaType,
        trust: source.trust, artifact: source.artifact, provenance: source.provenance,
      };
    });
    const rejectedSources = events.filter((event) => event.type === "source.rejected").map((event) => {
      const source = SourceRejectedPayloadSchema.parse(event.payload);
      return {
        status: "rejected" as const, relativePath: source.path, reason: source.reason,
        sizeBytes: source.sizeBytes, bytesRead: source.bytesRead, digest: source.digest, provenance: source.provenance,
      };
    });
    return {
      status: "closed", sourceKind: closure.sourceKind, snapshotSha256: closure.snapshotSha256,
      sourceCount: closure.sourceCount, rejectedCount: closure.rejectedCount, totalBytes: closure.totalBytes,
      limits: closure.limits, sources, rejectedSources,
    };
  }

  private analysis(runId: string): WorkflowAnalysisView {
    const events = readStreamEvents(this.journal, analysisStreamId(runId));
    let budget: AnalysisBudget | null = null;
    const rounds: WorkflowAnalysisRound[] = [];
    const answers: AnalysisAnswer[] = [];
    let completion: WorkflowAnalysisView["completion"] = null;
    let exhaustion: WorkflowAnalysisView["exhaustion"] = null;
    let reconciliation: WorkflowAnalysisView["reconciliation"] = null;
    let status: WorkflowAnalysisView["status"] = "not_started";
    for (const event of events) {
      switch (event.type) {
        case "analysis.started": budget = AnalysisStartedPayloadSchema.parse(event.payload).budget; status = "running"; break;
        case "analysis.observed": {
          const round = AnalysisObservedPayloadSchema.parse(event.payload);
          rounds.push({ round: round.round, observations: round.observations, uncertainties: round.uncertainties,
            usage: round.usage, sourceEvidenceSha256: round.sourceEvidenceSha256 });
          status = round.uncertainties.some((item) => item.materiality === "material") ? "awaiting_answer" : "running";
          break;
        }
        case "analysis.revised": answers.push(AnalysisRevisedPayloadSchema.parse(event.payload).answer); status = "running"; break;
        case "analysis.budget_exhausted": exhaustion = AnalysisBudgetExhaustedPayloadSchema.parse(event.payload); status = "budget_exhausted"; break;
        case "analysis.budget_revised": budget = AnalysisBudgetRevisedPayloadSchema.parse(event.payload).budget; exhaustion = null; status = "running"; break;
        case "analysis.reconciliation_required": reconciliation = AnalysisReconciliationRequiredPayloadSchema.parse(event.payload); status = "reconciliation_required"; break;
        case "analysis.reconciliation_resolved": AnalysisReconciliationResolvedPayloadSchema.parse(event.payload); reconciliation = null; status = "running"; break;
        case "analysis.completed": completion = AnalysisCompletedPayloadSchema.parse(event.payload); status = "completed"; break;
        case "analysis.cancelled": AnalysisCancelledPayloadSchema.parse(event.payload); status = "cancelled"; break;
        case "analysis.timed_out": AnalysisTerminalPayloadSchema.parse(event.payload); status = "timed_out"; break;
        case "analysis.failed": AnalysisTerminalPayloadSchema.parse(event.payload); status = "failed"; break;
        case "analysis.invocation_reserved": break;
        default: throw new Error(`unknown analysis event type ${event.type}`);
      }
    }
    return { status, streamVersion: events.at(-1)?.streamVersion ?? 0, budget, rounds, answers, completion, exhaustion, reconciliation };
  }

  private planning(run: RunView, attention: readonly AttentionView[], supplied?: PlanningView): WorkflowPlanningView {
    const planning = supplied ?? this.planningCoordinator.get(run.runId);
    const blockingDecisionIds = attention.filter((item) => item.material && item.status === "pending")
      .map((item) => item.decisionId).sort();
    return {
      status: planning?.lifecycle ?? "not_started",
      revision: planning?.revision ?? null,
      streamVersion: planning?.streamVersion ?? 0,
      dag: planning?.proposal.plan ?? null,
      envelope: planning?.envelope ?? null,
      planDigest: planning?.planDigest ?? null,
      envelopeDigest: planning?.envelopeDigest ?? null,
      rejection: planning?.rejection ?? null,
      readiness: {
        ready: run.lifecycle === "approved_and_ready_for_execution" && blockingDecisionIds.length === 0,
        lifecycle: run.lifecycle,
        approvalState: run.authority.approvalState,
        executionAuthority: "none",
        blockingDecisionIds,
      },
    };
  }
}

function validateSubmission(input: RunSubmission): RunSubmission {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.commandId)) {
    throw new Error("submission command identity is invalid");
  }
  if (input.kind === "inline_goal") {
    if (input.goal.trim() === "") throw new Error("inline goal must not be empty");
    return json(input);
  }
  if (input.kind === "ticket_directory") {
    if (input.directoryPath.trim() === "") throw new Error("ticket directory path must not be empty");
    return json(input);
  }
  throw new Error("unsupported run submission kind");
}

function validateCaller(caller: WorkflowCallerContext): WorkflowCallerContext {
  if (caller.actorId.trim() === "") throw new Error("workflow caller actor identity must not be empty");
  if (caller.channel !== "cli" && caller.channel !== "ui") throw new Error("workflow caller channel must be cli or ui");
  return json(caller);
}

function decisionActor(caller: WorkflowCallerContext): DecisionActor {
  const validated = validateCaller(caller);
  return { actorId: validated.actorId, kind: "operator", channel: validated.channel };
}

function mutationDigest(action: string, input: object, actor: DecisionActor): string {
  return digestCanonical({ schemaVersion: 1, action, input, actor });
}

function advanceStreamId(decisionId: string, commandId: string): string {
  return `workflow-advance:${digestCanonical({ decisionId, commandId })}`;
}

function cancellationEvidenceStreamId(runId: string, commandId: string): string {
  return `workflow-command:${digestCanonical({ runId, commandId })}`;
}

function normalizeSurfaceError(error: unknown): WorkflowSurfaceError {
  if (error instanceof WorkflowSurfaceError) return error;
  const message = error instanceof Error ? error.message : "unknown workflow surface failure";
  const normalized = message.toLowerCase();
  let code: WorkflowSurfaceErrorCode;
  if (/not found|is missing|disappeared/.test(normalized)) code = "not_found";
  else if (/digest|exact packet|packet_digest/.test(normalized)) code = "digest_mismatch";
  else if (/already consumed|already resolved|already cancelled|identity was reused/.test(normalized)) code = "consumed";
  else if (/expired|expiry/.test(normalized)) code = "expired";
  else if (/expected version|\bstale\b|run revision/.test(normalized)) code = "stale";
  else if (/unavailable|requires an atomic journal|could not obtain|retry exhausted/.test(normalized)) code = "unavailable";
  else if (/invalid|cannot|must|requires|is not|terminal|transition|unsupported|empty/.test(normalized)) code = "invalid_transition";
  else code = "internal";
  return new WorkflowSurfaceError(code, message, { cause: error });
}

function requireRun(runs: RunService, runId: string): RunView {
  const run = runs.get(runId);
  if (run === null) throw new Error(`run ${runId} not found`);
  return run;
}

function requiredDetail(detail: WorkflowRunDetail | null): WorkflowRunDetail {
  if (detail === null) throw new Error("workflow run detail unexpectedly disappeared");
  return detail;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("workflow event payload must be an object");
  return value as Readonly<Record<string, unknown>>;
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field === "") throw new Error(`workflow event ${key} is invalid`);
  return field;
}

function json<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("workflow projection must be JSON-serializable");
  return deepFreeze(JSON.parse(encoded) as T);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { readonly then?: unknown }).then === "function";
}

function createTextDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
