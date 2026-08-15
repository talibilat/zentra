import type { MilestoneBudget } from "../contracts/milestone.js";
import type { UntrustedEvidenceHandoff } from "../orchestration/untrusted-evidence-handoff.js";
import type { WriterPatchProposal } from "../contracts/writer-patch.js";
import type { WriterEventChain } from "../agents/writer-events.js";

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

export interface WriterUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly toolCalls: number;
}

export interface WriterDispatchBinding {
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

export interface PreparedWriterRequest {
  readonly binding: WriterDispatchBinding;
}

export interface WriterReport {
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
  readonly eventChain: WriterEventChain;
  readonly rawOutputPolicy: "not_retained";
  readonly protocolFailure: string | null;
  /** Transient process output. Callers must not journal or otherwise retain it. */
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly deniedToolRequests: readonly { readonly tool: string; readonly path: string | null }[];
  readonly usage: WriterUsage;
  readonly usageEvidence: string;
  readonly patchProposal: WriterPatchProposal | null;
  readonly dispatchBinding: WriterDispatchBinding;
}

export interface WriterRequest {
  readonly taskId: string;
  readonly executable: string;
  readonly model: import("../policy/model-sheet.js").ModelCapability;
  readonly workspace: import("../workspaces/worktree-manager.js").WorkspaceLease;
  readonly packet: WriterTaskPacket;
  readonly timeoutMs: number;
  readonly expectedExecutableSha256?: string;
  readonly home?: string;
  readonly capabilityEnvelope?: import("../workers/worker-lifecycle.js").CapabilityEnvelope;
  readonly dispatchAuthority?: {
    readonly dispatchId: string;
    readonly projectId: string;
    readonly claimId: string;
    readonly ownerId: string;
    readonly revision: string;
    readonly leaseToken: string;
  };
}

export interface HarnessWriter {
  prepare(request: WriterRequest): Promise<PreparedWriterRequest>;
  execute(prepared: PreparedWriterRequest, signal: AbortSignal): Promise<WriterReport>;
}
