// tests/gateway/console/shell.test.ts
import { describe, expect, it } from "vitest";

import { SHELL_MARKUP, SHELL_SCRIPT } from "../../../src/gateway/console/shell.js";
import { CONTROLS_SCRIPT } from "../../../src/gateway/console/controls-section.js";

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

  it("marks Controls, Overview, Trail, and Pods as enabled nav targets", () => {
    for (const enabled of ["data-nav-id=\"controls\"", "data-nav-id=\"overview\"", "data-nav-id=\"trail\"", "data-nav-id=\"pods\""]) {
      expect(SHELL_MARKUP).toContain(enabled);
    }
    expect(SHELL_MARKUP).not.toContain('data-nav-id="pods" disabled');
    expect(SHELL_MARKUP).toContain('data-nav-id="milestones" disabled');
    expect(SHELL_MARKUP).toContain('data-nav-id="journal" disabled');
  });

  it("owns the single page-level session handoff and wires Controls' connect hook after it", () => {
    expect(SHELL_SCRIPT).toContain("async function handoff()");
    expect(SHELL_SCRIPT).toContain("window.__consoleSections.controls?.connect?.()");
  });

  it("removes the dead agenttrail-frame reference from handoff and wires console-search to Trail's render", () => {
    expect(SHELL_SCRIPT).not.toContain("agenttrail-frame");
    const searchIndex = SHELL_SCRIPT.indexOf('$("console-search")?.addEventListener("input"');
    expect(searchIndex).toBeGreaterThan(-1);
    const searchBranch = SHELL_SCRIPT.slice(searchIndex, searchIndex + 300);
    expect(searchBranch).toContain("window.__consoleSections.trail?.render?.()");
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

  it("gives every nav item the mockup's icon glyph", () => {
    const icons: Record<string, string> = {
      controls: "▶", overview: "◉", trail: "⬡", warnings: "△", security: "⛨", cost: "◔",
      compare: "⑂", imports: "⇥", pods: "⬢", milestones: "⊕", github: "⎇", journal: "≣", policies: "⚙",
    };
    for (const [id, icon] of Object.entries(icons)) {
      const marker = `data-nav-id="${id}"`;
      const start = SHELL_MARKUP.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const buttonEnd = SHELL_MARKUP.indexOf("</button>", start);
      expect(SHELL_MARKUP.slice(start, buttonEnd)).toContain(`<span class="nav-icon">${icon}</span>`);
    }
  });

  it("adds a topbar with a run switcher, an inert search box, and the relocated connection badge", () => {
    for (const marker of [
      '<header class="topbar"',
      'id="run-switcher-button"',
      'id="run-switcher-dot"',
      'id="run-switcher-title"',
      'id="run-switcher-menu"',
      'id="run-switcher-rows"',
      'id="console-search"',
      'id="connection"',
    ]) {
      expect(SHELL_MARKUP).toContain(marker);
    }
    // connection now lives inside the topbar, not as a standalone paragraph
    const topbarStart = SHELL_MARKUP.indexOf('<header class="topbar"');
    const topbarEnd = SHELL_MARKUP.indexOf("</header>");
    expect(SHELL_MARKUP.indexOf('id="connection"')).toBeGreaterThan(topbarStart);
    expect(SHELL_MARKUP.indexOf('id="connection"')).toBeLessThan(topbarEnd);
  });

  it("renders the topbar via window.__consoleSections.shell and picking a run switcher row calls the existing selectRun", () => {
    expect(SHELL_SCRIPT).toContain("window.__consoleSections.shell={render:renderTopbar}");
    const renderTopbarBody = SHELL_SCRIPT.slice(SHELL_SCRIPT.indexOf("const renderTopbar="), SHELL_SCRIPT.indexOf('$("run-switcher-button")?.addEventListener("click"'));
    expect(renderTopbarBody).toContain("row.addEventListener(\"click\",()=>{");
    expect(renderTopbarBody).toContain("selectRun(id)");
  });

  it("refreshes the topbar every time Controls loads or switches a run", () => {
    const refreshBody = CONTROLS_SCRIPT.slice(CONTROLS_SCRIPT.indexOf("const refresh=async"), CONTROLS_SCRIPT.indexOf("const selectRun="));
    expect(refreshBody).toContain("window.__consoleSections.shell?.render?.()");
    const selectRunBody = CONTROLS_SCRIPT.slice(CONTROLS_SCRIPT.indexOf("const selectRun=async"), CONTROLS_SCRIPT.indexOf("const loadDecision="));
    expect(selectRunBody).toContain("window.__consoleSections.shell?.render?.()");
  });

  it("colors the run-switcher dot from the real RunLifecycle/TerminalOutcome enums, not fictional substrings", () => {
    expect(SHELL_SCRIPT).toContain("dotColorForRun");
    expect(SHELL_SCRIPT).not.toContain('name.includes("error")');
    expect(SHELL_SCRIPT).toContain('terminalOutcome==="failed"');
    expect(SHELL_SCRIPT).toContain('terminalOutcome==="completed"');
    expect(SHELL_SCRIPT).toContain('terminalOutcome==="cancelled"');
  });

  it("enables the Warnings/Security/Cost/Compare/Imports/Warning-policies nav items and embeds their sections", () => {
    for (const id of ["warnings", "security", "cost", "compare", "imports", "policies"]) {
      const start = SHELL_MARKUP.indexOf(`data-nav-id="${id}"`);
      expect(start).toBeGreaterThan(-1);
      const tag = SHELL_MARKUP.slice(start, SHELL_MARKUP.indexOf("</button>", start));
      expect(tag).not.toContain("disabled");
      expect(tag).not.toContain('class="badge"');
    }
    for (const id of ["warnings", "security", "cost", "compare", "imports", "policies"]) {
      expect(SHELL_MARKUP).toContain(`data-section-id="${id}"`);
    }
    expect(SHELL_MARKUP).toContain('id="warnings-root"');
    expect(SHELL_MARKUP).toContain('id="security-root"');
    expect(SHELL_MARKUP).toContain('id="cost-root"');
    expect(SHELL_MARKUP).toContain('id="compare-root"');
    expect(SHELL_MARKUP).toContain('id="imports-root"');
    expect(SHELL_MARKUP).toContain('id="policies-root"');
  });
});
