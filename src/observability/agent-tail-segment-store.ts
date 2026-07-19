import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import type { StoredEvent } from "../contracts/event.js";
import type { DurablePagedEventJournal } from "../journal/journal.js";
import type { StoredEventSink } from "../journal/projecting-journal.js";
import {
  agentTailEventToJsonLine,
  assertAgentTailExternalIdentity,
  isAgentTailProjectableEventType,
  storedEventToAgentTailEvent,
} from "./agent-tail.js";

const PROJECTION_VERSION = "agent-tail-1.0";
const REDACTION_VERSION = "zentra-1";
const DEFAULT_LIMITS: AgentTailSegmentLimits = {
  maxEvents: 1_000,
  maxBytes: 16 * 1024 * 1024,
};
const SEGMENT_NAME = /^(\d{16})-(\d{16})-(\d{4})-([a-f0-9]{64})\.jsonl$/;
const CLAIM_NAME = /^(\d{16})-(\d{16})\.claim\.json$/;

export interface AgentTailSegmentLimits {
  readonly maxEvents: number;
  readonly maxBytes: number;
}

export interface AgentTailSegmentDescriptor {
  readonly schemaVersion: 1;
  readonly projectionVersion: typeof PROJECTION_VERSION;
  readonly redactionVersion: typeof REDACTION_VERSION;
  readonly traceIdSha256: string;
  readonly afterPosition: number;
  readonly throughPosition: number;
  readonly firstEventPosition: number;
  readonly lastEventPosition: number;
  readonly eventCount: number;
  readonly byteLength: number;
  readonly contentSha256: string;
}

export interface AgentTailTraceReport {
  readonly traceId: string;
  readonly throughPosition: number;
  readonly eventCount: number;
  readonly segmentCount: number;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly withheldCount: number;
  readonly withheldDigests: readonly string[];
}

interface TraceMetadata {
  readonly schemaVersion: 1;
  readonly projectionVersion: typeof PROJECTION_VERSION;
  readonly redactionVersion: typeof REDACTION_VERSION;
  readonly traceId: string;
  readonly traceIdSha256: string;
}

interface ClaimManifest {
  readonly schemaVersion: 1;
  readonly afterPosition: number;
  readonly throughPosition: number;
  readonly segments: readonly string[];
  readonly withheld: readonly string[];
}

interface FileIdentity { readonly dev: number; readonly ino: number }

export class AgentTailSegmentStore implements StoredEventSink {
  readonly idempotentDelivery = true;
  readonly projectionCursorName: string;
  private closed = false;

  static create(input: {
    readonly trustedRoot: string;
    readonly traceDirectory: string;
    readonly traceId: string;
    readonly limits?: AgentTailSegmentLimits;
    readonly crashPoint?: "before_claim_manifest";
  }): AgentTailSegmentStore {
    assertTraceIdentity(input.traceId);
    const root = canonicalPrivateRoot(input.trustedRoot);
    assertDirectChild(root, input.traceDirectory);
    if (existsSync(input.traceDirectory)) throw new Error("Agent Tail trace directory already exists");
    mkdirSync(input.traceDirectory, { mode: 0o700 });
    const directory = realpathSync.native(input.traceDirectory);
    if (directory !== input.traceDirectory) throw new Error("Agent Tail trace directory is not canonical");
    const metadata: TraceMetadata = {
      schemaVersion: 1,
      projectionVersion: PROJECTION_VERSION,
      redactionVersion: REDACTION_VERSION,
      traceId: input.traceId,
      traceIdSha256: sha256(input.traceId),
    };
    publish(directory, "trace.meta.json", `${JSON.stringify(metadata)}\n`);
    fsyncDirectory(directory);
    return new AgentTailSegmentStore(root, directory, metadata, validateLimits(input.limits),
      input.crashPoint);
  }

  static reopen(input: {
    readonly trustedRoot: string;
    readonly traceDirectory: string;
    readonly limits?: AgentTailSegmentLimits;
    readonly expectedTraceId?: string;
  }): AgentTailSegmentStore {
    const root = canonicalPrivateRoot(input.trustedRoot);
    assertDirectChild(root, input.traceDirectory);
    const directory = realpathSync.native(input.traceDirectory);
    if (directory !== input.traceDirectory) throw new Error("Agent Tail trace directory is not canonical");
    assertPrivateDirectory(directory);
    const metadata = parseMetadata(readRestricted(path.join(directory, "trace.meta.json")));
    if (input.expectedTraceId !== undefined && metadata.traceId !== input.expectedTraceId) {
      throw new Error("Agent Tail retained trace identity does not match the requested trace");
    }
    return new AgentTailSegmentStore(root, directory, metadata, validateLimits(input.limits));
  }

  private constructor(
    private readonly trustedRoot: string,
    readonly directory: string,
    private readonly metadata: TraceMetadata,
    private readonly limits: AgentTailSegmentLimits,
    private crashPoint?: "before_claim_manifest",
  ) {
    this.rootIdentity = identity(lstatSync(trustedRoot));
    this.directoryIdentity = identity(lstatSync(directory));
    this.projectionCursorName = `agent-tail-segments:${metadata.traceIdSha256}`;
  }
  private readonly rootIdentity: FileIdentity;
  private readonly directoryIdentity: FileIdentity;

  select(events: readonly StoredEvent[]): readonly StoredEvent[] {
    return events;
  }

  append(events: readonly StoredEvent[]): void {
    this.assertIdentities();
    if (this.closed) throw new Error("Agent Tail segment store is closed");
    if (events.length === 0) return;
    assertContiguous(events);
    const afterPosition = events[0]!.globalPosition - 1;
    const throughPosition = events.at(-1)!.globalPosition;
    const claimName = `${position(afterPosition)}-${position(throughPosition)}.claim.json`;
    const lines: Array<{ readonly event: StoredEvent; readonly line: string }> = [];
    const withheld: string[] = [];
    for (const event of events) {
      if (event.correlationId !== this.metadata.traceId) continue;
      if (!isAgentTailProjectableEventType(event.type)) {
        withheld.push(this.publishWithholding(event));
        continue;
      }
      lines.push({ event, line: agentTailEventToJsonLine(storedEventToAgentTailEvent(event)) });
    }
    const segments = this.publishSegments(afterPosition, throughPosition, lines);
    const manifest: ClaimManifest = {
      schemaVersion: 1,
      afterPosition,
      throughPosition,
      segments,
      withheld,
    };
    if (this.crashPoint === "before_claim_manifest") {
      this.crashPoint = undefined;
      throw new Error("simulated crash before Agent Tail claim manifest publication");
    }
    publishOrVerify(this.directory, claimName, `${JSON.stringify(manifest)}\n`, () => this.assertIdentities());
    fsyncDirectory(this.directory);
  }

  reconcile(events: readonly StoredEvent[]): void {
    this.append(events);
  }

  reconcileHistory(committed: Iterable<StoredEvent>): void {
    const history = [...committed];
    const expected = history
      .filter((event) => event.correlationId === this.metadata.traceId &&
        isAgentTailProjectableEventType(event.type))
      .map((event) => agentTailEventToJsonLine(storedEventToAgentTailEvent(event))).join("");
    const actual = this.canonicalBytes().toString("utf8");
    if (actual !== expected) throw new Error("Agent Tail segments do not match authoritative history");
    const expectedWithheld = history
      .filter((event) => event.correlationId === this.metadata.traceId &&
        !isAgentTailProjectableEventType(event.type))
      .map((event) => withholdingName(event)).sort();
    const actualWithheld = this.claims().flatMap((claim) => claim.withheld).sort();
    if (JSON.stringify(actualWithheld) !== JSON.stringify(expectedWithheld)) {
      throw new Error("Agent Tail withholding alerts do not match authoritative history");
    }
    for (const event of history.filter((candidate) => candidate.correlationId === this.metadata.traceId &&
      !isAgentTailProjectableEventType(candidate.type))) {
      if (readRestricted(path.join(this.directory, withholdingName(event))) !== withholdingContent(event)) {
        throw new Error("Agent Tail withholding alert conflicts with authoritative history");
      }
    }
  }

  repairTornClaim(
    journal: DurablePagedEventJournal,
    projectionName: string,
    claimId: string,
    claimantId: string,
    committed: Iterable<StoredEvent>,
  ): void {
    const claim = journal.inspectProjectionClaim(projectionName);
    if (claim === null || claim.claimId !== claimId || claim.claimantId !== claimantId) {
      throw new Error("Agent Tail segment recovery requires exact claim ownership");
    }
    this.append(claim.events);
    const expectedCommitted = [...committed]
      .filter((event) => event.correlationId === this.metadata.traceId &&
        isAgentTailProjectableEventType(event.type))
      .map((event) => agentTailEventToJsonLine(storedEventToAgentTailEvent(event))).join("");
    const actualCommitted = this.canonicalBytes(claim.afterPosition).toString("utf8");
    if (actualCommitted !== expectedCommitted) {
      throw new Error("Agent Tail committed segments do not match authoritative history");
    }
  }

  report(): AgentTailTraceReport {
    this.assertIdentities();
    const claims = this.claims();
    const bytes = this.canonicalBytes();
    const lines = bytes.length === 0 ? [] : bytes.toString("utf8").trimEnd().split("\n");
    const withheld = claims.flatMap((claim) => claim.withheld).sort();
    return {
      traceId: this.metadata.traceId,
      throughPosition: claims.at(-1)?.throughPosition ?? 0,
      eventCount: lines.length,
      segmentCount: new Set(claims.flatMap((claim) => claim.segments)).size,
      byteLength: bytes.length,
      contentSha256: sha256(bytes),
      withheldCount: withheld.length,
      withheldDigests: Object.freeze(withheld.map((name) => name.split("-").at(-1)!.replace(".withheld.json", ""))),
    };
  }

  canonicalBytes(throughPosition = Number.MAX_SAFE_INTEGER): Buffer {
    this.assertIdentities();
    const segments = [...new Set(this.claims()
      .filter((claim) => claim.throughPosition <= throughPosition)
      .flatMap((claim) => claim.segments))].sort();
    const combined = Buffer.concat(segments.map((name) => {
      const match = SEGMENT_NAME.exec(name);
      if (match === null) throw new Error("Agent Tail segment name is corrupt");
      const bytes = readRestrictedBytes(path.join(this.directory, name));
      if (sha256(bytes) !== match[4]) throw new Error("Agent Tail segment digest is corrupt");
      return bytes;
    }));
    if (combined.length > 0) validateSegmentLines(combined, this.metadata.traceId);
    return combined;
  }

  close(): void { this.closed = true; }

  private publishSegments(
    afterPosition: number,
    throughPosition: number,
    lines: readonly { readonly event: StoredEvent; readonly line: string }[],
  ): readonly string[] {
    const segments: string[] = [];
    let pending: typeof lines = [];
    let bytes = 0;
    const flush = (): void => {
      if (pending.length === 0) return;
      const content = pending.map(({ line }) => line).join("");
      const digest = sha256(content);
      const name = `${position(afterPosition)}-${position(throughPosition)}-${String(segments.length).padStart(4, "0")}-${digest}.jsonl`;
      publishOrVerify(this.directory, name, content, () => this.assertIdentities());
      segments.push(name);
      pending = [];
      bytes = 0;
    };
    for (const item of lines) {
      const lineBytes = Buffer.byteLength(item.line, "utf8");
      if (lineBytes > this.limits.maxBytes) throw new Error("Agent Tail event exceeds the segment byte limit");
      if (pending.length === this.limits.maxEvents || bytes + lineBytes > this.limits.maxBytes) flush();
      pending = [...pending, item];
      bytes += lineBytes;
    }
    flush();
    return Object.freeze(segments);
  }

  private publishWithholding(event: StoredEvent): string {
    const name = withholdingName(event);
    const content = withholdingContent(event);
    publishOrVerify(this.directory, name, content, () => this.assertIdentities());
    return name;
  }

  private claims(): readonly ClaimManifest[] {
    const names = readdirSync(this.directory).filter((name) => name.endsWith(".claim.json")).sort();
    let expectedAfter = 0;
    const claims = names.map((name) => {
      const match = CLAIM_NAME.exec(name);
      if (match === null) throw new Error("Agent Tail claim name is corrupt");
      const claim = JSON.parse(readRestricted(path.join(this.directory, name))) as ClaimManifest;
      if (claim.schemaVersion !== 1 || claim.afterPosition !== Number(match[1]) ||
        claim.throughPosition !== Number(match[2]) || claim.afterPosition !== expectedAfter ||
        claim.throughPosition <= claim.afterPosition || !Array.isArray(claim.segments) ||
        !Array.isArray(claim.withheld)) {
        throw new Error("Agent Tail claim manifest is corrupt");
      }
      expectedAfter = claim.throughPosition;
      for (const withheld of claim.withheld) this.validateWithholding(withheld);
      return claim;
    });
    const expected = new Set(["trace.meta.json", ...names,
      ...claims.flatMap((claim) => [...claim.segments, ...claim.withheld])]);
    const unexpected = readdirSync(this.directory).filter((name) =>
      !expected.has(name) && (name.endsWith(".jsonl") || name.endsWith(".json") || name.startsWith(".tmp-")));
    if (unexpected.length > 0) throw new Error("Agent Tail trace contains an orphan publication");
    return claims;
  }

  private validateWithholding(name: string): void {
    const match = /^(\d{16})-([a-f0-9]{64})\.withheld\.json$/.exec(name);
    if (match === null) throw new Error("Agent Tail withholding alert name is corrupt");
    const alert = JSON.parse(readRestricted(path.join(this.directory, name))) as Record<string, unknown>;
    if (alert["schemaVersion"] !== 1 || alert["code"] !== "unknown_event_policy" ||
      alert["globalPosition"] !== Number(match[1]) || alert["eventIdSha256"] !== match[2] ||
      typeof alert["nativeTypeSha256"] !== "string" || !/^[a-f0-9]{64}$/.test(alert["nativeTypeSha256"] as string)) {
      throw new Error("Agent Tail withholding alert is corrupt");
    }
  }

  private assertIdentities(): void {
    const root = lstatSync(this.trustedRoot);
    const directory = lstatSync(this.directory);
    assertSameIdentity(root, this.rootIdentity, "trusted root");
    assertSameIdentity(directory, this.directoryIdentity, "trace directory");
    assertPrivateDirectory(this.trustedRoot);
    assertPrivateDirectory(this.directory);
  }
}

function withholdingName(event: StoredEvent): string {
  return `${position(event.globalPosition)}-${sha256(event.eventId)}.withheld.json`;
}

function withholdingContent(event: StoredEvent): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    code: "unknown_event_policy",
    globalPosition: event.globalPosition,
    eventIdSha256: sha256(event.eventId),
    nativeTypeSha256: sha256(event.type),
  })}\n`;
}

function validateSegmentLines(bytes: Buffer, traceId: string): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw new Error("Agent Tail segment has an incomplete line");
  let prior = -1;
  const ids = new Set<string>();
  for (const line of text.trimEnd().split("\n")) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event["trace_id"] !== traceId || typeof event["event_id"] !== "string" ||
      ids.has(event["event_id"] as string) || !Number.isSafeInteger(event["sequence"]) ||
      (event["sequence"] as number) <= prior) throw new Error("Agent Tail segment event identity is corrupt");
    ids.add(event["event_id"] as string);
    prior = event["sequence"] as number;
  }
}

function parseMetadata(content: string): TraceMetadata {
  const value = JSON.parse(content) as TraceMetadata;
  if (value.schemaVersion !== 1 || value.projectionVersion !== PROJECTION_VERSION ||
    value.redactionVersion !== REDACTION_VERSION || sha256(value.traceId) !== value.traceIdSha256) {
    throw new Error("Agent Tail trace metadata is corrupt or incompatible");
  }
  assertTraceIdentity(value.traceId);
  return value;
}

function validateLimits(value: AgentTailSegmentLimits | undefined): AgentTailSegmentLimits {
  const limits = value ?? DEFAULT_LIMITS;
  if (!Number.isSafeInteger(limits.maxEvents) || limits.maxEvents < 1 || limits.maxEvents > 10_000 ||
    !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > 64 * 1024 * 1024) {
    throw new Error("Agent Tail segment limits are invalid");
  }
  return limits;
}

function assertContiguous(events: readonly StoredEvent[]): void {
  let expected = events[0]!.globalPosition;
  const ids = new Set<string>();
  for (const event of events) {
    if (event.globalPosition !== expected || ids.has(event.eventId)) {
      throw new Error("Agent Tail journal claim order or identity is corrupt");
    }
    ids.add(event.eventId);
    expected += 1;
  }
}

function canonicalPrivateRoot(root: string): string {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || realpathSync.native(root) !== root) {
    throw new Error("Agent Tail trusted root must be canonical and absolute");
  }
  assertPrivateDirectory(root);
  return root;
}

function assertPrivateDirectory(directory: string): void {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid())) {
    throw new Error("Agent Tail trace directory must be private and nonsymlinked");
  }
}

function assertDirectChild(root: string, candidate: string): void {
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate || path.dirname(candidate) !== root) {
    throw new Error("Agent Tail trace directory must be a direct child of the trusted root");
  }
}

function assertTraceIdentity(traceId: string): void {
  assertAgentTailExternalIdentity(traceId, "trace identity");
}

function publishOrVerify(directory: string, name: string, content: string, verifyParent?: () => void): void {
  publish(directory, name, content, verifyParent);
}

function publish(directory: string, name: string, content: string, verifyParent?: () => void): void {
  verifyParent?.();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(name)) throw new Error("Agent Tail publication name is unsafe");
  const destination = path.join(directory, name);
  const bytes = Buffer.from(content, "utf8");
  const temporary = path.join(directory, `.tmp-${sha256(bytes)}`);
  if (existsSync(destination)) {
    if (existsSync(temporary)) {
      const target = lstatSync(destination);
      const temp = lstatSync(temporary);
      if (target.dev !== temp.dev || target.ino !== temp.ino) {
        throw new Error("Agent Tail publication temporary identity conflicts");
      }
      unlinkSync(temporary);
      fsyncDirectory(directory);
      verifyParent?.();
    }
    if (readRestricted(destination) !== content) throw new Error("Agent Tail retained publication conflicts with journal truth");
    return;
  }
  if (!existsSync(temporary)) {
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
      constants.O_NOFOLLOW, 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
        if (written <= 0) throw new Error("Agent Tail publication write made no progress");
        offset += written;
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } else {
    const info = lstatSync(temporary);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      readFileSync(temporary).compare(bytes) !== 0) throw new Error("Agent Tail temporary publication is corrupt");
  }
  chmodSync(temporary, 0o400);
  linkSync(temporary, destination);
  verifyParent?.();
  unlinkSync(temporary);
  fsyncDirectory(directory);
  verifyParent?.();
}

function readRestricted(filePath: string): string { return readRestrictedBytes(filePath).toString("utf8"); }

function readRestrictedBytes(filePath: string): Buffer {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o400 ||
      info.size > 64 * 1024 * 1024) throw new Error("Agent Tail retained file is unsafe");
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function position(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9_999_999_999_999_999) {
    throw new Error("Agent Tail position is invalid");
  }
  return String(value).padStart(16, "0");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function identity(info: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

function assertSameIdentity(
  info: { readonly dev: number; readonly ino: number },
  expected: FileIdentity,
  label: string,
): void {
  if (info.dev !== expected.dev || info.ino !== expected.ino) {
    throw new Error(`Agent Tail ${label} identity changed`);
  }
}
