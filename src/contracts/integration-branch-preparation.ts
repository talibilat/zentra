import { z } from "zod";

import { digestCanonical } from "./authority-attention.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const BodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  milestoneId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256),
  correlationId: z.string().min(1).max(256),
  repository: z.string().min(1).max(4_096),
  repositoryDevice: z.number().int().nonnegative().refine(Number.isSafeInteger),
  repositoryInode: z.number().int().nonnegative().refine(Number.isSafeInteger),
  commonDirectory: z.string().min(1).max(4_096),
  commonDirectoryDevice: z.number().int().nonnegative().refine(Number.isSafeInteger),
  commonDirectoryInode: z.number().int().nonnegative().refine(Number.isSafeInteger),
  fullRef: z.string().min(1).max(1_024).regex(/^refs\/heads\/.+/),
  intendedBaseCommit: CommitSchema,
});
export const IntegrationBranchPreparationIntentSchema = BodySchema.extend({ intentDigest: DigestSchema })
  .superRefine((intent, context) => {
    const { intentDigest, ...body } = intent;
    if (intentDigest !== digestCanonical(body)) context.addIssue({ code: "custom", message: "integration branch intent digest mismatch" });
  });
export const IntegrationBranchPreparationObservedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  intentDigest: DigestSchema,
  fullRef: z.string().min(1).max(1_024).regex(/^refs\/heads\/.+/),
  observedCommit: CommitSchema,
  outcome: z.literal("exact"),
});

export type IntegrationBranchPreparationIntent = z.infer<typeof IntegrationBranchPreparationIntentSchema>;
export type IntegrationBranchPreparationObserved = z.infer<typeof IntegrationBranchPreparationObservedSchema>;

export function createIntegrationBranchPreparationIntent(
  input: z.input<typeof BodySchema>,
): IntegrationBranchPreparationIntent {
  const body = BodySchema.parse(input);
  return IntegrationBranchPreparationIntentSchema.parse({ ...body, intentDigest: digestCanonical(body) });
}
