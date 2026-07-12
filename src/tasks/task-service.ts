import type {
  NewEvent,
  StoredEvent,
} from "../contracts/event.js";
import type {
  EventJournal,
} from "../journal/journal.js";
import {
  projectTask,
  type TaskView,
} from "./task-projection.js";

export class TaskService {
  constructor(private readonly journal: EventJournal) {}

  create(input: {
    taskId: string;
    projectId: string;
    title: string;
    correlationId: string;
  }): TaskView {
    const existing = this.get(input.taskId);
    if (existing !== null) {
      throw new Error(`task ${input.taskId} already exists`);
    }

    const event: NewEvent<string, unknown> = {
      streamId: input.taskId,
      type: "task.created",
      payload: canonicalizePayload({
        projectId: input.projectId,
        title: input.title,
      }),
      causationId: null,
      correlationId: input.correlationId,
    };

    projectTask([toProspectiveEvent(event, 1)]);
    const stored = this.journal.append(input.taskId, 0, [event]);
    const view = projectTask(stored);
    if (view === null) {
      throw new Error("projection should not be null after task.created");
    }
    return view;
  }

  append(
    taskId: string,
    type: string,
    payload: unknown,
    causationId: string | null,
  ): TaskView {
    const events = this.journal.readStream(taskId);
    const current = projectTask(events);
    if (current === null) {
      throw new Error(`task ${taskId} not found`);
    }

    if (current.lifecycle === "terminal") {
      throw new Error("task is already terminal");
    }

    const event: NewEvent<string, unknown> = {
      streamId: taskId,
      type,
      payload: canonicalizePayload(payload),
      causationId,
      correlationId: events[0]!.correlationId,
    };
    const prospectiveEvent = toProspectiveEvent(
      event,
      current.streamVersion + 1,
    );

    projectTask([...events, prospectiveEvent]);
    const stored = this.journal.append(taskId, current.streamVersion, [event]);
    const view = projectTask([...events, ...stored]);
    if (view === null) {
      throw new Error("projection should not be null after append");
    }
    return view;
  }

  get(taskId: string): TaskView | null {
    const events = this.journal.readStream(taskId);
    return projectTask(events);
  }
}

function canonicalizePayload(payload: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new Error("event payload must be JSON-serializable");
  }
  if (serialized === undefined) {
    throw new Error("event payload must be JSON-serializable");
  }
  return JSON.parse(serialized) as unknown;
}

function toProspectiveEvent(
  event: NewEvent<string, unknown>,
  streamVersion: number,
): StoredEvent {
  return {
    ...event,
    eventId: "",
    streamVersion,
    globalPosition: 0,
    recordedAt: "",
  };
}
