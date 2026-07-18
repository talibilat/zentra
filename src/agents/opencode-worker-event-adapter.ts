import type { WorkerObservation } from "../workers/worker-lifecycle.js";

// OpenCode 1.18.3 documents JSON output but no stable nested-agent lifecycle.
// Production keeps the task tool denied and accepts only measured top-level evidence.
export class OpenCodeWorkerEventAdapter {
  processObservation(name: string, outcome: "completed" | "cancelled" | "denied" | "timed_out" | "failed" | "uncertain"): WorkerObservation {
    return { kind: "process", name, outcome };
  }

  resourceObservation(name: string, outcome: "completed" | "cancelled" | "denied" | "timed_out" | "failed" | "uncertain"): WorkerObservation {
    return { kind: "resource", name, outcome };
  }

  rejectDelegation(nativeType: string): never {
    throw new Error(`OpenCode delegation is disabled because ${nativeType} has no supported observable lifecycle`);
  }

  assertNoDelegation(events: readonly unknown[]): void {
    for (const event of events) {
      if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
      const record = event as Readonly<Record<string, unknown>>;
      const part = typeof record["part"] === "object" && record["part"] !== null && !Array.isArray(record["part"])
        ? record["part"] as Readonly<Record<string, unknown>>
        : null;
      const tool = typeof record["tool"] === "string" ? record["tool"] : typeof part?.["tool"] === "string" ? part["tool"] : null;
      if (tool === "task" || tool === "subagent") this.rejectDelegation(tool);
    }
  }
}
