const MAX_PENDING_BROWSER_SUBMISSIONS = 32;

export function isProvenPreEffectBrowserSubmissionError(code: unknown): boolean {
  return code === "invalid_transition" || code === "digest_mismatch";
}

export class BrowserPendingSubmissionCommands {
  private readonly pending = new Map<string, string>();

  constructor(private readonly createId: () => string) {}

  reserve(submission: Readonly<Record<string, unknown>>, actor: Readonly<Record<string, string>>): {
    readonly key: string;
    readonly commandId: string;
  } {
    const source = submission["kind"] === "inline_goal"
      ? { kind: "inline_goal", goal: String(submission["goal"] ?? "") }
      : { kind: "ticket_directory", directoryPath: String(submission["directoryPath"] ?? "") };
    const key = JSON.stringify({ schemaVersion: 1, source, actor: { actorId: actor["actorId"], channel: actor["channel"] } });
    if (key.length > 24 * 1024) throw new Error("pending_submission_key_too_large");
    const existing = this.pending.get(key);
    if (existing !== undefined) return { key, commandId: existing };
    if (this.pending.size >= MAX_PENDING_BROWSER_SUBMISSIONS) throw new Error("pending_submission_limit");
    const commandId = this.createId();
    this.pending.set(key, commandId);
    return { key, commandId };
  }

  acknowledge(command: { readonly key: string; readonly commandId: string }): void {
    if (this.pending.get(command.key) === command.commandId) this.pending.delete(command.key);
  }

  get size(): number { return this.pending.size; }
}
