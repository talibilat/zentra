import { describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { LeaseService } from "../../src/leases/lease-service.js";

describe("LeaseService", () => {
  it("bounds lease lifetime and coalesces heartbeats to one per 60-second window", () => {
    const journal = new SqliteEventJournal(":memory:");
    let now = Date.parse("2026-07-20T00:00:00.000Z");
    const leases = new LeaseService(journal, { now: () => now });
    const lease = leases.grant({
      leaseId: "lease-1", taskId: "task-1", workerId: "worker-1",
      schedulerId: "installed", processIncarnation: "daemon-1", durationMs: 60_000,
    });
    expect(lease.expiresAtMs - lease.grantedAtMs).toBe(60_000);
    expect(() => leases.grant({
      leaseId: "lease-2", taskId: "task-2", workerId: "worker-2",
      schedulerId: "installed", processIncarnation: "daemon-1", durationMs: 180_001,
    })).toThrow(/180 seconds/i);
    expect(leases.heartbeat("lease-1", "daemon-1", "worker-incarnation-1")).toBe(true);
    now += 59_999;
    expect(leases.heartbeat("lease-1", "daemon-1", "worker-incarnation-1")).toBe(false);
    now += 1;
    expect(leases.heartbeat("lease-1", "daemon-1", "worker-incarnation-1")).toBe(true);
    expect(journal.readStream("lease:lease-1").filter((event) => event.type === "lease.heartbeat")).toHaveLength(2);
    expect(journal.readStream("lease:lease-1").filter((event) => event.type === "lease.renewed")).toHaveLength(2);
    journal.close();
  });

  it("rejects stale scheduler and worker incarnations and expires without granting authority", () => {
    const journal = new SqliteEventJournal(":memory:");
    let now = 1_000;
    const leases = new LeaseService(journal, { now: () => now });
    leases.grant({
      leaseId: "lease-1", taskId: "task-1", workerId: "worker-1",
      schedulerId: "installed", processIncarnation: "daemon-1", durationMs: 60_000,
    });
    leases.heartbeat("lease-1", "daemon-1", "worker-incarnation-1");
    expect(() => leases.heartbeat("lease-1", "daemon-2", "worker-incarnation-1")).toThrow(/stale scheduler incarnation/i);
    now += 180_000;
    expect(() => leases.heartbeat("lease-1", "daemon-1", "worker-incarnation-2")).toThrow(/stale worker incarnation|expired/i);
    expect(leases.expire("lease-1").status).toBe("expired");
    expect(leases.inspect("lease-1").authority).toBe(false);
    journal.close();
  });
});
