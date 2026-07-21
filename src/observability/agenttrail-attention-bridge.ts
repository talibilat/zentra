import { createHash } from "node:crypto";
import { z } from "zod";

import type { AttentionService } from "../attention/attention-service.js";
import type { AttentionView } from "../attention/attention-projection.js";
import { digestCanonical } from "../contracts/authority-attention.js";

const Id = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const WarningSchema = z.strictObject({
  runId: Id,
  code: Id,
  summary: z.string().min(1).max(4_096),
  actorId: Id,
  eventIds: z.array(Id).min(1).max(256).superRefine((values, context) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "warning evidence identities must be unique" });
  }),
  affectedScopes: z.array(Id).max(256),
  dependentScopes: z.array(Id).max(256),
});

export type AgentTrailWarningObservation = z.input<typeof WarningSchema>;

export class AgentTrailAttentionBridge {
  constructor(private readonly attention: AttentionService) {}

  publish(input: AgentTrailWarningObservation): AttentionView {
    const warning = WarningSchema.parse(input);
    const evidence = Object.freeze({ schemaVersion: 1, source: "agenttrail", runId: warning.runId,
      code: warning.code, actorId: warning.actorId, eventIds: Object.freeze([...warning.eventIds].sort()) });
    const evidenceSha256 = digestCanonical(evidence);
    const suffix = createHash("sha256").update(digestCanonical({ ...evidence, summary: warning.summary }), "utf8")
      .digest("hex").slice(0, 32);
    const attentionId = `agenttrail-warning-${suffix}`;
    const existing = this.attention.getAdvisory(attentionId);
    if (existing !== null) return existing;
    return this.attention.raiseAgentTrailWarning({
      attentionId,
      runId: warning.runId,
      warningCode: warning.code,
      message: warning.summary,
      evidenceSha256,
      affectedScopes: warning.affectedScopes,
      dependentScopes: warning.dependentScopes,
      commandId: `agenttrail-advisory-${suffix}`,
    });
  }
}
