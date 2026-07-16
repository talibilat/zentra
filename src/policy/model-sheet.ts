import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const MAX_MODEL_SHEET_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 4096;

const REQUIRED_COLUMNS = [
  "id",
  "harness",
  "model",
  "roles",
  "specialties",
  "cost",
  "context",
  "concurrency",
  "tools",
  "network",
  "fallback",
  "quality",
] as const;

const HARNESSES = new Set(["opencode", "claude_code", "codex"]);
const ROLES = new Set([
  "planner",
  "researcher",
  "implementer",
  "validator",
  "reviewer",
  "integrator",
  "verifier",
]);
const COST_TIERS = new Set(["low", "medium", "high", "premium"]);
const TOOL_PERMISSIONS = new Set([
  "read_repository",
  "write_worktree",
  "run_validation",
  "review_diff",
  "integrate",
  "web_research",
]);
const NETWORK_PERMISSIONS = new Set(["denied", "declared"]);
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_-]*$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;

export type ModelSheetErrorCode =
  | "MODEL_SHEET_TOO_LARGE"
  | "MODEL_SHEET_READ_FAILED"
  | "MODEL_SHEET_MISSING_SECTION"
  | "MODEL_SHEET_UNKNOWN_SECTION"
  | "MODEL_SHEET_DUPLICATE_SECTION"
  | "MODEL_SHEET_INVALID_TABLE"
  | "MODEL_SHEET_DUPLICATE_MODEL"
  | "MODEL_SHEET_INVALID_HARNESS"
  | "MODEL_SHEET_INVALID_ROLE"
  | "MODEL_SHEET_INVALID_SPECIALTY"
  | "MODEL_SHEET_INVALID_COST_TIER"
  | "MODEL_SHEET_INVALID_CONTEXT_LIMIT"
  | "MODEL_SHEET_INVALID_CONCURRENCY_LIMIT"
  | "MODEL_SHEET_INVALID_TOOL_PERMISSION"
  | "MODEL_SHEET_INVALID_NETWORK_PERMISSION"
  | "MODEL_SHEET_INVALID_FALLBACK"
  | "MODEL_SHEET_INVALID_QUALITY_HISTORY";

export class ModelSheetError extends Error {
  constructor(readonly code: ModelSheetErrorCode) {
    super(publicModelSheetErrorMessage(code));
    this.name = "ModelSheetError";
  }
}

export interface QualityHistory {
  readonly successes: number;
  readonly attempts: number;
}

export interface ModelCapability {
  readonly id: string;
  readonly harness: string;
  readonly model: string;
  readonly roles: readonly string[];
  readonly specialties: readonly string[];
  readonly costTier: string;
  readonly contextTokens: number;
  readonly maxConcurrency: number;
  readonly toolPermissions: readonly string[];
  readonly network: string;
  readonly fallbackOrder: readonly string[];
  readonly qualityHistory: QualityHistory;
}

export interface ModelSheet {
  readonly models: readonly ModelCapability[];
}

export interface PublicModelSheetSummary {
  readonly modelCount: number;
  readonly harnesses: readonly string[];
  readonly roles: readonly string[];
  readonly costTiers: readonly string[];
  readonly maxConcurrency: number;
}

export function loadModelSheet(sheetPath: string): ModelSheet {
  let file: number | null = null;
  try {
    file = openSync(sheetPath, "r");
    const stat = fstatSync(file);
    if (!stat.isFile()) throw new ModelSheetError("MODEL_SHEET_READ_FAILED");
    if (stat.size > MAX_MODEL_SHEET_BYTES) throw new ModelSheetError("MODEL_SHEET_TOO_LARGE");
    const buffer = Buffer.alloc(MAX_MODEL_SHEET_BYTES + 1);
    const bytesRead = readSync(file, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_MODEL_SHEET_BYTES) throw new ModelSheetError("MODEL_SHEET_TOO_LARGE");
    return parseModelSheetMarkdown(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch (error) {
    if (error instanceof ModelSheetError) throw error;
    throw new ModelSheetError("MODEL_SHEET_READ_FAILED");
  } finally {
    if (file !== null) closeSync(file);
  }
}

export function parseModelSheetMarkdown(markdown: string): ModelSheet {
  if (Buffer.byteLength(markdown, "utf8") > MAX_MODEL_SHEET_BYTES) {
    throw new ModelSheetError("MODEL_SHEET_TOO_LARGE");
  }
  const sections = parseSections(markdown);
  const modelLines = sections.get("Models");
  if (modelLines === undefined) throw new ModelSheetError("MODEL_SHEET_MISSING_SECTION");
  const models = parseModelsTable(modelLines);
  validateFallbacks(models);
  return Object.freeze({ models });
}

export function publicModelSheetSummary(sheet: ModelSheet): PublicModelSheetSummary {
  return Object.freeze({
    modelCount: sheet.models.length,
    harnesses: Object.freeze(sortedUnique(sheet.models.map((model) => model.harness))),
    roles: Object.freeze(sortedUnique(sheet.models.flatMap((model) => model.roles))),
    costTiers: Object.freeze(sortedUnique(sheet.models.map((model) => model.costTier))),
    maxConcurrency: sheet.models.reduce((total, model) => total + model.maxConcurrency, 0),
  });
}

function parseSections(markdown: string): Map<string, readonly string[]> {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const name = heading[1]!;
      if (name !== "Models") throw new ModelSheetError("MODEL_SHEET_UNKNOWN_SECTION");
      if (sections.has(name)) throw new ModelSheetError("MODEL_SHEET_DUPLICATE_SECTION");
      sections.set(name, []);
      current = name;
      continue;
    }
    if (current === null || line.trim() === "" || line.startsWith("# ")) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_TEXT_BYTES) {
      throw new ModelSheetError("MODEL_SHEET_INVALID_TABLE");
    }
    sections.get(current)!.push(line.trim());
  }
  return sections;
}

function parseModelsTable(lines: readonly string[]): readonly ModelCapability[] {
  if (lines.length < 3) throw new ModelSheetError("MODEL_SHEET_INVALID_TABLE");
  const header = splitRow(lines[0]!);
  if (JSON.stringify(header) !== JSON.stringify(REQUIRED_COLUMNS)) {
    throw new ModelSheetError("MODEL_SHEET_INVALID_TABLE");
  }
  const separator = splitRow(lines[1]!);
  if (
    separator.length !== REQUIRED_COLUMNS.length ||
    !separator.every((cell) => /^:?-{3,}:?$/.test(cell))
  ) {
    throw new ModelSheetError("MODEL_SHEET_INVALID_TABLE");
  }
  const models: ModelCapability[] = [];
  const ids = new Set<string>();
  for (const row of lines.slice(2)) {
    const cells = splitRow(row);
    if (cells.length !== REQUIRED_COLUMNS.length) throw new ModelSheetError("MODEL_SHEET_INVALID_TABLE");
    const model = parseModelRow(cells);
    if (ids.has(model.id)) throw new ModelSheetError("MODEL_SHEET_DUPLICATE_MODEL");
    ids.add(model.id);
    models.push(model);
  }
  return Object.freeze(models);
}

function splitRow(row: string): string[] {
  const trimmed = row.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    throw new ModelSheetError("MODEL_SHEET_INVALID_TABLE");
  }
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function parseModelRow(cells: readonly string[]): ModelCapability {
  const [
    id,
    harness,
    model,
    roles,
    specialties,
    costTier,
    contextTokens,
    maxConcurrency,
    toolPermissions,
    network,
    fallbackOrder,
    qualityHistory,
  ] = cells;
  if (id === undefined || !SAFE_ID.test(id) || id === "none") {
    throw new ModelSheetError("MODEL_SHEET_INVALID_TABLE");
  }
  if (harness === undefined || !HARNESSES.has(harness)) throw new ModelSheetError("MODEL_SHEET_INVALID_HARNESS");
  if (model === undefined || model === "") throw new ModelSheetError("MODEL_SHEET_INVALID_TABLE");
  if (costTier === undefined || !COST_TIERS.has(costTier)) throw new ModelSheetError("MODEL_SHEET_INVALID_COST_TIER");
  if (network === undefined || !NETWORK_PERMISSIONS.has(network)) {
    throw new ModelSheetError("MODEL_SHEET_INVALID_NETWORK_PERMISSION");
  }

  return Object.freeze({
    id,
    harness,
    model,
    roles: Object.freeze(parseTokenList(roles, ROLES, "MODEL_SHEET_INVALID_ROLE")),
    specialties: Object.freeze(parseSpecialties(specialties)),
    costTier,
    contextTokens: parsePositiveInteger(contextTokens, "MODEL_SHEET_INVALID_CONTEXT_LIMIT"),
    maxConcurrency: parsePositiveInteger(maxConcurrency, "MODEL_SHEET_INVALID_CONCURRENCY_LIMIT"),
    toolPermissions: Object.freeze(parseTokenList(
      toolPermissions,
      TOOL_PERMISSIONS,
      "MODEL_SHEET_INVALID_TOOL_PERMISSION",
    )),
    network,
    fallbackOrder: Object.freeze(parseFallbackOrder(fallbackOrder)),
    qualityHistory: Object.freeze(parseQualityHistory(qualityHistory)),
  });
}

function parseTokenList(
  value: string | undefined,
  allowed: ReadonlySet<string>,
  code: ModelSheetErrorCode,
): string[] {
  if (value === undefined) throw new ModelSheetError(code);
  const tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.length !== value.split(",").length) {
    throw new ModelSheetError(code);
  }
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!allowed.has(token)) throw new ModelSheetError(code);
    if (seen.has(token)) throw new ModelSheetError(code);
    seen.add(token);
  }
  return tokens;
}

function parseSpecialties(value: string | undefined): string[] {
  if (value === undefined) throw new ModelSheetError("MODEL_SHEET_INVALID_SPECIALTY");
  const specialties = value.split(",").map((token) => token.trim()).filter(Boolean);
  if (specialties.length !== value.split(",").length) {
    throw new ModelSheetError("MODEL_SHEET_INVALID_SPECIALTY");
  }
  const seen = new Set<string>();
  for (const specialty of specialties) {
    if (!SAFE_TOKEN.test(specialty)) throw new ModelSheetError("MODEL_SHEET_INVALID_SPECIALTY");
    if (seen.has(specialty)) throw new ModelSheetError("MODEL_SHEET_INVALID_SPECIALTY");
    seen.add(specialty);
  }
  return specialties;
}

function parsePositiveInteger(value: string | undefined, code: ModelSheetErrorCode): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) throw new ModelSheetError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ModelSheetError(code);
  return parsed;
}

function parseFallbackOrder(value: string | undefined): string[] {
  if (value === undefined || value === "") throw new ModelSheetError("MODEL_SHEET_INVALID_FALLBACK");
  if (value === "none") return [];
  const fallbacks = value.split(",").map((token) => token.trim()).filter(Boolean);
  if (
    fallbacks.length !== value.split(",").length ||
    fallbacks.some((fallback) => !SAFE_ID.test(fallback)) ||
    new Set(fallbacks).size !== fallbacks.length
  ) {
    throw new ModelSheetError("MODEL_SHEET_INVALID_FALLBACK");
  }
  return fallbacks;
}

function parseQualityHistory(value: string | undefined): QualityHistory {
  const match = /^(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/.exec(value ?? "");
  if (match === null) throw new ModelSheetError("MODEL_SHEET_INVALID_QUALITY_HISTORY");
  const successes = Number(match[1]);
  const attempts = Number(match[2]);
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(attempts) ||
    attempts <= 0 ||
    successes > attempts
  ) {
    throw new ModelSheetError("MODEL_SHEET_INVALID_QUALITY_HISTORY");
  }
  return { successes, attempts };
}

function validateFallbacks(models: readonly ModelCapability[]): void {
  const byId = new Map(models.map((model) => [model.id, model] as const));
  for (const model of models) {
    for (const fallback of model.fallbackOrder) {
      const fallbackModel = byId.get(fallback);
      if (fallbackModel === undefined || fallback === model.id) {
        throw new ModelSheetError("MODEL_SHEET_INVALID_FALLBACK");
      }
      const fallbackRoles = new Set(fallbackModel.roles);
      if (model.roles.some((role) => !fallbackRoles.has(role))) {
        throw new ModelSheetError("MODEL_SHEET_INVALID_FALLBACK");
      }
    }
  }
  assertNoFallbackCycles(models, byId);
}

function assertNoFallbackCycles(
  models: readonly ModelCapability[],
  byId: ReadonlyMap<string, ModelCapability>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (model: ModelCapability): void => {
    if (visited.has(model.id)) return;
    if (visiting.has(model.id)) throw new ModelSheetError("MODEL_SHEET_INVALID_FALLBACK");
    visiting.add(model.id);
    for (const fallback of model.fallbackOrder) {
      visit(byId.get(fallback)!);
    }
    visiting.delete(model.id);
    visited.add(model.id);
  };
  for (const model of models) visit(model);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function publicModelSheetErrorMessage(code: ModelSheetErrorCode): string {
  const messages: Record<ModelSheetErrorCode, string> = {
    MODEL_SHEET_TOO_LARGE: "Model sheet is too large.",
    MODEL_SHEET_READ_FAILED: "Model sheet could not be read.",
    MODEL_SHEET_MISSING_SECTION: "Model sheet is missing a required section.",
    MODEL_SHEET_UNKNOWN_SECTION: "Model sheet contains an unknown section.",
    MODEL_SHEET_DUPLICATE_SECTION: "Model sheet contains a duplicate section.",
    MODEL_SHEET_INVALID_TABLE: "Model sheet table is invalid.",
    MODEL_SHEET_DUPLICATE_MODEL: "Model sheet contains a duplicate model identity.",
    MODEL_SHEET_INVALID_HARNESS: "Model sheet contains an invalid harness.",
    MODEL_SHEET_INVALID_ROLE: "Model sheet contains an invalid role.",
    MODEL_SHEET_INVALID_SPECIALTY: "Model sheet contains an invalid specialty.",
    MODEL_SHEET_INVALID_COST_TIER: "Model sheet contains an invalid cost tier.",
    MODEL_SHEET_INVALID_CONTEXT_LIMIT: "Model sheet contains an invalid context limit.",
    MODEL_SHEET_INVALID_CONCURRENCY_LIMIT: "Model sheet contains an invalid concurrency limit.",
    MODEL_SHEET_INVALID_TOOL_PERMISSION: "Model sheet contains an invalid tool permission.",
    MODEL_SHEET_INVALID_NETWORK_PERMISSION: "Model sheet contains an invalid network permission.",
    MODEL_SHEET_INVALID_FALLBACK: "Model sheet contains an invalid fallback.",
    MODEL_SHEET_INVALID_QUALITY_HISTORY: "Model sheet contains invalid quality history.",
  };
  return messages[code];
}
