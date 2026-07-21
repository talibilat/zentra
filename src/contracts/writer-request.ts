import { z } from "zod";

import { SafeLogicalPathSchema } from "./milestone.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RevisionSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const CanonicalPathSetSchema = z.array(SafeLogicalPathSchema).min(1).max(256)
  .superRefine((paths, context) => {
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: "custom", message: "writer paths must be unique" });
    }
  });

export const MultiFileWriterRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256),
  baseRevision: RevisionSchema,
  readPaths: CanonicalPathSetSchema,
  potentialWritePaths: CanonicalPathSetSchema,
  claimedWritePaths: CanonicalPathSetSchema,
  forbiddenPaths: z.array(SafeLogicalPathSchema).max(256),
  checkpoint: z.strictObject({
    maxDurationMs: z.number().int().positive().max(24 * 60 * 60 * 1_000),
    maxToolCalls: z.number().int().positive().max(1_000_000),
  }),
});

export const WriterCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  checkpointId: z.string().min(1).max(256),
  claimId: z.string().min(1).max(256),
  revision: RevisionSchema,
  diffSha256: DigestSchema,
  toolEvidenceSha256: DigestSchema,
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative().max(2_000_000),
    outputTokens: z.number().int().nonnegative().max(2_000_000),
    reasoningTokens: z.number().int().nonnegative().max(2_000_000).default(0),
    cacheReadTokens: z.number().int().nonnegative().max(2_000_000).default(0),
    cacheWriteTokens: z.number().int().nonnegative().max(2_000_000).default(0),
    toolCalls: z.number().int().nonnegative().max(100_000),
  }),
  recordedAt: z.string().datetime(),
});

export type MultiFileWriterRequest = z.infer<typeof MultiFileWriterRequestSchema>;
export type WriterCheckpoint = z.infer<typeof WriterCheckpointSchema>;

export function assertCorrectionWithinWriterEnvelope(
  approvedPaths: readonly string[],
  correctionPaths: readonly string[],
): void {
  if (correctionPaths.length === 0 || correctionPaths.some((candidate) =>
    !approvedPaths.some((approved) => logicalScopeContains(approved, candidate)))) {
    throw new Error("writer correction expands the approved path envelope");
  }
}

function logicalScopeContains(scope: string, candidate: string): boolean {
  const fold = (value: string) => value.normalize("NFD").toUpperCase().toLowerCase().normalize("NFD");
  const recursive = scope === "**" || scope.endsWith("/**");
  const base = fold(scope === "**" ? "" : scope.replace(/\/\*\*$/, ""));
  const logicalPath = fold(candidate.replace(/\/\*\*$/, ""));
  return recursive
    ? base === "" || logicalPath === base || logicalPath.startsWith(`${base}/`)
    : logicalPath === base;
}
