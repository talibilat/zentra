import type { NewEvent, StoredEvent } from "../contracts/event.js";
import type { MilestonePlan } from "../contracts/milestone.js";
import type { EventJournal } from "../journal/journal.js";
import { projectMilestone, type MilestoneView } from "./milestone-projection.js";

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

  ready(milestoneId: string, taskId: string): MilestoneRecord {
    const events = this.journal.readStream(milestoneId);
    const view = projectMilestone(events);
    if (view === null || view.plan === null) throw new Error(`milestone ${milestoneId} does not have a plan`);
    const task = view.plan.tasks.find((candidate) => candidate.taskId === taskId);
    const current = view.tasks[taskId];
    if (task === undefined || current === undefined || (current.status !== "planned" && current.status !== "blocked")) {
      throw new Error(`planned task ${taskId} cannot become ready`);
    }
    for (const dependency of task.dependencies) {
      if (view.tasks[dependency]?.terminalOutcome !== "completed") {
        throw new Error(`planned task ${taskId} dependency ${dependency} is not completed successfully`);
      }
    }
    const stored = this.journal.append(milestoneId, view.streamVersion, [{
      streamId: milestoneId,
      type: "milestone.task_ready",
      payload: canonicalPayload({ taskId }),
      causationId: null,
      correlationId: events[0]!.correlationId,
    }]);
    const updatedEvents = [...events, ...stored];
    const updated = projectMilestone(updatedEvents);
    if (updated === null) throw new Error("projection should not be null after task readiness");
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
