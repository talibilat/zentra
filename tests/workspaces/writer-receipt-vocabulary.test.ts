import { describe, expect, it } from "vitest";

import { createWriterEventChain } from "../../src/agents/opencode-writer-events.js";
import { WriterReceiptBodySchema } from "../../src/workspaces/path-claims.js";

function receiptBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    receiptId: "11111111-1111-4111-8111-111111111111",
    claimId: "claim-1",
    ownerId: "owner-1",
    revision: "a".repeat(40),
    leaseToken: "22222222-2222-4222-8222-222222222222",
    dispatchId: "dispatch-1",
    outcome: "completed",
    dispatchBindingDigest: "b".repeat(64),
    eventChain: createWriterEventChain("", []),
    usage: {
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0,
    },
    stdoutSha256: "d".repeat(64),
    stderrSha256: "e".repeat(64),
    patchProposalDigest: null,
    startedAt: "2026-08-13T00:00:00.000Z",
    finishedAt: "2026-08-13T00:00:01.000Z",
    ...overrides,
  };
}

describe("writer receipt vocabulary", () => {
  it("accepts the neutral protocol failure value", () => {
    const parsed = WriterReceiptBodySchema.safeParse(
      receiptBody({ protocolFailure: "invalid_output_stream", usageEvidence: "native" }),
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts every neutral usage evidence value", () => {
    for (const usageEvidence of ["native", "fallback", "none"]) {
      const parsed = WriterReceiptBodySchema.safeParse(
        receiptBody({ protocolFailure: null, usageEvidence }),
      );
      expect(parsed.success, usageEvidence).toBe(true);
    }
  });

  it("still accepts pre-Phase-1.5 OpenCode literals so persisted receipts replay", () => {
    const parsed = WriterReceiptBodySchema.safeParse(
      receiptBody({ protocolFailure: "invalid_native_event_stream", usageEvidence: "native_tokens" }),
    );
    expect(parsed.success).toBe(true);
    const legacyUsage = WriterReceiptBodySchema.safeParse(
      receiptBody({ protocolFailure: null, usageEvidence: "legacy_usage" }),
    );
    expect(legacyUsage.success).toBe(true);
  });

  it("rejects a vocabulary value that belongs to neither set", () => {
    const parsed = WriterReceiptBodySchema.safeParse(
      receiptBody({ protocolFailure: "something_else", usageEvidence: "native" }),
    );
    expect(parsed.success).toBe(false);
  });
});
