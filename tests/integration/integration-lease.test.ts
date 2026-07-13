import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IntegrationLeaseStore,
  MAX_INTEGRATION_LEASE_MS,
  type IntegrationLeaseKey,
} from "../../src/integration/integration-lease.js";

describe("IntegrationLeaseStore", () => {
  let directory: string;
  let databasePath: string;
  const stores: IntegrationLeaseStore[] = [];
  const key: IntegrationLeaseKey = {
    commonDirectory: "/canonical/repository/.git",
    integrationRef: "refs/heads/zentra/integration",
  };

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "zentra-integration-lease-"));
    databasePath = path.join(directory, "leases.sqlite");
  });

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
    rmSync(directory, { recursive: true, force: true });
  });

  function store(): IntegrationLeaseStore {
    const result = new IntegrationLeaseStore(databasePath);
    stores.push(result);
    return result;
  }

  it("atomically grants one owner across store instances", () => {
    const first = store().acquire(key, 1_000, 10_000);
    const second = store().acquire(key, 1_000, 10_000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(first?.ownerToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first).toMatchObject({
      acquiredAt: 10_000,
      expiresAt: 11_000,
      pid: process.pid,
      hostname: expect.any(String),
    });
  });

  it("does not conflate repositories or exact refs", () => {
    const leases = [
      store().acquire(key, 1_000, 10_000),
      store().acquire({ ...key, commonDirectory: "/other/repository/.git" }, 1_000, 10_000),
      store().acquire({ ...key, integrationRef: "refs/heads/release" }, 1_000, 10_000),
    ];

    expect(leases.every((lease) => lease !== null)).toBe(true);
  });

  it("reclaims an expired lease after a crashed owner", () => {
    const crashedStore = store();
    const crashed = crashedStore.acquire(key, 100, 10_000)!;
    crashedStore.close();
    stores.splice(stores.indexOf(crashedStore), 1);

    expect(store().acquire(key, 100, 10_099)).toBeNull();
    const recovered = store().acquire(key, 100, 10_100);

    expect(recovered).not.toBeNull();
    expect(recovered?.ownerToken).not.toBe(crashed.ownerToken);
  });

  it("rejects renewal by a stale owner after expiry reclaim", () => {
    const firstStore = store();
    const stale = firstStore.acquire(key, 100, 10_000)!;
    const current = store().acquire(key, 100, 10_100)!;

    expect(firstStore.renew(stale, 100, 10_101)).toBeNull();
    expect(firstStore.read(key)?.ownerToken).toBe(current.ownerToken);
  });

  it("reports renewal loss when another owner reclaimed the lease", () => {
    const firstStore = store();
    const lost = firstStore.acquire(key, 50, 10_000)!;
    store().acquire(key, 50, 10_050);

    expect(firstStore.renew(lost, 50, 10_051)).toBeNull();
  });

  it("rejects release by a nonowner", () => {
    const ownerStore = store();
    const owner = ownerStore.acquire(key, 1_000, 10_000)!;

    expect(ownerStore.release({ ...owner, ownerToken: "not-the-owner" })).toBe(false);
    expect(ownerStore.read(key)?.ownerToken).toBe(owner.ownerToken);
    expect(ownerStore.release(owner)).toBe(true);
    expect(ownerStore.read(key)).toBeNull();
  });

  it("bounds acquisition and renewal expiry", () => {
    const leaseStore = store();

    expect(() => leaseStore.acquire(key, MAX_INTEGRATION_LEASE_MS + 1)).toThrow(
      "integration lease duration is out of bounds",
    );
    const lease = leaseStore.acquire(key, 100, 10_000)!;
    expect(() => leaseStore.renew(lease, MAX_INTEGRATION_LEASE_MS + 1)).toThrow(
      "integration lease duration is out of bounds",
    );
  });
});
