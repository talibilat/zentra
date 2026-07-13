import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ArtifactRecordedEventSchema,
  artifactEvidenceSha256,
  projectArtifacts,
} from "../../src/contracts/artifact.js";
import type { StoredEvent } from "../../src/contracts/event.js";

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const validation = {
  name: "focused",
  outcome: "completed" as const,
  exitCode: 0,
  stdout: "ok\n",
  stderr: "",
  startedAt: "2026-07-13T00:00:00.000Z",
  finishedAt: "2026-07-13T00:00:01.000Z",
  command: ["/usr/bin/node", "--test"],
  argvSha256: digest(JSON.stringify(["/usr/bin/node", "--test"])),
  outputSha256: digest(JSON.stringify({ stdout: "ok\n", stderr: "" })),
  timeoutMs: 10_000,
  provenance: {
    invocationId: "validation-1",
    canonicalCwd: "/workspace",
    subjectSha256: digest("diff"),
    timeoutMs: 10_000,
  },
};
const review = {
  reviewerId: "reviewer-1",
  approved: true,
  diffSha256: digest("diff"),
  validationSha256: artifactEvidenceSha256("validation_report", validation),
  decidedAt: "2026-07-13T00:00:02.000Z",
  reason: "approved",
};
const fullValidation = {
  ...validation,
  name: "full",
  provenance: {
    ...validation.provenance,
    subjectSha256: "c".repeat(40),
  },
};
const receipt = {
  taskId: "task-1",
  projectId: "project-1",
  sourceCommit: "a".repeat(40),
  originalIntegrationCommit: "b".repeat(40),
  resultCommit: "c".repeat(40),
  review,
  validation: fullValidation,
  outcome: "completed" as const,
};

function event(type: string, streamVersion: number, payload: unknown = {}): StoredEvent {
  return {
    streamId: "task-1",
    type,
    payload,
    causationId: null,
    correlationId: "task-1",
    eventId: `event-${streamVersion}`,
    streamVersion,
    globalPosition: streamVersion,
    recordedAt: "2026-07-13T00:00:03.000Z",
  };
}

function artifactEvent(
  kind: "patch" | "validation_report" | "review_report" | "integration_receipt",
  streamVersion: number,
  evidence: unknown,
  artifactId = `artifact-${kind}`,
  phase?: "prepared" | "final",
): StoredEvent {
  return event(`artifact.${kind}_recorded`, streamVersion, {
    artifact: {
      artifactId,
      taskId: "task-1",
      kind,
      path: `artifacts/${kind}.json`,
      sha256: artifactEvidenceSha256(kind, evidence),
      createdAt: "2026-07-13T00:00:03.000Z",
    },
    evidence,
    ...(phase === undefined ? {} : { phase }),
  });
}

function artifactMarker(recorded: StoredEvent, streamVersion: number): StoredEvent {
  const payload = recorded.payload as {
    artifact: { artifactId: string; kind: string; sha256: string };
  };
  return event("task.artifact_recording", streamVersion, {
    artifactProtocolVersion: 1,
    artifactId: payload.artifact.artifactId,
    kind: payload.artifact.kind,
    sha256: payload.artifact.sha256,
  });
}

const patch = {
  diff: "diff",
  diffSha256: digest("diff"),
  changedPath: "greeting.txt",
  changedContentSha256: digest("hello\n"),
};
const validationStartedPayload = {
  diffSha256: patch.diffSha256,
  patch: { path: patch.changedPath, sha256: patch.changedContentSha256 },
};

function throughReviewRequest(): StoredEvent[] {
  return [
    event("task.created", 1, { projectId: "project-1", title: "task" }),
    event("task.leased", 2),
    event("task.started", 3),
    artifactEvent("patch", 4, patch),
    event("task.validation_started", 5, validationStartedPayload),
    artifactEvent("validation_report", 6, validation),
    event("task.review_requested", 7, { reviewerId: "reviewer-1", validation }),
  ];
}

describe("artifact recorded event contracts", () => {
  it.each([
    ["patch", patch],
    ["validation_report", validation],
    ["review_report", review],
    ["integration_receipt", receipt],
  ] as const)("accepts a typed %s artifact", (kind, evidence) => {
    const recorded = artifactEvent(kind, 4, evidence);
    expect(ArtifactRecordedEventSchema.parse({ type: recorded.type, payload: recorded.payload })).toBeDefined();
  });

  it.each([
    ["absolute path", { path: "/tmp/report.json" }],
    ["traversal path", { path: "../report.json" }],
    ["invalid digest", { sha256: "bad" }],
    ["empty identity", { artifactId: "" }],
  ])("rejects malformed artifact metadata with %s", (_case, mutation) => {
    const recorded = artifactEvent("patch", 4, patch);
    const payload = recorded.payload as { artifact: Record<string, unknown>; evidence: unknown };
    expect(() => ArtifactRecordedEventSchema.parse({
      type: recorded.type,
      payload: { ...payload, artifact: { ...payload.artifact, ...mutation } },
    })).toThrow();
  });

  it.each([
    ["patch", patch, { changedPath: "/tmp/greeting.txt" }],
    ["validation_report", validation, { outcome: "approved" }],
    ["review_report", review, { reviewerId: "" }],
    ["integration_receipt", receipt, { sourceCommit: "not-a-commit" }],
  ] as const)("rejects malformed %s evidence", (kind, evidence, mutation) => {
    const recorded = artifactEvent(kind, 4, evidence);
    const payload = recorded.payload as { artifact: unknown; evidence: Record<string, unknown> };
    expect(() => ArtifactRecordedEventSchema.parse({
      type: recorded.type,
      payload: { ...payload, evidence: { ...payload.evidence, ...mutation } },
    })).toThrow();
  });

  it("rejects oversized identity and evidence strings", () => {
    const recorded = artifactEvent("patch", 4, patch);
    const payload = recorded.payload as {
      artifact: Record<string, unknown>;
      evidence: Record<string, unknown>;
    };
    expect(() => ArtifactRecordedEventSchema.parse({
      type: recorded.type,
      payload: {
        ...payload,
        artifact: { ...payload.artifact, artifactId: "a".repeat(10_000) },
      },
    })).toThrow();
    expect(() => ArtifactRecordedEventSchema.parse({
      type: recorded.type,
      payload: {
        ...payload,
        evidence: { ...payload.evidence, diff: "d".repeat(2_000_000) },
      },
    })).toThrow();
  });

  it("rejects unbounded or contradictory validation timeout evidence", () => {
    const recorded = artifactEvent("validation_report", 6, validation);
    const payload = recorded.payload as {
      artifact: unknown;
      evidence: Record<string, unknown>;
    };
    expect(() => ArtifactRecordedEventSchema.parse({
      type: recorded.type,
      payload: {
        ...payload,
        evidence: { ...payload.evidence, timeoutMs: 99 },
      },
    })).toThrow();
    expect(() => ArtifactRecordedEventSchema.parse({
      type: recorded.type,
      payload: {
        ...payload,
        evidence: { ...payload.evidence, timeoutMs: 20_000 },
      },
    })).toThrow();
  });

  it.each([
    ["completed with a nonzero exit", { outcome: "completed", exitCode: 1 }],
    ["failed with a zero exit", { outcome: "failed", exitCode: 0 }],
    ["cancelled with an exit code", { outcome: "cancelled", exitCode: 1 }],
    ["timed out with an exit code", { outcome: "timed_out", exitCode: 1 }],
    ["reversed timestamps", {
      startedAt: "2026-07-13T00:00:02.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z",
    }],
  ])("rejects validation evidence that is %s", (_case, mutation) => {
    const recorded = artifactEvent("validation_report", 6, validation);
    const payload = recorded.payload as { artifact: unknown; evidence: Record<string, unknown> };
    expect(() => ArtifactRecordedEventSchema.parse({
      type: recorded.type,
      payload: { ...payload, evidence: { ...payload.evidence, ...mutation } },
    })).toThrow();
  });

  it("accepts historical validation evidence without timeout fields", () => {
    const { timeoutMs: _timeout, provenance, ...historical } = validation;
    const { timeoutMs: _provenanceTimeout, ...historicalProvenance } = provenance;
    const evidence = { ...historical, provenance: historicalProvenance };
    const recorded = artifactEvent("validation_report", 6, evidence);
    expect(ArtifactRecordedEventSchema.parse({ type: recorded.type, payload: recorded.payload }))
      .toBeDefined();
  });
});

describe("projectArtifacts", () => {
  it("rebuilds ordered typed artifacts from journal evidence alone", () => {
    const events = [
      ...throughReviewRequest(),
      artifactEvent("review_report", 8, review),
      event("task.review_approved", 9, { review }),
      event("task.integration_started", 10, { sourceCommit: receipt.sourceCommit, review }),
      artifactEvent("integration_receipt", 11, receipt, undefined, "prepared"),
      event("task.integration_prepared", 12, { receipt }),
    ];
    expect(projectArtifacts(events).artifacts.map((artifact) => artifact.kind)).toEqual([
      "patch",
      "validation_report",
      "review_report",
      "integration_receipt",
    ]);
  });

  it("replays a legacy pre-CAS receipt without an explicit phase", () => {
    const events = [
      ...throughReviewRequest(),
      artifactEvent("review_report", 8, review),
      event("task.review_approved", 9, { review }),
      event("task.integration_started", 10, { sourceCommit: receipt.sourceCommit, review }),
      artifactEvent("integration_receipt", 11, receipt),
      event("task.integration_prepared", 12, { receipt }),
    ];
    const view = projectArtifacts(events);
    const integrationReceipt = view.artifacts.find((artifact) =>
      artifact.kind === "integration_receipt")!;
    expect(view.phaseByArtifactId[integrationReceipt.artifactId]).toBe("prepared");
  });

  it("rejects duplicate identities", () => {
    expect(() => projectArtifacts([
      event("task.created", 1),
      event("task.leased", 2),
      event("task.started", 3),
      artifactEvent("patch", 4, patch, "duplicate"),
      event("task.validation_started", 5, validationStartedPayload),
      artifactEvent("validation_report", 6, validation, "duplicate"),
    ])).toThrow("duplicate artifact identity");
  });

  it("rejects contradictory digests", () => {
    const recorded = artifactEvent("patch", 4, patch);
    const payload = recorded.payload as { artifact: Record<string, unknown>; evidence: unknown };
    expect(() => projectArtifacts([
      event("task.created", 1),
      event("task.leased", 2),
      event("task.started", 3),
      { ...recorded, payload: { ...payload, artifact: { ...payload.artifact, sha256: "0".repeat(64) } } },
    ])).toThrow("digest contradicts");
  });

  it("rejects a patch when both recorded digests contradict the retained diff", () => {
    const recorded = artifactEvent("patch", 4, patch);
    const payload = recorded.payload as {
      artifact: Record<string, unknown>;
      evidence: Record<string, unknown>;
    };
    const forgedDigest = "0".repeat(64);
    expect(() => projectArtifacts([
      event("task.created", 1),
      event("task.leased", 2),
      event("task.started", 3),
      {
        ...recorded,
        payload: {
          artifact: { ...payload.artifact, sha256: forgedDigest },
          evidence: { ...payload.evidence, diffSha256: forgedDigest },
        },
      },
    ])).toThrow("patch artifact contains a contradictory diff digest");
  });

  it("uses bounded deterministic errors for malformed payloads and duplicate identities", () => {
    const malformed = artifactEvent("patch", 4, patch);
    const malformedPayload = malformed.payload as {
      artifact: Record<string, unknown>;
      evidence: unknown;
    };
    expect(() => projectArtifacts([
      event("task.created", 1),
      event("task.leased", 2),
      event("task.started", 3),
      {
        ...malformed,
        payload: {
          ...malformedPayload,
          artifact: { ...malformedPayload.artifact, artifactId: "a".repeat(10_000) },
        },
      },
    ])).toThrow(new Error("invalid artifact.patch_recorded payload"));

    expect(() => projectArtifacts([
      event("task.created", 1),
      event("task.leased", 2),
      event("task.started", 3),
      artifactEvent("patch", 4, patch, "duplicate"),
      event("task.validation_started", 5, validationStartedPayload),
      artifactEvent("validation_report", 6, validation, "duplicate"),
    ])).toThrow(new Error("duplicate artifact identity"));
  });

  it("rejects lifecycle evidence that references a missing artifact", () => {
    expect(() => projectArtifacts([
      event("task.created", 1),
      event("task.leased", 2),
      event("task.started", 3),
      artifactEvent("patch", 4, patch),
      event("task.validation_started", 5, validationStartedPayload),
      event("task.review_requested", 6, { validation }),
    ])).toThrow("missing validation_report artifact");
  });

  it("rejects an artifact recorded after its consuming lifecycle event", () => {
    expect(() => projectArtifacts([
      event("task.created", 1),
      event("task.leased", 2),
      event("task.started", 3),
      artifactEvent("patch", 4, patch),
      event("task.validation_started", 5, validationStartedPayload),
      event("task.review_requested", 6, { validation }),
      artifactEvent("validation_report", 7, validation),
    ])).toThrow();
  });

  it.each([
    ["task.review_requested", { reviewerId: "reviewer-1" }, "validation_report"],
    ["task.review_approved", {}, "review_report"],
    ["task.integration_started", { sourceCommit: receipt.sourceCommit }, "review_report"],
    ["task.integration_prepared", {}, "integration_receipt"],
  ] as const)("requires event-specific evidence on %s", (type, payload, missingKind) => {
    const events = [
      ...throughReviewRequest(),
      artifactEvent("review_report", 8, review),
      event("task.review_approved", 9, { review }),
      event("task.integration_started", 10, { sourceCommit: receipt.sourceCommit, review }),
      artifactEvent("integration_receipt", 11, receipt, undefined, "prepared"),
      event("task.integration_prepared", 12, { receipt }),
    ];
    const index = events.findIndex((candidate) => candidate.type === type);
    events[index] = { ...events[index]!, payload };
    expect(() => projectArtifacts(events)).toThrow(
      `${type} payload must carry ${missingKind === "validation_report" ? "validation" : missingKind === "review_report" ? "review" : "receipt"} evidence`,
    );
  });

  it.each([
    ["focused validation subject", (events: StoredEvent[]) => {
      const index = events.findIndex((candidate) => candidate.type === "artifact.validation_report_recorded");
      const recorded = events[index]!;
      const payload = recorded.payload as { artifact: Record<string, unknown>; evidence: typeof validation };
      const evidence = {
        ...payload.evidence,
        provenance: { ...payload.evidence.provenance, subjectSha256: "0".repeat(64) },
      };
      events[index] = {
        ...recorded,
        payload: {
          artifact: { ...payload.artifact, sha256: artifactEvidenceSha256("validation_report", evidence) },
          evidence,
        },
      };
    }],
    ["requested reviewer", (events: StoredEvent[]) => {
      const index = events.findIndex((candidate) => candidate.type === "artifact.review_report_recorded");
      const recorded = events[index]!;
      const payload = recorded.payload as { artifact: Record<string, unknown>; evidence: typeof review };
      const evidence = { ...payload.evidence, reviewerId: "substituted-reviewer" };
      events[index] = {
        ...recorded,
        payload: {
          artifact: { ...payload.artifact, sha256: artifactEvidenceSha256("review_report", evidence) },
          evidence,
        },
      };
    }],
    ["receipt task", (events: StoredEvent[]) => mutateReceipt(events, { taskId: "other-task" })],
    ["receipt project", (events: StoredEvent[]) => mutateReceipt(events, { projectId: "other-project" })],
    ["receipt source", (events: StoredEvent[]) => mutateReceipt(events, { sourceCommit: "0".repeat(40) })],
    ["receipt result", (events: StoredEvent[]) => mutateReceipt(events, {
      resultCommit: "d".repeat(40),
    })],
    ["full-validation provenance", (events: StoredEvent[]) => mutateReceipt(events, {
      validation: {
        ...fullValidation,
        provenance: { ...fullValidation.provenance, subjectSha256: "d".repeat(40) },
      },
    })],
  ] as const)("rejects substituted %s evidence", (_case, mutate) => {
    const events = completeArtifactChain();
    mutate(events);
    expect(() => projectArtifacts(events)).toThrow(/contradict|does not match/);
  });

  it("fails closed when a protocol marker survives deletion of its trailing artifact", () => {
    const recorded = artifactEvent("patch", 5, patch);
    expect(() => projectArtifacts([
      event("task.created", 1),
      event("task.leased", 2),
      event("task.started", 3),
      artifactMarker(recorded, 4),
    ])).toThrow("artifact protocol marker references missing patch artifact");
  });
});

function completeArtifactChain(): StoredEvent[] {
  return [
    event("task.created", 1, { projectId: "project-1", title: "task" }),
    event("task.leased", 2),
    event("task.started", 3),
    artifactEvent("patch", 4, patch),
    event("task.validation_started", 5, validationStartedPayload),
    artifactEvent("validation_report", 6, validation),
    event("task.review_requested", 7, { reviewerId: "reviewer-1", validation }),
    artifactEvent("review_report", 8, review),
    event("task.review_approved", 9, { review }),
    event("task.integration_started", 10, { sourceCommit: receipt.sourceCommit, review }),
    artifactEvent("integration_receipt", 11, receipt, "artifact-integration-prepared", "prepared"),
    event("task.integration_prepared", 12, { receipt }),
    artifactEvent("integration_receipt", 13, receipt, "artifact-integration-final", "final"),
  ];
}

function mutateReceipt(events: StoredEvent[], mutation: Record<string, unknown>): void {
  const index = events.findLastIndex((candidate) =>
    candidate.type === "artifact.integration_receipt_recorded");
  const recorded = events[index]!;
  const payload = recorded.payload as { artifact: Record<string, unknown>; evidence: typeof receipt };
  const evidence = { ...payload.evidence, ...mutation };
  events[index] = {
    ...recorded,
    payload: {
      artifact: { ...payload.artifact, sha256: artifactEvidenceSha256("integration_receipt", evidence) },
      evidence,
    },
  };
}
