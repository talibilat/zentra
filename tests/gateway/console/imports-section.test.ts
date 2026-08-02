import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { IMPORTS_MARKUP, IMPORTS_SCRIPT } from "../../../src/gateway/console/imports-section.js";

describe("imports section", () => {
  it("keeps a single root container for renderImports to populate", () => {
    expect(IMPORTS_MARKUP).toContain('id="imports-root"');
  });

  it("shows an explicit preview note", () => {
    expect(IMPORTS_SCRIPT).toContain("Preview: static example data");
  });

  it("renders example adapter sources", () => {
    expect(IMPORTS_SCRIPT).toContain("Claude Code session export");
  });

  it("renders the import button disabled, with no click handler", () => {
    expect(IMPORTS_SCRIPT).toContain("button.disabled=true");
    expect(IMPORTS_SCRIPT).not.toContain("addEventListener");
  });

  it("shows the empty state for recent imports, since none are real", () => {
    expect(IMPORTS_SCRIPT).toContain("No imports yet");
  });

  it("never builds DOM with innerHTML", () => {
    expect(IMPORTS_SCRIPT).not.toContain("innerHTML");
  });

  it("isolates font-stack interpolation inside single-quoted constants, never a double-quoted string", () => {
    const source = readFileSync("src/gateway/console/imports-section.ts", "utf8");
    const lines = source.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("registers itself under window.__consoleSections.imports.render and self-invokes on load", () => {
    expect(IMPORTS_SCRIPT).toContain("window.__consoleSections.imports={render:renderImports}");
    expect(IMPORTS_SCRIPT.trim().endsWith("renderImports();")).toBe(true);
  });
});
