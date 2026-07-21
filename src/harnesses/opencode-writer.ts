import { createHash, randomUUID } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";

import type { MilestoneBudget } from "../contracts/milestone.js";
import type { ModelCapability } from "../policy/model-sheet.js";
import type { WorkerAdapter, WorkerResult } from "../workers/worker-adapter.js";
import type { WorkspaceLease } from "../workspaces/worktree-manager.js";
import type { UntrustedEvidenceHandoff } from "../orchestration/untrusted-evidence-handoff.js";
import { OpenCodeWorkerEventAdapter } from "../agents/opencode-worker-event-adapter.js";
import { createOpenCodeWriterEventChain, type OpenCodeWriterEventChain } from "../agents/opencode-writer-events.js";
import {
  CapabilityEnvelopeSchema,
  envelopeReadPaths,
  envelopeWritePaths,
  type CapabilityEnvelope,
} from "../workers/worker-lifecycle.js";
import { extractWriterPatchProposal, type WriterPatchProposal } from "../contracts/writer-patch.js";

export interface WriterTaskPacket {
  readonly brief: string;
  readonly guidance?: UntrustedEvidenceHandoff;
  readonly baseRevisionSha256?: string;
  readonly ownedPaths: readonly string[];
  readonly potentialWritePaths?: readonly string[];
  readonly pathClaim?: {
    readonly claimId: string;
    readonly revision: string;
    readonly expiresAt: string;
  };
  readonly readPaths?: readonly string[];
  readonly writePaths?: readonly string[];
  readonly toolPermissions?: readonly string[];
  readonly capabilityEnvelopeDigest?: string;
  readonly forbiddenPaths: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly patchProtocol: {
    readonly mode: "proposal_only";
    readonly maxOperations: 256;
    readonly maxBytes: 1048576;
    readonly mutationTools: "denied";
  };
  readonly budget: MilestoneBudget;
  readonly securityBoundary: {
    readonly repositoryWrites: "assigned_worktree_only";
    readonly validationAuthority: "zentra_named_validations_only";
    readonly integrationAuthority: "none";
    readonly shellAuthority: "none";
    readonly modelToolNetwork: "denied";
    readonly harnessProviderTransport: "user_os_network_authority";
    readonly parentSecretInheritance: "denied";
    readonly runtimeIsolation: "trusted_project_policy_not_os_sandbox";
  };
}

export interface OpenCodeWriterRequest {
  readonly taskId: string;
  readonly executable: string;
  readonly model: ModelCapability;
  readonly workspace: WorkspaceLease;
  readonly packet: WriterTaskPacket;
  readonly timeoutMs: number;
  readonly expectedExecutableSha256?: string;
  readonly home?: string;
  readonly capabilityEnvelope?: CapabilityEnvelope;
  readonly dispatchAuthority?: {
    readonly dispatchId: string;
    readonly projectId: string;
    readonly claimId: string;
    readonly ownerId: string;
    readonly revision: string;
    readonly leaseToken: string;
  };
}

export interface OpenCodeWriterReport {
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
  readonly exitCode: number | null;
  readonly executable: string;
  readonly modelId: string;
  readonly requestedModelSha256: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly packetSha256: string;
  readonly networkBoundary: {
    readonly modelTools: "denied";
    readonly harnessProviderTransport: "user_os_network_authority";
  };
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly eventChain: OpenCodeWriterEventChain;
  readonly rawOutputPolicy: "not_retained";
  readonly protocolFailure: "invalid_native_event_stream" | null;
  /** Transient process output. Callers must not journal or otherwise retain it. */
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly deniedToolRequests: readonly { readonly tool: string; readonly path: string | null }[];
  readonly usage: OpenCodeWriterUsage;
  readonly usageEvidence: "native_tokens" | "legacy_usage" | "none";
  readonly patchProposal: WriterPatchProposal | null;
  readonly dispatchBinding: OpenCodeWriterDispatchBinding;
}

export interface OpenCodeWriterUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly toolCalls: number;
}

export interface OpenCodeWriterDispatchBinding {
  readonly schemaVersion: 1;
  readonly processIncarnation: string;
  readonly executableSha256: string;
  readonly argvSha256: string;
  readonly packetSha256: string;
  readonly cwdSha256: string;
  readonly dispatchId: string | null;
  readonly projectId: string | null;
  readonly claimId: string | null;
  readonly ownerId: string | null;
  readonly revision: string | null;
  readonly leaseToken: string | null;
  readonly digest: string;
}

export interface PreparedOpenCodeWriterRequest {
  readonly binding: OpenCodeWriterDispatchBinding;
}

interface InternalPreparedOpenCodeWriterRequest extends PreparedOpenCodeWriterRequest {
  readonly request: OpenCodeWriterRequest;
  readonly executable: string;
  readonly cwd: string;
  readonly packet: string;
  readonly argv: readonly string[];
}

const preparedRequests = new WeakSet<object>();
const supervisedReports = new WeakMap<object, string>();

export class OpenCodeWriter {
  constructor(private readonly supervisor: WorkerAdapter) {}

  async prepare(request: OpenCodeWriterRequest): Promise<PreparedOpenCodeWriterRequest> {
    const executable = canonicalExecutable(request.executable);
    const executableSha256 = await sha256File(executable);
    if (request.expectedExecutableSha256 !== undefined && executableSha256 !== request.expectedExecutableSha256) {
      throw new Error("OpenCode writer executable changed after capability probe");
    }
    const cwd = canonicalDirectory(request.workspace.path);
    if (cwd !== request.workspace.path) throw new Error("OpenCode writer workspace must be canonical");
    const packet = JSON.stringify(request.packet);
    assertCapabilityPacket(request);
    const argv = [
      "--pure",
      "run",
      "--format",
      "json",
      "--model",
      request.model.model,
      "--agent",
      "zentra-writer",
      "--dir",
      cwd,
      packet,
    ] as const;
    const bindingBody = {
      schemaVersion: 1 as const,
      processIncarnation: randomUUID(),
      executableSha256,
      argvSha256: sha256(JSON.stringify(argv)),
      packetSha256: sha256(packet),
      cwdSha256: sha256(cwd),
      dispatchId: request.dispatchAuthority?.dispatchId ?? null,
      projectId: request.dispatchAuthority?.projectId ?? null,
      claimId: request.dispatchAuthority?.claimId ?? null,
      ownerId: request.dispatchAuthority?.ownerId ?? null,
      revision: request.dispatchAuthority?.revision ?? null,
      leaseToken: request.dispatchAuthority?.leaseToken ?? null,
    };
    const prepared: InternalPreparedOpenCodeWriterRequest = Object.freeze({
      request, executable, cwd, packet, argv,
      binding: Object.freeze({ ...bindingBody, digest: sha256(JSON.stringify(bindingBody)) }),
    });
    preparedRequests.add(prepared);
    return prepared;
  }

  async execute(
    rawPrepared: PreparedOpenCodeWriterRequest,
    signal: AbortSignal,
  ): Promise<OpenCodeWriterReport> {
    if (!preparedRequests.has(rawPrepared)) throw new Error("OpenCode writer request was not prepared by this trusted adapter");
    preparedRequests.delete(rawPrepared);
    const prepared = rawPrepared as InternalPreparedOpenCodeWriterRequest;
    const { request, executable, cwd, packet, argv } = prepared;
    const startedAt = new Date().toISOString();
    const result = await this.supervisor.execute({
      taskId: request.taskId,
      executable,
      args: argv,
      cwd,
      timeoutMs: request.timeoutMs,
      environment: {
        ...(request.home === undefined ? {} : { HOME: canonicalDirectory(request.home) }),
        OPENCODE_CONFIG_CONTENT: writerConfiguration(request.model, request.packet),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      },
    }, signal, "opencode_writer");
    let eventChain: OpenCodeWriterEventChain;
    let protocolFailure = false;
    try {
      eventChain = createOpenCodeWriterEventChain(result.rawStdout, result.events);
      if (result.outcome === "completed") new OpenCodeWorkerEventAdapter().assertSupportedTopLevelEvents(result.events);
    } catch {
      eventChain = createOpenCodeWriterEventChain(result.rawStdout, []);
      protocolFailure = true;
    }
    const completed = report(
      request, executable, cwd, argv, packet, result, eventChain, protocolFailure, startedAt, prepared.binding,
    );
    supervisedReports.set(completed, prepared.binding.digest);
    return completed;
  }
}

export function isSupervisedOpenCodeWriterReport(
  report: OpenCodeWriterReport,
  binding: OpenCodeWriterDispatchBinding,
): boolean {
  return supervisedReports.get(report) === binding.digest && report.dispatchBinding.digest === binding.digest;
}

function report(
  request: OpenCodeWriterRequest,
  executable: string,
  cwd: string,
  argv: readonly string[],
  packet: string,
  result: WorkerResult,
  eventChain: OpenCodeWriterEventChain,
  protocolFailure: boolean,
  startedAt: string,
  dispatchBinding: OpenCodeWriterDispatchBinding,
): OpenCodeWriterReport {
  const usageEvidence = parseOpenCodeWriterUsageEvidence(protocolFailure ? [] : result.events);
  let patchProposal: WriterPatchProposal | null = null;
  let proposalInvalid = false;
  if (request.packet.pathClaim !== undefined && result.outcome === "completed") {
    try {
      patchProposal = extractWriterPatchProposal(result.events);
    } catch {
      proposalInvalid = true;
    }
  }
  return Object.freeze({
    outcome: (protocolFailure || proposalInvalid) && result.outcome === "completed" ? "failed" : result.outcome,
    exitCode: result.exitCode,
    executable,
    modelId: request.model.id,
    requestedModelSha256: sha256(request.model.model),
    argv: Object.freeze(redactedArgv(argv)),
    cwd,
    packetSha256: sha256(packet),
    networkBoundary: Object.freeze({
      modelTools: request.packet.securityBoundary.modelToolNetwork,
      harnessProviderTransport: request.packet.securityBoundary.harnessProviderTransport,
    }),
    stdoutSha256: eventChain.stdoutSha256,
    stderrSha256: sha256(result.stderr),
    eventChain,
    rawOutputPolicy: "not_retained",
    protocolFailure: protocolFailure ? "invalid_native_event_stream" : null,
    stdout: result.rawStdout,
    stderr: result.stderr,
    startedAt,
    finishedAt: new Date().toISOString(),
    deniedToolRequests: Object.freeze(protocolFailure ? [] : deniedToolRequests(result.events)),
    usage: Object.freeze(usageEvidence.usage),
    usageEvidence: usageEvidence.kind,
    patchProposal,
    dispatchBinding,
  });
}

function redactedArgv(argv: readonly string[]): readonly string[] {
  const retained = [...argv.slice(0, -1), "<writer-task-packet>"];
  const modelIndex = retained.indexOf("--model");
  if (modelIndex !== -1 && retained[modelIndex + 1] !== undefined) {
    retained[modelIndex + 1] = "<approved-model>";
  }
  return retained;
}

function writerConfiguration(model: ModelCapability, packet: WriterTaskPacket): string {
  const tools = new Set(packet.toolPermissions ?? ["read_repository", "write_worktree"]);
  const read = packet.readPaths === undefined ? "allow" : Object.fromEntries([
    ["*", "deny"],
    ...packet.readPaths.map((scope) => [scope, "allow"] as const),
    ...packet.forbiddenPaths.map((scope) => [scope, "deny"] as const),
  ]);
  const edit = "deny";
  return JSON.stringify({
    share: "disabled",
    autoupdate: false,
    formatter: false,
    lsp: false,
    mcp: {},
    plugin: [],
    instructions: [],
    model: model.model,
    default_agent: "zentra-writer",
    agent: {
      "zentra-writer": {
        mode: "primary",
        model: model.model,
        permission: {
          "*": "deny",
          read: tools.has("read_repository") ? read : "deny",
          glob: tools.has("read_repository") ? read : "deny",
          grep: tools.has("read_repository") ? read : "deny",
          edit: tools.has("write_worktree") ? edit : "deny",
          bash: "deny",
          task: "deny",
          webfetch: "deny",
          external_directory: "deny",
        },
      },
    },
  });
}

function assertCapabilityPacket(request: OpenCodeWriterRequest): void {
  if (request.packet.guidance !== undefined &&
    request.packet.baseRevisionSha256 !== request.packet.guidance.baseRevisionSha256) {
    throw new Error("OpenCode writer packet base does not match its guidance");
  }
  if (request.capabilityEnvelope === undefined) return;
  const envelope = CapabilityEnvelopeSchema.parse(request.capabilityEnvelope);
  const packetTools = [...(request.packet.toolPermissions ?? [])].sort();
  const packetWrites = [...(request.packet.writePaths ?? [])];
  const envelopeWrites = envelopeWritePaths(envelope);
  if (
    request.packet.capabilityEnvelopeDigest !== envelope.digest ||
    JSON.stringify(packetTools) !== JSON.stringify([...envelope.capabilities].sort()) ||
    JSON.stringify([...(request.packet.readPaths ?? [])]) !== JSON.stringify(envelopeReadPaths(envelope)) ||
    packetWrites.some((candidate) => !envelopeWrites.some((scope) => logicalScopeContains(scope, candidate))) ||
    (request.packet.pathClaim !== undefined &&
      JSON.stringify([...(request.packet.potentialWritePaths ?? [])]) !== JSON.stringify(envelopeWrites))
  ) throw new Error("OpenCode writer packet does not match the accepted capability envelope digest");
}

function logicalScopeContains(scope: string, candidate: string): boolean {
  const foldedScope = scope.normalize("NFD").toUpperCase().toLowerCase().normalize("NFD");
  const foldedCandidate = candidate.normalize("NFD").toUpperCase().toLowerCase().normalize("NFD");
  if (foldedScope === "**") return true;
  if (foldedScope.endsWith("/**")) {
    const base = foldedScope.slice(0, -3);
    return foldedCandidate === base || foldedCandidate.startsWith(`${base}/`);
  }
  return foldedCandidate === foldedScope;
}

function deniedToolRequests(events: readonly unknown[]): { readonly tool: string; readonly path: string | null }[] {
  const denied: { tool: string; path: string | null }[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
    const record = event as Readonly<Record<string, unknown>>;
    const part = typeof record["part"] === "object" && record["part"] !== null && !Array.isArray(record["part"])
      ? record["part"] as Readonly<Record<string, unknown>> : null;
    const status = record["status"] ?? part?.["status"];
    const type = record["type"] ?? part?.["type"];
    if (status !== "denied" && type !== "permission.denied" && type !== "tool.denied") continue;
    const tool = typeof record["tool"] === "string" ? record["tool"] : typeof part?.["tool"] === "string" ? part["tool"] : "unknown";
    const candidate = record["path"] ?? part?.["path"];
    denied.push({ tool, path: typeof candidate === "string" ? candidate : null });
  }
  return denied;
}

export function parseOpenCodeWriterUsage(events: readonly unknown[]): OpenCodeWriterUsage {
  return parseOpenCodeWriterUsageEvidence(events).usage;
}

function parseOpenCodeWriterUsageEvidence(events: readonly unknown[]): {
  readonly usage: OpenCodeWriterUsage;
  readonly kind: "native_tokens" | "legacy_usage" | "none";
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let toolCalls = 0;
  let evidenceKind: "native_tokens" | "legacy_usage" | "none" = "none";
  for (const event of events) {
    const record = typeof event === "object" && event !== null && !Array.isArray(event)
      ? event as Readonly<Record<string, unknown>> : {};
    const part = typeof record["part"] === "object" && record["part"] !== null && !Array.isArray(record["part"])
      ? record["part"] as Readonly<Record<string, unknown>> : {};
    if (isCompletedToolUse(record, part)) toolCalls += 1;
    const currentKind = eventUsageKind(record, part);
    if (currentKind !== "none") {
      if (evidenceKind !== "none" && evidenceKind !== currentKind) {
        throw new Error("OpenCode writer stream mixes alternate token usage schemas");
      }
      evidenceKind = currentKind;
    }
    const measured = eventTokenUsage(record, part);
    inputTokens = addTokenCount(inputTokens, measured.inputTokens, "input tokens");
    outputTokens = addTokenCount(outputTokens, measured.outputTokens, "output tokens");
    reasoningTokens = addTokenCount(reasoningTokens, measured.reasoningTokens, "reasoning tokens");
    cacheReadTokens = addTokenCount(cacheReadTokens, measured.cacheReadTokens, "cache read tokens");
    cacheWriteTokens = addTokenCount(cacheWriteTokens, measured.cacheWriteTokens, "cache write tokens");
  }
  if (!Number.isSafeInteger(toolCalls) || toolCalls > 100_000) throw new Error("OpenCode writer tool usage exceeds bounded range");
  return {
    usage: { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, toolCalls },
    kind: evidenceKind,
  };
}

function eventUsageKind(
  record: Readonly<Record<string, unknown>>,
  part: Readonly<Record<string, unknown>>,
): "native_tokens" | "legacy_usage" | "none" {
  const tokenSources = [record["tokens"], part["tokens"]].filter((value) => value !== undefined);
  const usageSources = [record["usage"], part["usage"]].filter((value) => value !== undefined);
  if (tokenSources.length > 1 || usageSources.length > 1 || (tokenSources.length > 0 && usageSources.length > 0)) {
    throw new Error("OpenCode writer event contains ambiguous token usage schemas");
  }
  return tokenSources.length === 1 ? "native_tokens" : usageSources.length === 1 ? "legacy_usage" : "none";
}

function isCompletedToolUse(
  record: Readonly<Record<string, unknown>>,
  part: Readonly<Record<string, unknown>>,
): boolean {
  const type = record["type"] ?? part["type"];
  const status = record["status"] ?? part["status"];
  return type === "tool_use" && status !== "denied" &&
    typeof (record["tool"] ?? part["tool"]) === "string";
}

function eventTokenUsage(
  record: Readonly<Record<string, unknown>>,
  part: Readonly<Record<string, unknown>>,
): Omit<OpenCodeWriterUsage, "toolCalls"> {
  const tokenSources = [record["tokens"], part["tokens"]].filter((value) => value !== undefined);
  const usageSources = [record["usage"], part["usage"]].filter((value) => value !== undefined);
  if (tokenSources.length > 1 || usageSources.length > 1 || (tokenSources.length > 0 && usageSources.length > 0)) {
    throw new Error("OpenCode writer event contains ambiguous token usage schemas");
  }
  if (tokenSources.length === 1) {
    const type = record["type"] ?? part["type"];
    if (type !== "step_finish" && type !== "step-finish") {
      throw new Error("OpenCode writer tokens are only valid on step_finish events");
    }
    const tokens = tokenRecord(tokenSources[0], "tokens");
    const cache = tokens["cache"] === undefined ? {} : tokenRecord(tokens["cache"], "tokens.cache");
    return {
      inputTokens: requiredTokenCount(tokens["input"], "tokens.input"),
      outputTokens: requiredTokenCount(tokens["output"], "tokens.output"),
      reasoningTokens: optionalTokenCount(tokens["reasoning"], "tokens.reasoning"),
      cacheReadTokens: optionalTokenCount(cache["read"], "tokens.cache.read"),
      cacheWriteTokens: optionalTokenCount(cache["write"], "tokens.cache.write"),
    };
  }
  if (usageSources.length === 1) {
    const usage = tokenRecord(usageSources[0], "usage");
    return {
      inputTokens: alternateTokenCount(usage, ["inputTokens", "input_tokens", "input"], "usage input"),
      outputTokens: alternateTokenCount(usage, ["outputTokens", "output_tokens", "output"], "usage output"),
      reasoningTokens: alternateOptionalTokenCount(usage, ["reasoningTokens", "reasoning_tokens", "reasoning"], "usage reasoning"),
      cacheReadTokens: alternateOptionalTokenCount(usage, ["cacheReadTokens", "cache_read_tokens"], "usage cache read"),
      cacheWriteTokens: alternateOptionalTokenCount(usage, ["cacheWriteTokens", "cache_write_tokens"], "usage cache write"),
    };
  }
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function tokenRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function requiredTokenCount(value: unknown, label: string): number {
  if (value === undefined) throw new Error(`${label} is required`);
  return checkedTokenCount(value, label);
}

function optionalTokenCount(value: unknown, label: string): number {
  return value === undefined ? 0 : checkedTokenCount(value, label);
}

function checkedTokenCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2_000_000) {
    throw new Error(`${label} must be a nonnegative bounded safe integer`);
  }
  return value;
}

function alternateTokenCount(record: Readonly<Record<string, unknown>>, keys: readonly string[], label: string): number {
  const present = keys.filter((key) => record[key] !== undefined);
  if (present.length !== 1) throw new Error(`${label} must use exactly one supported field`);
  return checkedTokenCount(record[present[0]!], `${label}.${present[0]}`);
}

function alternateOptionalTokenCount(record: Readonly<Record<string, unknown>>, keys: readonly string[], label: string): number {
  const present = keys.filter((key) => record[key] !== undefined);
  if (present.length > 1) throw new Error(`${label} uses ambiguous alternate fields`);
  return present.length === 0 ? 0 : checkedTokenCount(record[present[0]!], `${label}.${present[0]}`);
}

function addTokenCount(total: number, value: number, label: string): number {
  const next = total + value;
  if (!Number.isSafeInteger(next) || next > 2_000_000) throw new Error(`OpenCode writer ${label} exceed bounded aggregate`);
  return next;
}

function canonicalDirectory(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  if (!statSync(canonical).isDirectory()) throw new Error("OpenCode writer cwd must be a directory");
  return canonical;
}

function canonicalExecutable(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  const stat = statSync(canonical);
  if (candidate !== canonical || !stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error("OpenCode writer executable must be a canonical executable file");
  }
  return canonical;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
