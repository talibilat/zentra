import { describe, expect, it } from "vitest";

import {
  MultiFileWriterRequestSchema,
  WriterCheckpointSchema,
  assertCorrectionWithinWriterEnvelope,
} from "../../src/contracts/writer-request.js";

describe("multi-file writer contracts", () => {
  it("separates broad potential scope from a concrete claimed write set", () => {
    const request = MultiFileWriterRequestSchema.parse({
      schemaVersion: 1,
      taskId: "writer-1",
      projectId: "project-1",
      baseRevision: "a".repeat(40),
      readPaths: ["**"],
      potentialWritePaths: ["src/**"],
      claimedWritePaths: ["src/a.ts", "src/b.ts"],
      forbiddenPaths: [".git/**", ".env"],
      checkpoint: { maxDurationMs: 30_000, maxToolCalls: 100 },
    });
    expect(request.claimedWritePaths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("rejects a correction that expands the accepted envelope", () => {
    expect(() => assertCorrectionWithinWriterEnvelope(
      ["src/a.ts", "src/b.ts"], ["src/a.ts", "src/c.ts"],
    )).toThrow(/correction/i);
  });

  it("allows a concrete correction inside an approved recursive scope", () => {
    expect(() => assertCorrectionWithinWriterEnvelope(["src/**"], ["src/nested/a.ts"]))
      .not.toThrow();
  });

  it("validates bounded checkpoint evidence", () => {
    expect(WriterCheckpointSchema.parse({
      schemaVersion: 1, checkpointId: "cp-1", claimId: "claim-1",
      revision: "b".repeat(40), diffSha256: "c".repeat(64),
      toolEvidenceSha256: "d".repeat(64),
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      recordedAt: new Date().toISOString(),
    }).checkpointId).toBe("cp-1");
  });
});
