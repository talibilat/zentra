import type { AttentionService } from "./attention-service.js";

export type ScopeDependencies = Readonly<Record<string, readonly string[]>>;

export type AttentionDispatchResult<T> =
  | { readonly status: "completed"; readonly value: T; readonly attentionRevision: number }
  | { readonly status: "paused"; readonly blockingAttentionIds: readonly string[] };

export class AttentionControlledDispatcher {
  constructor(private readonly attention: AttentionService) {}

  async dispatch<T>(input: {
    readonly runId: string;
    readonly admissionId: string;
    readonly scopeId: string;
    readonly dependencies?: ScopeDependencies;
    readonly commandId: string;
    readonly evidenceSha256: string;
    readonly work: () => Promise<T> | T;
  }): Promise<AttentionDispatchResult<T>> {
    const admission = this.attention.admitScope({
      runId: input.runId,
      admissionId: input.admissionId,
      scopeId: input.scopeId,
      dependencies: transitiveDependencies(input.scopeId, input.dependencies ?? {}),
      commandId: input.commandId,
      evidenceSha256: input.evidenceSha256,
    });
    if (admission.status === "paused") return admission;
    return {
      status: "completed",
      value: await input.work(),
      attentionRevision: admission.revision,
    };
  }
}

function transitiveDependencies(scopeId: string, dependencies: ScopeDependencies): readonly string[] {
  const pending = [...(dependencies[scopeId] ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    pending.push(...(dependencies[candidate] ?? []));
  }
  return Object.freeze([...visited].sort());
}
