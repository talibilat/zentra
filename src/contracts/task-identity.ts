import { z } from "zod";

export const MAX_WORKTREE_TASK_ID_LENGTH = 128;

export function canonicalDarwinTaskIdentity(taskId: string): string {
  return taskId.normalize("NFD").toLowerCase();
}

export function isSafeWorktreeTaskIdentity(taskId: string): boolean {
  return taskId.length > 0 &&
    taskId.length <= MAX_WORKTREE_TASK_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId) &&
    !taskId.includes("..") &&
    !taskId.includes("@{") &&
    !taskId.endsWith(".") &&
    !taskId.toLowerCase().endsWith(".lock");
}

export function assertSafeWorktreeTaskIdentity(taskId: string): void {
  if (!isSafeWorktreeTaskIdentity(taskId)) {
    throw new Error("task identity is unsafe for a worktree path or Git ref");
  }
}

export const WorktreeTaskIdentitySchema = z.string().refine(isSafeWorktreeTaskIdentity, {
  message: "task identity must be safe for a worktree path and Git ref",
});
