import { existsSync } from "node:fs";

import { AttentionService } from "../../src/attention/attention-service.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { openAuthoritativeJournal } from "../../src/journal/retention.js";
import { RunService } from "../../src/runs/run-service.js";

const [, , databasePath, barrierPath, encoded] = process.argv;
if (!databasePath || !barrierPath || !encoded) throw new Error("missing competing attention process arguments");
const command = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
  readonly action: "answer" | "reject" | "requestQuestion" | "requestApproval" | "acceptApproval" | "raiseWarning" | "revisePlan";
  readonly now: string;
  readonly decisionId?: string;
  readonly input?: Record<string, unknown>;
  readonly wrapper?: "projecting";
};

while (!existsSync(barrierPath)) await new Promise((resolve) => setTimeout(resolve, 2));

const authoritative = openAuthoritativeJournal(databasePath, "read-write");
const journal = command.wrapper === "projecting"
  ? new ProjectingEventJournal(authoritative, { append: () => {} }, `child:${process.pid}`)
  : authoritative;
const attention = new AttentionService(journal, () => new Date(command.now));
let result: Record<string, unknown>;
try {
  let value: unknown;
  if (command.action === "answer") {
    value = attention.answer(command.decisionId!, command.input as never);
  } else if (command.action === "reject") {
    value = attention.reject(command.decisionId!, command.input as never);
  } else if (command.action === "requestApproval") {
    value = attention.requestApproval(command.input as never);
  } else if (command.action === "requestQuestion") {
    value = attention.requestQuestion(command.input as never);
  } else if (command.action === "raiseWarning") {
    value = attention.raiseAgentTrailWarning(command.input as never);
  } else if (command.action === "acceptApproval") {
    value = attention.acceptApproval(command.decisionId!, command.input as never);
  } else {
    const runs = new RunService(journal);
    const run = runs.get((command.input as { readonly runId: string }).runId)!;
    value = runs.revisePlan(run.runId, run.streamVersion, (command.input as { readonly commandId: string }).commandId);
  }
  result = { status: "accepted", value };
} catch (error) {
  result = { status: "rejected", error: error instanceof Error ? error.message : String(error) };
}
authoritative.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
