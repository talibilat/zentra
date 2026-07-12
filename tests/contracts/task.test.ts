import { describe, expect, it } from "vitest";
import { TaskSchema } from "../../src/contracts/task.js";

describe("TaskSchema", () => {
  it("accepts canonical lifecycle and terminal values", () => {
    const task = TaskSchema.parse({
      taskId: "task-1",
      projectId: "project-1",
      title: "Update greeting",
      lifecycle: "queued",
      terminalOutcome: null,
      budget: { maxSeconds: 60, maxRetries: 0 },
    });

    expect(task.lifecycle).toBe("queued");
  });

  it("accepts a terminal lifecycle paired with a canonical outcome", () => {
    const task = TaskSchema.parse({
      taskId: "task-1",
      projectId: "project-1",
      title: "Update greeting",
      lifecycle: "terminal",
      terminalOutcome: "completed",
      budget: { maxSeconds: 60, maxRetries: 0 },
    });

    expect(task.terminalOutcome).toBe("completed");
  });

  it("rejects a terminal lifecycle without an outcome", () => {
    const result = TaskSchema.safeParse({
      taskId: "task-1",
      projectId: "project-1",
      title: "Update greeting",
      lifecycle: "terminal",
      terminalOutcome: null,
      budget: { maxSeconds: 60, maxRetries: 0 },
    });

    expect(result.success).toBe(false);
  });

  it("rejects an outcome on a non-terminal lifecycle", () => {
    const result = TaskSchema.safeParse({
      taskId: "task-1",
      projectId: "project-1",
      title: "Update greeting",
      lifecycle: "queued",
      terminalOutcome: "completed",
      budget: { maxSeconds: 60, maxRetries: 0 },
    });

    expect(result.success).toBe(false);
  });

  it("rejects approval_required as a terminal outcome", () => {
    expect(() =>
      TaskSchema.parse({
        taskId: "task-1",
        projectId: "project-1",
        title: "Update greeting",
        lifecycle: "terminal",
        terminalOutcome: "approval_required",
        budget: { maxSeconds: 60, maxRetries: 0 },
      }),
    ).toThrow();
  });
});
