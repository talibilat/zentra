import path from "node:path";
import { z } from "zod";

// Best-effort guard against configuring shell "-c" wrappers as validation
// commands. This is NOT a security boundary: the real boundary is that only
// named project commands run and they are spawned with shell: false. This
// check merely catches obvious misconfiguration.
const FORBIDDEN_SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "fish",
  "pwsh",
  "powershell",
]);

// Matches "-c" including combined short flags such as "-lc" or "-ec".
const COMBINED_C_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function stripEnvPrefix(command: readonly string[]): readonly string[] {
  const executable = command[0];
  if (executable === undefined || path.basename(executable) !== "env") {
    return command;
  }
  let index = 1;
  while (index < command.length && ENV_ASSIGNMENT.test(command[index] ?? "")) {
    index += 1;
  }
  return command.slice(index);
}

function isShellWrapperCommand(command: readonly string[]): boolean {
  const effective = stripEnvPrefix(command);
  const executable = effective[0];
  if (executable === undefined) {
    return false;
  }
  const basename = path.basename(executable).toLowerCase();
  return (
    FORBIDDEN_SHELLS.has(basename) &&
    effective.slice(1).some((argument) => COMBINED_C_FLAG.test(argument))
  );
}

const CommandSchema = z
  .tuple([z.string().min(1)])
  .rest(z.string())
  .refine((command) => !isShellWrapperCommand(command), {
    message:
      "Validation commands must be direct executable invocations, not shell -c wrappers",
  });

export const ProjectConfigSchema = z.object({
  projectId: z.string().min(1),
  repositoryPath: z.string().refine(path.isAbsolute),
  integrationBranch: z.string().min(1),
  worktreeRoot: z.string().refine(path.isAbsolute),
  validations: z.object({
    focused: CommandSchema,
    full: CommandSchema,
  }),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
