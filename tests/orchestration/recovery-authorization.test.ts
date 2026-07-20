import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IntegrationLeaseStore } from "../../src/integration/integration-lease.js";
import {
  RecoveryCompletionAuthorizer,
  RecoveryIntegrationLeaseAuthority,
  type RecoveryCompletionSnapshot,
} from "../../src/orchestration/recovery-completion-authorization.js";

const directories: string[] = [];
const stores: IntegrationLeaseStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-recovery-authorization-"));
  directories.push(directory);
  const store = new IntegrationLeaseStore(path.join(directory, "leases.sqlite"));
  stores.push(store);
  const key = { commonDirectory: directory, integrationRef: "refs/heads/zentra/integration" };
  const lease = store.acquire(key, 1_000, 100)!;
  const snapshot: RecoveryCompletionSnapshot = {
    taskId: "task-9",
    streamVersion: 10,
    lastEventType: "task.integration_observed",
    commonDirectory: directory,
    integrationRef: key.integrationRef,
    integrationCommit: "a".repeat(40),
    worktreePath: path.join(directory, "task-9"),
    worktreeRegistered: true,
    worktreePathExists: true,
    ticketRefExists: true,
    ticketCommit: "b".repeat(40),
    worktreeDirty: false,
    worktreeDiffSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
  return { store, lease, snapshot };
}

describe("RecoveryCompletionAuthorizer", () => {
  it("consumes one exact authorization only once", () => {
    const { store, lease, snapshot } = fixture();
    const authorizer = new RecoveryCompletionAuthorizer(store, () => 101, 100);
    const authorization = authorizer.issue("integration_observed", snapshot, lease);

    authorizer.consume(authorization, "integration_observed", snapshot);
    const independentCaller = new RecoveryCompletionAuthorizer(store, () => 101, 100);
    expect(() => independentCaller.consume(authorization, "integration_observed", snapshot)).toThrow(/already consumed/i);
  });

  it("binds authorization to the exact task stream and inspected identities", () => {
    const { store, lease, snapshot } = fixture();
    const authorizer = new RecoveryCompletionAuthorizer(store, () => 101, 100);
    const authorization = authorizer.issue("integration_observed", snapshot, lease);

    expect(() => authorizer.consume(authorization, "integration_observed", {
      ...snapshot,
      streamVersion: snapshot.streamVersion + 1,
    })).toThrow(/evidence changed/i);
  });

  it("contains thrown timer renewal failures and aborts with bounded diagnostics", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-recovery-renew-"));
    directories.push(directory);
    class ThrowingRenewStore extends IntegrationLeaseStore {
      override renew(): never {
        throw new Error(`injected renewal failure ${"x".repeat(2_000)}`);
      }
    }
    const store = new ThrowingRenewStore(path.join(directory, "leases.sqlite"));
    stores.push(store);
    const lease = store.acquire({
      commonDirectory: directory,
      integrationRef: "refs/heads/zentra/integration",
    }, 100)!;
    const authority = new RecoveryIntegrationLeaseAuthority(store, lease, 100, 10, Date.now);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(authority.signal.aborted).toBe(true);
    expect(authority.diagnostics().lossCause).toContain("injected renewal failure");
    expect(authority.diagnostics().lossCause!.length).toBeLessThanOrEqual(512);
    expect(() => authority.assertActive()).toThrow(/lease authority was lost/i);
    expect(() => authority.close()).not.toThrow();
  });

  it("keeps thrown release failure as bounded secondary evidence", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-recovery-release-"));
    directories.push(directory);
    class ThrowingReleaseStore extends IntegrationLeaseStore {
      override release(): never {
        throw new Error(`injected release failure ${"y".repeat(2_000)}`);
      }
    }
    const store = new ThrowingReleaseStore(path.join(directory, "leases.sqlite"));
    stores.push(store);
    const lease = store.acquire({
      commonDirectory: directory,
      integrationRef: "refs/heads/zentra/integration",
    }, 1_000)!;
    const authority = new RecoveryIntegrationLeaseAuthority(store, lease, 1_000, 100, Date.now);

    const diagnostics = authority.close();

    expect(diagnostics.releaseFailure).toContain("injected release failure");
    expect(diagnostics.releaseFailure!.length).toBeLessThanOrEqual(512);
    expect(() => authority.close()).not.toThrow();
  });
});
