import { createHash } from "node:crypto";

import type { MilestoneRole } from "../contracts/milestone.js";
import type { ModelCapability, ModelSheet } from "../policy/model-sheet.js";
import type { OutcomeHistoryRecord } from "./routing-events.js";

export type { OutcomeHistoryRecord } from "./routing-events.js";

export interface RouteApprovedModelRequest {
  readonly executionId: string;
  readonly taskId: string;
  readonly taskType: string;
  readonly role: MilestoneRole;
  readonly harness: "opencode";
  readonly requiredTools: readonly string[];
  readonly network: "denied" | "declared";
  readonly requiredContextTokens: number;
}

export interface ApprovedModelSelection {
  readonly executionId: string;
  readonly capability: ModelCapability;
  readonly sheetIndex: number;
  readonly basis: "sheet_order" | "outcome_history";
  readonly modelSheetSha256: string;
  readonly algorithmVersion: "approved-history-v1";
  readonly candidateCapabilityIds: readonly string[];
}

export function routeApprovedModel(
  sheet: ModelSheet,
  history: readonly OutcomeHistoryRecord[],
  request: RouteApprovedModelRequest,
): ApprovedModelSelection {
  if (!Number.isSafeInteger(request.requiredContextTokens) || request.requiredContextTokens <= 0) {
    throw new Error("required model context must be a positive safe integer");
  }
  const candidates = sheet.models.map((capability, sheetIndex) => ({ capability, sheetIndex }))
    .filter(({ capability }) =>
      capability.harness === request.harness &&
      capability.roles.includes(request.role) &&
      request.requiredTools.every((tool) => capability.toolPermissions.includes(tool)) &&
      capability.network === request.network &&
      capability.contextTokens >= request.requiredContextTokens);
  if (candidates.length === 0) throw new Error("model sheet has no approved routing candidate");

  const ranked = candidates.map((candidate) => {
    const records = history.filter((record) =>
      record.taskType === request.taskType &&
      record.role === request.role &&
      record.model.harness === request.harness &&
      record.model.capabilityId === candidate.capability.id &&
      record.model.transportModelSha256 === sha256(candidate.capability.model) &&
      record.selection.modelSheetSha256 === modelSheetSha256(sheet) &&
      usable(record));
    const successes = records.filter(successful).length;
    const observations = records.length;
    const posterior = (successes + 2) / (observations + 4);
    const confidence = observations / (observations + 8);
    return {
      ...candidate,
      observations,
      quality: 0.5 + confidence * (posterior - 0.5),
      medianDuration: median(records.filter(successful).map((record) => record.durationMs)),
    };
  });
  const hasHistory = ranked.some((candidate) => candidate.observations >= 3);
  if (hasHistory) {
    ranked.sort((left, right) =>
      (Math.abs(right.quality - left.quality) > 0.01 ? right.quality - left.quality : 0) ||
      right.observations - left.observations ||
      durationOrder(left, right) ||
      left.sheetIndex - right.sheetIndex);
  }
  const chosen = ranked[0]!;
  return Object.freeze({
    executionId: request.executionId,
    capability: chosen.capability,
    sheetIndex: chosen.sheetIndex,
    basis: hasHistory ? "outcome_history" : "sheet_order",
    modelSheetSha256: modelSheetSha256(sheet),
    algorithmVersion: "approved-history-v1",
    candidateCapabilityIds: Object.freeze(candidates.map(({ capability }) => capability.id)),
  });
}

export function modelSheetSha256(sheet: ModelSheet): string {
  return createHash("sha256").update(JSON.stringify(sheet.models.map((model) => ({
    id: model.id,
    harness: model.harness,
    model: model.model,
    roles: model.roles,
    specialties: model.specialties,
    costTier: model.costTier,
    contextTokens: model.contextTokens,
    maxConcurrency: model.maxConcurrency,
    toolPermissions: model.toolPermissions,
    network: model.network,
    fallbackOrder: model.fallbackOrder,
    qualityHistory: model.qualityHistory,
  }))), "utf8").digest("hex");
}

function usable(record: OutcomeHistoryRecord): boolean {
  return record.outcome !== "cancelled" &&
    (record.outcome !== "denied" || record.review.status === "denied");
}

function successful(record: OutcomeHistoryRecord): boolean {
  return record.outcome === "completed" &&
    (record.validation.status === "completed" || record.validation.status === "not_required") &&
    (record.review.status === "approved" || record.review.status === "not_required");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function median(values: readonly number[]): number | null {
  if (values.length < 3) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function durationOrder(
  left: { quality: number; medianDuration: number | null },
  right: { quality: number; medianDuration: number | null },
): number {
  if (Math.abs(left.quality - right.quality) > 0.01) return 0;
  if (left.medianDuration === null || right.medianDuration === null) return 0;
  return left.medianDuration - right.medianDuration;
}
