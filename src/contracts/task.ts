import { z } from "zod";

export const TaskLifecycleStateSchema = z.enum([
  "queued",
  "leased",
  "running",
  "validating",
  "awaiting_review",
  "integration_ready",
  "integrating",
  "terminal",
]);

export const TerminalOutcomeSchema = z.enum([
  "completed",
  "cancelled",
  "denied",
  "timed_out",
  "failed",
]);

export const TaskSchema = z
  .object({
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().min(1),
    lifecycle: TaskLifecycleStateSchema,
    terminalOutcome: TerminalOutcomeSchema.nullable(),
    budget: z.object({
      maxSeconds: z.number().int().positive(),
      maxRetries: z.number().int().nonnegative(),
    }),
  })
  .superRefine((task, context) => {
    if ((task.lifecycle === "terminal") !== (task.terminalOutcome !== null)) {
      context.addIssue({
        code: "custom",
        message: "terminal lifecycle and terminalOutcome must be set together",
      });
    }
  });

export type Task = z.infer<typeof TaskSchema>;
export type TaskLifecycleState = z.infer<typeof TaskLifecycleStateSchema>;
export type TerminalOutcome = z.infer<typeof TerminalOutcomeSchema>;
