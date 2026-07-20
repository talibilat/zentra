import { randomUUID } from "node:crypto";

import type { NewEvent, StoredEvent } from "../contracts/event.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import {
  isAtomicEventJournal,
  iterateAllEvents,
  readStreamEvents,
  type AtomicEventJournal,
  type AtomicAppend,
  type EventJournal,
} from "../journal/journal.js";
import {
  RunAcceptedPayloadSchema,
  RunApprovalRequestedPayloadSchema,
  RUN_SCHEMA_VERSION,
  RunReadyPayloadSchema,
  runStreamId,
  type ProjectRevision,
} from "../runs/run-contracts.js";
import { projectRun } from "../runs/run-projection.js";
import {
  ATTENTION_SCHEMA_VERSION,
  ApprovalPacketSchema,
  ApprovalReservationConsumedPayloadSchema,
  ApprovalReservationPayloadSchema,
  AttemptPayloadSchema,
  AttentionIdentityReservationPayloadSchema,
  AttentionIndexRaisedPayloadSchema,
  AttentionIndexResolvedPayloadSchema,
  AttentionRaisedPayloadSchema,
  DecisionActorSchema,
  QuestionPacketSchema,
  ScopeAdmissionPayloadSchema,
  advisoryAttentionStreamId,
  attentionIdentityReservationStreamId,
  attentionIndexStreamId,
  approvalReservationStreamId,
  decisionAttemptStreamId,
  decisionStreamId,
  parseDecisionAttemptStreamId,
  type ApprovalPacket,
  type AttemptPayload,
  type DecisionActor,
  type ExpiryPolicy,
  type QuestionPacket,
} from "./attention-contracts.js";
import { projectAttentionIndex, type AttentionIndexView } from "./attention-index.js";
import { projectAttention, type AttentionView } from "./attention-projection.js";
import { projectApprovalReservation, type ApprovalReservationView } from "./approval-reservation.js";
import {
  projectAttentionIdentityReservation,
  type AttentionIdentityReservationView,
} from "./attention-identity-reservation.js";

const Digest = /^[a-f0-9]{64}$/;
export type TrustedClock = () => Date;

export interface RequestQuestionInput {
  readonly decisionId: string;
  readonly attentionId: string;
  readonly runId: string;
  readonly question: string;
  readonly options: readonly {
    readonly optionId: string;
    readonly label: string;
    readonly impacts: readonly string[];
  }[];
  readonly recommendation: { readonly optionId: string; readonly rationale: string } | null;
  readonly impacts: readonly string[];
  readonly affectedScopes: readonly string[];
  readonly dependentScopes: readonly string[];
  readonly material: boolean;
  readonly evidenceSha256: string;
  readonly commandId: string;
  readonly expiryPolicy?: ExpiryPolicy;
  readonly questions?: QuestionPacket["questions"];
}

export interface RequestApprovalInput {
  readonly decisionId: string;
  readonly attentionId: string;
  readonly runId: string;
  readonly summary: string;
  readonly operation: string;
  readonly target: string;
  readonly inputsSha256: string;
  readonly expectedEffect: string;
  readonly proposedStateChange: string;
  readonly risk: string;
  readonly mitigationOrRollback: string;
  readonly planDigest: string;
  readonly envelopeDigest: string;
  readonly impacts: readonly string[];
  readonly affectedScopes: readonly string[];
  readonly dependentScopes: readonly string[];
  readonly expiryPolicy: { readonly kind: "at"; readonly expiresAt: string };
  readonly evidenceSha256: string;
  readonly commandId: string;
}

export interface DecisionSubmission {
  readonly runId: string;
  readonly expectedVersion: number;
  readonly actor: DecisionActor;
  readonly commandId: string;
  readonly evidenceSha256: string;
}

interface RunApprovalBinding {
  readonly runStreamVersion: number;
  readonly approvalRequestEventId: string;
  readonly projectRevision: ProjectRevision;
  readonly planDigest: string;
  readonly envelopeDigest: string;
}

export class AttentionService {
  constructor(
    private readonly journal: EventJournal,
    private readonly clock: TrustedClock = () => new Date(),
  ) {}

  requestQuestion(input: RequestQuestionInput): AttentionView {
    this.requireRun(input.runId);
    const packet = QuestionPacketSchema.parse({
      ...input,
      affectedScopes: canonicalSet(input.affectedScopes),
      dependentScopes: canonicalSet(input.dependentScopes),
      expiryPolicy: input.expiryPolicy ?? { kind: "wait_forever" },
      schemaVersion: ATTENTION_SCHEMA_VERSION,
      authority: "none",
    });
    const streamId = decisionStreamId(packet.decisionId);
    const creationEventId = randomUUID();
    const events = [
      { ...this.event(streamId, "questionnaire.proposed", packet, packet.runId), eventId: creationEventId },
      this.event(streamId, "decision.requested", {
        schemaVersion: ATTENTION_SCHEMA_VERSION,
        decisionId: packet.decisionId,
        runId: packet.runId,
        commandId: packet.commandId,
        authority: "none",
      }, packet.runId),
      this.event(
        streamId,
        "attention.raised",
        attentionRaised(packet, "questionnaire", packet.material ? "material" : "advisory"),
        packet.runId,
      ),
    ];
    return packet.material
      ? this.createMaterialDecision(packet, events)
      : this.createReservedAttention({
        attentionId: packet.attentionId,
        runId: packet.runId,
        kind: "question",
        source: "questionnaire",
        decisionId: packet.decisionId,
        commandId: packet.commandId,
        creationEventId,
        streamId,
        events,
      });
  }

  requestApproval(input: RequestApprovalInput): AttentionView {
    const atomic = this.atomicJournal();
    const binding = this.currentRunApproval(input.runId);
    if (binding.planDigest !== input.planDigest || binding.envelopeDigest !== input.envelopeDigest) {
      throw new Error("approval request does not match the current run packet");
    }
    const packet = ApprovalPacketSchema.parse({
      ...input,
      projectRevision: binding.projectRevision,
      runStreamVersion: binding.runStreamVersion,
      approvalRequestEventId: binding.approvalRequestEventId,
      affectedScopes: canonicalSet(input.affectedScopes),
      dependentScopes: canonicalSet(input.dependentScopes),
      schemaVersion: ATTENTION_SCHEMA_VERSION,
      authority: "none",
    });
    const streamId = decisionStreamId(packet.decisionId);
    const creationEventId = randomUUID();
    const events = [
      { ...this.event(streamId, "approval.requested", packet, packet.runId), eventId: creationEventId },
      this.event(streamId, "attention.raised", attentionRaised(packet, "approval", "material"), packet.runId),
    ];
    requiredProjection(events.map((event, index) => prospectiveEvent(event, index + 1)));
    const packetSha256 = digestCanonical(packet);
    const reservationStream = approvalReservationStreamId(packet.runId, packet.approvalRequestEventId);
    const existingReservation = this.approvalReservation(packet.runId, packet.approvalRequestEventId);
    if (existingReservation !== null) {
      if (existingReservation.decisionId !== packet.decisionId || existingReservation.packetSha256 !== packetSha256) {
        this.appendRequestAttempt(packet);
        throw new Error("run approval request is already reserved by another decision");
      }
      const existingDecision = this.getDecision(packet.decisionId);
      if (existingDecision === null) throw new Error("approval reservation exists without its decision stream");
      return existingDecision;
    }
    const reservation = ApprovalReservationPayloadSchema.parse({
      schemaVersion: ATTENTION_SCHEMA_VERSION,
      runId: packet.runId,
      approvalRequestEventId: packet.approvalRequestEventId,
      decisionId: packet.decisionId,
      packetSha256,
      commandId: packet.commandId,
      authority: "none",
    });
    return this.createMaterialDecision(packet, events, [
      { streamId: runStreamId(packet.runId), expectedVersion: binding.runStreamVersion, events: [] },
      {
        streamId: reservationStream,
        expectedVersion: 0,
        events: [this.event(reservationStream, "approval.reserved", reservation, packet.runId)],
      },
    ], atomic);
  }

  raiseAgentTrailWarning(input: {
    readonly attentionId: string;
    readonly runId: string;
    readonly warningCode: string;
    readonly message: string;
    readonly evidenceSha256: string;
    readonly affectedScopes: readonly string[];
    readonly dependentScopes: readonly string[];
    readonly commandId: string;
  }): AttentionView {
    this.requireRun(input.runId);
    const streamId = advisoryAttentionStreamId(input.attentionId);
    const creationEventId = randomUUID();
    const payload = AttentionRaisedPayloadSchema.parse({
      schemaVersion: ATTENTION_SCHEMA_VERSION,
      attentionId: input.attentionId,
      decisionId: input.attentionId,
      runId: input.runId,
      source: "agenttrail",
      classification: "advisory",
      affectedScopes: canonicalSet(input.affectedScopes),
      dependentScopes: canonicalSet(input.dependentScopes),
      evidenceSha256: input.evidenceSha256,
      commandId: input.commandId,
      warningCode: input.warningCode,
      message: input.message,
      authority: "none",
    });
    return this.createReservedAttention({
      attentionId: input.attentionId,
      runId: input.runId,
      kind: "advisory",
      source: "agenttrail",
      decisionId: null,
      commandId: input.commandId,
      creationEventId,
      streamId,
      events: [{ ...this.event(streamId, "attention.raised", payload, input.runId), eventId: creationEventId }],
    });
  }

  answer(decisionId: string, input: DecisionSubmission & { readonly optionId: string }): AttentionView {
    let current = this.requireDecision(decisionId);
    if (current.kind === "approval") {
      const pending = current;
      current = this.reconcileApproval(current);
      if (current.status === "stale") {
        this.appendAttempt(pending, input, "approval.stale_attempted", "run_revision");
        throw new Error("approval packet is stale after run revision");
      }
    }
    if (current.kind !== "question") throw new Error("approval requires exact approval acceptance");
    this.validateSubmission(current, input);
    if (!current.options.some((option) => option.optionId === input.optionId)) {
      throw new Error("answer is not one of the immutable options");
    }
    return this.consume(current, input, "decision.accepted", {
      schemaVersion: ATTENTION_SCHEMA_VERSION,
      decisionId,
      runId: input.runId,
      optionId: input.optionId,
      actor: DecisionActorSchema.parse(input.actor),
      commandId: input.commandId,
      evidenceSha256: input.evidenceSha256,
      authority: "none",
    }, "accepted");
  }

  reject(decisionId: string, input: DecisionSubmission & { readonly reason: string }): AttentionView {
    let current = this.requireDecision(decisionId);
    if (current.kind === "approval") {
      const pending = current;
      current = this.reconcileApproval(current);
      if (current.status === "stale") {
        this.appendAttempt(pending, input, "approval.stale_attempted", "run_revision");
        throw new Error("approval packet is stale after run revision");
      }
    }
    this.validateSubmission(current, input);
    return this.consume(
      current,
      input,
      current.kind === "approval" ? "approval.rejected" : "decision.rejected",
      {
        schemaVersion: ATTENTION_SCHEMA_VERSION,
        decisionId,
        runId: input.runId,
        reason: input.reason,
        actor: DecisionActorSchema.parse(input.actor),
        commandId: input.commandId,
        evidenceSha256: input.evidenceSha256,
        authority: "none",
      },
      "rejected",
    );
  }

  acceptApproval(decisionId: string, input: DecisionSubmission & {
    readonly planDigest: string;
    readonly envelopeDigest: string;
  }): AttentionView {
    const actor = DecisionActorSchema.parse(input.actor);
    if (actor.kind !== "operator") throw new Error("approval acceptance requires an operator actor");
    const current = this.requireDecision(decisionId);
    if (current.kind !== "approval") throw new Error("decision is not an approval");
    this.validateSubmission(current, input);
    const packet = current.packet as ApprovalPacket;
    if (input.planDigest !== packet.planDigest || input.envelopeDigest !== packet.envelopeDigest) {
      this.appendAttempt(current, input, "approval.stale_attempted", "packet_digest");
      throw new Error("approval digest does not match the exact packet");
    }
    let binding: RunApprovalBinding;
    try {
      binding = this.currentRunApproval(current.runId);
    } catch {
      this.appendAttempt(current, input, "approval.stale_attempted", "run_revision");
      return this.staleApproval(current, input, this.observedRunBinding(current.runId, current.packet as ApprovalPacket));
    }
    if (!approvalBindingMatches(packet, binding)) {
      this.appendAttempt(current, input, "approval.stale_attempted", "run_revision");
      return this.staleApproval(current, input, binding);
    }
    return this.consumeApproval(current, input, packet);
  }

  expire(decisionId: string, expectedVersion: number): AttentionView {
    let current = this.requireDecision(decisionId);
    if (current.kind === "approval") {
      current = this.reconcileApproval(current);
      if (current.status === "stale") throw new Error("approval packet is stale after run revision");
    }
    if (expectedVersion !== current.streamVersion) {
      throw new Error(`expected version ${expectedVersion}, actual ${current.streamVersion}`);
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      if (current.status === "expired") return current;
      if (current.status !== "pending") throw new Error("decision is already consumed");
      if (current.expiryPolicy.kind === "wait_forever") throw new Error("wait-forever attention does not expire");
      const now = this.now();
      if (now.getTime() < Date.parse(current.expiryPolicy.expiresAt)) throw new Error("attention has not expired");
      const commandId = `expiry:${decisionId}:${current.expiryPolicy.expiresAt}`;
      const evidenceSha256 = (current.packet as QuestionPacket | ApprovalPacket).evidenceSha256;
      const type = current.kind === "approval" ? "approval.expired" : "decision.expired";
      const events = [
        this.event(decisionStreamId(decisionId), type, {
          schemaVersion: ATTENTION_SCHEMA_VERSION,
          decisionId,
          runId: current.runId,
          expiredAt: now.toISOString(),
          commandId,
          authority: "none",
        }, current.runId),
        this.resolvedEvent(current, commandId, evidenceSha256, null, "expired"),
      ];
      try {
        return current.material
          ? this.appendResolution(current, events, "expired")
          : this.appendProjected(current, events);
      } catch (error) {
        if (!isOptimisticConflict(error)) throw error;
        current = this.requireDecision(decisionId);
      }
    }
    throw new Error("attention expiry could not obtain a stable run index revision");
  }

  resolveAdvisory(attentionId: string, expectedVersion: number, input: {
    readonly actor: DecisionActor;
    readonly commandId: string;
    readonly evidenceSha256: string;
  }): AttentionView {
    const current = this.requireAdvisory(attentionId);
    if (current.status !== "pending") throw new Error("attention is already resolved");
    if (expectedVersion !== current.streamVersion) {
      throw new Error(`expected version ${expectedVersion}, actual ${current.streamVersion}`);
    }
    return this.appendProjected(current, [
      this.resolvedEvent(current, input.commandId, input.evidenceSha256, input.actor, "acknowledged"),
    ]);
  }

  get(decisionOrAttentionId: string): AttentionView | null {
    const decision = this.getDecision(decisionOrAttentionId);
    const advisory = this.getAdvisory(decisionOrAttentionId);
    if (decision !== null && advisory !== null) throw new Error("ambiguous attention identity; use an exact namespace");
    return decision ?? advisory;
  }

  getDecision(decisionId: string): AttentionView | null {
    return projectAttention(this.readDecisionStream(decisionId));
  }

  getAdvisory(attentionId: string): AttentionView | null {
    return projectAttention(this.readAdvisoryStream(attentionId));
  }

  poll(runId: string): readonly AttentionView[] {
    const streamIds: string[] = [];
    const seen = new Set<string>();
    for (const event of iterateAllEvents(this.journal)) {
      if (event.correlationId !== runId || seen.has(event.streamId)) continue;
      if (event.type !== "questionnaire.proposed" && event.type !== "approval.requested" && event.type !== "attention.raised") continue;
      seen.add(event.streamId);
      streamIds.push(event.streamId);
    }
    let views = streamIds.map((streamId) => requiredProjection(readStreamEvents(this.journal, streamId)));
    if (views.some((view) => view.runId !== runId)) throw new Error("attention poll encountered a cross-run stream");
    for (const view of views) {
      if (view.kind === "approval" && view.status === "pending") this.reconcileApproval(view);
    }
    views = streamIds.map((streamId) => requiredProjection(readStreamEvents(this.journal, streamId)));
    for (const view of views) {
      if (view.status !== "pending" || view.expiryPolicy.kind === "wait_forever" ||
        this.now().getTime() < Date.parse(view.expiryPolicy.expiresAt)) continue;
      try {
        this.expire(view.decisionId, view.streamVersion);
      } catch (error) {
        if (!(error instanceof Error) ||
          (!isOptimisticConflict(error) && error.message !== "decision is already consumed")) throw error;
      }
    }
    views = streamIds.map((streamId) => requiredProjection(readStreamEvents(this.journal, streamId)));
    return Object.freeze(views.filter((view) => view.status === "pending"));
  }

  attentionIndex(runId: string): AttentionIndexView {
    return projectAttentionIndex(runId, readStreamEvents(this.journal, attentionIndexStreamId(runId)));
  }

  approvalReservation(runId: string, approvalRequestEventId: string): ApprovalReservationView | null {
    return projectApprovalReservation(readStreamEvents(
      this.journal,
      approvalReservationStreamId(runId, approvalRequestEventId),
    ));
  }

  attentionIdentityReservation(attentionId: string): AttentionIdentityReservationView | null {
    return projectAttentionIdentityReservation(readStreamEvents(
      this.journal,
      attentionIdentityReservationStreamId(attentionId),
    ));
  }

  admitScope(input: {
    readonly runId: string;
    readonly admissionId: string;
    readonly scopeId: string;
    readonly dependencies: readonly string[];
    readonly commandId: string;
    readonly evidenceSha256: string;
  }): { readonly status: "admitted"; readonly revision: number } |
    { readonly status: "paused"; readonly blockingAttentionIds: readonly string[] } {
    this.poll(input.runId);
    const atomic = this.atomicJournal();
    for (let attempt = 0; attempt < 8; attempt++) {
      const index = this.attentionIndex(input.runId);
      if (index.admissionIds.includes(input.admissionId)) {
        throw new Error("scope admission identity is already consumed; callback outcome requires reconciliation");
      }
      const dependencies = canonicalSet(input.dependencies);
      const considered = new Set([input.scopeId, ...dependencies]);
      const blockers = Object.values(index.pending).filter((item) =>
        [...item.affectedScopes, ...item.dependentScopes].some((scope) => considered.has(scope)));
      if (blockers.length > 0) {
        return {
          status: "paused",
          blockingAttentionIds: Object.freeze(blockers.map((item) => item.attentionId).sort()),
        };
      }
      const streamId = attentionIndexStreamId(input.runId);
      const payload = ScopeAdmissionPayloadSchema.parse({
        schemaVersion: ATTENTION_SCHEMA_VERSION,
        runId: input.runId,
        admissionId: input.admissionId,
        scopeId: input.scopeId,
        dependencies,
        attentionRevision: index.revision,
        evidenceSha256: input.evidenceSha256,
        commandId: input.commandId,
        authority: "none",
      });
      try {
        atomic.appendAtomically([{
          streamId,
          expectedVersion: index.revision,
          events: [this.event(streamId, "attention.scope_admitted", payload, input.runId)],
        }]);
        return { status: "admitted", revision: index.revision + 1 };
      } catch (error) {
        if (!isOptimisticConflict(error)) throw error;
      }
    }
    throw new Error("scope admission could not obtain a stable attention revision");
  }

  pausedScopes(runId: string): readonly string[] {
    return Object.freeze(canonicalSet(this.poll(runId)
      .filter((attention) => attention.material)
      .flatMap((attention) => [...attention.affectedScopes, ...attention.dependentScopes])));
  }

  readDecisionStream(decisionId: string): readonly StoredEvent[] {
    return readStreamEvents(this.journal, decisionStreamId(decisionId));
  }

  readAdvisoryStream(attentionId: string): readonly StoredEvent[] {
    return readStreamEvents(this.journal, advisoryAttentionStreamId(attentionId));
  }

  readStream(decisionOrAttentionId: string): readonly StoredEvent[] {
    const decision = this.readDecisionStream(decisionOrAttentionId);
    const advisory = this.readAdvisoryStream(decisionOrAttentionId);
    if (decision.length > 0 && advisory.length > 0) throw new Error("ambiguous attention identity; use an exact namespace");
    return decision.length > 0 ? decision : advisory;
  }

  readAttempts(decisionId: string): readonly StoredEvent[] {
    const attempts: StoredEvent[] = [];
    for (const event of iterateAllEvents(this.journal)) {
      if (!isAttemptEvent(event.type)) continue;
      const payload = AttemptPayloadSchema.parse(event.payload);
      if (payload.decisionId !== decisionId) continue;
      const parsed = parseDecisionAttemptStreamId(event.streamId);
      if (parsed.decisionId !== payload.decisionId || parsed.commandId !== payload.commandId ||
        event.streamId !== decisionAttemptStreamId(payload.decisionId, payload.commandId) || event.correlationId !== payload.runId) {
        throw new Error("decision attempt stream identity is contradictory");
      }
      attempts.push(event);
    }
    return Object.freeze(attempts);
  }

  readAttemptStream(decisionId: string, commandId: string): readonly StoredEvent[] {
    const streamId = decisionAttemptStreamId(decisionId, commandId);
    const events = readStreamEvents(this.journal, streamId);
    for (const event of events) {
      const payload = AttemptPayloadSchema.parse(event.payload);
      if (payload.decisionId !== decisionId || payload.commandId !== commandId || event.streamId !== streamId) {
        throw new Error("decision attempt stream identity is contradictory");
      }
    }
    return events;
  }

  private create(streamId: string, events: readonly NewEvent<string, unknown>[]): AttentionView {
    requiredProjection(events.map((event, index) => prospectiveEvent(event, index + 1)));
    return requiredProjection(this.journal.append(streamId, 0, events));
  }

  private consume(
    initial: AttentionView,
    input: DecisionSubmission,
    type: string,
    payload: unknown,
    resolution: "accepted" | "rejected",
  ): AttentionView {
    let current = initial;
    for (let attempt = 0; attempt < 8; attempt++) {
      const events = [
        this.event(decisionStreamId(current.decisionId), type, payload, current.runId),
        this.resolvedEvent(current, input.commandId, input.evidenceSha256, input.actor, resolution),
      ];
      try {
        return current.material
          ? this.appendResolution(current, events, resolution)
          : this.appendProjected(current, events);
      } catch (error) {
        if (!isOptimisticConflict(error) && !isTransientJournalConflict(error) && !isDecisionResolutionRace(error)) throw error;
        const latest = this.requireDecision(current.decisionId);
        if (latest.status === "pending" && attempt < 7) {
          if (isTransientJournalConflict(error)) sleepForRetry(attempt);
          current = latest;
          continue;
        }
        this.appendAttempt(latest, input, `${current.kind === "approval" ? "approval" : "decision"}.duplicate_attempted`, "already_consumed");
        throw new Error("decision is already consumed");
      }
    }
    throw new Error("decision optimistic retry exhausted");
  }

  private consumeApproval(current: AttentionView, input: DecisionSubmission & {
    readonly planDigest: string;
    readonly envelopeDigest: string;
  }, packet: ApprovalPacket): AttentionView {
    const atomic = this.atomicJournal();
    let decision = current;
    for (let attempt = 0; attempt < 8; attempt++) {
      const streamId = decisionStreamId(decision.decisionId);
      const approvalDecisionEventId = randomUUID();
      const approvalPacketSha256 = digestCanonical(packet);
      const events = [
        {
          ...this.event(streamId, "approval.accepted", {
          schemaVersion: ATTENTION_SCHEMA_VERSION,
          decisionId: decision.decisionId,
          runId: input.runId,
          planDigest: input.planDigest,
          envelopeDigest: input.envelopeDigest,
          approvalRequestEventId: packet.approvalRequestEventId,
          approvalPacketSha256,
          actor: DecisionActorSchema.parse(input.actor),
          commandId: input.commandId,
          evidenceSha256: input.evidenceSha256,
          authority: "none",
          }, decision.runId),
          eventId: approvalDecisionEventId,
        },
        this.resolvedEvent(decision, input.commandId, input.evidenceSha256, input.actor, "accepted"),
      ];
      const readyPayload = RunReadyPayloadSchema.parse({
        schemaVersion: RUN_SCHEMA_VERSION,
        commandId: input.commandId,
        planDigest: packet.planDigest,
        envelopeDigest: packet.envelopeDigest,
        approvalDecisionId: decision.decisionId,
        approvalDecisionEventId,
        approvalRequestEventId: packet.approvalRequestEventId,
        approvalPacketSha256,
        executionAuthority: "none",
      });
      const readyEvent = {
        ...this.event(runStreamId(packet.runId), "run.ready_for_execution", readyPayload, packet.runId),
        eventId: randomUUID(),
        causationId: approvalDecisionEventId,
      };
      const existingRunEvents = this.requireRun(packet.runId);
      projectRun([
        ...existingRunEvents,
        prospectiveEvent(readyEvent, packet.runStreamVersion + 1),
      ]);
      requiredProjection([
        ...this.readDecisionStream(decision.decisionId),
        ...events.map((event, index) => prospectiveEvent(event, decision.streamVersion + index + 1)),
      ]);
      try {
        return this.appendResolution(decision, events, "accepted", [{
          streamId: runStreamId(packet.runId), expectedVersion: packet.runStreamVersion, events: [readyEvent],
        }], atomic);
      } catch (error) {
        if (!isOptimisticConflict(error) && !isTransientJournalConflict(error) && !isDecisionResolutionRace(error)) throw error;
        const latest = this.requireDecision(decision.decisionId);
        if (latest.status !== "pending") {
          this.appendAttempt(latest, input, "approval.duplicate_attempted", "already_consumed");
          throw new Error("decision is already consumed");
        }
        let binding: RunApprovalBinding;
        try {
          binding = this.currentRunApproval(packet.runId);
        } catch {
          this.appendAttempt(latest, input, "approval.stale_attempted", "run_revision");
          return this.staleApproval(latest, input, this.observedRunBinding(packet.runId, packet));
        }
        if (!approvalBindingMatches(packet, binding)) {
          this.appendAttempt(latest, input, "approval.stale_attempted", "run_revision");
          return this.staleApproval(latest, input, binding);
        }
        if (attempt < 7) {
          if (isTransientJournalConflict(error)) sleepForRetry(attempt);
          decision = latest;
          continue;
        }
        throw new Error("approval optimistic retry exhausted");
      }
    }
    throw new Error("approval optimistic retry exhausted");
  }

  private validateSubmission(current: AttentionView, input: DecisionSubmission): void {
    DecisionActorSchema.parse(input.actor);
    if (!Digest.test(input.evidenceSha256)) throw new Error("decision evidence digest is invalid");
    if (input.runId !== current.runId) {
      this.appendAttempt(current, { ...input, runId: current.runId }, `${current.kind === "approval" ? "approval" : "decision"}.stale_attempted`, "cross_run");
      throw new Error("decision belongs to a different run");
    }
    if (current.status !== "pending") {
      this.appendAttempt(current, input, `${current.kind === "approval" ? "approval" : "decision"}.duplicate_attempted`, "already_consumed");
      throw new Error("decision is already consumed");
    }
    if (current.expiryPolicy.kind === "at" && this.now().getTime() >= Date.parse(current.expiryPolicy.expiresAt)) {
      this.expire(current.decisionId, current.streamVersion);
      throw new Error("decision has expired");
    }
    if (input.expectedVersion !== current.streamVersion) {
      this.appendAttempt(current, input, `${current.kind === "approval" ? "approval" : "decision"}.stale_attempted`, "optimistic_version");
      throw new Error(`expected version ${input.expectedVersion}, actual ${current.streamVersion}`);
    }
  }

  private appendAttempt(
    current: AttentionView,
    input: Omit<DecisionSubmission, "expectedVersion">,
    type: string,
    reason: AttemptPayload["reason"],
  ): void {
    this.appendAttemptRecord({
      decisionId: current.decisionId,
      runId: current.runId,
      commandId: input.commandId,
      actor: input.actor,
      evidenceSha256: input.evidenceSha256,
      type,
      reason,
    });
  }

  private appendRequestAttempt(packet: ApprovalPacket): void {
    this.appendAttemptRecord({
      decisionId: packet.decisionId,
      runId: packet.runId,
      commandId: packet.commandId,
      actor: { actorId: "zentra-approval-reservation", kind: "service", channel: "api" },
      evidenceSha256: packet.evidenceSha256,
      type: "approval.duplicate_attempted",
      reason: "already_consumed",
    });
  }

  private appendAttemptRecord(input: {
    readonly decisionId: string;
    readonly runId: string;
    readonly commandId: string;
    readonly actor: DecisionActor;
    readonly evidenceSha256: string;
    readonly type: string;
    readonly reason: AttemptPayload["reason"];
  }): void {
    const streamId = decisionAttemptStreamId(input.decisionId, input.commandId);
    const payload = AttemptPayloadSchema.parse({
      schemaVersion: ATTENTION_SCHEMA_VERSION,
      decisionId: input.decisionId,
      runId: input.runId,
      commandId: input.commandId,
      actor: DecisionActorSchema.parse(input.actor),
      reason: input.reason,
      evidenceSha256: input.evidenceSha256,
      authority: "none",
    });
    const event = this.event(streamId, input.type, payload, input.runId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = readStreamEvents(this.journal, streamId);
      if (existing.length > 0) {
        if (existing.length === 1 && existing[0]!.type === input.type && JSON.stringify(existing[0]!.payload) === JSON.stringify(payload)) return;
        throw new Error("decision attempt command identity was reused with different evidence");
      }
      try {
        this.journal.append(streamId, 0, [event]);
        return;
      } catch (error) {
        if (!isOptimisticConflict(error) && !isTransientJournalConflict(error)) throw error;
        if (isTransientJournalConflict(error)) sleepForRetry(attempt);
      }
    }
    throw new Error("decision attempt audit could not be durably appended");
  }

  private createReservedAttention(input: {
    readonly attentionId: string;
    readonly runId: string;
    readonly kind: "question" | "approval" | "advisory";
    readonly source: "questionnaire" | "approval" | "agenttrail";
    readonly decisionId: string | null;
    readonly commandId: string;
    readonly creationEventId: string;
    readonly streamId: string;
    readonly events: readonly NewEvent<string, unknown>[];
  }): AttentionView {
    const atomic = this.atomicJournal();
    if (this.attentionIdentityReservation(input.attentionId) !== null) {
      throw new Error(`attention identity ${input.attentionId} is already globally reserved`);
    }
    requiredProjection(input.events.map((event, index) => prospectiveEvent(event, index + 1)));
    const reservation = this.attentionIdentityReservationWrite(input);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        atomic.appendAtomically([
          reservation,
          { streamId: input.streamId, expectedVersion: 0, events: input.events },
        ]);
        return requiredProjection(readStreamEvents(this.journal, input.streamId));
      } catch (error) {
        if (this.attentionIdentityReservation(input.attentionId) !== null) {
          throw new Error(`attention identity ${input.attentionId} is already globally reserved`);
        }
        if (!isTransientJournalConflict(error)) throw error;
        sleepForRetry(attempt);
      }
    }
    throw new Error("attention identity reservation could not be durably appended");
  }

  private attentionIdentityReservationWrite(input: {
    readonly attentionId: string;
    readonly runId: string;
    readonly kind: "question" | "approval" | "advisory";
    readonly source: "questionnaire" | "approval" | "agenttrail";
    readonly decisionId: string | null;
    readonly commandId: string;
    readonly creationEventId: string;
  }): AtomicAppend {
    const streamId = attentionIdentityReservationStreamId(input.attentionId);
    const payload = AttentionIdentityReservationPayloadSchema.parse({
      schemaVersion: ATTENTION_SCHEMA_VERSION,
      attentionId: input.attentionId,
      runId: input.runId,
      kind: input.kind,
      source: input.source,
      decisionId: input.decisionId,
      creationEventId: input.creationEventId,
      commandId: input.commandId,
      authority: "none",
    });
    return {
      streamId,
      expectedVersion: 0,
      events: [{
        ...this.event(streamId, "attention.identity_reserved", payload, input.runId),
        causationId: input.creationEventId,
      }],
    };
  }

  private createMaterialDecision(
    packet: QuestionPacket | ApprovalPacket,
    events: readonly NewEvent<string, unknown>[],
    additionalWrites: readonly AtomicAppend[] = [],
    atomic = this.atomicJournal(),
  ): AttentionView {
    const decisionStream = decisionStreamId(packet.decisionId);
    const creationEventId = events[0]?.eventId;
    if (creationEventId === undefined) throw new Error("material attention creation requires a preassigned event identity");
    requiredProjection(events.map((event, index) => prospectiveEvent(event, index + 1)));
    for (let attempt = 0; attempt < 8; attempt++) {
      if (this.attentionIdentityReservation(packet.attentionId) !== null) {
        throw new Error(`attention identity ${packet.attentionId} is already globally reserved`);
      }
      const index = this.attentionIndex(packet.runId);
      if (index.knownAttentionIds.includes(packet.attentionId)) {
        throw new Error(`attention identity ${packet.attentionId} is already known in run ${packet.runId}`);
      }
      const indexStream = attentionIndexStreamId(packet.runId);
      const raised = AttentionIndexRaisedPayloadSchema.parse({
        schemaVersion: ATTENTION_SCHEMA_VERSION,
        runId: packet.runId,
        attentionId: packet.attentionId,
        decisionId: packet.decisionId,
        affectedScopes: packet.affectedScopes,
        dependentScopes: packet.dependentScopes,
        commandId: packet.commandId,
        authority: "none",
      });
      try {
        atomic.appendAtomically([
          this.attentionIdentityReservationWrite({
            attentionId: packet.attentionId,
            runId: packet.runId,
            kind: "approvalRequestEventId" in packet ? "approval" : "question",
            source: "approvalRequestEventId" in packet ? "approval" : "questionnaire",
            decisionId: packet.decisionId,
            commandId: packet.commandId,
            creationEventId,
          }),
          ...additionalWrites,
          { streamId: decisionStream, expectedVersion: 0, events },
          {
            streamId: indexStream,
            expectedVersion: index.revision,
            events: [this.event(indexStream, "attention.index_raised", raised, packet.runId)],
          },
        ]);
        return requiredProjection(this.readDecisionStream(packet.decisionId));
      } catch (error) {
        if (!isOptimisticConflict(error) && !isTransientJournalConflict(error)) throw error;
        if (this.attentionIdentityReservation(packet.attentionId) !== null) {
          throw new Error(`attention identity ${packet.attentionId} is already globally reserved`);
        }
        if (this.readDecisionStream(packet.decisionId).length > 0) throw error;
        if ("approvalRequestEventId" in packet) {
          const reservation = this.approvalReservation(packet.runId, packet.approvalRequestEventId);
          if (reservation !== null && reservation.decisionId !== packet.decisionId) {
            this.appendRequestAttempt(packet);
            throw new Error("run approval request is already reserved by another decision");
          }
        }
        for (const write of additionalWrites) {
          const actual = readStreamEvents(this.journal, write.streamId).at(-1)?.streamVersion ?? 0;
          if (actual !== write.expectedVersion) throw error;
        }
        if (isTransientJournalConflict(error)) sleepForRetry(attempt);
      }
    }
    throw new Error("material attention could not obtain a stable run index revision");
  }

  private appendResolution(
    current: AttentionView,
    events: readonly NewEvent<string, unknown>[],
    resolution: "accepted" | "rejected" | "expired" | "stale",
    additionalWrites: readonly AtomicAppend[] = [],
    atomic = this.atomicJournal(),
  ): AttentionView {
    const index = this.attentionIndex(current.runId);
    const indexed = index.pending[current.attentionId];
    if (indexed?.decisionId !== current.decisionId) {
      throw new Error("material attention is missing from its authoritative run index");
    }
    const indexStream = attentionIndexStreamId(current.runId);
    const payload = AttentionIndexResolvedPayloadSchema.parse({
      schemaVersion: ATTENTION_SCHEMA_VERSION,
      runId: current.runId,
      attentionId: current.attentionId,
      decisionId: current.decisionId,
      resolution,
      commandId: commandIdFromEvent(events[0]!),
      authority: "none",
    });
    const history = this.readDecisionStream(current.decisionId);
    const actualDecisionVersion = history.at(-1)?.streamVersion ?? 0;
    if (actualDecisionVersion !== current.streamVersion) {
      throw new Error(`expected version ${current.streamVersion}, actual ${actualDecisionVersion}`);
    }
    requiredProjection([
      ...history,
      ...events.map((event, eventIndex) => prospectiveEvent(event, current.streamVersion + eventIndex + 1)),
    ]);
    const reservationWrites: AtomicAppend[] = [];
    if (current.kind === "approval") {
      const packet = current.packet as ApprovalPacket;
      const reservation = this.approvalReservation(packet.runId, packet.approvalRequestEventId);
      if (reservation === null || reservation.decisionId !== current.decisionId ||
        reservation.packetSha256 !== digestCanonical(packet) || reservation.status !== "reserved") {
        throw new Error("approval decision does not own the current request reservation");
      }
      const reservationStream = approvalReservationStreamId(packet.runId, packet.approvalRequestEventId);
      const consumed = ApprovalReservationConsumedPayloadSchema.parse({
        schemaVersion: ATTENTION_SCHEMA_VERSION,
        runId: packet.runId,
        approvalRequestEventId: packet.approvalRequestEventId,
        decisionId: current.decisionId,
        outcome: resolution,
        commandId: commandIdFromEvent(events[0]!),
        authority: "none",
      });
      reservationWrites.push({
        streamId: reservationStream,
        expectedVersion: reservation.streamVersion,
        events: [this.event(reservationStream, "approval.reservation_consumed", consumed, packet.runId)],
      });
    }
    atomic.appendAtomically([
      { streamId: decisionStreamId(current.decisionId), expectedVersion: current.streamVersion, events },
      ...reservationWrites,
      {
        streamId: indexStream,
        expectedVersion: index.revision,
        events: [this.event(indexStream, "attention.index_resolved", payload, current.runId)],
      },
      ...additionalWrites,
    ]);
    return requiredProjection(this.readDecisionStream(current.decisionId));
  }

  private appendProjected(current: AttentionView, events: readonly NewEvent<string, unknown>[]): AttentionView {
    const history = this.readExactStream(current);
    if ((history.at(-1)?.streamVersion ?? 0) === current.streamVersion) {
      requiredProjection([
        ...history,
        ...events.map((event, index) => prospectiveEvent(event, current.streamVersion + index + 1)),
      ]);
    }
    this.journal.append(events[0]!.streamId, current.streamVersion, events);
    return requiredProjection(this.readExactStream(current));
  }

  private staleApproval(current: AttentionView, input: DecisionSubmission, binding: RunApprovalBinding): never {
    this.markApprovalStale(current, input, binding);
    throw new Error("approval packet is stale after run revision");
  }

  private markApprovalStale(
    initial: AttentionView,
    input: Omit<DecisionSubmission, "expectedVersion">,
    binding: RunApprovalBinding,
  ): AttentionView {
    let current = initial;
    const packet = current.packet as ApprovalPacket;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (current.status === "stale") return current;
      if (current.status !== "pending") return current;
      const streamId = decisionStreamId(current.decisionId);
      try {
        return this.appendResolution(current, [
          this.event(streamId, "approval.stale", {
          schemaVersion: ATTENTION_SCHEMA_VERSION,
          decisionId: current.decisionId,
          runId: current.runId,
          requestedPlanDigest: packet.planDigest,
          requestedEnvelopeDigest: packet.envelopeDigest,
          currentPlanDigest: binding.planDigest,
          currentEnvelopeDigest: binding.envelopeDigest,
          commandId: input.commandId,
          evidenceSha256: input.evidenceSha256,
          authority: "none",
          }, current.runId),
          this.resolvedEvent(current, input.commandId, input.evidenceSha256, input.actor, "stale"),
        ], "stale");
      } catch (error) {
        if (!isOptimisticConflict(error)) throw error;
        current = this.requireDecision(current.decisionId);
      }
    }
    throw new Error("approval stale reconciliation could not obtain a stable index revision");
  }

  private reconcileApproval(current: AttentionView): AttentionView {
    if (current.kind !== "approval" || current.status !== "pending") return current;
    const packet = current.packet as ApprovalPacket;
    let binding: RunApprovalBinding;
    try {
      binding = this.currentRunApproval(current.runId);
      if (approvalBindingMatches(packet, binding)) return current;
    } catch {
      binding = this.observedRunBinding(current.runId, packet);
    }
    return this.markApprovalStale(current, {
      runId: current.runId,
      actor: { actorId: "zentra-attention-reconciler", kind: "service", channel: "api" },
      commandId: `reconcile:${current.decisionId}:${binding.runStreamVersion}`,
      evidenceSha256: packet.evidenceSha256,
    }, binding);
  }

  private resolvedEvent(
    current: AttentionView,
    commandId: string,
    evidenceSha256: string,
    actor: DecisionActor | null,
    resolution: "accepted" | "rejected" | "expired" | "stale" | "acknowledged",
  ): NewEvent<string, unknown> {
    const streamId = current.kind === "advisory"
      ? advisoryAttentionStreamId(current.attentionId)
      : decisionStreamId(current.decisionId);
    return this.event(streamId, "attention.resolved", {
      schemaVersion: ATTENTION_SCHEMA_VERSION,
      attentionId: current.attentionId,
      decisionId: current.decisionId,
      runId: current.runId,
      resolution,
      commandId,
      evidenceSha256,
      actor: actor === null ? null : DecisionActorSchema.parse(actor),
      authority: "none",
    }, current.runId);
  }

  private currentRunApproval(runId: string): RunApprovalBinding {
    const events = this.requireRun(runId);
    const run = projectRun(events);
    if (run?.lifecycle !== "awaiting_approval") {
      throw new Error(`run ${runId} is not exactly awaiting approval`);
    }
    const accepted = RunAcceptedPayloadSchema.parse(events[0]!.payload);
    const event = events.at(-1)!;
    if (event.type !== "run.approval_requested") {
      throw new Error("run current approval request is not its latest event");
    }
    const payload = RunApprovalRequestedPayloadSchema.parse(event.payload);
    if (event.streamId !== runStreamId(runId) || event.correlationId !== runId ||
      run.authority.planDigest !== payload.planDigest || run.authority.envelopeDigest !== payload.envelopeDigest) {
      throw new Error("run approval packet identity, digest, or revision is contradictory");
    }
    return {
      runStreamVersion: event.streamVersion,
      approvalRequestEventId: event.eventId,
      projectRevision: accepted.projectRevision,
      planDigest: payload.planDigest,
      envelopeDigest: payload.envelopeDigest,
    };
  }

  private observedRunBinding(runId: string, packet: ApprovalPacket): RunApprovalBinding {
    const events = this.requireRun(runId);
    const run = projectRun(events);
    if (run === null) throw new Error(`run ${runId} not found`);
    const latestRequest = [...events].reverse().find((event) => event.type === "run.approval_requested");
    const payload = latestRequest === undefined ? null : RunApprovalRequestedPayloadSchema.parse(latestRequest.payload);
    return {
      runStreamVersion: events.at(-1)!.streamVersion,
      approvalRequestEventId: latestRequest?.eventId ?? packet.approvalRequestEventId,
      projectRevision: run.projectRevision,
      planDigest: payload?.planDigest ?? packet.planDigest,
      envelopeDigest: payload?.envelopeDigest ?? packet.envelopeDigest,
    };
  }

  private requireRun(runId: string): readonly StoredEvent[] {
    const events = readStreamEvents(this.journal, runStreamId(runId));
    if (events.length === 0) throw new Error(`run ${runId} not found`);
    return events;
  }

  private requireDecision(decisionId: string): AttentionView {
    const attention = this.getDecision(decisionId);
    if (attention === null) throw new Error(`decision ${decisionId} not found`);
    return attention;
  }

  private requireAdvisory(attentionId: string): AttentionView {
    const attention = this.getAdvisory(attentionId);
    if (attention === null) throw new Error(`advisory attention ${attentionId} not found`);
    return attention;
  }

  private readExactStream(view: AttentionView): readonly StoredEvent[] {
    return view.kind === "advisory"
      ? this.readAdvisoryStream(view.attentionId)
      : this.readDecisionStream(view.decisionId);
  }

  private atomicJournal(): AtomicEventJournal {
    if (!isAtomicEventJournal(this.journal)) throw new Error("exact approval requires an atomic event journal");
    return this.journal;
  }

  private now(): Date {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("trusted attention clock returned an invalid time");
    return new Date(now.getTime());
  }

  private event(streamId: string, type: string, payload: unknown, correlationId: string): NewEvent<string, unknown> {
    return { streamId, type, payload: canonical(payload), causationId: null, correlationId };
  }
}

function attentionRaised(
  packet: QuestionPacket | ApprovalPacket,
  source: "questionnaire" | "approval",
  classification: "material" | "advisory",
): ReturnType<typeof AttentionRaisedPayloadSchema.parse> {
  return AttentionRaisedPayloadSchema.parse({
    schemaVersion: ATTENTION_SCHEMA_VERSION,
    attentionId: packet.attentionId,
    decisionId: packet.decisionId,
    runId: packet.runId,
    source,
    classification,
    affectedScopes: packet.affectedScopes,
    dependentScopes: packet.dependentScopes,
    evidenceSha256: packet.evidenceSha256,
    commandId: packet.commandId,
    warningCode: null,
    message: null,
    authority: "none",
  });
}

function approvalBindingMatches(packet: ApprovalPacket, binding: RunApprovalBinding): boolean {
  return packet.runStreamVersion === binding.runStreamVersion &&
    packet.approvalRequestEventId === binding.approvalRequestEventId &&
    JSON.stringify(packet.projectRevision) === JSON.stringify(binding.projectRevision) &&
    packet.planDigest === binding.planDigest && packet.envelopeDigest === binding.envelopeDigest;
}

function requiredProjection(events: readonly StoredEvent[]): AttentionView {
  const attention = projectAttention(events);
  if (attention === null) throw new Error("attention projection unexpectedly returned null");
  return attention;
}

function prospectiveEvent(event: NewEvent<string, unknown>, streamVersion: number): StoredEvent {
  return {
    ...event,
    eventId: event.eventId ?? `prospective-${streamVersion}`,
    streamVersion,
    globalPosition: 0,
    recordedAt: "1970-01-01T00:00:00.000Z",
  };
}

function canonicalSet(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function canonical(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("attention event payload must be JSON-serializable");
  return JSON.parse(serialized) as unknown;
}

function commandIdFromEvent(event: NewEvent<string, unknown>): string {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new Error("attention resolution event has no command identity");
  }
  const commandId = (event.payload as Readonly<Record<string, unknown>>)["commandId"];
  if (typeof commandId !== "string") throw new Error("attention resolution event has no command identity");
  return commandId;
}

function isAttemptEvent(type: string): boolean {
  return type === "decision.stale_attempted" || type === "decision.duplicate_attempted" ||
    type === "approval.stale_attempted" || type === "approval.duplicate_attempted";
}

function isOptimisticConflict(error: unknown): boolean {
  return error instanceof Error && /^expected version \d+, actual \d+$/.test(error.message);
}

function isTransientJournalConflict(error: unknown): boolean {
  return error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message);
}

function isDecisionResolutionRace(error: unknown): boolean {
  return error instanceof Error && error.message === "material attention is missing from its authoritative run index";
}

function sleepForRetry(attempt: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, Math.min(5 * (attempt + 1), 25));
}
