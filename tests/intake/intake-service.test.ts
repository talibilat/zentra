import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BoundedTicketIntake } from "../../src/intake/ticket-intake.js";
import { IntakeArtifactStore } from "../../src/intake/intake-artifact-store.js";
import { IntakeService, intakeStreamId } from "../../src/intake/intake-service.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { RunService } from "../../src/runs/run-service.js";
import { ServiceLifecycleService } from "../../src/runs/service-lifecycle.js";
import { seedAgentTrailReady } from "../fixtures/service-ready.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("IntakeService durable orchestration", () => {
  it("loads the authoritative run and causally closes evidence before analysis", async () => {
    const fixture = preparedRun();
    writeFileSync(path.join(fixture.sourceRoot, "ticket.txt"), "untrusted ticket\n");
    const service = new IntakeService(fixture.journal, fixture.runs, new BoundedTicketIntake(), await artifacts(fixture));

    const result = await service.intake(request(fixture));

    expect(result.run.lifecycle).toBe("analyzing");
    expect(result.snapshot?.snapshotSha256).toBe(result.closure.snapshotSha256);
    const sourceEvents = fixture.journal.readStream(intakeStreamId(RUN_ID));
    expect(sourceEvents.map((event) => event.type)).toEqual([
      "source.discovered",
      "intake.snapshot_closed",
    ]);
    expect(JSON.stringify(sourceEvents)).not.toContain("untrusted ticket");
    expect(sourceEvents[0]!.payload).toMatchObject({
      artifact: {
        artifactId: expect.stringMatching(/^intake-text-v1:[a-f0-9]{64}$/),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sizeBytes: 17,
      },
    });
    expect(sourceEvents[0]!.causationId).toBe(fixture.preflightEventId);
    expect(sourceEvents[1]!.causationId).toBe(sourceEvents[0]!.eventId);
    expect(sourceEvents[1]!.payload).toMatchObject({
      runId: RUN_ID,
      projectRevision: REVISION,
      sourceCount: 1,
      rejectedCount: 0,
      totalBytes: 17,
    });
    const runIntake = fixture.runs.readStream(RUN_ID).at(-1)!;
    expect(runIntake.type).toBe("run.intake_completed");
    expect(runIntake.causationId).toBe(sourceEvents[1]!.eventId);

    const retained = await service.loadRetainedAnalysisSnapshot(RUN_ID);
    expect(fixture.runs.get(RUN_ID)?.lifecycle).toBe("analyzing");
    expect(retained.snapshot.sources[0]?.quotedText).toBe("untrusted ticket\n");
    await expect(service.completeAnalysis(RUN_ID, result.run.streamVersion, "analysis-90"))
      .rejects.toThrow("only through AnalysisCoordinator");
    fixture.journal.close();
  });

  it("rejects a stale revision and never accepts a caller-fabricated run view", async () => {
    const fixture = preparedRun();
    writeFileSync(path.join(fixture.sourceRoot, "ticket.txt"), "ticket");
    const service = new IntakeService(fixture.journal, fixture.runs, new BoundedTicketIntake(), await artifacts(fixture));

    await expect(service.intake({
      ...request(fixture),
      projectRevision: { objectFormat: "sha1", commit: "f".repeat(40) },
    })).rejects.toThrow(/revision/i);
    expect(fixture.journal.readStream(intakeStreamId(RUN_ID))).toEqual([]);
    fixture.journal.close();
  });

  it("cannot transition analysis before a matching durable closure", () => {
    const fixture = preparedRun();
    expect(() => fixture.runs.completeAnalysis(RUN_ID, fixture.runVersion, "analysis-too-early", undefined as never))
      .toThrow(/intake|transition/i);
    expect(() => fixture.runs.completeIntake(RUN_ID, fixture.runVersion, "fabricated-close", {
      sourceStreamId: intakeStreamId(RUN_ID),
      closureEventId: "missing-closure",
      snapshotSha256: "c".repeat(64),
      sourceCount: 1,
      rejectedCount: 0,
      totalBytes: 1,
    })).toThrow(/closure/i);
    fixture.journal.close();
  });

  it("durably records safe rejections but never closes a wholly rejected intake", async () => {
    const fixture = preparedRun();
    writeFileSync(path.join(fixture.sourceRoot, "binary"), Buffer.from([0x00]));
    const service = new IntakeService(fixture.journal, fixture.runs, new BoundedTicketIntake(), await artifacts(fixture));

    await expect(service.intake(request(fixture))).rejects.toMatchObject({ code: "no_accepted_sources" });
    const events = fixture.journal.readStream(intakeStreamId(RUN_ID));
    expect(events.map((event) => event.type)).toEqual(["source.rejected"]);
    expect(events[0]!.payload).toMatchObject({ path: "binary", reason: "binary", sizeBytes: 1 });
    expect(JSON.stringify(events)).not.toContain("quotedText");
    await expect(service.intake(request(fixture))).rejects.toMatchObject({ code: "no_accepted_sources" });
    expect(fixture.journal.readStream(intakeStreamId(RUN_ID))).toHaveLength(1);
    expect(fixture.runs.get(RUN_ID)?.lifecycle).toBe("intake");
    fixture.journal.close();
  });

  it("reopens after partial evidence and appends every event exactly once", async () => {
    const fixture = preparedRun();
    writeFileSync(path.join(fixture.sourceRoot, "a.txt"), "a");
    writeFileSync(path.join(fixture.sourceRoot, "b.txt"), "b");
    const first = new IntakeService(fixture.journal, fixture.runs, new BoundedTicketIntake(), await artifacts(fixture), {
      afterEvidenceAppended: (count) => {
        if (count === 1) throw new Error("crash after evidence");
      },
    });
    await expect(first.intake(request(fixture))).rejects.toThrow("crash after evidence");
    expect(fixture.runs.get(RUN_ID)?.lifecycle).toBe("intake");
    expect(fixture.journal.readStream(intakeStreamId(RUN_ID))).toHaveLength(1);

    const reopened = new IntakeService(fixture.journal, fixture.runs, new BoundedTicketIntake(), await artifacts(fixture));
    const result = await reopened.intake(request(fixture));
    expect(result.run.lifecycle).toBe("analyzing");
    expect(fixture.journal.readStream(intakeStreamId(RUN_ID)).map((event) => event.type)).toEqual([
      "source.discovered",
      "source.discovered",
      "intake.snapshot_closed",
    ]);
    fixture.journal.close();
  });

  it("reopens a durable closure without rescanning or duplicating completion", async () => {
    const fixture = preparedRun();
    writeFileSync(path.join(fixture.sourceRoot, "ticket.txt"), "ticket");
    const first = new IntakeService(fixture.journal, fixture.runs, new BoundedTicketIntake(), await artifacts(fixture), {
      afterSnapshotClosed: () => { throw new Error("crash after closure"); },
    });
    await expect(first.intake(request(fixture))).rejects.toThrow("crash after closure");
    const durableEvents = fixture.journal.readStream(intakeStreamId(RUN_ID));
    expect(durableEvents.at(-1)?.type).toBe("intake.snapshot_closed");
    expect(fixture.runs.get(RUN_ID)?.lifecycle).toBe("intake");

    const noRescan = new BoundedTicketIntake({
      testHooks: { beforeFileOpen: () => { throw new Error("must not rescan"); } },
    });
    const reopened = new IntakeService(fixture.journal, fixture.runs, noRescan, await artifacts(fixture));
    const firstReplay = await reopened.intake(request(fixture));
    await expect(reopened.intake({
      ...request(fixture),
      source: { kind: "ticket_directory", root: path.join(fixture.sourceRoot, "different") },
    })).rejects.toThrow(/source reference/i);
    const secondReplay = await reopened.intake(request(fixture));
    expect(firstReplay.snapshot?.sources[0]?.quotedText).toBe("ticket");
    expect(secondReplay.run).toEqual(firstReplay.run);
    expect(fixture.journal.readStream(intakeStreamId(RUN_ID))).toEqual(durableEvents);
    expect(fixture.runs.readStream(RUN_ID).filter((event) => event.type === "run.intake_completed")).toHaveLength(1);
    fixture.journal.close();
  });

  it("reconciles artifact publication uncertainty and rebuilds content without rereading changed tickets", async () => {
    const fixture = preparedRun();
    const ticket = path.join(fixture.sourceRoot, "ticket.txt");
    writeFileSync(ticket, "original ticket");
    let crash = true;
    const crashingStore = await IntakeArtifactStore.openProject(fixture.projectRoot, {
      afterPublishLink: () => {
        if (crash) {
          crash = false;
          throw new Error("artifact publication uncertain");
        }
      },
    });
    const first = new IntakeService(fixture.journal, fixture.runs, new BoundedTicketIntake(), crashingStore);
    await expect(first.intake(request(fixture))).rejects.toThrow("artifact publication uncertain");
    expect(fixture.journal.readStream(intakeStreamId(RUN_ID)).some((event) => event.type === "intake.snapshot_closed")).toBe(false);
    writeFileSync(ticket, "changed ticket");

    const noRescan = new BoundedTicketIntake({
      testHooks: { beforeFileOpen: () => { throw new Error("must not reread changed ticket"); } },
    });
    const reopened = new IntakeService(
      fixture.journal,
      fixture.runs,
      noRescan,
      await IntakeArtifactStore.openProject(fixture.projectRoot),
    );
    const result = await reopened.intake(request(fixture));
    expect(result.snapshot?.sources[0]?.quotedText).toBe("original ticket");
    expect(result.run.lifecycle).toBe("analyzing");
    fixture.journal.close();
  });

  it("rejects missing or tampered artifacts when reopening a durable closure", async () => {
    for (const mode of ["missing", "tampered"] as const) {
      const fixture = preparedRun();
      writeFileSync(path.join(fixture.sourceRoot, "ticket.txt"), "ticket");
      const service = new IntakeService(
        fixture.journal,
        fixture.runs,
        new BoundedTicketIntake(),
        await artifacts(fixture),
        { afterSnapshotClosed: () => { throw new Error("crash after closure"); } },
      );
      await expect(service.intake(request(fixture))).rejects.toThrow("crash after closure");
      const discovered = fixture.journal.readStream(intakeStreamId(RUN_ID))[0]!.payload as {
        readonly artifact: { readonly sha256: string };
      };
      const storedPath = path.join(
        fixture.projectRoot,
        ".zentra",
        "intake",
        "artifacts",
        `${discovered.artifact.sha256}.json`,
      );
      if (mode === "missing") rmSync(storedPath);
      else writeFileSync(storedPath, "tampered", { mode: 0o600 });

      const reopened = new IntakeService(
        fixture.journal,
        fixture.runs,
        new BoundedTicketIntake(),
        await artifacts(fixture),
      );
      await expect(reopened.intake(request(fixture))).rejects.toThrow(/artifact|missing|schema|digest/i);
      fixture.journal.close();
    }
  });

  it("separates BOM-bearing raw source evidence from normalized artifact evidence across reopen", async () => {
    const fixture = preparedRun();
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("goal", "utf8")]);
    writeFileSync(path.join(fixture.sourceRoot, "bom.txt"), raw);
    const service = new IntakeService(
      fixture.journal,
      fixture.runs,
      new BoundedTicketIntake(),
      await artifacts(fixture),
      { afterSnapshotClosed: () => { throw new Error("crash after BOM closure"); } },
    );
    await expect(service.intake(request(fixture))).rejects.toThrow("crash after BOM closure");
    const payload = fixture.journal.readStream(intakeStreamId(RUN_ID))[0]!.payload as {
      readonly digest: string;
      readonly sizeBytes: number;
      readonly artifact: { readonly sha256: string; readonly sizeBytes: number };
    };
    expect(payload).toMatchObject({
      digest: digest(raw),
      sizeBytes: 7,
      artifact: { sha256: digest(Buffer.from("goal")), sizeBytes: 4 },
    });

    const reopened = new IntakeService(
      fixture.journal,
      fixture.runs,
      new BoundedTicketIntake(),
      await artifacts(fixture),
    );
    const result = await reopened.intake(request(fixture));
    expect(result.snapshot.sources[0]).toMatchObject({
      quotedText: "goal",
      sha256: digest(raw),
      sizeBytes: 7,
      artifact: { sha256: digest(Buffer.from("goal")), sizeBytes: 4 },
    });
    fixture.journal.close();
  });

  it("deduplicates normalized duplicate artifacts and recovers after all evidence precedes publication", async () => {
    const fixture = preparedRun();
    writeFileSync(path.join(fixture.sourceRoot, "a.txt"), "same");
    writeFileSync(path.join(fixture.sourceRoot, "b.txt"), "same");
    const first = new IntakeService(
      fixture.journal,
      fixture.runs,
      new BoundedTicketIntake(),
      await artifacts(fixture),
      { afterEvidenceAppended: (count) => { if (count === 2) throw new Error("crash after duplicate evidence"); } },
    );
    await expect(first.intake(request(fixture))).rejects.toThrow("crash after duplicate evidence");
    expect(readdirSync(path.join(fixture.projectRoot, ".zentra", "intake", "tmp"))).toHaveLength(1);

    const noRescan = new BoundedTicketIntake({
      testHooks: { beforeFileOpen: () => { throw new Error("must not reread duplicates"); } },
    });
    const reopened = new IntakeService(
      fixture.journal,
      fixture.runs,
      noRescan,
      await artifacts(fixture),
    );
    const result = await reopened.intake(request(fixture));
    expect(result.snapshot.sources).toHaveLength(2);
    expect(result.snapshot.sources[0]!.artifact).toEqual(result.snapshot.sources[1]!.artifact);
    expect(readdirSync(path.join(fixture.projectRoot, ".zentra", "intake", "artifacts"))).toHaveLength(1);
    expect(readdirSync(path.join(fixture.projectRoot, ".zentra", "intake", "tmp"))).toEqual([]);
    fixture.journal.close();
  });

  it("refuses analysis when an artifact is deleted or tampered after intake completion", async () => {
    for (const mode of ["deleted", "tampered"] as const) {
      const fixture = preparedRun();
      writeFileSync(path.join(fixture.sourceRoot, "ticket.txt"), "ticket");
      const service = new IntakeService(
        fixture.journal,
        fixture.runs,
        new BoundedTicketIntake(),
        await artifacts(fixture),
      );
      const intake = await service.intake(request(fixture));
      const artifact = intake.snapshot.sources[0]!.artifact!;
      const storedPath = path.join(fixture.projectRoot, ".zentra", "intake", "artifacts", `${artifact.sha256}.json`);
      if (mode === "deleted") rmSync(storedPath);
      else writeFileSync(storedPath, "tampered", { mode: 0o600 });

      await expect(service.loadRetainedAnalysisSnapshot(RUN_ID))
        .rejects.toThrow(/artifact|missing|schema|digest/i);
      expect(fixture.runs.get(RUN_ID)?.lifecycle).toBe("analyzing");
      fixture.journal.close();
    }
  });

  it("rechecks artifacts when RunService consumes the capability and rejects stale verification", async () => {
    const fixture = preparedRun();
    writeFileSync(path.join(fixture.sourceRoot, "ticket.txt"), "ticket");
    let artifactPath = "";
    const service = new IntakeService(
      fixture.journal,
      fixture.runs,
      new BoundedTicketIntake(),
      await artifacts(fixture),
    );
    const intake = await service.intake(request(fixture));
    artifactPath = path.join(
      fixture.projectRoot,
      ".zentra",
      "intake",
      "artifacts",
      `${intake.snapshot.sources[0]!.artifact!.sha256}.json`,
    );

    await service.loadRetainedAnalysisSnapshot(RUN_ID);
    writeFileSync(artifactPath, "tampered after capability", { mode: 0o600 });
    await expect(service.loadRetainedAnalysisSnapshot(RUN_ID))
      .rejects.toThrow(/artifact|schema|digest/i);
    expect(fixture.runs.get(RUN_ID)?.lifecycle).toBe("analyzing");
    fixture.journal.close();
  });

  it("excludes the exact repository .zentra tree, including prior and interrupted artifacts", async () => {
    const fixture = preparedRun({ sourceAtProjectRoot: true });
    writeFileSync(path.join(fixture.sourceRoot, "ticket.txt"), "visible ticket");
    const store = await artifacts(fixture);
    await store.publish(await store.stage("private published content"));
    await store.stage("private interrupted content");
    const first = new IntakeService(
      fixture.journal,
      fixture.runs,
      new BoundedTicketIntake(),
      store,
      { afterSnapshotClosed: () => { throw new Error("crash after reserved-state closure"); } },
    );
    await expect(first.intake(request(fixture))).rejects.toThrow("crash after reserved-state closure");
    const closure = fixture.journal.readStream(intakeStreamId(RUN_ID)).at(-1)!.payload as { readonly snapshotSha256: string };

    const reopened = new IntakeService(
      fixture.journal,
      fixture.runs,
      new BoundedTicketIntake({
        testHooks: { beforeFileOpen: (relativePath) => {
          if (relativePath.startsWith(".zentra")) throw new Error("reserved state was traversed");
        } },
      }),
      await artifacts(fixture),
    );
    const result = await reopened.intake(request(fixture));
    expect(result.snapshot.snapshotSha256).toBe(closure.snapshotSha256);
    expect(result.snapshot.sources.map((source) => source.relativePath)).toEqual(["ticket.txt"]);
    expect(result.snapshot.rejected).toEqual([
      expect.objectContaining({ relativePath: ".zentra", reason: "reserved_runtime_state" }),
    ]);
    const journalText = JSON.stringify(fixture.journal.readStream(intakeStreamId(RUN_ID)));
    expect(journalText).not.toContain("private published content");
    expect(journalText).not.toContain("private interrupted content");
    fixture.journal.close();
  });
});

const RUN_ID = "run-90-service";
const REVISION = { objectFormat: "sha1" as const, commit: "a".repeat(40) };

function preparedRun(options: { readonly sourceAtProjectRoot?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "zentra-intake-service-"));
  cleanup.push(root);
  const sourceRoot = options.sourceAtProjectRoot ? root : path.join(root, "sources");
  if (!options.sourceAtProjectRoot) mkdirSync(sourceRoot);
  if (options.sourceAtProjectRoot) mkdirSync(path.join(root, ".zentra"), { mode: 0o700 });
  const journal = new SqliteEventJournal(options.sourceAtProjectRoot
    ? path.join(root, ".zentra", "events.sqlite")
    : path.join(root, "journal.sqlite"));
  const runs = new RunService(journal);
  const process = { pid: 90, processIncarnation: `process-v2:${"b".repeat(64)}` };
  const lifecycle = new ServiceLifecycleService(journal);
  const starting = lifecycle.start({
    serviceId: "intake-service",
    process,
    address: { host: "127.0.0.1", port: 43_290 },
    tokenExpiresAt: "2026-07-19T20:00:00.000Z",
    observation: "performed",
    commandId: "service-start-intake",
  });
  const agentTrail = seedAgentTrailReady(journal, {
    serviceId: "intake-service", serviceStartingEventId: starting.eventId, seed: "5",
  });
  const ready = lifecycle.ready({
    serviceId: "intake-service",
    process,
    address: { host: "127.0.0.1", port: 43_290 },
    runtimeSchemaVersion: 1,
    journalSchemaVersion: 2,
    observation: "performed",
    commandId: "service-ready-intake",
    tokenExpiresAt: "2026-07-19T20:00:00.000Z",
    ...agentTrail,
    causationId: agentTrail.agentTrailReadyEventId,
  });
  const reference = Buffer.from(path.resolve(sourceRoot), "utf8");
  let run = runs.accept({
    runId: RUN_ID,
    projectId: "zentra",
    projectRevision: REVISION,
    source: { kind: "ticket_directory", referenceSha256: digest(reference), declaredBytes: reference.length },
    actor: { actorId: "operator-1", kind: "operator" },
    process,
    budget: {
      maxDurationMs: 60_000,
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxCostUsdNano: 0,
      maxRetries: 0,
      maxSourceFiles: 20,
      maxSourceBytes: 4096,
    },
    commandId: "accept-intake-run",
    causationId: ready.eventId,
  });
  run = runs.startPreflight(RUN_ID, {
    expectedVersion: run.streamVersion,
    commandId: "preflight-start-intake",
    causationId: runs.readStream(RUN_ID).at(-1)!.eventId,
    process,
  });
  run = runs.completePreflight(RUN_ID, {
    expectedVersion: run.streamVersion,
    commandId: "preflight-complete-intake",
    causationId: runs.readStream(RUN_ID).at(-1)!.eventId,
    process,
  });
  return {
    projectRoot: root,
    journal,
    runs,
    sourceRoot,
    runVersion: run.streamVersion,
    preflightEventId: runs.readStream(RUN_ID).at(-1)!.eventId,
  };
}

function artifacts(fixture: ReturnType<typeof preparedRun>): Promise<IntakeArtifactStore> {
  return IntakeArtifactStore.openProject(fixture.projectRoot);
}

function request(fixture: ReturnType<typeof preparedRun>) {
  return {
    runId: RUN_ID,
    projectRevision: REVISION,
    source: { kind: "ticket_directory" as const, root: fixture.sourceRoot },
    limits: {
      maxFileBytes: 1024,
      maxFiles: 20,
      maxTotalBytes: 4096,
      maxDepth: 4,
      maxEntries: 40,
      maxDirectoryEntries: 20,
    },
    commandId: "intake-command-90",
  };
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
