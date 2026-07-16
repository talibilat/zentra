import { describe, expect, it } from "vitest";

import {
  MilestonePlanSchema,
  MilestoneRegistry,
  OpenCodeReadOnlyProgram,
  SqliteEventJournal,
} from "../../src/index.js";

describe("package-root programmatic API", () => {
  it("exports milestone preparation and OpenCode composition contracts", () => {
    expect(MilestoneRegistry).toBeTypeOf("function");
    expect(MilestoneRegistry.prototype.ready).toBeTypeOf("function");
    expect(MilestonePlanSchema.parse).toBeTypeOf("function");
    expect(OpenCodeReadOnlyProgram).toBeTypeOf("function");
    expect(SqliteEventJournal).toBeTypeOf("function");
  });
});
