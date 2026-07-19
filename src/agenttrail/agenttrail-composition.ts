import type { EventJournal } from "../journal/journal.js";
import {
  JournalAgentTrailEvidenceSink,
  type AgentTrailJournalContext,
} from "./agenttrail-events.js";
import {
  AgentTrailSupervisor,
  type AgentTrailSupervisorOptions,
} from "./agenttrail-supervisor.js";

export interface JournaledAgentTrailOptions
  extends Omit<AgentTrailSupervisorOptions, "evidence">,
    AgentTrailJournalContext {
  readonly journal: EventJournal;
}

export interface JournaledAgentTrail {
  readonly supervisor: AgentTrailSupervisor;
  readonly evidence: JournalAgentTrailEvidenceSink;
}

export function createJournaledAgentTrailSupervisor(
  options: JournaledAgentTrailOptions,
): JournaledAgentTrail {
  const evidence = new JournalAgentTrailEvidenceSink(options.journal, options);
  return {
    evidence,
    supervisor: new AgentTrailSupervisor({
      evidence: evidence.record,
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.restartBackoffMs === undefined ? {} : { restartBackoffMs: options.restartBackoffMs }),
    }),
  };
}
