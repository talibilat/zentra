import type {
  PodDispatchAdapter,
  PodDispatchPacket,
  PodDispatchResult,
  PodExecutionHandle,
  PodExecutionReservation,
} from "../../src/pods/pod-coordinator.js";

export class RecordingPodDispatchAdapter implements PodDispatchAdapter {
  readonly packets: Array<PodDispatchPacket & { readonly executionId: string }> = [];
  readonly identities = new Map<string, PodExecutionHandle["identity"]>();

  constructor(
    private readonly result: PodDispatchResult = { outcome: "completed", evidence: [
      { evidenceId: "test-evidence", kind: "test-report", sha256: "e".repeat(64) },
    ] },
    private readonly beforeDispatch: (() => void) | null = null,
  ) {}

  start(packet: PodDispatchPacket & { readonly executionId: string }): Promise<PodExecutionHandle> {
    this.beforeDispatch?.();
    this.packets.push(packet);
    const identity = { dispatchId: packet.dispatchId, executionId: packet.executionId,
      processId: `process-${packet.dispatchId}`, processIncarnation: `incarnation-${packet.dispatchId}`,
      assignmentId: packet.assignment.assignmentId, charterRevision: packet.assignment.charterRevision };
    this.identities.set(identity.dispatchId, identity);
    return Promise.resolve({ identity,
      started: Promise.resolve({ executionId: identity.executionId, processId: identity.processId,
        acknowledgedAt: "2026-07-20T10:30:00.000Z" }),
      completion: Promise.resolve(this.result),
      requestCancellation: () => Promise.resolve({ executionId: identity.executionId, processId: identity.processId,
        terminated: true as const, acknowledgedAt: "2026-07-20T10:31:00.000Z" }),
    });
  }

  lookup(identity: PodExecutionReservation): ReturnType<PodDispatchAdapter["lookup"]> {
    const retained = this.identities.get(identity.dispatchId) ?? { ...identity, processId: null, processIncarnation: null };
    return Promise.resolve({ identity: retained, status: "terminated" as const, effect: "completed" as const,
      terminationEvidenceSha256: "a".repeat(64), effectEvidenceSha256: "b".repeat(64), evidence: this.result.evidence });
  }
}
