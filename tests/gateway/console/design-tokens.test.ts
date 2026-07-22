import { describe, expect, it } from "vitest";

import { CONSOLE_DESIGN_TOKENS, CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "../../../src/gateway/console/design-tokens.js";

describe("console design tokens", () => {
  it("defines the AgentTrail-matching color palette", () => {
    for (const token of ["--bg:#0a0e17", "--panel:#111725", "--run:#33c9ff", "--ok:#37e39b", "--warn:#ffb454", "--err:#ff5d6c", "--accent:#7aa2ff", "--orch:#b18cff"]) {
      expect(CONSOLE_DESIGN_TOKENS).toContain(token);
    }
  });

  it("never references an external font host", () => {
    expect(CONSOLE_DESIGN_TOKENS).not.toMatch(/https?:\/\//);
    expect(CONSOLE_FONT_STACK_SANS).not.toMatch(/https?:\/\//);
    expect(CONSOLE_FONT_STACK_MONO).not.toMatch(/https?:\/\//);
    expect(CONSOLE_FONT_STACK_SANS).toContain("system-ui");
    expect(CONSOLE_FONT_STACK_MONO).toContain("monospace");
  });
});
