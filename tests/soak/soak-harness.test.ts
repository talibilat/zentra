import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SOAK_ABRUPT_POINTS,
  SOAK_FAULT_KINDS,
  createSoakProfile,
  runSoakHarness,
  trustedSoakPublicKeySha256,
  verifySoakReport,
} from "../../src/soak/soak-harness.js";
import { openAuthoritativeJournal } from "../../src/journal/retention.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(profile: "ci" | "process" | "realtime-24h", seed: string, workerCount = 20) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-production-soak-")));
  roots.push(root);
  const privateKeyPath = path.join(root, "trusted-soak-key.pem");
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const trustedPublicKeySha256 = trustedSoakPublicKeySha256(privateKeyPath);
  return { root, config: createSoakProfile(profile, { seed, workerCount,
    signing: { privateKeyPath, trustedPublicKeySha256 } }) };
}

describe("production soak harness", () => {
  it("runs two real #101 waves across an accelerated 1,440-tick day and verifies retained evidence", async () => {
    const { root, config } = fixture("ci", "production-day", 40);
    const result = await runSoakHarness({ root, config });

    expect(config).toMatchObject({ ticks: 1_440, tickMs: 60_000, realTime: false, workerCount: 40 });
    expect(result.report.status, JSON.stringify(result.report.slos)).toBe("qualified");
    expect(result.report.workers).toMatchObject({ registered: 40, unique: 40 });
    expect(result.report.production).toMatchObject({ waves: 2, completeWaves: 2, verifiedUnits: 12,
      productionBoundaries: { scheduler: true, daemon: true, pods: true, claims: true, supervisedProcesses: true,
        trustedPatchApply: true, repositoryOrchestrator: true, integrationQueue: true, agentTrail: true } });
    expect(result.report.capacity).toMatchObject({ respected: true,
      configured: { reasoning: 12, writers: 4, heavyValidation: 2, review: 2, integration: 1 } });
    expect(result.report.faults.configured).toEqual([...SOAK_FAULT_KINDS].sort());
    expect(result.report.faults.outcomes.every((fault) => fault.outcome === "recovered" || fault.outcome === "observed")).toBe(true);
    expect(result.report.maintenance).toMatchObject({ archiveSegments: expect.any(Number), prunes: 1,
      vacuumAttempts: 1, maximumArchiveRange: expect.any(Number) });
    expect(result.report.maintenance.archiveSegments).toBeGreaterThanOrEqual(2);
    expect(result.report.maintenance.maximumArchiveRange).toBeLessThan(10_000);
    expect(result.report.samples).toMatchObject({ count: 1_440, rssMaximumBytes: expect.any(Number),
      heapMaximumBytes: expect.any(Number), diskMaximumBytes: expect.any(Number), processOutputMaximumBytes: expect.any(Number) });
    expect(result.report.observability).toMatchObject({ heartbeats: expect.any(Number),
      projectionLagMaximum: expect.any(Number), projectionRebuilt: true });
    expect(result.report.observability.heartbeats).toBeGreaterThan(0);
    expect(result.report.attention).toMatchObject({ duplicates: 0 });
    expect(result.report.attention.items.map((item) => item.rank)).toEqual(
      result.report.attention.items.map((_, index) => index + 1));
    expect(result.report.attention.items.every((item) => item.authority === "none")).toBe(true);
    expect(result.report.bottlenecks.length).toBeGreaterThan(0);
    expect(result.report.safetyViolations).toEqual([]);
    expect(result.report.slos.every((slo) => slo.passed)).toBe(true);
    expect(statSync(result.reportPath).size).toBeLessThan(config.limits.maxReportBytes);
    expect(await verifySoakReport(result.reportPath, { root, trustedPublicKeySha256: config.signing.trustedPublicKeySha256 })).toBe(true);

    const journal = openAuthoritativeJournal(result.databasePath, "read-only");
    try {
      expect(journal.readAllPage(0, { maxEvents: 200, maxBytes: 1024 * 1024 }).hasMore).toBe(true);
      expect(journal.readStream("soak:control").filter((event) => event.type === "soak.tick_observed")).toHaveLength(1_440);
    } finally { journal.close(); }
  }, 180_000);

  it("reconciles abrupt mid-operation exits without repeating production or maintenance effects", async () => {
    const { root, config } = fixture("ci", "abrupt-matrix");
    for (const [index, abruptPoint] of SOAK_ABRUPT_POINTS.entries()) {
      const child = await runAbruptChild([path.resolve("node_modules/vite-node/dist/cli.mjs"),
        path.resolve("tests/soak/soak-abrupt-child.ts"), root, config.signing.privateKeyPath,
        config.signing.trustedPublicKeySha256, abruptPoint, String(index > 0)]);
      expect(child.signal, `${abruptPoint}: ${child.stderr}`).toBe("SIGKILL");
    }
    const result = await runSoakHarness({ root, config, resume: true });
    expect(result.report.status, JSON.stringify({ slos: result.report.slos,
      safety: result.report.safetyViolations, production: result.report.production })).toBe("qualified");
    expect(result.report.production).toMatchObject({ waves: 2, completeWaves: 2 });
    expect(result.report.recovery).toMatchObject({ abruptExits: SOAK_ABRUPT_POINTS.length,
      reconciledOperations: SOAK_ABRUPT_POINTS.length, repeatedEffects: 0,
      maximumRecoveryMs: expect.any(Number) });
    expect(result.report.maintenance).toMatchObject({ prunes: 1, vacuumAttempts: 1 });
    expect(result.report.safetyViolations).toEqual([]);
  }, 180_000);

  it("uses actual killed, delayed, cancelled, output-bounded, and minimal-environment processes", async () => {
    const { root, config } = fixture("process", "real-processes");
    const result = await runSoakHarness({ root, config });
    expect(result.report.status, JSON.stringify({ slos: result.report.slos,
      safety: result.report.safetyViolations, production: result.report.production })).toBe("qualified");
    expect(result.report.processes).toMatchObject({ spawned: expect.any(Number), killed: 4, delayedValidators: 1,
      cancelledInFlight: 1, secretLeaks: 0, shellExecutions: 0, outputLimitObserved: true });
    expect(result.report.production.completeWaves).toBe(1);
    expect(result.report.safetyViolations).toEqual([]);
  }, 120_000);

  it("requires exact qualifying real-time schema and never treats an accelerated run as 24-hour evidence", () => {
    const { config } = fixture("realtime-24h", "qualifying-schema", 40);
    expect(config).toMatchObject({ realTime: true, tickMs: 60_000, ticks: 1_440, durationMs: 86_400_000 });
    expect(config.qualifying).toBe(true);
    const accelerated = fixture("ci", "not-qualifying", 40).config;
    expect(accelerated.qualifying).toBe(false);
    expect(() => createSoakProfile("realtime-24h", { seed: "bad", workerCount: 40,
      signing: config.signing, tickMs: 1 })).toThrow(/real-time profile/i);
  });

  it("rejects report bytes, journal events, AgentTrail projections, or archives changed after signing", async () => {
    const { root, config } = fixture("process", "digest-verification");
    const result = await runSoakHarness({ root, config });
    const original = readFileSync(result.reportPath);
    const parsed = JSON.parse(original.toString("utf8"));
    parsed.samples.rssMaximumBytes += 1;
    writeFileSync(result.reportPath, `${JSON.stringify(parsed)}\n`);
    expect(await verifySoakReport(result.reportPath, { root,
      trustedPublicKeySha256: config.signing.trustedPublicKeySha256 })).toBe(false);
    writeFileSync(result.reportPath, original);

    const report = JSON.parse(original.toString("utf8"));
    const agentTrailRelative = Object.keys(report.evidenceFiles).find((name) => name.includes("agenttrail"))!;
    const agentTrailPath = path.join(root, agentTrailRelative);
    const agentTrail = readFileSync(agentTrailPath);
    writeFileSync(agentTrailPath, Buffer.concat([agentTrail, Buffer.from(" ")]));
    expect(await verifySoakReport(result.reportPath, { root,
      trustedPublicKeySha256: config.signing.trustedPublicKeySha256 })).toBe(false);
    writeFileSync(agentTrailPath, agentTrail);

    const archiveRoot = `${result.databasePath}.archives`;
    const segmentName = readdirSync(archiveRoot).find((name) => name.endsWith(".events.jsonl"))!;
    const segmentPath = path.join(archiveRoot, segmentName);
    const segment = readFileSync(segmentPath);
    chmodSync(segmentPath, 0o600); writeFileSync(segmentPath, Buffer.concat([segment, Buffer.from(" ")])); chmodSync(segmentPath, 0o400);
    expect(await verifySoakReport(result.reportPath, { root,
      trustedPublicKeySha256: config.signing.trustedPublicKeySha256 })).toBe(false);
    chmodSync(segmentPath, 0o600); writeFileSync(segmentPath, segment); chmodSync(segmentPath, 0o400);

    const journal = openAuthoritativeJournal(result.databasePath, "read-write");
    journal.append("tamper", 0, [{ streamId: "tamper", type: "tamper.event", payload: {},
      causationId: null, correlationId: "tamper" }]);
    journal.close();
    expect(await verifySoakReport(result.reportPath, { root,
      trustedPublicKeySha256: config.signing.trustedPublicKeySha256 })).toBe(false);
  }, 120_000);
});

async function runAbruptChild(args: readonly string[]): Promise<{ signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], { cwd: process.cwd(), shell: false,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "",
        LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("abrupt soak child timed out")); }, 180_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (_code, signal) => { clearTimeout(timer); resolve({ signal, stderr }); });
  });
}
