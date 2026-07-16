import { describe, expect, it } from "vitest";

import {
  MilestonePlanSchema,
  MilestoneRegistry,
  OpenCodeReadOnlyProgram,
  OpenCodeReviewerAdapter,
  OpenCodeTaskAdmissionContextSchema,
  PlanReplacementPayloadSchema,
  SqliteEventJournal,
} from "../../src/index.js";

describe("package-root programmatic API", () => {
  it("exports milestone preparation and OpenCode composition contracts", () => {
    expect(MilestoneRegistry).toBeTypeOf("function");
    expect(MilestoneRegistry.prototype.admitTask).toBeTypeOf("function");
    expect(MilestonePlanSchema.parse).toBeTypeOf("function");
    expect(OpenCodeReadOnlyProgram).toBeTypeOf("function");
    expect(OpenCodeReviewerAdapter).toBeTypeOf("function");
    expect(OpenCodeTaskAdmissionContextSchema.parse).toBeTypeOf("function");
    expect(PlanReplacementPayloadSchema.parse).toBeTypeOf("function");
    expect(MilestoneRegistry.prototype.replacePlan).toBeTypeOf("function");
    expect(SqliteEventJournal).toBeTypeOf("function");
  });
});
