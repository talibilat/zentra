import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { COST_MARKUP, COST_SCRIPT } from "../../../src/gateway/console/cost-section.js";

describe("cost section", () => {
  it("keeps a single root container for renderCost to populate", () => {
    expect(COST_MARKUP).toContain('id="cost-root"');
  });

  it("shows an explicit preview note", () => {
    expect(COST_SCRIPT).toContain("Preview: static example data");
  });

  it("renders example cost buckets and per-actor rows", () => {
    expect(COST_SCRIPT).toContain("ATTRIBUTED");
    expect(COST_SCRIPT).toContain("pod-a");
  });

  it("never builds DOM with innerHTML", () => {
    expect(COST_SCRIPT).not.toContain("innerHTML");
  });

  it("has no click handlers on any row (no functioning drill-down)", () => {
    expect(COST_SCRIPT).not.toContain("addEventListener");
  });

  it("isolates font-stack interpolation inside single-quoted constants, never a double-quoted string", () => {
    const source = readFileSync("src/gateway/console/cost-section.ts", "utf8");
    const lines = source.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("registers itself under window.__consoleSections.cost.render and self-invokes on load", () => {
    expect(COST_SCRIPT).toContain("window.__consoleSections.cost={render:renderCost}");
    expect(COST_SCRIPT.trim().endsWith("renderCost();")).toBe(true);
  });

  it("does not depend on the currently selected run", () => {
    expect(COST_SCRIPT).not.toContain("currentRun()");
    expect(COST_SCRIPT).not.toContain("state.selected");
  });
});
