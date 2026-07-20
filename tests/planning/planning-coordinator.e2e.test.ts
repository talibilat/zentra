import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttentionService } from "../../src/attention/attention-service.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { PlanningCoordinator } from "../../src/planning/planning-coordinator.js";
import { PLANNING_SCHEMA_VERSION, PlanRevisedPayloadSchema, buildPlanningArtifact, planningStreamId } from "../../src/planning/planning-contracts.js";
import { createValidationIdentitySnapshot, APPROVED_VALIDATION_EXECUTABLE, ProjectConfigSchema } from "../../src/projects/project-config.js";
import { RunService } from "../../src/runs/run-service.js";
import { planningProposalFixture } from "./planning-fixture.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-planning-"));
  cleanup.push(directory);
  const databasePath = path.join(directory, "events.sqlite");
  const journal = new SqliteEventJournal(databasePath);
  seedPlanningRun(journal);
  const project = ProjectConfigSchema.parse({
    projectId: "zentra",
    repositoryPath: directory,
    worktreeRoot: path.join(directory, "worktrees"),
    validations: {
      focused: [APPROVED_VALIDATION_EXECUTABLE, "--test"],
      full: [APPROVED_VALIDATION_EXECUTABLE, "--test"],
    },
  });
  const proposal = planningProposalFixture();
  proposal.analysisEvidence.completionEventId = analysisCompletionEventId;
  const security = {
    allowedRepositories: [directory],
    allowedFileScopes: ["src/**"],
    forbiddenPaths: ["secrets"],
    network: { default: "denied" as const, allowedDestinations: [] },
    secretHandling: ["Never expose secrets."],
    approvalRequiredOperations: ["external_effect"],
    releaseBoundary: "no_release_operations",
    stopAndAskConditions: ["forbidden_file_scope"],
  };
  const capabilities = [{ capabilityId: "worker-1", agentId: "worker-1", role: "implementer" as const, harness: "deterministic" as const }];
  proposal.securityDigest = digestCanonical(security);
  proposal.capabilityCatalogDigest = digestCanonical(capabilities);
  proposal.validationIdentities = [createValidationIdentitySnapshot(project, "focused")];
  const runs = new RunService(journal);
  const attention = new AttentionService(journal, () => new Date("2026-07-20T12:00:00.000Z"));
  return { databasePath, journal, project, security, capabilities, proposal, runs, attention,
    planning: new PlanningCoordinator(journal, runs, attention, capabilities) };
}

describe("PlanningCoordinator", () => {
  it("approves only the exact durable proposal and performs no execution effect", () => {
    const { journal, project, security, proposal, runs, attention, planning } = fixture();
    const requested = planning.propose(requestInput(proposal, project, security, "first"));

    const accepted = attention.acceptApproval(requested.approval.decisionId, {
      runId: proposal.runId,
      expectedVersion: requested.approval.streamVersion,
      actor: { actorId: "operator-1", kind: "operator", channel: "cli" },
      commandId: "accept-first",
      evidenceSha256: "8".repeat(64),
      planDigest: requested.planning.planDigest,
      envelopeDigest: requested.planning.envelopeDigest,
    });

    expect(accepted.status).toBe("accepted");
    expect(runs.get(proposal.runId)).toMatchObject({
      lifecycle: "approved_and_ready_for_execution",
      authority: { executionAuthority: "none" },
    });
    const types = journal.readAll().map((event) => event.type);
    expect(types).not.toContain("task.started");
    expect(types).not.toContain("milestone.created");
    expect(types).not.toContain("task.worktree_creation_started");
    journal.close();
  });

  it("invalidates stale approval on any revision", () => {
    const { journal, project, security, capabilities, proposal, attention, planning } = fixture();
    const first = planning.propose(requestInput(proposal, project, security, "first"));
    const revisedProposal = planningProposalFixture();
    revisedProposal.plan.goal = "Implement the narrower approved parser behavior";
    revisedProposal.validationIdentities = [createValidationIdentitySnapshot(project, "focused")];
    revisedProposal.securityDigest = digestCanonical(security);
    revisedProposal.capabilityCatalogDigest = digestCanonical(capabilities);
    const second = planning.revise(requestInput(revisedProposal, project, security, "second"));

    expect(() => attention.acceptApproval(first.approval.decisionId, {
      runId: proposal.runId,
      expectedVersion: first.approval.streamVersion,
      actor: { actorId: "operator-1", kind: "operator", channel: "cli" },
      commandId: "accept-stale",
      evidenceSha256: "8".repeat(64),
      planDigest: first.planning.planDigest,
      envelopeDigest: first.planning.envelopeDigest,
    })).toThrow(/stale/i);
    expect(second.planning.revision).toBe(2);
    journal.close();
  });

  it("reconciles the same pending approval after SQLite restart", () => {
    const { databasePath, journal, project, security, capabilities, proposal, planning } = fixture();
    const first = planning.propose(requestInput(proposal, project, security, "restart"));
    journal.close();

    const reopened = new SqliteEventJournal(databasePath);
    const resumed = new PlanningCoordinator(
      reopened,
      new RunService(reopened),
      new AttentionService(reopened, () => new Date("2026-07-20T12:00:00.000Z")), capabilities,
    );
    const replayed = resumed.propose(requestInput(proposal, project, security, "restart"));

    expect(replayed.planning.planDigest).toBe(first.planning.planDigest);
    expect(replayed.approval.decisionId).toBe(first.approval.decisionId);
    expect(reopened.readStream("planning:run-93")).toHaveLength(1);
    reopened.close();
  });

  it("recovers a durable revision whose approval request was interrupted", () => {
    const { databasePath, journal, project, security, capabilities, proposal, runs, planning } = fixture();
    const first = planning.propose(requestInput(proposal, project, security, "first"));
    const run = runs.get(proposal.runId)!;
    runs.revisePlan(proposal.runId, run.streamVersion, "interrupted:invalidate");
    const revised = planningProposalFixture();
    revised.plan.goal = "Implement the narrower approved parser behavior";
    revised.validationIdentities = [createValidationIdentitySnapshot(project, "focused")];
    revised.securityDigest = digestCanonical(security);
    revised.capabilityCatalogDigest = digestCanonical(capabilities);
    const artifact = buildPlanningArtifact(revised, runs.get(proposal.runId)!.budget, 2);
    const payload = PlanRevisedPayloadSchema.parse({
      schemaVersion: PLANNING_SCHEMA_VERSION,
      revision: 2,
      ...artifact,
      priorPlanDigest: first.planning.planDigest,
      priorEnvelopeDigest: first.planning.envelopeDigest,
      commandId: "interrupted",
      authority: "none",
    });
    const streamId = planningStreamId(proposal.runId);
    journal.append(streamId, first.planning.streamVersion, [{
      streamId,
      type: "plan.revised",
      payload,
      causationId: analysisCompletionEventId,
      correlationId: proposal.runId,
    }]);
    journal.close();

    const reopened = new SqliteEventJournal(databasePath);
    const resumed = new PlanningCoordinator(
      reopened,
      new RunService(reopened),
      new AttentionService(reopened, () => new Date("2026-07-20T12:00:00.000Z")), capabilities,
    );
    const recovered = resumed.revise(requestInput(revised, project, security, "interrupted"));

    expect(recovered.planning.revision).toBe(2);
    expect(reopened.readStream(streamId)).toHaveLength(2);
    expect(new RunService(reopened).get(proposal.runId)?.lifecycle).toBe("awaiting_approval");
    reopened.close();
  });

  it("records rejection and permits only a bounded correction after restart", () => {
    const { databasePath, journal, project, security, capabilities, proposal, attention, planning } = fixture();
    const requested = planning.propose(requestInput(proposal, project, security, "first"));
    attention.reject(requested.approval.decisionId, {
      runId: proposal.runId,
      expectedVersion: requested.approval.streamVersion,
      actor: { actorId: "operator-1", kind: "operator", channel: "cli" },
      commandId: "reject-first",
      evidenceSha256: "9".repeat(64),
      reason: "Keep the correction within the reviewed parser scope.",
    });
    journal.close();

    const reopened = new SqliteEventJournal(databasePath);
    const resumed = new PlanningCoordinator(reopened, new RunService(reopened), new AttentionService(reopened), capabilities);
    expect(resumed.get(proposal.runId)).toMatchObject({ lifecycle: "proposed" });
    const expanded = planningProposalFixture();
    expanded.plan.tasks[0]!.ownedPaths.push("src/other.ts");
    expanded.taskSpecifications[0]!.potentialWritePaths.push("src/other.ts");
    expanded.validationIdentities = [createValidationIdentitySnapshot(project, "focused")];
    expanded.securityDigest = digestCanonical(security);
    expanded.capabilityCatalogDigest = digestCanonical(capabilities);
    expect(() => resumed.revise(requestInput(expanded, project, security, "expanded"))).toThrow(/expands potential write scope/i);
    expect(resumed.get(proposal.runId)).toMatchObject({
      lifecycle: "correction_pending",
      rejection: { reason: "Keep the correction within the reviewed parser scope." },
    });
    reopened.close();
  });
});

function requestInput(
  proposal: ReturnType<typeof planningProposalFixture>,
  project: ReturnType<typeof ProjectConfigSchema.parse>,
  security: {
    readonly allowedRepositories: readonly string[];
    readonly allowedFileScopes: readonly string[];
    readonly forbiddenPaths: readonly string[];
    readonly network: { readonly default: "denied"; readonly allowedDestinations: readonly string[] };
    readonly secretHandling: readonly string[];
    readonly approvalRequiredOperations: readonly string[];
    readonly releaseBoundary: string;
    readonly stopAndAskConditions: readonly string[];
  },
  suffix: string,
) {
  return {
    proposal,
    project,
    security,
    decisionId: `approval-${suffix}`,
    attentionId: `attention-${suffix}`,
    expiresAt: "2026-07-21T00:00:00.000Z",
    commandId: `proposal-${suffix}`,
  };
}

function seedPlanningRun(journal: SqliteEventJournal): void {
  const streamId = "run:run-93";
  const process = { pid: 123, processIncarnation: `process-v2:${"d".repeat(64)}` };
  const intake = {
    sourceStreamId: `source-intake:${"1".repeat(64)}`,
    closureEventId: "intake-closure-93",
    snapshotSha256: "2".repeat(64),
    sourceCount: 1,
    rejectedCount: 0,
    totalBytes: 12,
  };
  const base = { streamId, correlationId: "run-93" };
  journal.append(streamId, 0, [
    { ...base, type: "run.accepted", causationId: "service-ready", payload: {
      schemaVersion: 1, runVersion: 1, runId: "run-93", projectId: "zentra",
      projectRevision: { objectFormat: "sha1", commit: "a".repeat(40) },
      source: { kind: "inline_goal", referenceSha256: "7".repeat(64), declaredBytes: 12 },
      actor: { actorId: "operator-1", kind: "operator" }, process,
      budget: { maxDurationMs: 60_000, maxInputTokens: 1_000, maxOutputTokens: 1_000,
        maxCostUsdNano: 1_000_000_000, maxRetries: 1, maxSourceFiles: 10, maxSourceBytes: 10_000 },
      authority: { approvalState: "not_proposed", planDigest: null, envelopeDigest: null,
        approvalDecisionId: null, executionAuthority: "none" }, commandId: "accept-run-93",
    } },
    { ...base, type: "preflight.started", causationId: "accepted", payload: {
      schemaVersion: 1, runId: "run-93", process, commandId: "preflight-start", executionAuthority: "none",
    } },
    { ...base, type: "preflight.completed", causationId: "preflight", payload: {
      schemaVersion: 1, runId: "run-93", process, commandId: "preflight-complete", executionAuthority: "none",
    } },
    { ...base, type: "run.intake_completed", causationId: intake.closureEventId, payload: {
      schemaVersion: 1, commandId: "intake-complete", intake, executionAuthority: "none",
    } },
    { ...base, type: "run.analysis_completed", causationId: analysisCompletionEventId, payload: {
      schemaVersion: 1, commandId: "analysis-complete", intake,
      analysisStreamId: "analysis:run-93", analysisCompletionEventId,
      analysisEvidenceSha256: "b".repeat(64), sourceEvidenceSha256: "c".repeat(64), executionAuthority: "none",
    } },
  ]);
  journal.append("analysis:run-93", 0, [{
    streamId: "analysis:run-93", type: "analysis.completed", causationId: "observation-1", correlationId: "run-93",
    eventId: analysisCompletionEventId, payload: {
      schemaVersion: 1, runId: "run-93", rounds: 1, observationCount: 1,
      evidenceSha256: "b".repeat(64), sourceEvidenceSha256: "c".repeat(64),
      finalObservationEventId: "observation-1",
      totalUsage: {
        durationMs: 10,
        inputTokens: 10,
        outputTokens: 10,
        inputBytes: 100,
        outputBytes: 100,
        costUsdNano: 10,
        modelReceiptSha256: "6".repeat(64),
      },
      commandId: "analysis-completed", authority: "none",
    },
  }]);
}

const analysisCompletionEventId = "00000000-0000-4000-8000-000000000093";
