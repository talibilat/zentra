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
  byteCount: z.number().int().positive().max(8 * 1024 * 1024),
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
export const OpenCodeWriterEventChainSchema = ChainBodySchema.extend({ chainSha256: DigestSchema }).superRefine((chain, context) => {
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

export type OpenCodeWriterEventChain = z.infer<typeof OpenCodeWriterEventChainSchema>;

export function createOpenCodeWriterEventChain(rawStdout: string, parsedEvents: readonly unknown[]): OpenCodeWriterEventChain {
  if (parsedEvents.length === 0) {
    const body = ChainBodySchema.parse({ schemaVersion: 1, rawOutputPolicy: "not_retained",
      stdoutBytes: Buffer.byteLength(rawStdout, "utf8"), stdoutSha256: sha256(rawStdout), events: [] });
    return OpenCodeWriterEventChainSchema.parse({ ...body, chainSha256: digestCanonical(body) });
  }
  if (!rawStdout.endsWith("\n")) throw new Error("OpenCode writer JSON output must end on an event boundary");
  const rawLines = rawStdout.slice(0, -1).split("\n");
  if (rawLines.length !== parsedEvents.length || rawLines.length === 0) throw new Error("OpenCode writer output contains non-event data");
  let prefix = "";
  let previousPrefixSha256 = sha256(prefix);
  const events = rawLines.map((line, sequence) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line.trim()); } catch { throw new Error("OpenCode writer output contains invalid JSON"); }
    if (digestCanonical(parsed) !== digestCanonical(parsedEvents[sequence])) throw new Error("OpenCode writer parsed event order changed");
    const record = objectRecord(parsed);
    const part = objectRecord(record["part"]);
    const type = stringField(record, "type") ?? stringField(part, "type");
    if (type === null) throw new Error("OpenCode writer event has no native type");
    const status = stringField(record, "status") ?? stringField(part, "status");
    const tool = stringField(record, "tool") ?? stringField(part, "tool");
    const path = stringField(record, "path") ?? stringField(part, "path");
    const framed = `${line}\n`;
    prefix += framed;
    const body = EventBodySchema.parse({
      sequence,
      type,
      status,
      tool,
      pathSha256: path === null ? null : sha256(path),
      lineSha256: sha256(framed),
      byteCount: Buffer.byteLength(framed, "utf8"),
      previousPrefixSha256,
      prefixSha256: sha256(prefix),
    });
    previousPrefixSha256 = body.prefixSha256;
    return EventSchema.parse({ ...body, normalizedSha256: digestCanonical(body) });
  });
  const body = ChainBodySchema.parse({
    schemaVersion: 1,
    rawOutputPolicy: "not_retained",
    stdoutBytes: Buffer.byteLength(rawStdout, "utf8"),
    stdoutSha256: sha256(rawStdout),
    events,
  });
  return OpenCodeWriterEventChainSchema.parse({ ...body, chainSha256: digestCanonical(body) });
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
