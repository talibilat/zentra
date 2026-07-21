import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import type { SchedulerBudget, SchedulerTerminalOutcome } from "./scheduler-contracts.js";
import type { DispatchIntent } from "./scheduler-contracts.js";
import { JournalScheduler } from "./journal-scheduler.js";
import { inspectDarwinProcessStartIdentity } from "../runtime/darwin-process-identity.js";

const MINIMAL_ENVIRONMENT = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;

export interface DispatchExecution {
  readonly pid: number;
  readonly workerIncarnation: string;
  readonly processStartIdentity: string;
  readonly completion: Promise<{ readonly outcome: SchedulerTerminalOutcome; readonly usage: SchedulerBudget }>;
  readonly usage?: AsyncIterable<SchedulerBudget>;
  cancel(): void;
}
export interface SchedulerExecutor {
  start(intent: DispatchIntent, signal: AbortSignal): Promise<DispatchExecution>;
}

export interface InstalledDispatchCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export class InstalledProcessExecutor implements SchedulerExecutor {
  constructor(private readonly commands: Readonly<Record<string, InstalledDispatchCommand>>) {}

  start(intent: DispatchIntent, signal: AbortSignal): Promise<DispatchExecution> {
    if (signal.aborted) return Promise.reject(new DOMException("dispatch expired before spawn", "AbortError"));
    const command = this.commands[intent.taskId];
    if (command === undefined) return Promise.reject(new Error(`no installed command for task ${intent.taskId}`));
    if (!path.isAbsolute(command.executable) || realpathSync(command.executable) !== command.executable ||
      !path.isAbsolute(command.cwd) || command.cwd !== intent.workspace.path) {
      return Promise.reject(new Error("installed dispatch command must use exact absolute executable and workspace"));
    }
    const environment: Record<string, string> = {};
    for (const name of MINIMAL_ENVIRONMENT) {
      if (process.env[name] !== undefined) environment[name] = process.env[name]!;
    }
    for (const [name, value] of Object.entries(command.environment ?? {})) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || value.includes("\0")) {
        return Promise.reject(new Error("installed dispatch environment is invalid"));
      }
      environment[name] = value;
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command.executable, [...command.args], {
        cwd: command.cwd, env: environment, shell: false, detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      let spawned = false;
      child.once("error", (error) => {
        if (!spawned) reject(error);
      });
      child.once("spawn", () => {
        spawned = true;
        const startedAt = Date.now();
        let cancellationRequested = false;
        let forceTimer: NodeJS.Timeout | null = null;
        const completion = new Promise<{ outcome: SchedulerTerminalOutcome; usage: SchedulerBudget }>((complete) => {
          child.once("close", (code, signal) => {
            if (forceTimer !== null) clearTimeout(forceTimer);
            complete({ outcome: cancellationRequested || signal === "SIGTERM" || signal === "SIGKILL"
              ? "cancelled" : code === 0 ? "completed" : "failed",
            usage: { seconds: Math.floor((Date.now() - startedAt) / 1_000), inputTokens: 0,
              outputTokens: 0, costUsdNano: 0 } });
          });
        });
        resolve(Object.freeze({
          pid: child.pid!, workerIncarnation: `worker-${randomUUID()}`,
          processStartIdentity: inspectDarwinProcessStartIdentity(child.pid!) ?? "process-exited-before-identity",
          completion,
          cancel: (): void => {
            if (cancellationRequested) return;
            cancellationRequested = true;
            try { process.kill(-child.pid!, "SIGTERM"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            forceTimer = setTimeout(() => {
              try { process.kill(-child.pid!, "SIGKILL"); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            }, 250);
            forceTimer.unref();
          },
        }));
        if (signal.aborted) {
          try { process.kill(-child.pid!, "SIGTERM"); } catch { /* Close observation settles the process. */ }
        }
      });
    });
  }
}

export class DaemonScheduler {
  private readonly active = new Map<string, DispatchExecution>();
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly completions = new Set<Promise<void>>();
  private readonly heartbeatJitterMs: () => number;
  private loopTimer: NodeJS.Timeout | null = null;
  private daemonRenewalTimer: NodeJS.Timeout | null = null;
  private loopRunning = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    readonly durable: JournalScheduler,
    private readonly executor: SchedulerExecutor,
    options: { readonly heartbeatJitterMs?: () => number } = {},
  ) { this.heartbeatJitterMs = options.heartbeatJitterMs ?? (() => Math.floor(Math.random() * 5_001)); }

  async runOnce(): Promise<readonly DispatchIntent[]> {
    this.durable.renewDaemonLease();
    if (this.daemonRenewalTimer === null) {
      this.daemonRenewalTimer = setInterval(() => {
        try { this.durable.renewDaemonLease(); }
        catch { for (const execution of this.active.values()) execution.cancel(); }
      }, 10_000);
      this.daemonRenewalTimer.unref();
    }
    const before = this.durable.inspect();
    for (const task of Object.values(before.tasks)) {
      if (task.status !== "cancelling" || task.dispatch === null) continue;
      this.active.get(task.dispatch.dispatchId)?.cancel();
    }
    const intents = this.durable.tick();
    for (const intent of intents) {
      if (this.durable.currentTimeMs() >= intent.deadlineAtMs) {
        this.durable.complete(intent.dispatchId, "timed_out");
        continue;
      }
      let timedOut = false;
      const deadline = new AbortController();
      const deadlineTimer = setTimeout(() => { timedOut = true; deadline.abort(); },
        Math.max(0, intent.deadlineAtMs - this.durable.currentTimeMs()));
      deadlineTimer.unref();
      let execution: DispatchExecution;
      try {
        execution = await this.executor.start(intent, deadline.signal);
      } catch (error) {
        clearTimeout(deadlineTimer);
        if (timedOut) {
          this.durable.complete(intent.dispatchId, "timed_out");
          continue;
        }
        this.durable.reconcileUncertainDispatch(intent.dispatchId,
          `installed process startup was not observed: ${safeError(error)}`, "valid");
        continue;
      }
      this.active.set(intent.dispatchId, execution);
      let budgetExceeded = false;
      const usagePump = this.consumeUsage(intent, execution).catch(() => {
        budgetExceeded = true;
        execution.cancel();
      });
      deadline.signal.addEventListener("abort", () => execution.cancel(), { once: true });
      if (deadline.signal.aborted) execution.cancel();
      const completion = execution.completion.then(async (receipt) => {
        await usagePump;
        clearTimeout(deadlineTimer);
        this.closeExecution(intent.dispatchId);
        const current = this.durable.inspect().tasks[intent.taskId];
        if (current !== undefined && current.status !== "terminal" && current.status !== "reconciling") {
          const outcome = timedOut ? "timed_out" : budgetExceeded ? "failed" : receipt.outcome;
          const finalUsage = execution.usage === undefined ? receipt.usage
            : { seconds: 0, inputTokens: 0, outputTokens: 0, costUsdNano: 0 };
          try { this.durable.complete(intent.dispatchId, outcome, finalUsage); }
          catch {
            try { this.durable.reconcileUncertainDispatch(intent.dispatchId,
              "worker usage receipt exceeded or contradicted its durable budget", "dirty"); }
            catch { /* A lost daemon fence forbids further journal mutation. */ }
          }
        }
      }, (error) => {
        clearTimeout(deadlineTimer);
        this.closeExecution(intent.dispatchId);
        try { this.durable.reconcileUncertainDispatch(intent.dispatchId,
          `installed process result was not observed: ${safeError(error)}`, "dirty"); }
        catch { /* A lost daemon fence forbids further journal mutation. */ }
      }).finally(() => this.completions.delete(completion));
      this.completions.add(completion);
      try { this.durable.started(intent.dispatchId, execution.pid, execution.workerIncarnation,
        execution.processStartIdentity); }
      catch { execution.cancel(); continue; }
      const afterStart = this.durable.inspect().tasks[intent.taskId];
      if (afterStart?.status === "cancelling") {
        execution.cancel();
        this.durable.tick();
        continue;
      }
      this.durable.heartbeat(intent.dispatchId, execution.workerIncarnation);
      const scheduleHeartbeat = (): void => {
        const delay = 60_000 + boundedJitter(this.heartbeatJitterMs());
        const timer = setTimeout(() => {
          if (!this.active.has(intent.dispatchId)) return;
          try { this.durable.heartbeat(intent.dispatchId, execution.workerIncarnation); scheduleHeartbeat(); }
          catch { execution.cancel(); }
        }, delay);
        timer.unref();
        this.heartbeatTimers.set(intent.dispatchId, timer);
      };
      scheduleHeartbeat();
    }
    return intents;
  }

  async awaitIdle(): Promise<void> {
    await Promise.all([...this.completions]);
  }

  async startLoop(intervalMs = 1_000): Promise<void> {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 10_000) {
      throw new Error("scheduler loop interval must be between 1 and 10000 ms");
    }
    if (this.loopTimer !== null) return;
    const run = async (): Promise<void> => {
      if (this.loopRunning) return;
      this.loopRunning = true;
      try { this.durable.expire(); await this.runOnce(); }
      finally { this.loopRunning = false; }
    };
    await run();
    this.loopTimer = setInterval(() => { void run().catch(() => undefined); }, intervalMs);
    this.loopTimer.unref();
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      if (this.loopTimer !== null) clearInterval(this.loopTimer);
      this.loopTimer = null;
      if (this.daemonRenewalTimer !== null) clearInterval(this.daemonRenewalTimer);
      this.daemonRenewalTimer = null;
      for (const execution of this.active.values()) execution.cancel();
      await this.awaitIdle();
      this.durable.stop();
    })();
    return this.shutdownPromise;
  }

  private closeExecution(dispatchId: string): void {
    this.active.delete(dispatchId);
    const timer = this.heartbeatTimers.get(dispatchId);
    if (timer !== undefined) clearInterval(timer);
    this.heartbeatTimers.delete(dispatchId);
  }

  private async consumeUsage(intent: DispatchIntent, execution: DispatchExecution): Promise<void> {
    if (execution.usage === undefined) return;
    for await (const delta of execution.usage) this.durable.recordUsage(intent.dispatchId, delta);
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}
function boundedJitter(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(5_000, Math.floor(value)));
}
