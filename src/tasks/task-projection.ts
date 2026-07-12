import type {
  StoredEvent,
} from "../contracts/event.js";
import type {
  TaskLifecycleState,
  TerminalOutcome,
} from "../contracts/task.js";

export interface TaskView {
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly lifecycle: TaskLifecycleState;
  readonly terminalOutcome: TerminalOutcome | null;
  readonly streamVersion: number;
  readonly leaseOwner: string | null;
}

type TaskProjectionState = {
  taskId: string;
  projectId: string;
  title: string;
  lifecycle: TaskLifecycleState;
  terminalOutcome: TerminalOutcome | null;
  streamVersion: number;
  leaseOwner: string | null;
};

const VALID_TRANSITIONS: Record<TaskLifecycleState, readonly string[]> = {
  queued: ["task.leased", "task.cancelled", "task.failed", "task.timed_out", "task.denied"],
  leased: ["task.started", "task.cancelled", "task.failed", "task.timed_out", "task.denied"],
  running: [
    "task.validation_started",
    "task.cancelled",
    "task.failed",
    "task.timed_out",
    "task.denied",
  ],
  validating: [
    "task.review_requested",
    "task.cancelled",
    "task.failed",
    "task.timed_out",
    "task.denied",
  ],
  awaiting_review: [
    "task.review_approved",
    "task.denied",
    "task.cancelled",
    "task.failed",
    "task.timed_out",
  ],
  integration_ready: [
    "task.commit_observed",
    "task.integration_started",
    "task.denied",
    "task.cancelled",
    "task.failed",
    "task.timed_out",
  ],
  integrating: [
    "task.integration_observed",
    "task.completed",
    "task.cancelled",
    "task.failed",
    "task.timed_out",
  ],
  terminal: [],
};

const EVENT_TO_LIFECYCLE: Record<string, TaskLifecycleState | TerminalOutcome> = {
  "task.created": "queued",
  "task.leased": "leased",
  "task.started": "running",
  "task.validation_started": "validating",
  "task.review_requested": "awaiting_review",
  "task.review_approved": "integration_ready",
  "task.commit_observed": "integration_ready",
  "task.integration_started": "integrating",
  "task.integration_observed": "integrating",
  "task.completed": "completed",
  "task.cancelled": "cancelled",
  "task.failed": "failed",
  "task.timed_out": "timed_out",
  "task.denied": "denied",
};

const TERMINAL_OUTCOMES = new Set<string>(["completed", "cancelled", "failed", "timed_out", "denied"]);

export function projectTask(events: readonly StoredEvent[]): TaskView | null {
  if (events.length === 0) {
    return null;
  }

  const firstEvent = events[0]!;
  if (firstEvent.type !== "task.created") {
    throw new Error("first event must be task.created");
  }
  if (typeof firstEvent.streamId !== "string" || firstEvent.streamId.length === 0) {
    throw new Error("task.created streamId must be a nonempty string");
  }

  const state: TaskProjectionState = {
    taskId: firstEvent.streamId,
    projectId: requirePayloadString(firstEvent, "projectId"),
    title: requirePayloadString(firstEvent, "title"),
    lifecycle: "queued",
    terminalOutcome: null,
    streamVersion: firstEvent.streamVersion,
    leaseOwner: null,
  };

  for (let i = 1; i < events.length; i++) {
    const event = events[i]!;

    if (state.lifecycle === "terminal") {
      throw new Error("task is already terminal");
    }

    const nextState = EVENT_TO_LIFECYCLE[event.type];
    if (nextState === undefined) {
      throw new Error(`unknown event type: ${event.type}`);
    }

    if (event.type === "task.created") {
      throw new Error("duplicate task.created event");
    }

    const currentLifecycle = state.lifecycle;
    if (!VALID_TRANSITIONS[currentLifecycle]?.includes(event.type)) {
      throw new Error(
        `invalid transition from ${currentLifecycle} via ${event.type}`,
      );
    }

    const leaseOwner =
      event.type === "task.leased"
        ? requirePayloadString(event, "leaseOwner")
        : null;

    if (TERMINAL_OUTCOMES.has(nextState as string)) {
      state.lifecycle = "terminal";
      state.terminalOutcome = nextState as TerminalOutcome;
    } else {
      state.lifecycle = nextState as TaskLifecycleState;
    }

    state.streamVersion = event.streamVersion;

    if (leaseOwner !== null) {
      state.leaseOwner = leaseOwner;
    }
  }

  return state;
}

function requirePayloadString(event: StoredEvent, field: string): string {
  const payload = event.payload;
  const value =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)[field]
      : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${event.type} payload.${field} must be a nonempty string`,
    );
  }
  return value;
}
