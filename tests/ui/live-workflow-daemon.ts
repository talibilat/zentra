import { createHash } from "node:crypto";
import { rmSync } from "node:fs";

import type { AgentTrailEvidence } from "../../src/agenttrail/agenttrail-events.js";
import type { AgentTrailReady, AgentTrailStartRequest } from "../../src/agenttrail/agenttrail-supervisor.js";
import { LoopbackGateway } from "../../src/gateway/loopback-gateway.js";
import {
  startZentraService,
  type AgentTrailService,
  type RunningZentraService,
} from "../../src/service/start-service.js";
import type { WorkflowSurface } from "../../src/surfaces/workflow-surface.js";

export interface LiveWorkflowDaemon {
  readonly service: RunningZentraService;
  readonly gateway: LoopbackGateway;
}

export async function startLiveWorkflowDaemon(root: string, surface: WorkflowSurface): Promise<LiveWorkflowDaemon> {
  let gateway: LoopbackGateway | undefined;
  const agentTrail = new FixtureAgentTrail();
  const service = await startZentraService({ cwd: root }, {
    createGateway: (options) => {
      gateway = new LoopbackGateway(options);
      return gateway;
    },
    createAgentTrail: (evidence) => agentTrail.attach(evidence),
    createWorkflowSurface: () => surface,
  });
  if (gateway === undefined) throw new Error("acceptance daemon did not construct its gateway");
  return { service, gateway };
}

export function resetDaemonJournalForInProcessRestart(daemon: LiveWorkflowDaemon): void {
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(`${daemon.service.layout.databasePath}${suffix}`, { force: true });
  }
}

class FixtureAgentTrail implements AgentTrailService {
  private evidence: ((event: AgentTrailEvidence) => void | Promise<void>) | null = null;
  private readonly incarnation = "agenttrail-v1:94949494-9494-4949-8949-949494949494";

  attach(evidence: (event: AgentTrailEvidence) => void | Promise<void>): this {
    this.evidence = evidence;
    return this;
  }

  async start(request: AgentTrailStartRequest): Promise<AgentTrailReady> {
    const base = {
      schemaVersion: 1 as const,
      executableSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      incarnation: this.incarnation,
      occurredAt: new Date().toISOString(),
    };
    await this.evidence!({
      type: "agenttrail.starting",
      ...base,
      pid: null,
      startupDeadlineMs: request.startupTimeoutMs,
      tracePathSha256: createHash("sha256").update(request.tracePath).digest("hex"),
    });
    await this.evidence!({
      type: "agenttrail.ready",
      ...base,
      pid: 9494,
      address: { host: "127.0.0.1", port: 49_494 },
      startupMs: 1,
    });
    return {
      pid: 9494,
      incarnation: this.incarnation,
      executableSha256: "a".repeat(64),
      address: { host: "127.0.0.1", port: 49_494 },
    };
  }

  async shutdown(): Promise<void> {}
}
