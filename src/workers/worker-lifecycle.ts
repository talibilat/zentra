import { createHash } from "node:crypto";

import { z } from "zod";

import type { NewEvent, StoredEvent } from "../contracts/event.js";
import { AuthorityLevelSchema, MilestoneRoleSchema } from "../contracts/milestone.js";
import { TerminalOutcomeSchema, type TerminalOutcome } from "../contracts/task.js";
import type { EventJournal } from "../journal/journal.js";

const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PathSchema = z.string().min(1).max(4_096).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
  "resource path must be a safe logical relative scope",
);
const SortedPathsSchema = z.array(PathSchema).max(256).superRefine(assertSortedUnique);

export const WorkerCapabilitySchema = z.enum([
  "read_repository", "write_worktree", "run_validation", "review_diff", "integrate", "web_research",
]);
export const WorkerNetworkSchema = z.enum(["denied", "model_provider_only", "declared_web_research"]);
export const WorkerHarnessSchema = z.enum(["opencode", "deterministic"]);
const CapabilitySetSchema = z.array(WorkerCapabilitySchema).max(16).superRefine(assertSortedUnique);
const TaskContextSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("standalone") }),
  z.strictObject({ kind: z.literal("milestone"), milestoneId: IdSchema }),
]);

const LegacyResourcesSchema = z.strictObject({
  repository: z.enum(["none", "read_only", "assigned_worktree"]),
  paths: SortedPathsSchema,
  forbiddenPaths: SortedPathsSchema,
});
const CanonicalResourcesSchema = z.strictObject({
  repository: z.enum(["none", "read_only", "assigned_worktree"]),
  readPaths: SortedPathsSchema,
  writePaths: SortedPathsSchema,
  forbiddenPaths: SortedPathsSchema,
});
const EnvelopeBaseShape = {
  role: MilestoneRoleSchema,
  authority: AuthorityLevelSchema,
  capabilities: CapabilitySetSchema,
  network: WorkerNetworkSchema,
  secrets: z.literal("none"),
  effects: z.strictObject({
    worktree: z.enum(["none", "assigned"]),
    pathExpansion: z.literal("none"),
    integration: z.enum(["none", "zentra_only"]),
    release: z.enum(["none", "zentra_only"]),
    external: z.literal("none"),
  }),
} as const;
const LegacyEnvelopeBodySchema = z.strictObject({ ...EnvelopeBaseShape, resources: LegacyResourcesSchema });
const CanonicalEnvelopeBodySchema = z.strictObject({ ...EnvelopeBaseShape, resources: CanonicalResourcesSchema });
const EnvelopeBodySchema = z.union([CanonicalEnvelopeBodySchema, LegacyEnvelopeBodySchema]);

export const CapabilityEnvelopeSchema = z.union([
  CanonicalEnvelopeBodySchema.extend({ digest: DigestSchema }),
  LegacyEnvelopeBodySchema.extend({ digest: DigestSchema }),
]).superRefine((value, context) => {
  if (value.digest !== envelopeDigest(value)) context.addIssue({ code: "custom", message: "capability envelope digest mismatch" });
  if (value.network === "declared_web_research" && !value.capabilities.includes("web_research")) {
    context.addIssue({ code: "custom", message: "declared web research requires its reserved capability" });
  }
  if (value.capabilities.includes("web_research")) {
    if (value.network !== "declared_web_research") context.addIssue({ code: "custom", message: "web research requires declared network policy" });
    if (value.role !== "planner" && value.role !== "researcher") context.addIssue({ code: "custom", message: "web research requires a planner or researcher role" });
  }
  const expectedAuthority = {
    planner: "read_only", researcher: "read_only", implementer: "workspace_write",
    validator: "validation", reviewer: "review", integrator: "integration",
    verifier: "local_release_preparation",
  }[value.role];
  if (value.authority !== expectedAuthority) context.addIssue({ code: "custom", message: "role and authority do not match" });
  if (value.capabilities.includes("write_worktree") !== (value.effects.worktree === "assigned" && value.resources.repository === "assigned_worktree")) {
    context.addIssue({ code: "custom", message: "worktree capability and resource authority do not match" });
  }
  if (value.capabilities.includes("integrate") !== (value.effects.integration === "zentra_only") || (value.capabilities.includes("integrate") && value.authority !== "integration")) {
    context.addIssue({ code: "custom", message: "integration capability and authority do not match" });
  }
  if ((value.resources.repository === "read_only" || value.resources.repository === "assigned_worktree") !== value.capabilities.includes("read_repository")) {
    context.addIssue({ code: "custom", message: "repository resource and read capability do not match" });
  }
  const readPaths = envelopeReadPaths(value);
  const writePaths = envelopeWritePaths(value);
  if (value.resources.repository === "none" && (readPaths.length !== 0 || writePaths.length !== 0 || value.capabilities.includes("read_repository") || value.capabilities.includes("write_worktree"))) {
    context.addIssue({ code: "custom", message: "repository none cannot retain paths or repository capabilities" });
  }
  if (value.resources.repository !== "assigned_worktree" && writePaths.length !== 0) context.addIssue({ code: "custom", message: "only an assigned worktree may retain write paths" });
  if (value.resources.repository === "assigned_worktree" && writePaths.length === 0) context.addIssue({ code: "custom", message: "assigned worktree requires write paths" });
  if (value.capabilities.includes("review_diff") && value.authority !== "review") context.addIssue({ code: "custom", message: "review capability requires review authority" });
  if (value.capabilities.includes("run_validation") && value.authority !== "validation") context.addIssue({ code: "custom", message: "validation capability requires validation authority" });
});

export const WorkerBudgetSchema = z.strictObject({
  budgetId: IdSchema,
  maxSeconds: z.number().nonnegative().max(86_400),
  maxCostUsd: z.number().nonnegative().max(10_000),
  maxInputTokens: z.number().int().nonnegative().max(2_000_000),
  maxOutputTokens: z.number().int().nonnegative().max(2_000_000),
  maxToolCalls: z.number().int().nonnegative().max(100_000),
  maxModelTurns: z.number().int().nonnegative().max(100_000),
  maxActiveWorkers: z.number().int().positive().max(1_000),
  maxConcurrentTools: z.number().int().positive().max(1_000),
  maxConcurrentModelTurns: z.number().int().positive().max(1_000),
});

export const WorkerUsageSchema = z.strictObject({
  seconds: z.number().nonnegative().max(86_400),
  inputTokens: z.number().int().nonnegative().max(2_000_000),
  outputTokens: z.number().int().nonnegative().max(2_000_000),
  costUsd: z.number().nonnegative().max(10_000),
  toolCalls: z.number().int().nonnegative().max(100_000),
  modelTurns: z.number().int().nonnegative().max(100_000),
});

export const WorkerBindingSchema = z.strictObject({
  schemaVersion: z.literal(1), workerId: IdSchema, taskId: IdSchema, rootTaskId: IdSchema,
  parentWorkerId: IdSchema.nullable(), harness: WorkerHarnessSchema, role: MilestoneRoleSchema,
  model: z.strictObject({ capabilityId: IdSchema, modelId: z.string().min(1).max(512) }).nullable(),
  envelope: CapabilityEnvelopeSchema, budget: WorkerBudgetSchema,
  taskContext: TaskContextSchema,
  trace: z.strictObject({ traceId: z.string().min(1).max(512), correlationId: z.string().min(1).max(512) }),
});

const IdentitySchema = z.strictObject({
  schemaVersion: z.literal(1), workerId: IdSchema, taskId: IdSchema, rootTaskId: IdSchema,
  parentWorkerId: IdSchema.nullable(), role: MilestoneRoleSchema, taskContext: TaskContextSchema,
});
export const WorkerObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["process", "resource"]), name: z.string().min(1).max(512), outcome: z.union([TerminalOutcomeSchema, z.literal("uncertain")]) }),
  z.strictObject({ kind: z.enum(["tool", "model"]), name: z.string().min(1).max(512), phase: z.enum(["started", "completed"]), outcome: TerminalOutcomeSchema.nullable(), usage: WorkerUsageSchema }),
]);
const StartedSchema = IdentitySchema;
const ObservedSchema = IdentitySchema.extend({ observation: WorkerObservationSchema });
const CleanupSchema = IdentitySchema.extend({ outcome: z.enum(["completed", "uncertain"]) });
const UncertainSchema = IdentitySchema.extend({ reason: z.string().min(1).max(4_096) });
const TerminalSchema = IdentitySchema.extend({ outcome: TerminalOutcomeSchema });

export type CapabilityEnvelope = z.infer<typeof CapabilityEnvelopeSchema>;
export type WorkerBudget = z.infer<typeof WorkerBudgetSchema>;
export type WorkerUsage = z.infer<typeof WorkerUsageSchema>;
export type WorkerBinding = z.infer<typeof WorkerBindingSchema>;
export type WorkerObservation = z.infer<typeof WorkerObservationSchema>;

export interface WorkerView extends WorkerBinding {
  readonly status: "bound" | "running" | "uncertain" | "cleaned" | "terminal";
  readonly cleanup: "completed" | "uncertain" | null;
  readonly terminalOutcome: TerminalOutcome | null;
  readonly usage: WorkerUsage;
  readonly activeTools: number;
  readonly activeModelTurns: number;
}
export interface WorkerLifecycleView {
  readonly rootTaskId: string | null;
  readonly workers: Readonly<Record<string, WorkerView>>;
  readonly budget: { readonly limits: WorkerBudget; readonly usage: WorkerUsage; readonly activeWorkers: number } | null;
}

const ZERO: WorkerUsage = Object.freeze({ seconds: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, modelTurns: 0 });

export function capabilityEnvelope(raw: z.input<typeof EnvelopeBodySchema>): CapabilityEnvelope {
  const resources = "paths" in raw.resources
    ? { ...raw.resources, paths: [...new Set(raw.resources.paths)].sort(), forbiddenPaths: [...new Set(raw.resources.forbiddenPaths)].sort() }
    : { ...raw.resources, readPaths: [...new Set(raw.resources.readPaths)].sort(), writePaths: [...new Set(raw.resources.writePaths)].sort(), forbiddenPaths: [...new Set(raw.resources.forbiddenPaths)].sort() };
  const body = EnvelopeBodySchema.parse({
    ...raw,
    capabilities: [...new Set(raw.capabilities)].sort(),
    resources,
  });
  return CapabilityEnvelopeSchema.parse({ ...body, digest: envelopeDigest(body) });
}

export function projectWorkerLifecycle(events: readonly StoredEvent[]): WorkerLifecycleView {
  const workerEvents = events.filter((event) => event.type.startsWith("worker."));
  const workers: Record<string, MutableWorker> = {};
  let rootTaskId: string | null = null;
  let budget: MutableBudget | null = null;
  for (const event of workerEvents) {
    if (event.type === "worker.bound") {
      const binding = WorkerBindingSchema.parse(event.payload);
      rootTaskId ??= binding.rootTaskId;
      if (binding.rootTaskId !== rootTaskId || event.streamId !== workerStreamId(rootTaskId)) throw new Error("worker event is outside its root task stream");
      if (workers[binding.workerId] !== undefined) throw new Error("duplicate worker identity");
      if (binding.parentWorkerId === binding.workerId) throw new Error("worker parent cycle detected");
      const parent = binding.parentWorkerId === null ? null : workers[binding.parentWorkerId];
      if (parent === undefined) throw new Error("unknown worker parent");
      if (parent !== null) assertNested(binding, parent);
      if (budget === null) budget = { limits: binding.budget, usage: { ...ZERO }, activeWorkers: 0, activeTools: 0, activeModelTurns: 0 };
      else if (JSON.stringify(budget.limits) !== JSON.stringify(binding.budget)) throw new Error("shared task budget changed");
      workers[binding.workerId] = { ...binding, status: "bound", cleanup: null, terminalOutcome: null, usage: { ...ZERO }, activeTools: 0, activeModelTurns: 0 };
      continue;
    }
    const payload = parsePayload(event.type, event.payload);
    if (rootTaskId === null || payload.rootTaskId !== rootTaskId || event.streamId !== workerStreamId(rootTaskId)) throw new Error("worker event is outside its root task stream");
    const worker = workers[payload.workerId];
    if (worker === undefined || worker.taskId !== payload.taskId) throw new Error("worker event has unknown identity");
    if (worker.status === "terminal") throw new Error("worker is already terminal");
    if (event.type === "worker.started") {
      if (worker.status !== "bound") throw new Error("worker start is out of order");
      if (budget!.activeWorkers >= budget!.limits.maxActiveWorkers) throw new Error("active worker budget exceeded");
      budget!.activeWorkers += 1;
      worker.status = "running";
    } else if (event.type === "worker.observed") {
      const observation = (payload as z.infer<typeof ObservedSchema>).observation;
      if (worker.status !== "running" && !(worker.status === "bound" && (observation.kind === "process" || observation.kind === "resource"))) throw new Error("worker observation is out of order");
      applyObservation(worker, budget!, observation);
    } else if (event.type === "worker.uncertain") {
      if (worker.status !== "bound" && worker.status !== "running") throw new Error("worker uncertainty is out of order");
      if (worker.status === "running") {
        budget!.activeWorkers -= 1;
      }
      worker.status = "uncertain";
    } else if (event.type === "worker.cleanup_observed") {
      if (worker.status !== "bound" && worker.status !== "running" && worker.status !== "uncertain") throw new Error("worker cleanup is out of order");
      if (worker.status === "running") {
        budget!.activeWorkers -= 1;
      }
      worker.cleanup = (payload as z.infer<typeof CleanupSchema>).outcome;
      if ((payload as z.infer<typeof CleanupSchema>).outcome === "completed") {
        if (worker.activeTools !== 0 || worker.activeModelTurns !== 0) throw new Error("completed cleanup has unresolved activity reservations");
        if (worker.status !== "uncertain") worker.status = "cleaned";
      } else {
        worker.status = "uncertain";
      }
    } else {
      if (worker.status !== "cleaned") throw new Error("worker terminal requires cleanup");
      const terminal = payload as z.infer<typeof TerminalSchema>;
      if (worker.activeTools !== 0 || worker.activeModelTurns !== 0 || budget!.activeTools !== 0 || budget!.activeModelTurns !== 0) {
        throw new Error("worker terminal has unresolved activity reservations");
      }
      if (terminal.outcome === "completed" && worker.cleanup !== "completed") throw new Error("completed worker requires completed cleanup");
      worker.status = "terminal";
      worker.terminalOutcome = terminal.outcome;
    }
  }
  return Object.freeze({ rootTaskId, workers: freeze(workers), budget: budget === null ? null : Object.freeze(budget) });
}

export class WorkerLifecycleService {
  constructor(private readonly journal: EventJournal) {}

  bind(binding: WorkerBinding): WorkerView { return this.append(binding.rootTaskId, binding.workerId, "worker.bound", WorkerBindingSchema.parse(binding)); }
  start(rootTaskId: string, workerId: string): WorkerView { return this.appendIdentity(rootTaskId, workerId, "worker.started", {}); }
  observe(rootTaskId: string, workerId: string, observation: WorkerObservation): WorkerView { return this.appendIdentity(rootTaskId, workerId, "worker.observed", { observation: WorkerObservationSchema.parse(observation) }); }
  uncertain(rootTaskId: string, workerId: string, reason: string): WorkerView { return this.appendIdentity(rootTaskId, workerId, "worker.uncertain", { reason }); }
  cleanup(rootTaskId: string, workerId: string, outcome: "completed" | "uncertain"): WorkerView { return this.appendIdentity(rootTaskId, workerId, "worker.cleanup_observed", { outcome }); }
  terminate(rootTaskId: string, workerId: string, outcome: TerminalOutcome): WorkerView { return this.appendIdentity(rootTaskId, workerId, "worker.terminal", { outcome }); }
  inspect(rootTaskId: string): WorkerLifecycleView { return projectWorkerLifecycle(this.journal.readStream(workerStreamId(rootTaskId))); }

  private appendIdentity(rootTaskId: string, workerId: string, type: string, extra: object): WorkerView {
    const worker = this.inspect(rootTaskId).workers[workerId];
    if (worker === undefined) throw new Error("worker event requires a durable binding");
    return this.append(rootTaskId, workerId, type, { schemaVersion: 1, workerId, taskId: worker.taskId, rootTaskId, parentWorkerId: worker.parentWorkerId, role: worker.role, taskContext: worker.taskContext, ...extra });
  }
  private append(rootTaskId: string, workerId: string, type: string, payload: unknown): WorkerView {
    const streamId = workerStreamId(rootTaskId);
    const events = this.journal.readStream(streamId);
    const correlationId = bindingCorrelation(payload) ?? events[0]?.correlationId;
    if (correlationId === undefined) throw new Error("worker event requires a durable binding");
    const next: NewEvent<string, unknown> = { streamId, type, payload, causationId: null, correlationId };
    const prospective: StoredEvent = { ...next, eventId: "prospective", streamVersion: events.length + 1, globalPosition: events.length + 1, recordedAt: new Date().toISOString() };
    const projected = projectWorkerLifecycle([...events, prospective]);
    this.journal.append(streamId, events.length, [next]);
    return projected.workers[workerId]!;
  }
}

export function workerStreamId(rootTaskId: string): string { return `worker-task:${rootTaskId}`; }
export function parseWorkerEventPayload(type: string, payload: unknown): unknown { return type === "worker.bound" ? WorkerBindingSchema.parse(payload) : parsePayload(type, payload); }

function assertNested(binding: WorkerBinding, parent: MutableWorker): void {
  if (parent.status === "terminal" || parent.status === "uncertain") throw new Error("worker parent is not delegatable");
  if (binding.taskId !== parent.taskId || binding.rootTaskId !== parent.rootTaskId || binding.budget.budgetId !== parent.budget.budgetId || binding.harness !== parent.harness) throw new Error("nested worker changed root authority");
  if (binding.trace.traceId !== parent.trace.traceId || binding.trace.correlationId !== parent.trace.correlationId || JSON.stringify(binding.taskContext) !== JSON.stringify(parent.taskContext)) throw new Error("nested worker changed trace identity");
  if (!authorityCanNarrow(parent.envelope.authority, binding.envelope.authority) || !capabilitiesCanNarrow(parent.envelope.capabilities, binding.envelope.capabilities)) throw new Error("nested worker authority expansion");
  if (!networkCanNarrow(parent.envelope.network, binding.envelope.network)) throw new Error("nested worker network expansion");
  if (!repositoryCanNarrow(parent.envelope.resources.repository, binding.envelope.resources.repository)) throw new Error("nested worker repository expansion");
  if (!effectsCanNarrow(parent.envelope.effects, binding.envelope.effects)) throw new Error("nested worker effect expansion");
  const parentReads = envelopeReadPaths(parent.envelope);
  const childReads = envelopeReadPaths(binding.envelope);
  const parentWrites = envelopeWritePaths(parent.envelope);
  const childWrites = envelopeWritePaths(binding.envelope);
  if (!childReads.every((child) => parentReads.some((scope) => pathContains(scope, child)))) throw new Error("nested worker read path expansion");
  const exactAssignedScope = binding.envelope.resources.repository === "assigned_worktree";
  if (exactAssignedScope
    ? JSON.stringify(childWrites) !== JSON.stringify(parentWrites)
    : !childWrites.every((child) => parentWrites.some((scope) => pathContains(scope, child)))) throw new Error("nested worker write path expansion");
  if (!parent.envelope.resources.forbiddenPaths.every((scope) => binding.envelope.resources.forbiddenPaths.includes(scope))) throw new Error("nested worker removed forbidden paths");
  if (binding.envelope.secrets !== "none" || binding.envelope.effects.integration !== "none" || binding.envelope.effects.release !== "none" || binding.envelope.effects.external !== "none") throw new Error("nested worker effect authority is forbidden");
}

function applyObservation(worker: MutableWorker, budget: MutableBudget, observation: WorkerObservation): void {
  if (!("phase" in observation)) return;
  const counter = observation.kind === "tool" ? "activeTools" : "activeModelTurns";
  const maximum = observation.kind === "tool" ? budget.limits.maxConcurrentTools : budget.limits.maxConcurrentModelTurns;
  if (observation.phase === "started") {
    if (observation.outcome !== null || !zeroUsage(observation.usage)) throw new Error("activity start cannot claim usage or outcome");
    if (budget[counter] >= maximum) throw new Error("concurrent activity budget exceeded");
    worker[counter] += 1;
    budget[counter] += 1;
    return;
  }
  if (worker[counter] <= 0 || observation.outcome === null) throw new Error("activity completion has no reservation");
  worker[counter] -= 1;
  budget[counter] -= 1;
  const next = add(budget.usage, observation.usage);
  if (next.seconds > budget.limits.maxSeconds || next.costUsd > budget.limits.maxCostUsd || next.inputTokens > budget.limits.maxInputTokens || next.outputTokens > budget.limits.maxOutputTokens || next.toolCalls > budget.limits.maxToolCalls || next.modelTurns > budget.limits.maxModelTurns) throw new Error("worker task budget exceeded");
  budget.usage = next;
  worker.usage = add(worker.usage, observation.usage);
}

function parsePayload(type: string, payload: unknown) {
  const schema = type === "worker.started" ? StartedSchema : type === "worker.observed" ? ObservedSchema : type === "worker.cleanup_observed" ? CleanupSchema : type === "worker.uncertain" ? UncertainSchema : type === "worker.terminal" ? TerminalSchema : null;
  if (schema === null) throw new Error(`unknown worker event type: ${type}`);
  return schema.parse(payload);
}
function envelopeDigest(value: z.input<typeof EnvelopeBodySchema> & { readonly digest?: string }): string {
  const { digest: _digest, ...body } = value;
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}
function assertSortedUnique(values: readonly string[], context: z.RefinementCtx): void { if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]! >= value)) context.addIssue({ code: "custom", message: "values must be sorted and unique" }); }
function subset<T>(values: readonly T[], parent: readonly T[]): boolean { const allowed = new Set(parent); return values.every((value) => allowed.has(value)); }
export function authorityCanNarrow(parent: z.infer<typeof AuthorityLevelSchema>, child: z.infer<typeof AuthorityLevelSchema>): boolean {
  return child === parent || child === "read_only";
}
export function networkCanNarrow(parent: z.infer<typeof WorkerNetworkSchema>, child: z.infer<typeof WorkerNetworkSchema>): boolean {
  return child === parent || (parent === "declared_web_research" && (child === "model_provider_only" || child === "denied")) ||
    (parent === "model_provider_only" && child === "denied");
}
export function repositoryCanNarrow(parent: CapabilityEnvelope["resources"]["repository"], child: CapabilityEnvelope["resources"]["repository"]): boolean {
  return child === parent || (parent === "assigned_worktree" && (child === "read_only" || child === "none")) || (parent === "read_only" && child === "none");
}
function effectsCanNarrow(parent: CapabilityEnvelope["effects"], child: CapabilityEnvelope["effects"]): boolean {
  return effectCanNarrow(parent.worktree, child.worktree) && effectCanNarrow(parent.integration, child.integration) &&
    effectCanNarrow(parent.release, child.release) && parent.pathExpansion === child.pathExpansion && parent.external === child.external;
}
export function effectCanNarrow(parent: "none" | "assigned" | "zentra_only", child: "none" | "assigned" | "zentra_only"): boolean {
  return child === parent || child === "none";
}
export function capabilitiesCanNarrow(parent: readonly z.infer<typeof WorkerCapabilitySchema>[], child: readonly z.infer<typeof WorkerCapabilitySchema>[]): boolean {
  return subset(child, parent);
}
export function envelopeReadPaths(envelope: CapabilityEnvelope): readonly string[] {
  return "readPaths" in envelope.resources ? envelope.resources.readPaths : envelope.resources.paths;
}
export function envelopeWritePaths(envelope: CapabilityEnvelope): readonly string[] {
  if ("writePaths" in envelope.resources) return envelope.resources.writePaths;
  return envelope.resources.repository === "assigned_worktree" ? envelope.resources.paths : [];
}
function pathContains(parent: string, child: string): boolean { if (parent === child || parent === "**") return true; return parent.endsWith("/**") && child.startsWith(parent.slice(0, -3) + "/"); }
function add(a: WorkerUsage, b: WorkerUsage): WorkerUsage { return { seconds: a.seconds + b.seconds, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, costUsd: a.costUsd + b.costUsd, toolCalls: a.toolCalls + b.toolCalls, modelTurns: a.modelTurns + b.modelTurns }; }
function zeroUsage(value: WorkerUsage): boolean { return Object.values(value).every((item) => item === 0); }
function bindingCorrelation(payload: unknown): string | undefined { const parsed = WorkerBindingSchema.safeParse(payload); return parsed.success ? parsed.data.trace.correlationId : undefined; }
function freeze<T extends object>(record: Record<string, T>): Readonly<Record<string, T>> { for (const value of Object.values(record)) Object.freeze(value); return Object.freeze(record); }

interface MutableWorker extends WorkerBinding { status: "bound" | "running" | "uncertain" | "cleaned" | "terminal"; cleanup: "completed" | "uncertain" | null; terminalOutcome: TerminalOutcome | null; usage: WorkerUsage; activeTools: number; activeModelTurns: number; }
interface MutableBudget { readonly limits: WorkerBudget; usage: WorkerUsage; activeWorkers: number; activeTools: number; activeModelTurns: number; }
