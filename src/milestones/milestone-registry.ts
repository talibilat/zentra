import { realpathSync, statSync } from "node:fs";

import type { NewEvent, StoredEvent } from "../contracts/event.js";
import type { MilestonePlan } from "../contracts/milestone.js";
import {
  admissionPacketDigest,
  createOpenCodeAdmissionPacket,
  OpenCodeTaskAdmissionContextSchema,
  PlanReplacementPayloadSchema,
  type OpenCodeAdmissionPacket,
  type OpenCodeTaskAdmissionContext,
} from "../contracts/authority-attention.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { EventJournal } from "../journal/journal.js";
import { projectMilestone, type MilestoneView } from "./milestone-projection.js";
import { assessMilestonePlanReadiness } from "./plan-readiness.js";

export interface RegisterMilestoneInput {
  readonly milestoneId: string;
  readonly projectId: string;
  readonly title: string;
  readonly correlationId: string;
  readonly tracePath?: string;
  readonly plan?: MilestonePlan;
}

export interface MilestoneSummary {
  readonly milestoneId: string;
  readonly projectId: string;
  readonly title: string;
  readonly lifecycle: MilestoneView["lifecycle"];
  readonly terminalOutcome: MilestoneView["terminalOutcome"];
  readonly streamVersion: number;
  readonly traceId: string;
  readonly tracePath: string | null;
  readonly taskCount: number;
}

export interface MilestoneRecord extends MilestoneView {
  readonly traceId: string;
  readonly tracePath: string | null;
}

export type TaskAdmissionResult =
  | {
    readonly status: "admitted";
    readonly milestone: MilestoneRecord;
    readonly admission: { readonly packet: OpenCodeAdmissionPacket; readonly digest: string };
  }
  | { readonly status: "paused"; readonly milestone: MilestoneRecord; readonly attention: NonNullable<MilestoneRecord["attention"]> };

export type { OpenCodeTaskAdmissionContext };

export interface ReplaceMilestonePlanInput {
  readonly milestoneId: string;
  readonly attentionId: string;
  readonly priorPlanDigest: string;
  readonly priorSecurityDigest: string;
  readonly replacementPlan: MilestonePlan;
}

export class MilestoneRegistry {
  constructor(private readonly journal: EventJournal) {}

  register(input: RegisterMilestoneInput): MilestoneView {
    const existing = this.inspect(input.milestoneId);
    if (existing !== null) throw new Error(`milestone ${input.milestoneId} already exists`);
    const events: NewEvent<string, unknown>[] = [{
      streamId: input.milestoneId,
      type: "milestone.created",
      payload: canonicalPayload({
        projectId: input.projectId,
        title: input.title,
        ...(input.tracePath === undefined ? {} : { tracePath: input.tracePath }),
      }),
      causationId: null,
      correlationId: input.correlationId,
    }];
    if (input.plan !== undefined) {
      events.push({
        streamId: input.milestoneId,
        type: "milestone.plan_created",
        payload: canonicalPayload({ plan: input.plan }),
        causationId: null,
        correlationId: input.correlationId,
      });
    }
    projectMilestone(events.map((event, index) => ({
      ...event,
      eventId: "",
      streamVersion: index + 1,
      globalPosition: 0,
      recordedAt: "2026-01-01T00:00:00.000Z",
    })));
    const stored = this.journal.append(input.milestoneId, 0, events);
    const view = projectMilestone(stored);
    if (view === null) throw new Error("projection should not be null after milestone registration");
    return withTrace(view, stored);
  }

  list(): readonly MilestoneSummary[] {
    const streamIds = new Set<string>();
    for (const event of this.journal.readAll()) {
      if (event.type.startsWith("milestone.")) streamIds.add(event.streamId);
    }
    return Object.freeze([...streamIds].sort().map((streamId) => {
      const events = this.journal.readStream(streamId);
      const view = projectMilestone(events);
      if (view === null) throw new Error(`milestone ${streamId} has no view`);
      return Object.freeze({
        milestoneId: view.milestoneId,
        projectId: view.projectId,
        title: view.title,
        lifecycle: view.lifecycle,
        terminalOutcome: view.terminalOutcome,
        streamVersion: view.streamVersion,
        traceId: events[0]!.correlationId,
        tracePath: tracePathFrom(events[0]!),
        taskCount: view.plan?.tasks.length ?? 0,
      });
    }));
  }

  admitTask(
    milestoneId: string,
    taskId: string,
    security: SecuritySheet,
    rawContext: OpenCodeTaskAdmissionContext,
  ): TaskAdmissionResult {
    const context = OpenCodeTaskAdmissionContextSchema.parse(rawContext);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const events = this.journal.readStream(milestoneId);
      const view = projectMilestone(events);
      if (view === null) throw new Error(`milestone ${milestoneId} does not exist`);
      const canonicalRepository = canonicalDirectory(context.repositoryPath);
      const packet = createOpenCodeAdmissionPacket({
        plan: view.plan,
        milestoneId,
        taskId,
        security,
        canonicalRepository,
        actorId: context.actorId,
        harness: context.harness,
        role: context.role,
        capabilityId: context.capabilityId,
        transportModelId: context.transportModelId,
        authority: context.authority,
        roles: context.roles,
        toolPermissions: context.toolPermissions,
        network: context.network,
        contextTokens: context.contextTokens,
        requestedBudget: context.requestedBudget,
      });
      const admissionDigest = admissionPacketDigest(packet);
      const decision = assessMilestonePlanReadiness({
        plan: view.plan,
        taskId,
        security,
        packet,
        context,
      });
      if (view.lifecycle === "paused") {
        if (view.attention !== null && decision.attention?.attentionId === view.attention.attentionId) {
          return Object.freeze({ status: "paused", milestone: withTrace(view, events), attention: view.attention });
        }
        throw new Error(`milestone ${milestoneId} is paused`);
      }
      const task = view.plan?.tasks.find((candidate) => candidate.taskId === taskId);
      const current = view.tasks[taskId];
      if (view.plan !== null && (task === undefined || current === undefined)) {
        throw new Error(`unknown planned task: ${taskId}`);
      }
      if (current?.status === "ready" && decision.status === "executable") {
        if (current.admissionDigest !== admissionDigest) {
          throw new Error("ready task admission packet does not match the requested execution");
        }
        return Object.freeze({
          status: "admitted",
          milestone: withTrace(view, events),
          admission: Object.freeze({ packet, digest: admissionDigest }),
        });
      }
      if (current !== undefined &&
        current.status !== "planned" &&
        current.status !== "blocked" &&
        !(current.status === "ready" && decision.status !== "executable")
      ) {
        throw new Error(`planned task ${taskId} cannot be admitted from ${current.status}`);
      }
      for (const dependency of task?.dependencies ?? []) {
        if (view.tasks[dependency]?.terminalOutcome !== "completed") {
          throw new Error(`planned task ${taskId} dependency ${dependency} is not completed successfully`);
        }
      }
      const paused = decision.attention !== null;
      const nextEvent: NewEvent<string, unknown> = {
        streamId: milestoneId,
        type: paused ? "milestone.paused" : "milestone.task_ready",
        payload: canonicalPayload(paused
          ? { attention: decision.attention }
          : { taskId, admissionDigest }),
        causationId: null,
        correlationId: events[0]!.correlationId,
      };
      try {
        projectMilestone([...events, candidateStoredEvent(nextEvent, view.streamVersion + 1)]);
        const stored = this.journal.append(milestoneId, view.streamVersion, [nextEvent]);
        const updatedEvents = [...events, ...stored];
        const updated = projectMilestone(updatedEvents);
        if (updated === null) throw new Error("projection should not be null after task admission");
        const milestone = withTrace(updated, updatedEvents);
        return paused
          ? Object.freeze({ status: "paused", milestone, attention: updated.attention! })
          : Object.freeze({
            status: "admitted",
            milestone,
            admission: Object.freeze({ packet, digest: admissionDigest }),
          });
      } catch (error) {
        if (!(error instanceof Error) || !/^expected version \d+, actual \d+$/.test(error.message)) throw error;
      }
    }
    throw new Error("task admission did not converge");
  }

  replacePlan(input: ReplaceMilestonePlanInput): MilestoneRecord {
    const events = this.journal.readStream(input.milestoneId);
    const view = projectMilestone(events);
    if (view === null || view.lifecycle !== "paused" || view.attention === null) {
      throw new Error(`milestone ${input.milestoneId} is not paused`);
    }
    if (
      input.attentionId !== view.attention.attentionId ||
      input.priorPlanDigest !== view.attention.planDigest ||
      input.priorSecurityDigest !== view.attention.policyDigest
    ) throw new Error("paused plan replacement binding is stale");
    const payload = PlanReplacementPayloadSchema.parse({
      schemaVersion: 1,
      milestoneId: input.milestoneId,
      projectId: view.projectId,
      attentionId: input.attentionId,
      priorPlanDigest: input.priorPlanDigest,
      priorSecurityDigest: input.priorSecurityDigest,
      replacementPlan: input.replacementPlan,
    });
    const nextEvent: NewEvent<string, unknown> = {
      streamId: input.milestoneId,
      type: "milestone.plan_replaced",
      payload: canonicalPayload(payload),
      causationId: null,
      correlationId: events[0]!.correlationId,
    };
    projectMilestone([...events, candidateStoredEvent(nextEvent, view.streamVersion + 1)]);
    const stored = this.journal.append(input.milestoneId, view.streamVersion, [nextEvent]);
    const updatedEvents = [...events, ...stored];
    const updated = projectMilestone(updatedEvents);
    if (updated === null) throw new Error("projection should not be null after plan replacement");
    return withTrace(updated, updatedEvents);
  }

  inspect(milestoneId: string): MilestoneRecord | null {
    const events = this.journal.readStream(milestoneId);
    const view = projectMilestone(events);
    return view === null ? null : withTrace(view, events);
  }

  resume(milestoneId: string): MilestoneRecord | null {
    return this.inspect(milestoneId);
  }
}

function canonicalDirectory(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  if (!statSync(canonical).isDirectory()) throw new Error("admission repository must be a directory");
  return canonical;
}

function candidateStoredEvent(event: NewEvent<string, unknown>, streamVersion: number): StoredEvent {
  return {
    ...event,
    eventId: "candidate-admission-event",
    streamVersion,
    globalPosition: 0,
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
}

function withTrace(view: MilestoneView, events: readonly StoredEvent[]): MilestoneRecord {
  return Object.freeze({
    ...view,
    traceId: events[0]!.correlationId,
    tracePath: tracePathFrom(events[0]!),
  });
}

function tracePathFrom(event: StoredEvent): string | null {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    return null;
  }
  const tracePath = (event.payload as Readonly<Record<string, unknown>>)["tracePath"];
  return typeof tracePath === "string" && tracePath.length > 0 ? tracePath : null;
}

function canonicalPayload(payload: unknown): unknown {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("event payload must be JSON-serializable");
  return JSON.parse(serialized) as unknown;
}
