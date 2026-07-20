import { digestCanonical } from "../contracts/authority-attention.js";
import type { NewEvent } from "../contracts/event.js";
import { AnalysisCompletedPayloadSchema } from "../analysis/analysis-contracts.js";
import { AttentionService, type DecisionSubmission } from "../attention/attention-service.js";
import type { AttentionView } from "../attention/attention-projection.js";
import { ApprovalPacketSchema, DecisionRejectedPayloadSchema, decisionStreamId, type ApprovalPacket } from "../attention/attention-contracts.js";
import { isAtomicEventJournal, iterateAllEvents, readStreamEvents, type EventJournal } from "../journal/journal.js";
import {
  createValidationIdentitySnapshot,
  type ProjectConfig,
} from "../projects/project-config.js";
import { RunAnalysisCompletedPayloadSchema, runStreamId } from "../runs/run-contracts.js";
import { RunService } from "../runs/run-service.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import {
  CorrectionProposedPayloadSchema,
  PLANNING_SCHEMA_VERSION,
  PlanProposedPayloadSchema,
  PlanRejectedPayloadSchema,
  PlanRevisedPayloadSchema,
  assertCorrectionWithinBounds,
  buildPlanningArtifact,
  planningStreamId,
  type PlanningProposalInput,
  PlanningCapabilityIdentitySchema,
  type PlanningCapabilityIdentity,
} from "./planning-contracts.js";
import { projectPlanning, type PlanningView } from "./planning-projection.js";

export interface PlanningRequestInput {
  readonly proposal: PlanningProposalInput;
  readonly project: ProjectConfig;
  readonly security: SecuritySheet;
  readonly decisionId: string;
  readonly attentionId: string;
  readonly expiresAt: string;
  readonly commandId: string;
}

export interface PlanningRequestResult {
  readonly planning: PlanningView;
  readonly approval: AttentionView;
}

export class PlanningCoordinator {
  private readonly capabilities: readonly PlanningCapabilityIdentity[];

  constructor(
    private readonly journal: EventJournal,
    private readonly runs: RunService,
    private readonly attention: AttentionService,
    capabilities: readonly PlanningCapabilityIdentity[],
  ) {
    this.capabilities = Object.freeze(capabilities.map((identity) => PlanningCapabilityIdentitySchema.parse(identity)));
  }

  propose(input: PlanningRequestInput): PlanningRequestResult {
    const run = this.runs.get(input.proposal.runId);
    if (run === null) throw new Error(`run ${input.proposal.runId} not found`);
    if (run.lifecycle !== "planning" && run.lifecycle !== "awaiting_approval") {
      throw new Error(`run is not planning: ${run.lifecycle}`);
    }
    this.verifyProposalBinding(input.proposal, input.project, input.security);
    const artifact = buildPlanningArtifact(input.proposal, run.budget, 1);
    const existing = this.get(input.proposal.runId);
    if (existing !== null) {
      if (existing.revision !== 1 || existing.planDigest !== artifact.planDigest ||
        existing.envelopeDigest !== artifact.envelopeDigest || existing.lifecycle !== "proposed") {
        throw new Error("planning proposal already exists with different input");
      }
      return this.requestApproval(input, existing);
    }
    const payload = PlanProposedPayloadSchema.parse({
      schemaVersion: PLANNING_SCHEMA_VERSION,
      revision: 1,
      ...artifact,
      commandId: input.commandId,
      authority: "none",
    });
    const streamId = planningStreamId(run.runId);
    this.journal.append(streamId, 0, [this.event(streamId, "plan.proposed", payload, run.runId,
      input.proposal.analysisEvidence.completionEventId)]);
    return this.requestApproval(input, requiredPlanning(this.get(run.runId)));
  }

  revise(input: PlanningRequestInput): PlanningRequestResult {
    let current = requiredPlanning(this.get(input.proposal.runId));
    const rejected = this.currentRejectedApproval(current);
    if (rejected !== null) current = this.recordRejection(rejected);
    let run = this.runs.get(input.proposal.runId);
    if (run === null) throw new Error(`run ${input.proposal.runId} not found`);
    this.verifyProposalBinding(input.proposal, input.project, input.security);
    const replayArtifact = buildPlanningArtifact(input.proposal, run.budget, current.revision);
    if (current.lifecycle === "proposed" && replayArtifact.planDigest === current.planDigest &&
      replayArtifact.envelopeDigest === current.envelopeDigest) {
      return this.requestApproval(input, current);
    }
    const artifact = buildPlanningArtifact(input.proposal, run.budget, current.revision + 1);
    if (current.correctionBounds !== null) assertCorrectionWithinBounds(artifact, current.correctionBounds);
    if (run.lifecycle === "awaiting_approval") {
      const pending = this.currentPendingApproval(current);
      if (pending === null) throw new Error("current run approval has no pending decision reservation");
      try {
        this.runs.revisePlanGuarded(run.runId, run.streamVersion, `${input.commandId}:invalidate`, {
          streamId: decisionStreamId(pending.decisionId),
          expectedVersion: pending.streamVersion,
        });
      } catch (error) {
        const concurrentlyRejected = this.currentRejectedApproval(current);
        if (concurrentlyRejected === null) throw error;
        current = this.recordRejection(concurrentlyRejected);
        assertCorrectionWithinBounds(artifact, current.correctionBounds!);
      }
      run = this.runs.get(run.runId)!;
    } else if (run.lifecycle !== "planning") {
      throw new Error(`run cannot revise its plan from ${run.lifecycle}`);
    }
    const payload = PlanRevisedPayloadSchema.parse({
      schemaVersion: PLANNING_SCHEMA_VERSION,
      revision: current.revision + 1,
      ...artifact,
      priorPlanDigest: current.planDigest,
      priorEnvelopeDigest: current.envelopeDigest,
      commandId: input.commandId,
      authority: "none",
    });
    const streamId = planningStreamId(run.runId);
    this.journal.append(streamId, current.streamVersion, [this.event(
      streamId,
      "plan.revised",
      payload,
      run.runId,
      input.proposal.analysisEvidence.completionEventId,
    )]);
    return this.requestApproval(input, requiredPlanning(this.get(run.runId)));
  }

  reject(decisionId: string, input: DecisionSubmission & { readonly reason: string }): PlanningView {
    const rejected = this.attention.reject(decisionId, input);
    return this.recordRejection(rejected);
  }

  reconcileRejected(decisionId: string): PlanningView {
    const decision = this.attention.getDecision(decisionId);
    if (decision === null) throw new Error(`decision ${decisionId} not found`);
    return this.recordRejection(decision);
  }

  get(runId: string): PlanningView | null {
    return projectPlanning(readStreamEvents(this.journal, planningStreamId(runId)));
  }

  private requestApproval(input: PlanningRequestInput, planning: PlanningView): PlanningRequestResult {
    let run = this.runs.get(planning.runId)!;
    if (run.lifecycle === "planning") {
      run = this.runs.requestApproval(run.runId, run.streamVersion, `${input.commandId}:run-approval`, {
        planDigest: planning.planDigest,
        envelopeDigest: planning.envelopeDigest,
      });
    }
    if (run.lifecycle !== "awaiting_approval" || run.authority.planDigest !== planning.planDigest ||
      run.authority.envelopeDigest !== planning.envelopeDigest) {
      throw new Error("run approval request does not bind the durable planning proposal");
    }
    const taskScopes = planning.proposal.plan.tasks.map((task) => `task:${task.taskId}`).sort();
    const dependentScopes = planning.proposal.plan.tasks
      .filter((task) => task.dependencies.length > 0)
      .map((task) => `task:${task.taskId}`)
      .sort();
    const approval = this.attention.requestApproval({
      decisionId: input.decisionId,
      attentionId: input.attentionId,
      runId: run.runId,
      summary: `Approve planning proposal revision ${planning.revision}.`,
      operation: "approve_execution_plan",
      target: `run:${run.runId}`,
      inputsSha256: digestCanonical({
        planDigest: planning.planDigest,
        envelopeDigest: planning.envelopeDigest,
        analysisEvidence: planning.proposal.analysisEvidence,
      }),
      expectedEffect: "Authorize only the exact bounded proposal for later execution admission.",
      proposedStateChange: "Move the run to approved_and_ready_for_execution without starting execution.",
      risk: `Potential writes are descriptively bounded to ${planning.envelope.potentialWritePaths.join(", ") || "none"}.`,
      mitigationOrRollback: "Revise or reject the proposal before any execution capability is admitted.",
      planDigest: planning.planDigest,
      envelopeDigest: planning.envelopeDigest,
      impacts: ["Authorizes the exact proposal for a later execution gate."],
      affectedScopes: taskScopes,
      dependentScopes,
      expiryPolicy: { kind: "at", expiresAt: input.expiresAt },
      evidenceSha256: digestCanonical({
        planDigest: planning.planDigest,
        envelopeDigest: planning.envelopeDigest,
      }),
      commandId: `${input.commandId}:attention`,
    });
    return { planning, approval };
  }

  private recordRejection(decision: AttentionView): PlanningView {
    if (decision.kind !== "approval" || decision.status !== "rejected" || decision.resolution === null) {
      throw new Error("planning rejection requires a rejected approval decision");
    }
    const packet = decision.packet as ApprovalPacket;
    const current = requiredPlanning(this.get(decision.runId));
    if (current.lifecycle === "correction_pending") return current;
    if (packet.planDigest !== current.planDigest || packet.envelopeDigest !== current.envelopeDigest) {
      throw new Error("rejected approval does not bind the current planning proposal");
    }
    const decisionEvent = this.attention.readDecisionStream(decision.decisionId)
      .find((event) => event.type === "approval.rejected");
    if (decisionEvent === undefined) throw new Error("approval rejection event is missing");
    const rejection = DecisionRejectedPayloadSchema.parse(decisionEvent.payload);
    const run = this.runs.get(decision.runId)!;
    if (run.lifecycle === "awaiting_approval") {
      this.runs.rejectApproval(run.runId, run.streamVersion, `${rejection.commandId}:run-rejected`, {
        approvalDecisionId: decision.decisionId,
        approvalDecisionEventId: decisionEvent.eventId,
        reasonEvidenceSha256: rejection.evidenceSha256,
      });
    } else if (run.lifecycle !== "planning" || run.authority.approvalState !== "rejected") {
      throw new Error("run rejection state contradicts the approval decision");
    }
    const rejectedPayload = PlanRejectedPayloadSchema.parse({
      schemaVersion: PLANNING_SCHEMA_VERSION,
      revision: current.revision,
      decisionId: decision.decisionId,
      approvalRequestEventId: packet.approvalRequestEventId,
      decisionEventId: decisionEvent.eventId,
      reason: rejection.reason,
      reasonEvidenceSha256: rejection.evidenceSha256,
      planDigest: current.planDigest,
      envelopeDigest: current.envelopeDigest,
      commandId: `${rejection.commandId}:plan-rejected`,
      authority: "none",
    });
    const correctionPayload = CorrectionProposedPayloadSchema.parse({
      schemaVersion: PLANNING_SCHEMA_VERSION,
      revision: current.revision,
      rejectedPlanDigest: current.planDigest,
      rejectedEnvelopeDigest: current.envelopeDigest,
      bounds: current.envelope,
      commandId: `${rejection.commandId}:correction`,
      authority: "none",
    });
    const streamId = planningStreamId(current.runId);
    const events = [
      this.event(streamId, "plan.rejected", rejectedPayload, current.runId, decisionEvent.eventId),
      this.event(streamId, "correction.proposed", correctionPayload, current.runId, decisionEvent.eventId),
    ];
    if (!isAtomicEventJournal(this.journal)) throw new Error("planning rejection requires an atomic journal");
    this.journal.appendAtomically([{ streamId, expectedVersion: current.streamVersion, events }]);
    return requiredPlanning(this.get(current.runId));
  }

  private verifyProposalBinding(
    proposal: PlanningProposalInput,
    project: ProjectConfig,
    security: SecuritySheet,
  ): void {
    const runEvents = this.runs.readStream(proposal.runId);
    const run = this.runs.get(proposal.runId);
    if (run === null || run.projectId !== proposal.projectId ||
      JSON.stringify(run.projectRevision) !== JSON.stringify(proposal.projectRevision)) {
      throw new Error("planning proposal does not match the authoritative run");
    }
    if (project.projectId !== proposal.projectId) throw new Error("project configuration does not match the proposal");
    if (proposal.securityDigest !== digestCanonical(security)) {
      throw new Error("planning security digest does not match the authoritative policy");
    }
    if (proposal.capabilityCatalogDigest !== digestCanonical(this.capabilities)) {
      throw new Error("planning capability catalog digest does not match the installed identities");
    }
    if (!security.allowedRepositories.includes(project.repositoryPath)) {
      throw new Error("planning project repository is outside the security policy");
    }
    const scopedPaths = [
      ...proposal.plan.tasks.flatMap((task) => task.ownedPaths),
      ...proposal.taskSpecifications.flatMap((specification) => specification.broadReadPaths),
      ...proposal.taskSpecifications.flatMap((specification) => specification.potentialWritePaths),
    ];
    for (const candidate of scopedPaths) {
      if (!security.allowedFileScopes.some((scope) => scopeContains(scope, candidate)) ||
        security.forbiddenPaths.some((scope) => scopesOverlap(scope, candidate))) {
        throw new Error(`planning path ${candidate} is outside the security policy`);
      }
    }
    for (const task of proposal.plan.tasks) {
      const specification = proposal.taskSpecifications.find((item) => item.taskId === task.taskId)!;
      if (!this.capabilities.some((identity) => identity.capabilityId === specification.capabilityId &&
        identity.agentId === task.roleAssignment.agentId && identity.role === task.roleAssignment.role &&
        identity.harness === task.roleAssignment.harness)) {
        throw new Error(`task ${task.taskId} does not match an installed capability identity`);
      }
      if (task.risk.authority === "external_effect") {
        throw new Error("external-effect authority is not executable in the local planning boundary");
      }
      if (task.risk.authority === "local_release_preparation" && security.releaseBoundary === "no_release_operations") {
        throw new Error("local release preparation is forbidden by the security policy");
      }
    }
    const runAnalysisEvent = runEvents.findLast((event) => event.type === "run.analysis_completed");
    if (runAnalysisEvent === undefined) throw new Error("planning requires durable completed analysis evidence");
    const runAnalysis = RunAnalysisCompletedPayloadSchema.parse(runAnalysisEvent.payload);
    const completion = readStreamEvents(this.journal, proposal.analysisEvidence.analysisStreamId)
      .find((event) => event.eventId === proposal.analysisEvidence.completionEventId);
    if (completion?.type !== "analysis.completed" || completion.correlationId !== proposal.runId) {
      throw new Error("planning analysis completion event is missing or incorrectly bound");
    }
    const analysis = AnalysisCompletedPayloadSchema.parse(completion.payload);
    if (runAnalysis.analysisStreamId !== proposal.analysisEvidence.analysisStreamId ||
      runAnalysis.analysisCompletionEventId !== completion.eventId ||
      runAnalysis.analysisEvidenceSha256 !== proposal.analysisEvidence.evidenceSha256 ||
      runAnalysis.sourceEvidenceSha256 !== proposal.analysisEvidence.sourceEvidenceSha256 ||
      analysis.evidenceSha256 !== proposal.analysisEvidence.evidenceSha256 ||
      analysis.sourceEvidenceSha256 !== proposal.analysisEvidence.sourceEvidenceSha256) {
      throw new Error("planning proposal analysis evidence contradicts the authoritative run");
    }
    const requiredValidationIds = [...new Set(proposal.taskSpecifications.flatMap((item) => item.requiredValidationIds))].sort();
    const expected = requiredValidationIds.map((validationId) =>
      createValidationIdentitySnapshot(project, validationId as "focused" | "full"));
    if (digestCanonical(proposal.validationIdentities) !== digestCanonical(expected)) {
      throw new Error("planning validation identities do not match the canonical project configuration");
    }
  }

  private currentRejectedApproval(planning: PlanningView): AttentionView | null {
    for (const event of iterateAllEvents(this.journal)) {
      if (event.type !== "approval.requested" || event.correlationId !== planning.runId) continue;
      const packet = ApprovalPacketSchema.parse(event.payload);
      if (packet.planDigest !== planning.planDigest || packet.envelopeDigest !== planning.envelopeDigest) continue;
      const decision = this.attention.getDecision(packet.decisionId);
      if (decision?.status === "rejected") return decision;
    }
    return null;
  }

  private currentPendingApproval(planning: PlanningView): AttentionView | null {
    for (const event of iterateAllEvents(this.journal)) {
      if (event.type !== "approval.requested" || event.correlationId !== planning.runId) continue;
      const packet = ApprovalPacketSchema.parse(event.payload);
      if (packet.planDigest !== planning.planDigest || packet.envelopeDigest !== planning.envelopeDigest) continue;
      const decision = this.attention.getDecision(packet.decisionId);
      if (decision?.status === "pending") return decision;
    }
    return null;
  }

  private event(
    streamId: string,
    type: string,
    payload: unknown,
    correlationId: string,
    causationId: string,
  ): NewEvent<string, unknown> {
    return { streamId, type, payload, correlationId, causationId };
  }
}

function requiredPlanning(view: PlanningView | null): PlanningView {
  if (view === null) throw new Error("planning projection unexpectedly returned null");
  return view;
}

function scopeContains(scope: string, candidate: string): boolean {
  const scopeBase = scope.endsWith("/**") ? scope.slice(0, -3) : scope;
  if (!scope.endsWith("/**")) return candidate === scopeBase;
  return candidate === scopeBase || candidate.startsWith(`${scopeBase}/`);
}

function scopesOverlap(first: string, second: string): boolean {
  const firstBase = first.endsWith("/**") ? first.slice(0, -3) : first;
  const secondBase = second.endsWith("/**") ? second.slice(0, -3) : second;
  return firstBase === secondBase || firstBase.startsWith(`${secondBase}/`) || secondBase.startsWith(`${firstBase}/`);
}
