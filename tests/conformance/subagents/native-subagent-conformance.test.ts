import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SqliteEventJournal } from "../../../src/journal/sqlite-journal.js";
import type { AtomicAppend } from "../../../src/journal/journal.js";
import {
  OpenCodeSubagentConformanceJournal,
  OpenCodeSubagentProbeEventPayloadSchema,
  createFixtureSubagentProbeReport,
  publicKeySha256,
  verifyOpenCodeSubagentProbeReport,
} from "../../../src/harnesses/opencode-subagent-capability.js";
import { storedEventToAgentTailEvent } from "../../../src/observability/agent-tail.js";

describe("native subagent denial conformance", () => {
  it("loads and verifies the genuine retained v2 report and journal without rewriting its signed payload", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-retained-subagent-v2-"));
    const database = path.join(root, "retained.sqlite");
    copyFileSync(new URL("../../fixtures/retained-opencode-subagent-v2.sqlite.fixture", import.meta.url), database);
    const journal = new SqliteEventJournal(database);
    try {
      const events = journal.readStream("subagent-probe:github-104-opencode-1.18.3-v2");
      expect(events).toHaveLength(2);
      const payload = OpenCodeSubagentProbeEventPayloadSchema.parse(events[0]?.payload);
      expect(payload).toMatchObject({
        schemaVersion: 2,
        probeId: "github-104-opencode-1.18.3-v2",
        projectId: "zentra",
        reportSha256: "76db952083b6dedec1088295ecd0f6e1a420b75558f04daffaa8a1366d979d59",
        signerPublicKeySha256: "851076cd3ea0f4a2f3f2b90f0c39d162da1248f5abba709b800c16c1b3f3c302",
        report: { schemaVersion: 2 },
      });
      expect(verifyOpenCodeSubagentProbeReport(payload.report, {
        expectedPublicKeySha256: payload.signerPublicKeySha256,
      })).toBe(true);
      expect(storedEventToAgentTailEvent(events[0]!).payload).toMatchObject({
        schemaVersion: 2,
        reportSchemaVersion: 2,
        evidenceClassification: "legacy_v2",
        classification: "legacy_retained_denial",
        capability: "denied",
        probeId: payload.probeId,
        projectId: payload.projectId,
        reportSha256: payload.reportSha256,
        signerPublicKeySha256: payload.signerPublicKeySha256,
      });
      expect(payload.report).not.toHaveProperty("classification");
      expect(payload.report).not.toHaveProperty("capability");
      expect(payload.report).not.toHaveProperty("expectedExecutable");
    } finally {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains the complete trusted signed report and binds AgentTrail to its digest and identity", () => {
    const journal = new SqliteEventJournal(":memory:");
    const signer = generateKeyPairSync("ed25519");
    const trustedDigest = publicKeySha256(signer.publicKey);
    const report = createFixtureSubagentProbeReport({ probeId: "probe-1", projectId: "project-1",
      signingPrivateKey: signer.privateKey, state: "denied" });
    expect(report.schemaVersion).toBe(3);
    new OpenCodeSubagentConformanceJournal(journal, { trustedPublicKeySha256: [trustedDigest] })
      .record("probe-1", "project-1", report, "correlation-1");

    const events = journal.readStream("subagent-probe:probe-1");
    expect(events.map((event) => event.type)).toEqual([
      "subagent.capability_probe_observed", "subagent.capability_denied",
    ]);
    expect(events[0]?.payload).toMatchObject({ probeId: "probe-1", projectId: "project-1",
      reportSha256: report.reportSha256, report });
    expect(verifyOpenCodeSubagentProbeReport(report,
      { expectedPublicKeySha256: trustedDigest })).toBe(true);
    const projected = events.map(storedEventToAgentTailEvent);
    expect(projected.map((event) => event.identities.project_id)).toEqual(["project-1", "project-1"]);
    expect(projected.map((event) => event.payload)).toEqual([
      expect.objectContaining({ probeId: "probe-1", projectId: "project-1", reportSha256: report.reportSha256 }),
      expect.objectContaining({ probeId: "probe-1", projectId: "project-1", reportSha256: report.reportSha256 }),
    ]);
    expect(projected.map((event) => event.payload)).toEqual([
      expect.objectContaining({ reportSchemaVersion: 3, evidenceClassification: "current_v3",
        capability: "denied", classification: "capability_nonconformance" }),
      expect.objectContaining({ reportSchemaVersion: 3, evidenceClassification: "current_v3",
        capability: "denied", classification: "capability_nonconformance" }),
    ]);
    journal.close();
  });

  it.each([
    ["probe replay", "other-probe", "project-1"],
    ["project replay", "probe-1", "other-project"],
  ] as const)("rejects %s across signed identity", (_name, probeId, projectId) => {
    const journal = new SqliteEventJournal(":memory:");
    const signer = generateKeyPairSync("ed25519");
    const report = createFixtureSubagentProbeReport({ probeId: "probe-1", projectId: "project-1",
      signingPrivateKey: signer.privateKey, state: "denied" });
    const service = new OpenCodeSubagentConformanceJournal(journal,
      { trustedPublicKeySha256: [publicKeySha256(signer.publicKey)] });
    expect(() => service.record(probeId, projectId, report, "correlation-1")).toThrow(/identity/i);
    expect(journal.readAll()).toEqual([]);
    journal.close();
  });

  it("rejects an untrusted replacement signing key", () => {
    const journal = new SqliteEventJournal(":memory:");
    const trusted = generateKeyPairSync("ed25519");
    const replacement = generateKeyPairSync("ed25519");
    const report = createFixtureSubagentProbeReport({ probeId: "probe-1", projectId: "project-1",
      signingPrivateKey: replacement.privateKey, state: "denied" });
    const service = new OpenCodeSubagentConformanceJournal(journal,
      { trustedPublicKeySha256: [publicKeySha256(trusted.publicKey)] });
    expect(() => service.record("probe-1", "project-1", report, "correlation-1")).toThrow(/trusted/i);
    expect(journal.readAll()).toEqual([]);
    journal.close();
  });

  it("rejects retained v2 tampering, strict-shape additions, and unknown report or event versions", () => {
    const raw = retainedV2Payload();
    const trusted = raw.signerPublicKeySha256 as string;
    expect(verifyOpenCodeSubagentProbeReport({ ...raw.report, outcome: "completed" }, {
      expectedPublicKeySha256: trusted,
    })).toBe(false);
    expect(verifyOpenCodeSubagentProbeReport({ ...raw.report, classification: "capability_nonconformance" }, {
      expectedPublicKeySha256: trusted,
    })).toBe(false);
    expect(verifyOpenCodeSubagentProbeReport({ ...raw.report, schemaVersion: 4 }, {
      expectedPublicKeySha256: trusted,
    })).toBe(false);
    expect(() => OpenCodeSubagentProbeEventPayloadSchema.parse({ ...raw, schemaVersion: 4,
      report: { ...raw.report, schemaVersion: 4 } })).toThrow();
  });

  it("retains the original v2 report identity and rejects cross-probe replay", () => {
    const raw = retainedV2Payload();
    const journal = new SqliteEventJournal(":memory:");
    const service = new OpenCodeSubagentConformanceJournal(journal, {
      trustedPublicKeySha256: [raw.signerPublicKeySha256],
    });
    service.record(raw.probeId, raw.projectId, raw.report, "legacy-replay");
    expect(journal.readStream(`subagent-probe:${raw.probeId}`)[0]?.payload).toMatchObject({
      schemaVersion: 2,
      probeId: raw.probeId,
      projectId: raw.projectId,
      reportSha256: raw.reportSha256,
      signerPublicKeySha256: raw.signerPublicKeySha256,
      report: raw.report,
    });
    expect(() => service.record("other-probe", raw.projectId, raw.report, "legacy-replay")).toThrow(/identity/i);
    expect(journal.readStream("subagent-probe:other-probe")).toEqual([]);
    journal.close();
  });

  it("replays the exact denial after an atomic append then throw", () => {
    class AppendThenThrowJournal extends SqliteEventJournal {
      private throwAfterAppend = true;

      override appendAtomically(writes: readonly AtomicAppend[]) {
        const stored = super.appendAtomically(writes);
        if (this.throwAfterAppend) {
          this.throwAfterAppend = false;
          throw new Error("controlled append-then-throw");
        }
        return stored;
      }
    }

    const journal = new AppendThenThrowJournal(":memory:");
    const signer = generateKeyPairSync("ed25519");
    const trustedDigest = publicKeySha256(signer.publicKey);
    const report = createFixtureSubagentProbeReport({ probeId: "probe-crash", projectId: "project-1",
      signingPrivateKey: signer.privateKey, state: "denied" });
    const service = new OpenCodeSubagentConformanceJournal(journal,
      { trustedPublicKeySha256: [trustedDigest] });

    expect(() => service.record("probe-crash", "project-1", report, "correlation-1"))
      .toThrow("controlled append-then-throw");
    expect(journal.readStream("subagent-probe:probe-crash")).toHaveLength(2);
    expect(() => service.record("probe-crash", "project-1", report, "correlation-1")).not.toThrow();
    expect(journal.readStream("subagent-probe:probe-crash")).toHaveLength(2);
    journal.close();
  });

  it("rejects a mismatched signed report when retrying a recorded probe", () => {
    const journal = new SqliteEventJournal(":memory:");
    const signer = generateKeyPairSync("ed25519");
    const trustedDigest = publicKeySha256(signer.publicKey);
    const first = createFixtureSubagentProbeReport({ probeId: "probe-retry", projectId: "project-1",
      signingPrivateKey: signer.privateKey, state: "denied" });
    const mismatch = createFixtureSubagentProbeReport({ probeId: "probe-retry", projectId: "project-1",
      signingPrivateKey: signer.privateKey, state: "conformant" });
    const service = new OpenCodeSubagentConformanceJournal(journal,
      { trustedPublicKeySha256: [trustedDigest] });

    service.record("probe-retry", "project-1", first, "correlation-1");
    expect(() => service.record("probe-retry", "project-1", mismatch, "correlation-1"))
      .toThrow(/does not match/i);
    expect(journal.readStream("subagent-probe:probe-retry")).toHaveLength(2);
    journal.close();
  });
});

function retainedV2Payload(): any {
  const root = mkdtempSync(path.join(tmpdir(), "zentra-retained-subagent-v2-"));
  const database = path.join(root, "retained.sqlite");
  copyFileSync(new URL("../../fixtures/retained-opencode-subagent-v2.sqlite.fixture", import.meta.url), database);
  const journal = new SqliteEventJournal(database);
  try {
    return journal.readStream("subagent-probe:github-104-opencode-1.18.3-v2")[0]?.payload;
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
}
