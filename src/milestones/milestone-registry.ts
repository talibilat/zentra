import { realpathSync, statSync } from "node:fs";

import type { NewEvent, StoredEvent } from "../contracts/event.js";
import {
  admissionPacketDigest,
  createAuthorityAttention,
  createOpenCodeAdmissionPacket,
  digestCanonical,
  OpenCodeTaskAdmissionContextSchema,
  PlanReplacementPayloadSchema,
  type OpenCodeAdmissionPacket,
  type OpenCodeTaskAdmissionContext,
} from "../contracts/authority-attention.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { ModelSheet } from "../policy/model-sheet.js";
import type { EventJournal } from "../journal/journal.js";
import { projectMilestone, type MilestoneView } from "./milestone-projection.js";
import { assessMilestonePlanReadiness } from "./plan-readiness.js";
import {
  capabilitySupportsAdmission,
  capabilitySnapshot,
  createMilestoneAuthorityEnvelope,
  createReplanningPolicyBinding,
  createReplanningAttention,
  MilestoneAuthorityEnvelopePayloadSchema,
  PlanRevisionPayloadSchema,
  RevisionEvidenceReferenceSchema,
  revisionBoundaryViolation,
  type ReplanningAttention,
  type ReplanningReason,
  type RevisionEvidenceReference,
} from "../contracts/replanning.js";
import {
  MilestoneCompletedPayloadSchema,
  MilestonePlanSchema,
  WriterBatchStartedPayloadSchema,
  WriterIntegrationCompletedPayloadSchema,
  WriterTerminalReleasedPayloadSchema,
  type MilestonePlan,
  type MilestoneRole,
  type VerifiedMilestoneIntegrationEvidence,
  type WriterBatchClaim,
} from "../contracts/milestone.js";
import type { TerminalOutcome } from "../contracts/task.js";
import { modelSheetSha256 } from "../routing/model-router.js";
import { projectTask } from "../tasks/task-projection.js";
import { ReviewDecisionSchema } from "../reviews/reviewer-adapter.js";
import { canonicalValidationDigest } from "../reviews/reviewer-adapter.js";
import { ValidationReportSchema } from "../capabilities/validation-runner.js";
import { artifactEvidenceSha256, projectArtifacts } from "../contracts/artifact.js";

export interface RegisterMilestoneInput {
  readonly milestoneId: string;
  readonly projectId: string;
  readonly title: string;
  readonly correlationId: string;
  readonly tracePath?: string;
  readonly plan?: MilestonePlan;
  readonly authority?: {
    readonly security: SecuritySheet;
    readonly modelSheet?: ModelSheet;
  };
}

export interface MilestoneSummary {
  readonly milestoneId: string;
  readonly projectId: string;
  readonly title: string;
  readonly lifecycle: MilestoneView["lifecycle"];
  readonly terminalOutcome: MilestoneView["terminalOutcome"];
  readonly streamVersion: number;
  readonly traceId: string;
  readonly tracePath: string | null;
  readonly taskCount: number;
}

export interface MilestoneRecord extends MilestoneView {
  readonly traceId: string;
  readonly tracePath: string | null;
}

export interface StartWriterBatchInput {
  readonly batchId: string;
  readonly maxConcurrentWriters: number;
  readonly writers: readonly WriterBatchClaim[];
}

export type TaskAdmissionResult =
  | {
    readonly status: "admitted";
    readonly milestone: MilestoneRecord;
    readonly admission: { readonly packet: OpenCodeAdmissionPacket; readonly digest: string };
  }
  | { readonly status: "paused"; readonly milestone: MilestoneRecord; readonly attention: NonNullable<MilestoneRecord["attention"]> };

export type { OpenCodeTaskAdmissionContext };

export interface ReplaceMilestonePlanInput {
  readonly milestoneId: string;
  readonly attentionId: string;
  readonly priorPlanDigest: string;
  readonly priorSecurityDigest: string;
  readonly replacementPlan: MilestonePlan;
}

export interface ReviseMilestonePlanInput {
  readonly revisionId: string;
  readonly milestoneId: string;
  readonly priorPlanDigest: string;
  readonly candidatePlan: MilestonePlan;
  readonly security: SecuritySheet;
  readonly modelSheet?: ModelSheet;
  readonly requestedBy: string;
  readonly evidence: readonly RevisionEvidenceReference[];
  readonly linkedTaskStreamIds: readonly string[];
  readonly supersessions?: readonly { readonly priorTaskId: string; readonly replacementTaskId: string }[];
}

export interface ResolveReplanningInput {
  readonly milestoneId: string;
  readonly attentionId: string;
  readonly priorPlanDigest: string;
  readonly candidateDigest: string;
  readonly pauseEventId: string;
  readonly pauseStreamVersion: number;
  readonly decisionId: string;
  readonly decidedBy: string;
  readonly action: "abandon_candidate";
}

export type PlanRevisionResult =
  | { readonly status: "accepted"; readonly milestone: MilestoneRecord; readonly revision: NonNullable<MilestoneView["revisions"][number]>; readonly traceProjectionFailed: boolean }
  | { readonly status: "paused"; readonly milestone: MilestoneRecord; readonly attention: ReplanningAttention; readonly traceProjectionFailed: boolean };

export class MilestoneRegistry {
  constructor(private readonly journal: EventJournal) {}

  register(input: RegisterMilestoneInput): MilestoneView {
    const existing = this.inspect(input.milestoneId);
    if (existing !== null) throw new Error(`milestone ${input.milestoneId} already exists`);
    if (input.authority !== undefined && input.plan === undefined) {
      throw new Error("milestone authority requires an accepted baseline plan");
    }
    const events: NewEvent<string, unknown>[] = [{
      streamId: input.milestoneId,
      type: "milestone.created",
      payload: canonicalPayload({
        projectId: input.projectId,
        title: input.title,
        ...(input.tracePath === undefined ? {} : { tracePath: input.tracePath }),
      }),
      causationId: null,
      correlationId: input.correlationId,
    }];
    if (input.plan !== undefined) {
      events.push({
        streamId: input.milestoneId,
        type: "milestone.plan_created",
        payload: canonicalPayload({ plan: input.plan }),
        causationId: null,
        correlationId: input.correlationId,
      });
      if (input.authority !== undefined) {
        const policy = createReplanningPolicyBinding({
          milestoneId: input.milestoneId,
          projectId: input.projectId,
          security: input.authority.security,
          ...(input.authority.modelSheet === undefined ? {} : { modelSheet: input.authority.modelSheet }),
        });
        events.push({
          streamId: input.milestoneId,
          type: "milestone.replanning_policy_bound",
          payload: canonicalPayload({ policy }),
          causationId: null,
          correlationId: input.correlationId,
        });
        events.push({
          streamId: input.milestoneId,
          type: "milestone.authority_envelope_established",
          payload: canonicalPayload(MilestoneAuthorityEnvelopePayloadSchema.parse({
            envelope: createMilestoneAuthorityEnvelope({
              plan: input.plan,
              security: input.authority.security,
              ...(input.authority.modelSheet === undefined ? {} : { modelSheet: input.authority.modelSheet }),
            }),
          })),
          causationId: null,
          correlationId: input.correlationId,
        });
      }
    }
    projectMilestone(events.map((event, index) => ({
      ...event,
      eventId: "",
      streamVersion: index + 1,
      globalPosition: 0,
      recordedAt: "2026-01-01T00:00:00.000Z",
    })));
    const stored = this.journal.append(input.milestoneId, 0, events);
    const view = projectMilestone(stored);
    if (view === null) throw new Error("projection should not be null after milestone registration");
    return withTrace(view, stored);
  }

  list(): readonly MilestoneSummary[] {
    const streamIds = new Set<string>();
    for (const event of this.journal.readAll()) {
      if (event.type.startsWith("milestone.")) streamIds.add(event.streamId);
    }
    return Object.freeze([...streamIds].sort().map((streamId) => {
      const events = this.journal.readStream(streamId);
      const view = projectMilestone(events);
      if (view === null) throw new Error(`milestone ${streamId} has no view`);
      verifyStoredCompletion(this.journal, events, view);
      assertWriterClaimProvenance(view, Object.values(view.writerOwnership));
      return Object.freeze({
        milestoneId: view.milestoneId,
        projectId: view.projectId,
        title: view.title,
        lifecycle: view.lifecycle,
        terminalOutcome: view.terminalOutcome,
        streamVersion: view.streamVersion,
        traceId: events[0]!.correlationId,
        tracePath: tracePathFrom(events[0]!),
        taskCount: view.plan?.tasks.length ?? 0,
      });
    }));
  }

  admitTask(
    milestoneId: string,
    taskId: string,
    security: SecuritySheet,
    rawContext: OpenCodeTaskAdmissionContext,
    modelSheet?: ModelSheet,
  ): TaskAdmissionResult {
    const context = OpenCodeTaskAdmissionContextSchema.parse(rawContext);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const events = this.journal.readStream(milestoneId);
      const view = projectMilestone(events);
      if (view === null) throw new Error(`milestone ${milestoneId} does not exist`);
      const canonicalRepository = canonicalDirectory(context.repositoryPath);
      const packet = createOpenCodeAdmissionPacket({
        plan: view.plan,
        milestoneId,
        taskId,
        security,
        canonicalRepository,
        actorId: context.actorId,
        harness: context.harness,
        role: context.role,
        capabilityId: context.capabilityId,
        transportModelId: context.transportModelId,
        authority: context.authority,
        roles: context.roles,
        toolPermissions: context.toolPermissions,
        network: context.network,
        contextTokens: context.contextTokens,
        requestedBudget: context.requestedBudget,
      });
      const admissionDigest = admissionPacketDigest(packet);
      const decision = assessMilestonePlanReadiness({
        plan: view.plan,
        taskId,
        security,
        packet,
        context,
      });
      const plannedTask = view.plan?.tasks.find((candidate) => candidate.taskId === taskId);
      const pinned = view.authorityEnvelope;
      const currentPolicy = pinned === null ? null : createReplanningPolicyBinding({
        milestoneId: view.milestoneId,
        projectId: view.projectId,
        security,
        ...(modelSheet === undefined ? {} : { modelSheet }),
      });
      const modelBoundaryValid = pinned === null || plannedTask === undefined || (
        currentPolicy?.securityDigest === pinned.securityDigest &&
        currentPolicy.modelSheetDigest === pinned.modelSheetDigest &&
        (plannedTask.roleAssignment.harness === "deterministic" || (
          modelSheet !== undefined && capabilitySupportsAdmission(pinned, plannedTask, context) &&
          currentPolicy.modelSheetDigest === pinned.modelSheetDigest
        ))
      );
      const boundedDecision = modelBoundaryValid ? decision : {
        status: "blocked" as const,
        reason: "plan_not_ready" as const,
        attention: createAuthorityAttention({
          packet,
          reason: "plan_not_ready",
          classification: "hard_stop",
          configuredStopCondition: security.stopAndAskConditions.includes("plan_not_ready"),
        }),
      };
      if (view.lifecycle === "paused") {
        if (view.attention !== null && boundedDecision.attention?.attentionId === view.attention.attentionId) {
          return Object.freeze({ status: "paused", milestone: withTrace(view, events), attention: view.attention });
        }
        throw new Error(`milestone ${milestoneId} is paused`);
      }
      const task = view.plan?.tasks.find((candidate) => candidate.taskId === taskId);
      const current = view.tasks[taskId];
      if (view.plan !== null && (task === undefined || current === undefined)) {
        throw new Error(`unknown planned task: ${taskId}`);
      }
      if (current?.status === "ready" && boundedDecision.status === "executable") {
        if (current.admissionDigest !== admissionDigest) {
          throw new Error("ready task admission packet does not match the requested execution");
        }
        return Object.freeze({
          status: "admitted",
          milestone: withTrace(view, events),
          admission: Object.freeze({ packet, digest: admissionDigest }),
        });
      }
      if (current !== undefined &&
        current.status !== "planned" &&
        current.status !== "blocked" &&
        !(current.status === "ready" && boundedDecision.status !== "executable")
      ) {
        throw new Error(`planned task ${taskId} cannot be admitted from ${current.status}`);
      }
      for (const dependency of task?.dependencies ?? []) {
        if (view.tasks[dependency]?.terminalOutcome !== "completed") {
          throw new Error(`planned task ${taskId} dependency ${dependency} is not completed successfully`);
        }
      }
      const paused = boundedDecision.attention !== null;
      const nextEvent: NewEvent<string, unknown> = {
        streamId: milestoneId,
        type: paused ? "milestone.paused" : "milestone.task_ready",
        payload: canonicalPayload(paused
          ? { attention: boundedDecision.attention }
          : { taskId, admissionDigest }),
        causationId: null,
        correlationId: events[0]!.correlationId,
      };
      try {
        projectMilestone([...events, candidateStoredEvent(nextEvent, view.streamVersion + 1)]);
        const stored = this.journal.append(milestoneId, view.streamVersion, [nextEvent]);
        const updatedEvents = [...events, ...stored];
        const updated = projectMilestone(updatedEvents);
        if (updated === null) throw new Error("projection should not be null after task admission");
        const milestone = withTrace(updated, updatedEvents);
        return paused
          ? Object.freeze({ status: "paused", milestone, attention: updated.attention! })
          : Object.freeze({
            status: "admitted",
            milestone,
            admission: Object.freeze({ packet, digest: admissionDigest }),
          });
      } catch (error) {
        if (!(error instanceof Error) || !/^expected version \d+, actual \d+$/.test(error.message)) throw error;
      }
    }
    throw new Error("task admission did not converge");
  }

  replacePlan(input: ReplaceMilestonePlanInput): MilestoneRecord {
    const events = this.journal.readStream(input.milestoneId);
    const view = projectMilestone(events);
    if (view === null || view.lifecycle !== "paused" || view.attention === null) {
      throw new Error(`milestone ${input.milestoneId} is not paused`);
    }
    if (
      input.attentionId !== view.attention.attentionId ||
      input.priorPlanDigest !== view.attention.planDigest ||
      input.priorSecurityDigest !== view.attention.policyDigest
    ) throw new Error("paused plan replacement binding is stale");
    const payload = PlanReplacementPayloadSchema.parse({
      schemaVersion: 1,
      milestoneId: input.milestoneId,
      projectId: view.projectId,
      attentionId: input.attentionId,
      priorPlanDigest: input.priorPlanDigest,
      priorSecurityDigest: input.priorSecurityDigest,
      replacementPlan: input.replacementPlan,
    });
    const nextEvent: NewEvent<string, unknown> = {
      streamId: input.milestoneId,
      type: "milestone.plan_replaced",
      payload: canonicalPayload(payload),
      causationId: null,
      correlationId: events[0]!.correlationId,
    };
    projectMilestone([...events, candidateStoredEvent(nextEvent, view.streamVersion + 1)]);
    const stored = this.journal.append(input.milestoneId, view.streamVersion, [nextEvent]);
    const updatedEvents = [...events, ...stored];
    const updated = projectMilestone(updatedEvents);
    if (updated === null) throw new Error("projection should not be null after plan replacement");
    return withTrace(updated, updatedEvents);
  }

  revisePlan(input: ReviseMilestonePlanInput): PlanRevisionResult {
    const candidateDigest = safeCandidateDigest(input.candidatePlan);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const events = this.journal.readStream(input.milestoneId);
      const view = projectMilestone(events);
      if (view === null) throw new Error(`milestone ${input.milestoneId} does not exist`);
      const requestPolicy = createReplanningPolicyBinding({
        milestoneId: view.milestoneId,
        projectId: view.projectId,
        security: input.security,
        ...(input.modelSheet === undefined ? {} : { modelSheet: input.modelSheet }),
      });

      const priorAccepted = view.revisions.find((revision) => revision.revisionId === input.revisionId);
      if (priorAccepted !== undefined) {
        if (
          priorAccepted.priorPlanDigest !== input.priorPlanDigest ||
          priorAccepted.revisedPlanDigest !== candidateDigest ||
          priorAccepted.securityDigest !== requestPolicy.securityDigest ||
          priorAccepted.modelSheetDigest !== requestPolicy.modelSheetDigest ||
          priorAccepted.requestedBy !== input.requestedBy ||
          digestCanonical(priorAccepted.priorEvidence) !== digestCanonical(input.evidence) ||
          digestCanonical(priorAccepted.supersessions) !== digestCanonical(input.supersessions ?? [])
        ) throw new Error("revision identity is already bound to a different candidate");
        return Object.freeze({
          status: "accepted",
          milestone: withTrace(view, events),
          revision: priorAccepted,
          traceProjectionFailed: projectionFailed(this.journal),
        });
      }

      const currentPlanDigest = digestCanonical(view.plan);
      const reason = assessRevision(input, view, events, this.journal, candidateDigest);
      if (view.lifecycle === "paused") {
        const existing = view.replanningAttention;
        if (
          isReplanningAttention(existing) &&
          existing.revisionId === input.revisionId &&
          existing.candidateDigest === candidateDigest &&
          existing.priorPlanDigest === currentPlanDigest &&
          existing.reason === reason
        ) {
          return Object.freeze({
            status: "paused",
            milestone: withTrace(view, events),
            attention: existing,
            traceProjectionFailed: projectionFailed(this.journal),
          });
        }
        throw new Error(`milestone ${input.milestoneId} is paused`);
      }

      const nextEvent: NewEvent<string, unknown> = reason === null
        ? {
          streamId: input.milestoneId,
          type: "milestone.plan_revised",
          payload: canonicalPayload(PlanRevisionPayloadSchema.parse({
            schemaVersion: 1,
            revisionId: input.revisionId,
            revisionNumber: view.revisions.length + 1,
            milestoneId: input.milestoneId,
            projectId: view.projectId,
            priorPlanDigest: input.priorPlanDigest,
            revisedPlanDigest: candidateDigest,
            authorityEnvelopeDigest: digestCanonical(view.authorityEnvelope),
            securityDigest: requestPolicy.securityDigest,
            modelSheetDigest: requestPolicy.modelSheetDigest,
            revisedPlan: input.candidatePlan,
            requestedBy: input.requestedBy,
            priorEvidence: input.evidence,
            supersessions: input.supersessions ?? [],
          })),
          causationId: null,
          correlationId: events[0]!.correlationId,
        }
        : {
          streamId: input.milestoneId,
          type: "milestone.paused",
          payload: canonicalPayload({ attention: createReplanningAttention({
            milestoneId: input.milestoneId,
            revisionId: boundedIdentity(input.revisionId),
            priorPlanDigest: currentPlanDigest,
            candidateDigest,
            reason,
          }) }),
          causationId: null,
          correlationId: events[0]!.correlationId,
        };

      try {
        projectMilestone([...events, candidateStoredEvent(nextEvent, view.streamVersion + 1)]);
        const stored = this.journal.append(input.milestoneId, view.streamVersion, [nextEvent]);
        const updatedEvents = [...events, ...stored];
        const updated = projectMilestone(updatedEvents)!;
        if (reason === null) {
          return Object.freeze({
            status: "accepted",
            milestone: withTrace(updated, updatedEvents),
            revision: updated.revisions.at(-1)!,
            traceProjectionFailed: projectionFailed(this.journal),
          });
        }
        return Object.freeze({
          status: "paused",
          milestone: withTrace(updated, updatedEvents),
          attention: updated.replanningAttention!,
          traceProjectionFailed: projectionFailed(this.journal),
        });
      } catch (error) {
        if (!(error instanceof Error) || !/^expected version \d+, actual \d+$/.test(error.message)) throw error;
      }
    }
    throw new Error("milestone plan revision did not converge");
  }

  resolveReplanning(input: ResolveReplanningInput): MilestoneRecord {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const events = this.journal.readStream(input.milestoneId);
      const view = projectMilestone(events);
      if (view === null) throw new Error(`milestone ${input.milestoneId} does not exist`);
      const prior = view.replanningResolutions.find((resolution) => resolution.decisionId === input.decisionId);
      if (prior !== undefined) {
        if (view.lifecycle === "paused") throw new Error("replanning decision identity is already bound");
        if (digestCanonical(prior) !== digestCanonical({ schemaVersion: 1, ...input })) {
          throw new Error("replanning decision identity is already bound");
        }
        return withTrace(view, events);
      }
      const attention = view.replanningAttention;
      const occurrence = view.replanningPauseOccurrence;
      if (view.lifecycle !== "paused" || attention === null || input.attentionId !== attention.attentionId ||
        occurrence === null || input.pauseEventId !== occurrence.eventId || input.pauseStreamVersion !== occurrence.streamVersion ||
        input.priorPlanDigest !== attention.priorPlanDigest || input.candidateDigest !== attention.candidateDigest) {
        throw new Error("replanning resolution binding is stale");
      }
      const nextEvent: NewEvent<string, unknown> = {
        streamId: input.milestoneId,
        type: "milestone.replanning_resolved",
        payload: canonicalPayload({ schemaVersion: 1, ...input }),
        causationId: null,
        correlationId: events[0]!.correlationId,
      };
      try {
        projectMilestone([...events, candidateStoredEvent(nextEvent, view.streamVersion + 1)]);
        const stored = this.journal.append(input.milestoneId, view.streamVersion, [nextEvent]);
        return withTrace(projectMilestone([...events, ...stored])!, [...events, ...stored]);
      } catch (error) {
        if (!(error instanceof Error) || !/^expected version \d+, actual \d+$/.test(error.message)) throw error;
      }
    }
    throw new Error("replanning resolution did not converge");
  }

  startTask(milestoneId: string, taskId: string, actorId: string, role: MilestoneRole): MilestoneRecord {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const events = this.journal.readStream(milestoneId);
      const view = projectMilestone(events);
      if (view === null) throw new Error(`milestone ${milestoneId} does not exist`);
      const task = view.plan?.tasks.find((candidate) => candidate.taskId === taskId);
      if (task === undefined || task.roleAssignment.agentId !== actorId || task.roleAssignment.role !== role) {
        throw new Error(`planned task ${taskId} actor contradicts its assignment`);
      }
      const current = view.tasks[taskId];
      if (current?.status === "running" || current?.status === "completed") return withTrace(view, events);
      if (current?.status !== "ready") throw new Error(`planned task ${taskId} is not ready`);
      const appended = this.tryAppendTransition(events, view, "milestone.task_running", { taskId, actorId, role });
      if (appended !== null) return appended;
    }
    throw new Error("task start did not converge");
  }

  startWriterBatch(milestoneId: string, input: StartWriterBatchInput): MilestoneRecord {
    const payload = WriterBatchStartedPayloadSchema.parse({ schemaVersion: 1, ...input });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const events = this.journal.readStream(milestoneId);
      const view = projectMilestone(events);
      if (view === null) throw new Error(`milestone ${milestoneId} does not exist`);
      assertWriterClaimProvenance(view, payload.writers);
      const nextEvent: NewEvent<string, unknown> = {
        streamId: milestoneId,
        type: "milestone.writer_batch_started",
        payload: canonicalPayload(payload),
        causationId: null,
        correlationId: events[0]!.correlationId,
      };
      try {
        projectMilestone([...events, candidateStoredEvent(nextEvent, view.streamVersion + 1)]);
        const stored = this.journal.append(milestoneId, view.streamVersion, [nextEvent]);
        const updatedEvents = [...events, ...stored];
        return withTrace(projectMilestone(updatedEvents)!, updatedEvents);
      } catch (error) {
        if (!(error instanceof Error) || !/^expected version \d+, actual \d+$/.test(error.message)) throw error;
      }
    }
    throw new Error("writer batch claim did not converge");
  }

  completeTask(
    milestoneId: string,
    taskId: string,
    outcome: TerminalOutcome,
    evidence: Readonly<Record<string, unknown>> = {},
  ): MilestoneRecord {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const events = this.journal.readStream(milestoneId);
      const view = projectMilestone(events);
      if (view === null) throw new Error(`milestone ${milestoneId} does not exist`);
      const task = view.plan?.tasks.find((candidate) => candidate.taskId === taskId);
      if (task === undefined) throw new Error(`unknown planned task: ${taskId}`);
      const current = view.tasks[taskId];
      if (current?.status === "completed") {
        if (current.terminalOutcome !== outcome) throw new Error(`planned task ${taskId} completed with another outcome`);
        return withTrace(view, events);
      }
      if (current?.status !== "running") throw new Error(`planned task ${taskId} is not running`);
      const appended = this.tryAppendTransition(events, view, "milestone.task_completed", {
        taskId,
        actorId: task.roleAssignment.agentId,
        role: task.roleAssignment.role,
        outcome,
        evidence,
      });
      if (appended !== null) return appended;
    }
    throw new Error("task completion did not converge");
  }

  finish(
    milestoneId: string,
    outcome: TerminalOutcome,
    evidence: Readonly<Record<string, unknown>> = {},
  ): MilestoneRecord {
    if (outcome === "completed") throw new Error("use completeIntegrated for successful milestone completion");
    return this.appendTransition(milestoneId, `milestone.${outcome}`, { outcome, evidence });
  }

  completeIntegrated(milestoneId: string, taskStreamId: string): MilestoneRecord {
    const milestoneEvents = this.journal.readStream(milestoneId);
    let milestone = projectMilestone(milestoneEvents);
    if (milestone === null) throw new Error(`milestone ${milestoneId} does not exist`);
    const singletonWriter = milestone.plan?.tasks.find((planned) => planned.taskId === taskStreamId);
    const pairedReviewer = milestone.plan?.tasks.find((planned) =>
      planned.roleAssignment.role === "reviewer" && planned.dependencies.includes(taskStreamId));
    if (singletonWriter === undefined || pairedReviewer === undefined) {
      throw new Error("integration evidence requires one planned writer-reviewer pair");
    }
    const evidence = verifiedIntegrationEvidence(
      this.journal,
      milestoneEvents,
      milestone,
      taskStreamId,
      true,
      pairedReviewer.roleAssignment.agentId,
    );
    const runningReviewer = milestone.plan?.tasks.find((planned) =>
      planned.roleAssignment.role === "reviewer" && milestone!.tasks[planned.taskId]?.status === "running");
    if (runningReviewer !== undefined) {
      this.completeTask(milestoneId, runningReviewer.taskId, "completed", evidence);
      milestone = this.requireMilestone(milestoneId);
    }
    if (milestone.plan?.tasks.some((planned) => milestone!.tasks[planned.taskId]?.terminalOutcome !== "completed")) {
      throw new Error("successful milestone completion requires all planned tasks completed");
    }
    return this.appendTransition(milestoneId, "milestone.completed", {
      outcome: "completed",
      evidence,
    });
  }

  completeWriterIntegration(milestoneId: string, writerTaskId: string): MilestoneRecord {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const events = this.journal.readStream(milestoneId);
      const milestone = projectMilestone(events);
      if (milestone === null) throw new Error(`milestone ${milestoneId} does not exist`);
      const ownership = milestone.writerOwnership[writerTaskId];
      if (ownership === undefined) throw new Error(`writer ${writerTaskId} has no ownership claim`);
      if (ownership.status === "integrated") {
        verifyStoredWriterIntegrations(this.journal, events, milestone);
        return withTrace(milestone, events);
      }
      const reviewer = milestone.plan?.tasks.find((task) => task.taskId === ownership.reviewerTaskId);
      const reviewerState = reviewer === undefined ? undefined : milestone.tasks[reviewer.taskId];
      if (reviewer === undefined || (reviewerState?.status !== "running" && reviewerState?.status !== "completed")) {
        throw new Error(`paired reviewer ${ownership.reviewerTaskId} is not running or completed`);
      }
      if (reviewerState.terminalOutcome !== null && reviewerState.terminalOutcome !== "completed") {
        throw new Error(`paired reviewer ${ownership.reviewerTaskId} did not complete successfully`);
      }
      const evidence = verifiedIntegrationEvidence(
        this.journal,
        events,
        milestone,
        writerTaskId,
        false,
        reviewer.roleAssignment.agentId,
      );
      const next: NewEvent<string, unknown>[] = [];
      if (reviewerState.status === "running") {
        next.push(this.newMilestoneEvent(events, milestoneId, "milestone.task_completed", {
          taskId: reviewer.taskId,
          actorId: reviewer.roleAssignment.agentId,
          role: reviewer.roleAssignment.role,
          outcome: "completed",
          evidence,
        }));
      }
      next.push(this.newMilestoneEvent(events, milestoneId, "milestone.writer_integration_completed",
        WriterIntegrationCompletedPayloadSchema.parse({
          schemaVersion: 1,
          batchId: ownership.batchId,
          writerTaskId,
          reviewerTaskId: reviewer.taskId,
          evidence,
        })));
      const candidates = next.map((event, index) =>
        candidateStoredEvent(event, milestone.streamVersion + index + 1));
      projectMilestone([...events, ...candidates]);
      try {
        const stored = this.journal.append(milestoneId, milestone.streamVersion, next);
        const updatedEvents = [...events, ...stored];
        return withTrace(projectMilestone(updatedEvents)!, updatedEvents);
      } catch (error) {
        if (!(error instanceof Error) || !/^expected version \d+, actual \d+$/.test(error.message)) throw error;
      }
    }
    throw new Error("writer integration evidence did not converge");
  }

  releaseTerminalWriter(milestoneId: string, writerTaskId: string): MilestoneRecord {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const events = this.journal.readStream(milestoneId);
      const milestone = projectMilestone(events);
      if (milestone === null) throw new Error(`milestone ${milestoneId} does not exist`);
      const ownership = milestone.writerOwnership[writerTaskId];
      if (ownership === undefined) throw new Error(`writer ${writerTaskId} has no ownership claim`);
      if (ownership.status === "released") {
        verifyStoredWriterReleases(this.journal, events, milestone);
        return withTrace(milestone, events);
      }
      if (ownership.status !== "claimed") throw new Error(`writer ${writerTaskId} ownership is not releasable`);
      const taskEvents = this.journal.readStream(writerTaskId);
      if (taskEvents.length === 0 || taskEvents.some((event) =>
        event.streamId !== writerTaskId || event.correlationId !== events[0]!.correlationId)) {
        throw new Error("terminal writer stream is not bound to the milestone trace");
      }
      const task = projectTask(taskEvents);
      if (task === null || task.terminalOutcome === null || task.terminalOutcome === "completed") {
        throw new Error("writer ownership release requires a non-success terminal task stream");
      }
      const outcome = task.terminalOutcome;
      const terminalEvent = taskEvents.at(-1)!;
      if (terminalEvent.type !== `task.${outcome}`) throw new Error("writer terminal event is not canonical");
      const writerState = milestone.tasks[writerTaskId];
      if (writerState?.status !== "running" && writerState?.status !== "completed") {
        throw new Error(`planned writer ${writerTaskId} is not running or completed`);
      }
      const reviewerState = milestone.tasks[ownership.reviewerTaskId];
      const phase = writerState.status === "running" || writerState.terminalOutcome === outcome
        ? "pre_review_writer" as const
        : writerState.terminalOutcome === "completed"
        ? "post_handoff_reviewer" as const
        : null;
      if (phase === null) throw new Error("terminal task stream contradicts milestone writer outcome");
      if (phase === "pre_review_writer" && reviewerState?.status !== "planned") {
        throw new Error("pre-review writer release requires an unstarted reviewer");
      }
      if (phase === "post_handoff_reviewer" &&
        reviewerState?.status !== "running" && reviewerState?.status !== "completed") {
        throw new Error("post-handoff release requires a running or completed paired reviewer");
      }
      if (phase === "post_handoff_reviewer" && reviewerState?.terminalOutcome !== null &&
        reviewerState?.terminalOutcome !== outcome) {
        throw new Error("terminal task stream contradicts paired reviewer outcome");
      }
      const next: NewEvent<string, unknown>[] = [];
      if (phase === "pre_review_writer" && writerState.status === "running") {
        const planned = milestone.plan?.tasks.find((candidate) => candidate.taskId === writerTaskId)!;
        next.push(this.newMilestoneEvent(events, milestoneId, "milestone.task_completed", {
          taskId: writerTaskId,
          actorId: planned.roleAssignment.agentId,
          role: planned.roleAssignment.role,
          outcome,
          evidence: { taskStreamId: writerTaskId, reconciliation: "terminal_task_stream" },
        }));
      }
      if (phase === "post_handoff_reviewer" && reviewerState?.status === "running") {
        const reviewer = milestone.plan?.tasks.find((candidate) => candidate.taskId === ownership.reviewerTaskId)!;
        next.push(this.newMilestoneEvent(events, milestoneId, "milestone.task_completed", {
          taskId: reviewer.taskId,
          actorId: reviewer.roleAssignment.agentId,
          role: reviewer.roleAssignment.role,
          outcome,
          evidence: { taskStreamId: writerTaskId, reconciliation: "terminal_paired_task_stream" },
        }));
      }
      next.push(this.newMilestoneEvent(events, milestoneId, "milestone.writer_terminal_released",
        WriterTerminalReleasedPayloadSchema.parse({
          schemaVersion: 1,
          batchId: ownership.batchId,
          writerTaskId,
          reviewerTaskId: ownership.reviewerTaskId,
          phase,
          milestoneTerminalTaskId: phase === "pre_review_writer" ? writerTaskId : ownership.reviewerTaskId,
          outcome,
          terminalEvidence: {
            streamId: writerTaskId,
            eventId: terminalEvent.eventId,
            streamVersion: terminalEvent.streamVersion,
            payloadDigest: digestCanonical(terminalEvent.payload),
            correlationId: terminalEvent.correlationId,
          },
        })));
      const candidates = next.map((event, index) => candidateStoredEvent(event, milestone.streamVersion + index + 1));
      projectMilestone([...events, ...candidates]);
      try {
        const stored = this.journal.append(milestoneId, milestone.streamVersion, next);
        const updatedEvents = [...events, ...stored];
        return withTrace(projectMilestone(updatedEvents)!, updatedEvents);
      } catch (error) {
        if (!(error instanceof Error) || !/^expected version \d+, actual \d+$/.test(error.message)) throw error;
      }
    }
    throw new Error("writer terminal release did not converge");
  }

  inspectWriterTask(milestoneId: string, writerTaskId: string): ReturnType<typeof projectTask> {
    const milestoneEvents = this.journal.readStream(milestoneId);
    if (milestoneEvents.length === 0) throw new Error(`milestone ${milestoneId} does not exist`);
    const taskEvents = this.journal.readStream(writerTaskId);
    if (taskEvents.length === 0) return null;
    if (taskEvents.some((event) => event.correlationId !== milestoneEvents[0]!.correlationId)) {
      throw new Error("writer task stream is not bound to the milestone trace");
    }
    return projectTask(taskEvents);
  }

  inspect(milestoneId: string): MilestoneRecord | null {
    const events = this.journal.readStream(milestoneId);
    const view = projectMilestone(events);
    if (view === null) return null;
    verifyStoredCompletion(this.journal, events, view);
    assertWriterClaimProvenance(view, Object.values(view.writerOwnership));
    verifyStoredWriterIntegrations(this.journal, events, view);
    verifyStoredWriterReleases(this.journal, events, view);
    return withTrace(view, events);
  }

  resume(milestoneId: string): MilestoneRecord | null {
    return this.inspect(milestoneId);
  }

  private requireMilestone(milestoneId: string): MilestoneRecord {
    const view = this.inspect(milestoneId);
    if (view === null) throw new Error(`milestone ${milestoneId} does not exist`);
    return view;
  }

  private appendTransition(milestoneId: string, type: string, payload: unknown): MilestoneRecord {
    const events = this.journal.readStream(milestoneId);
    const view = projectMilestone(events);
    if (view === null) throw new Error(`milestone ${milestoneId} does not exist`);
    const nextEvent: NewEvent<string, unknown> = {
      streamId: milestoneId,
      type,
      payload: canonicalPayload(payload),
      causationId: null,
      correlationId: events[0]!.correlationId,
    };
    projectMilestone([...events, candidateStoredEvent(nextEvent, view.streamVersion + 1)]);
    const stored = this.journal.append(milestoneId, view.streamVersion, [nextEvent]);
    return withTrace(projectMilestone([...events, ...stored])!, [...events, ...stored]);
  }

  private tryAppendTransition(
    events: readonly StoredEvent[],
    view: MilestoneView,
    type: string,
    payload: unknown,
  ): MilestoneRecord | null {
    const nextEvent = this.newMilestoneEvent(events, view.milestoneId, type, payload);
    projectMilestone([...events, candidateStoredEvent(nextEvent, view.streamVersion + 1)]);
    try {
      const stored = this.journal.append(view.milestoneId, view.streamVersion, [nextEvent]);
      const updatedEvents = [...events, ...stored];
      return withTrace(projectMilestone(updatedEvents)!, updatedEvents);
    } catch (error) {
      if (error instanceof Error && /^expected version \d+, actual \d+$/.test(error.message)) return null;
      throw error;
    }
  }

  private newMilestoneEvent(
    events: readonly StoredEvent[],
    milestoneId: string,
    type: string,
    payload: unknown,
  ): NewEvent<string, unknown> {
    return {
      streamId: milestoneId,
      type,
      payload: canonicalPayload(payload),
      causationId: null,
      correlationId: events[0]!.correlationId,
    };
  }
}

function canonicalDirectory(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  if (!statSync(canonical).isDirectory()) throw new Error("admission repository must be a directory");
  return canonical;
}

function candidateStoredEvent(event: NewEvent<string, unknown>, streamVersion: number): StoredEvent {
  return {
    ...event,
    eventId: "candidate-admission-event",
    streamVersion,
    globalPosition: 0,
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
}

function withTrace(view: MilestoneView, events: readonly StoredEvent[]): MilestoneRecord {
  return Object.freeze({
    ...view,
    traceId: events[0]!.correlationId,
    tracePath: tracePathFrom(events[0]!),
  });
}

function tracePathFrom(event: StoredEvent): string | null {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    return null;
  }
  const tracePath = (event.payload as Readonly<Record<string, unknown>>)["tracePath"];
  return typeof tracePath === "string" && tracePath.length > 0 ? tracePath : null;
}

function canonicalPayload(payload: unknown): unknown {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("event payload must be JSON-serializable");
  return JSON.parse(serialized) as unknown;
}

function assessRevision(
  input: ReviseMilestonePlanInput,
  view: MilestoneView,
  milestoneEvents: readonly StoredEvent[],
  journal: EventJournal,
  candidateDigest: string,
): ReplanningReason | null {
  if (view.plan === null || view.authorityEnvelope === null || view.replanningPolicy === null) return "baseline_authority_unproven";
  if (input.priorPlanDigest !== digestCanonical(view.plan)) return "stale_plan";
  if (
    input.revisionId.length === 0 || input.revisionId.length > 256 ||
    input.requestedBy.length === 0 || input.requestedBy.length > 256
  ) return "evidence";

  const candidate = MilestonePlanSchema.safeParse(input.candidatePlan);
  if (!candidate.success) return "dependency_graph";
  if (candidateDigest !== digestCanonical(candidate.data)) return "dependency_graph";
  if (
    candidate.data.milestoneId !== view.milestoneId ||
    candidate.data.projectId !== view.projectId ||
    digestCanonical(candidate.data.goal) !== view.authorityEnvelope.goalDigest
  ) return "goal";

  const currentPolicy = createReplanningPolicyBinding({
    milestoneId: view.milestoneId,
    projectId: view.projectId,
    security: input.security,
    ...(input.modelSheet === undefined ? {} : { modelSheet: input.modelSheet }),
  });
  if (currentPolicy.networkDigest !== view.authorityEnvelope.networkDigest) return "network";
  if (input.security.releaseBoundary !== view.authorityEnvelope.releaseBoundary) return "release";
  if (currentPolicy.securityDigest !== view.authorityEnvelope.securityDigest) return "security";
  if (currentPolicy.modelSheetDigest !== view.authorityEnvelope.modelSheetDigest) return "model_sheet";
  if (view.hasUncertainEffects) return "uncertain_effect";
  if (view.hasActiveEffects || view.executedTaskIds.some((taskId) => view.tasks[taskId]?.status !== "completed")) return "active_effect";

  if (input.linkedTaskStreamIds.length > 0) return "evidence";
  const globallyRelatedTaskStreams = new Set(journal.readAll()
    .filter((event) => event.correlationId === milestoneEvents[0]!.correlationId && event.streamId !== view.milestoneId && event.type.startsWith("task."))
    .map((event) => event.streamId));
  for (const streamId of globallyRelatedTaskStreams) {
    const stream = journal.readStream(streamId);
    if (stream.some((event) => event.streamId !== streamId || event.correlationId !== milestoneEvents[0]!.correlationId)) {
      return "evidence";
    }
    let task;
    try {
      task = projectTask(stream);
    } catch {
      return "evidence";
    }
    if (task === null) return "evidence";
    if (task.paused && task.uncertainEffect !== null) return "uncertain_effect";
    if (task.lifecycle !== "terminal") return "active_effect";
  }

  if (!validEvidence(input.evidence, view.milestoneId, journal)) return "evidence";
  return revisionBoundaryViolation({
    envelope: view.authorityEnvelope,
    currentPlan: view.plan,
    candidatePlan: candidate.data,
    planHistory: view.planHistory,
    taskStates: view.tasks,
    executedTaskIds: view.executedTaskIds,
    supersessions: input.supersessions ?? [],
  });
}

function validEvidence(
  references: readonly RevisionEvidenceReference[],
  milestoneId: string,
  journal: EventJournal,
): boolean {
  if (references.length === 0 || references.length > 256) return false;
  const eventIds = new Set<string>();
  let executionInformed = false;
  for (const rawReference of references) {
    const parsed = RevisionEvidenceReferenceSchema.safeParse(rawReference);
    if (!parsed.success || eventIds.has(parsed.data.eventId)) return false;
    eventIds.add(parsed.data.eventId);
    if (parsed.data.streamId !== milestoneId) return false;
    const event = journal.readStream(parsed.data.streamId).find((candidate) => candidate.eventId === parsed.data.eventId);
    if (
      event === undefined || event.streamVersion !== parsed.data.streamVersion ||
      event.type !== parsed.data.eventType || digestCanonical(event.payload) !== parsed.data.payloadDigest
    ) return false;
    if (event.type === "milestone.task_completed") executionInformed = true;
  }
  return executionInformed;
}

function safeCandidateDigest(candidate: unknown): string {
  try {
    return digestCanonical(canonicalPayload(candidate));
  } catch {
    return digestCanonical("invalid-replanning-candidate");
  }
}

function boundedIdentity(value: string): string {
  return value.length > 0 && value.length <= 256 ? value : digestCanonical(value);
}

function isReplanningAttention(value: MilestoneView["replanningAttention"]): value is ReplanningAttention {
  return value !== null && "revisionId" in value;
}

function projectionFailed(journal: EventJournal): boolean {
  return "projectionFailed" in journal && (journal as EventJournal & { readonly projectionFailed: boolean }).projectionFailed;
}

function eventPayload(event: StoredEvent | undefined): Readonly<Record<string, unknown>> | null {
  return event === undefined || typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)
    ? null
    : event.payload as Readonly<Record<string, unknown>>;
}

function recordValue(
  value: Readonly<Record<string, unknown>> | null,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const nested = value?.[key];
  return typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? nested as Readonly<Record<string, unknown>>
    : null;
}

function assertWriterClaimProvenance(
  milestone: MilestoneView,
  claims: readonly {
    readonly actorId: string;
    readonly capabilityId: string;
    readonly transportModelId: string;
    readonly harness: string;
    readonly roles: readonly string[];
    readonly toolPermissions: readonly string[];
    readonly network: string;
    readonly contextTokens: number;
    readonly modelCapabilityDigest: string;
    readonly modelMaxConcurrency: number;
  }[],
): void {
  if (claims.length === 0) return;
  const envelope = milestone.authorityEnvelope;
  const modelSheet = milestone.replanningPolicy?.modelSheet ?? null;
  if (envelope === null && modelSheet === null) return;
  if (envelope === null || modelSheet === null || envelope.modelSheetDigest === null ||
    milestone.replanningPolicy?.modelSheetDigest !== envelope.modelSheetDigest) {
    throw new Error("writer batch model provenance is not pinned by durable authority");
  }
  for (const claim of claims) {
    const model = modelSheet.models.find((candidate) => candidate.id === claim.capabilityId);
    const pinnedCapability = envelope.capabilities.find((candidate) => candidate.capabilityId === claim.capabilityId);
    if (model === undefined || pinnedCapability === undefined) {
      throw new Error("writer batch model provenance is not in the pinned model sheet");
    }
    const snapshot = capabilitySnapshot({ models: [model] })[0]!;
    if (
      claim.actorId !== model.id || claim.transportModelId !== model.model ||
      claim.harness !== model.harness || claim.network !== model.network ||
      claim.contextTokens !== model.contextTokens || claim.modelMaxConcurrency !== model.maxConcurrency ||
      claim.modelCapabilityDigest !== digestCanonical(model) ||
      digestCanonical([...claim.roles].sort()) !== digestCanonical([...model.roles].sort()) ||
      digestCanonical([...claim.toolPermissions].sort()) !== digestCanonical([...model.toolPermissions].sort()) ||
      digestCanonical(snapshot) !== digestCanonical(pinnedCapability)
    ) throw new Error("writer batch claim contradicts pinned model provenance");
  }
}

function verifiedIntegrationEvidence(
  journal: EventJournal,
  milestoneEvents: readonly StoredEvent[],
  milestone: MilestoneView,
  taskStreamId: string,
  requireSingleton: boolean,
  expectedReviewerId: string,
): VerifiedMilestoneIntegrationEvidence {
  const implementers = milestone.plan?.tasks.filter((task) => task.roleAssignment.role === "implementer") ?? [];
  if ((requireSingleton && implementers.length !== 1) || !implementers.some((task) => task.taskId === taskStreamId)) {
    throw new Error("integration evidence must belong to the planned implementer task");
  }
  const taskEvents = journal.readStream(taskStreamId);
  if (
    taskEvents.length === 0 ||
    taskEvents.some((event) => event.streamId !== taskStreamId || event.correlationId !== milestoneEvents[0]!.correlationId)
  ) throw new Error("integrated task stream is not bound to the milestone trace");
  const task = projectTask(taskEvents);
  if (task?.terminalOutcome !== "completed") {
    throw new Error("successful milestone completion requires a completed task stream");
  }
  const integration = taskEvents.findLast((event) => event.type === "task.integration_observed");
  const completion = taskEvents.findLast((event) => event.type === "task.completed");
  const cleanup = taskEvents.findLast((event) =>
    event.type === "task.cleanup_completed" || event.type === "task.cleanup_reconciled");
  const integrationPayload = eventPayload(integration);
  const receipt = recordValue(integrationPayload, "receipt");
  assertPairedReviewEvidence(taskEvents, expectedReviewerId, receipt);
  const resultCommit = receipt?.["resultCommit"];
  if (
    integration === undefined || completion === undefined || cleanup === undefined ||
    integrationPayload?.["verification"] !== "verified" ||
    typeof resultCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(resultCommit) ||
    receipt?.["taskId"] !== taskStreamId || receipt["projectId"] !== milestone.projectId || receipt["outcome"] !== "completed" ||
    integration.streamVersion >= cleanup.streamVersion || cleanup.streamVersion >= completion.streamVersion
  ) throw new Error("task stream lacks ordered verified local integration evidence");
  return {
    taskStreamId,
    integrationEventId: integration.eventId,
    integrationStreamVersion: integration.streamVersion,
    integrationPayloadDigest: digestCanonical(integration.payload),
    completionEventId: completion.eventId,
    completionStreamVersion: completion.streamVersion,
    completionPayloadDigest: digestCanonical(completion.payload),
    resultCommit,
  };
}

function assertPairedReviewEvidence(
  taskEvents: readonly StoredEvent[],
  expectedReviewerId: string,
  receipt: Readonly<Record<string, unknown>> | null,
): void {
  const artifacts = projectArtifacts(taskEvents);
  const byKind = (kind: "patch" | "validation_report" | "review_report") => {
    const matching = artifacts.artifacts.filter((artifact) => artifact.kind === kind);
    if (matching.length !== 1) throw new Error(`task stream lacks exact ${kind} artifact evidence`);
    const artifact = matching[0]!;
    return { artifact, evidence: artifacts.evidenceByArtifactId[artifact.artifactId] };
  };
  const patch = byKind("patch");
  const validationArtifact = byKind("validation_report");
  const reviewArtifact = byKind("review_report");
  const patchEvidence = patch.evidence as Readonly<Record<string, unknown>>;
  const patchDiffSha256 = patchEvidence?.["diffSha256"];
  const validation = ValidationReportSchema.safeParse(validationArtifact.evidence);
  const requested = taskEvents.filter((event) => event.type === "task.review_requested");
  const approved = taskEvents.filter((event) => event.type === "task.review_approved");
  const validationCompleted = taskEvents.filter((event) => event.type === "task.validation_completed");
  if (requested.length !== 1 || approved.length !== 1 || validationCompleted.length !== 1) {
    throw new Error("task stream lacks exact paired review evidence");
  }
  const validationPayload = eventPayload(validationCompleted[0]);
  const requestPayload = eventPayload(requested[0]);
  const approvalPayload = eventPayload(approved[0]);
  const parsed = ReviewDecisionSchema.safeParse(approvalPayload?.["review"]);
  const receiptReview = receipt?.["review"];
  if (
    typeof patchDiffSha256 !== "string" || patchDiffSha256 !== patch.artifact.sha256 ||
    artifactEvidenceSha256("patch", patch.evidence) !== patch.artifact.sha256 ||
    !validation.success || validation.data.name !== "focused" || validation.data.outcome !== "completed" ||
    validation.data.exitCode !== 0 || validation.data.provenance.subjectSha256 !== patchDiffSha256 ||
    artifactEvidenceSha256("validation_report", validation.data) !== validationArtifact.artifact.sha256 ||
    validationPayload?.["outcome"] !== "completed" || validationPayload["diffSha256"] !== patchDiffSha256 ||
    validationPayload["validation"] === undefined ||
    digestCanonical(validationPayload["validation"]) !== digestCanonical(validation.data) ||
    requestPayload?.["reviewerId"] !== expectedReviewerId ||
    requestPayload["validation"] === undefined ||
    digestCanonical(requestPayload["validation"]) !== digestCanonical(validation.data) ||
    !parsed.success || !parsed.data.approved || parsed.data.reviewerId !== expectedReviewerId ||
    parsed.data.diffSha256 !== patchDiffSha256 ||
    parsed.data.validationSha256 !== canonicalValidationDigest(validation.data) ||
    artifactEvidenceSha256("review_report", parsed.data) !== reviewArtifact.artifact.sha256 ||
    digestCanonical(reviewArtifact.evidence) !== digestCanonical(parsed.data) ||
    receiptReview === undefined || digestCanonical(receiptReview) !== digestCanonical(parsed.data)
  ) throw new Error("task stream lacks exact paired review evidence");
}

function verifyStoredCompletion(
  journal: EventJournal,
  milestoneEvents: readonly StoredEvent[],
  milestone: MilestoneView,
): void {
  if (milestone.terminalOutcome !== "completed" || milestone.plan === null || !(
    milestone.plan.tasks.some((task) => task.roleAssignment.role === "implementer") &&
    milestone.plan.tasks.some((task) => task.roleAssignment.role === "reviewer")
  )) return;
  const completion = milestoneEvents.at(-1);
  if (completion?.type !== "milestone.completed") throw new Error("completed milestone lacks a terminal event");
  const retained = MilestoneCompletedPayloadSchema.parse(completion.payload).evidence;
  const reviewer = milestone.plan.tasks.find((task) =>
    task.roleAssignment.role === "reviewer" && task.dependencies.includes(retained.taskStreamId));
  if (reviewer === undefined) throw new Error("completed milestone lacks a paired reviewer");
  const verified = verifiedIntegrationEvidence(
    journal,
    milestoneEvents,
    milestone,
    retained.taskStreamId,
    true,
    reviewer.roleAssignment.agentId,
  );
  if (digestCanonical(retained) !== digestCanonical(verified)) {
    throw new Error("milestone completion evidence contradicts the retained task stream");
  }
}

function verifyStoredWriterIntegrations(
  journal: EventJournal,
  milestoneEvents: readonly StoredEvent[],
  milestone: MilestoneView,
): void {
  for (const ownership of Object.values(milestone.writerOwnership)) {
    if (ownership.status !== "integrated") continue;
    const event = milestoneEvents.findLast((candidate) =>
      candidate.type === "milestone.writer_integration_completed" &&
      eventPayload(candidate)?.["writerTaskId"] === ownership.writerTaskId);
    if (event === undefined) throw new Error("integrated writer lacks retained milestone evidence");
    const retained = WriterIntegrationCompletedPayloadSchema.parse(event.payload).evidence;
    const reviewer = milestone.plan?.tasks.find((task) => task.taskId === ownership.reviewerTaskId);
    if (reviewer === undefined) throw new Error("integrated writer lacks its paired reviewer");
    const verified = verifiedIntegrationEvidence(
      journal,
      milestoneEvents,
      milestone,
      ownership.writerTaskId,
      false,
      reviewer.roleAssignment.agentId,
    );
    if (digestCanonical(retained) !== digestCanonical(verified)) {
      throw new Error("writer integration evidence contradicts the retained task stream");
    }
  }
}

function verifyStoredWriterReleases(
  journal: EventJournal,
  milestoneEvents: readonly StoredEvent[],
  milestone: MilestoneView,
): void {
  for (const ownership of Object.values(milestone.writerOwnership)) {
    if (ownership.status !== "released") continue;
    const releaseEvent = milestoneEvents.findLast((candidate) =>
      candidate.type === "milestone.writer_terminal_released" &&
      eventPayload(candidate)?.["writerTaskId"] === ownership.writerTaskId);
    if (releaseEvent === undefined) throw new Error("released writer lacks retained milestone evidence");
    const retained = WriterTerminalReleasedPayloadSchema.parse(releaseEvent.payload);
    const taskEvents = journal.readStream(ownership.writerTaskId);
    const terminal = taskEvents.at(-1);
    const task = projectTask(taskEvents);
    const expectedMilestoneTaskId = retained.phase === "pre_review_writer"
      ? ownership.writerTaskId
      : ownership.reviewerTaskId;
    if (
      taskEvents.length === 0 || taskEvents.some((event) =>
        event.streamId !== ownership.writerTaskId || event.correlationId !== milestoneEvents[0]!.correlationId) ||
      terminal === undefined || task?.terminalOutcome !== retained.outcome ||
      retained.outcome !== ownership.terminalOutcome || retained.phase !== ownership.releasePhase ||
      retained.milestoneTerminalTaskId !== expectedMilestoneTaskId ||
      retained.terminalEvidence.streamId !== ownership.writerTaskId ||
      terminal.eventId !== retained.terminalEvidence.eventId ||
      terminal.streamVersion !== retained.terminalEvidence.streamVersion ||
      terminal.correlationId !== retained.terminalEvidence.correlationId ||
      retained.terminalEvidence.correlationId !== milestoneEvents[0]!.correlationId ||
      digestCanonical(terminal.payload) !== retained.terminalEvidence.payloadDigest
    ) throw new Error("writer terminal release contradicts the retained task stream");
  }
}
