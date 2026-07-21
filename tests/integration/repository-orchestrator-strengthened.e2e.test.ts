import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runInstalledThreePodConformance } from "../../src/conformance/three-pod-installed.js";
import { projectRepositoryOrchestration, repositoryOrchestrationStreamId } from "../../src/integration/repository-orchestrator.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("strengthened repository orchestration", () => {
  it("replays coupled batching, stale rebase, correction, conflict replacement, and cancellation-vs-CAS", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-repository-strengthened-"))); roots.push(root);
    const result = await runInstalledThreePodConformance(root);
    const journal = new SqliteEventJournal(result.databasePath);
    const stream = journal.readStream(repositoryOrchestrationStreamId(result.project.projectId));
    const state = projectRepositoryOrchestration(stream);
    const admissions = stream.filter((event) => event.type === "repository.submission_admitted")
      .map((event) => (event.payload as any).receipt);
    expect(admissions.filter((receipt) => receipt.contract.candidateOutcome === "non_green")).toHaveLength(2);
    expect(stream.some((event) => event.type === "integration.unit_formed" &&
      (event.payload as any).tightlyCoupled === true)).toBe(true);
    expect(stream.map((event) => event.type)).toEqual(expect.arrayContaining([
      "rebase.started", "rebase.completed", "final_acceptance.rejected", "correction.planned",
      "correction.approved", "conflict.observed", "replan.proposed", "replan.approved",
      "repository.cancellation_requested",
    ]));
    expect(Object.values(state.units).filter((unit) => unit.status === "accepted")).toHaveLength(6);
    expect(Object.values(state.units).some((unit) => unit.correctionCount === 1)).toBe(true);
    const terminal = stream.map((event) => event.type).filter((type) =>
      type === "integration.committed" || type === "repository.cancellation_requested");
    expect(terminal.at(-1)).toBe("repository.cancellation_requested");
    expect(terminal.at(-2)).toBe("integration.committed");
    expect(state.cancelled).toBe(true);
    journal.close();
  }, 180_000);
});
