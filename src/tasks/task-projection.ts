import type {
  StoredEvent,
} from "../contracts/event.js";
import {
  ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE,
  isArtifactRecordedEventType,
  projectArtifacts,
} from "../contracts/artifact.js";
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
  queued: [
    "task.worktree_creation_started",
    "task.leased",
    "task.cancelled",
    "task.failed",
    "task.timed_out",
    "task.denied",
  ],
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
    "task.review_policy_blocked",
    "task.commit_observed",
    "task.integration_started",
    "task.denied",
    "task.cancelled",
    "task.failed",
    "task.timed_out",
  ],
  integrating: [
    "task.integration_prepared",
    "task.integration_observed",
    "task.cleanup_started",
    "task.cleanup_completed",
    "task.cleanup_observed",
    "task.cleanup_reconciled",
    "task.completed",
    "task.cancelled",
    "task.failed",
    "task.timed_out",
  ],
  terminal: [],
};

const EVENT_TO_LIFECYCLE: Record<string, TaskLifecycleState | TerminalOutcome> = {
  "task.created": "queued",
  "task.worktree_creation_started": "queued",
  "task.leased": "leased",
  "task.started": "running",
  "task.validation_started": "validating",
  "task.review_requested": "awaiting_review",
  "task.review_approved": "integration_ready",
  "task.review_policy_blocked": "integration_ready",
  "task.commit_observed": "integration_ready",
  "task.integration_started": "integrating",
  "task.integration_prepared": "integrating",
  "task.integration_observed": "integrating",
  "task.cleanup_started": "integrating",
  "task.cleanup_completed": "integrating",
  "task.cleanup_observed": "integrating",
  "task.cleanup_reconciled": "integrating",
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

  projectArtifacts(events);

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
  const singleOccurrenceEvents = new Set<string>();
  let integrationPrepared = false;
  let integrationObserved = false;
  let integrationVerified = false;
  let cleanupStarted = false;
  let cleanupCompleted = false;
  let cleanupObserved = false;
  let cleanupReconciled = false;
  let reviewPolicyBlocked = false;
  let preparedReceiptSnapshot: string | null = null;
  let observedReceiptSnapshot: string | null = null;
  let cleanupStartedSnapshot: string | null = null;
  let cleanupObservationSnapshot: string | null = null;

  for (let i = 1; i < events.length; i++) {
    const event = events[i]!;

    if (state.lifecycle === "terminal") {
      throw new Error("task is already terminal");
    }

    if (
      isArtifactRecordedEventType(event.type) ||
      event.type === ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE
    ) {
      state.streamVersion = event.streamVersion;
      continue;
    }

    const nextState = EVENT_TO_LIFECYCLE[event.type];
    if (nextState === undefined) {
      throw new Error(`unknown event type: ${event.type}`);
    }
    if (reviewPolicyBlocked && event.type !== "task.cancelled" && event.type !== "task.failed") {
      throw new Error("task review policy is blocked");
    }

    if (event.type === "task.created") {
      throw new Error("duplicate task.created event");
    }
    if (
      event.type === "task.commit_observed" ||
      event.type === "task.integration_prepared" ||
      event.type === "task.integration_observed" ||
      event.type === "task.cleanup_started" ||
      event.type === "task.cleanup_completed" ||
      event.type === "task.cleanup_observed" ||
      event.type === "task.cleanup_reconciled" ||
      event.type === "task.review_policy_blocked" ||
      event.type === "task.completed"
    ) {
      if (singleOccurrenceEvents.has(event.type)) {
        throw new Error(`duplicate ${event.type} event`);
      }
      singleOccurrenceEvents.add(event.type);
    }

    if (event.type === "task.integration_prepared") {
      if (integrationObserved || cleanupStarted) {
        throw new Error("task.integration_prepared is out of order");
      }
      integrationPrepared = true;
      preparedReceiptSnapshot = canonicalSnapshot(payloadField(event, "receipt"));
    } else if (event.type === "task.integration_observed") {
      const verified = payloadField(event, "verification") === "verified";
      if (verified && !integrationPrepared) {
        throw new Error("verified integration observation requires prepared evidence");
      }
      const receiptSnapshot = canonicalSnapshot(payloadField(event, "receipt"));
      if (verified && receiptSnapshot !== preparedReceiptSnapshot) {
        throw new Error("verified integration receipt contradicts prepared receipt");
      }
      integrationObserved = true;
      integrationVerified = verified;
      if (verified) observedReceiptSnapshot = receiptSnapshot;
    } else if (event.type === "task.cleanup_started") {
      if (!integrationObserved || !integrationVerified) {
        throw new Error("cleanup start requires one verified integration observation");
      }
      cleanupStarted = true;
      cleanupStartedSnapshot = canonicalSnapshot(event.payload);
    } else if (event.type === "task.cleanup_completed") {
      if (!cleanupStarted || cleanupObserved) {
        throw new Error("cleanup completion requires one cleanup start");
      }
      if (canonicalSnapshot(event.payload) !== cleanupStartedSnapshot) {
        throw new Error("cleanup completion facts contradict cleanup start facts");
      }
      cleanupCompleted = true;
    } else if (event.type === "task.cleanup_observed") {
      if (!cleanupStarted || cleanupCompleted || cleanupObserved) {
        throw new Error("cleanup observation requires one cleanup start");
      }
      cleanupObserved = true;
      cleanupObservationSnapshot = canonicalSnapshot(event.payload);
    } else if (event.type === "task.cleanup_reconciled") {
      if (!cleanupObserved || cleanupCompleted || cleanupReconciled) {
        throw new Error("cleanup reconciliation requires one uncertain cleanup observation");
      }
      if (
        canonicalSnapshot(payloadField(event, "cleanup")) !== cleanupStartedSnapshot ||
        canonicalSnapshot(payloadField(event, "observation")) !== cleanupObservationSnapshot
      ) {
        throw new Error("cleanup reconciliation facts contradict cleanup target facts");
      }
      cleanupReconciled = true;
    } else if (event.type === "task.review_policy_blocked") {
      reviewPolicyBlocked = true;
    } else if (event.type === "task.completed") {
      if (!cleanupCompleted && !cleanupReconciled) {
        throw new Error("task completion requires durable cleanup completion or reconciliation");
      }
      if (canonicalSnapshot(payloadField(event, "receipt")) !== observedReceiptSnapshot) {
        throw new Error("task completion receipt contradicts verified integration receipt");
      }
    }

    const currentLifecycle = state.lifecycle;
    if (!VALID_TRANSITIONS[currentLifecycle].includes(event.type)) {
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

function payloadField(event: StoredEvent, field: string): unknown {
  return typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Record<string, unknown>)[field]
    : undefined;
}

function canonicalSnapshot(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function requirePayloadString(event: StoredEvent, field: string): string {
  const value = payloadField(event, field);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${event.type} payload.${field} must be a nonempty string`,
    );
  }
  return value;
}
