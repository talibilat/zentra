import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { POLICIES_MARKUP, POLICIES_SCRIPT } from "../../../src/gateway/console/policies-section.js";

describe("policies section", () => {
  it("keeps a single root container for renderPolicies to populate", () => {
    expect(POLICIES_MARKUP).toContain('id="policies-root"');
  });

  it("shows an explicit preview note", () => {
    expect(POLICIES_SCRIPT).toContain("Preview: static example data");
  });

  it("renders example policy rows with operation names", () => {
    expect(POLICIES_SCRIPT).toContain("tool.call.run_tests");
  });

  it("renders the suppress toggle disabled, with no click handler", () => {
    expect(POLICIES_SCRIPT).toContain("button.disabled=true");
    expect(POLICIES_SCRIPT).not.toContain("addEventListener");
  });

  it("never builds DOM with innerHTML", () => {
    expect(POLICIES_SCRIPT).not.toContain("innerHTML");
  });

  it("isolates font-stack interpolation inside single-quoted constants, never a double-quoted string", () => {
    const source = readFileSync("src/gateway/console/policies-section.ts", "utf8");
    const lines = source.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("registers itself under window.__consoleSections.policies.render and self-invokes on load", () => {
    expect(POLICIES_SCRIPT).toContain("window.__consoleSections.policies={render:renderPolicies}");
    expect(POLICIES_SCRIPT.trim().endsWith("renderPolicies();")).toBe(true);
  });
});
