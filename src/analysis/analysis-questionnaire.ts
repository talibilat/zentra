import { createHash } from "node:crypto";

import type { AnalysisUncertainty } from "./analysis-contracts.js";

export interface CombinedQuestionnaireOption {
  readonly optionId: string;
  readonly label: string;
  readonly impacts: readonly string[];
  readonly selections: readonly { readonly uncertaintyId: string; readonly optionId: string }[];
}

export function canonicalUncertainties(input: readonly AnalysisUncertainty[]): readonly AnalysisUncertainty[] {
  rejectDuplicates(input.map((item) => item.uncertaintyId), "uncertainty");
  rejectDuplicates(input.flatMap((item) => item.options.map((option) => option.optionId)), "option");
  return Object.freeze([...input].map((item) => ({
    ...item,
    options: [...item.options].sort((left, right) => left.optionId.localeCompare(right.optionId)),
  })).sort((left, right) => left.uncertaintyId.localeCompare(right.uncertaintyId)));
}

export function questionnaireBoundReason(
  uncertainties: readonly AnalysisUncertainty[],
  limits: { readonly maxQuestions: number; readonly maxOptionsPerQuestion: number; readonly maxCombinedOptions: number },
): "questions" | "options" | null {
  if (uncertainties.length > limits.maxQuestions) return "questions";
  let product = 1;
  for (const uncertainty of uncertainties) {
    const count = uncertainty.options.length;
    if (count > limits.maxOptionsPerQuestion || count === 0) return "options";
    if (product > Math.floor(limits.maxCombinedOptions / count)) return "options";
    product *= count;
  }
  return null;
}

export function combinedQuestionnaireOptions(
  uncertaintiesInput: readonly AnalysisUncertainty[],
  maxCombinedOptions: number,
): readonly CombinedQuestionnaireOption[] {
  const uncertainties = canonicalUncertainties(uncertaintiesInput);
  if (questionnaireBoundReason(uncertainties, {
    maxQuestions: uncertainties.length,
    maxOptionsPerQuestion: 16,
    maxCombinedOptions,
  }) !== null) throw new Error("questionnaire combination bound exceeded before allocation");
  let combinations: Array<{ labels: string[]; impacts: string[]; selections: Array<{ uncertaintyId: string; optionId: string }> }> = [
    { labels: [], impacts: [], selections: [] },
  ];
  for (const uncertainty of uncertainties) {
    combinations = combinations.flatMap((combination) => uncertainty.options.map((option) => ({
      labels: [...combination.labels, `${uncertainty.uncertaintyId}: ${option.label}`],
      impacts: [...combination.impacts, ...option.impacts],
      selections: [...combination.selections, { uncertaintyId: uncertainty.uncertaintyId, optionId: option.optionId }],
    })));
  }
  return Object.freeze(combinations.map((item) => Object.freeze({
    optionId: `choice:${digest(item.selections).slice(0, 24)}`,
    label: item.labels.join("; "), impacts: Object.freeze(item.impacts), selections: Object.freeze(item.selections),
  })));
}

export function questionnaireEvidenceSha256(runId: string, round: number, uncertainties: readonly AnalysisUncertainty[]): string {
  return digest({ runId, round, uncertainties: canonicalUncertainties(uncertainties) });
}

function rejectDuplicates(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} identities must be unique before questionnaire allocation`);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
