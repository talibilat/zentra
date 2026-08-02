import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { COMPARE_MARKUP, COMPARE_SCRIPT } from "../../../src/gateway/console/compare-section.js";

describe("compare section", () => {
  it("keeps a single root container for renderCompare to populate", () => {
    expect(COMPARE_MARKUP).toContain('id="compare-root"');
  });

  it("shows an explicit preview note", () => {
    expect(COMPARE_SCRIPT).toContain("Preview: static example data");
  });

  it("renders one fixed example comparison, not a functioning run picker", () => {
    expect(COMPARE_SCRIPT).toContain("compare-run-a.jsonl");
    expect(COMPARE_SCRIPT).toContain("compare-run-b.jsonl");
    expect(COMPARE_SCRIPT).not.toContain("addEventListener");
  });

  it("renders added and removed facts columns", () => {
    expect(COMPARE_SCRIPT).toContain("addedFacts");
    expect(COMPARE_SCRIPT).toContain("removedFacts");
  });

  it("never builds DOM with innerHTML", () => {
    expect(COMPARE_SCRIPT).not.toContain("innerHTML");
  });

  it("isolates font-stack interpolation inside single-quoted constants, never a double-quoted string", () => {
    const source = readFileSync("src/gateway/console/compare-section.ts", "utf8");
    const lines = source.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("registers itself under window.__consoleSections.compare.render and self-invokes on load", () => {
    expect(COMPARE_SCRIPT).toContain("window.__consoleSections.compare={render:renderCompare}");
    expect(COMPARE_SCRIPT.trim().endsWith("renderCompare();")).toBe(true);
  });

  it("does not depend on the currently selected run", () => {
    expect(COMPARE_SCRIPT).not.toContain("currentRun()");
    expect(COMPARE_SCRIPT).not.toContain("state.selected");
  });
});
