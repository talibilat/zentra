import { describe, expect, it } from "vitest";

import {
  LocalReleaseCoordinator,
  MilestonePlanSchema,
  MilestoneRegistry,
  OpenCodeReadOnlyProgram,
  OpenCodeReviewerAdapter,
  OpenCodeTaskAdmissionContextSchema,
  PlanReplacementPayloadSchema,
  JournalOutcomeHistoryStore,
  routeApprovedModel,
  RoutedOpenCodeExecution,
  SqliteEventJournal,
} from "../../src/index.js";
import * as packageApi from "../../src/index.js";

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
    expect(JournalOutcomeHistoryStore).toBeTypeOf("function");
    expect(routeApprovedModel).toBeTypeOf("function");
    expect(RoutedOpenCodeExecution).toBeTypeOf("function");
    expect(SqliteEventJournal).toBeTypeOf("function");
    expect(LocalReleaseCoordinator).toBeTypeOf("function");
    expect("InstalledMilestoneRunner" in packageApi).toBe(false);
    expect("OpenRouterModelBroker" in packageApi).toBe(false);
    expect("runCli" in packageApi).toBe(false);
    expect("ProviderConfigSchema" in packageApi).toBe(false);
    expect("OPENROUTER_ENDPOINT" in packageApi).toBe(false);
    expect("loadProviderConfig" in packageApi).toBe(false);
    expect("LocalReleaseRunner" in packageApi).toBe(false);
    expect("createLocalReleasePacket" in packageApi).toBe(false);
    expect("ReleasePacketSchema" in packageApi).toBe(false);
  });
});
