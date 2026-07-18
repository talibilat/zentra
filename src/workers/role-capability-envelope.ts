import { z } from "zod";

import { digestCanonical } from "../contracts/authority-attention.js";
import type { EventJournal } from "../journal/journal.js";
import { capabilityEnvelope, CapabilityEnvelopeSchema } from "./worker-lifecycle.js";
import { WebResearchPolicySchema } from "../research/web-research.js";
import { researchDestinationAllows } from "../research/destination-policy.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentitySchema = z.string().min(1).max(256);
const LogicalPathSchema = z.string().min(1).max(4_096).refine(isSafeLogicalPath, "path must be a safe logical relative path");
const CanonicalPathsSchema = z.array(LogicalPathSchema).max(256).superRefine(assertCanonicalSet);
const GovernedRoleSchema = z.enum(["planner", "researcher", "implementer", "reviewer"]);
const ProviderTransportSchema = z.literal("host_model_provider");

const AccessSchema = z.strictObject({
  readPaths: CanonicalPathsSchema,
  writePaths: CanonicalPathsSchema,
  forbiddenPaths: CanonicalPathsSchema,
  scratch: z.enum(["bounded_ephemeral", "none"]),
});
const ReviewEvidenceSchema = z.strictObject({
  workerId: IdentitySchema,
  diffSha256: DigestSchema,
  validationSha256: DigestSchema,
});
const BindingBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  milestoneId: IdentitySchema,
  taskId: IdentitySchema,
  projectId: IdentitySchema,
  correlationId: IdentitySchema,
  role: GovernedRoleSchema,
  actorId: IdentitySchema,
  planDigest: DigestSchema,
  securityDigest: DigestSchema,
  modelDigest: DigestSchema,
  repositoryDigest: DigestSchema,
  ownershipDigest: DigestSchema,
  budgetDigest: DigestSchema,
  admissionDigest: DigestSchema,
  providerTransport: ProviderTransportSchema,
  envelope: CapabilityEnvelopeSchema,
  access: AccessSchema,
  review: ReviewEvidenceSchema.nullable(),
  webResearch: WebResearchPolicySchema.nullable(),
});

export const RoleCapabilityBindingSchema = BindingBodySchema.extend({ digest: DigestSchema }).superRefine((binding, context) => {
  if (binding.digest !== bindingDigest(binding)) context.addIssue({ code: "custom", message: "role capability binding digest mismatch" });
  const expected = roleEnvelope(binding.role, binding.access, binding.webResearch !== null);
  if (expected.digest !== binding.envelope.digest) context.addIssue({ code: "custom", message: "role capability envelope is not canonical" });
  if ((binding.role === "implementer") !== (binding.access.writePaths.length > 0)) {
    context.addIssue({ code: "custom", message: "only implementers receive owned write paths" });
  }
  if ((binding.role === "reviewer") !== (binding.review !== null)) {
    context.addIssue({ code: "custom", message: "review evidence must be bound only for reviewers" });
  }
});

export type GovernedRole = z.infer<typeof GovernedRoleSchema>;
export type RoleCapabilityBinding = z.infer<typeof RoleCapabilityBindingSchema>;

export interface RoleCapabilityBindingInput {
  readonly milestoneId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly correlationId: string;
  readonly role: GovernedRole;
  readonly actorId: string;
  readonly repository: string;
  readonly planDigest: string;
  readonly securityDigest: string;
  readonly model: {
    readonly capabilityId: string;
    readonly transportModelId: string;
    readonly digest: string;
    readonly harness: string;
    readonly roles: readonly string[];
    readonly toolPermissions: readonly string[];
    readonly network: string;
  };
  readonly budget: Readonly<Record<string, unknown>>;
  readonly admissionDigest: string;
  readonly configuredReadPaths: readonly string[];
  readonly ownedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly review?: z.infer<typeof ReviewEvidenceSchema>;
  readonly webResearch?: {
    readonly allowedDestinations: readonly string[];
    readonly destinations?: readonly { readonly origin: string; readonly pathPrefix: string }[];
    readonly requiredRequest?: { readonly method: "GET"; readonly url: string; readonly maxRequests: 1 };
    readonly timeoutMs: number;
  };
}

export const RoleCapabilityRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["read", "search", "write"]), path: LogicalPathSchema }),
  z.strictObject({ kind: z.literal("review"), ...ReviewEvidenceSchema.shape }),
  z.strictObject({ kind: z.literal("network"), destination: z.string().min(1).max(4_096),
    method: z.enum(["GET", "HEAD", "OTHER"]).optional(), capability: z.enum(["web_research", "unknown"]).optional() }),
  z.strictObject({ kind: z.enum(["validation", "integration", "release", "secret", "external_effect"]) }),
]);
export type RoleCapabilityRequest = z.infer<typeof RoleCapabilityRequestSchema>;

const DecisionBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  decisionId: DigestSchema,
  bindingDigest: DigestSchema,
  requestDigest: DigestSchema,
  effectPerformed: z.literal(false),
});
export const RoleCapabilityDecisionSchema = z.discriminatedUnion("status", [
  DecisionBaseSchema.extend({ status: z.literal("allowed"), reason: z.literal("in_envelope") }),
  DecisionBaseSchema.extend({
    status: z.literal("attention"),
    reason: z.enum(["forbidden_path", "forbidden_effect", "network_disabled", "network_destination_not_allowed", "network_method_not_allowed", "network_capability_not_allowed", "self_review", "stale_evidence"]),
  }),
  DecisionBaseSchema.extend({ status: z.literal("replan"), reason: z.literal("path_not_owned") }),
]);
export type RoleCapabilityDecision = z.infer<typeof RoleCapabilityDecisionSchema>;

const AcceptedPayloadSchema = z.strictObject({ binding: RoleCapabilityBindingSchema });
const EvaluatedPayloadSchema = z.strictObject({
  bindingDigest: DigestSchema,
  request: RoleCapabilityRequestSchema,
  decision: RoleCapabilityDecisionSchema,
}).superRefine((evaluation, context) => {
  const requestDigest = digestCanonical(evaluation.request);
  if (evaluation.decision.requestDigest !== requestDigest) context.addIssue({ code: "custom", message: "capability request digest mismatch" });
  if (evaluation.decision.bindingDigest !== evaluation.bindingDigest) context.addIssue({ code: "custom", message: "capability decision binding digest mismatch" });
  if (evaluation.decision.decisionId !== decisionId(evaluation.bindingDigest, requestDigest, evaluation.decision.status, evaluation.decision.reason)) {
    context.addIssue({ code: "custom", message: "capability decision identity mismatch" });
  }
});

export interface RoleCapabilityExpectedDigests {
  readonly planDigest: string;
  readonly securityDigest: string;
  readonly modelDigest: string;
  readonly repositoryDigest: string;
  readonly ownershipDigest: string;
  readonly budgetDigest: string;
  readonly admissionDigest: string;
}

export function roleToolPermissions(role: GovernedRole, webResearch = false): readonly string[] {
  return role === "implementer"
    ? Object.freeze(["read_repository", "write_worktree"])
    : role === "reviewer"
      ? Object.freeze(["read_repository", "review_diff"])
      : Object.freeze(webResearch ? ["read_repository", "web_research"] : ["read_repository"]);
}

export function roleModelSupports(role: GovernedRole, model: {
  readonly harness: string;
  readonly roles: readonly string[];
  readonly toolPermissions: readonly string[];
  readonly network: string;
}): boolean {
  const declaredResearch = (role === "planner" || role === "researcher") && model.network === "declared" &&
    sameSet(model.toolPermissions, roleToolPermissions(role, true));
  const networkDark = model.network === "denied" && sameSet(model.toolPermissions, roleToolPermissions(role));
  return model.harness === "opencode" && model.roles.includes(role) && (declaredResearch || networkDark);
}

export function assertRoleModelCapability(role: GovernedRole, model: {
  readonly harness: string;
  readonly roles: readonly string[];
  readonly toolPermissions: readonly string[];
  readonly network: string;
}): void {
  if (!roleModelSupports(role, model)) throw new Error("model does not match the canonical role capability policy");
}

export function buildRoleCapabilityBinding(input: RoleCapabilityBindingInput): RoleCapabilityBinding {
  assertRoleModelCapability(input.role, input.model);
  const access = AccessSchema.parse({
    readPaths: canonicalPaths(input.configuredReadPaths),
    writePaths: input.role === "implementer" ? canonicalPaths(input.ownedPaths) : [],
    forbiddenPaths: canonicalPaths(input.forbiddenPaths),
    scratch: input.role === "planner" || input.role === "researcher" ? "bounded_ephemeral" : "none",
  });
  const webResearchEnabled = input.model.network === "declared" && input.model.toolPermissions.includes("web_research");
  if (webResearchEnabled && (input.webResearch === undefined || input.webResearch.allowedDestinations.length === 0)) {
    throw new Error("declared web research requires exact security-sheet destinations");
  }
  if (!webResearchEnabled && input.webResearch !== undefined) throw new Error("web research policy requires its accepted capability");
  const webResearch = webResearchEnabled ? WebResearchPolicySchema.parse({
    schemaVersion: 1,
    destinations: input.webResearch!.destinations ??
      [...new Set(input.webResearch!.allowedDestinations)].sort().map((origin) => ({ origin, pathPrefix: "/" })),
    requiredRequest: input.webResearch!.requiredRequest ?? null,
    contentTypes: ["application/json", "application/xhtml+xml", "text/html", "text/markdown", "text/plain"],
    maxRedirects: 5,
    maxCompressedBytes: 2 * 1024 * 1024,
    maxDecompressedBytes: 4 * 1024 * 1024,
    timeoutMs: input.webResearch!.timeoutMs,
    budget: { maxRequests: input.webResearch!.requiredRequest === undefined ? 16 : 1,
      maxBytes: 16 * 1024 * 1024, maxTimeMs: input.webResearch!.timeoutMs },
  }) : null;
  if (access.readPaths.length === 0) throw new Error("role capability requires configured repository read scope");
  for (const writable of access.writePaths) {
    if (!access.readPaths.some((readable) => pathScopeContains(readable, writable))) {
      throw new Error(`owned write path is outside configured read scope: ${writable}`);
    }
    if (access.forbiddenPaths.some((forbidden) => pathScopesOverlap(forbidden, writable))) {
      throw new Error(`owned write path overlaps a forbidden path: ${writable}`);
    }
  }
  const body = BindingBodySchema.parse({
    schemaVersion: 1,
    milestoneId: input.milestoneId,
    taskId: input.taskId,
    projectId: input.projectId,
    correlationId: input.correlationId,
    role: input.role,
    actorId: input.actorId,
    planDigest: input.planDigest,
    securityDigest: input.securityDigest,
    modelDigest: input.model.digest,
    repositoryDigest: digestCanonical(input.repository),
    ownershipDigest: digestCanonical({ readPaths: access.readPaths, writePaths: access.writePaths, forbiddenPaths: access.forbiddenPaths }),
    budgetDigest: digestCanonical(input.budget),
    admissionDigest: input.admissionDigest,
    providerTransport: "host_model_provider",
    envelope: roleEnvelope(input.role, access, webResearch !== null),
    access,
    review: input.review ?? null,
    webResearch,
  });
  return RoleCapabilityBindingSchema.parse({ ...body, digest: bindingDigest(body) });
}

export function verifyRoleCapabilityBinding(
  rawBinding: RoleCapabilityBinding,
  expected: RoleCapabilityExpectedDigests,
): RoleCapabilityBinding {
  const binding = RoleCapabilityBindingSchema.parse(rawBinding);
  for (const key of ["planDigest", "securityDigest", "modelDigest", "repositoryDigest", "ownershipDigest", "budgetDigest", "admissionDigest"] as const) {
    if (binding[key] !== expected[key]) throw new Error(`role capability binding is stale: ${key}`);
  }
  return binding;
}

export class RoleCapabilityEnvelopeService {
  constructor(private readonly journal: EventJournal) {}

  accept(rawBinding: RoleCapabilityBinding): RoleCapabilityBinding {
    const binding = RoleCapabilityBindingSchema.parse(rawBinding);
    assertCurrentAdmission(this.journal, binding);
    const streamId = roleCapabilityStreamId(binding);
    const events = this.journal.readStream(streamId);
    const accepted = events.filter((event) => event.type === "capability_envelope.accepted")
      .map((event) => AcceptedPayloadSchema.parse(event.payload).binding);
    if (accepted.length > 0) {
      const existing = accepted[0]!;
      if (existing.digest !== binding.digest) throw new Error("role capability envelope substitution is forbidden");
      return existing;
    }
    this.journal.append(streamId, events.length, [{
      streamId,
      type: "capability_envelope.accepted",
      payload: AcceptedPayloadSchema.parse({ binding }),
      causationId: null,
      correlationId: binding.correlationId,
    }]);
    return binding;
  }

  verify(binding: RoleCapabilityBinding, expected: RoleCapabilityExpectedDigests): RoleCapabilityBinding {
    const verified = verifyRoleCapabilityBinding(binding, expected);
    const retained = this.inspect(verified).binding;
    if (retained === null || retained.digest !== verified.digest) throw new Error("role capability envelope substitution is forbidden");
    return verified;
  }

  evaluate(rawBinding: RoleCapabilityBinding, rawRequest: RoleCapabilityRequest): RoleCapabilityDecision {
    const binding = RoleCapabilityBindingSchema.parse(rawBinding);
    const request = RoleCapabilityRequestSchema.parse(rawRequest);
    const retained = this.inspect(binding).binding;
    if (retained === null || retained.digest !== binding.digest) throw new Error("role capability envelope substitution is forbidden");
    const decision = evaluateRoleCapabilityRequest(binding, request);
    const streamId = roleCapabilityStreamId(binding);
    const events = this.journal.readStream(streamId);
    this.journal.append(streamId, events.length, [{
      streamId,
      type: "capability_envelope.evaluated",
      payload: EvaluatedPayloadSchema.parse({ bindingDigest: binding.digest, request, decision }),
      causationId: events[0]?.eventId ?? null,
      correlationId: binding.correlationId,
    }]);
    return decision;
  }

  inspect(rawBinding: RoleCapabilityBinding): { readonly binding: RoleCapabilityBinding | null; readonly evaluationCount: number } {
    const expectedBinding = RoleCapabilityBindingSchema.parse(rawBinding);
    const streamId = roleCapabilityStreamId(expectedBinding);
    let binding: RoleCapabilityBinding | null = null;
    let evaluationCount = 0;
    for (const event of this.journal.readStream(streamId)) {
      if (event.streamId !== streamId || event.correlationId !== expectedBinding.correlationId) throw new Error("capability envelope event identity mismatch");
      if (event.type === "capability_envelope.accepted") {
        const candidate = AcceptedPayloadSchema.parse(event.payload).binding;
        if (binding !== null) throw new Error("duplicate role capability envelope acceptance");
        if (candidate.digest !== expectedBinding.digest || roleCapabilityStreamId(candidate) !== streamId) throw new Error("capability envelope stream binding mismatch");
        binding = candidate;
      } else if (event.type === "capability_envelope.evaluated") {
        const evaluation = EvaluatedPayloadSchema.parse(event.payload);
        if (binding === null || evaluation.bindingDigest !== binding.digest) throw new Error("capability evaluation has no accepted binding");
        const expected = evaluateRoleCapabilityRequest(binding, evaluation.request);
        if (digestCanonical(expected) !== digestCanonical(evaluation.decision)) throw new Error("forged capability evaluation decision");
        evaluationCount += 1;
      } else throw new Error(`unknown role capability event: ${event.type}`);
    }
    return Object.freeze({ binding, evaluationCount });
  }

  evaluationEvent(binding: RoleCapabilityBinding, decisionId: string): import("../contracts/event.js").StoredEvent {
    this.inspect(binding);
    const event = this.journal.readStream(roleCapabilityStreamId(binding)).find((candidate) => {
      if (candidate.type !== "capability_envelope.evaluated") return false;
      const payload = EvaluatedPayloadSchema.parse(candidate.payload);
      return payload.decision.decisionId === decisionId;
    });
    if (event === undefined) throw new Error("capability evaluation occurrence does not exist");
    return event;
  }
}

export function roleCapabilityStreamId(binding: Pick<RoleCapabilityBinding, "projectId" | "milestoneId" | "taskId" | "admissionDigest" | "digest">): string {
  return `capability-envelope:${digestCanonical({ projectId: binding.projectId, milestoneId: binding.milestoneId, taskId: binding.taskId })}:${binding.admissionDigest}:${binding.digest}`;
}

export function parseRoleCapabilityEventPayload(type: string, payload: unknown): unknown {
  return type === "capability_envelope.accepted"
    ? AcceptedPayloadSchema.parse(payload)
    : type === "capability_envelope.evaluated"
      ? EvaluatedPayloadSchema.parse(payload)
      : (() => { throw new Error(`unknown role capability event: ${type}`); })();
}

function roleEnvelope(role: GovernedRole, access: z.infer<typeof AccessSchema>, webResearch = false) {
  return capabilityEnvelope({
    role,
    authority: role === "implementer" ? "workspace_write" : role === "reviewer" ? "review" : "read_only",
    capabilities: [...roleToolPermissions(role, webResearch)] as ("read_repository" | "write_worktree" | "review_diff" | "web_research")[],
    network: webResearch ? "declared_web_research" : "model_provider_only",
    secrets: "none",
    effects: {
      worktree: role === "implementer" ? "assigned" : "none",
      pathExpansion: "none", integration: "none", release: "none", external: "none",
    },
    resources: {
      repository: role === "implementer" ? "assigned_worktree" : "read_only",
      readPaths: access.readPaths,
      writePaths: access.writePaths,
      forbiddenPaths: access.forbiddenPaths,
    },
  });
}

export function evaluateRoleCapabilityRequest(binding: RoleCapabilityBinding, request: RoleCapabilityRequest): RoleCapabilityDecision {
  const parsedBinding = RoleCapabilityBindingSchema.parse(binding);
  const parsedRequest = RoleCapabilityRequestSchema.parse(request);
  const result = evaluateRequestResult(parsedBinding, parsedRequest);
  const requestDigest = digestCanonical(parsedRequest);
  return RoleCapabilityDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: decisionId(parsedBinding.digest, requestDigest, result.status, result.reason),
    bindingDigest: parsedBinding.digest,
    requestDigest,
    effectPerformed: false,
    ...result,
  });
}

function evaluateRequestResult(binding: RoleCapabilityBinding, request: RoleCapabilityRequest): Pick<RoleCapabilityDecision, "status" | "reason"> {
  if (request.kind === "read" || request.kind === "search") {
    if (binding.access.forbiddenPaths.some((scope) => pathScopeContains(scope, request.path))) return { status: "attention", reason: "forbidden_path" };
    return binding.access.readPaths.some((scope) => pathScopeContains(scope, request.path))
      ? { status: "allowed", reason: "in_envelope" }
      : { status: "attention", reason: "forbidden_path" };
  }
  if (request.kind === "write") {
    if (binding.access.forbiddenPaths.some((scope) => pathScopesOverlap(scope, request.path))) return { status: "attention", reason: "forbidden_path" };
    return binding.role === "implementer" && binding.access.writePaths.some((scope) => pathScopeContains(scope, request.path))
      ? { status: "allowed", reason: "in_envelope" }
      : { status: "replan", reason: "path_not_owned" };
  }
  if (request.kind === "review") {
    if (binding.role !== "reviewer" || binding.review === null) return { status: "attention", reason: "forbidden_effect" };
    if (request.workerId === binding.actorId) return { status: "attention", reason: "self_review" };
    return digestCanonical({ workerId: request.workerId, diffSha256: request.diffSha256, validationSha256: request.validationSha256 }) === digestCanonical(binding.review)
      ? { status: "allowed", reason: "in_envelope" }
      : { status: "attention", reason: "stale_evidence" };
  }
  if (request.kind === "network") {
    if (binding.webResearch === null) return { status: "attention", reason: "network_disabled" };
    if ((request.capability ?? "web_research") !== "web_research") return { status: "attention", reason: "network_capability_not_allowed" };
    if ((request.method ?? "GET") !== "GET" && request.method !== "HEAD") return { status: "attention", reason: "network_method_not_allowed" };
    let candidate: URL;
    try { candidate = new URL(request.destination); } catch { return { status: "attention", reason: "network_destination_not_allowed" }; }
    if (binding.webResearch.requiredRequest !== null) {
      if ((request.method ?? "GET") !== binding.webResearch.requiredRequest.method) {
        return { status: "attention", reason: "network_method_not_allowed" };
      }
      if (candidate.href !== binding.webResearch.requiredRequest.url) {
        return { status: "attention", reason: "network_destination_not_allowed" };
      }
    }
    const allowed = binding.webResearch.destinations.some((destination) => researchDestinationAllows(destination, candidate));
    return allowed ? { status: "allowed", reason: "in_envelope" } : { status: "attention", reason: "network_destination_not_allowed" };
  }
  return { status: "attention", reason: "forbidden_effect" };
}

function decisionId(bindingDigest: string, requestDigest: string, status: string, reason: string): string {
  return digestCanonical({ bindingDigest, requestDigest, status, reason });
}

function assertCurrentAdmission(journal: EventJournal, binding: RoleCapabilityBinding): void {
  const milestoneEvents = journal.readStream(binding.milestoneId);
  if (!milestoneEvents.some((event) => event.type === "milestone.created")) return;
  const admission = [...milestoneEvents].reverse().find((event) => {
    if (event.type !== "milestone.task_ready" || typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return false;
    return (event.payload as Readonly<Record<string, unknown>>)["taskId"] === binding.taskId;
  });
  const admissionDigest = admission === undefined || typeof admission.payload !== "object" || admission.payload === null
    ? null
    : (admission.payload as Readonly<Record<string, unknown>>)["admissionDigest"];
  if (admissionDigest !== binding.admissionDigest) throw new Error("role capability binding requires the current durable task admission");
}

function bindingDigest(value: z.input<typeof BindingBodySchema> & { readonly digest?: string }): string {
  const { digest: _digest, ...body } = value;
  return digestCanonical(body);
}

function canonicalPaths(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameSet(first: readonly string[], second: readonly string[]): boolean {
  return JSON.stringify(canonicalPaths(first)) === JSON.stringify(canonicalPaths(second));
}

function pathScopeContains(scope: string, candidate: string): boolean {
  const canonicalScope = canonicalDarwinPath(scope);
  const canonicalCandidate = canonicalDarwinPath(candidate);
  if (canonicalScope.path === "") return true;
  return canonicalScope.recursive
    ? canonicalCandidate.path === canonicalScope.path || canonicalCandidate.path.startsWith(`${canonicalScope.path}/`)
    : !canonicalCandidate.recursive && canonicalCandidate.path === canonicalScope.path;
}

function pathScopesOverlap(first: string, second: string): boolean {
  const left = canonicalDarwinPath(first).path;
  const right = canonicalDarwinPath(second).path;
  return left === "" || right === "" || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function canonicalDarwinPath(value: string): { readonly path: string; readonly recursive: boolean } {
  const normalized = value.normalize("NFD").toLowerCase();
  if (normalized === "**") return { path: "", recursive: true };
  const recursive = normalized.endsWith("/**");
  return { path: recursive ? normalized.slice(0, -3) : normalized, recursive };
}

function isSafeLogicalPath(value: string): boolean {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r") || value.includes("\\")) return false;
  if (value.includes("*") && value !== "**" && (!value.endsWith("/**") || value.slice(0, -3).includes("*"))) return false;
  return value === "**" || value.replace(/\/\*\*$/, "").split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function assertCanonicalSet(values: readonly string[], context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    context.addIssue({ code: "custom", message: "paths must be sorted and unique" });
  }
}
