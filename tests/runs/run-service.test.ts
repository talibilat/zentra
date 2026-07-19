import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { projectRun } from "../../src/runs/run-projection.js";
import { RunService } from "../../src/runs/run-service.js";
import { ServiceLifecycleService } from "../../src/runs/service-lifecycle.js";
import { storedEventToAgentTailEvent } from "../../src/observability/agent-tail.js";
import { intakeStreamId } from "../../src/intake/intake-service.js";
import { IntakeService } from "../../src/intake/intake-service.js";
import { IntakeArtifactStore } from "../../src/intake/intake-artifact-store.js";
import { computeIntakeSnapshotSha256 } from "../../src/intake/intake-contracts.js";
import { BoundedTicketIntake } from "../../src/intake/ticket-intake.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(seedService = true) {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-run-"));
  cleanup.push(directory);
  const databasePath = path.join(directory, "events.sqlite");
  const journal = new SqliteEventJournal(databasePath);
  const service = new RunService(journal);
  let input = accepted;
  if (seedService) {
    const services = new ServiceLifecycleService(journal);
    const starting = services.start({
      serviceId: "zentra-local", process: accepted.process,
      address: { host: "127.0.0.1", port: 43_219 }, tokenExpiresAt: "2026-07-19T13:00:00.000Z",
      observation: "performed", commandId: "fixture-service-start",
    });
    const ready = services.ready({
      serviceId: "zentra-local", process: accepted.process,
      address: { host: "127.0.0.1", port: 43_219 }, runtimeSchemaVersion: 1, journalSchemaVersion: 2,
      observation: "performed", commandId: "fixture-service-ready", causationId: starting.eventId,
    });
    input = { ...accepted, causationId: ready.eventId };
  }
  return { directory, databasePath, journal, service, input };
}

const intakeGoal = "inspect the durable intake";
const intakeLimits = {
  maxFileBytes: 1_000,
  maxFiles: 10,
  maxTotalBytes: 1_000,
  maxDepth: 0,
  maxEntries: 10,
  maxDirectoryEntries: 10,
};

const accepted = {
  runId: "run-89",
  projectId: "zentra",
  projectRevision: { objectFormat: "sha1" as const, commit: "a".repeat(40) },
  source: {
    kind: "inline_goal" as const,
    referenceSha256: createHash("sha256").update(intakeGoal).digest("hex"),
    declaredBytes: Buffer.byteLength(intakeGoal),
  },
  actor: { actorId: "operator-1", kind: "operator" as const },
  process: { pid: 123, processIncarnation: `process-v2:${"c".repeat(64)}` },
  budget: {
    maxDurationMs: 60_000,
    maxInputTokens: 10_000,
    maxOutputTokens: 2_000,
    maxCostUsdNano: 1_000_000_000,
    maxRetries: 0,
    maxSourceFiles: 100,
    maxSourceBytes: 1_000_000,
  },
  commandId: "accept-1",
  causationId: "service-ready-event",
};

describe("RunService", () => {
  it("durably records service startup and readiness with process identity", () => {
    const { journal } = fixture(false);
    const services = new ServiceLifecycleService(journal);
    const starting = services.start({
      serviceId: "zentra-local",
      process: accepted.process,
      address: { host: "127.0.0.1", port: 43_219 },
      tokenExpiresAt: "2026-07-19T13:00:00.000Z",
      observation: "performed",
      commandId: "service-start-1",
    });
    const ready = services.ready({
      serviceId: "zentra-local",
      process: accepted.process,
      address: { host: "127.0.0.1", port: 43_219 },
      runtimeSchemaVersion: 1,
      journalSchemaVersion: 2,
      observation: "performed",
      commandId: "service-ready-1",
      causationId: starting.eventId,
    });

    expect([starting.type, ready.type]).toEqual(["service.starting", "service.ready"]);
    expect(ready.causationId).toBe(starting.eventId);
    expect(storedEventToAgentTailEvent(ready)).toMatchObject({
      kind: "service.ready",
      actor: { id: "zentra-runtime", role: "service" },
      operation: { name: "service_startup", status: "completed" },
    });
    journal.close();
  });

  it("reopens the exact approval state after verified intake and denies direct unverified analysis", async () => {
    const { directory, databasePath, journal, service, input } = fixture();
    let run = service.accept(input);
    run = service.startPreflight("run-89", {
      expectedVersion: run.streamVersion,
      commandId: "preflight-start-1",
      causationId: service.readStream("run-89")[0]!.eventId,
      process: accepted.process,
    });
    run = service.completePreflight("run-89", {
      expectedVersion: run.streamVersion,
      commandId: "preflight-complete-1",
      causationId: service.readStream("run-89").at(-1)!.eventId,
      process: accepted.process,
    });
    const intake = new IntakeService(
      journal,
      service,
      new BoundedTicketIntake(),
      await IntakeArtifactStore.openProject(directory),
    );
    const result = await intake.intake({
      runId: input.runId,
      projectRevision: input.projectRevision,
      source: { kind: "inline_goal", goal: intakeGoal },
      limits: intakeLimits,
      commandId: "intake-1",
    });
    run = result.run;
    expect(() => service.completeAnalysis("run-89", run.streamVersion, "analysis-1", undefined as never))
      .toThrow(/capability|verified intake artifact/i);
    run = (await intake.completeAnalysis("run-89", run.streamVersion, "analysis-1")).run;
    run = service.requestApproval("run-89", run.streamVersion, "approval-request-1", {
      planDigest: "d".repeat(64),
      envelopeDigest: "e".repeat(64),
    });
    expect(run).toMatchObject({
      lifecycle: "awaiting_approval",
      terminalOutcome: null,
      authority: {
        approvalState: "approval_pending",
        executionAuthority: "none",
        planDigest: "d".repeat(64),
        envelopeDigest: "e".repeat(64),
        approvalDecisionId: null,
      },
    });
    journal.close();

    const reopenedJournal = new SqliteEventJournal(databasePath);
    const reopened = new RunService(reopenedJournal).reopen("run-89");
    expect(reopened).toEqual(run);
    reopenedJournal.close();
  });

  it("reconciles a repeated acceptance command after a lost acknowledgement", () => {
    const { journal, service, input } = fixture();
    const first = service.accept(input);
    expect(service.accept(input)).toEqual(first);
    expect(service.readStream("run-89")).toHaveLength(1);
    expect(() => service.accept({ ...input, source: { ...input.source, declaredBytes: 33 } }))
      .toThrow("already exists with different acceptance input");
    journal.close();
  });

  it("rejects minimal source payloads and fabricated canonical snapshot digests", () => {
    for (const mode of ["minimal", "fabricated_digest"] as const) {
      const { journal, service, input } = fixture();
      let run = service.accept(input);
      run = service.startPreflight("run-89", {
        expectedVersion: run.streamVersion,
        commandId: `preflight-start-${mode}`,
        causationId: service.readStream("run-89")[0]!.eventId,
        process: accepted.process,
      });
      run = service.completePreflight("run-89", {
        expectedVersion: run.streamVersion,
        commandId: `preflight-complete-${mode}`,
        causationId: service.readStream("run-89").at(-1)!.eventId,
        process: accepted.process,
      });
      const closure = seedIntakeClosure(journal, service, mode);
      expect(() => service.completeIntake("run-89", run.streamVersion, `intake-${mode}`, closure))
        .toThrow(/intake|source|snapshot|unrecognized|required/i);
      expect(service.get("run-89")?.lifecycle).toBe("intake");
      journal.close();
    }
  });

  it("durably reopens under a separately ready process incarnation", () => {
    const { databasePath, journal, service, input } = fixture();
    let run = service.accept(input);
    run = service.startPreflight(input.runId, {
      expectedVersion: run.streamVersion, commandId: "takeover-preflight", causationId: service.readStream(input.runId).at(-1)!.eventId,
      process: input.process,
    });
    journal.close();

    const reopenedJournal = new SqliteEventJournal(databasePath);
    const newProcess = { pid: 456, processIncarnation: `process-v2:${"9".repeat(64)}` };
    const lifecycle = new ServiceLifecycleService(reopenedJournal);
    const starting = lifecycle.start({
      serviceId: "zentra-local", process: newProcess, address: { host: "127.0.0.1", port: 43_220 },
      tokenExpiresAt: "2026-07-19T14:00:00.000Z", observation: "performed", commandId: "takeover-service-start",
    });
    const ready = lifecycle.ready({
      serviceId: "zentra-local", process: newProcess, address: { host: "127.0.0.1", port: 43_220 },
      runtimeSchemaVersion: 1, journalSchemaVersion: 2, observation: "performed",
      commandId: "takeover-service-ready", causationId: starting.eventId,
    });
    const reopenedService = new RunService(reopenedJournal);
    run = reopenedService.reopenWithProcess(input.runId, run.streamVersion, "takeover-run", newProcess, ready.eventId);
    run = reopenedService.completePreflight(input.runId, {
      expectedVersion: run.streamVersion, commandId: "takeover-complete", causationId: reopenedService.readStream(input.runId).at(-1)!.eventId,
      process: newProcess,
    });
    expect(run).toMatchObject({ lifecycle: "intake", acceptedBy: input.process, activeProcess: newProcess });
    reopenedJournal.close();

    const replay = new SqliteEventJournal(databasePath);
    expect(new RunService(replay).reopen(input.runId)).toEqual(run);
    replay.close();
  });

  it("enforces optimistic versions and leaves invalid transitions unappended", () => {
    const { journal, service, input } = fixture();
    const run = service.accept(input);

    expect(() => service.completeAnalysis("run-89", run.streamVersion, "bad-analysis", undefined as never))
      .toThrow(/invalid run transition/);
    expect(service.readStream("run-89")).toHaveLength(1);
    expect(() => service.startPreflight("run-89", {
      expectedVersion: 0,
      commandId: "stale",
      causationId: null,
      process: accepted.process,
    })).toThrow("expected version 0, actual 1");
    journal.append("run:run-89", 1, [{
      streamId: "run:run-89", type: "run.completed",
      payload: {
        schemaVersion: 1, commandId: "forged-completion", evidenceSha256: "f".repeat(64),
        process: input.process, executionAuthority: "none",
      },
      causationId: null, correlationId: "run-89",
    }]);
    expect(() => service.reopen("run-89")).toThrow("run completion requires approved_and_ready_for_execution");
    journal.close();
  });

  it("cancels idempotently with one durable evidence event and rejects post-terminal changes", () => {
    const { databasePath, journal, service, input } = fixture();
    const run = service.accept(input);
    const cancelled = service.cancel("run-89", {
      expectedVersion: run.streamVersion,
      commandId: "cancel-command-1",
      causationId: null,
      process: accepted.process,
    }, {
      cancellationId: "cancel-1",
      requestedBy: accepted.actor,
      reasonCode: "operator_requested",
    });

    expect(service.cancel("run-89", {
      expectedVersion: 0,
      commandId: "cancel-command-1",
      causationId: null,
      process: accepted.process,
    }, {
      cancellationId: "cancel-1",
      requestedBy: accepted.actor,
      reasonCode: "operator_requested",
    })).toEqual(cancelled);
    expect(service.readStream("run-89").filter((event) => event.type === "run.cancelled")).toHaveLength(1);
    expect(() => service.completeIntake("run-89", cancelled.streamVersion, "after-terminal", {
      sourceStreamId: "source-intake:terminal",
      closureEventId: "missing",
      snapshotSha256: "c".repeat(64),
      sourceCount: 0,
      rejectedCount: 0,
      totalBytes: 0,
    }))
      .toThrow("run is already terminal");
    journal.close();

    const reopened = new SqliteEventJournal(databasePath);
    expect(projectRun(reopened.readStream("run:run-89"))).toEqual(cancelled);
    reopened.close();
  });

  it("keeps waiting and preflight failure blocked states nonterminal and resumable", () => {
    const { journal, service, input } = fixture();
    let run = service.accept(input);
    run = service.wait("run-89", run.streamVersion, "wait-1", "operator_attention");
    expect(run).toMatchObject({ lifecycle: "waiting", terminalOutcome: null, suspendedFrom: "accepted" });
    run = service.resume("run-89", run.streamVersion, "resume-1");
    run = service.startPreflight("run-89", {
      expectedVersion: run.streamVersion, commandId: "preflight-1", causationId: null, process: accepted.process,
    });
    run = service.failPreflight("run-89", {
      expectedVersion: run.streamVersion, commandId: "preflight-failed-1", causationId: null, process: accepted.process,
    }, { reasonCode: "project_revision_changed", diagnosticSha256: "f".repeat(64), disposition: "blocked" });
    expect(run).toMatchObject({ lifecycle: "blocked", terminalOutcome: null, suspendedFrom: "preflighting" });
    run = service.resume("run-89", run.streamVersion, "resume-preflight-1");
    expect(run.lifecycle).toBe("preflighting");
    journal.close();
  });

  it("revises only the current approval request back to planning", async () => {
    const { directory, journal, service, input } = fixture();
    let run = service.accept(input);
    run = service.startPreflight(input.runId, {
      expectedVersion: run.streamVersion, commandId: "revise-preflight-start",
      causationId: service.readStream(input.runId).at(-1)!.eventId, process: input.process,
    });
    run = service.completePreflight(input.runId, {
      expectedVersion: run.streamVersion, commandId: "revise-preflight-complete",
      causationId: service.readStream(input.runId).at(-1)!.eventId, process: input.process,
    });
    const intake = new IntakeService(
      journal,
      service,
      new BoundedTicketIntake(),
      await IntakeArtifactStore.openProject(directory),
    );
    run = (await intake.intake({
      runId: input.runId,
      projectRevision: input.projectRevision,
      source: { kind: "inline_goal", goal: intakeGoal },
      limits: intakeLimits,
      commandId: "revise-intake",
    })).run;
    run = (await intake.completeAnalysis(input.runId, run.streamVersion, "revise-analysis")).run;
    run = service.requestApproval(input.runId, run.streamVersion, "revise-approval-1", {
      planDigest: "d".repeat(64), envelopeDigest: "e".repeat(64),
    });
    run = service.revisePlan(input.runId, run.streamVersion, "revise-plan");
    expect(run).toMatchObject({
      lifecycle: "planning",
      authority: { approvalState: "not_proposed", planDigest: null, envelopeDigest: null },
    });
    expect(() => service.revisePlan(input.runId, run.streamVersion, "revise-again"))
      .toThrow("requires the current approval request event");
    expect(service.requestApproval(input.runId, run.streamVersion, "revise-approval-2", {
      planDigest: "d".repeat(64), envelopeDigest: "e".repeat(64),
    })).toMatchObject({ lifecycle: "awaiting_approval" });
    journal.close();
  });
});

function seedIntakeClosure(
  journal: SqliteEventJournal,
  service: RunService,
  mode: "valid" | "minimal" | "fabricated_digest" = "valid",
) {
  const streamId = intakeStreamId("run-89");
  const preflightEventId = service.readStream("run-89").at(-1)!.eventId;
  const digest = "c".repeat(64);
  const limits = {
    maxFileBytes: 1024,
    maxFiles: 100,
    maxTotalBytes: 1_000_000,
    maxDepth: 0,
    maxEntries: 100,
    maxDirectoryEntries: 100,
  };
  const provenance = {
    runId: "run-89",
    projectId: accepted.projectId,
    projectRevision: accepted.projectRevision,
    sourceKind: "inline_goal" as const,
    rootIdentitySha256: "e".repeat(64),
    device: null,
    inode: null,
    modifiedNanoseconds: null,
    changedNanoseconds: null,
  };
  const discovered = {
    schemaVersion: 1 as const,
    runId: "run-89",
    projectId: accepted.projectId,
    commandId: "fixture-intake-close",
    requestSha256: "d".repeat(64),
    eventIndex: 0,
    evidenceCount: 1,
    sourceKind: "inline_goal" as const,
    limits,
    snapshotTotalBytes: 32,
    path: "$inline",
    provenance,
    sourceId: `source-v1:${createHash("sha256").update(`run-89\0$inline\0${digest}`).digest("hex")}`,
    sizeBytes: 32,
    digest,
    trust: "untrusted_planning_data" as const,
    mediaType: "text/plain; charset=utf-8" as const,
    artifact: { artifactId: `intake-text-v1:${digest}`, sha256: digest, sizeBytes: 32 },
  };
  const snapshotSha256 = computeIntakeSnapshotSha256({
    closure: {
      schemaVersion: 1,
      runId: "run-89",
      projectId: accepted.projectId,
      projectRevision: accepted.projectRevision,
      commandId: "fixture-intake-close",
      requestSha256: "d".repeat(64),
      sourceKind: "inline_goal",
      limits,
      totalBytes: 32,
    },
    discovered: [discovered],
    rejected: [],
  });
  const evidence = journal.append(streamId, 0, [{
    streamId,
    type: "source.discovered",
    payload: mode === "minimal" ? { schemaVersion: 1, runId: "run-89", path: "$inline" } : discovered,
    causationId: preflightEventId,
    correlationId: "run-89",
  }])[0]!;
  const stored = journal.append(streamId, 1, [{
    streamId,
    type: "intake.snapshot_closed",
    payload: {
      schemaVersion: 1,
      runId: "run-89",
      projectId: accepted.projectId,
      projectRevision: accepted.projectRevision,
      commandId: "fixture-intake-close",
      requestSha256: "d".repeat(64),
      sourceKind: "inline_goal",
      limits,
      snapshotSha256: mode === "fabricated_digest" ? "f".repeat(64) : snapshotSha256,
      sourceCount: 1,
      rejectedCount: 0,
      totalBytes: 32,
      evidenceCount: 1,
    },
    causationId: evidence.eventId,
    correlationId: "run-89",
  }])[0]!;
  return {
    sourceStreamId: streamId,
    closureEventId: stored.eventId,
    snapshotSha256: mode === "fabricated_digest" ? "f".repeat(64) : snapshotSha256,
    sourceCount: 1,
    rejectedCount: 0,
    totalBytes: 32,
  };
}
