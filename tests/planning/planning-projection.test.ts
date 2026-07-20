import { describe, expect, it } from "vitest";

import type { StoredEvent } from "../../src/contracts/event.js";
import { projectPlanning } from "../../src/planning/planning-projection.js";
import { buildPlanningArtifact } from "../../src/planning/planning-contracts.js";
import { planningProposalFixture, runBudgetFixture } from "./planning-fixture.js";

function event(type: string, payload: unknown, version: number): StoredEvent {
  const cause = type === "plan.rejected"
    ? (payload as { decisionEventId: string }).decisionEventId
    : type === "correction.proposed"
      ? "decision-event-1"
      : "00000000-0000-4000-8000-000000000093";
  return {
    streamId: "planning:run-93",
    type,
    payload,
    causationId: cause,
    correlationId: "run-93",
    eventId: `event-${version}`,
    streamVersion: version,
    globalPosition: version,
    recordedAt: "2026-07-20T00:00:00.000Z",
  };
}

describe("projectPlanning", () => {
  it("replays proposal, rejection, and bounded correction state", () => {
    const artifact = buildPlanningArtifact(planningProposalFixture(), runBudgetFixture, 1);
    const proposed = {
      schemaVersion: 1,
      revision: 1,
      ...artifact,
      commandId: "propose-1",
      authority: "none",
    };
    const rejected = {
      schemaVersion: 1,
      revision: 1,
      decisionId: "approval-1",
      approvalRequestEventId: "request-1",
      decisionEventId: "decision-event-1",
      reason: "Reduce the write scope.",
      reasonEvidenceSha256: "9".repeat(64),
      planDigest: artifact.planDigest,
      envelopeDigest: artifact.envelopeDigest,
      commandId: "reject-1",
      authority: "none",
    };
    const correction = {
      schemaVersion: 1,
      revision: 1,
      rejectedPlanDigest: artifact.planDigest,
      rejectedEnvelopeDigest: artifact.envelopeDigest,
      bounds: artifact.envelope,
      commandId: "correction-1",
      authority: "none",
    };

    const view = projectPlanning([
      event("plan.proposed", proposed, 1),
      event("plan.rejected", rejected, 2),
      event("correction.proposed", correction, 3),
    ]);

    expect(view).toMatchObject({ lifecycle: "correction_pending", revision: 1 });
    expect(view?.rejection?.reason).toBe("Reduce the write scope.");
    expect(view?.correctionBounds?.planDigest).toBe(artifact.envelope.planDigest);
    expect(Object.isFrozen(view)).toBe(true);
  });

  it("fails closed on unknown and non-contiguous events", () => {
    const artifact = buildPlanningArtifact(planningProposalFixture(), runBudgetFixture, 1);
    const payload = { schemaVersion: 1, revision: 1, ...artifact, commandId: "propose-1", authority: "none" };
    expect(() => projectPlanning([event("plan.proposed", payload, 1), event("unknown", {}, 2)]))
      .toThrow(/unknown/i);
    expect(() => projectPlanning([{ ...event("plan.proposed", payload, 1), streamVersion: 2 }]))
      .toThrow(/contiguous/i);
    expect(() => projectPlanning([{ ...event("plan.proposed", payload, 1), causationId: "wrong-analysis" }]))
      .toThrow(/analysis completion/i);
  });
});
