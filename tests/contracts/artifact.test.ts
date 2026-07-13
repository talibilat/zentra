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
  provenance: {
    invocationId: "validation-1",
    canonicalCwd: "/workspace",
    subjectSha256: digest("diff"),
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
const receipt = {
  taskId: "task-1",
  projectId: "project-1",
  sourceCommit: "a".repeat(40),
  originalIntegrationCommit: "b".repeat(40),
  resultCommit: "c".repeat(40),
  review,
  validation: { ...validation, name: "full" },
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
  });
}

const patch = {
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
    event("task.created", 1),
    event("task.leased", 2),
    event("task.started", 3),
    artifactEvent("patch", 4, patch),
    event("task.validation_started", 5, validationStartedPayload),
    artifactEvent("validation_report", 6, validation),
    event("task.review_requested", 7, { validation }),
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
});

describe("projectArtifacts", () => {
  it("rebuilds ordered typed artifacts from journal evidence alone", () => {
    const events = [
      ...throughReviewRequest(),
      artifactEvent("review_report", 8, review),
      event("task.review_approved", 9, { review }),
      event("task.integration_started", 10, { review }),
      artifactEvent("integration_receipt", 11, receipt),
      event("task.integration_prepared", 12, { receipt }),
    ];
    expect(projectArtifacts(events).artifacts.map((artifact) => artifact.kind)).toEqual([
      "patch",
      "validation_report",
      "review_report",
      "integration_receipt",
    ]);
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
});
