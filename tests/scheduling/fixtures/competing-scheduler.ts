import { existsSync } from "node:fs";

import { SqliteEventJournal } from "../../../src/journal/sqlite-journal.js";
import { DispatchGrantService } from "../../../src/scheduling/dispatch-grant-service.js";
import { JournalScheduler, type SchedulerTaskInput } from "../../../src/scheduling/journal-scheduler.js";

const [database, barrier, encoded] = process.argv.slice(2);
if (!database || !barrier || !encoded) process.exit(64);
while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 5));
const command = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
  readonly schedulerId: string; readonly incarnation: string; readonly task: SchedulerTaskInput;
  readonly delayMs?: number;
};
if (command.delayMs) await new Promise((resolve) => setTimeout(resolve, command.delayMs));
const identity = { controlPlaneId: "zentra", repositoryIdentity: "/tmp/multiprocess-repository" };
const journal = new SqliteEventJournal(database);
try {
  const grants = new DispatchGrantService(journal, identity, "policy-plane");
  const scheduler = new JournalScheduler(journal, { schedulerId: command.schedulerId,
    processIncarnation: command.incarnation, pid: process.pid, platform: "darwin-arm64",
    processStartIdentity: `start-${command.incarnation}`,
    capabilities: ["write_worktree"], controlIdentity: identity, grants,
    limits: { resources: { reasoning: 1, writers: 1, heavyValidation: 1, review: 1, integration: 1 },
      budget: { seconds: 100, inputTokens: 100, outputTokens: 100, costUsdNano: 100 } } });
  scheduler.start(); scheduler.submit(command.task);
  const intents = scheduler.tick();
  process.stdout.write(JSON.stringify({ status: "accepted", intents: intents.length }));
} catch (error) {
  process.stdout.write(JSON.stringify({ status: "rejected", error: error instanceof Error ? error.message : "unknown" }));
} finally { journal.close(); }
