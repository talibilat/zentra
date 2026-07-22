// tests/gateway/console/shell.test.ts
import { describe, expect, it } from "vitest";

import { SHELL_MARKUP, SHELL_SCRIPT } from "../../../src/gateway/console/shell.js";

describe("console shell", () => {
  it("renders all twelve mock nav items plus the carried-over Controls entry, grouped correctly", () => {
    const groups: Record<string, readonly string[]> = {
      OPERATE: ["Controls"],
      OBSERVE: ["Overview", "Trail", "Warnings", "Security", "Cost"],
      ANALYZE: ["Compare runs", "Imports"],
      ZENTRA: ["Pods", "Milestones", "GitHub broker", "Journal"],
      CONFIG: ["Warning policies"],
    };
    for (const [group, items] of Object.entries(groups)) {
      expect(SHELL_MARKUP).toContain(group);
      for (const item of items) expect(SHELL_MARKUP).toContain(item);
    }
  });

  it("marks only Controls, Overview, and Trail as enabled nav targets", () => {
    for (const enabled of ["data-nav-id=\"controls\"", "data-nav-id=\"overview\"", "data-nav-id=\"trail\""]) {
      expect(SHELL_MARKUP).toContain(enabled);
    }
    expect(SHELL_MARKUP).toContain('data-nav-id="pods" disabled');
    expect(SHELL_MARKUP).toContain('data-nav-id="milestones" disabled');
    expect(SHELL_MARKUP).toContain('data-nav-id="journal" disabled');
  });

  it("owns the single page-level session handoff and wires Controls' connect hook after it", () => {
    expect(SHELL_SCRIPT).toContain("async function handoff()");
    expect(SHELL_SCRIPT).toContain("window.__consoleSections.controls?.connect?.()");
  });

  it("re-establishes the AgentTrail iframe src after session handoff, since Task 4 removed the old dynamic assignment from controls-section.ts", () => {
    expect(SHELL_SCRIPT).toContain('document.getElementById("agenttrail-frame").src="/agenttrail/"');
  });

  it("never loads a font from an external host", () => {
    expect(SHELL_MARKUP).not.toMatch(/fonts\.googleapis\.com/);
  });

  it("carries over the component styles Controls' ported markup depends on, and the connection-status element connect() targets", () => {
    for (const selector of [".panel{", ".run-card,.attention-card{", ".badge{", ".fact{", ".decision-actions{", "textarea,input,select{"]) {
      expect(SHELL_MARKUP).toContain(selector);
    }
    expect(SHELL_MARKUP).toContain('id="connection"');
  });

  it("confirms session success with the same status text the prior page used, which an existing untouched e2e test asserts on", () => {
    expect(SHELL_SCRIPT).toContain('status("Secure local session established.","ok")');
  });

  it("marks the page ready only after the initial run data has loaded, matching operations-ui.ts's original synchronization contract", () => {
    expect(SHELL_SCRIPT).toContain("await window.__consoleSections.controls?.refresh?.()");
    const readyIndex = SHELL_SCRIPT.indexOf('document.documentElement.dataset.ready="true"');
    const refreshIndex = SHELL_SCRIPT.indexOf("await window.__consoleSections.controls?.refresh?.()");
    expect(refreshIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(refreshIndex);
    expect(SHELL_SCRIPT).toContain("void window.__consoleSections.controls?.connect?.()");
    expect(SHELL_SCRIPT).not.toContain("await window.__consoleSections.controls?.connect?.()");
  });
});
