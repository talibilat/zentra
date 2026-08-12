import type { WriterDispatchBinding, WriterReport } from "./harness-writer.js";

const supervisedReports = new WeakMap<object, string>();

export function brandSupervisedReport(report: WriterReport, binding: WriterDispatchBinding): void {
  supervisedReports.set(report, binding.digest);
}

export function isSupervisedWriterReport(report: WriterReport, binding: WriterDispatchBinding): boolean {
  return supervisedReports.get(report) === binding.digest && report.dispatchBinding.digest === binding.digest;
}
