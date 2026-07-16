import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const APPROVED_VALIDATION_EXECUTABLE = realpathSync(process.execPath);
export const MIN_VALIDATION_TIMEOUT_MS = 100;
export const MAX_VALIDATION_TIMEOUT_MS = 30 * 60 * 1_000;
export const DEFAULT_FOCUSED_VALIDATION_TIMEOUT_MS = 30_000;
export const DEFAULT_FULL_VALIDATION_TIMEOUT_MS = 5 * 60 * 1_000;

export const ValidationTimeoutSchema = z
  .number()
  .int()
  .min(MIN_VALIDATION_TIMEOUT_MS)
  .max(MAX_VALIDATION_TIMEOUT_MS);

interface ExecutableIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly sha256: string;
}

const approvedValidationExecutableIdentity = executableIdentitySync(
  APPROVED_VALIDATION_EXECUTABLE,
);

function executableIdentitySync(executable: string): ExecutableIdentity {
  const before = statSync(executable);
  const content = readFileSync(executable);
  const after = statSync(executable);
  if (!sameFileVersion(before, after)) {
    throw new Error("Validation executable identity changed during approval");
  }
  return {
    device: after.dev,
    inode: after.ino,
    size: after.size,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function sameFileVersion(
  left: Awaited<ReturnType<typeof stat>>,
  right: Awaited<ReturnType<typeof stat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameExecutableIdentity(
  left: ExecutableIdentity,
  right: ExecutableIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.sha256 === right.sha256
  );
}

export function assertApprovedValidationExecutable(executable: string): void {
  if (!path.isAbsolute(executable)) {
    throw new Error("Validation executable must be an approved canonical absolute path");
  }

  let canonicalExecutable: string;
  try {
    canonicalExecutable = realpathSync(executable);
  } catch {
    throw new Error("Validation executable must be an approved canonical absolute path");
  }

  if (
    executable !== canonicalExecutable ||
    canonicalExecutable !== APPROVED_VALIDATION_EXECUTABLE
  ) {
    throw new Error("Validation executable must be an approved canonical absolute path");
  }
}

export async function assertApprovedValidationExecutableIdentity(
  executable: string,
): Promise<void> {
  assertApprovedValidationExecutable(executable);

  try {
    const canonicalExecutable = await realpath(executable);
    const before = await stat(canonicalExecutable);
    const content = await readFile(canonicalExecutable);
    const after = await stat(canonicalExecutable);
    const currentIdentity: ExecutableIdentity = {
      device: after.dev,
      inode: after.ino,
      size: after.size,
      sha256: createHash("sha256").update(content).digest("hex"),
    };

    if (
      canonicalExecutable !== APPROVED_VALIDATION_EXECUTABLE ||
      !sameFileVersion(before, after) ||
      !sameExecutableIdentity(
        currentIdentity,
        approvedValidationExecutableIdentity,
      )
    ) {
      throw new Error("Validation executable identity changed after approval");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("identity changed")) {
      throw error;
    }
    throw new Error("Validation executable identity changed after approval");
  }
}

// This catches obvious shell-wrapper misconfiguration before the stricter
// executable identity check reports the generic allowlist error.
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
const INVALID_REF_CHARACTERS = /[\u0000-\u0020\u007f~^:?*[\\]/;

function isSafeBranchName(branch: string): boolean {
  if (
    branch === "" ||
    branch === "@" ||
    branch.startsWith("-") ||
    branch.startsWith("refs/") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    INVALID_REF_CHARACTERS.test(branch)
  ) {
    return false;
  }
  return branch.split("/").every((component) =>
    component !== "" &&
    !component.startsWith(".") &&
    !component.endsWith(".") &&
    !component.toLowerCase().endsWith(".lock")
  );
}

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
  })
  .superRefine((command, context) => {
    try {
      assertApprovedValidationExecutable(command[0]);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid validation executable",
      });
    }
  });

export const ProjectConfigSchema = z.object({
  projectId: z.string().min(1),
  repositoryPath: z.string().refine(path.isAbsolute),
  integrationBranch: z.string().refine(isSafeBranchName, {
    message: "Integration branch must be a safe Git branch name",
  }),
  worktreeRoot: z.string().refine(path.isAbsolute),
  validations: z.object({
    focused: CommandSchema,
    full: CommandSchema,
    focusedTimeoutMs: ValidationTimeoutSchema.default(
      DEFAULT_FOCUSED_VALIDATION_TIMEOUT_MS,
    ),
    fullTimeoutMs: ValidationTimeoutSchema.default(
      DEFAULT_FULL_VALIDATION_TIMEOUT_MS,
    ),
  }),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
