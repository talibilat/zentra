import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  IntakeSnapshotClosedPayloadSchema,
  SourceDiscoveredPayloadSchema,
  SourceRejectedPayloadSchema,
} from "../../src/intake/intake-contracts.js";

describe("strict intake payload schemas", () => {
  it("rejects minimal, extra-field, unsafe-path, and contradictory payloads", () => {
    expect(() => SourceDiscoveredPayloadSchema.parse({ schemaVersion: 1, runId: "run", path: "ticket" })).toThrow();
    expect(() => SourceRejectedPayloadSchema.parse({ schemaVersion: 1, extra: true })).toThrow();
    expect(() => IntakeSnapshotClosedPayloadSchema.parse({ schemaVersion: 1, snapshotSha256: "a".repeat(64) })).toThrow();

    const base = {
      schemaVersion: 1,
      runId: "run",
      projectId: "project",
      commandId: "command",
      requestSha256: "a".repeat(64),
      eventIndex: 0,
      evidenceCount: 1,
      sourceKind: "ticket_directory",
      limits: {
        maxFileBytes: 10,
        maxFiles: 1,
        maxTotalBytes: 10,
        maxDepth: 1,
        maxEntries: 2,
        maxDirectoryEntries: 2,
      },
      snapshotTotalBytes: 1,
      path: "../escape",
      provenance: {
        runId: "run",
        projectId: "project",
        projectRevision: { objectFormat: "sha1", commit: "b".repeat(40) },
        sourceKind: "ticket_directory",
        rootIdentitySha256: "c".repeat(64),
        device: "1",
        inode: null,
        modifiedNanoseconds: "2",
        changedNanoseconds: "3",
      },
      reason: "binary",
      sizeBytes: 1,
      bytesRead: 0,
      digest: null,
    };
    expect(() => SourceRejectedPayloadSchema.parse(base)).toThrow();
  });

  it("accepts normalized artifact evidence distinct from raw BOM input and fully examined aggregate rejection", () => {
    const rawDigest = createHash("sha256").update(Buffer.from([0xef, 0xbb, 0xbf, 0x67])).digest("hex");
    const normalizedDigest = createHash("sha256").update("g").digest("hex");
    const common = {
      schemaVersion: 1,
      runId: "run",
      projectId: "project",
      commandId: "command",
      requestSha256: "a".repeat(64),
      eventIndex: 0,
      evidenceCount: 1,
      sourceKind: "inline_goal" as const,
      limits: {
        maxFileBytes: 100,
        maxFiles: 1,
        maxTotalBytes: 100,
        maxDepth: 0,
        maxEntries: 1,
        maxDirectoryEntries: 1,
      },
      snapshotTotalBytes: 4,
      path: "$inline",
      provenance: {
        runId: "run",
        projectId: "project",
        projectRevision: { objectFormat: "sha1" as const, commit: "b".repeat(40) },
        sourceKind: "inline_goal" as const,
        rootIdentitySha256: "c".repeat(64),
        device: null,
        inode: null,
        modifiedNanoseconds: null,
        changedNanoseconds: null,
      },
    };
    expect(SourceDiscoveredPayloadSchema.parse({
      ...common,
      sourceId: `source-v1:${createHash("sha256").update(`run\0$inline\0${rawDigest}`).digest("hex")}`,
      sizeBytes: 4,
      digest: rawDigest,
      trust: "untrusted_planning_data",
      mediaType: "text/plain; charset=utf-8",
      artifact: {
        artifactId: `intake-text-v1:${normalizedDigest}`,
        sha256: normalizedDigest,
        sizeBytes: 1,
      },
    })).toMatchObject({ digest: rawDigest, artifact: { sha256: normalizedDigest } });
    expect(SourceRejectedPayloadSchema.parse({
      ...common,
      reason: "aggregate_size_exceeded",
      sizeBytes: 4,
      bytesRead: 4,
      digest: rawDigest,
    })).toMatchObject({ reason: "aggregate_size_exceeded", bytesRead: 4, digest: rawDigest });
  });
});
