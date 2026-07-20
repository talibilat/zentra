import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttentionService } from "../../src/attention/attention-service.js";
import { DecisionActorSchema } from "../../src/attention/attention-contracts.js";
import {
  approvalReservationStreamId,
  advisoryAttentionStreamId,
  attentionIndexStreamId,
  attentionIdentityReservationStreamId,
  decisionAttemptStreamId,
  decisionStreamId,
  parseDecisionAttemptStreamId,
} from "../../src/attention/attention-contracts.js";
import { AttentionControlledDispatcher } from "../../src/attention/attention-dispatcher.js";
import type { AttentionView } from "../../src/attention/attention-projection.js";
import { ATOMIC_EVENT_JOURNAL, isAtomicEventJournal, type AtomicAppend, type AtomicEventJournal, type EventJournal } from "../../src/journal/journal.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { openAuthoritativeJournal } from "../../src/journal/retention.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
import { RunService } from "../../src/runs/run-service.js";
import { ServiceLifecycleService } from "../../src/runs/service-lifecycle.js";
import { seedAgentTrailReady } from "../fixtures/service-ready.js";

const cleanup: string[] = [];
const planDigest = "a".repeat(64);
const envelopeDigest = "b".repeat(64);
const evidenceSha256 = "c".repeat(64);

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(now = "2026-07-19T11:00:00.000Z") {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-attention-"));
  cleanup.push(directory);
  const databasePath = path.join(directory, "events.sqlite");
  const journal = new SqliteEventJournal(databasePath);
  seedRun(journal, "run-1");
  seedRun(journal, "run-2");
  const clock = { now: new Date(now) };
  return { databasePath, journal, clock, service: new AttentionService(journal, () => clock.now) };
}

function seedRun(journal: EventJournal, runId: string): void {
  const process = { pid: 123, processIncarnation: `process-v2:${runId === "run-1" ? "d" : "e".repeat(64)}` };
  const normalizedProcess = runId === "run-1"
    ? { ...process, processIncarnation: `process-v2:${"d".repeat(64)}` }
    : process;
  const lifecycle = new ServiceLifecycleService(journal);
  const starting = lifecycle.start({
    serviceId: `service-${runId}`,
    process: normalizedProcess,
    address: { host: "127.0.0.1", port: runId === "run-1" ? 43_201 : 43_202 },
    tokenExpiresAt: "2026-07-20T00:00:00.000Z",
    observation: "performed",
    commandId: `start-${runId}`,
  });
  const agentTrail = seedAgentTrailReady(journal, {
    serviceId: `service-${runId}`, serviceStartingEventId: starting.eventId,
    seed: runId === "run-1" ? "3" : "4",
  });
  const ready = lifecycle.ready({
    serviceId: `service-${runId}`,
    process: normalizedProcess,
    address: { host: "127.0.0.1", port: runId === "run-1" ? 43_201 : 43_202 },
    runtimeSchemaVersion: 1,
    journalSchemaVersion: 6,
    observation: "performed",
    commandId: `ready-${runId}`,
    tokenExpiresAt: "2026-07-20T00:00:00.000Z",
    ...agentTrail,
    causationId: agentTrail.agentTrailReadyEventId,
  });
  const runs = new RunService(journal);
  let run = runs.accept({
    runId,
    projectId: "zentra",
    projectRevision: { objectFormat: "sha1", commit: "f".repeat(40) },
    source: { kind: "inline_goal", referenceSha256: "9".repeat(64), declaredBytes: 12 },
    actor: { actorId: "operator-1", kind: "operator" },
    process: normalizedProcess,
    budget: {
      maxDurationMs: 60_000, maxInputTokens: 1_000, maxOutputTokens: 1_000,
      maxCostUsdNano: 1_000_000, maxRetries: 0, maxSourceFiles: 10, maxSourceBytes: 1_000,
    },
    commandId: `accept-${runId}`,
    causationId: ready.eventId,
  });
  run = runs.startPreflight(runId, {
    expectedVersion: run.streamVersion, commandId: `preflight-start-${runId}`,
    causationId: runs.readStream(runId).at(-1)!.eventId, process: normalizedProcess,
  });
  run = runs.completePreflight(runId, {
    expectedVersion: run.streamVersion, commandId: `preflight-complete-${runId}`,
    causationId: runs.readStream(runId).at(-1)!.eventId, process: normalizedProcess,
  });
  const sourceStreamId = `source-intake:${"1".repeat(64)}`;
  const closureEventId = `closure-${runId}`;
  const intake = journal.append(`run:${runId}`, run.streamVersion, [{
    streamId: `run:${runId}`,
    type: "run.intake_completed",
    payload: {
      schemaVersion: 1,
      commandId: `intake-${runId}`,
      intake: {
        sourceStreamId,
        closureEventId,
        snapshotSha256: "2".repeat(64),
        sourceCount: 1,
        rejectedCount: 0,
        totalBytes: 12,
      },
      executionAuthority: "none",
    },
    causationId: closureEventId,
    correlationId: runId,
  }])[0]!;
  journal.append(`run:${runId}`, run.streamVersion + 1, [{
    streamId: `run:${runId}`,
    type: "run.analysis_completed",
    payload: {
      schemaVersion: 1,
      commandId: `analysis-${runId}`,
      intake: (intake.payload as { intake: unknown }).intake,
      analysisStreamId: `analysis:${runId}`,
      analysisCompletionEventId: `analysis-completion-${runId}`,
      analysisEvidenceSha256: "3".repeat(64),
      sourceEvidenceSha256: "4".repeat(64),
      executionAuthority: "none",
    },
    causationId: `analysis-completion-${runId}`,
    correlationId: runId,
  }]);
  run = runs.get(runId)!;
  runs.requestApproval(runId, run.streamVersion, `approval-${runId}`, { planDigest, envelopeDigest });
}

function questionInput() {
  return {
    decisionId: "decision-question-1",
    attentionId: "attention-question-1",
    runId: "run-1",
    question: "Which implementation should proceed?",
    options: [
      { optionId: "safe", label: "Use the bounded implementation", impacts: ["No external effect"] },
      { optionId: "stop", label: "Stop this scope", impacts: ["The parser remains paused"] },
    ],
    recommendation: { optionId: "safe", rationale: "It remains inside the reviewed scope." },
    impacts: ["Changes parser scheduling"],
    affectedScopes: ["task:parser"],
    dependentScopes: ["task:parser-tests"],
    material: true,
    evidenceSha256,
    commandId: "question-request-1",
  } as const;
}

function approvalInput() {
  return {
    decisionId: "decision-approval-1",
    attentionId: "attention-approval-1",
    runId: "run-1",
    summary: "Execute the exact reviewed plan",
    operation: "execute_plan",
    target: "run:run-1",
    inputsSha256: "8".repeat(64),
    expectedEffect: "Run only the reviewed local envelope.",
    proposedStateChange: "Move the run to approved and ready.",
    risk: "The approved operation may modify its assigned worktree.",
    mitigationOrRollback: "Stop before integration and preserve evidence.",
    planDigest,
    envelopeDigest,
    impacts: ["Starts bounded execution"],
    affectedScopes: ["task:parser"],
    dependentScopes: ["task:parser-tests"],
    expiryPolicy: { kind: "at", expiresAt: "2026-07-20T13:00:00.000Z" },
    evidenceSha256,
    commandId: "approval-request-1",
  } as const;
}

describe("AttentionService", () => {
  it("replays an immutable wait-forever question after crash and reopens it for polling", () => {
    const { databasePath, journal, service } = fixture();
    const requested = service.requestQuestion(questionInput());
    expect(requested).toMatchObject({
      kind: "question", status: "pending", expiryPolicy: { kind: "wait_forever" },
      affectedScopes: ["task:parser"], dependentScopes: ["task:parser-tests"],
    });
    expect(Object.isFrozen(requested.options)).toBe(true);
    expect(service.pausedScopes("run-1")).toEqual(["task:parser", "task:parser-tests"]);
    journal.close();

    const reopenedJournal = new SqliteEventJournal(databasePath);
    const reopened = new AttentionService(reopenedJournal, () => new Date("2027-01-01T00:00:00.000Z"));
    expect(reopened.get(requested.decisionId)).toEqual(requested);
    expect(reopened.poll("run-1").map((item) => item.decisionId)).toEqual([requested.decisionId]);
    expect(() => reopened.expire(requested.decisionId, requested.streamVersion))
      .toThrow("wait-forever attention does not expire");
    reopenedJournal.close();
  });

  it("allows exactly one UI or CLI answer and audits the duplicate loser", async () => {
    const { databasePath, journal, service } = fixture();
    const requested = service.requestQuestion(questionInput());
    const secondJournal = new SqliteEventJournal(databasePath);
    const cli = new AttentionService(secondJournal, () => new Date("2026-07-19T11:00:00.000Z"));
    const submissions = await Promise.allSettled([
      Promise.resolve().then(() => service.answer(requested.decisionId, {
        runId: "run-1", expectedVersion: requested.streamVersion, optionId: "safe",
        actor: { actorId: "alice", kind: "operator", channel: "ui" },
        commandId: "answer-ui", evidenceSha256,
      })),
      Promise.resolve().then(() => cli.answer(requested.decisionId, {
        runId: "run-1", expectedVersion: requested.streamVersion, optionId: "stop",
        actor: { actorId: "alice", kind: "operator", channel: "cli" },
        commandId: "answer-cli", evidenceSha256,
      })),
    ]);

    expect(submissions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(submissions.filter((result) => result.status === "rejected")).toHaveLength(1);
    const final = service.get(requested.decisionId)!;
    expect(final.status).toBe("accepted");
    expect(service.readAttempts(requested.decisionId).filter((event) => event.type === "decision.duplicate_attempted"))
      .toHaveLength(1);
    expect(service.pausedScopes("run-1")).toEqual([]);
    secondJournal.close();
    journal.close();
  });

  it("rejects actor tokens and records an exact single-use rejection", () => {
    const { journal, service } = fixture("2026-07-19T12:00:00.001Z");
    expect(() => DecisionActorSchema.parse({
      actorId: "alice", kind: "operator", channel: "ui", token: "secret",
    })).toThrow();
    const requested = service.requestQuestion(questionInput());
    const rejected = service.reject(requested.decisionId, {
      runId: "run-1", expectedVersion: requested.streamVersion, reason: "Insufficient evidence.",
      actor: { actorId: "alice", kind: "operator", channel: "cli" },
      commandId: "reject-1", evidenceSha256,
    });
    expect(rejected).toMatchObject({ status: "rejected", resolution: { reason: "Insufficient evidence." } });
    expect(() => service.reject(requested.decisionId, {
      runId: "run-1", expectedVersion: rejected.streamVersion, reason: "Again",
      actor: { actorId: "alice", kind: "operator", channel: "ui" },
      commandId: "reject-2", evidenceSha256,
    })).toThrow("decision is already consumed");
    journal.close();
  });

  it("expires deadline questions without auto-answering", () => {
    const { journal, service } = fixture("2026-07-19T12:00:00.001Z");
    const requested = service.requestQuestion({
      ...questionInput(),
      decisionId: "deadline-question",
      attentionId: "deadline-attention",
      expiryPolicy: { kind: "at", expiresAt: "2026-07-19T12:00:00.000Z" },
    });
    const expired = service.expire(requested.decisionId, requested.streamVersion);
    expect(expired).toMatchObject({ status: "expired", resolution: null });
    journal.close();
  });

  it("binds approval to the current run and exact plan/envelope digests", () => {
    const { journal, service } = fixture();
    const requested = service.requestApproval(approvalInput());
    expect(requested.packet).toMatchObject({
      projectRevision: { objectFormat: "sha1", commit: "f".repeat(40) },
      runStreamVersion: 6,
    });
    expect((requested.packet as { approvalRequestEventId: string }).approvalRequestEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => service.acceptApproval(requested.decisionId, {
      runId: "run-2", expectedVersion: requested.streamVersion, planDigest, envelopeDigest,
      actor: { actorId: "alice", kind: "operator", channel: "ui" },
      commandId: "cross-run", evidenceSha256,
    })).toThrow("decision belongs to a different run");
    expect(() => service.acceptApproval(requested.decisionId, {
      runId: "run-1", expectedVersion: service.get(requested.decisionId)!.streamVersion,
      planDigest: "7".repeat(64), envelopeDigest,
      actor: { actorId: "alice", kind: "operator", channel: "ui" },
      commandId: "stale-digest", evidenceSha256,
    })).toThrow("approval digest does not match the exact packet");

    const current = service.get(requested.decisionId)!;
    const accepted = service.acceptApproval(current.decisionId, {
      runId: "run-1", expectedVersion: current.streamVersion, planDigest, envelopeDigest,
      actor: { actorId: "alice", kind: "operator", channel: "cli" },
      commandId: "approve-1", evidenceSha256,
    });
    expect(accepted).toMatchObject({ status: "accepted", kind: "approval" });
    const acceptedEvent = service.readDecisionStream(accepted.decisionId)
      .find((event) => event.type === "approval.accepted")!;
    const readyEvent = new RunService(journal).readStream("run-1").at(-1)!;
    expect(readyEvent).toMatchObject({
      type: "run.ready_for_execution",
      causationId: acceptedEvent.eventId,
      payload: {
        approvalDecisionId: accepted.decisionId,
        approvalDecisionEventId: acceptedEvent.eventId,
        approvalRequestEventId: (accepted.packet as { approvalRequestEventId: string }).approvalRequestEventId,
        approvalPacketSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(service.approvalReservation(
      "run-1",
      (accepted.packet as { approvalRequestEventId: string }).approvalRequestEventId,
    )).toMatchObject({ status: "consumed", outcome: "accepted", decisionId: accepted.decisionId });
    expect(service.readAttempts(current.decisionId).map((event) => event.type)).toContain("approval.stale_attempted");
    journal.close();
  });

  it("projects run readiness before mutation and rolls back every authoritative stream", () => {
    const { journal, service } = fixture();
    const requested = service.requestApproval({
      ...approvalInput(), decisionId: "preflight-ready", attentionId: "preflight-ready-attention",
    });
    const packet = requested.packet as { approvalRequestEventId: string };
    const streamIds = [
      decisionStreamId(requested.decisionId),
      approvalReservationStreamId("run-1", packet.approvalRequestEventId),
      attentionIndexStreamId("run-1"),
      "run:run-1",
    ];
    const before = streamIds.map((streamId) => JSON.stringify(journal.readStream(streamId)));

    expect(() => service.acceptApproval(requested.decisionId, {
      ...approvalSubmission(requested, "approval-run-1"),
    })).toThrow(/command identity.*reused|duplicate run command/i);
    expect(streamIds.map((streamId) => JSON.stringify(journal.readStream(streamId)))).toEqual(before);
    expect(service.getDecision(requested.decisionId)).toMatchObject({ status: "pending" });
    expect(service.approvalReservation("run-1", packet.approvalRequestEventId)).toMatchObject({ status: "reserved" });
    journal.close();
  });

  it("rejects service self-approval without mutating any journal stream", () => {
    const { journal, service } = fixture();
    const requested = service.requestApproval({
      ...approvalInput(), decisionId: "service-self-approval", attentionId: "service-self-attention",
    });
    const before = JSON.stringify(journal.readAll());
    expect(() => service.acceptApproval(requested.decisionId, {
      runId: "run-1", expectedVersion: requested.streamVersion, planDigest, envelopeDigest,
      actor: { actorId: "zentra-service", kind: "service", channel: "api" },
      commandId: "service-self-accept", evidenceSha256,
    })).toThrow("requires an operator actor");
    expect(JSON.stringify(journal.readAll())).toBe(before);
    expect(service.getDecision(requested.decisionId)).toMatchObject({ status: "pending" });
    journal.close();
  });

  it("reserves material attention identities permanently and rejects concurrent duplicates", async () => {
    const { databasePath, journal, service } = fixture();
    const first = service.requestQuestion({
      ...questionInput(), decisionId: "identity-first", attentionId: "shared-attention-id",
    });
    expect(() => service.requestQuestion({
      ...questionInput(), decisionId: "identity-pending-duplicate", attentionId: "shared-attention-id",
    })).toThrow("globally reserved");
    service.answer(first.decisionId, {
      runId: "run-1", expectedVersion: first.streamVersion, optionId: "safe",
      actor: { actorId: "alice", kind: "operator", channel: "ui" },
      commandId: "identity-resolve", evidenceSha256,
    });
    expect(() => service.requestQuestion({
      ...questionInput(), decisionId: "identity-resolved-duplicate", attentionId: "shared-attention-id",
    })).toThrow("globally reserved");
    expect(service.readDecisionStream("identity-pending-duplicate")).toEqual([]);
    expect(service.readDecisionStream("identity-resolved-duplicate")).toEqual([]);

    const results = await runCompetingProcesses(databasePath, [
      childCommand("requestQuestion", undefined, {
        ...questionInput(), decisionId: "identity-race-a", attentionId: "identity-race-shared",
      }),
      childCommand("requestQuestion", undefined, {
        ...questionInput(), decisionId: "identity-race-b", attentionId: "identity-race-shared",
      }),
    ]);
    expect(results.filter((result) => result.status === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results[0]!.status === "accepted" ? "identity-race-a" : "identity-race-b";
    const loser = winner === "identity-race-a" ? "identity-race-b" : "identity-race-a";
    expect(service.readDecisionStream(loser)).toEqual([]);
    expect(service.attentionIndex("run-1").knownAttentionIds).toContain("identity-race-shared");
    expect(service.attentionIndex("run-1").pending["identity-race-shared"]?.decisionId).toBe(winner);
    expect(service.poll("run-1").some((item) => item.decisionId === winner)).toBe(true);
    journal.close();
  });

  it("globally reserves attention identities across every source and run", async () => {
    const { databasePath, journal, service } = fixture();
    service.requestQuestion({
      ...questionInput(), decisionId: "global-advisory-first", attentionId: "global-advisory",
      material: false,
    });
    expect(() => service.requestQuestion({
      ...questionInput(), decisionId: "global-advisory-second", attentionId: "global-advisory",
      material: false,
    })).toThrow("globally reserved");
    service.requestApproval({
      ...approvalInput(), decisionId: "global-approval-decision", attentionId: "global-approval",
    });
    expect(() => service.raiseAgentTrailWarning({
      attentionId: "global-approval", runId: "run-2", warningCode: "observation",
      message: "Cannot reuse approval attention.", evidenceSha256, affectedScopes: [], dependentScopes: [],
      commandId: "global-approval-warning",
    })).toThrow("globally reserved");
    expect(service.readAdvisoryStream("global-approval")).toEqual([]);
    service.raiseAgentTrailWarning({
      attentionId: "global-warning", runId: "run-1", warningCode: "observation",
      message: "Advisory only.", evidenceSha256, affectedScopes: [], dependentScopes: [],
      commandId: "global-warning-create",
    });
    expect(() => service.requestQuestion({
      ...questionInput(), decisionId: "global-warning-question", attentionId: "global-warning",
    })).toThrow("globally reserved");
    service.requestQuestion({
      ...questionInput(), decisionId: "global-cross-run-first", attentionId: "global-cross-run",
    });
    expect(() => service.requestQuestion({
      ...questionInput(), runId: "run-2", decisionId: "global-cross-run-second",
      attentionId: "global-cross-run",
    })).toThrow("globally reserved");
    expect(service.readDecisionStream("global-advisory-second")).toEqual([]);
    expect(service.readDecisionStream("global-warning-question")).toEqual([]);
    expect(service.readDecisionStream("global-cross-run-second")).toEqual([]);
    expect(service.attentionIndex("run-1").knownAttentionIds).not.toContain("global-advisory");
    expect(service.attentionIndex("run-1").knownAttentionIds).not.toContain("global-warning");
    expect(service.attentionIdentityReservation("global-warning")).toMatchObject({
      kind: "advisory", source: "agenttrail", decisionId: null, authority: "none",
    });
    expect(service.attentionIdentityReservation("global-warning")?.creationEventId)
      .toBe(service.readAdvisoryStream("global-warning")[0]?.eventId);

    const cases = [
      {
        attentionId: "race-advisory-advisory",
        commands: [
          childCommand("requestQuestion", undefined, {
            ...questionInput(), decisionId: "race-aa-a", attentionId: "race-advisory-advisory", material: false,
          }),
          childCommand("requestQuestion", undefined, {
            ...questionInput(), decisionId: "race-aa-b", attentionId: "race-advisory-advisory", material: false,
          }),
        ],
        streams: [decisionStreamId("race-aa-a"), decisionStreamId("race-aa-b")],
      },
      {
        attentionId: "race-material-advisory",
        commands: [
          childCommand("requestQuestion", undefined, {
            ...questionInput(), decisionId: "race-ma-material", attentionId: "race-material-advisory",
          }),
          childCommand("requestQuestion", undefined, {
            ...questionInput(), decisionId: "race-ma-advisory", attentionId: "race-material-advisory", material: false,
          }),
        ],
        streams: [decisionStreamId("race-ma-material"), decisionStreamId("race-ma-advisory")],
      },
      {
        attentionId: "race-warning-question",
        commands: [
          childCommand("raiseWarning", undefined, {
            attentionId: "race-warning-question", runId: "run-1", warningCode: "observation",
            message: "Warning.", evidenceSha256, affectedScopes: [], dependentScopes: [], commandId: "race-warning",
          }),
          childCommand("requestQuestion", undefined, {
            ...questionInput(), decisionId: "race-warning-question-decision", attentionId: "race-warning-question",
          }),
        ],
        streams: [advisoryAttentionStreamId("race-warning-question"), decisionStreamId("race-warning-question-decision")],
      },
      {
        attentionId: "race-cross-run",
        commands: [
          childCommand("requestQuestion", undefined, {
            ...questionInput(), decisionId: "race-cross-run-a", attentionId: "race-cross-run",
          }),
          childCommand("requestQuestion", undefined, {
            ...questionInput(), runId: "run-2", decisionId: "race-cross-run-b", attentionId: "race-cross-run",
          }),
        ],
        streams: [decisionStreamId("race-cross-run-a"), decisionStreamId("race-cross-run-b")],
      },
    ] as const;
    for (const candidate of cases) {
      const results = await runCompetingProcesses(databasePath, candidate.commands);
      expect(results.filter((result) => result.status === "accepted")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const winnerIndex = results[0]!.status === "accepted" ? 0 : 1;
      expect(journal.readStream(candidate.streams[winnerIndex]!)).not.toEqual([]);
      expect(journal.readStream(candidate.streams[1 - winnerIndex]!)).toEqual([]);
      expect(service.attentionIdentityReservation(candidate.attentionId)).toMatchObject({
        attentionId: candidate.attentionId,
        authority: "none",
      });
      expect(() => service.poll("run-1")).not.toThrow();
      expect(() => service.poll("run-2")).not.toThrow();
    }
    journal.close();
  }, 20_000);

  it("reserves one run approval request permanently across rejection and expiry", () => {
    const { journal, service, clock } = fixture();
    const first = service.requestApproval({
      ...approvalInput(), decisionId: "reserved-first", attentionId: "reserved-first-attention",
    });
    const packet = first.packet as { approvalRequestEventId: string };
    expect(service.approvalReservation("run-1", packet.approvalRequestEventId)).toMatchObject({
      decisionId: first.decisionId, status: "reserved",
    });
    expect(() => service.requestApproval({
      ...approvalInput(), decisionId: "reserved-second", attentionId: "reserved-second-attention",
    })).toThrow("already reserved by another decision");
    service.reject(first.decisionId, {
      runId: "run-1", expectedVersion: first.streamVersion, reason: "No.",
      actor: { actorId: "alice", kind: "operator", channel: "ui" },
      commandId: "reserved-reject", evidenceSha256,
    });
    expect(service.approvalReservation("run-1", packet.approvalRequestEventId)).toMatchObject({
      status: "consumed", outcome: "rejected",
    });
    expect(new RunService(journal).get("run-1")).toMatchObject({
      lifecycle: "awaiting_approval",
      authority: { approvalState: "approval_pending", approvalDecisionId: null },
    });
    expect(() => service.requestApproval({
      ...approvalInput(), decisionId: "reserved-third", attentionId: "reserved-third-attention",
    })).toThrow("already reserved by another decision");

    const runs = new RunService(journal);
    let run = runs.get("run-1")!;
    const rejectionEvent = service.readDecisionStream(first.decisionId)
      .find((event) => event.type === "approval.rejected")!;
    run = runs.rejectApproval("run-1", run.streamVersion, "expiry-plan-rejected", {
      approvalDecisionId: first.decisionId,
      approvalDecisionEventId: rejectionEvent.eventId,
      reasonEvidenceSha256: evidenceSha256,
    });
    run = runs.requestApproval("run-1", run.streamVersion, "expiry-run-approval", { planDigest, envelopeDigest });
    const expiring = service.requestApproval({
      ...approvalInput(), decisionId: "reserved-expiring", attentionId: "reserved-expiring-attention",
      expiryPolicy: { kind: "at", expiresAt: "2026-07-19T12:00:00.000Z" },
    });
    clock.now = new Date("2026-07-19T12:00:00.001Z");
    service.expire(expiring.decisionId, expiring.streamVersion);
    expect(service.approvalReservation("run-1", (expiring.packet as { approvalRequestEventId: string }).approvalRequestEventId))
      .toMatchObject({ status: "consumed", outcome: "expired" });
    journal.close();
  });

  it("allows only one concurrent decision reservation for one run approval request", async () => {
    const { databasePath, journal, service } = fixture();
    const results = await runCompetingProcesses(databasePath, [
      childCommand("requestApproval", undefined, {
        ...approvalInput(), decisionId: "reservation-race-a", attentionId: "reservation-race-attention-a",
      }),
      childCommand("requestApproval", undefined, {
        ...approvalInput(), decisionId: "reservation-race-b", attentionId: "reservation-race-attention-b",
      }),
    ]);
    expect(results.filter((result) => result.status === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result) => result.status === "accepted")!.value as AttentionView;
    const loserDecisionId = results[0]!.status === "rejected" ? "reservation-race-a" : "reservation-race-b";
    expect(service.readAttemptStream(loserDecisionId, "approval-request-1")).toHaveLength(1);
    const requestEventId = (winner.packet as { approvalRequestEventId: string }).approvalRequestEventId;
    expect(service.approvalReservation("run-1", requestEventId)).toMatchObject({ status: "reserved" });
    journal.close();
  });

  it("marks an approval stale when the authoritative run packet is revised", () => {
    const { journal, service } = fixture();
    const requested = service.requestApproval({ ...approvalInput(), decisionId: "revision-approval", attentionId: "revision-attention" });
    const runs = new RunService(journal);
    const run = runs.get("run-1")!;
    runs.wait("run-1", run.streamVersion, "revision-with-same-digests", "plan_revised");

    expect(() => service.acceptApproval(requested.decisionId, {
      runId: "run-1", expectedVersion: requested.streamVersion, planDigest, envelopeDigest,
      actor: { actorId: "alice", kind: "operator", channel: "ui" },
      commandId: "approve-stale", evidenceSha256,
    })).toThrow("approval packet is stale after run revision");
    expect(service.get(requested.decisionId)).toMatchObject({ status: "stale" });
    journal.close();
  });

  it("reconciles stale approvals before poll, rejection, answer, or expiry", () => {
    for (const operation of ["poll", "reject", "answer", "expire"] as const) {
      const { journal, service, clock } = fixture();
      const requested = service.requestApproval({
        ...approvalInput(), decisionId: `stale-${operation}`, attentionId: `stale-${operation}-attention`,
        expiryPolicy: { kind: "at", expiresAt: "2026-07-19T12:00:00.000Z" },
      });
      const runs = new RunService(journal);
      const run = runs.get("run-1")!;
      runs.revisePlan("run-1", run.streamVersion, `stale-${operation}-revision`);
      clock.now = new Date("2026-07-19T12:00:00.001Z");
      if (operation === "poll") {
        expect(service.poll("run-1").map((item) => item.decisionId)).not.toContain(requested.decisionId);
      } else if (operation === "reject") {
        expect(() => service.reject(requested.decisionId, {
          runId: "run-1", expectedVersion: requested.streamVersion, reason: "Too late.",
          actor: { actorId: "alice", kind: "operator", channel: "ui" },
          commandId: "stale-reject", evidenceSha256,
        })).toThrow("approval packet is stale after run revision");
      } else if (operation === "answer") {
        expect(() => service.answer(requested.decisionId, {
          runId: "run-1", expectedVersion: requested.streamVersion, optionId: "safe",
          actor: { actorId: "alice", kind: "operator", channel: "ui" },
          commandId: "stale-answer", evidenceSha256,
        })).toThrow("approval packet is stale after run revision");
      } else {
        expect(() => service.expire(requested.decisionId, requested.streamVersion))
          .toThrow("approval packet is stale after run revision");
      }
      expect(service.getDecision(requested.decisionId)).toMatchObject({ status: "stale" });
      expect(service.pausedScopes("run-1")).toEqual([]);
      expect(service.approvalReservation(
        "run-1",
        (requested.packet as { approvalRequestEventId: string }).approvalRequestEventId,
      )).toMatchObject({ status: "consumed", outcome: "stale" });
      journal.close();
    }
  });

  it("rejects old approval requests after every legal lifecycle departure", () => {
    {
      const { journal, service } = fixture();
      const old = service.requestApproval({ ...approvalInput(), decisionId: "revised-old", attentionId: "revised-old-attention" });
      const runs = new RunService(journal);
      let run = runs.get("run-1")!;
      run = runs.revisePlan("run-1", run.streamVersion, "legal-plan-revision");
      run = runs.requestApproval("run-1", run.streamVersion, "replacement-approval-request", { planDigest, envelopeDigest });
      expect(() => service.acceptApproval(old.decisionId, approvalSubmission(old, "revised-old-accept")))
        .toThrow("approval packet is stale after run revision");
      expect(service.requestApproval({
        ...approvalInput(), decisionId: "replacement-decision", attentionId: "replacement-attention",
      })).toMatchObject({ status: "pending" });
      journal.close();
    }
    {
      const { journal, service } = fixture();
      const old = service.requestApproval({ ...approvalInput(), decisionId: "waiting-old", attentionId: "waiting-old-attention" });
      const runs = new RunService(journal);
      const run = runs.get("run-1")!;
      runs.wait("run-1", run.streamVersion, "legal-wait", "operator_attention");
      expect(() => service.requestApproval({
        ...approvalInput(), decisionId: "waiting-new", attentionId: "waiting-new-attention",
      })).toThrow("not exactly awaiting approval");
      expect(() => service.acceptApproval(old.decisionId, approvalSubmission(old, "waiting-old-accept")))
        .toThrow("approval packet is stale after run revision");
      journal.close();
    }
    {
      const { journal, service } = fixture();
      const old = service.requestApproval({ ...approvalInput(), decisionId: "approved-old", attentionId: "approved-old-attention" });
      const runs = new RunService(journal);
      service.acceptApproval(old.decisionId, approvalSubmission(old, "approved-old-accept"));
      expect(runs.get("run-1")).toMatchObject({
        lifecycle: "approved_and_ready_for_execution",
        authority: { approvalDecisionId: old.decisionId },
      });
      expect(() => service.requestApproval({
        ...approvalInput(), decisionId: "approved-new", attentionId: "approved-new-attention",
      })).toThrow("not exactly awaiting approval");
      expect(() => service.acceptApproval(old.decisionId, approvalSubmission(old, "approved-repeat")))
        .toThrow("decision is already consumed");
      journal.close();
    }
    for (const outcome of ["denied", "failed"] as const) {
      const { journal, service } = fixture();
      const old = service.requestApproval({
        ...approvalInput(), decisionId: `${outcome}-old`, attentionId: `${outcome}-old-attention`,
      });
      const runs = new RunService(journal);
      const run = runs.get("run-1")!;
      runs.terminate("run-1", {
        expectedVersion: run.streamVersion, commandId: `legal-${outcome}`, causationId: null,
        process: { pid: 123, processIncarnation: `process-v2:${"d".repeat(64)}` },
      }, outcome, "4".repeat(64));
      expect(() => service.acceptApproval(old.decisionId, approvalSubmission(old, `${outcome}-old-accept`)))
        .toThrow("approval packet is stale after run revision");
      journal.close();
    }
  });

  it("keeps AgentTrail warnings advisory and incapable of granting authority", () => {
    const { journal, service } = fixture();
    const warning = service.raiseAgentTrailWarning({
      attentionId: "warning-1", runId: "run-1", warningCode: "review_observation",
      message: "AgentTrail observed a possible review concern.", evidenceSha256,
      affectedScopes: ["task:parser"], dependentScopes: ["task:parser-tests"], commandId: "warning-command",
    });
    expect(warning).toMatchObject({ kind: "advisory", status: "pending", authority: "none" });
    expect(service.pausedScopes("run-1")).toEqual([]);
    expect(() => service.answer(warning.decisionId, {
      runId: "run-1", expectedVersion: warning.streamVersion, optionId: "approve",
      actor: { actorId: "alice", kind: "operator", channel: "ui" }, commandId: "warning-answer", evidenceSha256,
    })).toThrow("decision warning-1 not found");
    expect(service.resolveAdvisory(warning.attentionId, warning.streamVersion, {
      actor: { actorId: "alice", kind: "operator", channel: "ui" }, commandId: "warning-resolve", evidenceSha256,
    })).toMatchObject({ status: "resolved", authority: "none" });
    journal.close();
  });

  it("keeps attempt audit off the authoritative version and allows one winner in a three-party race", async () => {
    const { databasePath, journal, service } = fixture();
    const requested = service.requestQuestion(questionInput());
    expect(() => service.answer(requested.decisionId, {
      runId: "run-1", expectedVersion: requested.streamVersion - 1, optionId: "safe",
      actor: { actorId: "stale", kind: "operator", channel: "api" },
      commandId: "stale-spam", evidenceSha256,
    })).toThrow("expected version");
    expect(service.getDecision(requested.decisionId)?.streamVersion).toBe(requested.streamVersion);

    const secondJournal = new SqliteEventJournal(databasePath);
    const second = new AttentionService(secondJournal, () => new Date("2026-07-19T11:00:00.000Z"));
    const results = await Promise.allSettled([
      Promise.resolve().then(() => service.answer(requested.decisionId, {
        runId: "run-1", expectedVersion: requested.streamVersion, optionId: "safe",
        actor: { actorId: "ui-user", kind: "operator", channel: "ui" },
        commandId: "three-ui", evidenceSha256,
      })),
      Promise.resolve().then(() => second.reject(requested.decisionId, {
        runId: "run-1", expectedVersion: requested.streamVersion, reason: "CLI rejected.",
        actor: { actorId: "cli-user", kind: "operator", channel: "cli" },
        commandId: "three-cli", evidenceSha256,
      })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(service.readAttempts(requested.decisionId)).toHaveLength(2);
    expect(service.getDecision(requested.decisionId)?.status).toMatch(/accepted|rejected/);
    secondJournal.close();
    journal.close();
  });

  it("retries one optimistic conflict when the decision remains pending", () => {
    const { journal, service } = fixture();
    const requested = service.requestQuestion(questionInput());
    const conflicted = new AttentionService(new ConflictOnceJournal(journal), () => new Date("2026-07-19T11:00:00.000Z"));
    expect(conflicted.answer(requested.decisionId, {
      runId: "run-1", expectedVersion: requested.streamVersion, optionId: "safe",
      actor: { actorId: "alice", kind: "operator", channel: "ui" },
      commandId: "retry-valid", evidenceSha256,
    })).toMatchObject({ status: "accepted" });
    journal.close();
  });

  it("preserves exact namespaces when decision and advisory suffixes collide across runs", () => {
    const { journal, service } = fixture();
    service.requestQuestion({ ...questionInput(), decisionId: "shared-suffix" });
    service.raiseAgentTrailWarning({
      attentionId: "shared-suffix", runId: "run-2", warningCode: "observation",
      message: "Advisory only.", evidenceSha256, affectedScopes: ["task:other"],
      dependentScopes: ["task:other-test"], commandId: "warning-shared",
    });
    expect(service.poll("run-1").map((item) => item.kind)).toEqual(["question"]);
    expect(service.poll("run-2").map((item) => item.kind)).toEqual(["advisory"]);
    expect(service.pausedScopes("run-1")).toEqual(["task:parser", "task:parser-tests"]);
    expect(service.pausedScopes("run-2")).toEqual([]);
    expect(() => service.get("shared-suffix")).toThrow("ambiguous attention identity");
    journal.close();
  });

  it("atomically rejects approval when the run version changes with reused digests", () => {
    const { journal, service } = fixture();
    const requested = service.requestApproval({ ...approvalInput(), decisionId: "atomic-approval", attentionId: "atomic-attention" });
    const racing = new AttentionService(new RunRaceJournal(journal), () => new Date("2026-07-19T11:00:00.000Z"));
    expect(() => racing.acceptApproval(requested.decisionId, {
      runId: "run-1", expectedVersion: requested.streamVersion, planDigest, envelopeDigest,
      actor: { actorId: "alice", kind: "operator", channel: "ui" },
      commandId: "atomic-race", evidenceSha256,
    })).toThrow("approval packet is stale after run revision");
    expect(service.getDecision(requested.decisionId)).toMatchObject({ status: "stale" });
    expect(service.readDecisionStream(requested.decisionId).map((event) => event.type)).not.toContain("approval.accepted");
    journal.close();
  });

  it("gates actual work only for affected scopes and transitive dependents", async () => {
    const { journal, service } = fixture();
    service.requestQuestion(questionInput());
    service.raiseAgentTrailWarning({
      attentionId: "advisory-gate", runId: "run-1", warningCode: "observation",
      message: "Advisory only.", evidenceSha256, affectedScopes: ["task:unaffected"],
      dependentScopes: [], commandId: "advisory-gate-command",
    });
    const dispatcher = new AttentionControlledDispatcher(service);
    let invoked = 0;
    expect(await dispatcher.dispatch({
      runId: "run-1",
      admissionId: "blocked-admission",
      scopeId: "task:parser-e2e",
      dependencies: { "task:parser-e2e": ["task:parser-tests"], "task:parser-tests": ["task:parser"] },
      commandId: "blocked-dispatch",
      evidenceSha256,
      work: async () => ++invoked,
    }))
      .toMatchObject({ status: "paused" });
    expect(invoked).toBe(0);
    expect(await dispatcher.dispatch({
      runId: "run-1", admissionId: "allowed-admission", scopeId: "task:unaffected",
      commandId: "allowed-dispatch", evidenceSha256, work: async () => ++invoked,
    })).toMatchObject({ status: "completed", value: 1, attentionRevision: expect.any(Number) });
    expect(invoked).toBe(1);
    journal.close();
  });

  it("uses only the trusted clock for deadline expiry and never expires wait-forever questions", () => {
    const { journal, service, clock } = fixture();
    const deadline = service.requestQuestion({
      ...questionInput(), decisionId: "clock-deadline", attentionId: "clock-attention",
      expiryPolicy: { kind: "at", expiresAt: "2026-07-19T12:00:00.000Z" },
    });
    expect(() => service.expire(deadline.decisionId, deadline.streamVersion)).toThrow("attention has not expired");
    clock.now = new Date("2026-07-19T12:00:00.001Z");
    expect(service.expire(deadline.decisionId, deadline.streamVersion)).toMatchObject({ status: "expired" });
    const forever = service.requestQuestion({
      ...questionInput(), decisionId: "clock-forever", attentionId: "clock-forever-attention",
    });
    clock.now = new Date("2099-01-01T00:00:00.000Z");
    expect(() => service.expire(forever.decisionId, forever.streamVersion)).toThrow("wait-forever attention does not expire");
    journal.close();
  });

  it("expires elapsed decisions durably during polling without answering wait-forever questions", () => {
    const { journal, service, clock } = fixture();
    const deadline = service.requestQuestion({
      ...questionInput(), decisionId: "poll-deadline", attentionId: "poll-deadline-attention",
      expiryPolicy: { kind: "at", expiresAt: "2026-07-19T12:00:00.000Z" },
    });
    const forever = service.requestQuestion({
      ...questionInput(), decisionId: "poll-forever", attentionId: "poll-forever-attention",
      affectedScopes: ["task:forever"], dependentScopes: [],
    });
    const advisoryDeadline = service.requestQuestion({
      ...questionInput(), decisionId: "poll-advisory-deadline", attentionId: "poll-advisory-attention",
      material: false, expiryPolicy: { kind: "at", expiresAt: "2026-07-19T12:00:00.000Z" },
    });
    clock.now = new Date("2026-07-19T12:00:00.001Z");
    expect(service.poll("run-1").map((item) => item.decisionId)).toContain(forever.decisionId);
    expect(service.poll("run-1").map((item) => item.decisionId)).not.toContain(deadline.decisionId);
    expect(service.getDecision(deadline.decisionId)).toMatchObject({ status: "expired", resolution: null });
    expect(service.getDecision(advisoryDeadline.decisionId)).toMatchObject({ status: "expired", resolution: null });
    expect(service.attentionIndex("run-1").pending[deadline.attentionId]).toBeUndefined();
    expect(service.attentionIndex("run-1").pending[forever.attentionId]).toBeDefined();
    journal.close();
  });

  it("uses collision-free canonical attempt stream components", () => {
    const first = decisionAttemptStreamId("a:b", "c");
    const second = decisionAttemptStreamId("a", "b:c");
    expect(first).not.toBe(second);
    expect(parseDecisionAttemptStreamId(first)).toEqual({ decisionId: "a:b", commandId: "c" });
    expect(parseDecisionAttemptStreamId(second)).toEqual({ decisionId: "a", commandId: "b:c" });
  });

  it("preserves atomic approval through archived and projecting journals across reopen", () => {
    const { databasePath, journal } = fixture();
    journal.close();
    const archived = openAuthoritativeJournal(databasePath, "read-write");
    expect(isAtomicEventJournal(archived)).toBe(true);
    const archivedService = new AttentionService(archived, () => new Date("2026-07-19T11:00:00.000Z"));
    const archivedRequest = archivedService.requestApproval({
      ...approvalInput(), decisionId: "archived-approval", attentionId: "archived-attention",
    });
    expect(archivedService.acceptApproval(archivedRequest.decisionId, {
      runId: "run-1", expectedVersion: archivedRequest.streamVersion, planDigest, envelopeDigest,
      actor: { actorId: "alice", kind: "operator", channel: "ui" },
      commandId: "archived-accept", evidenceSha256,
    })).toMatchObject({ status: "accepted" });
    archived.close();

    const reopened = openAuthoritativeJournal(databasePath, "read-write");
    const delivered: number[] = [];
    const projecting = new ProjectingEventJournal(reopened, {
      append: (events) => delivered.push(...events.map((event) => event.globalPosition)),
    }, "attention:wrapper-flow");
    expect(isAtomicEventJournal(projecting)).toBe(true);
    const projectedService = new AttentionService(projecting, () => new Date("2026-07-19T11:00:00.000Z"));
    const projectedRequest = projectedService.requestApproval({
      ...approvalInput(), runId: "run-2", target: "run:run-2",
      decisionId: "projected-approval", attentionId: "projected-attention",
    });
    expect(projectedService.acceptApproval(projectedRequest.decisionId, {
      runId: "run-2", expectedVersion: projectedRequest.streamVersion, planDigest, envelopeDigest,
      actor: { actorId: "alice", kind: "operator", channel: "cli" },
      commandId: "projected-accept", evidenceSha256,
    })).toMatchObject({ status: "accepted" });
    expect(delivered).toEqual([...delivered].sort((left, right) => left - right));
    reopened.close();

    const final = openAuthoritativeJournal(databasePath, "read-write");
    expect(new AttentionService(final).getDecision("projected-approval")).toMatchObject({ status: "accepted" });
    final.close();
  });

  it("orders concurrent material raise and admission without a check-effect race", async () => {
    const { journal, service } = fixture();
    const racingJournal = new AdmissionRaceJournal(journal, () => service.requestQuestion({
      ...questionInput(), decisionId: "racing-question", attentionId: "racing-attention",
    }));
    const racingService = new AttentionService(racingJournal, () => new Date("2026-07-19T11:00:00.000Z"));
    const dispatcher = new AttentionControlledDispatcher(racingService);
    let invoked = 0;
    expect(await dispatcher.dispatch({
      runId: "run-1", admissionId: "racing-admission", scopeId: "task:parser",
      commandId: "racing-dispatch", evidenceSha256, work: () => ++invoked,
    })).toMatchObject({ status: "paused" });
    expect(invoked).toBe(0);

    const following = await new AttentionControlledDispatcher(service).dispatch({
      runId: "run-2", admissionId: "preceding-admission", scopeId: "task:later",
      commandId: "preceding-dispatch", evidenceSha256,
      work: () => {
        service.requestQuestion({
          ...questionInput(), runId: "run-2", decisionId: "following-question",
          attentionId: "following-attention", affectedScopes: ["task:later"], dependentScopes: [],
        });
        return "ran";
      },
    });
    expect(following).toMatchObject({ status: "completed", value: "ran" });
    expect(service.attentionIndex("run-2").revision).toBe(2);
    let duplicateInvoked = 0;
    await expect(new AttentionControlledDispatcher(service).dispatch({
      runId: "run-2", admissionId: "preceding-admission", scopeId: "task:other",
      commandId: "duplicate-dispatch", evidenceSha256, work: () => ++duplicateInvoked,
    })).rejects.toThrow("callback outcome requires reconciliation");
    expect(duplicateInvoked).toBe(0);
    journal.close();
  });

  it("projects strict redacted attention and decision history through the real AgentTail sink", () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-attention-tail-")));
    cleanup.push(root);
    const tracePath = path.join(root, "attention.jsonl");
    const journal = new SqliteEventJournal(path.join(root, "events.sqlite"));
    const sink = AgentTailJsonlFileSink.open(root, tracePath, "run-1");
    const projected = new ProjectingEventJournal(journal, sink);
    seedRun(projected, "run-1");
    const service = new AttentionService(projected, () => new Date("2026-07-19T11:00:00.000Z"));
    const canary = "ATTENTION_SECRET_CANARY";

    const question = service.requestQuestion({
      ...questionInput(), decisionId: "tail-question", attentionId: "tail-question-attention",
      question: canary, recommendation: { optionId: "safe", rationale: canary },
      options: [{ optionId: "safe", label: canary, impacts: [canary] }], impacts: [canary],
    });
    service.answer(question.decisionId, {
      runId: "run-1", expectedVersion: question.streamVersion, optionId: "safe",
      actor: { actorId: "tail-operator", kind: "operator", channel: "ui" },
      commandId: "tail-answer", evidenceSha256,
    });

    const stale = service.requestApproval({
      ...approvalInput(), decisionId: "tail-stale", attentionId: "tail-stale-attention",
      summary: canary, expectedEffect: canary, proposedStateChange: canary, risk: canary,
      mitigationOrRollback: canary, impacts: [canary],
    });
    const runs = new RunService(projected);
    let run = runs.get("run-1")!;
    run = runs.revisePlan("run-1", run.streamVersion, "tail-plan-revised");
    service.poll("run-1");
    expect(() => service.acceptApproval(stale.decisionId, approvalSubmission(stale, "tail-stale-attempt")))
      .toThrow("decision is already consumed");

    run = runs.requestApproval("run-1", run.streamVersion, "tail-replacement-request", {
      planDigest, envelopeDigest,
    });
    const accepted = service.requestApproval({
      ...approvalInput(), decisionId: "tail-approved", attentionId: "tail-approved-attention",
    });
    service.acceptApproval(accepted.decisionId, approvalSubmission(accepted, "tail-approve"));

    expect(projected.projectionFailed).toBe(false);
    expect(journal.inspectProjectionCursor(sink.projectionCursorName)).toMatchObject({
      position: journal.readAll().at(-1)?.globalPosition,
      activeClaimId: null,
    });
    sink.close();
    const retained = readFileSync(tracePath, "utf8");
    expect(retained).not.toContain(canary);
    const lines = retained.trim().split("\n").map((line) =>
      JSON.parse(line) as { readonly kind: string; readonly payload: unknown });
    const attentionPayloads = lines.filter((line) =>
      /^(?:questionnaire|decision|approval|attention)\./.test(line.kind)).map((line) => line.payload);
    const payloadKeys = new Set(attentionPayloads.flatMap(allObjectKeys));
    for (const forbidden of [
      "recommendation", "options", "reason", "question", "message", "summary",
      "expectedEffect", "risk", "token",
    ]) expect(payloadKeys.has(forbidden)).toBe(false);
    const kinds = lines.map((line) => line.kind);
    for (const kind of [
      "questionnaire.proposed", "decision.requested", "decision.accepted",
      "attention.raised", "attention.resolved", "attention.index_raised",
      "attention.index_resolved", "attention.identity_reserved", "approval.requested",
      "approval.stale", "approval.duplicate_attempted", "approval.reserved",
      "approval.reservation_consumed", "run.plan_revised", "approval.accepted",
      "run.ready_for_execution",
    ]) expect(kinds).toContain(kind);
    journal.close();
  });

  it("serializes valid answer, rejection, and stale spam across independent processes", async () => {
    const { databasePath, journal, service } = fixture();
    for (let iteration = 0; iteration < 10; iteration++) {
      const requested = service.requestQuestion({
        ...questionInput(), decisionId: `process-question-${iteration}`, attentionId: `process-attention-${iteration}`,
      });
      const answerId = `process-answer-${iteration}`;
      const rejectId = `process-reject-${iteration}`;
      const spamId = `process-spam-${iteration}`;
      const results = await runCompetingProcesses(databasePath, [
        childCommand("answer", requested.decisionId, {
          runId: "run-1", expectedVersion: requested.streamVersion, optionId: "safe",
          actor: { actorId: answerId, kind: "operator", channel: "api" },
          commandId: answerId, evidenceSha256,
        }),
        childCommand("reject", requested.decisionId, {
          runId: "run-1", expectedVersion: requested.streamVersion, reason: "Rejected from another process.",
          actor: { actorId: rejectId, kind: "operator", channel: "api" },
          commandId: rejectId, evidenceSha256,
        }),
        childCommand("answer", requested.decisionId, {
          runId: "run-1", expectedVersion: requested.streamVersion - 1, optionId: "safe",
          actor: { actorId: spamId, kind: "operator", channel: "api" },
          commandId: spamId, evidenceSha256,
        }, "projecting"),
      ]);
      expect(results.slice(0, 2).filter((result) => result.status === "accepted")).toHaveLength(1);
      expect(service.getDecision(requested.decisionId)?.status).toMatch(/accepted|rejected/);
      const loserId = results[0]!.status === "rejected" ? answerId : rejectId;
      expect(service.readAttemptStream(requested.decisionId, loserId), JSON.stringify(results)).toHaveLength(1);
      expect(service.readAttemptStream(requested.decisionId, spamId), JSON.stringify(results)).toHaveLength(1);
      expect(service.readAttemptStream(
        requested.decisionId,
        results[0]!.status === "accepted" ? answerId : rejectId,
      )).toHaveLength(0);
    }
    journal.close();

    const reopened = new SqliteEventJournal(databasePath);
    expect(new AttentionService(reopened).getDecision("process-question-9")?.status).toMatch(/accepted|rejected/);
    reopened.close();
  }, 20_000);

  it("rolls back an independent-process approval if a legal run revision wins", async () => {
    const { databasePath, journal, service } = fixture();
    const requested = service.requestApproval({
      ...approvalInput(), decisionId: "process-approval", attentionId: "process-approval-attention",
    });
    const approval = childCommand("acceptApproval", requested.decisionId, approvalSubmission(requested, "process-approve"), "projecting");
    const revision = childCommand("revisePlan", undefined, { runId: "run-1", commandId: "process-revision" });
    const [approvalResult, revisionResult] = await runCompetingProcesses(databasePath, [approval, revision]);
    expect([approvalResult, revisionResult].filter((result) => result?.status === "accepted")).toHaveLength(1);
    const reopened = new AttentionService(journal, () => new Date("2026-07-19T11:00:00.000Z"));
    if (approvalResult!.status === "rejected") {
      expect(reopened.getDecision(requested.decisionId)).toMatchObject({ status: "stale" });
      expect(reopened.readAttemptStream(requested.decisionId, "process-approve").length).toBeLessThanOrEqual(1);
      const requestEventId = (requested.packet as { approvalRequestEventId: string }).approvalRequestEventId;
      expect(reopened.approvalReservation("run-1", requestEventId)).toMatchObject({ status: "consumed", outcome: "stale" });
    } else {
      expect(reopened.getDecision(requested.decisionId)).toMatchObject({ status: "accepted" });
      expect(reopened.readAttemptStream(requested.decisionId, "process-approve")).toHaveLength(0);
      expect(revisionResult!.status).toMatch(/accepted|rejected/);
    }
    journal.close();
    const final = new SqliteEventJournal(databasePath);
    expect(new AttentionService(final).getDecision(requested.decisionId)?.status).toMatch(/accepted|stale/);
    final.close();
  });

  it("uses real child services for packet validation and trusted-clock expiry", async () => {
    const { databasePath, journal, service } = fixture();
    const approval = service.requestApproval({
      ...approvalInput(), decisionId: "child-packet-approval", attentionId: "child-packet-attention",
    });
    const [invalid] = await runCompetingProcesses(databasePath, [childCommand(
      "acceptApproval",
      approval.decisionId,
      { ...approvalSubmission(approval, "child-invalid-packet"), planDigest: "0".repeat(64) },
      "projecting",
    )]);
    expect(invalid).toMatchObject({ status: "rejected", error: expect.stringContaining("exact packet") });
    expect(service.getDecision(approval.decisionId)).toMatchObject({ status: "pending" });
    expect(service.readAttempts(approval.decisionId)).toHaveLength(1);

    const deadline = service.requestQuestion({
      ...questionInput(), decisionId: "child-expiry", attentionId: "child-expiry-attention",
      expiryPolicy: { kind: "at", expiresAt: "2026-07-19T12:00:00.000Z" },
    });
    const [expired] = await runCompetingProcesses(databasePath, [childCommand("answer", deadline.decisionId, {
      runId: "run-1", expectedVersion: deadline.streamVersion, optionId: "safe",
      actor: { actorId: "child-expiry", kind: "operator", channel: "api" },
      commandId: "child-expiry-answer", evidenceSha256,
    }, "projecting", "2026-07-19T12:00:00.001Z")]);
    expect(expired).toMatchObject({ status: "rejected", error: "decision has expired" });
    expect(service.getDecision(deadline.decisionId)).toMatchObject({ status: "expired", resolution: null });
    journal.close();
    const reopened = openAuthoritativeJournal(databasePath, "read-write");
    expect(new AttentionService(reopened).getDecision(deadline.decisionId)).toMatchObject({ status: "expired" });
    reopened.close();
  });
});

class ConflictOnceJournal implements AtomicEventJournal {
  readonly [ATOMIC_EVENT_JOURNAL] = true;
  private conflict = true;
  constructor(private readonly delegate: EventJournal) {}
  append(streamId: string, expectedVersion: number, events: Parameters<EventJournal["append"]>[2]) {
    return this.delegate.append(streamId, expectedVersion, events);
  }
  appendAtomically(writes: readonly AtomicAppend[]) {
    if (this.conflict && writes.some((write) => write.events.some((event) => event.type === "decision.accepted"))) {
      this.conflict = false;
      const expectedVersion = writes.find((write) => write.events.some((event) => event.type === "decision.accepted"))!.expectedVersion;
      throw new Error(`expected version ${expectedVersion}, actual ${expectedVersion + 1}`);
    }
    if (!(this.delegate instanceof SqliteEventJournal)) throw new Error("test delegate lacks atomic append");
    return this.delegate.appendAtomically(writes);
  }
  readStream(streamId: string, afterVersion?: number) { return this.delegate.readStream(streamId, afterVersion); }
  readAll(afterPosition?: number) { return this.delegate.readAll(afterPosition); }
}

class RunRaceJournal implements AtomicEventJournal {
  readonly [ATOMIC_EVENT_JOURNAL] = true;
  private raced = false;
  constructor(private readonly delegate: SqliteEventJournal) {}
  append(streamId: string, expectedVersion: number, events: Parameters<EventJournal["append"]>[2]) {
    return this.delegate.append(streamId, expectedVersion, events);
  }
  appendAtomically(writes: readonly AtomicAppend[]) {
    if (!this.raced && writes.some((write) => write.events.some((event) => event.type === "approval.accepted"))) {
      this.raced = true;
      const runs = new RunService(this.delegate);
      const run = runs.get("run-1")!;
      runs.wait("run-1", run.streamVersion, "atomic-race-revision", "plan_revised");
    }
    return this.delegate.appendAtomically(writes);
  }
  readStream(streamId: string, afterVersion?: number) { return this.delegate.readStream(streamId, afterVersion); }
  readAll(afterPosition?: number) { return this.delegate.readAll(afterPosition); }
}

class AdmissionRaceJournal implements AtomicEventJournal {
  readonly [ATOMIC_EVENT_JOURNAL] = true;
  private raced = false;
  constructor(
    private readonly delegate: SqliteEventJournal,
    private readonly raise: () => unknown,
  ) {}
  append(streamId: string, expectedVersion: number, events: Parameters<EventJournal["append"]>[2]) {
    return this.delegate.append(streamId, expectedVersion, events);
  }
  appendAtomically(writes: readonly AtomicAppend[]) {
    if (!this.raced && writes.some((write) => write.events.some((event) => event.type === "attention.scope_admitted"))) {
      this.raced = true;
      this.raise();
    }
    return this.delegate.appendAtomically(writes);
  }
  readStream(streamId: string, afterVersion?: number) { return this.delegate.readStream(streamId, afterVersion); }
  readAll(afterPosition?: number) { return this.delegate.readAll(afterPosition); }
}

function approvalSubmission(requested: AttentionView, commandId: string) {
  return {
    runId: requested.runId,
    expectedVersion: requested.streamVersion,
    planDigest,
    envelopeDigest,
    actor: { actorId: "alice", kind: "operator" as const, channel: "ui" as const },
    commandId,
    evidenceSha256,
  };
}

function allObjectKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(allObjectKeys);
  const record = value as Readonly<Record<string, unknown>>;
  return Object.entries(record).flatMap(([key, child]) => [key, ...allObjectKeys(child)]);
}

function childCommand(
  action: "answer" | "reject" | "requestQuestion" | "requestApproval" | "acceptApproval" | "raiseWarning" | "revisePlan",
  decisionId: string | undefined,
  input: unknown,
  wrapper?: "projecting",
  now = "2026-07-19T11:00:00.000Z",
) {
  return {
    action,
    now,
    ...(decisionId === undefined ? {} : { decisionId }),
    ...(wrapper === undefined ? {} : { wrapper }),
    input,
  };
}

async function runCompetingProcesses(
  databasePath: string,
  commands: readonly unknown[],
): Promise<readonly { readonly status: "accepted" | "rejected"; readonly error?: string; readonly value?: unknown }[]> {
  const barrier = path.join(path.dirname(databasePath), `attention-barrier-${Date.now()}`);
  const fixturePath = path.resolve("tests/attention/competing-attention-process.ts");
  const viteNode = path.resolve("node_modules/.bin/vite-node");
  const children = commands.map((command) => new Promise<{ readonly status: "accepted" | "rejected"; readonly error?: string; readonly value?: unknown }>((resolve, reject) => {
    const child = spawn(viteNode, [fixturePath, databasePath, barrier, Buffer.from(JSON.stringify(command)).toString("base64url")], {
      cwd: path.resolve("."),
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", TMPDIR: process.env["TMPDIR"] ?? "/tmp" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr));
      resolve(JSON.parse(stdout) as { readonly status: "accepted" | "rejected"; readonly error?: string; readonly value?: unknown });
    });
  }));
  writeFileSync(barrier, "go", { mode: 0o600 });
  return Promise.all(children);
}
