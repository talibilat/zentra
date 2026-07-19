import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BoundedTicketIntake,
  decodeTicketText,
  normalizeSourceRelativePath,
} from "../../src/intake/ticket-intake.js";
import type { RunView } from "../../src/runs/run-projection.js";
import * as packageApi from "../../src/index.js";

describe("ticket intake boundary properties", () => {
  it("exposes the bounded intake surface from the package root", () => {
    expect(packageApi.BoundedTicketIntake).toBe(BoundedTicketIntake);
    expect(packageApi.IntakeService).toBeTypeOf("function");
    expect(packageApi.IntakeArtifactStore).toBeTypeOf("function");
    expect(packageApi.SourceDiscoveredPayloadSchema.parse).toBeTypeOf("function");
    expect("prepareIntakeArtifactVerification" in packageApi).toBe(false);
    expect("consumeAndVerifyIntakeArtifacts" in packageApi).toBe(false);
    expect(packageApi.decodeTicketText).toBe(decodeTicketText);
    expect(packageApi.normalizeSourceRelativePath).toBe(normalizeSourceRelativePath);
  });

  it("accepts an inline goal only as quoted untrusted planning data", async () => {
    const bytes = Buffer.from("<script>process.exit()</script>\nimport './payload.js'", "utf8");
    const snapshot = await new BoundedTicketIntake().collect({
      run: inlineRun(bytes),
      source: { kind: "inline_goal", goal: bytes.toString("utf8") },
      limits: { maxFileBytes: 1024, maxFiles: 1, maxTotalBytes: 1024, maxDepth: 0 },
    });

    expect(snapshot.sources).toEqual([
      expect.objectContaining({
        relativePath: "$inline",
        quotedText: bytes.toString("utf8"),
        trust: "untrusted_planning_data",
        sha256: digest(bytes),
      }),
    ]);
    expect(snapshot.events[0]!.payload).not.toHaveProperty("quotedText");
    expect(snapshot.events[0]!.payload).not.toHaveProperty("content");
  });

  it("rejects a run that is not in intake or whose pinned source reference differs", async () => {
    const bytes = Buffer.from("goal", "utf8");
    const intake = new BoundedTicketIntake();
    await expect(intake.collect({
      run: { ...inlineRun(bytes), lifecycle: "analyzing" },
      source: { kind: "inline_goal", goal: "goal" },
      limits: { maxFileBytes: 10, maxFiles: 1, maxTotalBytes: 10, maxDepth: 0 },
    })).rejects.toMatchObject({ code: "run_not_in_intake" });
    await expect(intake.collect({
      run: { ...inlineRun(bytes), source: { kind: "inline_goal", referenceSha256: "f".repeat(64), declaredBytes: 4 } },
      source: { kind: "inline_goal", goal: "goal" },
      limits: { maxFileBytes: 10, maxFiles: 1, maxTotalBytes: 10, maxDepth: 0 },
    })).rejects.toMatchObject({ code: "source_reference_mismatch" });
  });

  it("retains safe inline aggregate rejection digest and examined-byte evidence", async () => {
    const bytes = Buffer.from("oversized inline", "utf8");
    let error: unknown;
    try {
      await new BoundedTicketIntake().collect({
        run: inlineRun(bytes),
        source: { kind: "inline_goal", goal: bytes.toString("utf8") },
        limits: { maxFileBytes: 100, maxFiles: 1, maxTotalBytes: 4, maxDepth: 0 },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "no_accepted_sources",
      bytesRead: bytes.length,
      rejections: [expect.objectContaining({
        reason: "aggregate_size_exceeded",
        sizeBytes: bytes.length,
        bytesRead: bytes.length,
        digest: digest(bytes),
      })],
    });
  });

  it("strictly decodes only valid UTF-8 text", () => {
    expect(decodeTicketText(Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b]))).toEqual({ ok: true, text: "ok" });
    expect(decodeTicketText(Buffer.from([0xc0, 0xaf]))).toEqual({ ok: false, reason: "invalid_encoding" });
    expect(decodeTicketText(Buffer.from([0xed, 0xa0, 0x80]))).toEqual({ ok: false, reason: "invalid_encoding" });
    expect(decodeTicketText(Buffer.from([0x61, 0x00, 0x62]))).toEqual({ ok: false, reason: "binary" });
    expect(decodeTicketText(Buffer.from([0x61, 0x01, 0x62]))).toEqual({ ok: false, reason: "binary" });
    expect(decodeTicketText(Buffer.from([0xc2, 0x80]))).toEqual({ ok: false, reason: "binary" });
    expect(decodeTicketText(Buffer.from("a\tb\r\nc", "utf8"))).toEqual({ ok: true, text: "a\tb\r\nc" });

    let seed = 0xdec0de;
    for (let sample = 0; sample < 2_000; sample += 1) {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      const bytes = Buffer.alloc(seed % 32);
      for (let index = 0; index < bytes.length; index += 1) {
        seed = (seed * 1_103_515_245 + 12_345) >>> 0;
        bytes[index] = seed & 0xff;
      }
      const result = decodeTicketText(bytes);
      expect([true, false]).toContain(result.ok);
      if (result.ok) expect(result.text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
      else expect(["binary", "invalid_encoding"]).toContain(result.reason);
    }
  });

  it("normalizes only bounded portable source-relative paths across generated boundary cases", () => {
    let seed = 0x90;
    for (let index = 0; index < 2_000; index += 1) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      const pieces = Array.from({ length: 1 + (seed % 5) }, (_, piece) => {
        const value = (seed >>> (piece * 3)) & 7;
        return ["name", ".", "..", "", "nested", "a\\b", "nul\0x", "é"][value]!;
      });
      const candidate = pieces.join(seed % 2 === 0 ? "/" : "\\");
      const normalized = normalizeSourceRelativePath(candidate);
      if (normalized !== null) {
        expect(normalized).not.toMatch(/(?:^|\/)\.\.(?:\/|$)/);
        expect(normalized).not.toContain("\\");
        expect(normalized).not.toContain("\0");
        expect(Buffer.byteLength(normalized, "utf8")).toBeLessThanOrEqual(1024);
      }
    }
    expect(normalizeSourceRelativePath("../escape")).toBeNull();
    expect(normalizeSourceRelativePath("/absolute")).toBeNull();
    expect(normalizeSourceRelativePath("a\\..\\escape")).toBeNull();
    expect(normalizeSourceRelativePath("a\\b")).toBeNull();
  });
});

function inlineRun(bytes: Buffer): RunView {
  return {
    schemaVersion: 1,
    runVersion: 1,
    runId: "run-inline",
    projectId: "zentra",
    projectRevision: { objectFormat: "sha1", commit: "a".repeat(40) },
    source: { kind: "inline_goal", referenceSha256: digest(bytes), declaredBytes: bytes.length },
    actor: { actorId: "operator-1", kind: "operator" },
    acceptedBy: { pid: 90, processIncarnation: `process-v2:${"b".repeat(64)}` },
    activeProcess: { pid: 90, processIncarnation: `process-v2:${"b".repeat(64)}` },
    budget: {
      maxDurationMs: 60_000,
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxCostUsdNano: 0,
      maxRetries: 0,
      maxSourceFiles: 1,
      maxSourceBytes: 1024,
    },
    lifecycle: "intake",
    terminalOutcome: null,
    streamVersion: 3,
    authority: {
      approvalState: "not_proposed",
      planDigest: null,
      envelopeDigest: null,
      approvalDecisionId: null,
      executionAuthority: "none",
    },
    suspendedFrom: null,
    suspensionEventId: null,
    cancellation: null,
  };
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
