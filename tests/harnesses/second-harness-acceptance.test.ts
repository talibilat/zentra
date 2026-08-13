import { describe, expect, it } from "vitest";

import { FakeHarnessWriter } from "./fake-harness-writer.js";
import { HarnessWriterRegistry } from "../../src/harnesses/harness-writer-registry.js";
import { isSupervisedWriterReport } from "../../src/harnesses/writer-brand.js";
import type { WriterRequest } from "../../src/harnesses/harness-writer.js";

function writerRequest(): WriterRequest {
  return {
    taskId: "task-second-harness",
    executable: "/fake/harness",
    model: {
      id: "claude-implementer",
      harness: "claude_code",
      model: "anthropic/claude-sonnet-4",
      roles: ["implementer"],
      specialties: ["coding"],
      costTier: "low",
      contextTokens: 128_000,
      maxConcurrency: 1,
      toolPermissions: ["read_repository", "write_worktree"],
      network: "denied",
      fallbackOrder: [],
      qualityHistory: { successes: 1, attempts: 1 },
    },
    workspace: { taskId: "task-second-harness", branch: "ticket/task-second-harness", path: "/tmp/fake-worktree" },
    packet: {} as never,
    timeoutMs: 1_000,
  } as WriterRequest;
}

describe("a second harness writer", () => {
  it("is resolvable from the registry under its own harness id", () => {
    const writer = new FakeHarnessWriter();
    const registry = new HarnessWriterRegistry({ claude_code: writer });
    expect(registry.get("claude_code")).toBe(writer);
  });

  it("produces a report that the shared brand check accepts", async () => {
    const writer = new FakeHarnessWriter();
    const prepared = await writer.prepare(writerRequest());
    const report = await writer.execute(prepared);
    expect(isSupervisedWriterReport(report, prepared.binding)).toBe(true);
  });

  it("reports the neutral usage vocabulary rather than an OpenCode literal", async () => {
    const writer = new FakeHarnessWriter();
    const prepared = await writer.prepare(writerRequest());
    const report = await writer.execute(prepared);
    expect(report.usageEvidence).toBe("native");
    expect(report.protocolFailure).toBeNull();
  });
});
