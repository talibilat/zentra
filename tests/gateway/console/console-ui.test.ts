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
    expect(html).toContain('id="pods-list"');
    expect(html).toContain('id="milestones-list"');
  });

  it("includes the six newly-wired sections' data-screen-label markers", () => {
    const html = consoleHtml();
    for (const label of ["Warnings", "Security", "Cost", "Compare runs", "Imports", "Warning policies"]) {
      expect(html).toContain(`data-screen-label="${label}"`);
    }
  });

  it("includes the Pods section's data-screen-label marker", () => {
    const html = consoleHtml();
    expect(html).toContain('data-screen-label="Pods"');
  });

  it("includes the Milestones section's data-screen-label marker", () => {
    const html = consoleHtml();
    expect(html).toContain('data-screen-label="Milestones"');
  });

  it("concatenates MILESTONES_SCRIPT into the composed document", () => {
    const html = consoleHtml();
    expect(html).toContain("window.__consoleSections.milestones={render:renderMilestones,load:loadMilestones}");
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

  it("concatenates PODS_SCRIPT into the composed document", () => {
    const html = consoleHtml();
    expect(html).toContain("window.__consoleSections.pods={render:renderPods,load:loadPods}");
  });
});
