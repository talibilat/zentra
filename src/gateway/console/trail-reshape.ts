export interface TrailEvidenceLink {
  readonly type: string;
  readonly refEventId: string;
}

export interface TrailEvent {
  readonly id: string;
  readonly offsetSeconds: number;
  readonly kind: string;
  readonly name: string;
  readonly summary: string;
  readonly actorId: string;
  readonly failed: boolean;
  readonly sequence: number | null;
  readonly evidence: readonly TrailEvidenceLink[];
  readonly payload: unknown;
}

export interface TrailActorUsageMetric {
  readonly available: boolean;
  readonly value: number | null;
}

export interface TrailActorUsage {
  readonly inputTokens: TrailActorUsageMetric;
  readonly outputTokens: TrailActorUsageMetric;
  readonly totalTokens: TrailActorUsageMetric;
  readonly costUsd: TrailActorUsageMetric;
}

export interface TrailActor {
  readonly id: string;
  readonly role: string | null;
  readonly color: string;
  readonly glyph: string;
  readonly model: string | null;
  readonly status: string;
  readonly usage: TrailActorUsage;
}

export interface TrailView {
  readonly runId: string;
  readonly durationSeconds: number;
  readonly events: readonly TrailEvent[];
  readonly actors: readonly TrailActor[];
}

const ACTOR_PALETTE = ["var(--run)", "var(--ok)", "var(--warn)", "var(--accent)", "var(--orch)", "var(--err)"] as const;
const FAILED_STATUSES = new Set(["error", "errored", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function actorColor(actorId: string): string {
  return ACTOR_PALETTE[hashString(actorId) % ACTOR_PALETTE.length]!;
}

function actorGlyph(actorId: string, role: string | null): string {
  const source = role !== null && role.length > 0 ? role : actorId;
  const letter = source.charAt(0).toUpperCase();
  return letter.length > 0 ? letter : "?";
}

function actorUsageMetric(usage: Record<string, unknown>, key: string): TrailActorUsageMetric {
  const raw = usage[key];
  if (!isRecord(raw)) return { available: false, value: null };
  const value = typeof raw["value"] === "number" ? raw["value"] : null;
  const available = raw["available"] === true && value !== null;
  return { available, value };
}

function actorUsage(actor: Record<string, unknown>): TrailActorUsage {
  const usage = isRecord(actor["usage"]) ? actor["usage"] : {};
  return {
    inputTokens: actorUsageMetric(usage, "input_tokens"),
    outputTokens: actorUsageMetric(usage, "output_tokens"),
    totalTokens: actorUsageMetric(usage, "total_tokens"),
    costUsd: actorUsageMetric(usage, "cost_usd"),
  };
}

function isEventFailed(kind: string, status: string): boolean {
  return kind.endsWith(".failed") || FAILED_STATUSES.has(status.toLowerCase());
}

function eventName(operation: Record<string, unknown>, kind: string): string {
  const name = operation["name"];
  if (typeof name === "string" && name.length > 0) return name;
  const segments = kind.split(".");
  const last = segments[segments.length - 1];
  return last !== undefined && last.length > 0 ? last : kind;
}

function eventSummary(operation: Record<string, unknown>, kind: string, status: string): string {
  const error = operation["error"];
  if (typeof error === "string" && error.length > 0) return error;
  return `${kind} - ${status}`;
}

export function reshapeTrail(raw: unknown): TrailView {
  if (!isRecord(raw)) throw new Error("trail_response_invalid");
  const run = raw["run"];
  const runId = isRecord(run) && typeof run["trace_id"] === "string" ? run["trace_id"] : "";
  const durationSeconds = typeof raw["duration_seconds"] === "number" ? raw["duration_seconds"] : 0;
  const rawEvents = Array.isArray(raw["events"]) ? raw["events"] : [];
  const rawActors = Array.isArray(raw["actors"]) ? raw["actors"] : [];

  const events: TrailEvent[] = rawEvents.filter(isRecord).map((event) => {
    const operation = isRecord(event["operation"]) ? event["operation"] : {};
    const actor = isRecord(event["actor"]) ? event["actor"] : {};
    const kind = typeof event["kind"] === "string" ? event["kind"] : "unknown";
    const status = typeof operation["status"] === "string" ? operation["status"] : "unknown";
    const relationships = Array.isArray(event["relationships"]) ? event["relationships"] : [];
    return {
      id: String(event["event_id"] ?? ""),
      offsetSeconds: typeof event["offset_seconds"] === "number" ? event["offset_seconds"] : 0,
      kind,
      name: eventName(operation, kind),
      summary: eventSummary(operation, kind, status),
      actorId: typeof actor["id"] === "string" ? actor["id"] : "unknown",
      failed: isEventFailed(kind, status),
      sequence: typeof event["sequence"] === "number" ? event["sequence"] : null,
      evidence: relationships.filter(isRecord).map((relationship) => ({
        type: String(relationship["type"] ?? "related"),
        refEventId: String(relationship["event_id"] ?? ""),
      })),
      payload: event["payload"] ?? null,
    };
  });

  const actors: TrailActor[] = rawActors.filter(isRecord).map((actor) => {
    const id = String(actor["id"] ?? "unknown");
    const role = typeof actor["role"] === "string" ? actor["role"] : null;
    const model = typeof actor["model"] === "string" ? actor["model"] : null;
    const status = typeof actor["status"] === "string" ? actor["status"] : "unknown";
    return { id, role, color: actorColor(id), glyph: actorGlyph(id, role), model, status, usage: actorUsage(actor) };
  });

  return { runId, durationSeconds, events, actors };
}
