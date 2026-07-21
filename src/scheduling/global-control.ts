import { z } from "zod";
import type { StoredEvent } from "../contracts/event.js";
import { SchedulerBudgetSchema, SchedulerLimitsSchema, SchedulerResourceSchema,
  type SchedulerBudget, type SchedulerControlIdentity, type SchedulerLimits,
  type SchedulerResources, schedulerControlStreamId } from "./scheduler-contracts.js";

const Id = z.string().min(1);
const Reservation = z.strictObject({ schemaVersion: z.literal(1), dispatchId: z.string().uuid(),
  taskId: Id, schedulerId: Id, resources: SchedulerResourceSchema, budget: SchedulerBudgetSchema,
  reservedAtMs: z.number().int().nonnegative() });
const Usage = z.strictObject({ schemaVersion: z.literal(1), dispatchId: z.string().uuid(), taskId: Id,
  delta: SchedulerBudgetSchema, observedAtMs: z.number().int().nonnegative() });
const Release = z.strictObject({ schemaVersion: z.literal(1), dispatchId: z.string().uuid(), taskId: Id,
  resources: SchedulerResourceSchema, reservedBudget: SchedulerBudgetSchema, usedBudget: SchedulerBudgetSchema,
  unusedBudget: SchedulerBudgetSchema, releasedAtMs: z.number().int().nonnegative() });

export interface GlobalControlView {
  readonly identity: SchedulerControlIdentity | null;
  readonly limits: SchedulerLimits | null;
  readonly resources: SchedulerResources;
  readonly reservedBudget: SchedulerBudget;
  readonly spentBudget: SchedulerBudget;
  readonly allocations: Readonly<Record<string, { readonly taskId: string; readonly schedulerId: string;
    readonly resources: SchedulerResources; readonly budget: SchedulerBudget; readonly used: SchedulerBudget }>>;
  readonly streamVersion: number;
}

export function projectGlobalControl(events: readonly StoredEvent[]): GlobalControlView {
  let identity: SchedulerControlIdentity | null = null;
  let limits: SchedulerLimits | null = null;
  const resources = zeroResources(); const reservedBudget = zeroBudget(); const spentBudget = zeroBudget();
  const allocations: Record<string, { taskId: string; schedulerId: string; resources: SchedulerResources;
    budget: SchedulerBudget; used: SchedulerBudget }> = {};
  let streamVersion = 0;
  for (const event of events) {
    streamVersion = event.streamVersion;
    if (event.type === "scheduler_control.initialized") {
      if (identity !== null) throw new Error("scheduler control was initialized more than once");
      const payload = z.strictObject({ schemaVersion: z.literal(1), identity: z.object({
        controlPlaneId: Id, repositoryIdentity: z.string().startsWith("/") }), limits: SchedulerLimitsSchema }).parse(event.payload);
      if (event.streamId !== schedulerControlStreamId(payload.identity)) throw new Error("scheduler control identity mismatch");
      identity = payload.identity; limits = payload.limits;
    } else if (event.type === "scheduler_control.dispatch_reserved") {
      if (limits === null) throw new Error("scheduler control is not initialized");
      const payload = Reservation.parse(event.payload);
      if (allocations[payload.dispatchId] !== undefined) throw new Error("duplicate global dispatch reservation");
      add(resources, payload.resources, 1); add(reservedBudget, payload.budget, 1);
      assertFits(resources, limits.resources, "global resource capacity");
      assertCombinedBudget(reservedBudget, spentBudget, limits.budget);
      allocations[payload.dispatchId] = { taskId: payload.taskId, schedulerId: payload.schedulerId,
        resources: payload.resources, budget: payload.budget, used: zeroBudget() };
    } else if (event.type === "scheduler_control.usage_recorded") {
      const payload = Usage.parse(event.payload); const allocation = allocations[payload.dispatchId];
      if (allocation === undefined || allocation.taskId !== payload.taskId) throw new Error("usage has no global reservation");
      add(allocation.used, payload.delta, 1);
      assertFits(allocation.used, allocation.budget, "dispatch budget");
    } else if (event.type === "scheduler_control.dispatch_released") {
      const payload = Release.parse(event.payload); const allocation = allocations[payload.dispatchId];
      if (allocation === undefined || allocation.taskId !== payload.taskId ||
        JSON.stringify(allocation.resources) !== JSON.stringify(payload.resources) ||
        JSON.stringify(allocation.budget) !== JSON.stringify(payload.reservedBudget) ||
        JSON.stringify(allocation.used) !== JSON.stringify(payload.usedBudget) ||
        JSON.stringify(subtract(allocation.budget, allocation.used)) !== JSON.stringify(payload.unusedBudget)) {
        throw new Error("global release evidence does not match the exact reservation and usage");
      }
      add(resources, allocation.resources, -1); add(reservedBudget, allocation.budget, -1);
      add(spentBudget, allocation.used, 1); delete allocations[payload.dispatchId];
      if (limits !== null) assertFits(spentBudget, limits.budget, "global spent budget");
    } else throw new Error(`unknown scheduler control event ${event.type}`);
  }
  return Object.freeze({ identity, limits, resources: Object.freeze(resources),
    reservedBudget: Object.freeze(reservedBudget), spentBudget: Object.freeze(spentBudget),
    allocations: Object.freeze(allocations), streamVersion });
}
export function zeroBudget(): SchedulerBudget { return { seconds: 0, inputTokens: 0, outputTokens: 0, costUsdNano: 0 }; }
export function zeroResources(): SchedulerResources { return { reasoning: 0, writers: 0, heavyValidation: 0, review: 0, integration: 0 }; }
export function add<T extends Record<string, number>>(target: T, value: T, direction: 1 | -1): void {
  const mutable = target as Record<string, number>; for (const key of Object.keys(target)) mutable[key] = mutable[key]! + direction * value[key]!;
}
export function fits<T extends Record<string, number>>(used: T, request: T, limit: T): boolean {
  return Object.keys(limit).every((key) => used[key]! + request[key]! <= limit[key]!);
}
function assertFits<T extends Record<string, number>>(used: T, limit: T, label: string): void {
  if (Object.keys(limit).some((key) => used[key]! < 0 || used[key]! > limit[key]!)) throw new Error(`${label} exceeded`);
}
function assertCombinedBudget(reserved: SchedulerBudget, spent: SchedulerBudget, limit: SchedulerBudget): void {
  if (Object.keys(limit).some((key) => reserved[key as keyof SchedulerBudget] + spent[key as keyof SchedulerBudget] > limit[key as keyof SchedulerBudget])) throw new Error("global budget exceeded");
}
export function subtract(total: SchedulerBudget, used: SchedulerBudget): SchedulerBudget {
  return { seconds: total.seconds - used.seconds, inputTokens: total.inputTokens - used.inputTokens,
    outputTokens: total.outputTokens - used.outputTokens, costUsdNano: total.costUsdNano - used.costUsdNano };
}
