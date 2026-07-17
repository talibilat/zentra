import { digestCanonical } from "../contracts/authority-attention.js";
import type { EventJournal } from "../journal/journal.js";
import type { MilestoneRecord, MilestoneRegistry } from "../milestones/milestone-registry.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { ProjectRegistry } from "../projects/project-registry.js";
import {
  createLocalReleasePacket,
  inspectLocalReleaseResult,
  LocalReleaseRunner,
  type LocalReleaseResult,
} from "./local-release-runner.js";
import {
  RELEASE_BLOCKED_OPERATIONS,
  RELEASE_PREPARED_MESSAGE,
  ReleaseCreatedPayloadSchema,
  ReleaseMilestoneTaskCompletedPayloadSchema,
  ReleaseTaskCompletionEvidenceSchema,
  type ReleaseTaskCompletionEvidence,
} from "./release-events.js";

export interface LocalReleaseCoordinatorResult {
  readonly status: "prepared_local_only" | "cancelled" | "timed_out" | "failed" | "uncertain" | "blocked";
  readonly milestone: MilestoneRecord;
  readonly release: LocalReleaseResult | null;
  readonly blockedOperations: typeof RELEASE_BLOCKED_OPERATIONS;
  readonly message: string;
}

export class LocalReleaseCoordinator {
  private readonly runner: LocalReleaseRunner;

  constructor(
    private readonly journal: EventJournal,
    private readonly milestones: MilestoneRegistry,
    private readonly projects: ProjectRegistry,
  ) {
    this.runner = new LocalReleaseRunner(journal);
  }

  async run(input: {
    readonly releaseId: string; readonly milestoneId: string;
    readonly security: SecuritySheet; readonly signal: AbortSignal;
  }): Promise<LocalReleaseCoordinatorResult> {
    let milestone = this.requireMilestone(input.milestoneId);
    if (milestone.releaseOperation !== null && milestone.releaseOperation.releaseId !== input.releaseId) {
      throw new Error(`milestone release operation is already bound to ${milestone.releaseOperation.releaseId}`);
    }
    const verifiers = milestone.plan!.tasks.filter((task) =>
      task.roleAssignment.role === "verifier" && task.roleAssignment.harness === "deterministic" &&
      task.risk.authority === "local_release_preparation");
    if (verifiers.length !== 1) throw new Error("local release preparation requires exactly one verifier task with local_release_preparation authority");
    const verifier = verifiers[0]!;
    const verifierState = milestone.tasks[verifier.taskId];
    if (verifierState?.admissionDigest === null || verifierState?.admissionDigest === undefined) {
      throw new Error("local release preparation requires the durable verifier admission");
    }
    const envelope = milestone.authorityEnvelope;
    const securityDigest = digestCanonical(input.security);
    if (envelope === null || envelope.securityDigest !== securityDigest) {
      throw new Error("local release preparation security does not match the durable authority envelope");
    }
    if (input.security.releaseBoundary !== "local_preparation_only" &&
      input.security.releaseBoundary !== "approval_required_for_remote" &&
      input.security.releaseBoundary !== "no_release_operations") {
      throw new Error("unsupported release boundary");
    }
    if (verifierState.status === "completed") {
      return this.replayCompletedRelease(input, milestone, verifierState.admissionDigest, digestCanonical(envelope));
    }
    const project = this.projects.get(milestone.projectId);
    const resultCommit = verifiedIntegratedCommit(this.journal, milestone);
    const packet = await createLocalReleasePacket({
      releaseId: input.releaseId,
      milestoneId: input.milestoneId,
      taskId: verifier.taskId,
      project,
      resultCommit,
      securityDigest,
      authorityDigest: digestCanonical(envelope),
      verifierAdmissionDigest: verifierState.admissionDigest,
    });
    const packetDigest = digestCanonical(packet);
    if (milestone.releaseOperation !== null &&
      (milestone.releaseOperation.packetDigest !== packetDigest ||
        milestone.releaseOperation.verifierAdmissionDigest !== verifierState.admissionDigest ||
        milestone.releaseOperation.taskId !== verifier.taskId)) {
      throw new Error("release request contradicts the immutable milestone release packet");
    }
    if (milestone.releaseOperation === null) {
      milestone = this.milestones.bindReleaseOperation(input.milestoneId, {
        schemaVersion: 1,
        releaseId: input.releaseId,
        taskId: verifier.taskId,
        packetDigest,
        verifierAdmissionDigest: verifierState.admissionDigest,
      });
    }

    if (milestone.lifecycle === "paused") {
      if (milestone.attention?.reason !== "release_boundary") throw new Error(`milestone ${input.milestoneId} is paused`);
      const retained = inspectLocalReleaseResult(this.journal, packet);
      return retained === null
        ? output("blocked", milestone, null)
        : output(retained.status, milestone, retained);
    }
    if (input.security.releaseBoundary === "no_release_operations") {
      milestone = this.milestones.pauseForReleaseBoundary(
        input.milestoneId, verifier.taskId, input.security, verifierState.admissionDigest,
      );
      return output("blocked", milestone, null);
    }

    const state = milestone.tasks[verifier.taskId];
    if (state?.status === "ready") {
      milestone = this.milestones.startTask(input.milestoneId, verifier.taskId, verifier.roleAssignment.agentId, "verifier");
    } else if (state?.status !== "running" && state?.status !== "completed") {
      throw new Error("local release verifier must be durably ready before execution");
    }
    const release = await this.runner.run({ packet, project, signal: input.signal });
    if (release.status === "uncertain") return output("uncertain", this.requireMilestone(input.milestoneId), release);
    const outcome = release.status === "prepared_local_only" ? "completed" : release.status;
    milestone = this.milestones.completeTask(
      input.milestoneId,
      verifier.taskId,
      outcome,
      releaseCompletionEvidence(this.journal, packetDigest, resultCommit, release),
    );
    if (release.status !== "prepared_local_only") return output(release.status, milestone, release);
    milestone = this.milestones.pauseForReleaseBoundary(
      input.milestoneId, verifier.taskId, input.security, verifierState.admissionDigest,
    );
    return output("prepared_local_only", milestone, release);
  }

  private requireMilestone(milestoneId: string): MilestoneRecord {
    const milestone = this.milestones.inspect(milestoneId);
    if (milestone === null || milestone.plan === null) throw new Error(`milestone ${milestoneId} requires an accepted plan`);
    if (milestone.lifecycle === "terminal") throw new Error("release preparation must follow verified integration before terminal completion");
    return milestone;
  }

  private replayCompletedRelease(
    input: { readonly releaseId: string; readonly milestoneId: string; readonly security: SecuritySheet },
    milestone: MilestoneRecord,
    verifierAdmissionDigest: string,
    authorityDigest: string,
  ): LocalReleaseCoordinatorResult {
    const binding = milestone.releaseOperation;
    if (binding === null || binding.releaseId !== input.releaseId) {
      throw new Error("completed verifier lacks the exact bound release operation");
    }
    const releaseEvents = this.journal.readStream(`release:${input.releaseId}`);
    const createdEvents = releaseEvents.filter((event) => event.type === "release.created");
    if (createdEvents.length !== 1) throw new Error("completed verifier release stream lacks one exact packet event");
    const created = ReleaseCreatedPayloadSchema.parse(createdEvents[0]!.payload);
    const packet = created.packet;
    if (created.packetDigest !== binding.packetDigest || digestCanonical(packet) !== binding.packetDigest ||
      packet.releaseId !== input.releaseId || packet.milestoneId !== input.milestoneId ||
      packet.taskId !== binding.taskId || packet.projectId !== milestone.projectId ||
      packet.verifierAdmissionDigest !== verifierAdmissionDigest || binding.verifierAdmissionDigest !== verifierAdmissionDigest ||
      packet.securityDigest !== digestCanonical(input.security) || packet.authorityDigest !== authorityDigest) {
      throw new Error("retained release packet contradicts the milestone binding or authority");
    }
    const release = inspectLocalReleaseResult(this.journal, packet);
    if (release === null || release.status === "uncertain") {
      throw new Error("completed verifier lacks a known retained release outcome");
    }
    const completionEvents = this.journal.readStream(input.milestoneId).filter((event) => {
      if (event.type !== "milestone.task_completed") return false;
      const payload = record(event.payload, "milestone task completion");
      return payload["taskId"] === binding.taskId;
    });
    if (completionEvents.length !== 1) throw new Error("completed verifier requires one exact retained completion event");
    const completion = ReleaseMilestoneTaskCompletedPayloadSchema.parse(completionEvents[0]!.payload);
    const expectedOutcome = release.status === "prepared_local_only" ? "completed" : release.status;
    const projectedOutcome = milestone.tasks[binding.taskId]?.terminalOutcome;
    const expectedEvidence = releaseCompletionEvidence(this.journal, binding.packetDigest, packet.resultCommit, release);
    if (completion.outcome !== expectedOutcome || projectedOutcome !== expectedOutcome ||
      digestCanonical(completion.evidence) !== digestCanonical(expectedEvidence)) {
      throw new Error("retained release completion evidence contradicts the known outcome");
    }
    if (release.status === "prepared_local_only") {
      if (milestone.lifecycle === "paused") {
        if (milestone.attention?.reason !== "release_boundary") throw new Error("completed local release is paused for another reason");
      } else {
        milestone = this.milestones.pauseForReleaseBoundary(
          input.milestoneId, binding.taskId, input.security, verifierAdmissionDigest,
        );
      }
    }
    return output(release.status, milestone, release);
  }
}

function releaseCompletionEvidence(
  journal: EventJournal,
  packetDigest: string,
  resultCommit: string,
  release: LocalReleaseResult,
): ReleaseTaskCompletionEvidence {
  const releaseStreamId = `release:${release.releaseId}`;
  const events = journal.readStream(releaseStreamId);
  const first = events[0];
  const last = events.at(-1);
  if (first?.type !== "release.created" || last === undefined || first.streamId !== releaseStreamId || last.streamId !== releaseStreamId) {
    throw new Error("known release outcome lacks exact durable release evidence");
  }
  return ReleaseTaskCompletionEvidenceSchema.parse({
    schemaVersion: 1,
    releaseStreamId,
    packetDigest,
    resultCommit,
    status: release.status,
    releaseEvents: [first, last].map((event) => ({
      streamId: event.streamId,
      eventId: event.eventId,
      eventType: event.type,
      streamVersion: event.streamVersion,
      payloadDigest: digestCanonical(event.payload),
    })),
    artifacts: release.artifacts.map((artifact) => ({
      pathDigest: digestCanonical(artifact.path), size: artifact.size, sha256: artifact.sha256,
    })),
  });
}

function verifiedIntegratedCommit(journal: EventJournal, milestone: MilestoneRecord): string {
  const writers = milestone.plan!.tasks.filter((task) => task.roleAssignment.role === "implementer");
  if (writers.length === 0 || Object.values(milestone.writerOwnership).some((ownership) => ownership.status !== "integrated")) {
    throw new Error("local release preparation requires verified integration");
  }
  const observations = writers.map((writer) => {
    const matches = journal.readStream(writer.taskId).filter((event) => event.type === "task.integration_observed");
    if (matches.length !== 1) throw new Error("local release preparation requires one verified integration observation per writer");
    const payload = record(matches[0]!.payload, "integration observation");
    const receipt = record(payload["receipt"], "integration receipt");
    if (payload["verification"] !== "verified" || receipt["outcome"] !== "completed" ||
      receipt["taskId"] !== writer.taskId || receipt["projectId"] !== milestone.projectId ||
      typeof receipt["resultCommit"] !== "string" || !/^[a-f0-9]{40,64}$/.test(receipt["resultCommit"])) {
      throw new Error("local release preparation integration evidence is not verified");
    }
    return { globalPosition: matches[0]!.globalPosition, resultCommit: receipt["resultCommit"] };
  });
  observations.sort((left, right) => left.globalPosition - right.globalPosition);
  return observations.at(-1)!.resultCommit;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function output(status: LocalReleaseCoordinatorResult["status"], milestone: MilestoneRecord, release: LocalReleaseResult | null): LocalReleaseCoordinatorResult {
  return Object.freeze({ status, milestone, release, blockedOperations: RELEASE_BLOCKED_OPERATIONS, message: RELEASE_PREPARED_MESSAGE });
}
