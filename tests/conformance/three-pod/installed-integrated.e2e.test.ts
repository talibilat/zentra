import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInstalledThreePodConformance } from "../../../src/conformance/three-pod-installed.js";
import { SqliteEventJournal } from "../../../src/journal/sqlite-journal.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("installed integrated three-pod conformance", () => {
  it("runs pods, scheduler, writers, restart, repository admission, integration, acceptance, and metrics in one journal", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-integrated-three-pod-"))); roots.push(root);
    const result = await runInstalledThreePodConformance(root);
    expect(result.report.evidence, JSON.stringify(result.report.evidence)).toMatchObject({ complete: true });
    expect(result.report).toMatchObject({ pods: { durable: 3, completed: 2, cancelled: 1 },
      capacities: { configured: { writers: 4, heavyValidation: 2, review: 2, integration: 1 }, respected: true },
      throughput: { verifiedUnits: 6 }, conflicts: { observed: 1 }, waits: { neverDispatched: 1 } });
    expect(result.report.capacities.peak).toMatchObject({ writers: 4, heavyValidation: 2, review: 2, integration: 1 });
    expect(result.report.backpressure.observations).toBeGreaterThan(0);
    expect(result.report.waits.backpressuredSamples).toBeGreaterThanOrEqual(3);
    expect(result.report.waits.minimumBackpressuredMs).toBeGreaterThan(0);
    expect(result.report.throughput.elapsedMs).toBeGreaterThan(0);
    expect(result.report.throughput.elapsedMs).toBeLessThan(120_000);
    expect(result.report.throughput.unitsPerSecond).toBeGreaterThan(0);
    expect(result.report.throughput.unitsPerSecond).toBeLessThan(100);
    expect(result.writerMutationCount).toBe(10);
    expect(result.integrationCommit).not.toBe(result.mainCommit);
    expect(readFileSync(result.reportPath, "utf8")).toContain('"complete": true');
    const journal = new SqliteEventJournal(result.databasePath);
    const events = journal.readAll();
    expect(events.filter((event) => event.type === "writer.patch_apply_completed")).toHaveLength(10);
    expect(events.filter((event) => event.type === "pod.revised")).toHaveLength(6);
    expect(events.filter((event) => event.type === "scheduler.daemon_stale")).toHaveLength(1);
    for (const taskId of ["writer-conflict", "writer-replacement"]) {
      expect(events.some((event) => event.type === "scheduler.task_submitted" &&
        (event.payload as any).task.taskId === taskId)).toBe(true);
      expect(events.some((event) => event.type === "scheduler.worker_outcome" &&
        (event.payload as any).taskId === taskId)).toBe(true);
      expect(events.some((event) => event.type === "path_claim.acquired" &&
        (event.payload as any).claimId === `claim-${taskId}`)).toBe(true);
      expect(events.some((event) => event.type === "writer.receipt_observed" &&
        (event.payload as any).claimId === `claim-${taskId}`)).toBe(true);
      expect(events.some((event) => event.type === "writer.checkpointed" &&
        (event.payload as any).claimId === `claim-${taskId}`)).toBe(true);
      expect(events.some((event) => event.type === "pod.assignment_recorded" &&
        (event.payload as any).assignment.taskId === taskId &&
        (event.payload as any).assignment.charterRevision === 2)).toBe(true);
    }
    const schedulerDispatches = new Map(events.filter((event) => event.type === "scheduler.dispatch_intended")
      .map((event) => [(event.payload as any).taskId, (event.payload as any).dispatchId]));
    const claimsByTask = new Map(events.filter((event) => event.type === "writer.dispatch_started")
      .map((event) => [String((event.payload as any).claimId).replace(/^claim-/, ""), (event.payload as any).dispatchId]));
    for (const taskId of ["writer-a", "writer-b", "writer-c", "writer-d", "writer-conflict", "writer-replacement"]) {
      expect(claimsByTask.get(taskId)).toBe(schedulerDispatches.get(taskId));
    }
    const freshScheduled = events.filter((event) => event.type === "scheduler.task_submitted" &&
      ["writer-conflict", "writer-replacement"].includes((event.payload as any).task.taskId));
    expect(new Set(freshScheduled.map((event) => (event.payload as any).task.grantId)).size).toBe(2);
    const freshDispatches = events.filter((event) => event.type === "scheduler.dispatch_intended" &&
      ["writer-conflict", "writer-replacement"].includes((event.payload as any).taskId));
    expect(new Set(freshDispatches.map((event) => (event.payload as any).dispatchId)).size).toBe(2);
    journal.close();
  }, 120_000);
});
