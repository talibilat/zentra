import { lstat, realpath } from "node:fs/promises";

import type { EventJournal } from "../journal/journal.js";
import { DaemonScheduler, InstalledProcessExecutor, type SchedulerExecutor } from "../scheduling/daemon-scheduler.js";
import { DispatchGrantService } from "../scheduling/dispatch-grant-service.js";
import { JournalScheduler, type JournalSchedulerOptions, type SchedulerReconciliationObservation } from "../scheduling/journal-scheduler.js";
import { classifyDarwinProcessIdentity, inspectDarwinProcessStartIdentity } from "../runtime/darwin-process-identity.js";

export interface InstalledSchedulerLifecycle {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  readonly daemon: DaemonScheduler;
}

export function createInstalledDaemonScheduler(
  journal: EventJournal,
  options: JournalSchedulerOptions,
  executor: SchedulerExecutor,
): DaemonScheduler {
  return new DaemonScheduler(new JournalScheduler(journal, options), executor);
}

export async function createRepositorySchedulerLifecycle(input: {
  readonly journal: EventJournal;
  readonly projectRoot: string;
  readonly schedulerId: string;
  readonly process: { readonly pid: number; readonly processIncarnation: string };
  readonly now?: () => number;
  readonly executor?: SchedulerExecutor;
}): Promise<InstalledSchedulerLifecycle> {
  const repositoryIdentity = await realpath(input.projectRoot);
  const now = input.now ?? Date.now;
  const controlIdentity = { controlPlaneId: "zentra-installed", repositoryIdentity };
  const grants = new DispatchGrantService(input.journal, controlIdentity, "zentra-policy-plane", now);
  const durable = new JournalScheduler(input.journal, {
    schedulerId: input.schedulerId,
    processIncarnation: input.process.processIncarnation,
    pid: input.process.pid,
    processStartIdentity: requireProcessIdentity(input.process.pid),
    platform: "darwin-arm64",
    capabilities: ["integrate", "review_diff", "run_validation", "write_worktree"],
    limits: {
      resources: { reasoning: 12, writers: 4, heavyValidation: 2, review: 4, integration: 1 },
      budget: { seconds: 86_400, inputTokens: 2_000_000, outputTokens: 2_000_000,
        costUsdNano: 1_000_000_000 },
    },
    controlIdentity,
    grants,
    now,
    daemonOwnerLiveness: osOwnerLiveness,
  });
  const daemon = new DaemonScheduler(durable, input.executor ?? new InstalledProcessExecutor({}));
  return {
    daemon,
    start: async () => {
      await durable.recover(async (candidate): Promise<SchedulerReconciliationObservation> => ({
        taskId: candidate.taskId,
        workerAlive: workerIdentityIsAlive(candidate.workerPid, candidate.workerProcessStartIdentity),
        workspace: await workspaceState(candidate.workspacePath),
        effect: candidate.effect === "potentially_effectful" ? "uncertain" : "none",
        reason: `startup reconciled worker ${candidate.workerIncarnation ?? "without-incarnation"}`,
      }));
      await daemon.startLoop();
    },
    shutdown: () => daemon.shutdown(),
  };
}

function osOwnerLiveness(owner: { readonly pid: number; readonly processStartIdentity: string }): "alive" | "dead" | "unknown" {
  const state = classifyDarwinProcessIdentity(owner.pid, owner.processStartIdentity);
  return state === "alive" ? "alive" : state === "dead" || state === "replaced" ? "dead" : "unknown";
}
function workerIdentityIsAlive(pid: number | null, expected: string | null): boolean {
  if (pid === null) return false;
  if (expected === null) return true;
  return classifyDarwinProcessIdentity(pid, expected) === "alive";
}
function requireProcessIdentity(pid: number): string {
  const identity = inspectDarwinProcessStartIdentity(pid);
  if (identity === null) throw new Error("scheduler process start identity is unavailable");
  return identity;
}
async function workspaceState(workspacePath: string): Promise<"valid" | "missing" | "dirty"> {
  try { return (await lstat(workspacePath)).isDirectory() ? "dirty" : "missing"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
