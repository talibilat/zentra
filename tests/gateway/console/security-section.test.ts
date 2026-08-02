import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SECURITY_MARKUP, SECURITY_SCRIPT } from "../../../src/gateway/console/security-section.js";

describe("security section", () => {
  it("keeps a single root container for renderSecurity to populate", () => {
    expect(SECURITY_MARKUP).toContain('id="security-root"');
  });

  it("shows an explicit preview note", () => {
    expect(SECURITY_SCRIPT).toContain("Preview: static example data");
  });

  it("renders an example taint path with a chain of trust-labeled nodes", () => {
    expect(SECURITY_SCRIPT).toContain("planning-doc.md");
    expect(SECURITY_SCRIPT).toContain("untrusted");
  });

  it("renders chain nodes as disabled buttons, not real navigation", () => {
    expect(SECURITY_SCRIPT).toContain("button.disabled=true");
    expect(SECURITY_SCRIPT).not.toContain("addEventListener");
  });

  it("never builds DOM with innerHTML", () => {
    expect(SECURITY_SCRIPT).not.toContain("innerHTML");
  });

  it("isolates font-stack interpolation inside single-quoted constants, never a double-quoted string", () => {
    const source = readFileSync("src/gateway/console/security-section.ts", "utf8");
    const lines = source.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("registers itself under window.__consoleSections.security.render and self-invokes on load", () => {
    expect(SECURITY_SCRIPT).toContain("window.__consoleSections.security={render:renderSecurity}");
    expect(SECURITY_SCRIPT.trim().endsWith("renderSecurity();")).toBe(true);
  });

  it("does not depend on the currently selected run", () => {
    expect(SECURITY_SCRIPT).not.toContain("currentRun()");
    expect(SECURITY_SCRIPT).not.toContain("state.selected");
  });
});
