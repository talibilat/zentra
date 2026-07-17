import { describe, expect, it } from "vitest";

import { assertSafeWorktreeTaskIdentity } from "../../src/contracts/task-identity.js";

describe("task-derived worktree and ref identity", () => {
  it.each(["task-29", "issue_29.a", "A1"])("accepts bounded identity %j", (taskId) => {
    expect(() => assertSafeWorktreeTaskIdentity(taskId)).not.toThrow();
  });

  it.each(["../outside", "nested/task", ".", "task..lock", "task@{1}", "ticket.lock", "é"])(
    "rejects path or ref unsafe identity %j",
    (taskId) => {
      expect(() => assertSafeWorktreeTaskIdentity(taskId)).toThrow("unsafe for a worktree path or Git ref");
    },
  );
});
