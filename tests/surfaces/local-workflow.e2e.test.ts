import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import type { EventJournal } from "../../src/journal/journal.js";
import { resolveProjectRevision } from "../../src/runs/project-revision.js";
import { ServiceLifecycleService } from "../../src/runs/service-lifecycle.js";
import { createLocalWorkflowSurface } from "../../src/surfaces/local-workflow.js";
import { runCli } from "../../src/cli/main.js";
import { seedAgentTrailReady } from "../fixtures/service-ready.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("createLocalWorkflowSurface", () => {
  it("composes both bounded intake types and replays list, detail, and cancellation after restart", async () => {
    const root = repository();
    const ticketDirectory = path.join(root, "tickets");
    mkdirSync(ticketDirectory);
    const hostileTicket = "<script>globalThis.ticketAttack = true</script>\n<img src=x onerror=alert(1)>\n";
    writeFileSync(path.join(ticketDirectory, "issue.md"), hostileTicket);
    const database = path.join(root, ".workflow.sqlite");
    const revision = await resolveProjectRevision(root);
    const process = { pid: 123, processIncarnation: `process-v2:${"c".repeat(64)}` };
    const journal = new SqliteEventJournal(database);
    const serviceReadyEventId = seedServiceReady(journal, process);
    const surface = await createLocalWorkflowSurface({
      journal,
      process,
      serviceReadyEventId,
      projectRoot: root,
      projectRevision: revision,
    });

    const inline = await surface.submitRun(
      { kind: "inline_goal", commandId: "submit-inline", goal: "Fix one production workflow boundary." },
      { actorId: "operator-1", channel: "cli" },
    );
    const tickets = await surface.submitRun(
      { kind: "ticket_directory", commandId: "submit-tickets", directoryPath: "tickets" },
      { actorId: "operator-2", channel: "ui" },
    );

    expect(inline).toMatchObject({
      run: { lifecycle: "analyzing", source: { kind: "inline_goal" }, authority: { executionAuthority: "none" } },
      intake: { status: "closed", sourceCount: 1, sources: [{ relativePath: "$inline" }] },
      analysis: { status: "not_started" },
      planning: { status: "not_started", readiness: { executionAuthority: "none" } },
    });
    expect(tickets).toMatchObject({
      run: { lifecycle: "analyzing", source: { kind: "ticket_directory" }, authority: { executionAuthority: "none" } },
       intake: { status: "closed", sourceCount: 1, sources: [{ relativePath: "issue.md",
        trust: "untrusted_planning_data", mediaType: "text/plain; charset=utf-8" }] },
    });
    expect(inline.run.runId).not.toBe(tickets.run.runId);
    expect(surface.listRuns().map((run) => run.runId)).toEqual([tickets.run.runId, inline.run.runId]);
    expect(JSON.stringify(surface.listRuns())).not.toContain(hostileTicket);
    expect(surface.getRun(inline.run.runId)).toEqual(inline);
    expect(inline.commandEvidence).toEqual([expect.objectContaining({
      kind: "run_submission",
      runId: inline.run.runId,
      source: {
        kind: "inline_goal",
        referenceSha256: inline.run.source.referenceSha256,
      },
      actor: { actorId: "operator-1", kind: "operator", channel: "cli" },
      evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    expect(tickets.commandEvidence).toEqual([expect.objectContaining({
      kind: "run_submission",
      runId: tickets.run.runId,
      source: {
        kind: "ticket_directory",
        referenceSha256: tickets.run.source.referenceSha256,
      },
      actor: { actorId: "operator-2", kind: "operator", channel: "ui" },
      evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    for (const detail of [inline, tickets]) {
      const accepted = journal.readStream(`run:${detail.run.runId}`)[0];
      expect(detail.commandEvidence[0]).toMatchObject({
        acceptanceCommandId: (accepted?.payload as { readonly commandId: string }).commandId,
      });
    }

    const cancelled = surface.cancelRun({
      runId: tickets.run.runId,
      expectedVersion: tickets.run.streamVersion,
      commandId: "cancel-ticket-run",
      cancellationId: "ticket-run-cancellation",
    }, { actorId: "operator-2", channel: "ui" });
    expect(cancelled.run).toMatchObject({ lifecycle: "terminal", terminalOutcome: "cancelled" });
    const expectedRuns = surface.listRuns();
    journal.close();

    const reopenedJournal = new SqliteEventJournal(database);
    const reopened = await createLocalWorkflowSurface({
      journal: reopenedJournal,
      process,
      serviceReadyEventId,
      projectRoot: root,
      projectRevision: revision,
    });
    expect(reopened.listRuns()).toEqual(expectedRuns);
    expect(reopened.getRun(inline.run.runId)).toEqual(inline);
    expect(reopened.getRun(tickets.run.runId)).toEqual(cancelled);
    const ticketSource = reopened.getRun(tickets.run.runId)!.intake.sources[0]!;
    expect(reopened.getSourceText(tickets.run.runId, ticketSource.sourceId).text).toBe(hostileTicket);
    expect(reopened.getRun(inline.run.runId)?.commandEvidence[0]).toMatchObject({
      actor: { actorId: "operator-1", channel: "cli" },
    });
    expect(reopened.getRun(tickets.run.runId)?.commandEvidence[0]).toMatchObject({
      actor: { actorId: "operator-2", channel: "ui" },
    });
    reopenedJournal.close();
  });

  it("keeps CLI status bounded for valid multi-megabyte aggregate intake", async () => {
    const root = repository();
    const ticketDirectory = path.join(root, "large-tickets");
    mkdirSync(ticketDirectory);
    const chunk = "bounded source line\n".repeat(40_000);
    for (const name of ["one.md", "two.md", "three.md"]) writeFileSync(path.join(ticketDirectory, name), chunk);
    expect(Buffer.byteLength(chunk, "utf8")).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(chunk, "utf8") * 3).toBeGreaterThan(2 * 1024 * 1024);
    const journal = new SqliteEventJournal(path.join(root, ".workflow.sqlite"));
    const process = { pid: 123, processIncarnation: `process-v2:${"9".repeat(64)}` };
    const surface = await createLocalWorkflowSurface({
      journal,
      process,
      serviceReadyEventId: seedServiceReady(journal, process),
      projectRoot: root,
      projectRevision: await resolveProjectRevision(root),
    });
    const submitted = await surface.submitRun(
      { kind: "ticket_directory", commandId: "large-aggregate", directoryPath: "large-tickets" },
      { actorId: "operator", channel: "cli" },
    );
    let stdout = "";
    let stderr = "";
    const code = await runCli(["status", submitted.run.runId], {
      workflowSurface: surface,
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(Buffer.byteLength(stdout, "utf8")).toBeLessThan(16 * 1024);
    expect(stdout).not.toContain("bounded source line");
    expect(JSON.parse(stdout)).toMatchObject({ command: "status", run: { intake: { sourceCount: 3 } } });
    journal.close();
  });

  it("rejects absolute ticket directories outside the project and in-project symlink escapes", async () => {
    const root = repository();
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-outside-tickets-")));
    cleanup.push(outside);
    writeFileSync(path.join(outside, "issue.md"), "Outside authority.\n");
    symlinkSync(outside, path.join(root, "escaped-tickets"));
    const revision = await resolveProjectRevision(root);
    const process = { pid: 123, processIncarnation: `process-v2:${"d".repeat(64)}` };
    const journal = new SqliteEventJournal(path.join(root, ".workflow.sqlite"));
    const surface = await createLocalWorkflowSurface({
      journal,
      process,
      serviceReadyEventId: seedServiceReady(journal, process),
      projectRoot: root,
      projectRevision: revision,
    });

    await expect(surface.submitRun(
      { kind: "ticket_directory", commandId: "submit-outside", directoryPath: outside },
      { actorId: "operator-1", channel: "cli" },
    )).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(surface.submitRun(
      { kind: "ticket_directory", commandId: "submit-escape", directoryPath: "escaped-tickets" },
      { actorId: "operator-2", channel: "ui" },
    )).rejects.toMatchObject({ code: "invalid_transition" });
    expect(surface.listRuns()).toEqual([]);
    journal.close();
  });

  it("reserves one run before effects and reconciles crash and lost-response retries exactly", async () => {
    const root = repository();
    const revision = await resolveProjectRevision(root);
    const process = { pid: 123, processIncarnation: `process-v2:${"e".repeat(64)}` };
    const journal = new SqliteEventJournal(path.join(root, ".workflow.sqlite"));
    const serviceReadyEventId = seedServiceReady(journal, process);
    let crash = true;
    const crashing = await createLocalWorkflowSurface({
      journal, process, serviceReadyEventId, projectRoot: root, projectRevision: revision,
      afterSubmissionReserved: () => { if (crash) { crash = false; throw new Error("simulated crash"); } },
    });
    const submission = { kind: "inline_goal" as const, commandId: "stable-submission", goal: "Do this once." };
    const caller = { actorId: "operator-1", channel: "cli" as const };

    await expect(crashing.submitRun(submission, caller)).rejects.toMatchObject({ code: "internal" });
    expect(journal.readAll().filter((event) => event.type === "workflow.run_submission_reserved")).toHaveLength(1);
    expect(journal.readAll().filter((event) => event.type === "run.accepted")).toHaveLength(0);

    const resumed = await createLocalWorkflowSurface({
      journal, process, serviceReadyEventId, projectRoot: root, projectRevision: revision,
    });
    const acknowledged = await resumed.submitRun(submission, caller);
    const lostResponseRetry = await resumed.submitRun(submission, caller);
    expect(lostResponseRetry.run.runId).toBe(acknowledged.run.runId);
    expect(journal.readAll().filter((event) => event.type === "run.accepted")).toHaveLength(1);
    expect(journal.readAll().filter((event) => event.type === "intake.snapshot_closed")).toHaveLength(1);

    await expect(resumed.submitRun({ ...submission, goal: "Changed input." }, caller))
      .rejects.toMatchObject({ code: "consumed" });
    await expect(resumed.submitRun(submission, { ...caller, actorId: "operator-2" }))
      .rejects.toMatchObject({ code: "consumed" });
    expect(journal.readAll().filter((event) => event.type === "run.accepted")).toHaveLength(1);
    journal.close();
  });

  it("resumes accepted preflight and closed intake after append-then-crash without duplicate effects", async () => {
    const root = repository();
    const revision = await resolveProjectRevision(root);
    const process = { pid: 123, processIncarnation: `process-v2:${"f".repeat(64)}` };
    const journal = new SqliteEventJournal(path.join(root, ".workflow.sqlite"));
    const serviceReadyEventId = seedServiceReady(journal, process);
    const crashTypes = new Set(["run.accepted", "intake.snapshot_closed"]);
    const crashingJournal: EventJournal = {
      append: (streamId, expectedVersion, events) => {
        const stored = journal.append(streamId, expectedVersion, events);
        const crashType = events.find((event) => crashTypes.has(event.type))?.type;
        if (crashType !== undefined) {
          crashTypes.delete(crashType);
          throw new Error(`simulated crash after ${crashType}`);
        }
        return stored;
      },
      readStream: (streamId, afterVersion) => journal.readStream(streamId, afterVersion),
      readAll: (afterPosition) => journal.readAll(afterPosition),
    };
    const surface = await createLocalWorkflowSurface({
      journal: crashingJournal, process, serviceReadyEventId, projectRoot: root, projectRevision: revision,
    });
    const submission = { kind: "inline_goal" as const, commandId: "resume-safe-stages", goal: "Resume safely." };
    const caller = { actorId: "operator-1", channel: "cli" as const };

    await expect(surface.submitRun(submission, caller)).rejects.toMatchObject({ code: "internal" });
    await expect(surface.submitRun(submission, caller)).rejects.toMatchObject({ code: "internal" });
    const completed = await surface.submitRun(submission, caller);

    expect(completed.run.lifecycle).toBe("analyzing");
    expect(journal.readAll().filter((event) => event.type === "run.accepted")).toHaveLength(1);
    expect(journal.readAll().filter((event) => event.type === "preflight.started")).toHaveLength(1);
    expect(journal.readAll().filter((event) => event.type === "intake.snapshot_closed")).toHaveLength(1);
    journal.close();
  });
});

function repository(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-local-workflow-")));
  cleanup.push(root);
  execFileSync("/usr/bin/git", ["init", root], { env: { HOME: root }, stdio: "ignore" });
  execFileSync("/usr/bin/git", ["config", "user.name", "Zentra Test"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["config", "user.email", "zentra@example.invalid"], { cwd: root, env: { HOME: root } });
  writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("/usr/bin/git", ["add", "README.md"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["commit", "-m", "fixture"], { cwd: root, env: { HOME: root }, stdio: "ignore" });
  return root;
}

function seedServiceReady(
  journal: SqliteEventJournal,
  process: { readonly pid: number; readonly processIncarnation: string },
): string {
  const lifecycle = new ServiceLifecycleService(journal);
  const starting = lifecycle.start({
    serviceId: "zentra-local-test",
    process,
    address: { host: "127.0.0.1", port: 43_219 },
    tokenExpiresAt: "2026-07-20T13:00:00.000Z",
    observation: "performed",
    commandId: "service-start",
  });
  const agentTrail = seedAgentTrailReady(journal, {
    serviceId: "zentra-local-test",
    serviceStartingEventId: starting.eventId,
  });
  return lifecycle.ready({
    serviceId: "zentra-local-test",
    process,
    address: { host: "127.0.0.1", port: 43_219 },
    runtimeSchemaVersion: 1,
    journalSchemaVersion: 2,
    tokenExpiresAt: "2026-07-20T13:00:00.000Z",
    observation: "performed",
    commandId: "service-ready",
    causationId: agentTrail.agentTrailReadyEventId,
    ...agentTrail,
  }).eventId;
}
