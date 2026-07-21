import type {
  PodCharter,
  PodLease,
  PodParentGrant,
  PodWorkspaceLease,
} from "../../src/pods/pod-contracts.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";

export const budget = {
  maxSeconds: 600,
  maxRetries: 1,
  maxCostUsd: 5,
  maxInputTokens: 10_000,
  maxOutputTokens: 5_000,
  maxExternalEffects: 0 as const,
};

export const usage = { elapsedMs: 20_000, retries: 0, costUsd: 0.5, inputTokens: 100, outputTokens: 50,
  externalEffects: 0 as const };

export function charter(overrides: Partial<PodCharter> = {}): PodCharter {
  return {
    schemaVersion: 1,
    podId: "pod-1",
    projectId: "zentra",
    revision: 1,
    outcome: "Implement the pod aggregate.",
    sourceRefs: [{ kind: "ticket", value: "#97" }],
    tasks: [
      {
        milestoneId: "milestone-1", taskId: "research", title: "Research", dependencies: [],
        acceptanceCriteria: ["Evidence retained."], evidenceRequirements: ["research-report"],
      },
      {
        milestoneId: "milestone-1", taskId: "implement", title: "Implement",
        dependencies: [{ milestoneId: "milestone-1", taskId: "research" }],
        acceptanceCriteria: ["Focused tests pass."], evidenceRequirements: ["test-report"],
      },
    ],
    roles: [
      { roleId: "researcher", agentId: "agent-read", taskIds: ["research"] },
      { roleId: "implementer", agentId: "agent-write", taskIds: ["implement"] },
    ],
    requiredCapabilities: ["read_repository", "write_worktree"],
    ownership: { ownedPaths: ["src/pods/**", "tests/pods/**"], forbiddenPaths: ["refs/**"] },
    budget,
    checkpoints: [{ checkpointId: "focused", afterTaskIds: ["implement"], evidenceRequirements: ["test-report"] }],
    acceptanceCriteria: ["Pod state replays."],
    evidenceRequirements: ["test-report"],
    forbiddenChanges: ["shared integration refs"],
    securityBoundary: "Parent grants and leases are authoritative.",
    escalationConditions: ["uncertain effect"],
    completionRules: ["All tasks have canonical terminal projections."],
    cleanupRules: ["Preserve uncertain workspaces."],
    execution: { mode: "local_process", nativeSubagents: false, distributed: false },
    ...overrides,
  };
}

export function grant(overrides: Partial<PodParentGrant> = {}): PodParentGrant {
  return {
    schemaVersion: 1,
    grantId: "grant-1",
    parentAuthorityId: "run-1",
    podId: "pod-1",
    projectId: "zentra",
    repositoryPath: "/tmp/zentra-project",
    worktreeRoot: "/tmp/zentra-worktrees",
    charterRevision: 1,
    charterDigest: digestCanonical(charter()),
    agentIds: ["agent-read", "agent-write"],
    capabilities: ["read_repository", "write_worktree"],
    ownedPaths: ["src/pods/**", "tests/pods/**"],
    forbiddenPaths: ["refs/**"],
    budget,
    sharedIntegrationRefs: ["refs/heads/main", "refs/heads/zentra/integration"],
    issuedAt: "2026-07-20T10:00:00.000Z",
    expiresAt: "2026-07-20T12:00:00.000Z",
    executionMode: "local_process",
    nativeSubagents: false,
    distributed: false,
    ...overrides,
  };
}

export function lease(overrides: Partial<PodLease> = {}): PodLease {
  return {
    schemaVersion: 1,
    leaseId: "lease-1",
    grantId: "grant-1",
    podId: "pod-1",
    assignmentId: "assignment-1",
    workspaceLeaseId: "workspace-1",
    taskId: "implement",
    agentId: "agent-write",
    charterRevision: 1,
    capabilities: ["write_worktree"],
    ownedPaths: ["src/pods/**"],
    budget: { ...budget, maxSeconds: 300, maxRetries: 0, maxCostUsd: 2, maxInputTokens: 5_000, maxOutputTokens: 2_500 },
    issuedAt: "2026-07-20T10:00:00.000Z",
    expiresAt: "2026-07-20T11:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

export function workspaceLease(overrides: Partial<PodWorkspaceLease> = {}): PodWorkspaceLease {
  return {
    schemaVersion: 1, workspaceLeaseId: "workspace-1", podLeaseId: "lease-1", podId: "pod-1",
    projectId: "zentra", taskId: "implement", repositoryPath: "/tmp/zentra-project",
    path: "/tmp/zentra-worktrees/implement", branch: "refs/heads/ticket/implement", baseCommit: "a".repeat(40),
    status: "active", ...overrides,
  };
}
