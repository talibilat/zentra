import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { projectRun } from "../../src/runs/run-projection.js";
import { RunService } from "../../src/runs/run-service.js";
import { ServiceLifecycleService } from "../../src/runs/service-lifecycle.js";
import { storedEventToAgentTailEvent } from "../../src/observability/agent-tail.js";

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
  return { databasePath, journal, service, input };
}

const accepted = {
  runId: "run-89",
  projectId: "zentra",
  projectRevision: { objectFormat: "sha1" as const, commit: "a".repeat(40) },
  source: { kind: "inline_goal" as const, referenceSha256: "b".repeat(64), declaredBytes: 32 },
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

  it("reopens the exact authority-neutral ready state", () => {
    const { databasePath, journal, service, input } = fixture();
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
    run = service.completeIntake("run-89", run.streamVersion, "intake-1");
    run = service.completeAnalysis("run-89", run.streamVersion, "analysis-1");
    run = service.requestApproval("run-89", run.streamVersion, "approval-request-1", {
      planDigest: "d".repeat(64),
      envelopeDigest: "e".repeat(64),
    });
    run = service.markApprovedAndReadyForExecution(
      "run-89",
      run.streamVersion,
      "approval-ready-1",
      { planDigest: "d".repeat(64), envelopeDigest: "e".repeat(64), approvalDecisionId: "decision-1" },
    );

    expect(run).toMatchObject({
      lifecycle: "approved_and_ready_for_execution",
      terminalOutcome: null,
      authority: {
        approvalState: "approved",
        executionAuthority: "none",
        planDigest: "d".repeat(64),
        envelopeDigest: "e".repeat(64),
        approvalDecisionId: "decision-1",
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

    expect(() => service.completeAnalysis("run-89", run.streamVersion, "bad-analysis"))
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
    expect(() => service.completeIntake("run-89", cancelled.streamVersion, "after-terminal"))
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
});
