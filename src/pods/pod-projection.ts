import type { StoredEvent } from "../contracts/event.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import {
  PodAssignmentSchema,
  PodAttentionSchema,
  PodBudgetUsageSchema,
  PodCharterSchema,
  PodCheckpointSchema,
  PodEvidenceSchema,
  PodLeaseSchema,
  PodWorkspaceLeaseSchema,
  PodReconciliationResolutionSchema,
  PodOwnershipIntentSchema,
  PodParentGrantSchema,
  PodReconciliationSchema,
  PodRevisionSchema,
  PodTerminalProjectionSchema,
  PodTaskRelationshipsSchema,
  parsePodEventPayload,
  type PodAssignment,
  type PodAttention,
  type PodBudgetUsage,
  type PodCharter,
  type PodCheckpoint,
  type PodEvidence,
  type PodLifecycle,
  type PodLease,
  type PodWorkspaceLease,
  type PodOwnershipIntent,
  type PodParentGrant,
  type PodReconciliation,
  type PodTerminalProjection,
} from "./pod-contracts.js";
import type { TerminalOutcome } from "../contracts/task.js";
import { logicalPathScopesOverlap } from "../milestones/path-ownership.js";
import path from "node:path";

export interface PodAssignmentView extends PodAssignment {
  readonly status: "proposed" | "dispatched" | "invoking" | "completed" | "cancelled" | "timed_out" | "failed" | "stale" | "uncertain";
  readonly invalidatedByRevision: number | null;
  readonly proposalId: string | null;
  readonly dispatchId: string | null;
  readonly evidenceIds: readonly string[];
  readonly assignmentDigest: string;
  readonly charterDigest: string;
  readonly grantDigest: string;
  readonly leaseDigest: string;
  readonly observedOutcome: "completed" | "cancelled" | "timed_out" | "failed" | "uncertain" | null;
  readonly executionId: string | null;
  readonly processId: string | null;
  readonly processIncarnation: string | null;
}

export interface PodRevisionView {
  readonly revisionId: string;
  readonly priorRevision: number;
  readonly revision: number;
  readonly causationEventId: string;
  readonly charterDigest: string;
}

export interface PodView {
  readonly podId: string;
  readonly projectId: string;
  readonly charter: PodCharter;
  readonly revision: number;
  readonly lifecycle: PodLifecycle;
  readonly terminalOutcome: TerminalOutcome | null;
  readonly streamVersion: number;
  readonly grant: PodParentGrant | null;
  readonly leases: Readonly<Record<string, PodLease>>;
  readonly workspaceLeases: Readonly<Record<string, PodWorkspaceLease>>;
  readonly assignments: Readonly<Record<string, PodAssignmentView>>;
  readonly ownershipIntents: readonly PodOwnershipIntent[];
  readonly budgetUsage: PodBudgetUsage;
  readonly checkpoints: Readonly<Record<string, PodCheckpoint>>;
  readonly evidence: Readonly<Record<string, PodEvidence>>;
  readonly attention: PodAttention | null;
  readonly cancellation: { readonly requestedBy: string; readonly reason: string } | null;
  readonly reconciliation: PodReconciliation | null;
  readonly reconciliationRequired: boolean;
  readonly revisions: readonly PodRevisionView[];
  readonly terminal: PodTerminalProjection | null;
}

const ZERO_USAGE: PodBudgetUsage = Object.freeze({ elapsedMs: 0, retries: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, externalEffects: 0 });

export function projectPod(events: readonly StoredEvent[]): PodView | null {
  if (events.length === 0) return null;
  assertMetadata(events);
  const first = events[0]!;
  if (first.type !== "pod.registered") throw new Error("first pod event must be pod.registered");
  parsePodEventPayload(first.type, first.payload);
  const charter = PodCharterSchema.parse(payload(first)["charter"]);
  if (charter.podId !== first.streamId || charter.revision !== 1) throw new Error("registered pod identity or revision is invalid");
  let currentCharter = charter;
  let lifecycle: PodLifecycle = "registered";
  let terminalOutcome: TerminalOutcome | null = null;
  let grant: PodParentGrant | null = null;
  const grantIds = new Set<string>();
  const leases = new Map<string, PodLease>();
  const workspaceLeases = new Map<string, PodWorkspaceLease>();
  const assignments = new Map<string, PodAssignmentView>();
  const ownershipIntents: PodOwnershipIntent[] = [];
  let usage = ZERO_USAGE;
  const checkpoints = new Map<string, PodCheckpoint>();
  const evidence = new Map<string, PodEvidence>();
  let attention: PodAttention | null = null;
  let cancellation: PodView["cancellation"] = null;
  let reconciliation: PodReconciliation | null = null;
  const revisions: PodRevisionView[] = [];
  let terminal: PodTerminalProjection | null = null;
  let relationshipsRecorded = false;
  let invocationNeedsReservation = false;

  for (const event of events.slice(1)) {
    if (lifecycle === "terminal") throw new Error("pod is already terminal");
    parsePodEventPayload(event.type, event.payload);
    if (!relationshipsRecorded && event.type !== "pod.task_relationships_recorded") throw new Error("pod revision requires atomic task relationships");
    if (invocationNeedsReservation && event.type !== "pod.execution_reserved") {
      throw new Error("pod invocation and execution reservation must be adjacent and atomic");
    }
    switch (event.type) {
      case "pod.task_relationships_recorded": {
        if (relationshipsRecorded || lifecycle !== "registered") throw new Error("pod task relationships are out of order");
        const relationships = PodTaskRelationshipsSchema.parse(payload(event));
        if (relationships.charterRevision !== currentCharter.revision ||
          digestCanonical(relationships.relationships) !== digestCanonical(currentCharter.tasks.map((task) => ({
            taskId: task.taskId,
            dependencies: task.dependencies,
          })))) throw new Error("pod task relationships contradict the charter DAG");
        relationshipsRecorded = true;
        break;
      }
      case "pod.admitted": {
        if (lifecycle !== "registered" || grant !== null || !relationshipsRecorded) throw new Error("pod admission is out of order");
        const parsed = PodParentGrantSchema.parse(payload(event)["grant"]);
        if (parsed.podId !== charter.podId || parsed.projectId !== charter.projectId || parsed.charterRevision !== currentCharter.revision) {
          throw new Error("pod grant contradicts charter identity");
        }
        if (parsed.charterDigest !== digestCanonical(currentCharter)) throw new Error("pod grant does not bind the exact charter");
        if (grantIds.has(parsed.grantId)) throw new Error("pod parent grant identity cannot be reused");
        assertGrantContainsCharter(parsed, currentCharter);
        grant = parsed;
        grantIds.add(parsed.grantId);
        lifecycle = "admitted";
        break;
      }
      case "pod.lease_received": {
        const lease = PodLeaseSchema.parse(payload(event)["lease"]);
        const currentGrant = grant;
        if (currentGrant === null || (lifecycle !== "admitted" && lifecycle !== "running") || lease.status !== "active" ||
          lease.podId !== charter.podId || lease.grantId !== currentGrant.grantId || lease.charterRevision !== currentCharter.revision ||
          !currentGrant.agentIds.includes(lease.agentId) || lease.capabilities.some((capability) => !currentGrant.capabilities.includes(capability)) ||
          lease.ownedPaths.some((owned) => !currentGrant.ownedPaths.some((allowed) => scopeContains(allowed, owned))) ||
          exceedsBudget(lease.budget, currentGrant.budget) || Date.parse(lease.issuedAt) < Date.parse(currentGrant.issuedAt) ||
          Date.parse(lease.expiresAt) > Date.parse(currentGrant.expiresAt) || leases.has(lease.leaseId)) {
          throw new Error("pod lease is not exactly contained by current parent authority");
        }
        leases.set(lease.leaseId, lease);
        break;
      }
      case "pod.workspace_lease_received": {
        const workspace = PodWorkspaceLeaseSchema.parse(payload(event)["workspace"]);
        const lease = leases.get(workspace.podLeaseId);
        if (grant === null || lease === undefined || workspaceLeases.has(workspace.workspaceLeaseId) ||
          workspace.workspaceLeaseId !== lease.workspaceLeaseId || workspace.podId !== charter.podId ||
          workspace.projectId !== charter.projectId || workspace.projectId !== grant.projectId ||
          workspace.repositoryPath !== grant.repositoryPath || workspace.taskId !== lease.taskId ||
          !workspace.path.startsWith(`${grant.worktreeRoot}${path.sep}`) ||
          grant.sharedIntegrationRefs.includes(workspace.branch)) {
          throw new Error("pod workspace lease contradicts project, task, or protected refs");
        }
        workspaceLeases.set(workspace.workspaceLeaseId, workspace);
        break;
      }
      case "pod.started":
        if (lifecycle !== "admitted" && lifecycle !== "blocked") throw new Error("pod cannot start from its current lifecycle");
        if (payloadString(event, "podId") !== charter.podId) throw new Error("pod start identity is invalid");
        if (attention !== null || cancellation !== null || reconciliation !== null) throw new Error("pod cannot start with unresolved control state");
        lifecycle = "running";
        break;
      case "pod.blocked":
        if (lifecycle !== "running" && lifecycle !== "admitted") throw new Error("pod cannot block from its current lifecycle");
        lifecycle = "blocked";
        break;
      case "pod.attention_raised":
        attention = PodAttentionSchema.parse(payload(event));
        lifecycle = "blocked";
        break;
      case "pod.attention_resolved":
        if (attention === null || payloadString(event, "attentionId") !== attention.attentionId) throw new Error("pod attention resolution is stale");
        attention = null;
        lifecycle = reconciliation === null ? "admitted" : "blocked";
        break;
      case "pod.assignment_recorded": {
        if (lifecycle !== "running" && lifecycle !== "admitted") throw new Error("pod assignment requires an active pod");
        const assignment = PodAssignmentSchema.parse(payload(event)["assignment"]);
        const proposalId = payloadString(event, "proposalId");
        if (assignments.has(assignment.assignmentId)) throw new Error("pod assignment identity already exists");
        assertAssignmentMatchesCharter(assignment, currentCharter);
        const durableGrant = grant;
        if (durableGrant === null || !durableGrant.agentIds.includes(assignment.agentId) ||
          assignment.capabilities.some((capability) => !durableGrant.capabilities.includes(capability)) ||
          assignment.ownedPaths.some((path) => !durableGrant.ownedPaths.some((allowed) => scopeContains(allowed, path))) ||
          exceedsBudget(assignment.budget, durableGrant.budget)) throw new Error("pod assignment exceeds durable parent grant");
        const currentAssignments = [...assignments.values()].filter((candidate) =>
          candidate.charterRevision === currentCharter.revision && candidate.status !== "stale");
        if (currentAssignments.some((candidate) => candidate.taskId === assignment.taskId)) {
          throw new Error("pod task already has a current assignment");
        }
        const planned = currentCharter.tasks.find((task) => task.taskId === assignment.taskId)!;
        for (const dependency of planned.dependencies) {
          const dependencyAssignment = [...assignments.values()].find((candidate) => candidate.taskId === dependency.taskId && candidate.charterRevision === currentCharter.revision);
          if (dependencyAssignment?.status !== "completed") throw new Error("pod assignment violates task DAG order");
        }
        for (const checkpoint of currentCharter.checkpoints.filter((candidate) =>
          candidate.afterTaskIds.some((taskId) => planned.dependencies.some((dependency) => dependency.taskId === taskId)))) {
          if (checkpoints.get(checkpoint.checkpointId)?.status !== "passed") throw new Error("pod assignment requires passed dependency checkpoint");
        }
        const reserved = currentAssignments.reduce((total, candidate) => addBudget(total, candidate.budget), emptyBudget());
        addBudget(reserved, assignment.budget);
        if (exceedsBudget(reserved, durableGrant.budget) || exceedsBudget(reserved, currentCharter.budget)) {
          throw new Error("pod assignments exceed aggregate budget authority");
        }
        if (assignment.capabilities.includes("write_worktree") && currentAssignments.some((candidate) =>
          candidate.capabilities.includes("write_worktree") && candidate.ownedPaths.some((left) =>
            assignment.ownedPaths.some((right) => logicalPathScopesOverlap(left, right))))) {
          throw new Error("pod writable assignments overlap ownership");
        }
        const assignmentDigest = payloadString(event, "assignmentDigest");
        const charterDigest = payloadString(event, "charterDigest");
        const grantDigest = payloadString(event, "grantDigest");
        const leaseDigest = payloadString(event, "leaseDigest");
        const assignmentLease = [...leases.values()].find((lease) => lease.assignmentId === assignment.assignmentId);
        if (assignmentLease === undefined || assignmentDigest !== digestCanonical(assignment) || charterDigest !== digestCanonical(currentCharter) ||
          grantDigest !== digestCanonical(durableGrant) || leaseDigest !== digestCanonical(assignmentLease)) {
          throw new Error("pod proposal digest binding is invalid");
        }
        const workspace = workspaceLeases.get(assignmentLease.workspaceLeaseId);
        const expectedProposalId = digestCanonical({ podId: charter.podId, charterRevision: currentCharter.revision,
          workspaceLeaseId: assignmentLease.workspaceLeaseId, assignmentDigest, charterDigest, grantDigest, leaseDigest });
        if (workspace === undefined || proposalId !== expectedProposalId) throw new Error("pod proposal identity is invalid");
        assignments.set(assignment.assignmentId, Object.freeze({ ...assignment, status: "proposed", invalidatedByRevision: null,
          proposalId, dispatchId: null, evidenceIds: Object.freeze([]), assignmentDigest, charterDigest, grantDigest, leaseDigest,
          observedOutcome: null, executionId: null, processId: null, processIncarnation: null }));
        break;
      }
      case "pod.assignment_dispatched": {
        const assignmentId = payloadString(event, "assignmentId");
        const current = assignments.get(assignmentId);
        if (lifecycle !== "running" || cancellation !== null || reconciliation !== null || current?.status !== "proposed" ||
          current.proposalId !== payloadString(event, "proposalId")) throw new Error("pod dispatch requires a current active assignment");
        assignments.set(assignmentId, Object.freeze({ ...current, status: "dispatched", dispatchId: payloadString(event, "dispatchId") }));
        break;
      }
      case "pod.assignment_invocation_started": {
        const assignmentId = payloadString(event, "assignmentId");
        const current = assignments.get(assignmentId);
        const currentLease = [...leases.values()].find((lease) => lease.assignmentId === assignmentId);
        const authorizedAt = payloadString(event, "authorizedAt");
        if (lifecycle !== "running" || cancellation !== null || reconciliation !== null || grant === null ||
          current?.status !== "dispatched" || current.dispatchId !== payloadString(event, "dispatchId") ||
          current.charterRevision !== currentCharter.revision || currentLease === undefined || currentLease.status !== "active" ||
          currentLease.charterRevision !== currentCharter.revision || currentLease.grantId !== grant.grantId ||
          Date.parse(authorizedAt) >= Date.parse(currentLease.expiresAt) || Date.parse(authorizedAt) >= Date.parse(grant.expiresAt)) {
          throw new Error("pod invocation requires current running authority without cancellation");
        }
        assignments.set(assignmentId, Object.freeze({ ...current, status: "invoking" }));
        invocationNeedsReservation = true;
        break;
      }
      case "pod.execution_bound": {
        const assignmentId = payloadString(event, "assignmentId");
        const current = assignments.get(assignmentId);
        if (current?.status !== "invoking" || current.dispatchId !== payloadString(event, "dispatchId") ||
          current.executionId !== payloadString(event, "executionId") || current.processId !== null) {
          throw new Error("pod execution identity is not bound to current invocation");
        }
        assignments.set(assignmentId, Object.freeze({ ...current, processId: payloadString(event, "processId"),
          processIncarnation: payloadString(event, "processIncarnation") }));
        break;
      }
      case "pod.execution_reserved": {
        const assignmentId = payloadString(event, "assignmentId");
        const current = assignments.get(assignmentId);
        if (current?.status !== "invoking" || current.dispatchId !== payloadString(event, "dispatchId") || current.executionId !== null ||
          payload(event)["charterRevision"] !== currentCharter.revision || current.charterRevision !== currentCharter.revision) {
          throw new Error("pod execution reservation is stale or duplicated");
        }
        assignments.set(assignmentId, Object.freeze({ ...current, executionId: payloadString(event, "executionId") }));
        invocationNeedsReservation = false;
        break;
      }
      case "pod.assignment_observed": {
        const assignmentId = payloadString(event, "assignmentId");
        const current = assignments.get(assignmentId);
        const outcome = payloadString(event, "outcome");
        const evidenceIds = payload(event)["evidenceIds"] as readonly string[];
        const observedUsage = PodBudgetUsageSchema.parse(payload(event)["usage"]);
        if ((current?.status !== "invoking" && current?.status !== "dispatched") || current.dispatchId !== payloadString(event, "dispatchId") ||
          current.executionId === null || !["completed", "cancelled", "timed_out", "failed", "uncertain"].includes(outcome)) {
          throw new Error("pod assignment observation requires exact durable execution identity");
        }
        if (evidenceIds.some((id) => evidence.get(id)?.taskId !== current.taskId)) throw new Error("pod assignment observation evidence is invalid");
        if (outcome === "completed") {
          const task = currentCharter.tasks.find((candidate) => candidate.taskId === current.taskId)!;
          if (task.evidenceRequirements.some((kind) => !evidenceIds.some((id) => evidence.get(id)?.kind === kind))) throw new Error("completed assignment lacks task evidence");
        }
        if (usageExceedsBudget(observedUsage, current.budget)) throw new Error("pod assignment observation exceeds assignment budget");
        const aggregateUsage = addUsage(usage, observedUsage);
        if (grant === null || usageExceedsBudget(aggregateUsage, grant.budget) || usageExceedsBudget(aggregateUsage, currentCharter.budget)) {
          throw new Error("pod assignment observation exceeds aggregate budget");
        }
        usage = Object.freeze(aggregateUsage);
        const terminationAcknowledged = payload(event)["terminationAcknowledged"] === true;
        const status = outcome === "uncertain" || (outcome === "timed_out" && !terminationAcknowledged) ? "uncertain" : outcome;
        assignments.set(assignmentId, Object.freeze({ ...current, status: status as PodAssignmentView["status"],
          observedOutcome: outcome as PodAssignmentView["observedOutcome"], evidenceIds: Object.freeze([...evidenceIds]) }));
        break;
      }
      case "pod.ownership_intent_observed": {
        const intent = PodOwnershipIntentSchema.parse(payload(event));
        const assignment = assignments.get(intent.assignmentId);
        if (assignment === undefined || assignment.taskId !== intent.taskId || !sameSet(assignment.ownedPaths, intent.ownedPaths)) {
          throw new Error("pod ownership intent contradicts assignment");
        }
        ownershipIntents.push(intent);
        break;
      }
      case "pod.checkpointed": {
        const checkpoint = PodCheckpointSchema.parse(payload(event));
        const definition = currentCharter.checkpoints.find((candidate) => candidate.checkpointId === checkpoint.checkpointId);
        if (definition === undefined) throw new Error("unknown pod checkpoint");
        if (definition.afterTaskIds.some((taskId) => ![...assignments.values()].some((assignment) =>
          assignment.taskId === taskId && assignment.charterRevision === currentCharter.revision && assignment.status === "completed"))) {
          throw new Error("pod checkpoint cannot precede its declared tasks");
        }
        if (checkpoint.evidenceIds.some((evidenceId) => !evidence.has(evidenceId)) ||
          definition.evidenceRequirements.some((kind) => !checkpoint.evidenceIds.some((evidenceId) => evidence.get(evidenceId)?.kind === kind))) {
          throw new Error("pod checkpoint lacks its retained evidence");
        }
        checkpoints.set(checkpoint.checkpointId, checkpoint);
        break;
      }
      case "pod.evidence_recorded": {
        const item = PodEvidenceSchema.parse(payload(event));
        if (evidence.has(item.evidenceId)) throw new Error("duplicate pod evidence identity");
        if (item.taskId !== null && !currentCharter.tasks.some((task) => task.taskId === item.taskId)) throw new Error("pod evidence references unknown task");
        evidence.set(item.evidenceId, item);
        break;
      }
      case "pod.revised": {
        const revision = PodRevisionSchema.parse(payload(event));
        const cause = events.find((candidate) => candidate.eventId === revision.cause.eventId);
        if (event.causationId !== revision.cause.eventId || revision.priorRevision !== currentCharter.revision ||
          revision.charter.revision !== currentCharter.revision + 1 || revision.charter.podId !== charter.podId ||
          revision.charter.projectId !== charter.projectId || cause === undefined || cause.streamVersion !== revision.cause.streamVersion ||
          cause.streamVersion >= event.streamVersion ||
          cause.type !== revision.cause.eventType || digestCanonical(cause.payload) !== revision.cause.payloadDigest) {
          throw new Error("pod revision causation is invalid or stale");
        }
        if (reconciliation !== null || [...assignments.values()].some((assignment) =>
          assignment.status === "dispatched" || assignment.status === "invoking" || assignment.status === "uncertain")) {
          throw new Error("pod revision cannot race an active or uncertain dispatch");
        }
        assertRevisionContained(currentCharter, revision.charter, grant);
        currentCharter = revision.charter;
        revisions.push(Object.freeze({ revisionId: revision.revisionId, priorRevision: revision.priorRevision, revision: currentCharter.revision,
          causationEventId: event.causationId, charterDigest: digestCanonical(revision.charter) }));
        for (const [assignmentId, assignment] of assignments) {
          if (assignment.status === "proposed") assignments.set(assignmentId, Object.freeze({ ...assignment, status: "stale", invalidatedByRevision: currentCharter.revision }));
        }
        grant = null;
        relationshipsRecorded = false;
        lifecycle = "registered";
        break;
      }
      case "pod.reconciliation_required": {
        const requested = PodReconciliationSchema.parse(payload(event));
        const assignment = assignments.get(requested.assignmentId);
        if (reconciliation !== null || assignment?.dispatchId !== requested.dispatchId ||
          (assignment.status !== "dispatched" && assignment.status !== "invoking" && assignment.status !== "uncertain")) {
          throw new Error("pod reconciliation request is not bound to an unresolved dispatch");
        }
        reconciliation = requested;
        lifecycle = "blocked";
        break;
      }
      case "pod.reconciliation_resolved": {
        const resolution = PodReconciliationResolutionSchema.parse(payload(event));
        const current = assignments.get(resolution.assignmentId);
        if (reconciliation === null || resolution.reconciliationId !== reconciliation.reconciliationId ||
          resolution.dispatchId !== reconciliation.dispatchId || current?.dispatchId !== resolution.dispatchId ||
          resolution.evidenceIds.some((id) => evidence.get(id)?.taskId !== current.taskId)) throw new Error("pod reconciliation resolution is stale or unsupported");
        if (current.executionId !== null && (resolution.executionId !== current.executionId ||
          resolution.processId !== current.processId || resolution.processIncarnation !== current.processIncarnation ||
          resolution.terminationEvidenceSha256 === null || resolution.effectEvidenceSha256 === null)) {
          throw new Error("pod reconciliation resolution lacks exact execution, termination, or effect evidence");
        }
        if (current.executionId === null && (resolution.executionId !== null || resolution.processId !== null ||
          resolution.processIncarnation !== null)) throw new Error("pod reconciliation resolution invents execution identity");
        const status = resolution.resolution === "completed" ? "completed" :
          resolution.resolution === "no_effect" && current.observedOutcome === "timed_out" ? "timed_out" : "failed";
        if (resolution.resolution === "completed") {
          const task = currentCharter.tasks.find((candidate) => candidate.taskId === current.taskId)!;
          if (task.evidenceRequirements.some((kind) => !resolution.evidenceIds.some((id) => evidence.get(id)?.kind === kind))) {
            throw new Error("completed reconciliation lacks task evidence");
          }
        }
        assignments.set(current.assignmentId, Object.freeze({ ...current, status, evidenceIds: Object.freeze([...resolution.evidenceIds]) }));
        reconciliation = null;
        lifecycle = cancellation === null ? "running" : "cancel_requested";
        break;
      }
      case "pod.cancel_requested":
        cancellation = Object.freeze({ requestedBy: payloadString(event, "requestedBy"), reason: payloadString(event, "reason") });
        for (const [assignmentId, assignment] of assignments) {
          if (assignment.status === "proposed") assignments.set(assignmentId, Object.freeze({ ...assignment, status: "cancelled" }));
        }
        lifecycle = "cancel_requested";
        break;
      case "pod.completed":
      case "pod.cancelled":
      case "pod.denied":
      case "pod.timed_out":
      case "pod.failed": {
        terminal = PodTerminalProjectionSchema.parse(payload(event));
        const expected = event.type.slice("pod.".length) as TerminalOutcome;
        if (terminal.outcome !== expected || terminal.podId !== charter.podId || terminal.projectId !== charter.projectId ||
          terminal.charterRevision !== currentCharter.revision) throw new Error("pod terminal projection contradicts aggregate state");
        if (terminal.outcome === "completed" && (attention !== null || cancellation !== null || reconciliation !== null)) {
          throw new Error("completed pod cannot retain unresolved control state");
        }
        if (terminal.outcome === "cancelled" && cancellation === null) throw new Error("pod cancellation requires a durable request");
        if (reconciliation !== null || [...assignments.values()].some((assignment) =>
          assignment.status === "dispatched" || assignment.status === "invoking" || assignment.status === "uncertain")) {
          throw new Error("pod terminal outcome cannot hide an active or uncertain effect");
        }
        validateTerminal(terminal, currentCharter, evidence);
        terminalOutcome = terminal.outcome;
        lifecycle = "terminal";
        break;
      }
      default:
        throw new Error(`unknown pod event type: ${event.type}`);
    }
  }

  if (!relationshipsRecorded) throw new Error("pod revision is missing atomic task relationships");
  if (invocationNeedsReservation) throw new Error("pod invocation is missing its atomic execution reservation");

  return Object.freeze({
    podId: charter.podId,
    projectId: charter.projectId,
    charter: currentCharter,
    revision: currentCharter.revision,
    lifecycle,
    terminalOutcome,
    streamVersion: events.at(-1)!.streamVersion,
    grant,
    leases: Object.freeze(Object.fromEntries(leases)),
    workspaceLeases: Object.freeze(Object.fromEntries(workspaceLeases)),
    assignments: Object.freeze(Object.fromEntries(assignments)),
    ownershipIntents: Object.freeze([...ownershipIntents]),
    budgetUsage: usage,
    checkpoints: Object.freeze(Object.fromEntries(checkpoints)),
    evidence: Object.freeze(Object.fromEntries(evidence)),
    attention,
    cancellation,
    reconciliation,
    reconciliationRequired: reconciliation !== null,
    revisions: Object.freeze(revisions),
    terminal,
  });
}

export function assertGrantContainsCharter(grant: PodParentGrant, charter: PodCharter): void {
  if (charter.requiredCapabilities.some((capability) => !grant.capabilities.includes(capability)) ||
    charter.roles.some((role) => !grant.agentIds.includes(role.agentId)) ||
    charter.ownership.ownedPaths.some((owned) => !grant.ownedPaths.some((allowed) => scopeContains(allowed, owned))) ||
    !charter.ownership.forbiddenPaths.every((path) => grant.forbiddenPaths.some((forbidden) => scopeContains(forbidden, path))) ||
    exceedsBudget(charter.budget, grant.budget)) throw new Error("pod charter exceeds parent grant");
}

export function assertAssignmentMatchesCharter(assignment: PodAssignment, charter: PodCharter): void {
  const role = charter.roles.find((candidate) => candidate.roleId === assignment.roleId);
  if (assignment.charterRevision !== charter.revision || role?.agentId !== assignment.agentId || !role.taskIds.includes(assignment.taskId) ||
    assignment.capabilities.some((capability) => !charter.requiredCapabilities.includes(capability)) ||
    assignment.ownedPaths.some((path) => !charter.ownership.ownedPaths.some((allowed) => scopeContains(allowed, path))) ||
    exceedsBudget(assignment.budget, charter.budget)) throw new Error("pod assignment exceeds charter authority");
}

export function exceedsBudget(usage: PodBudgetUsage | PodCharter["budget"], budget: PodCharter["budget"]): boolean {
  const seconds = "elapsedMs" in usage ? Math.ceil(usage.elapsedMs / 1_000) : usage.maxSeconds;
  const retries = "retries" in usage ? usage.retries : usage.maxRetries;
  const cost = "costUsd" in usage ? usage.costUsd : usage.maxCostUsd;
  const input = "inputTokens" in usage ? usage.inputTokens : usage.maxInputTokens;
  const output = "outputTokens" in usage ? usage.outputTokens : usage.maxOutputTokens;
  const effects = "externalEffects" in usage ? usage.externalEffects : usage.maxExternalEffects;
  return seconds > budget.maxSeconds || retries > budget.maxRetries || cost > budget.maxCostUsd ||
    input > budget.maxInputTokens || output > budget.maxOutputTokens || effects > budget.maxExternalEffects;
}

function usageExceedsBudget(usage: PodBudgetUsage, budget: PodCharter["budget"]): boolean {
  return usage.elapsedMs > budget.maxSeconds * 1_000 || usage.retries > budget.maxRetries ||
    usage.costUsd > budget.maxCostUsd || usage.inputTokens > budget.maxInputTokens ||
    usage.outputTokens > budget.maxOutputTokens || usage.externalEffects > budget.maxExternalEffects;
}

function addUsage(first: PodBudgetUsage, second: PodBudgetUsage): PodBudgetUsage {
  return { elapsedMs: first.elapsedMs + second.elapsedMs, retries: first.retries + second.retries,
    costUsd: first.costUsd + second.costUsd, inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens, externalEffects: 0 };
}

export function scopeContains(container: string, candidate: string): boolean {
  const recursive = container.endsWith("/**");
  const base = recursive ? container.slice(0, -3) : container;
  const candidateBase = candidate.endsWith("/**") ? candidate.slice(0, -3) : candidate;
  return recursive ? candidateBase === base || candidateBase.startsWith(`${base}/`) : candidate === container;
}

function assertRevisionContained(prior: PodCharter, revised: PodCharter, grant: PodParentGrant | null): void {
  if (revised.outcome !== prior.outcome && prior.revision > 1) throw new Error("pod revision cannot repeatedly alter its outcome");
  if (grant !== null) assertGrantContainsCharter(grant, revised);
}

function validateTerminal(terminal: PodTerminalProjection, charter: PodCharter, evidence: ReadonlyMap<string, PodEvidence>): void {
  if (new Set(terminal.tasks.map((task) => task.taskId)).size !== terminal.tasks.length ||
    terminal.tasks.some((task) => !charter.tasks.some((planned) => planned.taskId === task.taskId))) {
    throw new Error("pod terminal projection has invalid task identities");
  }
  for (const evidenceId of terminal.evidenceIds) if (!evidence.has(evidenceId)) throw new Error("pod terminal projection references missing evidence");
  for (const task of terminal.tasks) {
    for (const evidenceId of task.evidenceIds) {
      if (evidence.get(evidenceId)?.taskId !== task.taskId) throw new Error("pod task terminal projection references invalid evidence");
    }
  }
  if (terminal.outcome === "completed") {
    if (terminal.tasks.length !== charter.tasks.length || charter.tasks.some((task, index) => terminal.tasks[index]?.taskId !== task.taskId || terminal.tasks[index]?.outcome !== "completed")) {
      throw new Error("completed pod requires canonical successful task projections");
    }
    for (const requirement of charter.evidenceRequirements) {
      if (![...evidence.values()].some((item) => item.kind === requirement && terminal.evidenceIds.includes(item.evidenceId))) {
        throw new Error("completed pod lacks charter evidence");
      }
    }
    for (const [index, task] of charter.tasks.entries()) {
      const projected = terminal.tasks[index]!;
      for (const requirement of task.evidenceRequirements) {
        if (!projected.evidenceIds.some((evidenceId) => evidence.get(evidenceId)?.kind === requirement && evidence.get(evidenceId)?.taskId === task.taskId)) {
          throw new Error(`completed pod task ${task.taskId} lacks required evidence`);
        }
      }
    }
  }
}

function assertMetadata(events: readonly StoredEvent[]): void {
  const first = events[0]!;
  for (const [index, event] of events.entries()) {
    if (event.streamId !== first.streamId || event.correlationId !== first.correlationId || event.streamVersion !== index + 1) {
      throw new Error("pod event metadata must be contiguous and trace-bound");
    }
  }
}

function payload(event: StoredEvent): Readonly<Record<string, unknown>> {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) throw new Error("pod event payload must be an object");
  return event.payload as Readonly<Record<string, unknown>>;
}

function payloadString(event: StoredEvent, key: string): string {
  const value = payload(event)[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`pod event ${key} must be a nonempty string`);
  return value;
}

function sameSet(first: readonly string[], second: readonly string[]): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function emptyBudget(): PodCharter["budget"] {
  return { maxSeconds: 0, maxRetries: 0, maxCostUsd: 0, maxInputTokens: 0, maxOutputTokens: 0, maxExternalEffects: 0 };
}

function addBudget(target: PodCharter["budget"], budget: PodCharter["budget"]): PodCharter["budget"] {
  target.maxSeconds += budget.maxSeconds;
  target.maxRetries += budget.maxRetries;
  target.maxCostUsd += budget.maxCostUsd;
  target.maxInputTokens += budget.maxInputTokens;
  target.maxOutputTokens += budget.maxOutputTokens;
  return target;
}
