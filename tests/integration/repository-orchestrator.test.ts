import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import type { StoredEvent } from "../../src/contracts/event.js";
import {
  IntegrationSubmissionSchema,
  buildReplanProposal,
  formIntegrationUnits,
  projectRepositoryOrchestration,
  repositoryOrchestrationStreamId,
  type IntegrationSubmission,
} from "../../src/integration/repository-orchestrator.js";

describe("repository orchestrator durable contracts", () => {
  it("forms singleton units from green candidate tests and batches only matching failed candidate evidence", () => {
    const units = formIntegrationUnits([
      admission("a", "green-a", true), admission("b", "green-b", true),
      admission("c", "coupled", false), admission("d", "coupled", false),
    ]);
    expect(units.map((unit) => unit.taskIds)).toEqual([["task-a"], ["task-b"], ["task-c", "task-d"]]);
    expect(units[2]).toMatchObject({ tightlyCoupled: true,
      admissionReceipts: [expect.objectContaining({ receiptId: "admission-c" }),
        expect.objectContaining({ receiptId: "admission-d" })] });
  });

  it("rejects forged, missing, and insufficient contract-stability evidence", () => {
    expect(() => IntegrationSubmissionSchema.parse({ ...admission("a", "green", true), digest: "0".repeat(64) }))
      .toThrow(/digest/i);
    expect(() => formIntegrationUnits([admission("a", "coupled", false)])).toThrow(/at least two/i);
    const unrelated = admission("b", "other", false);
    expect(() => formIntegrationUnits([admission("a", "coupled", false), unrelated])).toThrow(/contract/i);
    const valid = admission("z", "green", true);
    const { digest: _digest, ...forgedBody } = { ...valid, schedulerGrantId: "grant-forged" };
    expect(() => IntegrationSubmissionSchema.parse({ ...forgedBody,
      digest: digestCanonical(forgedBody) })).toThrow(/writer grant and claim/i);
  });

  it.each(["cancelled", "timed_out", "failed"] as const)(
    "rejects %s candidate outcomes without an observed process exit",
    (outcome) => {
      const valid = admission("a", "coupled", false);
      const candidateValidation = { ...valid.contract.candidateValidation, outcome, exitCode: null };
      const contract = { ...valid.contract, candidateValidation };
      const { digest: _digest, ...body } = { ...valid, contract };
      expect(() => IntegrationSubmissionSchema.parse({ ...body, digest: digestCanonical(body) }))
        .toThrow(/nonzero process exit/i);
    },
  );

  it("rejects an uncertain candidate outcome before unit formation", () => {
    const valid = admission("a", "coupled", false);
    const candidateValidation = { ...valid.contract.candidateValidation,
      outcome: "uncertain", exitCode: null };
    const contract = { ...valid.contract, candidateValidation };
    const { digest: _digest, ...body } = { ...valid, contract };
    expect(() => IntegrationSubmissionSchema.parse({ ...body, digest: digestCanonical(body) }))
      .toThrow();
  });

  it("binds maxAttempts and replacement admissions into the exact replan digest", () => {
    const replacement = admission("r", "green", true);
    const proposal = buildReplanProposal({ projectId: "project-1", unitId: "unit-1",
      conflictId: "conflict-1", attempt: 1, maxAttempts: 2, changedPaths: ["src/r.ts"],
      behaviorChanges: [], authorityChanges: [], rationale: "Use reviewed replacement.",
      replacementAdmissionReceipts: [replacement] });
    const changedMax = buildReplanProposal({ projectId: "project-1", unitId: "unit-1",
      conflictId: "conflict-1", attempt: 1, maxAttempts: 3, changedPaths: ["src/r.ts"],
      behaviorChanges: [], authorityChanges: [], rationale: "Use reviewed replacement.",
      replacementAdmissionReceipts: [replacement] });
    expect(changedMax.approvalDigest).not.toBe(proposal.approvalDigest);
  });

  it("reconstructs exact source receipts after restart and rejects units without prior durable admissions", () => {
    const streamId = repositoryOrchestrationStreamId("project-1");
    const receipt = admission("a", "green", true);
    const unit = formIntegrationUnits([receipt])[0]!;
    const admitted = stored(streamId, 1, "repository.submission_admitted", { schemaVersion: 1, receipt });
    const formed = stored(streamId, 2, "integration.unit_formed", { schemaVersion: 1,
      unitId: unit.unitId, contractId: unit.contractId, taskIds: unit.taskIds, podIds: unit.podIds,
      paths: unit.paths, sourceCommits: unit.sourceCommits, admissionReceipts: unit.admissionReceipts,
      tightlyCoupled: false, formedAt: "2026-07-21T00:00:00.000Z" });
    const restarted = projectRepositoryOrchestration([admitted, formed]);
    expect(restarted.units[unit.unitId]).toMatchObject({ sourceCommits: [receipt.sourceCommit],
      admissionReceipts: [expect.objectContaining({ digest: receipt.digest })] });
    expect(() => projectRepositoryOrchestration([{ ...formed, streamVersion: 1 }])).toThrow(/prior durable/i);
  });

  it("rejects non-monotonic replan attempts and maxAttempts changes after approval", () => {
    const streamId = repositoryOrchestrationStreamId("project-1");
    const receipt = admission("a", "green", true);
    const unit = formIntegrationUnits([receipt])[0]!;
    const proposal = buildReplanProposal({ projectId: "project-1", unitId: unit.unitId,
      conflictId: "conflict-1", attempt: 1, maxAttempts: 2, changedPaths: ["src/a.ts"],
      behaviorChanges: [], authorityChanges: [], rationale: "Replace source.",
      replacementAdmissionReceipts: [receipt] });
    const events = [
      stored(streamId, 1, "repository.submission_admitted", { schemaVersion: 1, receipt }),
      stored(streamId, 2, "integration.unit_formed", { schemaVersion: 1, unitId: unit.unitId,
        contractId: unit.contractId, taskIds: unit.taskIds, podIds: unit.podIds, paths: unit.paths,
        sourceCommits: unit.sourceCommits, admissionReceipts: unit.admissionReceipts,
        tightlyCoupled: false, formedAt: "2026-07-21T00:00:00.000Z" }),
      stored(streamId, 3, "conflict.observed", { schemaVersion: 1, unitId: unit.unitId,
        conflictId: "conflict-1", paths: ["src/a.ts"], analysisSha256: "8".repeat(64),
        observedAt: "2026-07-21T00:00:01.000Z" }),
      stored(streamId, 4, "replan.proposed", replanPayload(proposal)),
      stored(streamId, 5, "replan.approved", { schemaVersion: 1, unitId: unit.unitId,
        approvalDigest: proposal.approvalDigest, decidedBy: "operator",
        decidedAt: "2026-07-21T00:00:03.000Z" }),
      stored(streamId, 6, "conflict.observed", { schemaVersion: 1, unitId: unit.unitId,
        conflictId: "conflict-2", paths: ["src/a.ts"], analysisSha256: "9".repeat(64),
        observedAt: "2026-07-21T00:00:04.000Z" }),
    ];
    const changedMax = buildReplanProposal({ projectId: "project-1", unitId: unit.unitId,
      conflictId: "conflict-2", attempt: 2, maxAttempts: 3, changedPaths: ["src/a.ts"],
      behaviorChanges: [], authorityChanges: [], rationale: "Try again.",
      replacementAdmissionReceipts: [receipt] });
    expect(() => projectRepositoryOrchestration([...events,
      stored(streamId, 7, "replan.proposed", replanPayload(changedMax))])).toThrow(/maximum|monotonic/i);
  });
});

function replanPayload(proposal: ReturnType<typeof buildReplanProposal>) {
  return { schemaVersion: 1, unitId: proposal.unitId, conflictId: proposal.conflictId,
    approvalDigest: proposal.approvalDigest, requiresApproval: true, attempt: proposal.attempt,
    maxAttempts: proposal.maxAttempts, changedPaths: proposal.changedPaths,
    behaviorChanges: proposal.behaviorChanges, authorityChanges: proposal.authorityChanges,
    rationale: proposal.rationale, replacementAdmissionReceipts: proposal.replacementAdmissionReceipts,
    proposedAt: "2026-07-21T00:00:02.000Z" };
}

function admission(suffix: string, contractKey: string, green: boolean): IntegrationSubmission {
  const source = suffix.padEnd(40, "a").slice(0, 40).replace(/[^a-f0-9]/g, "a");
  const validation = report(green ? "completed" : "failed", source);
  const focused = report("completed", "f".repeat(64));
  const body = {
    schemaVersion: 1 as const, receiptId: `admission-${suffix}`, projectId: "project-1",
    repositoryPath: "/tmp/repository", projectRevision: "a".repeat(40), podId: `pod-${suffix}`,
    projectConfigDigest: "0".repeat(64),
    taskId: `task-${suffix}`, podStreamVersion: 10, charterRevision: 1, assignmentId: `assignment-${suffix}`,
    assignmentDigest: "1".repeat(64), proposalId: "2".repeat(64), podGrantDigest: "3".repeat(64),
    podLeaseDigest: "4".repeat(64), workspaceLeaseId: `workspace-${suffix}`, schedulerId: "scheduler-1",
    schedulerStreamVersion: 20, schedulerTaskId: `scheduled-${suffix}`, schedulerWorkerId: `worker-${suffix}`,
    schedulerGrantId: `grant-${suffix}`, schedulerDispatchId: "00000000-0000-4000-8000-000000000001",
    claimId: `claim-${suffix}`, claimLeaseToken: "00000000-0000-4000-8000-000000000002",
    claimOwnerId: `worker-${suffix}`,
    writerAuthorityDigest: digestCanonical({ schedulerWorkerId: `worker-${suffix}`,
      schedulerGrantId: `grant-${suffix}`, schedulerDispatchId: "00000000-0000-4000-8000-000000000001",
      claimId: `claim-${suffix}`, claimLeaseToken: "00000000-0000-4000-8000-000000000002",
      claimOwnerId: `worker-${suffix}`, projectRevision: "a".repeat(40) }),
    correctionBinding: null,
    branch: `ticket/task-${suffix}`, workspacePath: `/tmp/work-${suffix}`,
    baseCommit: "b".repeat(40), sourceCommit: source, changedPaths: [`src/${suffix}.ts`],
    diffSha256: "f".repeat(64),
    review: { reviewerId: `reviewer-${suffix}`, approved: true, diffSha256: "f".repeat(64),
      validationSha256: canonicalValidationDigestForFixture(focused), decidedAt: "2026-07-21T00:00:00.000Z",
      reason: "approved" },
    focusedValidation: focused,
    contract: { contractDigest: digestCanonical({ key: contractKey }), scopeDigest: "5".repeat(64),
      behaviorDigest: "6".repeat(64), authorityDigest: "7".repeat(64),
      batchKeyDigest: green ? null : digestCanonical({ key: contractKey }), candidateValidation: validation,
      candidateOutcome: green ? "green" as const : "non_green" as const },
    admittedAt: "2026-07-21T00:00:00.000Z",
  };
  return IntegrationSubmissionSchema.parse({ ...body, digest: digestCanonical(body) });
}

function report(outcome: "completed" | "failed", subject: string) {
  const command = [process.execPath, "-e", "process.exit(0)"];
  const stdout = ""; const stderr = outcome === "failed" ? "failed" : "";
  return { name: "focused", outcome, exitCode: outcome === "completed" ? 0 : 1,
    stdout, stderr, startedAt: "2026-07-21T00:00:00.000Z", finishedAt: "2026-07-21T00:00:01.000Z",
    command, argvSha256: digestText(JSON.stringify(command)),
    outputSha256: digestText(JSON.stringify({ stdout, stderr })), timeoutMs: 100,
    provenance: { invocationId: `invocation-${subject.slice(0, 8)}`, canonicalCwd: "/tmp",
      subjectSha256: subject, timeoutMs: 100 } } as const;
}

function canonicalValidationDigestForFixture(validation: ReturnType<typeof report>): string {
  return digestText(JSON.stringify({ name: validation.name, outcome: validation.outcome,
    exitCode: validation.exitCode, startedAt: validation.startedAt, finishedAt: validation.finishedAt,
    command: validation.command, stdout: validation.stdout, stderr: validation.stderr,
    argvSha256: validation.argvSha256, outputSha256: validation.outputSha256,
    provenance: validation.provenance }));
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stored(streamId: string, streamVersion: number, type: string, payload: unknown): StoredEvent {
  return { streamId, streamVersion, type, payload, eventId: `event-${streamVersion}`,
    globalPosition: streamVersion, recordedAt: "2026-07-21T00:00:00.000Z",
    causationId: null, correlationId: "project-1" };
}
