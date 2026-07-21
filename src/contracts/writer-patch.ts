import { z } from "zod";
import { createHash } from "node:crypto";

import { digestCanonical } from "./authority-attention.js";
import { SafeLogicalPathSchema } from "./milestone.js";
import { canonicalDarwinPathIdentity } from "../milestones/path-ownership.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RevisionSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const MAX_PATCH_BYTES = 1024 * 1024;

const PatchOperationSchema = z.strictObject({
  path: SafeLogicalPathSchema.refine((value) => !value.includes("*") && value === value.normalize("NFC") &&
    !isProtectedPath(value),
    "patch operation path must be a concrete NFC path"),
  expectedSha256: DigestSchema.nullable(),
  content: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MAX_PATCH_BYTES,
    "patch content exceeds the per-file byte limit"),
  contentSha256: DigestSchema,
}).superRefine((operation, context) => {
  if (digestText(operation.content) !== operation.contentSha256) {
    context.addIssue({ code: "custom", message: "patch content digest mismatch" });
  }
});

const PatchProposalBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("zentra.patch_proposal"),
  proposalId: z.string().min(1).max(256),
  baseRevision: RevisionSchema,
  operations: z.array(PatchOperationSchema).min(1).max(256),
}).superRefine((proposal, context) => {
  if (new Set(proposal.operations.map((operation) => operation.path)).size !== proposal.operations.length) {
    context.addIssue({ code: "custom", message: "patch proposal paths must be unique" });
  }
  if (new Set(proposal.operations.map((operation) => canonicalDarwinPathIdentity(operation.path))).size !==
    proposal.operations.length) {
    context.addIssue({ code: "custom", message: "patch proposal paths must be unique by Darwin filesystem identity" });
  }
  const identities = proposal.operations.map((operation) => canonicalDarwinPathIdentity(operation.path));
  for (let left = 0; left < identities.length; left += 1) {
    for (let right = left + 1; right < identities.length; right += 1) {
      const first = identities[left]!;
      const second = identities[right]!;
      if (first.startsWith(`${second}/`) || second.startsWith(`${first}/`)) {
        context.addIssue({ code: "custom", message: "patch proposal paths must not have ancestor or descendant conflicts" });
      }
    }
  }
  const bytes = proposal.operations.reduce((total, operation) =>
    total + Buffer.byteLength(operation.content, "utf8"), 0);
  if (bytes > MAX_PATCH_BYTES) context.addIssue({ code: "custom", message: "patch proposal exceeds total byte limit" });
});

export const WriterPatchProposalSchema = PatchProposalBodySchema.extend({ digest: DigestSchema })
  .superRefine((proposal, context) => {
    const { digest, ...body } = proposal;
    if (digest !== digestCanonical(body)) context.addIssue({ code: "custom", message: "patch proposal digest mismatch" });
  });

export type WriterPatchProposal = z.infer<typeof WriterPatchProposalSchema>;

export function buildWriterPatchProposal(input: z.input<typeof PatchProposalBodySchema>): WriterPatchProposal {
  const body = PatchProposalBodySchema.parse(input);
  return WriterPatchProposalSchema.parse({ ...body, digest: digestCanonical(body) });
}

export function extractWriterPatchProposal(events: readonly unknown[]): WriterPatchProposal {
  const candidates: unknown[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
    const record = event as Readonly<Record<string, unknown>>;
    const part = typeof record["part"] === "object" && record["part"] !== null && !Array.isArray(record["part"])
      ? record["part"] as Readonly<Record<string, unknown>> : null;
    const type = record["type"] ?? part?.["type"];
    const text = record["text"] ?? part?.["text"];
    if (type !== "text" || typeof text !== "string") continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null &&
        (parsed as Readonly<Record<string, unknown>>)["kind"] === "zentra.patch_proposal") candidates.push(parsed);
    } catch {
      // Non-proposal model text is not authority.
    }
  }
  if (candidates.length !== 1) throw new Error("OpenCode writer must emit exactly one typed patch proposal");
  return WriterPatchProposalSchema.parse(candidates[0]);
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isProtectedPath(value: string): boolean {
  const canonical = value.normalize("NFD").toUpperCase().toLowerCase().normalize("NFD");
  return canonical === ".git" || canonical.startsWith(".git/") ||
    canonical === ".env" || canonical.startsWith(".env.");
}
