import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import type { StoredEvent } from "../contracts/event.js";
import {
  agentTailEventToJsonLine,
  storedEventToAgentTailEvent,
} from "./agent-tail.js";

export class AgentTailJsonlFileSink {
  private readonly eventIds = new Set<string>();
  private lastGlobalPosition = -1;
  private closed = false;
  private liveStreamFailed = false;

  static open(
    trustedRoot: string,
    tracePath: string,
    liveWriter?: (line: string) => void,
  ): AgentTailJsonlFileSink {
    assertSafeAgentTailJsonlPath(trustedRoot, tracePath);
    let descriptor: number;
    try {
      descriptor = openSync(
        tracePath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (isFileExistsError(error)) {
        throw new Error("Agent Tail trace path must not already exist");
      }
      throw error;
    }
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw new Error("Agent Tail trace destination must be a regular file");
      }
      return new AgentTailJsonlFileSink(descriptor, liveWriter);
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  private constructor(
    private readonly descriptor: number,
    private readonly liveWriter?: (line: string) => void,
  ) {}

  get streamFailed(): boolean {
    return this.liveStreamFailed;
  }

  append(events: readonly StoredEvent[]): void {
    if (this.closed) throw new Error("Agent Tail trace sink is closed");
    const pendingIds = new Set(this.eventIds);
    let pendingPosition = this.lastGlobalPosition;
    const lines = events.map((event) => {
      if (pendingIds.has(event.eventId)) {
        throw new Error("Agent Tail trace event was already appended");
      }
      if (event.globalPosition <= pendingPosition) {
        throw new Error("Agent Tail trace events must follow journal order");
      }
      pendingIds.add(event.eventId);
      pendingPosition = event.globalPosition;
      return Buffer.from(agentTailEventToJsonLine(storedEventToAgentTailEvent(event)), "utf8");
    });

    for (const line of lines) writeAll(this.descriptor, line);
    if (lines.length > 0) fsyncSync(this.descriptor);
    this.eventIds.clear();
    for (const eventId of pendingIds) this.eventIds.add(eventId);
    this.lastGlobalPosition = pendingPosition;

    if (this.liveWriter !== undefined && !this.liveStreamFailed) {
      try {
        for (const line of lines) this.liveWriter(line.toString("utf8"));
      } catch {
        this.liveStreamFailed = true;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.descriptor);
  }
}

export function assertSafeAgentTailJsonlPath(trustedRoot: string, tracePath: string): void {
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

  assertSafeDirectory(trustedRoot, trustedRoot);
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
    lstatSync(tracePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("Agent Tail trace path must not already exist");
}

function assertSafeDirectory(directory: string, trustedRoot: string): void {
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
  const relative = path.relative(trustedRoot, canonical);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Agent Tail trace path must remain inside the trusted root");
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ELOOP");
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
