import { describe, expect, it } from "vitest";

import { MultipleMilestoneScheduler } from "../../src/orchestration/multiple-milestone-scheduler.js";
import { WriterResourceGovernor } from "../../src/orchestration/writer-resource-governor.js";

function item(governor: WriterResourceGovernor, milestoneId: string, traceId: string, writerTaskId: string, run: () => Promise<unknown>) {
  return {
    milestoneId,
    traceId,
    projectId: "project",
    coordinator: {
      run,
      inspectIdentity: () => ({ projectId: "project", traceId }),
      usesWriterGovernor: (candidate: WriterResourceGovernor) => candidate === governor,
    },
    request: {
      milestoneId,
      readOnlyTasks: [],
      writerSchedule: {
        milestoneId,
        maxConcurrentWriters: 1,
        tasks: [{ writerTaskId }],
      },
    },
  } as never;
}

describe("MultipleMilestoneScheduler", () => {
  it("starts milestones concurrently, isolates failures, and returns input-order results", async () => {
    const release = Promise.withResolvers<void>();
    let secondStarted = false;
    const governor = new WriterResourceGovernor(1);
    const scheduler = new MultipleMilestoneScheduler(governor);
    const resultPromise = scheduler.run([
      item(governor, "first", "trace-first", "writer-first", async () => { await release.promise; return "first-result"; }),
      item(governor, "second", "trace-second", "writer-second", async () => { secondStarted = true; throw new Error("second failed"); }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondStarted).toBe(true);
    release.resolve();

    const results = await resultPromise;
    expect(results[0]).toMatchObject({ milestoneId: "first", status: "fulfilled", value: "first-result" });
    expect(results[1]).toMatchObject({ milestoneId: "second", status: "rejected" });
  });

  it.each(["milestone", "trace", "writer"])("rejects duplicate Darwin-canonical %s identities", async (kind) => {
    const governor = new WriterResourceGovernor(1);
    const first = item(governor, kind === "milestone" ? "M" : "m-a", kind === "trace" ? "TRACE" : "trace-a", kind === "writer" ? "WRITER" : "writer-a", async () => null);
    const second = item(governor, kind === "milestone" ? "m" : "m-b", kind === "trace" ? "trace" : "trace-b", kind === "writer" ? "writer" : "writer-b", async () => null);
    const scheduler = new MultipleMilestoneScheduler(governor);
    await expect(scheduler.run([first, second])).rejects.toThrow("must be unique");
  });

  it("rejects project and nested milestone mismatches and limits above the governor", async () => {
    const scheduler = new MultipleMilestoneScheduler(new WriterResourceGovernor(1));
    const governor = new WriterResourceGovernor(1);
    const verifiedScheduler = new MultipleMilestoneScheduler(governor);
    const mismatched = item(governor, "m", "trace", "writer", async () => null) as any;
    mismatched.request.writerSchedule.milestoneId = "other";
    await expect(verifiedScheduler.run([mismatched])).rejects.toThrow("another milestone");

    const excessive = item(governor, "m", "trace", "writer", async () => null) as any;
    excessive.request.writerSchedule.maxConcurrentWriters = 2;
    await expect(verifiedScheduler.run([excessive])).rejects.toThrow("exceeds shared global writer capacity");
  });

  it("rejects conflicting repeated capability metadata before starting any milestone", async () => {
    let starts = 0;
    const governor = new WriterResourceGovernor(2);
    const first = item(governor, "m-a", "trace-a", "writer-a", async () => { starts += 1; return null; }) as any;
    const second = item(governor, "m-b", "trace-b", "writer-b", async () => { starts += 1; return null; }) as any;
    first.request.writerSchedule.modelSheet = { models: [{ id: "shared", maxConcurrency: 1 }] };
    second.request.writerSchedule.modelSheet = { models: [{ id: "SHARED", maxConcurrency: 2 }] };

    await expect(new MultipleMilestoneScheduler(governor).run([first, second]))
      .rejects.toThrow("conflicting repeated capability metadata");
    expect(starts).toBe(0);
  });

  it("rejects a top-level mapping that contradicts durable project or trace identity", async () => {
    const governor = new WriterResourceGovernor(1);
    const mapped = item(governor, "m", "trace", "writer", async () => null) as any;
    mapped.coordinator.inspectIdentity = () => ({ projectId: "other-project", traceId: "trace" });

    await expect(new MultipleMilestoneScheduler(governor).run([mapped]))
      .rejects.toThrow("contradicts durable project or trace identity");
  });

  it("rejects an unverifiable or differently governed coordinator before effects", async () => {
    const governor = new WriterResourceGovernor(1);
    let effects = 0;
    const wrong = item(new WriterResourceGovernor(1), "m", "trace", "writer", async () => { effects += 1; return null; });
    await expect(new MultipleMilestoneScheduler(governor).run([wrong]))
      .rejects.toThrow("does not use the shared writer governor");
    expect(effects).toBe(0);
  });
});
