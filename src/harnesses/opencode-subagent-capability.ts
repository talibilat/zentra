import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";

import { z } from "zod";

import { isAtomicEventJournal, type EventJournal } from "../journal/journal.js";
import type { WorkerAdapter, WorkerResult } from "../workers/worker-adapter.js";

export const NATIVE_SUBAGENT_CONTRACTS = [
  "parent_child_identity",
  "zentra_task_worker_incarnation_mapping",
  "authority_path_containment",
  "shared_budget_resource_accounting",
  "journal_agenttrail_attribution",
  "heartbeat_lte_60s",
  "cancellation_propagation",
  "process_descendant_cleanup",
  "restart_reconciliation",
  "canonical_terminal_outcome",
  "uncertain_effect_no_retry",
] as const;

const PROBE_DEFINITION = "zentra.opencode-native-subagents.v2" as const;
const SUPPORTED_VERSION = "1.18.3";
const SUPPORTED_SOURCE_REVISION = "127bdb30784d508cc556c71a0f32b508a3061517";
const MAX_EVIDENCE_BYTES = 65_536;
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const SourceRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const NativeSubagentContractSchema = z.enum(NATIVE_SUBAGENT_CONTRACTS);
const ObservationStatusSchema = z.enum(["supported", "not_observable", "unsupported"]);
const CommandOutcomeSchema = z.enum(["completed", "cancelled", "timed_out", "failed"]);

const ObservationSchema = z.strictObject({
  contract: NativeSubagentContractSchema,
  status: ObservationStatusSchema,
  evidenceRefs: z.array(z.string().min(1).max(256)).min(1).max(16),
  reason: z.string().min(1).max(512),
});
const CommandEvidenceSchema = z.strictObject({
  id: z.enum(["version", "root_help", "debug_help", "run_help", "pure_config", "agent_list",
    "build_agent", "general_agent", "explore_agent", "session_help", "serve_help"]),
  argv: z.array(z.string().max(256)).max(8),
  outcome: CommandOutcomeSchema,
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(MAX_EVIDENCE_BYTES),
  stderr: z.string().max(MAX_EVIDENCE_BYTES),
  stdoutBytes: z.number().int().nonnegative().max(MAX_EVIDENCE_BYTES),
  stderrBytes: z.number().int().nonnegative().max(MAX_EVIDENCE_BYTES),
  stdoutSha256: DigestSchema,
  stderrSha256: DigestSchema,
  truncated: z.boolean(),
});
const LegacySourceAttestationSchema = z.strictObject({
  repository: z.literal("https://github.com/anomalyco/opencode"),
  revision: SourceRevisionSchema,
  paths: z.tuple([
    z.literal("packages/opencode/src/tool/task.ts"),
    z.literal("packages/opencode/src/agent/subagent-permissions.ts"),
    z.literal("packages/opencode/src/session/session.ts"),
    z.literal("packages/opencode/src/cli/cmd/run.ts"),
  ]),
});
const SourceAttestationSchema = z.strictObject({
  repository: z.literal("https://github.com/anomalyco/opencode"),
  revision: SourceRevisionSchema,
  paths: z.tuple([
    z.literal("packages/opencode/src/tool/task.ts"),
    z.literal("packages/opencode/src/agent/subagent-permissions.ts"),
    z.literal("packages/opencode/src/session/session.ts"),
    z.literal("packages/opencode/src/cli/cmd/run.ts"),
    z.literal("packages/opencode/src/server/routes/instance/httpapi/groups/session.ts"),
  ]),
});

export interface NativeSubagentObservation extends z.infer<typeof ObservationSchema> {}
export interface OpenCodeCommandEvidence extends z.infer<typeof CommandEvidenceSchema> {}
export interface OpenCodeTrustedIdentity {
  readonly executable: string;
  readonly executableSha256: string;
  readonly version: string;
  readonly sourceRevision: string;
}
export interface NativeSubagentConformance {
  readonly observations: readonly NativeSubagentObservation[];
  readonly conformant: boolean;
  readonly toolsEnabled: boolean;
  readonly denialReasons: readonly string[];
}
export interface OpenCodeSubagentProbeRequest {
  readonly probeId: string;
  readonly projectId: string;
  readonly executable: string;
  readonly sourceRevision: string;
  readonly cwd: string;
  readonly home: string;
  readonly timeoutMs: number;
  readonly signingPrivateKey: KeyObject;
}

const LegacyUnsignedReportSchema = z.strictObject({
  schemaVersion: z.literal(2),
  probeDefinition: z.literal(PROBE_DEFINITION),
  provider: z.literal("opencode"),
  evidenceBasis: z.enum(["command_and_source_attestation", "identity_drift_observed", "identity_rejected", "fixture"]),
  probeId: IdSchema,
  projectId: IdSchema,
  executable: z.string().min(1).max(4_096),
  executableSha256: DigestSchema.nullable(),
  expectedExecutableSha256: DigestSchema,
  version: z.string().min(1).max(512).nullable(),
  expectedVersion: z.string().min(1).max(512),
  sourceRevision: SourceRevisionSchema,
  expectedSourceRevision: SourceRevisionSchema,
  sourceAttestation: LegacySourceAttestationSchema,
  commandEvidence: z.array(CommandEvidenceSchema).max(16),
  commandEvidenceSha256: DigestSchema,
  observations: z.array(ObservationSchema).length(NATIVE_SUBAGENT_CONTRACTS.length),
  lifecycleEndpoints: z.array(z.string().min(1).max(256)).max(32),
  conformant: z.boolean(),
  toolsEnabled: z.boolean(),
  denialReasons: z.array(z.string().min(1).max(256)).max(64),
  outcome: z.enum(["enabled", "denied"]),
  taskTool: z.enum(["allow", "deny"]),
  subagentTool: z.enum(["allow", "deny"]),
  measuredAt: z.string().datetime({ offset: true }),
  signerPublicKey: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  signerPublicKeySha256: DigestSchema,
});
const UnsignedReportSchema = z.strictObject({
  schemaVersion: z.literal(3),
  probeDefinition: z.literal(PROBE_DEFINITION),
  provider: z.literal("opencode"),
  evidenceBasis: z.enum(["command_and_source_attestation", "identity_drift_observed", "identity_rejected", "fixture"]),
  probeId: IdSchema,
  projectId: IdSchema,
  executable: z.string().min(1).max(4_096),
  expectedExecutable: z.string().min(1).max(4_096),
  executableSha256: DigestSchema.nullable(),
  expectedExecutableSha256: DigestSchema,
  version: z.string().min(1).max(512).nullable(),
  expectedVersion: z.string().min(1).max(512),
  sourceRevision: SourceRevisionSchema,
  expectedSourceRevision: SourceRevisionSchema,
  sourceAttestation: SourceAttestationSchema,
  commandEvidence: z.array(CommandEvidenceSchema).max(16),
  commandEvidenceSha256: DigestSchema,
  observations: z.array(ObservationSchema).length(NATIVE_SUBAGENT_CONTRACTS.length),
  lifecycleEndpoints: z.array(z.string().min(1).max(256)).max(32),
  conformant: z.boolean(),
  toolsEnabled: z.boolean(),
  denialReasons: z.array(z.string().min(1).max(256)).max(64),
  capability: z.literal("denied"),
  classification: z.enum(["version_drift", "source_revision_drift", "identity_mismatch", "capability_nonconformance"]),
  outcome: z.enum(["enabled", "denied"]),
  taskTool: z.enum(["allow", "deny"]),
  subagentTool: z.enum(["allow", "deny"]),
  measuredAt: z.string().datetime({ offset: true }),
  signerPublicKey: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  signerPublicKeySha256: DigestSchema,
});
const LegacyReportSchema = LegacyUnsignedReportSchema.extend({
  reportSha256: DigestSchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
const CurrentReportSchema = UnsignedReportSchema.extend({
  reportSha256: DigestSchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
const ReportSchema = z.discriminatedUnion("schemaVersion", [LegacyReportSchema, CurrentReportSchema]);
export type OpenCodeSubagentProbeReport = z.infer<typeof ReportSchema>;
type UnsignedReport = z.infer<typeof UnsignedReportSchema>;

const COMMANDS = [
  ["version", ["--version"]],
  ["root_help", ["--help"]],
  ["debug_help", ["debug", "--help"]],
  ["run_help", ["run", "--help"]],
  ["pure_config", ["--pure", "debug", "config"]],
  ["agent_list", ["--pure", "agent", "list"]],
  ["build_agent", ["--pure", "debug", "agent", "build"]],
  ["general_agent", ["--pure", "debug", "agent", "general"]],
  ["explore_agent", ["--pure", "debug", "agent", "explore"]],
  ["session_help", ["session", "--help"]],
  ["serve_help", ["serve", "--help"]],
] as const;

export class OpenCodeSubagentCapabilityProbe {
  private readonly trusted: OpenCodeTrustedIdentity;

  constructor(private readonly supervisor: WorkerAdapter, trusted: OpenCodeTrustedIdentity) {
    this.trusted = {
      executable: canonicalExecutable(trusted.executable),
      executableSha256: DigestSchema.parse(trusted.executableSha256),
      version: validIdentityVersion(trusted.version),
      sourceRevision: SourceRevisionSchema.parse(trusted.sourceRevision),
    };
  }

  static sha256(filePath: string): Promise<string> { return sha256File(filePath); }

  async run(request: OpenCodeSubagentProbeRequest, signal: AbortSignal): Promise<z.infer<typeof CurrentReportSchema>> {
    const probeId = IdSchema.parse(request.probeId);
    const projectId = IdSchema.parse(request.projectId);
    const sourceRevision = SourceRevisionSchema.parse(request.sourceRevision);
    const privateKey = assertPrivateSigningKey(request.signingPrivateKey);
    const sourceAttestation = sourceEvidence(sourceRevision);
    const denialReasons: string[] = [];
    let executableSha256: string | null = null;
    let version: string | null = null;
    let evidenceItems: readonly OpenCodeCommandEvidence[] = [];
    let evidenceBasis: UnsignedReport["evidenceBasis"] = "identity_rejected";

    let canonicalExecutableValid = false;
    let executableIdentityValid = false;
    try {
      const executable = canonicalExecutable(request.executable);
      canonicalExecutableValid = executable === this.trusted.executable;
      if (!canonicalExecutableValid) denialReasons.push("executable_identity_mismatch");
      if (canonicalExecutableValid) {
        executableSha256 = await sha256File(executable);
        executableIdentityValid = executableSha256 === this.trusted.executableSha256;
        if (!executableIdentityValid) denialReasons.push("executable_digest_drift");
      }
    } catch {
      denialReasons.push("executable_identity_mismatch");
    }
    if (sourceRevision !== this.trusted.sourceRevision) denialReasons.push("source_revision_drift");

    if (canonicalExecutableValid) {
      const cwd = canonicalDirectory(request.cwd);
      const home = canonicalDirectory(request.home);
      const measured: OpenCodeCommandEvidence[] = [];
      const commands = executableIdentityValid && sourceRevision === this.trusted.sourceRevision
        ? COMMANDS : COMMANDS.slice(0, 1);
      for (const [id, argv] of commands) {
        const result = await this.supervisor.execute({ taskId: `opencode-native-subagent-probe-v2-${id}`,
          executable: this.trusted.executable, args: argv, cwd, timeoutMs: request.timeoutMs,
          environment: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" } }, signal, "validation");
        measured.push(buildCommandEvidence(id, argv, result));
      }
      evidenceItems = Object.freeze(measured);
      evidenceBasis = executableIdentityValid && sourceRevision === this.trusted.sourceRevision
        ? "command_and_source_attestation" : "identity_drift_observed";
      const after = await sha256File(this.trusted.executable);
      if (after !== executableSha256) denialReasons.push("executable_changed_during_probe");
      const versionEvidence = measured[0]!;
      if (versionEvidence.outcome === "completed" && versionEvidence.exitCode === 0 && versionEvidence.stderr === "") {
        try { version = exactVersion(versionEvidence.stdout); } catch { denialReasons.push("version_evidence_invalid"); }
      } else denialReasons.push("version_probe_failed");
      if (version !== this.trusted.version) denialReasons.push("version_drift");
      if (measured.some((item) => item.outcome !== "completed" || item.exitCode !== 0 || item.truncated)) {
        denialReasons.push("capability_evidence_incomplete");
      }
      if (evidenceBasis === "command_and_source_attestation") validatePureConfiguration(measured, denialReasons);
    }

    if (this.trusted.version !== SUPPORTED_VERSION) denialReasons.push("unsupported_version");
    if (this.trusted.sourceRevision !== SUPPORTED_SOURCE_REVISION) denialReasons.push("unsupported_source_revision");
    const observations = evidenceBasis === "command_and_source_attestation"
      ? supportedSourceObservations() : unavailableObservations();
    const evaluated = evaluateConformance(observations);
    denialReasons.push(...evaluated.denialReasons);
    const toolsEnabled = evaluated.conformant && denialReasons.length === 0;
    const uniqueDenialReasons = [...new Set(denialReasons)];
    return signedReport({ schemaVersion: 3, probeDefinition: PROBE_DEFINITION, provider: "opencode", evidenceBasis,
      probeId, projectId, executable: request.executable, expectedExecutable: this.trusted.executable, executableSha256,
      expectedExecutableSha256: this.trusted.executableSha256, version, expectedVersion: this.trusted.version,
      sourceRevision, expectedSourceRevision: this.trusted.sourceRevision, sourceAttestation,
      commandEvidence: [...evidenceItems], commandEvidenceSha256: digestJson(evidenceItems), observations: [...observations],
      lifecycleEndpoints: [], conformant: evaluated.conformant, toolsEnabled,
      denialReasons: uniqueDenialReasons, capability: "denied", classification: classifyDenial(uniqueDenialReasons),
      outcome: toolsEnabled ? "enabled" : "denied",
      taskTool: toolsEnabled ? "allow" : "deny", subagentTool: toolsEnabled ? "allow" : "deny",
      measuredAt: new Date().toISOString(), ...publicSigningIdentity(privateKey) }, privateKey);
  }
}

export function evaluateNativeSubagentConformance(raw: unknown, origin: "measured" | "fixture"): NativeSubagentConformance {
  const observations = z.array(ObservationSchema).length(NATIVE_SUBAGENT_CONTRACTS.length).parse(raw);
  const result = evaluateConformance(observations);
  if (origin === "measured") return result;
  return Object.freeze({ ...result, toolsEnabled: false,
    denialReasons: Object.freeze([...result.denialReasons, "fixture_evidence_not_enablement_eligible"]) });
}

export function createFixtureSubagentProbeReport(input: { readonly probeId: string; readonly projectId: string;
  readonly signingPrivateKey: KeyObject; readonly state: "conformant" | "denied" }): z.infer<typeof CurrentReportSchema> {
  const privateKey = assertPrivateSigningKey(input.signingPrivateKey);
  const observations = NATIVE_SUBAGENT_CONTRACTS.map((contract, index): NativeSubagentObservation => ({ contract,
    status: input.state === "denied" && index === 1 ? "unsupported" : "supported",
    evidenceRefs: ["fixture:evidence"], reason: "Fixture-only contract evidence." }));
  const evaluated = evaluateNativeSubagentConformance(observations, "fixture");
  return signedReport({ schemaVersion: 3, probeDefinition: PROBE_DEFINITION, provider: "opencode",
    evidenceBasis: "fixture", probeId: IdSchema.parse(input.probeId), projectId: IdSchema.parse(input.projectId),
    executable: "/fixture/opencode", expectedExecutable: "/fixture/opencode",
    executableSha256: "a".repeat(64), expectedExecutableSha256: "a".repeat(64),
    version: SUPPORTED_VERSION, expectedVersion: SUPPORTED_VERSION, sourceRevision: SUPPORTED_SOURCE_REVISION,
    expectedSourceRevision: SUPPORTED_SOURCE_REVISION, sourceAttestation: sourceEvidence(SUPPORTED_SOURCE_REVISION),
    commandEvidence: [], commandEvidenceSha256: digestJson([]), observations,
    lifecycleEndpoints: [], conformant: evaluated.conformant, toolsEnabled: false,
    denialReasons: [...evaluated.denialReasons], capability: "denied", classification: "capability_nonconformance",
    outcome: "denied", taskTool: "deny", subagentTool: "deny",
    measuredAt: "2026-07-21T00:00:00.000Z", ...publicSigningIdentity(privateKey) }, privateKey);
}

export function publicKeySha256(key: KeyObject): string {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") throw new Error("signing key must be Ed25519");
  return createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex");
}

export function verifyOpenCodeSubagentProbeReport(report: unknown,
  trust: { readonly expectedPublicKeySha256: string }): boolean {
  try {
    const parsed = ReportSchema.parse(report);
    const trustedDigest = DigestSchema.parse(trust.expectedPublicKeySha256);
    if (parsed.signerPublicKeySha256 !== trustedDigest) return false;
    const keyDer = Buffer.from(parsed.signerPublicKey, "base64");
    if (createHash("sha256").update(keyDer).digest("hex") !== trustedDigest) return false;
    const unsigned = unsignedReport(parsed);
    const digest = digestJson(unsigned);
    if (digest !== parsed.reportSha256 || parsed.commandEvidenceSha256 !== digestJson(parsed.commandEvidence)) return false;
    for (const item of parsed.commandEvidence) {
      if (item.stdoutBytes !== Buffer.byteLength(item.stdout) || item.stderrBytes !== Buffer.byteLength(item.stderr) ||
        item.stdoutSha256 !== sha256Text(item.stdout) || item.stderrSha256 !== sha256Text(item.stderr)) return false;
    }
    return verify(null, Buffer.from(digest, "hex"), { key: keyDer, format: "der", type: "spki" },
      Buffer.from(parsed.signature, "base64"));
  } catch { return false; }
}

export class OpenCodeSubagentConformanceJournal {
  private readonly trusted: ReadonlySet<string>;
  constructor(private readonly journal: EventJournal, trust: { readonly trustedPublicKeySha256: readonly string[] }) {
    this.trusted = new Set(trust.trustedPublicKeySha256.map((item) => DigestSchema.parse(item)));
    if (this.trusted.size === 0) throw new Error("native subagent probe requires a trusted signing key");
  }

  record(probeId: string, projectId: string, rawReport: unknown, correlationId: string): void {
    const report = ReportSchema.parse(rawReport);
    if (report.probeId !== probeId || report.projectId !== projectId) throw new Error("native subagent report identity mismatch");
    if (!this.trusted.has(report.signerPublicKeySha256) || !verifyOpenCodeSubagentProbeReport(report,
      { expectedPublicKeySha256: report.signerPublicKeySha256 })) throw new Error("native subagent report lacks a trusted signature");
    if (report.toolsEnabled || report.outcome === "enabled" || report.taskTool !== "deny" || report.subagentTool !== "deny") {
      throw new Error("native subagent enablement lacks an eligible conformant provider");
    }
    const streamId = `subagent-probe:${probeId}`;
    const payload = OpenCodeSubagentProbeEventPayloadSchema.parse({ schemaVersion: report.schemaVersion, probeId, projectId,
      reportSha256: report.reportSha256, signerPublicKeySha256: report.signerPublicKeySha256,
      outcome: report.outcome, failedContracts: report.observations.filter((item) => item.status !== "supported")
        .map((item) => item.contract), report });
    const existing = this.journal.readStream(streamId);
    if (existing.length !== 0) {
      const exact = existing.length === 2 && existing[0]?.type === "subagent.capability_probe_observed" &&
        existing[1]?.type === "subagent.capability_denied" && existing.every((event) =>
          event.correlationId === correlationId && digestJson(event.payload) === digestJson(payload));
      if (exact) return;
      throw new Error("recorded native subagent probe does not match the signed report retry");
    }
    if (!isAtomicEventJournal(this.journal)) throw new Error("native subagent denial requires an atomic event journal");
    this.journal.appendAtomically([{ streamId, expectedVersion: 0, events: [
      { streamId, type: "subagent.capability_probe_observed", payload, causationId: null, correlationId },
      { streamId, type: "subagent.capability_denied", payload, causationId: null, correlationId },
    ] }]);
  }
}

const LegacyOpenCodeSubagentProbeEventPayloadSchema = z.strictObject({
  schemaVersion: z.literal(2), probeId: IdSchema, projectId: IdSchema, reportSha256: DigestSchema,
  signerPublicKeySha256: DigestSchema, outcome: z.literal("denied"),
  failedContracts: z.array(NativeSubagentContractSchema), report: LegacyReportSchema,
}).superRefine((payload, context) => {
  if (payload.report.probeId !== payload.probeId || payload.report.projectId !== payload.projectId ||
    payload.report.reportSha256 !== payload.reportSha256 ||
    payload.report.signerPublicKeySha256 !== payload.signerPublicKeySha256) {
    context.addIssue({ code: "custom", message: "subagent probe event does not match its signed report" });
  }
});
const CurrentOpenCodeSubagentProbeEventPayloadSchema = z.strictObject({
  schemaVersion: z.literal(3), probeId: IdSchema, projectId: IdSchema, reportSha256: DigestSchema,
  signerPublicKeySha256: DigestSchema, outcome: z.literal("denied"),
  failedContracts: z.array(NativeSubagentContractSchema), report: CurrentReportSchema,
}).superRefine((payload, context) => {
  if (payload.report.probeId !== payload.probeId || payload.report.projectId !== payload.projectId ||
    payload.report.reportSha256 !== payload.reportSha256 ||
    payload.report.signerPublicKeySha256 !== payload.signerPublicKeySha256) {
    context.addIssue({ code: "custom", message: "subagent probe event does not match its signed report" });
  }
});
export const OpenCodeSubagentProbeEventPayloadSchema = z.union([
  LegacyOpenCodeSubagentProbeEventPayloadSchema,
  CurrentOpenCodeSubagentProbeEventPayloadSchema,
]);

export function projectOpenCodeSubagentDenial(payload: unknown): Readonly<Record<string, unknown>> {
  const parsed = OpenCodeSubagentProbeEventPayloadSchema.parse(payload);
  const report = parsed.report;
  const legacy = report.schemaVersion === 2;
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    reportSchemaVersion: report.schemaVersion,
    evidenceClassification: legacy ? "legacy_v2" : "current_v3",
    probeId: parsed.probeId,
    projectId: parsed.projectId,
    reportSha256: parsed.reportSha256,
    signerPublicKeySha256: parsed.signerPublicKeySha256,
    probeDefinition: report.probeDefinition,
    provider: report.provider,
    evidenceBasis: report.evidenceBasis,
    capability: "denied",
    classification: report.schemaVersion === 2 ? "legacy_retained_denial" : report.classification,
    expectedExecutable: report.schemaVersion === 2 ? null : report.expectedExecutable,
    expectedExecutableSha256: report.expectedExecutableSha256,
    expectedVersion: report.expectedVersion,
    expectedSourceRevision: report.expectedSourceRevision,
    version: report.version,
    executableSha256: report.executableSha256,
    sourceRevision: report.sourceRevision,
    commandEvidenceSha256: report.commandEvidenceSha256,
    outcome: parsed.outcome,
    taskTool: report.taskTool,
    subagentTool: report.subagentTool,
    conformant: report.conformant,
    toolsEnabled: report.toolsEnabled,
    failedContracts: parsed.failedContracts,
    measuredAt: report.measuredAt,
  });
}

function supportedSourceObservations(): readonly NativeSubagentObservation[] {
  return Object.freeze([
    observation("parent_child_identity", "supported", ["source:task.ts", "source:session.ts"],
      "Source-attested child sessions carry parentID and Task metadata carries parent and child session IDs."),
    observation("zentra_task_worker_incarnation_mapping", "unsupported", ["source:task.ts"],
      "The Task protocol has no Zentra task, worker, or process-incarnation fields."),
    observation("authority_path_containment", "unsupported", ["command:build_agent", "command:agent_list", "source:subagent-permissions.ts"],
      "OpenCode session permissions are not a Zentra authority or path-claim binding."),
    observation("shared_budget_resource_accounting", "unsupported", ["source:session.ts", "source:task.ts"],
      "Session usage is not an enforceable shared parent and child Zentra budget."),
    observation("journal_agenttrail_attribution", "not_observable", ["command:run_help", "source:run.ts"],
      "Root JSON output does not expose a complete attributed child lifecycle."),
    observation("heartbeat_lte_60s", "unsupported", ["command:debug_help", "source:task.ts"],
      "No native child heartbeat contract is exposed."),
    observation("cancellation_propagation", "not_observable", ["source:task.ts"],
      "Foreground cancellation exists, but no stable parent cancellation proof covers every background child."),
    observation("process_descendant_cleanup", "not_observable", ["command:debug_help", "source:task.ts"],
      "No process-group or descendant-absence evidence is exposed."),
    observation("restart_reconciliation", "unsupported", ["command:run_help", "source:task.ts"],
      "Session resume is not a Zentra effect reconciliation protocol."),
    observation("canonical_terminal_outcome", "unsupported", ["source:task.ts"],
      "Native task states do not map to exactly one Zentra canonical terminal outcome."),
    observation("uncertain_effect_no_retry", "unsupported", ["source:task.ts"],
      "No native uncertain-effect no-retry contract is exposed."),
  ]);
}

function unavailableObservations(): readonly NativeSubagentObservation[] {
  return Object.freeze(NATIVE_SUBAGENT_CONTRACTS.map((contract) => observation(contract, "not_observable",
    ["attestation:identity_rejected"], "Provider lifecycle was not probed because exact identity attestation failed.")));
}

function observation(contract: typeof NATIVE_SUBAGENT_CONTRACTS[number], status: z.infer<typeof ObservationStatusSchema>,
  evidenceRefs: readonly string[], reason: string): NativeSubagentObservation {
  return ObservationSchema.parse({ contract, status, evidenceRefs, reason });
}

function evaluateConformance(observations: readonly NativeSubagentObservation[]): NativeSubagentConformance {
  const parsed = z.array(ObservationSchema).length(NATIVE_SUBAGENT_CONTRACTS.length).parse(observations);
  if (parsed.some((item, index) => item.contract !== NATIVE_SUBAGENT_CONTRACTS[index])) {
    throw new Error("native subagent observations must follow the complete canonical contract order");
  }
  const denialReasons = parsed.filter((item) => item.status !== "supported")
    .map((item) => `contract_${item.status}:${item.contract}`);
  const conformant = denialReasons.length === 0;
  return Object.freeze({ observations: Object.freeze(parsed), conformant, toolsEnabled: conformant,
    denialReasons: Object.freeze(denialReasons) });
}

function classifyDenial(reasons: readonly string[]): UnsignedReport["classification"] {
  if (reasons.includes("version_drift")) return "version_drift";
  if (reasons.includes("source_revision_drift")) return "source_revision_drift";
  if (reasons.some((reason) => reason === "executable_identity_mismatch" || reason === "executable_digest_drift")) {
    return "identity_mismatch";
  }
  return "capability_nonconformance";
}

function buildCommandEvidence(id: typeof COMMANDS[number][0], argv: readonly string[], result: WorkerResult): OpenCodeCommandEvidence {
  const stdoutFull = result.rawStdout;
  const stderrFull = result.stderr;
  const stdout = boundedText(stdoutFull);
  const stderr = boundedText(stderrFull);
  return CommandEvidenceSchema.parse({ id, argv: [...argv], outcome: result.outcome, exitCode: result.exitCode,
    stdout, stderr, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    stdoutSha256: sha256Text(stdout), stderrSha256: sha256Text(stderr),
    truncated: stdout !== stdoutFull || stderr !== stderrFull });
}

function boundedText(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_EVIDENCE_BYTES) return value;
  return bytes.subarray(0, MAX_EVIDENCE_BYTES).toString("utf8").replace(/\uFFFD$/, "");
}

function validatePureConfiguration(evidence: readonly OpenCodeCommandEvidence[], denialReasons: string[]): void {
  const config = evidence.find((item) => item.id === "pure_config");
  if (config?.outcome !== "completed") return;
  try {
    const parsed = JSON.parse(config.stdout) as { readonly plugin?: unknown };
    if (!Array.isArray(parsed.plugin) || parsed.plugin.length !== 0) denialReasons.push("pure_configuration_invalid");
  } catch { denialReasons.push("pure_configuration_invalid"); }
}

function sourceEvidence(revision: string): z.infer<typeof SourceAttestationSchema> {
  return SourceAttestationSchema.parse({ repository: "https://github.com/anomalyco/opencode", revision,
    paths: ["packages/opencode/src/tool/task.ts", "packages/opencode/src/agent/subagent-permissions.ts",
      "packages/opencode/src/session/session.ts", "packages/opencode/src/cli/cmd/run.ts",
      "packages/opencode/src/server/routes/instance/httpapi/groups/session.ts"] });
}

function publicSigningIdentity(privateKey: KeyObject): Pick<UnsignedReport, "signerPublicKey" | "signerPublicKeySha256"> {
  const publicKey = createPublicKey(privateKey);
  return { signerPublicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    signerPublicKeySha256: publicKeySha256(publicKey) };
}

function signedReport(raw: UnsignedReport, privateKey: KeyObject): z.infer<typeof CurrentReportSchema> {
  const unsigned = UnsignedReportSchema.parse(raw);
  const reportSha256 = digestJson(unsigned);
  return Object.freeze(CurrentReportSchema.parse({ ...unsigned, reportSha256,
    signature: sign(null, Buffer.from(reportSha256, "hex"), privateKey).toString("base64") }));
}

function unsignedReport(report: OpenCodeSubagentProbeReport): UnsignedReport | z.infer<typeof LegacyUnsignedReportSchema> {
  const { reportSha256: _digest, signature: _signature, ...unsigned } = report;
  return report.schemaVersion === 2
    ? LegacyUnsignedReportSchema.parse(unsigned)
    : UnsignedReportSchema.parse(unsigned);
}

function assertPrivateSigningKey(key: KeyObject): KeyObject {
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new Error("operator signing key must be a private Ed25519 key");
  return key;
}

function exactVersion(stdout: string): string {
  const value = stdout.endsWith("\r\n") ? stdout.slice(0, -2) : stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  return validIdentityVersion(value);
}

function validIdentityVersion(value: string): string {
  if (value.length === 0 || Buffer.byteLength(value) > 512 || /[\r\n\u0000-\u001f\u007f]/.test(value)) throw new Error("invalid version identity");
  return value;
}

function canonicalExecutable(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  const stat = statSync(canonical);
  if (candidate !== canonical || !stat.isFile() || (stat.mode & 0o111) === 0 || stat.size > 512 * 1024 * 1024) throw new Error("invalid executable");
  return canonical;
}

function canonicalDirectory(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  if (candidate !== canonical || !statSync(canonical).isDirectory()) throw new Error("invalid directory");
  return canonical;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sha256Text(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function digestJson(value: unknown): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
