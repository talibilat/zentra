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
    return this.appendBatch(taskId, [{ type, payload, causationId }]);
  }

  appendBatch(
    taskId: string,
    inputs: readonly {
      readonly type: string;
      readonly payload: unknown;
      readonly causationId: string | null;
    }[],
  ): TaskView {
    if (inputs.length === 0) throw new Error("event batch must not be empty");
    const events = this.journal.readStream(taskId);
    const current = projectTask(events);
    if (current === null) {
      throw new Error(`task ${taskId} not found`);
    }

    if (current.lifecycle === "terminal") {
      throw new Error("task is already terminal");
    }

    const batch = inputs.map((input) => ({
      streamId: taskId,
      type: input.type,
      payload: canonicalizePayload(input.payload),
      causationId: input.causationId,
      correlationId: events[0]!.correlationId,
    } satisfies NewEvent<string, unknown>));
    const prospectiveEvents = batch.map((event, index) =>
      toProspectiveEvent(event, current.streamVersion + index + 1));

    projectTask([...events, ...prospectiveEvents]);
    const stored = this.journal.append(taskId, current.streamVersion, batch);
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
