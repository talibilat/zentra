import { describe, expect, it } from "vitest";

import { brandSupervisedReport, isSupervisedWriterReport } from "../../src/harnesses/writer-brand.js";
import type { WriterDispatchBinding, WriterReport } from "../../src/harnesses/harness-writer.js";

function binding(digest: string): WriterDispatchBinding {
  return { digest } as WriterDispatchBinding;
}

function report(digest: string): WriterReport {
  return { dispatchBinding: { digest } } as WriterReport;
}

describe("writer brand registry", () => {
  it("recognizes a report it branded for the same binding", () => {
    const target = report("a".repeat(64));
    brandSupervisedReport(target, binding("a".repeat(64)));
    expect(isSupervisedWriterReport(target, binding("a".repeat(64)))).toBe(true);
  });

  it("rejects an unbranded report", () => {
    expect(isSupervisedWriterReport(report("b".repeat(64)), binding("b".repeat(64)))).toBe(false);
  });

  it("rejects a branded report checked against a different binding digest", () => {
    const target = report("c".repeat(64));
    brandSupervisedReport(target, binding("c".repeat(64)));
    expect(isSupervisedWriterReport(target, binding("d".repeat(64)))).toBe(false);
  });

  it("rejects a report whose own dispatchBinding digest disagrees with the binding", () => {
    const target = report("e".repeat(64));
    brandSupervisedReport(target, binding("f".repeat(64)));
    expect(isSupervisedWriterReport(target, binding("f".repeat(64)))).toBe(false);
  });
});
