// tests/gateway/console/console-ui.test.ts
import { createHash } from "node:crypto";
import { Script } from "node:vm";

import { describe, expect, it } from "vitest";

import { consoleHtml, CONSOLE_SCRIPT_SHA256 } from "../../../src/gateway/console/console-ui.js";

describe("composed console document", () => {
  it("embeds a single inline script whose digest matches the exported CSP hash", () => {
    const html = consoleHtml();
    const match = /<script>([\s\S]*)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const digest = createHash("sha256").update(match![1]!, "utf8").digest("base64");
    expect(digest).toBe(CONSOLE_SCRIPT_SHA256);
  });

  it("includes every section's markup and preserves controls' DOM ids", () => {
    const html = consoleHtml();
    expect(html).toContain('id="goal-form"');
    expect(html).toContain('id="trail-events"');
    expect(html).toContain('id="overview-root"');
  });

  it("includes the six newly-wired sections' data-screen-label markers", () => {
    const html = consoleHtml();
    for (const label of ["Warnings", "Security", "Cost", "Compare runs", "Imports", "Warning policies"]) {
      expect(html).toContain(`data-screen-label="${label}"`);
    }
  });

  it("produces a script that parses as valid JavaScript", () => {
    const html = consoleHtml();
    const match = /<script>([\s\S]*)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    expect(() => new Script(match![1]!)).not.toThrow();
  });

  it("concatenates all six new sections' scripts into the composed document, not just their markup", () => {
    const html = consoleHtml();
    for (const call of ["renderWarnings();", "renderSecurity();", "renderCost();", "renderCompare();", "renderImports();", "renderPolicies();"]) {
      expect(html).toContain(call);
    }
  });
});
