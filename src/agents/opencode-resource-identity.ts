import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface OpenCodeResourceIdentity {
  readonly capsuleId: string;
  readonly resourceLabel: string;
  readonly containerName: string;
  readonly imageName: string;
  readonly repositoryViewPath: string;
}

export function openCodeResourceIdentity(
  milestoneId: string,
  taskId: string,
  attempt: number,
): OpenCodeResourceIdentity {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 1_000) throw new Error("invalid OpenCode capsule attempt");
  const digest = createHash("sha256").update(milestoneId).update("\0").update(taskId).update("\0").update(String(attempt)).digest("hex");
  const capsuleId = `opencode-${digest.slice(0, 32)}`;
  const viewRoot = controlledViewRootPath();
  return Object.freeze({
    capsuleId,
    resourceLabel: `org.zentra.capsule-id=${capsuleId}`,
    containerName: `zentra-opencode-readonly-${digest.slice(0, 32)}`,
    imageName: `zentra-opencode-readonly:${digest.slice(0, 32)}`,
    repositoryViewPath: path.join(viewRoot, digest),
  });
}

export function controlledViewRoot(): string {
  const root = controlledViewRootPath();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonical = realpathSync.native(root);
  if (canonical !== root || !statSync(canonical).isDirectory()) throw new Error("controlled repository-view root is unavailable");
  return canonical;
}

export function controlledViewRootPath(): string {
  return path.join(realpathSync.native(tmpdir()), "zentra-read-only-views");
}
