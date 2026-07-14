import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadModelSheet,
  ModelSheetError,
  parseModelSheetMarkdown,
  publicModelSheetSummary,
} from "../../src/policy/model-sheet.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const validSheet = `# Zentra Model Sheet

## Models
| id | harness | model | roles | specialties | cost | context | concurrency | tools | network | fallback | quality |
| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
| opencode-planner | opencode | anthropic/claude-sonnet-4 | planner,researcher | planning,research | medium | 200000 | 2 | read_repository,web_research | declared | opencode-general | 8/10 |
| opencode-general | opencode | openrouter/qwen3-coder | planner,researcher,implementer,reviewer | coding,review | low | 128000 | 4 | read_repository,write_worktree,review_diff | denied | none | 3/4 |
`;

describe("model sheet parser", () => {
  it("parses a Markdown model sheet into typed capability entries", () => {
    const parsed = parseModelSheetMarkdown(validSheet);

    expect(parsed.models).toHaveLength(2);
    expect(parsed.models[0]).toMatchObject({
      id: "opencode-planner",
      harness: "opencode",
      model: "anthropic/claude-sonnet-4",
      roles: ["planner", "researcher"],
      specialties: ["planning", "research"],
      costTier: "medium",
      contextTokens: 200000,
      maxConcurrency: 2,
      toolPermissions: ["read_repository", "web_research"],
      network: "declared",
      fallbackOrder: ["opencode-general"],
      qualityHistory: { successes: 8, attempts: 10 },
    });
  });

  it("loads a Markdown model sheet from disk", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-model-sheet-"));
    temporaryDirectories.push(directory);
    const sheetPath = path.join(directory, "MODEL-SHEET.md");
    writeFileSync(sheetPath, validSheet, "utf8");

    expect(loadModelSheet(sheetPath).models[1]?.id).toBe("opencode-general");
  });

  it("fails closed with stable public errors for missing or malformed required sections", () => {
    expectErrorCode(
      () => parseModelSheetMarkdown("# Zentra Model Sheet\n"),
      "MODEL_SHEET_MISSING_SECTION",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(`${validSheet}\n## Surprise\nhello\n`),
      "MODEL_SHEET_UNKNOWN_SECTION",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |", "")),
      "MODEL_SHEET_INVALID_TABLE",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |", "| --- |")),
      "MODEL_SHEET_INVALID_TABLE",
    );
  });

  it("rejects unknown role authority, harnesses, tools, and network values", () => {
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("planner,researcher", "planner,root")),
      "MODEL_SHEET_INVALID_ROLE",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("planner,researcher", "planner,")),
      "MODEL_SHEET_INVALID_ROLE",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("planner,researcher", "planner,planner")),
      "MODEL_SHEET_INVALID_ROLE",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("opencode |", "unknown |")),
      "MODEL_SHEET_INVALID_HARNESS",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("read_repository,web_research", "read_repository,shell")),
      "MODEL_SHEET_INVALID_TOOL_PERMISSION",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("declared", "open")),
      "MODEL_SHEET_INVALID_NETWORK_PERMISSION",
    );
  });

  it("rejects invalid cost, context, concurrency, quality, and fallback references", () => {
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("medium", "free")),
      "MODEL_SHEET_INVALID_COST_TIER",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("200000", "0")),
      "MODEL_SHEET_INVALID_CONTEXT_LIMIT",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("| 2 |", "| 0 |")),
      "MODEL_SHEET_INVALID_CONCURRENCY_LIMIT",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("8/10", "10/8")),
      "MODEL_SHEET_INVALID_QUALITY_HISTORY",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("opencode-general | 8/10", "missing-model | 8/10")),
      "MODEL_SHEET_INVALID_FALLBACK",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("opencode-general | 8/10", "opencode-general,opencode-general | 8/10")),
      "MODEL_SHEET_INVALID_FALLBACK",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("opencode-general | 8/10", "opencode-general, | 8/10")),
      "MODEL_SHEET_INVALID_FALLBACK",
    );
  });

  it("rejects duplicate model identities and self fallbacks", () => {
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("opencode-planner", "none")),
      "MODEL_SHEET_INVALID_TABLE",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("| opencode-general | opencode |", "| opencode-planner | opencode |")),
      "MODEL_SHEET_DUPLICATE_MODEL",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("opencode-general | 8/10", "opencode-planner | 8/10")),
      "MODEL_SHEET_INVALID_FALLBACK",
    );
  });

  it("rejects fallback cycles and role-incompatible fallbacks", () => {
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("none | 3/4", "opencode-planner | 3/4")),
      "MODEL_SHEET_INVALID_FALLBACK",
    );
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("planner,researcher,implementer,reviewer", "implementer,reviewer")),
      "MODEL_SHEET_INVALID_FALLBACK",
    );
  });

  it("rejects non-table content mixed into the Models section", () => {
    expectErrorCode(
      () => parseModelSheetMarkdown(validSheet.replace("| opencode-general |", "opencode-general |")),
      "MODEL_SHEET_INVALID_TABLE",
    );
  });

  it("wraps file access failures in stable public errors", () => {
    expectErrorCode(
      () => loadModelSheet("/path/that/does/not/exist.md"),
      "MODEL_SHEET_READ_FAILED",
    );
  });

  it("summarizes model capabilities without exposing raw model names", () => {
    const parsed = parseModelSheetMarkdown(validSheet.replace(
      "anthropic/claude-sonnet-4",
      "provider/sk-live-SECRET",
    ));

    const summary = publicModelSheetSummary(parsed);

    expect(summary).toMatchObject({
      modelCount: 2,
      harnesses: ["opencode"],
      roles: ["implementer", "planner", "researcher", "reviewer"],
      costTiers: ["low", "medium"],
      maxConcurrency: 6,
    });
    expect(JSON.stringify(summary)).not.toContain("sk-live-SECRET");
    expect(JSON.stringify(summary)).not.toContain("provider/");
  });
});

function expectErrorCode(
  operation: () => unknown,
  code: ModelSheetError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelSheetError);
    expect((error as ModelSheetError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}
