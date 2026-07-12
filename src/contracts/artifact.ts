import { z } from "zod";

export const ArtifactSchema = z.object({
  artifactId: z.string().min(1),
  taskId: z.string().min(1),
  kind: z.enum(["patch", "validation_report", "review_report", "integration_receipt"]),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;
