import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import {
  PathClaimConflictError,
  PathClaimService,
  canonicalDarwinClaimPath,
} from "../../src/workspaces/path-claims.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PathClaimService", () => {
  it("durably serializes hierarchical Darwin-equivalent claims and permits disjoint claims", () => {
    const fixture = journalFixture();
    const first = new PathClaimService(fixture.journal).acquire({
      projectId: "project-1", claimId: "claim-1", ownerId: "writer-1",
      revision: "a".repeat(40), paths: ["src/components/**"], leaseMs: 60_000,
      correlationId: "run-1",
    });

    expect(() => new PathClaimService(fixture.journal).acquire({
      projectId: "project-1", claimId: "claim-2", ownerId: "writer-2",
      revision: "a".repeat(40), paths: ["SRC/components/button.ts"], leaseMs: 60_000,
      correlationId: "run-2",
    })).toThrow(PathClaimConflictError);
    expect(new PathClaimService(fixture.journal).acquire({
      projectId: "project-1", claimId: "claim-3", ownerId: "writer-3",
      revision: "a".repeat(40), paths: ["docs/guide.md"], leaseMs: 60_000,
      correlationId: "run-3",
    }).status).toBe("active");

    fixture.journal.close();
    const reopened = new SqliteEventJournal(fixture.database);
    expect(new PathClaimService(reopened).inspect("project-1").active.map((claim) => claim.claimId))
      .toEqual([first.claimId, "claim-3"]);
    reopened.close();
  });

  it("binds renewal and release to owner, revision, and lease token", () => {
    const fixture = journalFixture();
    const service = new PathClaimService(fixture.journal);
    const claim = service.acquire({
      projectId: "project-1", claimId: "claim-1", ownerId: "writer-1",
      revision: "b".repeat(40), paths: ["src/a.ts", "src/b.ts"], leaseMs: 60_000,
      correlationId: "run-1",
    });
    expect(() => service.renew({ ...claim, ownerId: "writer-2", leaseMs: 60_000, correlationId: "run-1" }))
      .toThrow(/owner/i);
    const renewed = service.renew({
      projectId: claim.projectId, claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, leaseToken: claim.leaseToken, leaseMs: 120_000,
      correlationId: "run-1",
    });
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(claim.expiresAt));
    service.release({
      projectId: claim.projectId, claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, leaseToken: renewed.leaseToken, correlationId: "run-1",
    });
    expect(service.inspect("project-1").active).toEqual([]);
    expect(() => service.acquire({
      projectId: claim.projectId, claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, paths: claim.paths, leaseMs: 60_000, correlationId: "run-1",
    })).toThrow(/immutable/i);
    fixture.journal.close();
  });

  it.each([
    "../secret", "/tmp/secret", "src\\secret", "src//secret", "src/./secret",
    ".git/config", ".env", "src/*/secret", "src/cafe\u0301.ts",
  ])("rejects unsafe, protected, wildcard, or non-NFC claim %s", (candidate) => {
    expect(() => canonicalDarwinClaimPath(candidate)).toThrow();
  });

  it.each([
    ["src/long-s.ts", "src/long-ſ.ts"],
    ["src/strasse.ts", "src/straße.ts"],
  ])("treats APFS case-fold aliases %s and %s as one identity", (firstPath, alias) => {
    const fixture = journalFixture();
    const service = new PathClaimService(fixture.journal);
    service.acquire({ projectId: "project-1", claimId: "first", ownerId: "writer-1",
      revision: "a".repeat(40), paths: [firstPath], leaseMs: 60_000, correlationId: "run-1" });
    expect(() => service.acquire({ projectId: "project-1", claimId: "alias", ownerId: "writer-2",
      revision: "a".repeat(40), paths: [alias], leaseMs: 60_000, correlationId: "run-2" }))
      .toThrow(PathClaimConflictError);
    fixture.journal.close();
  });

  it("fails closed on a compatibility-normalized Kelvin-sign alias", () => {
    expect(() => canonicalDarwinClaimPath("src/Kelvin.ts")).toThrow(/normalization/i);
  });

  it("retains requested, denied, checkpoint, uncertainty, correction, and release evidence", () => {
    const fixture = journalFixture();
    const service = new PathClaimService(fixture.journal);
    const claim = service.acquire({
      projectId: "project-1", claimId: "claim-1", ownerId: "writer-1",
      revision: "c".repeat(40), paths: ["src/a.ts"], leaseMs: 60_000,
      correlationId: "run-1",
    });
    service.proposeCorrection({
      projectId: "project-1", claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, leaseToken: claim.leaseToken,
      correctionId: "correction-1", paths: ["src/a.ts"], reason: "review rejection",
      correlationId: "run-1",
    });
    service.recordUncertain({
      projectId: "project-1", claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, leaseToken: claim.leaseToken,
      reason: "writer acknowledgement missing", correlationId: "run-1",
    });
    expect(fixture.journal.readStream("path-claims:project-1").map((event) => event.type))
      .toEqual(expect.arrayContaining([
        "path_claim.requested", "path_claim.acquired",
        "writer.effect_uncertain", "writer.correction_proposed",
      ]));
    fixture.journal.close();
  });

  it("requires reconciliation after dispatch uncertainty before another dispatch", async () => {
    const fixture = journalFixture();
    const service = new PathClaimService(fixture.journal);
    const claim = service.acquire({ projectId: "project-1", claimId: "claim-1", ownerId: "writer-1",
      revision: "c".repeat(40), paths: ["src/a.ts"], leaseMs: 60_000, correlationId: "run-1" });
    service.beginDispatch({ projectId: claim.projectId, claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, leaseToken: claim.leaseToken, dispatchId: "dispatch-1",
      binding: dispatchBinding(claim, "dispatch-1"), correlationId: "run-1" });
    expect(() => service.checkpoint({ projectId: claim.projectId, claimId: claim.claimId,
      ownerId: claim.ownerId, revision: claim.revision, leaseToken: claim.leaseToken,
      checkpointId: "fabricated", diffSha256: "d".repeat(64), toolEvidenceSha256: "e".repeat(64),
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 }, correlationId: "run-1" }))
      .toThrow(/exact retained/i);
    service.recordUncertain({ projectId: claim.projectId, claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, leaseToken: claim.leaseToken, reason: "lost acknowledgement", correlationId: "run-1" });
    expect(() => service.beginDispatch({ projectId: claim.projectId, claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, leaseToken: claim.leaseToken, dispatchId: "dispatch-2",
      binding: dispatchBinding(claim, "dispatch-2"), correlationId: "run-1" }))
      .toThrow(/reconcil/i);
    fixture.journal.close();
  });
});

function journalFixture(): { journal: SqliteEventJournal; database: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-path-claims-"));
  directories.push(directory);
  const database = path.join(directory, "journal.sqlite");
  return { journal: new SqliteEventJournal(database), database };
}

function dispatchBinding(claim: { projectId: string; claimId: string; ownerId: string; revision: string; leaseToken: string }, dispatchId: string) {
  const body = { schemaVersion: 1 as const, processIncarnation: "11111111-1111-4111-8111-111111111111",
    executableSha256: "a".repeat(64), argvSha256: "b".repeat(64), packetSha256: "c".repeat(64),
    cwdSha256: "d".repeat(64), dispatchId, projectId: claim.projectId, claimId: claim.claimId,
    ownerId: claim.ownerId, revision: claim.revision, leaseToken: claim.leaseToken };
  return { ...body, digest: createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex") };
}
