import type { SchedulerView } from "../scheduling/scheduler-projection.js";
import type { GlobalControlView } from "../scheduling/global-control.js";
import type { DaemonLeaseView } from "../leases/daemon-lease.js";
import type { LeaseView } from "../leases/lease-projection.js";

export interface SchedulerDiagnostic {
  readonly processIncarnation: string | null;
  readonly queueDepth: number;
  readonly running: number;
  readonly reconciling: number;
  readonly blockedByReason: Readonly<Record<string, number>>;
  readonly resources: SchedulerView["usage"]["resources"];
  readonly budget: SchedulerView["usage"]["budget"];
  readonly spentBudget: GlobalControlView["spentBudget"] | null;
  readonly globalAllocationCount: number | null;
  readonly daemonLease: { readonly schedulerId: string; readonly processIncarnation: string;
    readonly pid: number; readonly processStartIdentity: string;
    readonly expiresAtMs: number; readonly status: string } | null;
  readonly workers: readonly { readonly taskId: string; readonly workerId: string;
    readonly workerIncarnation: string | null; readonly pid: number | null;
    readonly deadlineAtMs: number | null; readonly status: string;
    readonly queueWaitMs: number; readonly backpressure: string | null;
    readonly reconciliationReason: string | null;
    readonly cancellation: { readonly requested: boolean; readonly acknowledged: boolean;
      readonly requestedAtMs: number | null; readonly reason: string | null };
    readonly taskLease: DiagnosticLease | null; readonly workerLease: DiagnosticLease | null }[];
}

export interface DiagnosticLease { readonly leaseId: string; readonly schedulerId: string;
  readonly workerId: string; readonly processIncarnation: string; readonly workerIncarnation: string | null;
  readonly expiresAtMs: number; readonly lastHeartbeatAtMs: number | null;
  readonly heartbeatAgeMs: number | null; readonly status: string }

export function projectSchedulerDiagnostic(view: SchedulerView, options: {
  readonly control?: GlobalControlView;
  readonly daemonLease?: DaemonLeaseView | null;
  readonly leases?: Readonly<Record<string, LeaseView>>;
  readonly nowMs?: number;
} = {}): SchedulerDiagnostic {
  const tasks = Object.values(view.tasks);
  const blockedByReason: Record<string, number> = {};
  const nowMs = options.nowMs ?? Date.now();
  for (const task of tasks) {
    for (const reason of task.blockedReasons) blockedByReason[reason] = (blockedByReason[reason] ?? 0) + 1;
  }
  return Object.freeze({
    processIncarnation: view.processIncarnation,
    queueDepth: tasks.filter((task) => task.status === "queued" || task.status === "ready" || task.status === "blocked").length,
    running: tasks.filter((task) => task.status === "dispatched" || task.status === "running" || task.status === "cancelling").length,
    reconciling: tasks.filter((task) => task.status === "reconciling").length,
    blockedByReason: Object.freeze(blockedByReason),
    resources: view.usage.resources,
    budget: view.usage.budget,
    spentBudget: options.control?.spentBudget ?? null,
    globalAllocationCount: options.control === undefined ? null : Object.keys(options.control.allocations).length,
    daemonLease: options.daemonLease == null ? null : Object.freeze({
      schedulerId: options.daemonLease.owner.schedulerId,
      processIncarnation: options.daemonLease.owner.processIncarnation,
      pid: options.daemonLease.owner.pid,
      processStartIdentity: options.daemonLease.owner.processStartIdentity,
      expiresAtMs: options.daemonLease.expiresAtMs,
      status: options.daemonLease.status,
    }),
    workers: Object.freeze(tasks.map((task) => Object.freeze({
      taskId: task.input.taskId, workerId: task.input.workerId,
      workerIncarnation: task.workerIncarnation, pid: task.workerPid,
      deadlineAtMs: task.dispatch?.deadlineAtMs ?? null, status: task.status,
      queueWaitMs: Math.max(0, (task.dispatch?.intendedAtMs ?? nowMs) - task.submittedAtMs),
      backpressure: task.backpressure,
      reconciliationReason: task.reconciliationReason,
      cancellation: Object.freeze({ requested: task.cancellationRequestedAtMs !== null,
        acknowledged: task.cancellationSignalled, requestedAtMs: task.cancellationRequestedAtMs,
        reason: task.cancellationReason }),
      taskLease: diagnosticLease(task.dispatch?.taskLeaseId, options.leases, nowMs),
      workerLease: diagnosticLease(task.dispatch?.workerLeaseId, options.leases, nowMs),
    }))),
  });
}

function diagnosticLease(leaseId: string | undefined, leases: Readonly<Record<string, LeaseView>> | undefined,
  nowMs: number): DiagnosticLease | null {
  if (leaseId === undefined || leases === undefined) return null;
  const lease = leases[leaseId];
  if (lease === undefined) return null;
  return Object.freeze({ leaseId, schedulerId: lease.schedulerId, workerId: lease.workerId,
    processIncarnation: lease.processIncarnation, workerIncarnation: lease.workerIncarnation,
    expiresAtMs: lease.expiresAtMs, lastHeartbeatAtMs: lease.lastHeartbeatAtMs,
    heartbeatAgeMs: lease.lastHeartbeatAtMs === null ? null : Math.max(0, nowMs - lease.lastHeartbeatAtMs),
    status: lease.status });
}
