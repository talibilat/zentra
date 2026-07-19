import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import type { StoredEvent } from "../contracts/event.js";
import { isDurablePagedEventJournal, type DurablePagedEventJournal } from "../journal/journal.js";
import {
  agentTailEventToJsonLine,
  storedEventToAgentTailEvent,
} from "./agent-tail.js";

export class AgentTailJsonlFileSink {
  private deliveredEventPositions = new Map<string, number>();
  private lastGlobalPosition = -1;
  private closed = false;
  private liveStreamFailed = false;
  private tornSuffix: Buffer | null = null;
  private completeLength = 0;

  static open(
    trustedRoot: string,
    tracePath: string,
    liveWriter?: (line: string) => void,
  ): AgentTailJsonlFileSink;
  static open(
    trustedRoot: string,
    tracePath: string,
    expectedTraceId: string,
    liveWriter?: (line: string) => void,
    resume?: boolean,
  ): AgentTailJsonlFileSink;
  static open(
    trustedRoot: string,
    tracePath: string,
    expectedTraceIdOrWriter?: string | ((line: string) => void),
    scopedLiveWriter?: (line: string) => void,
    resume = false,
  ): AgentTailJsonlFileSink {
    const explicitlyScoped = typeof expectedTraceIdOrWriter === "string";
    const expectedTraceId = explicitlyScoped ? expectedTraceIdOrWriter : null;
    const liveWriter = explicitlyScoped ? scopedLiveWriter : expectedTraceIdOrWriter;
    if (expectedTraceId !== null) assertValidTraceId(expectedTraceId);
    if (!explicitlyScoped && resume) throw new Error("Agent Tail resume requires an explicit trace identity");
    assertSafeAgentTailJsonlPath(trustedRoot, tracePath, resume);
    let descriptor: number;
    try {
      descriptor = openSync(
        tracePath,
        (resume ? constants.O_RDWR : constants.O_CREAT | constants.O_EXCL | constants.O_RDWR) |
          constants.O_APPEND |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (
        error instanceof Error && "code" in error &&
        ((error as NodeJS.ErrnoException).code === "EEXIST" ||
          (error as NodeJS.ErrnoException).code === "ELOOP")
      ) {
        throw new Error("Agent Tail trace path must not already exist");
      }
      throw error;
    }
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw new Error("Agent Tail trace destination must be a regular file");
      }
      const sink = new AgentTailJsonlFileSink(
        descriptor,
        tracePath,
        expectedTraceId,
        explicitlyScoped,
        liveWriter,
      );
      if (resume) sink.readRetainedPosition();
      return sink;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  private constructor(
    private readonly descriptor: number,
    private readonly tracePath: string,
    private expectedTraceId: string | null,
    private readonly explicitlyScoped: boolean,
    private readonly liveWriter?: (line: string) => void,
  ) {}

  static projectionCursorName(tracePath: string): string {
    return `agent-tail:${createHash("sha256").update(tracePath, "utf8").digest("hex")}`;
  }

  get projectionCursorName(): string {
    this.assertExplicitScope();
    return AgentTailJsonlFileSink.projectionCursorName(this.tracePath);
  }

  get streamFailed(): boolean {
    return this.liveStreamFailed;
  }

  readonly idempotentDelivery = true;

  select(events: readonly StoredEvent[]): readonly StoredEvent[] {
    this.assertExplicitScope();
    return events.filter((event) => event.correlationId === this.expectedTraceId);
  }

  reconcile(events: readonly StoredEvent[]): void {
    this.assertExplicitScope();
    const expected = new Map(this.select(events).map((event) => [event.globalPosition, {
      eventId: event.eventId,
      line: agentTailEventToJsonLine(storedEventToAgentTailEvent(event)),
    }] as const));
    const found = new Set<number>();
    const deliveredEventPositions = new Map(this.deliveredEventPositions);
    this.scanRetained((line, parsed) => {
      const candidate = expected.get(parsed.sequence);
      if (candidate === undefined) return;
      if (parsed.event_id !== candidate.eventId || `${line}\n` !== candidate.line) {
        throw new Error("Agent Tail retained event does not match the journal claim");
      }
      found.add(parsed.sequence);
      recordEventPosition(deliveredEventPositions, candidate.eventId, parsed.sequence);
    });
    for (const [position] of expected) {
      if (position <= this.lastGlobalPosition && !found.has(position)) {
        throw new Error("Agent Tail retained event is missing from the journal claim range");
      }
    }
    this.deliveredEventPositions = deliveredEventPositions;
  }

  reconcileHistory(
    committed: Iterable<StoredEvent>,
  ): void {
    this.assertExplicitScope();
    this.validateRetainedHistory(committed, null, false);
    if (this.tornSuffix !== null) {
      throw new Error("Agent Tail retained trace has an incomplete line");
    }
  }

  repairTornClaim(
    journal: DurablePagedEventJournal,
    projectionName: string,
    claimId: string,
    claimantId: string,
    committed: Iterable<StoredEvent>,
  ): void {
    this.assertExplicitScope();
    if (!isDurablePagedEventJournal(journal)) {
      throw new Error("Agent Tail torn repair requires a durable event journal");
    }
    const claim = journal.inspectProjectionClaim(projectionName);
    assertOwnedClaim(claim, projectionName, claimId, claimantId);
    const active = this.select(claim.events);
    const activeIndex = this.validateRetainedHistory(committed, active, false);
    if (this.tornSuffix === null) return;
    const expected = active[activeIndex];
    if (expected === undefined) throw new Error("Agent Tail committed trace has a torn line");
    const canonical = Buffer.from(agentTailEventToJsonLine(storedEventToAgentTailEvent(expected)), "utf8");
    if (!canonical.subarray(0, this.tornSuffix.length).equals(this.tornSuffix)) {
      throw new Error("Agent Tail torn line does not match the active claim");
    }
    assertOwnedClaim(
      journal.inspectProjectionClaim(projectionName),
      projectionName,
      claimId,
      claimantId,
    );
    ftruncateSync(this.descriptor, this.completeLength);
    fsyncSync(this.descriptor);
    this.tornSuffix = null;
  }

  private validateRetainedHistory(
    committed: Iterable<StoredEvent>,
    active: readonly StoredEvent[] | null,
    allowUnverifiedSuffix: boolean,
  ): number {
    const committedIterator = this.selectedIterator(committed)[Symbol.iterator]();
    let committedNext = committedIterator.next();
    let activeIndex = 0;
    const deliveredEventPositions = new Map(this.deliveredEventPositions);
    this.scanRetained((line, parsed) => {
      const isCommitted = !committedNext.done;
      const expected = isCommitted ? committedNext.value : active?.[activeIndex];
      if (expected === undefined) {
        if (allowUnverifiedSuffix) return;
        throw new Error("Agent Tail retained trace contains an event after the journal cursor");
      }
      const expectedLine = agentTailEventToJsonLine(storedEventToAgentTailEvent(expected));
      if (parsed.event_id !== expected.eventId || `${line}\n` !== expectedLine) {
        throw new Error("Agent Tail retained event does not match authoritative history");
      }
      recordEventPosition(deliveredEventPositions, expected.eventId, parsed.sequence);
      if (isCommitted) {
        committedNext = committedIterator.next();
      } else if (active !== null) {
        activeIndex += 1;
      }
    }, this.tornSuffix !== null);
    if (!committedNext.done) {
      throw new Error("Agent Tail retained trace is missing committed journal history");
    }
    this.deliveredEventPositions = deliveredEventPositions;
    return activeIndex;
  }

  append(candidateEvents: readonly StoredEvent[]): void {
    if (this.closed) throw new Error("Agent Tail trace sink is closed");
    if (this.tornSuffix !== null) throw new Error("Agent Tail retained trace has an incomplete line");
    const pendingLegacyTraceId = !this.explicitlyScoped &&
      this.expectedTraceId === null && candidateEvents.length > 0
      ? candidateEvents[0]!.correlationId
      : null;
    const events = this.explicitlyScoped
      ? this.select(candidateEvents)
      : this.bindLegacyTrace(candidateEvents);
    let pendingPosition = this.lastGlobalPosition;
    const deliveredEventPositions = new Map(this.deliveredEventPositions);
    const lines = events.flatMap((event) => {
      const deliveredPosition = deliveredEventPositions.get(event.eventId);
      if (deliveredPosition !== undefined) {
        if (deliveredPosition !== event.globalPosition) {
          throw new Error("Agent Tail event identity is corrupt: global position changed");
        }
        return [];
      }
      if (event.globalPosition <= pendingPosition) {
        throw new Error("Agent Tail trace events must follow journal order");
      }
      deliveredEventPositions.set(event.eventId, event.globalPosition);
      pendingPosition = event.globalPosition;
      return [Buffer.from(agentTailEventToJsonLine(storedEventToAgentTailEvent(event)), "utf8")];
    });

    this.deliveredEventPositions = deliveredEventPositions;
    if (pendingLegacyTraceId !== null) this.expectedTraceId = pendingLegacyTraceId;
    for (const line of lines) writeAll(this.descriptor, line);
    if (lines.length > 0) fsyncSync(this.descriptor);
    this.lastGlobalPosition = pendingPosition;

    if (this.liveWriter !== undefined && !this.liveStreamFailed) {
      try {
        for (const line of lines) this.liveWriter(line.toString("utf8"));
      } catch {
        this.liveStreamFailed = true;
      }
    }
  }

  private readRetainedPosition(): void {
    this.lastGlobalPosition = this.scanRetained(() => {}, true);
  }

  private bindLegacyTrace(events: readonly StoredEvent[]): readonly StoredEvent[] {
    if (events.length === 0) return events;
    const expectedTraceId = this.expectedTraceId ?? events[0]!.correlationId;
    assertValidTraceId(expectedTraceId);
    if (events.some((event) => event.correlationId !== expectedTraceId)) {
      throw new Error("Agent Tail legacy sink cannot accept events from a different trace");
    }
    return events;
  }

  private assertExplicitScope(): void {
    if (!this.explicitlyScoped) {
      throw new Error("Agent Tail durable projection requires an explicit trace identity; legacy mode is unscoped direct append only");
    }
  }

  private scanRetained(
    inspect: (
      line: string,
      parsed: { readonly event_id: string; readonly sequence: number; readonly trace_id: string },
    ) => void,
    allowTorn = false,
  ): number {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const size = fstatSync(this.descriptor).size;
    let lastNewline = 0;
    for (let scanOffset = 0; scanOffset < size;) {
      const bytes = readSync(this.descriptor, buffer, 0, Math.min(buffer.length, size - scanOffset), scanOffset);
      if (bytes === 0) break;
      for (let index = 0; index < bytes; index += 1) {
        if (buffer[index] === 0x0a) lastNewline = scanOffset + index + 1;
      }
      scanOffset += bytes;
    }
    this.completeLength = lastNewline;
    if (lastNewline < size) {
      if (!allowTorn) throw new Error("Agent Tail retained trace has an incomplete line");
      if (size - lastNewline > 16 * 1024 * 1024) throw new Error("Agent Tail retained line exceeds the recovery limit");
      this.tornSuffix = Buffer.allocUnsafe(size - lastNewline);
      readSync(this.descriptor, this.tornSuffix, 0, this.tornSuffix.length, lastNewline);
    }
    let retained = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let offset = 0;
    let lastGlobalPosition = -1;
    while (true) {
      if (offset >= lastNewline) break;
      const bytes = readSync(this.descriptor, buffer, 0, Math.min(buffer.length, lastNewline - offset), offset);
      if (bytes === 0) break;
      offset += bytes;
      retained += decoder.decode(buffer.subarray(0, bytes), { stream: offset < lastNewline });
      if (Buffer.byteLength(retained, "utf8") > 16 * 1024 * 1024) {
        throw new Error("Agent Tail retained line exceeds the recovery limit");
      }
      let newline = retained.indexOf("\n");
      while (newline >= 0) {
        const line = retained.slice(0, newline);
        retained = retained.slice(newline + 1);
        const parsed = JSON.parse(line) as {
          readonly event_id?: unknown;
          readonly sequence?: unknown;
          readonly trace_id?: unknown;
        };
        if (
          typeof parsed.event_id !== "string" || parsed.event_id.length === 0 ||
          !Number.isSafeInteger(parsed.sequence) ||
          parsed.trace_id !== this.expectedTraceId ||
          (parsed.sequence as number) <= lastGlobalPosition
        ) {
          throw new Error("Agent Tail retained trace is corrupt");
        }
        const validated = {
          event_id: parsed.event_id,
          sequence: parsed.sequence as number,
          trace_id: parsed.trace_id as string,
        };
        inspect(line, validated);
        lastGlobalPosition = validated.sequence;
        newline = retained.indexOf("\n");
      }
    }
    if (retained.length !== 0) throw new Error("Agent Tail retained trace has an incomplete line");
    return lastGlobalPosition;
  }

  private *selectedIterator(events: Iterable<StoredEvent>): Generator<StoredEvent> {
    for (const event of events) {
      if (event.correlationId === this.expectedTraceId) yield event;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.descriptor);
  }
}

function assertValidTraceId(traceId: string): void {
  if (traceId.length === 0 || traceId.length > 256 || /[\u0000\r\n]/.test(traceId)) {
    throw new Error("Agent Tail expected trace identity is invalid");
  }
}

function recordEventPosition(
  positions: Map<string, number>,
  eventId: string,
  globalPosition: number,
): void {
  const retainedPosition = positions.get(eventId);
  if (retainedPosition !== undefined && retainedPosition !== globalPosition) {
    throw new Error("Agent Tail event identity is corrupt: global position changed");
  }
  positions.set(eventId, globalPosition);
}

function assertOwnedClaim(
  claim: ReturnType<DurablePagedEventJournal["inspectProjectionClaim"]>,
  projectionName: string,
  claimId: string,
  claimantId: string,
): asserts claim is NonNullable<typeof claim> {
  if (
    claim === null || claim.name !== projectionName ||
    claim.claimId !== claimId || claim.claimantId !== claimantId
  ) {
    throw new Error("Agent Tail torn repair requires exact current claim ownership");
  }
}

export function assertSafeAgentTailJsonlPath(
  trustedRoot: string,
  tracePath: string,
  allowExisting = false,
): void {
  if (!path.isAbsolute(trustedRoot) || path.normalize(trustedRoot) !== trustedRoot) {
    throw new Error("Agent Tail trusted root must be an absolute normalized path");
  }
  if (!path.isAbsolute(tracePath)) {
    throw new Error("Agent Tail trace path must be absolute");
  }
  if (path.normalize(tracePath) !== tracePath) {
    throw new Error("Agent Tail trace path must be normalized");
  }
  if (/[\u0000\r\n]/.test(tracePath)) {
    throw new Error("Agent Tail trace path contains forbidden characters");
  }

  assertSafeDirectory(trustedRoot);
  const relative = path.relative(trustedRoot, tracePath);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Agent Tail trace path must remain inside the trusted root");
  }
  if (path.dirname(tracePath) !== trustedRoot) {
    throw new Error("Agent Tail trace path must be a direct child of the trusted root");
  }

  try {
    const retained = lstatSync(tracePath);
    if (allowExisting && retained.isFile() && !retained.isSymbolicLink()) return;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("Agent Tail trace path must not already exist");
}

function assertSafeDirectory(directory: string): void {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    throw new Error("Agent Tail trace parent directory is unavailable");
  }
  if (stat.isSymbolicLink()) {
    throw new Error("Agent Tail trace path must not contain symbolic links");
  }
  if (!stat.isDirectory()) {
    throw new Error("Agent Tail trace parent must be a directory");
  }
  const canonical = realpathSync.native(directory);
  if (canonical !== directory) {
    throw new Error("Agent Tail trace path must not contain symbolic links");
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (written <= 0) {
      throw new Error("Agent Tail trace append was incomplete; the event journal remains authoritative");
    }
    offset += written;
  }
}
