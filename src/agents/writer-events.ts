import { createHash } from "node:crypto";

import { z } from "zod";

import { digestCanonical } from "../contracts/authority-attention.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const NativeFieldSchema = z.string().min(1).max(256);
const EventBodySchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  type: NativeFieldSchema,
  status: NativeFieldSchema.nullable(),
  tool: NativeFieldSchema.nullable(),
  pathSha256: DigestSchema.nullable(),
  lineSha256: DigestSchema,
  // nonnegative, not positive: a Claude Code line with several nested tool_use
  // blocks (see claudeCodeToolUseBlocks) retains one event per block, and only
  // the block that carries the line's bytes has byteCount > 0 - the rest are
  // zero-byte events over the same already-accounted-for bytes. Every OpenCode
  // event is still produced with its real positive byteCount, so this widening
  // does not change any value OpenCode's chain emits.
  byteCount: z.number().int().nonnegative().max(8 * 1024 * 1024),
  previousPrefixSha256: DigestSchema,
  prefixSha256: DigestSchema,
});
const EventSchema = EventBodySchema.extend({ normalizedSha256: DigestSchema }).superRefine((event, context) => {
  const { normalizedSha256, ...body } = event;
  if (normalizedSha256 !== digestCanonical(body)) context.addIssue({ code: "custom", message: "writer event digest mismatch" });
});
const ChainBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  rawOutputPolicy: z.literal("not_retained"),
  stdoutBytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
  stdoutSha256: DigestSchema,
  events: z.array(EventSchema).max(100_000),
});
export const WriterEventChainSchema = ChainBodySchema.extend({ chainSha256: DigestSchema }).superRefine((chain, context) => {
  const { chainSha256, ...body } = chain;
  if (chainSha256 !== digestCanonical(body)) context.addIssue({ code: "custom", message: "writer event chain digest mismatch" });
  let bytes = 0;
  let previous = sha256("");
  for (let index = 0; index < chain.events.length; index += 1) {
    const event = chain.events[index]!;
    if (event.sequence !== index || event.previousPrefixSha256 !== previous) {
      context.addIssue({ code: "custom", message: "writer event chain order is invalid" });
      break;
    }
    bytes += event.byteCount;
    previous = event.prefixSha256;
  }
  if ((chain.events.length > 0 && (bytes !== chain.stdoutBytes || previous !== chain.stdoutSha256)) ||
    (chain.events.length === 0 && chain.stdoutBytes === 0 && chain.stdoutSha256 !== sha256(""))) {
    context.addIssue({ code: "custom", message: "writer event chain does not match stdout evidence" });
  }
});

export type WriterEventChain = z.infer<typeof WriterEventChainSchema>;

export function createWriterEventChain(rawStdout: string, parsedEvents: readonly unknown[]): WriterEventChain {
  if (parsedEvents.length === 0) {
    const body = ChainBodySchema.parse({ schemaVersion: 1, rawOutputPolicy: "not_retained",
      stdoutBytes: Buffer.byteLength(rawStdout, "utf8"), stdoutSha256: sha256(rawStdout), events: [] });
    return WriterEventChainSchema.parse({ ...body, chainSha256: digestCanonical(body) });
  }
  if (!rawStdout.endsWith("\n")) throw new Error("OpenCode writer JSON output must end on an event boundary");
  const rawLines = rawStdout.slice(0, -1).split("\n");
  if (rawLines.length !== parsedEvents.length || rawLines.length === 0) throw new Error("OpenCode writer output contains non-event data");
  let prefix = "";
  let previousPrefixSha256 = sha256(prefix);
  let sequence = 0;
  const events: z.infer<typeof EventSchema>[] = [];
  const emit = (input: {
    readonly type: string; readonly status: string | null; readonly tool: string | null;
    readonly path: string | null; readonly lineSha256: string; readonly byteCount: number; readonly prefixSha256: string;
  }): void => {
    const body = EventBodySchema.parse({
      sequence,
      type: input.type,
      status: input.status,
      tool: input.tool,
      pathSha256: input.path === null ? null : sha256(input.path),
      lineSha256: input.lineSha256,
      byteCount: input.byteCount,
      previousPrefixSha256,
      prefixSha256: input.prefixSha256,
    });
    previousPrefixSha256 = body.prefixSha256;
    sequence += 1;
    events.push(EventSchema.parse({ ...body, normalizedSha256: digestCanonical(body) }));
  };
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const line = rawLines[lineIndex]!;
    let parsed: unknown;
    try { parsed = JSON.parse(line.trim()); } catch { throw new Error("OpenCode writer output contains invalid JSON"); }
    if (digestCanonical(parsed) !== digestCanonical(parsedEvents[lineIndex])) throw new Error("OpenCode writer parsed event order changed");
    const record = objectRecord(parsed);
    const part = objectRecord(record["part"]);
    const type = stringField(record, "type") ?? stringField(part, "type");
    if (type === null) throw new Error("OpenCode writer event has no native type");
    const framed = `${line}\n`;
    const lineSha256 = sha256(framed);
    const lineByteCount = Buffer.byteLength(framed, "utf8");
    // OpenCode's own shape never nests a "message.content[]" array, so this is
    // always empty for OpenCode and this branch is dead code on that path -
    // purely additive for Claude Code, whose tool_use blocks live here instead
    // of at the top level or under "part".
    const nestedToolUses = claudeCodeToolUseBlocks(record);
    if (nestedToolUses.length === 0) {
      const status = stringField(record, "status") ?? stringField(part, "status");
      const tool = stringField(record, "tool") ?? stringField(part, "tool");
      const path = stringField(record, "path") ?? stringField(part, "path");
      prefix += framed;
      emit({ type, status, tool, path, lineSha256, byteCount: lineByteCount, prefixSha256: sha256(prefix) });
      continue;
    }
    // Retain one "tool_use" event per nested block so the receipt invariant
    // (usage.toolCalls === retained tool_use events) holds on real evidence.
    // The byte-hash chain still accounts for every stdout byte exactly once:
    // the line's bytes are attributed to its last block, and any earlier
    // blocks on the same line are zero-byte events over bytes already
    // accounted for by that final one.
    for (let blockIndex = 0; blockIndex < nestedToolUses.length; blockIndex += 1) {
      const isLast = blockIndex === nestedToolUses.length - 1;
      const block = nestedToolUses[blockIndex]!;
      if (isLast) prefix += framed;
      emit({
        type: "tool_use",
        status: null,
        tool: block.tool,
        path: block.path,
        lineSha256: isLast ? lineSha256 : sha256(""),
        byteCount: isLast ? lineByteCount : 0,
        prefixSha256: sha256(prefix),
      });
    }
  }
  const body = ChainBodySchema.parse({
    schemaVersion: 1,
    rawOutputPolicy: "not_retained",
    stdoutBytes: Buffer.byteLength(rawStdout, "utf8"),
    stdoutSha256: sha256(rawStdout),
    events,
  });
  return WriterEventChainSchema.parse({ ...body, chainSha256: digestCanonical(body) });
}

interface ClaudeCodeToolUseBlock {
  readonly tool: string;
  readonly path: string | null;
}

/**
 * Claude Code's stream-json lines carry top-level types of only "system",
 * "assistant", "user", or "result" - its tool calls are nested inside
 * `message.content[]` as `{ type: "tool_use", name, input }` blocks, unlike
 * OpenCode's top-level or "part"-nested shape. Returns [] for any record
 * without that exact nesting, which is every OpenCode event.
 */
function claudeCodeToolUseBlocks(record: Readonly<Record<string, unknown>>): readonly ClaudeCodeToolUseBlock[] {
  const message = objectRecord(record["message"]);
  const content = message["content"];
  if (!Array.isArray(content)) return [];
  const blocks: ClaudeCodeToolUseBlock[] = [];
  for (const entry of content) {
    const block = objectRecord(entry);
    if (block["type"] !== "tool_use") continue;
    const name = block["name"];
    const tool = typeof name === "string" && name.length > 0 && name.length <= 256 ? name : "unknown";
    const input = objectRecord(block["input"]);
    const path = stringField(input, "file_path") ?? stringField(input, "path");
    blocks.push({ tool, path });
  }
  return blocks;
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
