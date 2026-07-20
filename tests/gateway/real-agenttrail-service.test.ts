import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentTrailEvidence } from "../../src/agenttrail/agenttrail-events.js";
import { openAuthoritativeJournal } from "../../src/journal/retention.js";
import { startZentraService, type RunningZentraService } from "../../src/service/start-service.js";

const temporaryDirectories: string[] = [];
const runningServices: RunningZentraService[] = [];

afterEach(async () => {
  await Promise.allSettled(runningServices.splice(0).map((service) => service.shutdown("test_requested")));
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("real AgentTrail service composition", () => {
  it("durably degrades, restarts, backfills, recovers, and cleans every resource", async () => {
    const root = repository();
    const evidence: AgentTrailEvidence[] = [];
    const service = await startZentraService({ cwd: root, agentTrailStartupTimeoutMs: 60_000 }, {
      observeAgentTrailEvidence: (event) => { evidence.push(event); },
    });
    runningServices.push(service);
    const initial = evidence.find((event): event is Extract<AgentTrailEvidence, { type: "agenttrail.ready" }> =>
      event.type === "agenttrail.ready")!;

    process.kill(initial.pid, "SIGKILL");
    await waitFor(() => evidence.some((event) => event.type === "agenttrail.failed" && event.incarnation === initial.incarnation));
    expect((await fetch(`${service.origin}/healthz`)).status).toBe(200);
    await waitFor(() => evidence.some((event) => event.type === "agenttrail.ready" && event.incarnation !== initial.incarnation), 120_000);
    expect((await fetch(`${service.origin}/readyz`)).status).toBe(200);

    const journal = openAuthoritativeJournal(service.layout.databasePath, "read-only");
    const types = journal.readAll().map(({ type }) => type);
    journal.close();
    const chain = [
      "agenttrail.failed",
      "gateway.degraded",
      "service.critical_attention",
      "agenttrail.starting",
      "gateway.backfill_target",
      "agenttrail.restarted",
      "agenttrail.ready",
      "gateway.recovered",
    ];
    expect(chain.every((type) => types.includes(type))).toBe(true);
    expect(chain.map((type) => types.lastIndexOf(type))).toEqual([...chain.map((type) => types.lastIndexOf(type))].sort((a, b) => a - b));

    const replacement = evidence.find((event): event is Extract<AgentTrailEvidence, { type: "agenttrail.ready" }> =>
      event.type === "agenttrail.ready" && event.incarnation !== initial.incarnation)!;
    const port = new URL(service.origin).port;
    await service.shutdown("test_requested");
    await service.closed;
    runningServices.splice(runningServices.indexOf(service), 1);

    expect(existsSync(service.layout.runtimeStatePath)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    expect(() => process.kill(-replacement.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }, 180_000);
});

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "zentra-real-service-"));
  temporaryDirectories.push(root);
  execFileSync("/usr/bin/git", ["init", root], { env: { HOME: root }, stdio: "ignore" });
  return realpathSync(root);
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for real AgentTrail service lifecycle");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
