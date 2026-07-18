import type { PlannedTask } from "../contracts/milestone.js";
import type {
  OpenCodeWriter,
  OpenCodeWriterReport,
  WriterTaskPacket,
} from "../harnesses/opencode-writer.js";
import type { ModelCapability } from "../policy/model-sheet.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { ProjectConfig } from "../projects/project-config.js";
import { GitClient } from "../workspaces/git-client.js";
import type {
  WorkspaceOwnershipGate,
  WorkspaceOwnershipReport,
} from "../workspaces/workspace-ownership.js";
import type {
  WorkspaceCreationIntent,
  WorkspaceLease,
  WorktreeManager,
} from "../workspaces/worktree-manager.js";

export interface WriterCapsuleObserver {
  onWorktreeCreationStarted?(intent: WorkspaceCreationIntent): void | Promise<void>;
  onLeaseCreated?(input: {
    readonly lease: WorkspaceLease;
    readonly baseCommit: string;
  }): void | Promise<void>;
  onWriterStarted?(input: {
    readonly lease: WorkspaceLease;
    readonly modelId: string;
  }): void | Promise<void>;
  onWriterCompleted?(report: OpenCodeWriterReport): void | Promise<void>;
}

export interface WriterCapsuleRequest {
  readonly project: ProjectConfig;
  readonly task: PlannedTask;
  readonly model: ModelCapability;
  readonly security: SecuritySheet;
  readonly executable: string;
  readonly executableSha256?: string;
  readonly openCodeHome?: string;
  readonly signal: AbortSignal;
  readonly observer?: WriterCapsuleObserver;
}

export interface WriterCapsuleResult {
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed" | "denied";
  readonly lease: WorkspaceLease | null;
  readonly writer: OpenCodeWriterReport | null;
  readonly ownership: WorkspaceOwnershipReport | null;
}

export class WriterWorktreeCapsule {
  constructor(
    private readonly worktrees: WorktreeManager,
    private readonly writer: OpenCodeWriter,
    private readonly ownership: WorkspaceOwnershipGate,
    private readonly git = new GitClient(),
  ) {}

  async run(request: WriterCapsuleRequest): Promise<WriterCapsuleResult> {
    assertAuthority(request);
    const primaryHead = await this.gitRead(request.project.repositoryPath, ["rev-parse", "HEAD"]);
    const primaryHeadRef = await this.symbolicRef(request.project.repositoryPath, "HEAD");
    await this.assertPrimaryClean(request.project.repositoryPath);
    await this.worktrees.ensureIntegrationBranch(request.project, { signal: request.signal });
    const lease = await this.worktrees.create(
      request.project,
      request.task.taskId,
      { signal: request.signal },
      request.observer?.onWorktreeCreationStarted,
    );
    const packet = writerPacket(request.task, request.security);
    const baseCommit = await this.gitRead(lease.path, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (await this.symbolicRef(
      request.project.repositoryPath,
      `refs/heads/${request.project.integrationBranch}`,
    ) !== null) {
      throw new Error("integration branch must not be symbolic");
    }
    await request.observer?.onLeaseCreated?.({ lease, baseCommit });
    await this.ownership.assertSafeBaseline(lease, packet.ownedPaths, { signal: request.signal });
    await request.observer?.onWriterStarted?.({ lease, modelId: request.model.id });
    const writer = await this.writer.execute({
      taskId: request.task.taskId,
      executable: request.executable,
      model: request.model,
      workspace: lease,
      packet,
      timeoutMs: request.task.budget.maxSeconds * 1_000,
      ...(request.executableSha256 === undefined
        ? {}
        : { expectedExecutableSha256: request.executableSha256 }),
      ...(request.openCodeHome === undefined ? {} : { home: request.openCodeHome }),
    }, request.signal);
    await request.observer?.onWriterCompleted?.(writer);

    await this.assertPrimaryUnchanged(
      request.project,
      primaryHead,
      primaryHeadRef,
    );
    const ownership = await this.ownership.inspect(
      lease,
      baseCommit,
      packet.ownedPaths,
      packet.forbiddenPaths,
      { signal: request.signal },
    );
    if (writer.outcome !== "completed") {
      return Object.freeze({
        outcome: writer.outcome,
        lease,
        writer,
        ownership,
      });
    }
    return Object.freeze({
      outcome: ownership.outcome === "accepted" ? "completed" : "denied",
      lease,
      writer,
      ownership,
    });
  }

  private async assertPrimaryClean(repository: string): Promise<void> {
    if ((await this.gitRead(repository, ["status", "--porcelain=v1", "--untracked-files=all"])) !== "") {
      throw new Error("primary checkout must be clean before writer assignment");
    }
  }

  private async assertPrimaryUnchanged(
    project: ProjectConfig,
    expectedHead: string,
    expectedHeadRef: string | null,
  ): Promise<void> {
    await this.assertPrimaryClean(project.repositoryPath);
    if (await this.gitRead(project.repositoryPath, ["rev-parse", "HEAD"]) !== expectedHead) {
      throw new Error("primary checkout HEAD changed during writer assignment");
    }
    if (await this.symbolicRef(project.repositoryPath, "HEAD") !== expectedHeadRef) {
      throw new Error("primary checkout branch changed during writer assignment");
    }
    if (await this.symbolicRef(
      project.repositoryPath,
      `refs/heads/${project.integrationBranch}`,
    ) !== null) {
      throw new Error("integration branch became symbolic during writer assignment");
    }
  }

  private async gitRead(cwd: string, args: readonly string[]): Promise<string> {
    const result = await this.git.run(cwd, args);
    if (result.termination !== null || result.exitCode !== 0 || result.truncated) {
      throw new Error(`bounded Git read failed for ${args[0] ?? "unknown"}`);
    }
    return result.stdout.trim();
  }

  private async symbolicRef(cwd: string, ref: string): Promise<string | null> {
    const result = await this.git.run(cwd, ["symbolic-ref", "--quiet", ref]);
    if (result.termination !== null || result.truncated || (result.exitCode !== 0 && result.exitCode !== 1)) {
      throw new Error(`bounded symbolic ref read failed for ${ref}`);
    }
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }
}

function assertAuthority(request: WriterCapsuleRequest): void {
  const { task, model, project, security } = request;
  if (!security.allowedRepositories.includes(project.repositoryPath)) {
    throw new Error("writer repository is not allowed by the security sheet");
  }
  if (
    task.roleAssignment.role !== "implementer" ||
    task.roleAssignment.harness !== "opencode" ||
    task.roleAssignment.agentId !== model.id ||
    model.harness !== "opencode" ||
    !model.roles.includes("implementer") ||
    !model.toolPermissions.includes("read_repository") ||
    !model.toolPermissions.includes("write_worktree") ||
    model.network !== "denied" ||
    task.risk.authority !== "workspace_write"
  ) {
    throw new Error("writer assignment is outside approved OpenCode authority");
  }
  for (const ownedPath of task.ownedPaths) {
    if (!security.allowedFileScopes.some((scope) => scopeContains(scope, ownedPath))) {
      throw new Error(`writer owned path is outside allowed scope: ${ownedPath}`);
    }
    if (security.forbiddenPaths.some((scope) => scopesOverlap(scope, ownedPath))) {
      throw new Error(`writer owned path overlaps forbidden scope: ${ownedPath}`);
    }
  }
  if (!Number.isSafeInteger(task.budget.maxSeconds * 1_000)) {
    throw new Error("writer timeout exceeds the supported duration");
  }
}

function writerPacket(task: PlannedTask, security: SecuritySheet): WriterTaskPacket {
  return Object.freeze({
    brief: task.description,
    ownedPaths: Object.freeze([...task.ownedPaths]),
    forbiddenPaths: Object.freeze([...new Set([...task.forbiddenPaths, ...security.forbiddenPaths])]),
    acceptanceCriteria: Object.freeze([...task.acceptanceCriteria]),
    budget: Object.freeze({ ...task.budget }),
    securityBoundary: Object.freeze({
      repositoryWrites: "assigned_worktree_only",
      validationAuthority: "zentra_named_validations_only",
      integrationAuthority: "none",
      shellAuthority: "none",
      modelToolNetwork: "denied",
      harnessProviderTransport: "user_os_network_authority",
      parentSecretInheritance: "denied",
    }),
  });
}

function scopeContains(container: string, candidate: string): boolean {
  if (container.endsWith("/**")) {
    const base = container.slice(0, -3);
    const candidateBase = candidate.replace(/\/\*\*$/, "");
    return candidateBase === base || candidateBase.startsWith(`${base}/`);
  }
  return container === candidate;
}

function scopesOverlap(first: string, second: string): boolean {
  const firstBase = first.replace(/\/\*\*$/, "");
  const secondBase = second.replace(/\/\*\*$/, "");
  return firstBase === secondBase ||
    firstBase.startsWith(`${secondBase}/`) ||
    secondBase.startsWith(`${firstBase}/`);
}
