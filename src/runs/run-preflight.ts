import { createHash } from "node:crypto";

import type { AcceptRunInput, RunService } from "./run-service.js";
import type { RunView } from "./run-projection.js";
import type { ProjectRevision } from "./run-contracts.js";

export class RunPreflightCoordinator {
  constructor(
    private readonly runs: RunService,
    private readonly traceProjectionFailed: () => boolean,
    private readonly verifyProjectRevision: (revision: ProjectRevision) => boolean | Promise<boolean>,
  ) {}

  async prepareAndInvoke<T>(input: AcceptRunInput, expensiveSourceWork: (run: RunView) => T | Promise<T>): Promise<T> {
    let run = this.runs.get(input.runId);
    if (run === null) {
      run = this.runs.accept(input);
    } else {
      assertSameRunRequest(run, input);
      run = this.runs.reopenWithProcess(
        input.runId,
        run.streamVersion,
        commandId(input.commandId, `reopened:${input.process.processIncarnation}`),
        input.process,
        input.causationId ?? "",
      );
    }
    if (run.lifecycle === "accepted") {
      const acceptedEvent = this.runs.readStream(input.runId).at(-1)!;
      run = this.runs.startPreflight(input.runId, {
        expectedVersion: run.streamVersion,
        commandId: commandId(input.commandId, "preflight-started"),
        causationId: acceptedEvent.eventId,
        process: input.process,
      });
    }
    if (run.lifecycle !== "preflighting" && run.lifecycle !== "intake") {
      throw new Error(`run cannot resume preflight from ${run.lifecycle}`);
    }
    if (this.traceProjectionFailed()) this.failTracePreflight(input, run);
    let revisionMatches: boolean;
    try {
      revisionMatches = await this.verifyProjectRevision(input.projectRevision);
    } catch {
      run = this.runs.failPreflight(input.runId, {
        expectedVersion: run.streamVersion,
        commandId: commandId(input.commandId, "preflight-failed"),
        causationId: this.runs.readStream(input.runId).at(-1)!.eventId,
        process: input.process,
      }, {
        reasonCode: "project_revision_unavailable",
        diagnosticSha256: createHash("sha256").update("project revision unavailable during preflight").digest("hex"),
        disposition: "blocked",
      });
      throw new Error(`run preflight blocked at ${run.lifecycle}: project revision unavailable`);
    }
    if (!revisionMatches) {
      run = this.runs.failPreflight(input.runId, {
        expectedVersion: run.streamVersion,
        commandId: commandId(input.commandId, "preflight-failed"),
        causationId: this.runs.readStream(input.runId).at(-1)!.eventId,
        process: input.process,
      }, {
        reasonCode: "project_revision_changed",
        diagnosticSha256: createHash("sha256").update("project revision changed during preflight").digest("hex"),
        disposition: "blocked",
      });
      throw new Error(`run preflight blocked at ${run.lifecycle}: project revision changed`);
    }
    if (run.lifecycle === "preflighting") {
      const startedEvent = this.runs.readStream(input.runId).at(-1)!;
      run = this.runs.completePreflight(input.runId, {
        expectedVersion: run.streamVersion,
        commandId: commandId(input.commandId, "preflight-completed"),
        causationId: startedEvent.eventId,
        process: input.process,
      });
    }
    if (this.traceProjectionFailed()) this.failTracePreflight(input, run);
    return expensiveSourceWork(run);
  }

  private failTracePreflight(input: AcceptRunInput, run: RunView): never {
    this.runs.failPreflight(input.runId, {
      expectedVersion: run.streamVersion,
      commandId: commandId(input.commandId, "preflight-failed"),
      causationId: this.runs.readStream(input.runId).at(-1)!.eventId,
      process: input.process,
    }, {
      reasonCode: "projection_failed",
      diagnosticSha256: createHash("sha256").update("run trace projection failed").digest("hex"),
      disposition: "terminal",
    });
    throw new Error("run trace projection failed before source work");
  }
}

function commandId(parent: string, stage: string): string {
  return `preflight:${createHash("sha256").update(`${parent}\0${stage}`).digest("hex")}`;
}

function assertSameRunRequest(run: RunView, input: AcceptRunInput): void {
  for (const [name, actual, expected] of [
    ["project", run.projectId, input.projectId],
    ["revision", run.projectRevision, input.projectRevision],
    ["source", run.source, input.source],
    ["actor", run.actor, input.actor],
    ["budget", run.budget, input.budget],
  ] as const) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`reopened run ${name} input changed`);
  }
}
