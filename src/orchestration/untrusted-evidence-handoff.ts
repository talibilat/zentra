import { z } from "zod";
import { createHash } from "node:crypto";

import { parseOpenCodeMilestonePayload } from "../agents/opencode-agent-events.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import type { EventJournal } from "../journal/journal.js";
import { parseWebResearchEventPayload } from "../research/web-research.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const HandoffSourceSchema = z.strictObject({
  evidenceId: DigestSchema,
  sourceUrl: z.string().url(),
  method: z.enum(["GET", "HEAD"]),
  status: z.number().int().min(200).max(299),
  contentSha256: DigestSchema,
  compressedBytes: z.number().int().nonnegative(),
  decompressedBytes: z.number().int().nonnegative(),
});
const HandoffItemSchema = z.strictObject({
  taskId: z.string().min(1).max(256),
  role: z.enum(["planner", "researcher"]),
  actorId: z.string().min(1).max(256),
  capabilityId: z.string().min(1).max(256),
  transportModelId: z.string().min(1).max(256),
  repositoryRevision: DigestSchema,
  kind: z.enum(["plan", "research", "finding"]),
  summary: z.string().min(1).max(32 * 1024),
  sha256: DigestSchema,
  sourceEvidenceIds: z.array(DigestSchema).max(128),
  sources: z.array(HandoffSourceSchema).max(128),
}).superRefine((item, context) => {
  if (item.sha256 !== createHash("sha256").update(item.summary, "utf8").digest("hex")) {
    context.addIssue({ code: "custom", message: "evidence handoff summary digest mismatch" });
  }
  const cited = [...item.summary.matchAll(/\[source:([a-f0-9]{64})\]/g)].map((match) => match[1]!);
  if (JSON.stringify([...cited].sort()) !== JSON.stringify([...item.sourceEvidenceIds].sort())) {
    context.addIssue({ code: "custom", message: "evidence handoff citations do not match source references" });
  }
  if (JSON.stringify(item.sources.map((source) => source.evidenceId).sort()) !==
    JSON.stringify([...item.sourceEvidenceIds].sort())) {
    context.addIssue({ code: "custom", message: "evidence handoff source facts do not match source references" });
  }
});
const HandoffBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  authority: z.literal("guidance_only"),
  baseRevisionSha256: DigestSchema,
  items: z.array(HandoffItemSchema).min(2).max(128),
});
export const UntrustedEvidenceHandoffSchema = HandoffBodySchema.extend({ digest: DigestSchema })
  .superRefine((handoff, context) => {
    const { digest, ...body } = handoff;
    if (digest !== digestCanonical(body)) context.addIssue({ code: "custom", message: "evidence handoff digest mismatch" });
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 64 * 1024) {
      context.addIssue({ code: "custom", message: "evidence handoff exceeds its size limit" });
    }
    if (!handoff.items.some((item) => item.role === "planner") || !handoff.items.some((item) => item.role === "researcher")) {
      context.addIssue({ code: "custom", message: "evidence handoff requires planner and researcher provenance" });
    }
  });

export type UntrustedEvidenceHandoff = z.infer<typeof UntrustedEvidenceHandoffSchema>;

export function retainedGuidanceHandoff(
  journal: EventJournal,
  milestoneId: string,
  taskIds: readonly string[],
  expectedBaseRevisionSha256?: string,
  requiredSource?: { readonly url: string; readonly method: "GET"; readonly status: 200 },
): UntrustedEvidenceHandoff {
  const expected = new Set(taskIds);
  const retainedSources = new Map(journal.readAll()
    .filter((event) => event.type === "web_research.observed")
    .map((event) => parseWebResearchEventPayload(event.type, event.payload) as {
      readonly outcome: string;
      readonly evidence: null | z.infer<typeof HandoffSourceSchema>;
    })
    .filter((result) => result.outcome === "completed" && result.evidence !== null)
    .map((result) => {
      const evidence = result.evidence!;
      const source = HandoffSourceSchema.parse({
        evidenceId: evidence.evidenceId,
        sourceUrl: evidence.sourceUrl,
        method: evidence.method,
        status: evidence.status,
        contentSha256: evidence.contentSha256,
        compressedBytes: evidence.compressedBytes,
        decompressedBytes: evidence.decompressedBytes,
      });
      return [source.evidenceId, source] as const;
    }));
  const items = journal.readStream(milestoneId)
    .filter((event) => event.type === "milestone.task_completed" &&
      typeof event.payload === "object" && event.payload !== null &&
      expected.has(String((event.payload as Readonly<Record<string, unknown>>)["taskId"])))
    .map((event) => parseOpenCodeMilestonePayload(event.type, event.payload) as {
      readonly taskId: string;
      readonly role: "planner" | "researcher" | "reviewer";
      readonly actorId: string;
      readonly capabilityId: string;
      readonly transportModelId: string;
      readonly evidence: readonly {
        readonly kind: "plan" | "research" | "finding" | "review";
        readonly summary: string;
        readonly sourceEvidenceIds?: readonly string[];
        readonly sha256: string;
        readonly provenance: { readonly repositoryRevision: string };
      }[];
    })
    .filter((completion) => completion.role === "planner" || completion.role === "researcher")
    .flatMap((completion) => completion.evidence.map((evidence) => HandoffItemSchema.parse({
      taskId: completion.taskId,
      role: completion.role,
      actorId: completion.actorId,
      capabilityId: completion.capabilityId,
      transportModelId: completion.transportModelId,
      repositoryRevision: evidence.provenance.repositoryRevision,
      kind: evidence.kind,
      summary: evidence.summary,
      sha256: evidence.sha256,
      sourceEvidenceIds: [...(evidence.sourceEvidenceIds ?? [])],
      sources: [...(evidence.sourceEvidenceIds ?? [])].map((evidenceId) => {
        const source = retainedSources.get(evidenceId);
        if (source === undefined) throw new Error("evidence handoff source reference is not retained");
        return source;
      }),
    })));
  const revisions = [...new Set(items.map((item) => item.repositoryRevision))];
  const baseRevisionSha256 = expectedBaseRevisionSha256 ?? revisions[0];
  if (baseRevisionSha256 === undefined || revisions.length !== 1 || items.some((item) => item.repositoryRevision !== baseRevisionSha256)) {
    throw new Error("planner or researcher evidence is stale for the intended writer base");
  }
  if (requiredSource !== undefined) {
    const matches = items.flatMap((item) => item.sources).filter((source) =>
      source.sourceUrl === requiredSource.url && source.method === requiredSource.method &&
      source.status === requiredSource.status && source.contentSha256.length === 64 &&
      source.compressedBytes > 0 && source.decompressedBytes > 0);
    if (matches.length !== 1) throw new Error("required research source evidence is missing or invalid");
  }
  const body = HandoffBodySchema.parse({ schemaVersion: 1, authority: "guidance_only", baseRevisionSha256, items });
  return UntrustedEvidenceHandoffSchema.parse({ ...body, digest: digestCanonical(body) });
}
