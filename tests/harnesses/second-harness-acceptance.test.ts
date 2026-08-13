import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeHarnessWriter } from "./fake-harness-writer.js";
import { HarnessWriterRegistry } from "../../src/harnesses/harness-writer-registry.js";
import { isSupervisedWriterReport } from "../../src/harnesses/writer-brand.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { appendSupervisedWriterReceipt, PathClaimService } from "../../src/workspaces/path-claims.js";
import type { WriterRequest } from "../../src/harnesses/harness-writer.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writerRequest(dispatchAuthority?: WriterRequest["dispatchAuthority"]): WriterRequest {
  const base: Omit<WriterRequest, "dispatchAuthority"> = {
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
  };
  const request: WriterRequest = dispatchAuthority === undefined ? base : { ...base, dispatchAuthority };
  return request;
}

function journalFixture(): { journal: SqliteEventJournal; database: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-second-harness-"));
  directories.push(directory);
  const database = path.join(directory, "journal.sqlite");
  return { journal: new SqliteEventJournal(database), database };
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
    const report = await writer.execute(prepared, new AbortController().signal);
    expect(isSupervisedWriterReport(report, prepared.binding)).toBe(true);
  });

  it("drives its report through the durable receipt path with real dispatch authority", async () => {
    const { receipt, journal } = await driveReceipt(new FakeHarnessWriter());

    expect(receipt.usageEvidence).toBe("native");
    expect(receipt.protocolFailure).toBeNull();

    journal.close();
  });

  it("remaps an OpenCode-flavored writer report onto the durable receipt vocabulary", async () => {
    const { receipt, journal } = await driveReceipt(
      new FakeHarnessWriter("native_tokens", "invalid_native_event_stream"),
    );

    expect(receipt.usageEvidence).toBe("native");
    expect(receipt.protocolFailure).toBe("invalid_output_stream");

    journal.close();
  });
});

async function driveReceipt(writer: FakeHarnessWriter) {
  const fixture = journalFixture();
  const service = new PathClaimService(fixture.journal);
  const claim = service.acquire({
    projectId: "project-1", claimId: "claim-1", ownerId: "writer-1",
    revision: "a".repeat(40), paths: ["src/a.ts"], leaseMs: 60_000,
    correlationId: "run-1",
  });

  const dispatchId = "dispatch-1";
  const prepared = await writer.prepare(writerRequest({
    dispatchId,
    projectId: claim.projectId,
    claimId: claim.claimId,
    ownerId: claim.ownerId,
    revision: claim.revision,
    leaseToken: claim.leaseToken,
  }));

  service.beginDispatch({
    projectId: claim.projectId, claimId: claim.claimId, ownerId: claim.ownerId,
    revision: claim.revision, leaseToken: claim.leaseToken,
    dispatchId, binding: prepared.binding, correlationId: "run-1",
  });

  const report = await writer.execute(prepared, new AbortController().signal);

  const receipt = appendSupervisedWriterReceipt(service, {
    projectId: claim.projectId, claimId: claim.claimId, ownerId: claim.ownerId,
    revision: claim.revision, correlationId: "run-1",
    leaseToken: claim.leaseToken, dispatchId,
  }, report, prepared.binding);

  return { receipt, journal: fixture.journal };
}
