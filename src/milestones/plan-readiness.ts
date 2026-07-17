import {
  MilestonePlanSchema,
  type MilestonePlan,
  type StopAndAskReason,
} from "../contracts/milestone.js";
import {
  createAuthorityAttention,
  digestCanonical,
  type AuthorityAttention,
  type AuthorityAttentionClassification,
  type OpenCodeAdmissionPacket,
  type OpenCodeTaskAdmissionContext,
} from "../contracts/authority-attention.js";
import type { SecuritySheet } from "../policy/security-sheet.js";

export type PlanReadinessStatus = "executable" | "blocked" | "requires_approval";

export interface PlanReadinessDecision {
  readonly status: PlanReadinessStatus;
  readonly reason: "ready" | StopAndAskReason;
  readonly attention: AuthorityAttention | null;
}

export interface PlanReadinessInput {
  readonly plan: unknown;
  readonly taskId?: string;
  readonly security: SecuritySheet;
  readonly packet: OpenCodeAdmissionPacket;
  readonly context: OpenCodeTaskAdmissionContext;
}

export function assessMilestonePlanReadiness(
  input: PlanReadinessInput,
): PlanReadinessDecision {
  const parsed = MilestonePlanSchema.safeParse(input.plan);
  if (!parsed.success) {
    return Object.freeze({
      status: "blocked",
      reason: "plan_not_ready",
      attention: createAuthorityAttention({
        packet: input.packet,
        reason: "plan_not_ready",
        classification: "hard_stop",
        configuredStopCondition: input.security.stopAndAskConditions.includes("plan_not_ready"),
      }),
    });
  }

  const taskId = input.taskId ?? parsed.data.tasks[0]!.taskId;
  const task = parsed.data.tasks.find((candidate) => candidate.taskId === taskId);
  if (task === undefined) {
    return stopped(input.packet, "plan_not_ready", "hard_stop", input.security);
  }
  if (
    input.packet.planDigest !== digestCanonical(parsed.data) ||
    input.packet.securityDigest !== digestCanonical(input.security)
  ) {
    return stopped(input.packet, "plan_not_ready", "hard_stop", input.security);
  }

  const scopeDecision = assessFileScope(parsed.data, task.taskId, input.security, input.packet);
  if (scopeDecision !== null) return scopeDecision;

  const authorityDecision = assessAuthority(
    parsed.data,
    task.taskId,
    input.security,
    input.packet,
    input.context,
  );
  if (authorityDecision !== null) return authorityDecision;

  return Object.freeze({ status: "executable", reason: "ready", attention: null });
}

function assessFileScope(
  plan: MilestonePlan,
  taskId: string,
  security: SecuritySheet,
  packet: OpenCodeAdmissionPacket,
): PlanReadinessDecision | null {
  const task = plan.tasks.find((candidate) => candidate.taskId === taskId)!;
  if (!security.allowedRepositories.includes(packet.repository)) {
    return stopped(packet, "forbidden_file_scope", "hard_stop", security);
  }
  for (const ownedPath of task.ownedPaths) {
    if (!security.allowedFileScopes.some((scope) => scopeContains(scope, ownedPath))) {
      return stopped(
        packet,
        "forbidden_file_scope",
        "hard_stop",
        security,
      );
    }
    if (security.forbiddenPaths.some((scope) => scopesOverlap(ownedPath, scope))) {
      return stopped(
        packet,
        "forbidden_file_scope",
        "hard_stop",
        security,
      );
    }
  }
  return null;
}

function assessAuthority(
  plan: MilestonePlan,
  taskId: string,
  security: SecuritySheet,
  packet: OpenCodeAdmissionPacket,
  context: OpenCodeTaskAdmissionContext,
): PlanReadinessDecision | null {
  const task = plan.tasks.find((candidate) => candidate.taskId === taskId)!;
  if (
    packet.actorId !== task.roleAssignment.agentId ||
    packet.harness !== "opencode" ||
    context.harness !== "opencode" ||
    context.actorId !== packet.actorId ||
    context.harness !== packet.harness ||
    context.role !== packet.role ||
    context.capabilityId !== packet.capabilityId ||
    context.transportModelId !== packet.transportModelId ||
    packet.harness !== task.roleAssignment.harness ||
    packet.role !== task.roleAssignment.role ||
    packet.capabilityId !== task.roleAssignment.agentId ||
    packet.authority !== task.risk.authority ||
    context.authority !== task.risk.authority ||
    !context.roles.includes(packet.role) ||
    !sameCanonicalSet(packet.roles, context.roles) ||
    !sameCanonicalSet(packet.toolPermissions, context.toolPermissions) ||
    packet.network !== context.network ||
    packet.contextTokens !== context.contextTokens
  ) {
    return stopped(packet, "plan_not_ready", "hard_stop", security);
  }
  if (
    context.network === "declared" ||
    context.toolPermissions.includes("web_research")
  ) {
    return stopped(packet, "undeclared_network", "hard_stop", security);
  }
  const expectedTools = packet.role === "reviewer"
    ? ["read_repository", "review_diff"]
    : packet.role === "implementer"
      ? ["read_repository", "write_worktree"]
      : ["read_repository"];
  if (!sameCanonicalSet(context.toolPermissions, expectedTools)) {
    return stopped(packet, "plan_not_ready", "hard_stop", security);
  }
  if (context.requestedBudget.maxInputTokens + context.requestedBudget.maxOutputTokens > context.contextTokens) {
    return stopped(packet, "plan_not_ready", "hard_stop", security);
  }
  if (exceedsBudget(packet, task.budget)) {
    return stopped(packet, "budget_exceeded", "hard_stop", security);
  }
  if (task.risk.authority === "external_effect") {
    return stopped(
      packet,
      "undeclared_network",
      "hard_stop",
      security,
    );
  }
  if (
    task.risk.authority === "local_release_preparation" &&
    security.releaseBoundary === "no_release_operations"
  ) {
    return stopped(
      packet,
      "release_boundary",
      "hard_stop",
      security,
    );
  }
  const approvalOperation = representableApprovalOperations(task.risk.authority, context)
    .find((operation) => security.approvalRequiredOperations.includes(operation));
  if (approvalOperation !== undefined) {
    return stopped(packet, "missing_authority", "exact_approval_required", security);
  }
  if (task.risk.requiresApproval) {
    return stopped(
      packet,
      "missing_authority",
      "exact_approval_required",
      security,
    );
  }
  return null;
}

function representableApprovalOperations(
  authority: MilestonePlan["tasks"][number]["risk"]["authority"],
  context: OpenCodeTaskAdmissionContext,
): readonly string[] {
  if (authority === "external_effect") return ["external_effect", "network_access"];
  if (context.network === "declared") return ["network_access"];
  return [];
}

function sameCanonicalSet(first: readonly string[], second: readonly string[]): boolean {
  return JSON.stringify(first) === JSON.stringify([...new Set(second)].sort());
}


function stopped(
  packet: OpenCodeAdmissionPacket,
  reason: StopAndAskReason,
  classification: AuthorityAttentionClassification,
  security: SecuritySheet,
): PlanReadinessDecision {
  return Object.freeze({
    status: classification === "hard_stop" ? "blocked" : "requires_approval",
    reason,
    attention: createAuthorityAttention({
      packet,
      reason,
      classification,
      configuredStopCondition: security.stopAndAskConditions.includes(reason),
    }),
  });
}

function exceedsBudget(
  packet: OpenCodeAdmissionPacket,
  planned: MilestonePlan["tasks"][number]["budget"],
): boolean {
  const requested = packet.requestedBudget;
  return requested.maxSeconds > planned.maxSeconds ||
    requested.maxCostUsd > planned.maxCostUsd ||
    requested.maxInputTokens > planned.maxInputTokens ||
    requested.maxOutputTokens > planned.maxOutputTokens ||
    requested.timeoutMs > planned.maxSeconds * 1_000;
}

function scopeContains(scope: string, candidate: string): boolean {
  const scopeBase = logicalScopeBase(scope);
  const candidateBase = logicalScopeBase(candidate);
  if (!scope.endsWith("/**")) return scopeBase === candidateBase && !candidate.endsWith("/**");
  return candidateBase === scopeBase || candidateBase.startsWith(`${scopeBase}/`);
}

function scopesOverlap(first: string, second: string): boolean {
  const firstBase = logicalScopeBase(first);
  const secondBase = logicalScopeBase(second);
  return firstBase === secondBase || firstBase.startsWith(`${secondBase}/`) || secondBase.startsWith(`${firstBase}/`);
}

function logicalScopeBase(scope: string): string {
  return scope.endsWith("/**") ? scope.slice(0, -3) : scope;
}
