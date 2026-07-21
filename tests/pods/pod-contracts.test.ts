import { describe, expect, it } from "vitest";

import {
  PodCharterSchema,
  PodParentGrantSchema,
  PodTaskTerminalProjectionSchema,
} from "../../src/pods/pod-contracts.js";
import { charter, grant } from "./pod-fixtures.js";

describe("pod contracts", () => {
  it("strictly validates a local charter with an acyclic task-reference DAG", () => {
    expect(PodCharterSchema.parse(charter())).toMatchObject({
      podId: "pod-1",
      tasks: [{ taskId: "research" }, { taskId: "implement" }],
      execution: { mode: "local_process", nativeSubagents: false, distributed: false },
    });
    expect(() => PodCharterSchema.parse({ ...charter(), extraAuthority: true })).toThrow();
    expect(() => PodCharterSchema.parse(charter({
      tasks: [
        { ...charter().tasks[0]!, dependencies: [{ milestoneId: "milestone-1", taskId: "implement" }] },
        { ...charter().tasks[1]!, dependencies: [{ milestoneId: "milestone-1", taskId: "research" }] },
      ],
    }))).toThrow(/cycle/);
  });

  it("rejects grants that imply distribution, native subagents, shared-ref mutation, or noncanonical sets", () => {
    expect(PodParentGrantSchema.parse(grant()).podId).toBe("pod-1");
    expect(() => PodParentGrantSchema.parse({ ...grant(), capabilities: ["write_worktree", "read_repository"] })).toThrow();
    expect(() => PodParentGrantSchema.parse({ ...grant(), capabilities: [...grant().capabilities, "mutate_integration_ref"] })).toThrow();
    expect(() => PodParentGrantSchema.parse({ ...grant(), distributed: true })).toThrow();
    expect(() => PodParentGrantSchema.parse({ ...grant(), nativeSubagents: true })).toThrow();
    expect(PodParentGrantSchema.parse({ ...grant(), sharedIntegrationRefs: ["release"] }).sharedIntegrationRefs)
      .toEqual(["refs/heads/release"]);
  });

  it("permits only canonical task terminal outcomes", () => {
    for (const outcome of ["completed", "cancelled", "denied", "timed_out", "failed"] as const) {
      expect(PodTaskTerminalProjectionSchema.parse({ taskId: "implement", outcome, evidenceIds: [] }).outcome).toBe(outcome);
    }
    expect(() => PodTaskTerminalProjectionSchema.parse({ taskId: "implement", outcome: "blocked", evidenceIds: [] })).toThrow();
  });
});
