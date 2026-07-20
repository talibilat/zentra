import type { StoredEvent } from "../contracts/event.js";
import {
  CorrectionProposedPayloadSchema,
  PlanProposedPayloadSchema,
  PlanRejectedPayloadSchema,
  PlanRevisedPayloadSchema,
  planningStreamId,
  type PlanningArtifact,
  type PlanningAuthorityEnvelope,
} from "./planning-contracts.js";

export interface PlanningView extends PlanningArtifact {
  readonly runId: string;
  readonly lifecycle: "proposed" | "rejected" | "correction_pending";
  readonly revision: number;
  readonly streamVersion: number;
  readonly rejection: ReturnType<typeof PlanRejectedPayloadSchema.parse> | null;
  readonly correctionBounds: PlanningAuthorityEnvelope | null;
}

export function projectPlanning(events: readonly StoredEvent[]): PlanningView | null {
  if (events.length === 0) return null;
  const first = events[0]!;
  if (first.type !== "plan.proposed") throw new Error("first planning event must be plan.proposed");
  const proposed = PlanProposedPayloadSchema.parse(first.payload);
  const expectedStreamId = planningStreamId(proposed.proposal.runId);
  if (first.causationId !== proposed.proposal.analysisEvidence.completionEventId) {
    throw new Error("initial planning proposal is not caused by its analysis completion");
  }
  let artifact: PlanningArtifact = proposed;
  let revision = proposed.revision;
  let lifecycle: PlanningView["lifecycle"] = "proposed";
  let rejection: PlanningView["rejection"] = null;
  let correctionBounds: PlanningAuthorityEnvelope | null = null;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.streamId !== expectedStreamId || event.streamVersion !== index + 1 ||
      event.correlationId !== proposed.proposal.runId) {
      throw new Error("planning event metadata is not contiguous or bound to the run");
    }
    if (index === 0) continue;
    switch (event.type) {
      case "plan.revised": {
        const payload = PlanRevisedPayloadSchema.parse(event.payload);
        if (payload.revision !== revision + 1 || payload.priorPlanDigest !== artifact.planDigest ||
          payload.priorEnvelopeDigest !== artifact.envelopeDigest ||
          payload.proposal.runId !== proposed.proposal.runId ||
          payload.proposal.projectId !== proposed.proposal.projectId ||
          JSON.stringify(payload.proposal.projectRevision) !== JSON.stringify(proposed.proposal.projectRevision) ||
          event.causationId !== payload.proposal.analysisEvidence.completionEventId) {
          throw new Error("planning revision does not bind the prior proposal");
        }
        artifact = payload;
        revision = payload.revision;
        lifecycle = "proposed";
        rejection = null;
        correctionBounds = null;
        break;
      }
      case "plan.rejected": {
        const payload = PlanRejectedPayloadSchema.parse(event.payload);
        if (lifecycle !== "proposed" || payload.revision !== revision ||
          payload.planDigest !== artifact.planDigest || payload.envelopeDigest !== artifact.envelopeDigest) {
          throw new Error("plan rejection does not bind the current proposal");
        }
        if (event.causationId !== payload.decisionEventId) {
          throw new Error("plan rejection is not caused by its exact decision");
        }
        lifecycle = "rejected";
        rejection = payload;
        break;
      }
      case "correction.proposed": {
        const payload = CorrectionProposedPayloadSchema.parse(event.payload);
        if (lifecycle !== "rejected" || payload.revision !== revision ||
          payload.rejectedPlanDigest !== artifact.planDigest ||
          payload.rejectedEnvelopeDigest !== artifact.envelopeDigest ||
          JSON.stringify(payload.bounds) !== JSON.stringify(artifact.envelope)) {
          throw new Error("correction bounds do not bind the rejected proposal");
        }
        if (rejection === null || event.causationId !== rejection.decisionEventId) {
          throw new Error("correction proposal is not caused by its exact rejection");
        }
        lifecycle = "correction_pending";
        correctionBounds = payload.bounds;
        break;
      }
      default:
        throw new Error(`unknown planning event type ${event.type}`);
    }
  }

  return Object.freeze({
    ...artifact,
    runId: proposed.proposal.runId,
    lifecycle,
    revision,
    streamVersion: events.length,
    rejection,
    correctionBounds,
  });
}
