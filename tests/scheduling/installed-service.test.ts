import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { createRepositorySchedulerLifecycle } from "../../src/service/scheduler-composition.js";

describe("installed scheduler service lifecycle", () => {
  it("recovers on installed restart, runs the loop, and releases its daemon fence on clean shutdown", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-installed-scheduler-"));
    const journal = new SqliteEventJournal(path.join(root, "journal.sqlite"));
    try {
      const first = await createRepositorySchedulerLifecycle({ journal, projectRoot: root,
        schedulerId: "installed", process: { pid: process.pid, processIncarnation: "service-incarnation-1" } });
      await first.start();
      expect(first.daemon.durable.inspect().activeIncarnations).toEqual(["service-incarnation-1"]);
      await first.shutdown();

      const second = await createRepositorySchedulerLifecycle({ journal, projectRoot: root,
        schedulerId: "installed", process: { pid: process.pid, processIncarnation: "service-incarnation-2" } });
      await second.start();
      expect(second.daemon.durable.inspect().activeIncarnations).toEqual(["service-incarnation-2"]);
      expect(journal.readAll().filter((event) => event.type === "scheduler.daemon_stale")).toHaveLength(1);
      await second.shutdown();
      expect(journal.readAll().filter((event) => event.type === "daemon_lease.released")).toHaveLength(2);
    } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
