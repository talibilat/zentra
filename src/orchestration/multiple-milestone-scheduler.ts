import type { MilestoneRecord } from "../milestones/milestone-registry.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import type {
  MultiAgentMilestoneCoordinator,
  MultiAgentMilestoneRequest,
} from "./multi-agent-milestone.js";
import type { WriterResourceGovernor } from "./writer-resource-governor.js";

export interface MultipleMilestoneSchedule {
  readonly milestoneId: string;
  readonly traceId: string;
  readonly projectId: string;
  readonly coordinator: Pick<MultiAgentMilestoneCoordinator, "inspectIdentity" | "run" | "usesWriterGovernor">;
  readonly request: MultiAgentMilestoneRequest;
}

export type MultipleMilestoneResult =
  | { readonly milestoneId: string; readonly status: "fulfilled"; readonly value: MilestoneRecord }
  | { readonly milestoneId: string; readonly status: "rejected"; readonly reason: unknown };

export class MultipleMilestoneScheduler {
  constructor(private readonly governor: WriterResourceGovernor) {}

  async run(inputs: readonly MultipleMilestoneSchedule[]): Promise<readonly MultipleMilestoneResult[]> {
    validateInputs(inputs, this.governor);
    return Promise.all(inputs.map(async (input): Promise<MultipleMilestoneResult> => {
      try {
        const value = await input.coordinator.run(input.request);
        return Object.freeze({ milestoneId: input.milestoneId, status: "fulfilled", value });
      } catch (reason) {
        return Object.freeze({ milestoneId: input.milestoneId, status: "rejected", reason });
      }
    }));
  }
}

function validateInputs(inputs: readonly MultipleMilestoneSchedule[], governor: WriterResourceGovernor): void {
  const milestoneIds = new Set<string>();
  const traceIds = new Set<string>();
  const writerIds = new Set<string>();
  const capabilities = new Map<string, string>();
  for (const input of inputs) {
    unique(milestoneIds, input.milestoneId, "milestone identities");
    unique(traceIds, input.traceId, "trace identities");
    if (!input.coordinator.usesWriterGovernor(governor)) {
      throw new Error("milestone coordinator does not use the shared writer governor");
    }
    const durableIdentity = input.coordinator.inspectIdentity(input.milestoneId);
    if (durableIdentity.projectId !== input.projectId || durableIdentity.traceId !== input.traceId) {
      throw new Error("multiple-milestone mapping contradicts durable project or trace identity");
    }
    if (input.request.milestoneId !== input.milestoneId ||
      input.request.writerSchedule.milestoneId !== input.milestoneId) {
      throw new Error("nested schedule belongs to another milestone");
    }
    if (input.request.writerSchedule.maxConcurrentWriters > governor.maxConcurrentWriters) {
      throw new Error("nested writer limit exceeds shared global writer capacity");
    }
    for (const capability of input.request.writerSchedule.modelSheet?.models ?? []) {
      const canonicalId = darwinCanonical(capability.id);
      const digest = digestCanonical(capability);
      const pinned = capabilities.get(canonicalId);
      if (pinned !== undefined && pinned !== digest) {
        throw new Error(`conflicting repeated capability metadata for ${capability.id}`);
      }
      capabilities.set(canonicalId, digest);
    }
    for (const task of input.request.writerSchedule.tasks) {
      unique(writerIds, task.writerTaskId, "writer identities");
      if (task.execution?.project?.projectId !== undefined &&
        task.execution.project.projectId !== input.projectId) {
        throw new Error(`writer ${task.writerTaskId} belongs to another project`);
      }
    }
  }
}

function unique(seen: Set<string>, value: string, label: string): void {
  if (value === "") throw new Error(`${label} must be nonempty`);
  const canonical = darwinCanonical(value);
  if (seen.has(canonical)) throw new Error(`${label} must be unique under Darwin canonical identity`);
  seen.add(canonical);
}

function darwinCanonical(value: string): string {
  return value.normalize("NFD").toLocaleLowerCase("en-US");
}
