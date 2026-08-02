import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WARNINGS_MARKUP, WARNINGS_SCRIPT } from "../../../src/gateway/console/warnings-section.js";

describe("warnings section", () => {
  it("keeps a single root container for renderWarnings to populate", () => {
    expect(WARNINGS_MARKUP).toContain('id="warnings-root"');
  });

  it("shows an explicit preview note, not silently fake data", () => {
    expect(WARNINGS_SCRIPT).toContain("Preview: static example data");
  });

  it("renders at least one example warning card with code, actor, and summary", () => {
    expect(WARNINGS_SCRIPT).toContain("LOOP");
    expect(WARNINGS_SCRIPT).toContain("pod-b");
  });

  it("renders every action button disabled, with no click handler", () => {
    expect(WARNINGS_SCRIPT).toContain("button.disabled=true");
    expect(WARNINGS_SCRIPT).not.toContain("addEventListener");
  });

  it("never builds DOM with innerHTML", () => {
    expect(WARNINGS_SCRIPT).not.toContain("innerHTML");
  });

  it("isolates font-stack interpolation inside single-quoted constants, never a double-quoted string", () => {
    const source = readFileSync("src/gateway/console/warnings-section.ts", "utf8");
    const lines = source.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("registers itself under window.__consoleSections.warnings.render and self-invokes on load", () => {
    expect(WARNINGS_SCRIPT).toContain("window.__consoleSections.warnings={render:renderWarnings}");
    expect(WARNINGS_SCRIPT.trim().endsWith("renderWarnings();")).toBe(true);
  });

  it("does not depend on the currently selected run", () => {
    expect(WARNINGS_SCRIPT).not.toContain("currentRun()");
    expect(WARNINGS_SCRIPT).not.toContain("state.selected");
  });
});
