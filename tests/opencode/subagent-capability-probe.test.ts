import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NATIVE_SUBAGENT_CONTRACTS,
  OpenCodeSubagentCapabilityProbe,
  evaluateNativeSubagentConformance,
  publicKeySha256,
  verifyOpenCodeSubagentProbeReport,
  type OpenCodeSubagentProbeReport,
  type OpenCodeTrustedIdentity,
} from "../../src/harnesses/opencode-subagent-capability.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";

const roots: string[] = [];
afterEach(() => {
  delete process.env.ZENTRA_SHOULD_NOT_LEAK;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("versioned OpenCode native-subagent capability probe", () => {
  it("keeps success and one failure fixture for every versioned contract without enabling fixtures", () => {
    const success = JSON.parse(readFileSync(new URL("../../fixtures/opencode-subagents/success.json", import.meta.url), "utf8"));
    const failures = JSON.parse(readFileSync(new URL("../../fixtures/opencode-subagents/failures.json", import.meta.url), "utf8")) as {
      readonly fixtures: readonly { readonly contract: string; readonly status: string; readonly evidenceRefs: readonly string[]; readonly reason: string }[];
    };
    expect(success.observations.map((item: { contract: string }) => item.contract)).toEqual(NATIVE_SUBAGENT_CONTRACTS);
    expect(failures.fixtures.map((item) => item.contract)).toEqual(NATIVE_SUBAGENT_CONTRACTS);
    expect(evaluateNativeSubagentConformance(success.observations, "fixture")).toMatchObject({
      conformant: true, toolsEnabled: false, denialReasons: ["fixture_evidence_not_enablement_eligible"],
    });
    for (const failure of failures.fixtures) {
      const observations = success.observations.map((item: { contract: string }) =>
        item.contract === failure.contract ? failure : item);
      expect(evaluateNativeSubagentConformance(observations, "fixture").conformant, failure.contract).toBe(false);
    }
  });

  it("retains bounded raw and digested evidence and classifies ten unobservable or unsupported contracts", async () => {
    process.env.ZENTRA_SHOULD_NOT_LEAK = "secret";
    const fixture = await executable("1.18.3");
    const signer = generateKeyPairSync("ed25519");
    const report = await new OpenCodeSubagentCapabilityProbe(new ProcessSupervisor(), fixture.identity).run({
      probeId: "probe-1", projectId: "project-1", executable: fixture.executable,
      sourceRevision: fixture.identity.sourceRevision, cwd: fixture.root, home: fixture.root,
      timeoutMs: 5_000, signingPrivateKey: signer.privateKey,
    }, AbortSignal.timeout(30_000));
    delete process.env.ZENTRA_SHOULD_NOT_LEAK;

    expect(report.commandEvidence.map((item) => item.id)).toEqual([
      "version", "root_help", "debug_help", "run_help", "pure_config", "agent_list",
      "build_agent", "general_agent", "explore_agent", "session_help", "serve_help",
    ]);
    expect(report.commandEvidence.every((item) => item.stdoutBytes <= 65_536 && item.stderrBytes <= 65_536)).toBe(true);
    expect(report.commandEvidence.every((item) => item.stdoutSha256.length === 64 && item.stderrSha256.length === 64)).toBe(true);
    expect(report.observations.map((item) => item.contract)).toEqual(NATIVE_SUBAGENT_CONTRACTS);
    expect(report.observations[0]).toMatchObject({ contract: "parent_child_identity", status: "supported" });
    expect(report.observations.slice(1).every((item) => item.status === "not_observable" || item.status === "unsupported")).toBe(true);
    expect(report).toMatchObject({ outcome: "denied", taskTool: "deny", subagentTool: "deny",
      lifecycleEndpoints: [], probeId: "probe-1", projectId: "project-1" });
    expect(verifyOpenCodeSubagentProbeReport(report,
      { expectedPublicKeySha256: publicKeySha256(signer.publicKey) })).toBe(true);
  });

  it("does not execute an arbitrary script that prints the supported version", async () => {
    const trusted = await executable("1.18.3");
    const fake = await executable("1.18.3", "executed");
    const signer = generateKeyPairSync("ed25519");
    const report = await new OpenCodeSubagentCapabilityProbe(new ProcessSupervisor(), trusted.identity).run({
      probeId: "probe-fake", projectId: "project-1", executable: fake.executable,
      sourceRevision: trusted.identity.sourceRevision, cwd: fake.root, home: fake.root,
      timeoutMs: 5_000, signingPrivateKey: signer.privateKey,
    }, AbortSignal.timeout(10_000));
    expect(report.denialReasons).toContain("executable_identity_mismatch");
    expect(report.commandEvidence).toEqual([]);
    expect(() => readFileSync(path.join(fake.root, "executed"))).toThrow();
  });

  it("executes only bounded version evidence after the canonical executable drifts", async () => {
    const trusted = await executable("1.18.3");
    const marker = path.join(trusted.root, "changed-executed");
    writeFileSync(trusted.executable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--version'])) process.exit(9);\nprocess.stdout.write('1.18.4\\n');\n`, { mode: 0o755 });
    const signer = generateKeyPairSync("ed25519");
    const report = await new OpenCodeSubagentCapabilityProbe(new ProcessSupervisor(), trusted.identity).run({
      probeId: "probe-digest", projectId: "project-1", executable: trusted.executable,
      sourceRevision: trusted.identity.sourceRevision, cwd: trusted.root, home: trusted.root,
      timeoutMs: 5_000, signingPrivateKey: signer.privateKey,
    }, AbortSignal.timeout(10_000));
    expect(report.denialReasons).toContain("executable_digest_drift");
    expect(report.denialReasons).toContain("version_drift");
    expect(report).toMatchObject({
      capability: "denied",
      classification: "version_drift",
      expectedExecutable: trusted.executable,
      expectedExecutableSha256: trusted.identity.executableSha256,
      expectedVersion: "1.18.3",
      expectedSourceRevision: trusted.identity.sourceRevision,
      version: "1.18.4",
    });
    expect(report.executableSha256).not.toBe(trusted.identity.executableSha256);
    expect(report.commandEvidence.map((item) => item.id)).toEqual(["version"]);
    expect(readFileSync(marker, "utf8")).toBe('["--version"]\n');
  });

  it("rejects raw command evidence tampering", async () => {
    const { report, publicKeyDigest } = await measuredReport();
    const tampered = structuredClone(report) as OpenCodeSubagentProbeReport;
    (tampered.commandEvidence as { stdout: string }[])[0]!.stdout = "1.18.4\n";
    expect(verifyOpenCodeSubagentProbeReport(tampered,
      { expectedPublicKeySha256: publicKeyDigest })).toBe(false);
  });

  it("rejects key replacement even when the replacement report has a valid signature", async () => {
    const first = await measuredReport("probe-key-1");
    const second = await measuredReport("probe-key-2");
    expect(verifyOpenCodeSubagentProbeReport(second.report,
      { expectedPublicKeySha256: first.publicKeyDigest })).toBe(false);
  });

  it.each([
    ["version", "1.18.4", "127bdb30784d508cc556c71a0f32b508a3061517", "version_drift"],
    ["source", "1.18.3", "227bdb30784d508cc556c71a0f32b508a3061517", "source_revision_drift"],
  ] as const)("denies %s drift", async (_kind, version, sourceRevision, reason) => {
    const fixture = await executable(version);
    const signer = generateKeyPairSync("ed25519");
    const report = await new OpenCodeSubagentCapabilityProbe(new ProcessSupervisor(), {
      ...fixture.identity, version: "1.18.3",
    }).run({ probeId: `probe-${reason}`, projectId: "project-1", executable: fixture.executable,
      sourceRevision, cwd: fixture.root, home: fixture.root, timeoutMs: 5_000,
      signingPrivateKey: signer.privateKey }, AbortSignal.timeout(30_000));
    expect(report.denialReasons).toContain(reason);
    expect(report.outcome).toBe("denied");
    expect(report.classification).toBe(reason);
  });
});

async function measuredReport(probeId = "probe-measured") {
  const fixture = await executable("1.18.3");
  const signer = generateKeyPairSync("ed25519");
  const report = await new OpenCodeSubagentCapabilityProbe(new ProcessSupervisor(), fixture.identity).run({
    probeId, projectId: "project-1", executable: fixture.executable,
    sourceRevision: fixture.identity.sourceRevision, cwd: fixture.root, home: fixture.root,
    timeoutMs: 5_000, signingPrivateKey: signer.privateKey,
  }, AbortSignal.timeout(30_000));
  return { report, publicKeyDigest: publicKeySha256(signer.publicKey) };
}

async function executable(version: string, marker?: string): Promise<{
  readonly root: string; readonly executable: string; readonly identity: OpenCodeTrustedIdentity;
}> {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-subagent-probe-")));
  roots.push(root);
  const executable = path.join(root, "opencode.mjs");
  const outputs: Readonly<Record<string, string>> = {
    "--version": `${version}\n`,
    "--help": "Commands: run debug agent session serve\n",
    "debug --help": "Commands: config agent paths\n",
    "run --help": "--format json --agent --session --fork\n",
    "--pure debug config": '{"plugin":[],"agent":{},"username":"unknown"}\n',
    "--pure agent list": "build (primary)\ngeneral (subagent)\nexplore (subagent)\n",
    "--pure debug agent build": '{"name":"build","tools":{"task":true,"bash":true}}\n',
    "--pure debug agent general": '{"name":"general","mode":"subagent","tools":{"task":false}}\n',
    "--pure debug agent explore": '{"name":"explore","mode":"subagent","tools":{"read":true}}\n',
    "session --help": "Commands: list delete\n",
    "serve --help": "starts a headless opencode server\n",
  };
  writeFileSync(executable, `#!${process.execPath}\nif (process.env.ZENTRA_SHOULD_NOT_LEAK) process.exit(8);\n${marker === undefined ? "" : `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(path.join(root, marker))}, 'yes');`}\nconst key = process.argv.slice(2).join(' ');\nconst output = ${JSON.stringify(outputs)}[key];\nif (output === undefined) process.exit(9);\nprocess.stdout.write(output);\n`, { mode: 0o755 });
  const canonical = realpathSync.native(executable);
  return { root, executable: canonical, identity: { executable: canonical,
    executableSha256: await OpenCodeSubagentCapabilityProbe.sha256(canonical), version: "1.18.3",
    sourceRevision: "127bdb30784d508cc556c71a0f32b508a3061517" } };
}
