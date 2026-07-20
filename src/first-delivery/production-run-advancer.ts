import { createHash } from "node:crypto";

import { AnalysisCoordinator } from "../analysis/analysis-coordinator.js";
import { AnalysisReconciliationRequiredPayloadSchema, type AnalysisBudget } from "../analysis/analysis-contracts.js";
import type { AnalysisAdapterResult, CapsuleBackedAnalysisAdapter } from "../analysis/capsule-analysis-adapter.js";
import type { AnalysisAdapterRequest } from "../analysis/analysis-contracts.js";
import { AttentionService } from "../attention/attention-service.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import type { StoredEvent } from "../contracts/event.js";
import { BoundedTicketIntake } from "../intake/ticket-intake.js";
import { IntakeArtifactStore } from "../intake/intake-artifact-store.js";
import { IntakeSnapshotClosedPayloadSchema } from "../intake/intake-contracts.js";
import { IntakeService } from "../intake/intake-service.js";
import { iterateAllEvents, readStreamEvents, type EventJournal } from "../journal/journal.js";
import { PlanningCoordinator } from "../planning/planning-coordinator.js";
import {
  PlanningProposalSchema,
  buildPlanningArtifact,
  type PlanningCapabilityIdentity,
  type PlanningProposalInput,
} from "../planning/planning-contracts.js";
import type { ProjectConfig } from "../projects/project-config.js";
import type { RunProcess } from "../runs/run-contracts.js";
import type { RunView } from "../runs/run-projection.js";
import { RunService } from "../runs/run-service.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { RunAdvanceRequest, RunAdvancer, RunCancellationNotice, RunScheduleRequest } from "../surfaces/workflow-surface.js";

const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;

export interface FirstDeliveryAnalysisAdapter {
  analyze(request: AnalysisAdapterRequest, signal: AbortSignal): Promise<AnalysisAdapterResult>;
}

export interface FirstDeliveryPlannerRequest {
  readonly run: RunView;
  readonly project: ProjectConfig;
  readonly security: SecuritySheet;
  readonly capabilities: readonly PlanningCapabilityIdentity[];
  readonly analysisEvidence: PlanningProposalInput["analysisEvidence"];
}

export interface FirstDeliveryPlanner {
  plan(request: FirstDeliveryPlannerRequest, signal: AbortSignal): Promise<PlanningProposalInput>;
}

export interface FirstDeliveryConfiguration {
  readonly analysis: FirstDeliveryAnalysisAdapter;
  readonly planner: FirstDeliveryPlanner;
  readonly analysisBudget: AnalysisBudget;
  readonly project: ProjectConfig;
  readonly security: SecuritySheet;
  readonly capabilities: readonly PlanningCapabilityIdentity[];
  readonly approvalExpiresAt: (run: RunView) => string;
}

export interface FirstDeliveryFaultHooks {
  readonly afterAdvanceReserved?: (stage: string, runId: string) => void | Promise<void>;
  readonly beforeAnalysisReservation?: (runId: string) => void | Promise<void>;
  readonly afterAnalysisReservation?: (runId: string) => void | Promise<void>;
  readonly afterAnalysis?: (runId: string) => void | Promise<void>;
  readonly afterPlannerReservation?: (runId: string) => void | Promise<void>;
  readonly afterPlannerObservation?: (runId: string) => void | Promise<void>;
  readonly afterPlanProposed?: (runId: string) => void | Promise<void>;
  readonly afterCancellation?: (runId: string) => void | Promise<void>;
}

export interface ProductionRunAdvancerOptions {
  readonly journal: EventJournal;
  readonly process: RunProcess;
  readonly serviceReadyEventId: string;
  readonly projectRoot: string;
  readonly configuration?: FirstDeliveryConfiguration;
  readonly cleanupTimeoutMs?: number;
  readonly hooks?: FirstDeliveryFaultHooks;
}

interface WriteLease { open: boolean }

interface AdvanceJob {
  readonly runId: string;
  readonly advanceId: string;
  readonly stage: string;
  readonly streamId: string;
}

interface RunActivity {
  readonly runId: string;
  readonly controller: AbortController;
  readonly queue: AdvanceJob[];
  readonly advanceIds: Set<string>;
  readonly leases: Set<WriteLease>;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  running: Promise<void> | null;
  stopped: boolean;
  coordination: Promise<void> | null;
}

class ActivityStoppedError extends Error {}
class LateResultIgnoredError extends Error {}

export class ProductionRunAdvancer implements RunAdvancer {
  private readonly runs: RunService;
  private readonly attention: AttentionService;
  private readonly active = new Map<string, RunActivity>();
  private readonly failures = new Map<string, unknown>();
  private stopping = false;

  private constructor(
    private readonly options: ProductionRunAdvancerOptions,
    private readonly artifacts: IntakeArtifactStore,
  ) {
    this.runs = new RunService(options.journal);
    this.attention = new AttentionService(options.journal);
  }

  static async create(options: ProductionRunAdvancerOptions): Promise<ProductionRunAdvancer> {
    const artifacts = await IntakeArtifactStore.openProject(options.projectRoot);
    if (options.cleanupTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.cleanupTimeoutMs) || options.cleanupTimeoutMs < 1 || options.cleanupTimeoutMs > 60_000)) {
      throw new Error("first-delivery cleanup timeout is invalid");
    }
    if (options.configuration !== undefined) {
      if (options.configuration.project.repositoryPath !== options.projectRoot) {
        throw new Error("first-delivery project configuration does not match the active project root");
      }
      if (!options.configuration.security.allowedRepositories.includes(options.projectRoot)) {
        throw new Error("first-delivery security policy does not authorize the active project root");
      }
    }
    return new ProductionRunAdvancer(options, artifacts);
  }

  schedule(input: RunScheduleRequest): void {
    this.enqueue(input.runId, input.advanceId, input.stage);
  }

  advance(input: RunAdvanceRequest): void {
    this.enqueue(input.runId, input.advanceId, "decision");
  }

  cancel(input: RunCancellationNotice): void {
    const job = this.reserveAdvance(input.runId, input.advanceId, "cancellation");
    if (job === null) return;
    const activity = this.active.get(input.runId) ?? this.createActivity(input.runId);
    if (activity.coordination !== null) return;
    this.stopActivity(activity);
    activity.coordination = this.coordinateStop(activity, job, true);
  }

  async resumeNonterminalRuns(): Promise<void> {
    const runIds = new Set<string>();
    for (const event of iterateAllEvents(this.options.journal)) {
      if (event.type === "run.accepted" && event.streamId.startsWith("run:")) runIds.add(event.streamId.slice(4));
    }
    for (const runId of [...runIds].sort()) {
      let run = this.runs.get(runId);
      if (run === null || run.lifecycle === "terminal" || run.lifecycle === "approved_and_ready_for_execution") continue;
      if (JSON.stringify(run.activeProcess) !== JSON.stringify(this.options.process)) {
        run = this.runs.reopenWithProcess(
          runId,
          run.streamVersion,
          `first-delivery-reopen:${this.options.serviceReadyEventId}:${runId}`,
          this.options.process,
          this.options.serviceReadyEventId,
        );
      }
      this.enqueue(runId, digestCanonical({ schemaVersion: 1, runId, serviceReadyEventId: this.options.serviceReadyEventId }), "restart");
    }
    await Promise.all([...this.active.values()].map((item) => item.settled));
  }

  async waitForIdle(runId: string): Promise<void> {
    await this.active.get(runId)?.settled;
    const failure = this.failures.get(runId);
    if (failure !== undefined) throw failure;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const activities = [...this.active.values()];
    for (const activity of activities) {
      if (activity.coordination !== null) continue;
      this.stopActivity(activity);
      activity.coordination = this.coordinateStop(activity, null, false);
    }
    await Promise.all(activities.map((activity) => activity.settled));
  }

  private get cleanupTimeoutMs(): number {
    return this.options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  }

  private enqueue(runId: string, advanceId: string, stage: string): void {
    if (this.stopping) return;
    const job = this.reserveAdvance(runId, advanceId, stage);
    if (job === null) return;
    const activity = this.active.get(runId) ?? this.createActivity(runId);
    if (activity.stopped) return;
    if (activity.advanceIds.has(advanceId)) return;
    activity.advanceIds.add(advanceId);
    activity.queue.push(job);
    this.pump(activity);
  }

  private reserveAdvance(runId: string, advanceId: string, stage: string): AdvanceJob | null {
    const streamId = advanceStreamId(advanceId);
    const existing = readStreamEvents(this.options.journal, streamId);
    if (existing.some((event) => event.type === "first_delivery.advance_completed")) return null;
    if (existing.length === 0) {
      this.options.journal.append(streamId, 0, [{
        streamId,
        type: "first_delivery.advance_reserved",
        correlationId: runId,
        causationId: null,
        payload: { schemaVersion: 1, runId, advanceId, stage, authority: "none" },
      }]);
    } else {
      const payload = object(existing[0]!.payload);
      if (payload["runId"] !== runId || payload["advanceId"] !== advanceId || payload["stage"] !== stage) {
        throw new Error("first-delivery advance identity was reused with different input");
      }
    }
    return { runId, advanceId, stage, streamId };
  }

  private createActivity(runId: string): RunActivity {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const activity: RunActivity = {
      runId, controller: new AbortController(), queue: [], advanceIds: new Set(), leases: new Set(), settled,
      resolveSettled, running: null, stopped: false, coordination: null,
    };
    this.active.set(runId, activity);
    return activity;
  }

  private pump(activity: RunActivity): void {
    if (activity.running !== null || activity.stopped) return;
    const job = activity.queue.shift();
    if (job === undefined) {
      activity.resolveSettled();
      if (this.active.get(activity.runId) === activity) this.active.delete(activity.runId);
      return;
    }
    const lease = { open: true };
    activity.leases.add(lease);
    const journal = guardedJournal(this.options.journal, lease);
    const operation = this.runJob(job, activity, journal, lease)
      .catch((error: unknown) => {
        if (!(error instanceof ActivityStoppedError) && !(error instanceof LateResultIgnoredError)) {
          this.failures.set(activity.runId, error);
        }
      })
      .finally(() => {
        lease.open = false;
        activity.leases.delete(lease);
        activity.running = null;
        if (!activity.stopped) this.pump(activity);
      });
    activity.running = operation;
  }

  private async runJob(job: AdvanceJob, activity: RunActivity, journal: EventJournal, lease: WriteLease): Promise<void> {
    const timeout = AbortSignal.timeout(this.options.configuration?.analysisBudget.maxDurationMs ?? this.cleanupTimeoutMs);
    const signal = AbortSignal.any([activity.controller.signal, timeout]);
    const work = (async () => {
      await this.options.hooks?.afterAdvanceReserved?.(job.stage, job.runId);
      await this.advanceRun(job.runId, signal, journal);
    })();
    try {
      await untilStopped(work, signal);
    } catch (error) {
      if (!(error instanceof ActivityStoppedError)) throw error;
      lease.open = false;
      if (!activity.stopped && !this.stopping) await this.retainUncertainty(job.runId);
      throw error;
    }
    if (!lease.open || signal.aborted || activity.stopped || this.stopping) throw new ActivityStoppedError();
    this.failures.delete(job.runId);
    this.completeAdvance(job);
  }

  private completeAdvance(job: AdvanceJob): void {
    const events = readStreamEvents(this.options.journal, job.streamId);
    if (events.some((event) => event.type === "first_delivery.advance_completed")) return;
    this.options.journal.append(job.streamId, events.length, [{
      streamId: job.streamId, type: "first_delivery.advance_completed", correlationId: job.runId,
      causationId: events[0]!.eventId,
      payload: { schemaVersion: 1, runId: job.runId, advanceId: job.advanceId, authority: "none" },
    }]);
  }

  private stopActivity(activity: RunActivity): void {
    activity.stopped = true;
    activity.controller.abort();
    activity.queue.length = 0;
    for (const lease of activity.leases) lease.open = false;
  }

  private async coordinateStop(activity: RunActivity, cancellation: AdvanceJob | null, cancelled: boolean): Promise<void> {
    if (activity.running !== null) await bounded(activity.running, this.cleanupTimeoutMs);
    await this.retainUncertainty(activity.runId);
    if (cancelled) {
      await this.settleCancellation(activity.runId);
      if (cancellation !== null) this.completeAdvance(cancellation);
      await this.options.hooks?.afterCancellation?.(activity.runId);
    }
    activity.resolveSettled();
  }

  private async advanceRun(runId: string, signal: AbortSignal, journal: EventJournal): Promise<void> {
    let run = this.requireRun(runId);
    if (run.lifecycle === "terminal") {
      if (run.terminalOutcome === "cancelled") await this.settleCancellation(runId);
      return;
    }
    if (run.lifecycle === "approved_and_ready_for_execution") return;
    if (run.lifecycle === "waiting" || run.lifecycle === "blocked") {
      if (run.suspendedFrom === "intake") {
        if (this.closedIntake(runId) === null) return;
        run = this.runs.resume(runId, run.streamVersion, `first-delivery-resume-intake:${runId}:${run.streamVersion}`);
      } else if (run.suspendedFrom === "analyzing" || run.suspendedFrom === "planning") {
        const pending = this.attention.poll(runId).some((item) => item.material && item.status === "pending");
        const unavailable = this.options.configuration === undefined;
        if (!pending && !unavailable) run = this.runs.resume(runId, run.streamVersion, `first-delivery-resume:${runId}:${run.streamVersion}`);
        else return;
      } else return;
    }
    if (run.lifecycle === "accepted" || run.lifecycle === "preflighting") {
      this.runs.wait(runId, run.streamVersion, `first-delivery-intake-replay:${runId}:${run.streamVersion}`, "first_delivery_intake_replay_required");
      return;
    }
    if (run.lifecycle === "intake") {
      const intake = this.closedIntake(runId);
      if (intake === null) {
        this.runs.wait(runId, run.streamVersion, `first-delivery-intake-incomplete:${runId}:${run.streamVersion}`, "first_delivery_intake_replay_required");
        return;
      }
      run = this.runs.completeIntake(runId, run.streamVersion, `first-delivery-intake-complete:${intake.closureEventId}`, intake);
    }
    if (run.lifecycle === "analyzing") {
      if (this.options.configuration === undefined) {
        this.runs.wait(runId, run.streamVersion, `first-delivery-unconfigured-analysis:${runId}`, "first_delivery_analysis_not_configured");
        return;
      }
      const analysis = this.createAnalysisCoordinator(journal, runId);
      const result = await analysis.advance({ runId, budget: this.options.configuration.analysisBudget, signal });
      await this.options.hooks?.afterAnalysis?.(runId);
      if (result.status !== "completed") return;
      run = this.requireRun(runId);
    }
    if (run.lifecycle === "planning") await this.plan(run, signal, journal);
  }

  private async plan(run: RunView, signal: AbortSignal, journal: EventJournal): Promise<void> {
    const configuration = this.options.configuration;
    if (configuration === undefined) {
      this.runs.wait(run.runId, run.streamVersion, `first-delivery-unconfigured-planner:${run.runId}`, "first_delivery_planner_not_configured");
      return;
    }
    const analysis = journal.readStream(`analysis:${run.runId}`).findLast((event) => event.type === "analysis.completed");
    if (analysis === undefined) throw new Error("first-delivery planning requires completed analysis evidence");
    const analysisPayload = object(analysis.payload);
    const evidence = {
      analysisStreamId: analysis.streamId,
      completionEventId: analysis.eventId,
      evidenceSha256: string(analysisPayload, "evidenceSha256"),
      sourceEvidenceSha256: string(analysisPayload, "sourceEvidenceSha256"),
    };
    const streamId = plannerStreamId(run.runId);
    let events = readStreamEvents(journal, streamId);
    let proposal: PlanningProposalInput;
    let metadata: { readonly decisionId: string; readonly attentionId: string; readonly expiresAt: string };
    const observed = events.find((event) => event.type === "first_delivery.planner_observed");
    if (observed !== undefined) {
      const payload = object(observed.payload);
      proposal = proposalInput(buildPlanningArtifact(
        payload["proposal"] as PlanningProposalInput,
        run.budget,
        1,
      ).proposal);
      metadata = {
        decisionId: string(payload, "decisionId"),
        attentionId: string(payload, "attentionId"),
        expiresAt: string(payload, "expiresAt"),
      };
    } else {
      const reservation = events.find((event) => event.type === "first_delivery.planner_reserved");
      if (reservation !== undefined) {
        this.ensurePlannerReconciliation(run.runId, events, reservation, journal);
        this.waitIfActive(run.runId, "first_delivery_planner_reconciliation_required");
        return;
      }
      const requestSha256 = digestCanonical({ runId: run.runId, evidence, projectRevision: run.projectRevision });
      const stored = journal.append(streamId, 0, [{
        streamId,
        type: "first_delivery.planner_reserved",
        correlationId: run.runId,
        causationId: analysis.eventId,
        payload: { schemaVersion: 1, runId: run.runId, requestSha256, authority: "none" },
      }]);
      events = stored;
      await this.options.hooks?.afterPlannerReservation?.(run.runId);
      let planned: PlanningProposalInput;
      try {
        planned = await configuration.planner.plan({
          run,
          project: configuration.project,
          security: configuration.security,
          capabilities: configuration.capabilities,
          analysisEvidence: evidence,
        }, signal);
      } catch (error) {
        const currentEvents = readStreamEvents(journal, streamId);
        this.ensurePlannerReconciliation(run.runId, currentEvents, currentEvents[0]!, journal);
        this.waitIfActive(run.runId, "first_delivery_planner_reconciliation_required");
        throw error;
      }
      const artifact = buildPlanningArtifact(planned, run.budget, 1);
      proposal = proposalInput(artifact.proposal);
      const identity = artifact.planDigest.slice(0, 32);
      metadata = {
        decisionId: `first-delivery-approval:${identity}`,
        attentionId: `first-delivery-attention:${identity}`,
        expiresAt: configuration.approvalExpiresAt(run),
      };
      const appended = journal.append(streamId, events.length, [{
        streamId,
        type: "first_delivery.planner_observed",
        correlationId: run.runId,
        causationId: events[0]!.eventId,
        payload: { schemaVersion: 1, runId: run.runId, proposal, ...metadata, authority: "none" },
      }]);
      events = [...events, ...appended];
      await this.options.hooks?.afterPlannerObservation?.(run.runId);
    }
    const guardedRuns = new RunService(journal);
    new PlanningCoordinator(journal, guardedRuns, new AttentionService(journal), configuration.capabilities).propose({
      proposal,
      project: configuration.project,
      security: configuration.security,
      ...metadata,
      commandId: `first-delivery-plan:${digestCanonical(proposal).slice(0, 32)}`,
    });
    await this.options.hooks?.afterPlanProposed?.(run.runId);
  }

  private async settleCancellation(runId: string): Promise<void> {
    const analysisEvents = this.options.journal.readStream(`analysis:${runId}`);
    const analysisCompleted = analysisEvents.some((event) => event.type === "analysis.completed");
    if (!analysisCompleted && this.options.configuration !== undefined) {
      const controller = new AbortController();
      controller.abort();
      const lease = { open: true };
      const analysis = this.createAnalysisCoordinator(guardedJournal(this.options.journal, lease), runId);
      try {
        await bounded(analysis.advance({ runId, budget: this.options.configuration.analysisBudget, signal: controller.signal }), this.cleanupTimeoutMs);
      } finally {
        lease.open = false;
      }
    }
  }

  private async retainUncertainty(runId: string): Promise<void> {
    let uncertainty = false;
    const analysisEvents = readStreamEvents(this.options.journal, `analysis:${runId}`);
    const reservation = analysisEvents.findLast((event) => event.type === "analysis.invocation_reserved");
    if (reservation !== undefined) {
      const settled = analysisEvents.some((event) => event.streamVersion > reservation.streamVersion &&
        (event.type === "analysis.observed" || event.type === "analysis.cancelled" ||
          event.type === "analysis.timed_out" || event.type === "analysis.failed" ||
          event.type === "analysis.reconciliation_required"));
      if (!settled) {
        uncertainty = true;
        const payload = AnalysisReconciliationRequiredPayloadSchema.parse({
          schemaVersion: 1, runId, reservationEventId: reservation.eventId,
          reason: "capsule_uncertain", capsuleOutcome: "uncertain", cleanup: "uncertain", effectState: "uncertain",
          usage: zeroUsage(), evidenceSha256: digestCanonical({ runId, reservationEventId: reservation.eventId, reason: "activity_stopped" }),
          commandId: `first-delivery-reconcile:${reservation.eventId}`, authority: "none",
        });
        try {
          this.options.journal.append(`analysis:${runId}`, analysisEvents.length, [{
            streamId: `analysis:${runId}`, type: "analysis.reconciliation_required", correlationId: runId,
            causationId: reservation.eventId, payload,
          }]);
        } catch (error) {
          const replay = readStreamEvents(this.options.journal, `analysis:${runId}`);
          if (!replay.some((event) => event.type === "analysis.reconciliation_required")) throw error;
        }
      }
    }
    const plannerEvents = readStreamEvents(this.options.journal, plannerStreamId(runId));
    const plannerReservation = plannerEvents.find((event) => event.type === "first_delivery.planner_reserved");
    if (plannerReservation !== undefined && !plannerEvents.some((event) =>
      event.type === "first_delivery.planner_observed" || event.type === "first_delivery.planner_reconciliation_required")) {
      uncertainty = true;
      this.ensurePlannerReconciliation(runId, plannerEvents, plannerReservation, this.options.journal);
    }
    if (uncertainty) {
      this.waitIfActive(runId, plannerReservation === undefined
        ? "first_delivery_analysis_reconciliation_required"
        : "first_delivery_planner_reconciliation_required");
    }
  }

  private createAnalysisCoordinator(journal: EventJournal, runId: string): AnalysisCoordinator {
    const configuration = this.options.configuration;
    if (configuration === undefined) throw new Error("first-delivery analysis is not configured");
    const runs = new RunService(journal);
    return new AnalysisCoordinator(
      journal,
      runs,
      new AttentionService(journal),
      new IntakeService(journal, runs, new BoundedTicketIntake(), this.artifacts),
      configuration.analysis as CapsuleBackedAnalysisAdapter,
      {
        beforeReservation: () => this.options.hooks?.beforeAnalysisReservation?.(runId),
        afterReservation: () => this.options.hooks?.afterAnalysisReservation?.(runId),
      },
    );
  }

  private ensurePlannerReconciliation(
    runId: string,
    events: readonly StoredEvent[],
    reservation: StoredEvent,
    journal: EventJournal,
  ): void {
    if (events.some((event) => event.type === "first_delivery.planner_reconciliation_required")) return;
    journal.append(plannerStreamId(runId), events.length, [{
      streamId: plannerStreamId(runId),
      type: "first_delivery.planner_reconciliation_required",
      correlationId: runId,
      causationId: reservation.eventId,
      payload: {
        schemaVersion: 1,
        runId,
        reservationEventId: reservation.eventId,
        reason: "planner_result_uncertain",
        authority: "none",
      },
    }]);
  }

  private waitIfActive(runId: string, reason: string): void {
    const run = this.requireRun(runId);
    if (run.lifecycle !== "waiting" && run.lifecycle !== "blocked" && run.lifecycle !== "terminal") {
      this.runs.wait(runId, run.streamVersion, `first-delivery-wait:${reason}:${run.streamVersion}`, reason);
    }
  }

  private closedIntake(runId: string) {
    const streamId = `source-intake:${createHash("sha256").update(runId).digest("hex")}`;
    const closure = readStreamEvents(this.options.journal, streamId).findLast((event) => event.type === "intake.snapshot_closed");
    if (closure === undefined) return null;
    const payload = IntakeSnapshotClosedPayloadSchema.parse(closure.payload);
    return {
      sourceStreamId: streamId,
      closureEventId: closure.eventId,
      snapshotSha256: payload.snapshotSha256,
      sourceCount: payload.sourceCount,
      rejectedCount: payload.rejectedCount,
      totalBytes: payload.totalBytes,
    };
  }

  private requireRun(runId: string): RunView {
    const run = this.runs.get(runId);
    if (run === null) throw new Error(`run ${runId} not found`);
    return run;
  }
}

function advanceStreamId(advanceId: string): string {
  return `first-delivery-advance:${createHash("sha256").update(advanceId).digest("hex")}`;
}

function plannerStreamId(runId: string): string {
  return `first-delivery-planner:${createHash("sha256").update(runId).digest("hex")}`;
}

function proposalInput(value: unknown): PlanningProposalInput {
  const proposal = PlanningProposalSchema.parse(value);
  const { schemaVersion: _schemaVersion, revision: _revision, executionAuthority: _executionAuthority, ...input } = proposal;
  return input;
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("first-delivery evidence payload is invalid");
  return value as Readonly<Record<string, unknown>>;
}

function string(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field === "") throw new Error(`first-delivery evidence ${key} is invalid`);
  return field;
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<void> {
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function untilStopped<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ActivityStoppedError();
  let stop!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new ActivityStoppedError());
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    signal.removeEventListener("abort", stop);
    void promise.catch(() => undefined);
  }
}

function guardedJournal(journal: EventJournal, lease: WriteLease): EventJournal {
  return new Proxy(journal as EventJournal & Record<PropertyKey, unknown>, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "append" || property === "appendAtomically") {
        return (...args: unknown[]) => {
          if (!lease.open) throw new LateResultIgnoredError("late first-delivery result ignored");
          return Reflect.apply(value as (...input: unknown[]) => unknown, target, args);
        };
      }
      return (value as (...input: unknown[]) => unknown).bind(target);
    },
  }) as EventJournal;
}

function zeroUsage() {
  return {
    inputTokens: 0, outputTokens: 0, inputBytes: 0, outputBytes: 0, durationMs: 0, costUsdNano: 0,
    modelReceiptSha256: createHash("sha256").update("first-delivery-no-receipt").digest("hex"),
  };
}
