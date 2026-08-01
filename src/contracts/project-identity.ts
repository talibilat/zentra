import path from "node:path";

import { z } from "zod";

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]+$/u;

export const HumanTitleSchema = z.string().trim().min(1).max(160).regex(SAFE_TEXT);

export const ProjectIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  title: HumanTitleSchema,
  repositoryPath: z.string().min(1).max(4_096).refine((value) => path.isAbsolute(value), "repository path must be absolute"),
});

export const SubmissionDirectorySchema = z.strictObject({
  path: z.string().min(1).max(4_096).refine((value) => path.isAbsolute(value), "submission directory must be absolute"),
  projectRelativePath: z.string().min(1).max(4_096),
});

export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;
export type SubmissionDirectory = z.infer<typeof SubmissionDirectorySchema>;

export function deriveProjectTitle(repositoryPath: string): string {
  const basename = path.basename(repositoryPath).replace(UNSAFE_TEXT, " ").replace(/[-_]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (basename === "") return "Project";
  return Array.from(basename).slice(0, 160).join("");
}

export function deriveRunTitle(value: string): string {
  const normalized = value.replace(UNSAFE_TEXT, " ").replace(/\s+/gu, " ").trim();
  if (normalized === "") return "Untitled run";
  const characters = Array.from(normalized);
  return characters.length <= 160 ? normalized : `${characters.slice(0, 159).join("")}…`;
}
