import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

import type { DurablePagedEventJournal } from "../journal/journal.js";
import { ProjectingEventJournal } from "../journal/projecting-journal.js";
import { createHash } from "node:crypto";
import { agentTailEventToJsonLine, assertAgentTailExternalIdentity, isAgentTailProjectableEventType, storedEventToAgentTailEvent } from "./agent-tail.js";
import { AgentTailSegmentStore, type AgentTailSegmentLimits, type AgentTailTraceReport } from "./agent-tail-segment-store.js";

export class AgentTailTraceService {
  constructor(private readonly journal: DurablePagedEventJournal) {}

  project(input: {
    readonly trustedRoot: string;
    readonly traceDirectory: string;
    readonly traceId: string;
    readonly limits?: AgentTailSegmentLimits;
  }): AgentTailTraceReport {
    const store = AgentTailSegmentStore.create(input);
    try {
      this.projectThrough(store, this.head());
      return store.report();
    } finally {
      store.close();
    }
  }

  validate(traceDirectory: string): AgentTailTraceReport {
    const store = AgentTailSegmentStore.reopen({
      trustedRoot: path.dirname(traceDirectory), traceDirectory,
    });
    try { return store.report(); } finally { store.close(); }
  }

  export(traceDirectory: string, destination: string): AgentTailTraceReport {
    const store = AgentTailSegmentStore.reopen({ trustedRoot: path.dirname(traceDirectory), traceDirectory });
    try {
      const report = store.report();
      if (path.dirname(destination) !== path.dirname(traceDirectory)) {
        throw new Error("Agent Tail export must remain in the trusted root");
      }
      publishExport(destination, store.canonicalBytes());
      return report;
    } finally { store.close(); }
  }

  repair(input: {
    readonly trustedRoot: string;
    readonly traceDirectory: string;
    readonly traceId: string;
    readonly throughPosition: number;
    readonly limits?: AgentTailSegmentLimits;
  }): AgentTailTraceReport {
    const store = AgentTailSegmentStore.create(input);
    try {
      this.projectThrough(store, input.throughPosition);
      return store.report();
    } finally { store.close(); }
  }

  async *tail(input: {
    readonly traceId: string;
    readonly afterPosition?: number;
    readonly signal: AbortSignal;
    readonly pollIntervalMs?: number;
  }): AsyncGenerator<string, void, undefined> {
    let position = input.afterPosition ?? 0;
    assertAgentTailExternalIdentity(input.traceId, "trace identity");
    const pollIntervalMs = input.pollIntervalMs ?? 100;
    if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(pollIntervalMs) ||
      pollIntervalMs < 10 || pollIntervalMs > 10_000) throw new Error("Agent Tail tail bounds are invalid");
    while (!input.signal.aborted) {
      const page = this.journal.readAllPage(position, {
        maxEvents: 1_000,
        maxBytes: 16 * 1024 * 1024,
      });
      for (const event of page.events) {
        position = event.globalPosition;
        if (event.correlationId !== input.traceId) continue;
        if (!isAgentTailProjectableEventType(event.type)) {
          yield withheldLine(input.traceId, event.globalPosition, event.eventId, event.type);
          continue;
        }
        yield agentTailEventToJsonLine(storedEventToAgentTailEvent(event));
      }
      if (page.events.length > 0) continue;
      await abortableDelay(pollIntervalMs, input.signal);
    }
  }

  private head(): number {
    const page = this.journal.readAllPage(0, { maxEvents: 1, maxBytes: 16 * 1024 * 1024 });
    if (page.highWaterPosition === undefined) {
      throw new Error("Agent Tail fixed snapshot requires a journal high-water position");
    }
    return page.highWaterPosition;
  }

  private projectThrough(store: AgentTailSegmentStore, throughPosition: number): void {
    let position = 0;
    while (position < throughPosition) {
      const page = this.journal.readAllPage(position, {
        maxEvents: Math.min(1_000, throughPosition - position),
        maxBytes: 16 * 1024 * 1024,
      });
      const events = page.events.filter((event) => event.globalPosition <= throughPosition);
      if (events.length === 0) throw new Error("Agent Tail backfill did not make progress");
      store.append(events);
      position = events.at(-1)!.globalPosition;
    }
  }
}

export function createSegmentedAgentTailProjection(
  journal: DurablePagedEventJournal,
  input: Parameters<typeof AgentTailSegmentStore.create>[0],
): {
  readonly journal: ProjectingEventJournal;
  readonly store: AgentTailSegmentStore;
} {
  const store = existsSync(input.traceDirectory)
    ? AgentTailSegmentStore.reopen({
      trustedRoot: input.trustedRoot,
      traceDirectory: input.traceDirectory,
      expectedTraceId: input.traceId,
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    })
    : AgentTailSegmentStore.create(input);
  const projecting = new ProjectingEventJournal(journal, store);
  return Object.freeze({ journal: projecting, store });
}

function withheldLine(traceId: string, sequence: number, eventId: string, nativeType: string): string {
  const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
  return `${JSON.stringify({
    schema_version: "1.0",
    event_id: `withheld:${digest(eventId)}`,
    trace_id: traceId,
    span_id: `projection:${digest(traceId)}`,
    parent_span_id: null,
    emitter_id: "zentra:agent-tail-projection",
    sequence,
    timestamp: new Date(0).toISOString(),
    kind: "projection.withheld",
    actor: { id: "zentra-agent-tail-policy", role: "policy" },
    operation: { name: "projection", status: "completed" },
    relationships: [],
    attributes: { zentra: { global_position: sequence } },
    payload: { code: "unknown_event_policy", event_id_sha256: digest(eventId),
      native_type_sha256: digest(nativeType) },
  })}\n`;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function publishExport(destination: string, bytes: Buffer): void {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const temporary = `${destination}.tmp-${digest}`;
  if (existsSync(destination)) {
    if (existsSync(temporary)) {
      const target = lstatSync(destination);
      const temp = lstatSync(temporary);
      if (target.dev !== temp.dev || target.ino !== temp.ino) throw new Error("Agent Tail export identity conflicts");
      unlinkSync(temporary);
      fsyncParent(destination);
    }
    if (!readSafeExport(destination).equals(bytes)) throw new Error("Agent Tail export destination conflicts");
    return;
  }
  if (!existsSync(temporary)) {
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
      constants.O_NOFOLLOW, 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
        if (written <= 0) throw new Error("Agent Tail export write made no progress");
        offset += written;
      }
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    chmodSync(temporary, 0o400);
  } else if (!readSafeExport(temporary).equals(bytes)) {
    throw new Error("Agent Tail temporary export is incomplete or corrupt");
  }
  linkSync(temporary, destination);
  unlinkSync(temporary);
  fsyncParent(destination);
}

function readSafeExport(filePath: string): Buffer {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o400 ||
      (process.getuid !== undefined && info.uid !== process.getuid())) {
      throw new Error("Agent Tail export file identity is unsafe");
    }
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

function fsyncParent(destination: string): void {
  const descriptor = openSync(path.dirname(destination), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export type { AgentTailTraceReport } from "./agent-tail-segment-store.js";
