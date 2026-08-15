export const HARNESS_IDS = ["opencode", "claude_code", "codex"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export const EXECUTABLE_HARNESSES: ReadonlySet<HarnessId> = new Set(HARNESS_IDS);

export function isHarnessId(value: string): value is HarnessId {
  return (EXECUTABLE_HARNESSES as ReadonlySet<string>).has(value);
}
