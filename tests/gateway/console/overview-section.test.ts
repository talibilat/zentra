import { describe, expect, it } from "vitest";

import { OVERVIEW_MARKUP, OVERVIEW_SCRIPT } from "../../../src/gateway/console/overview-section.js";

describe("overview section", () => {
  it("keeps a single root container for renderOverview to populate", () => {
    expect(OVERVIEW_MARKUP).toContain('id="overview-root"');
  });

  it("shows an honest placeholder for the five metric tiles instead of fabricated numbers", () => {
    for (const metricLabel of ["AGENTS", "EVENTS", "TOKENS", "COST", "WARNINGS"]) {
      expect(OVERVIEW_SCRIPT).toContain(`"${metricLabel}"`);
    }
    expect(OVERVIEW_SCRIPT).toContain("Available in a later phase");
    expect((OVERVIEW_SCRIPT.match(/Available in a later phase/g) || []).length).toBeGreaterThanOrEqual(1);
  });

  it("shows an honest placeholder for top warnings instead of fabricated warning cards", () => {
    expect(OVERVIEW_SCRIPT).toContain("Warning triage has no real backend yet - the Warnings section shows a static preview.");
  });

  it("builds the narrative from state.attention and state.history, not from fabricated demo data", () => {
    expect(OVERVIEW_SCRIPT).toContain("state.attention");
    expect(OVERVIEW_SCRIPT).toContain("state.history");
    expect(OVERVIEW_SCRIPT).not.toMatch(/DATA\.runs/);
  });

  it("never builds DOM with innerHTML, matching the rest of the console's XSS-safe pattern", () => {
    expect(OVERVIEW_SCRIPT).not.toContain("innerHTML");
  });

  it("registers itself under window.__consoleSections.overview.render", () => {
    expect(OVERVIEW_SCRIPT).toContain("window.__consoleSections.overview={render:renderOverview}");
  });

  it("renders the literal em-dash as the metric tile value, not any number", () => {
    expect(OVERVIEW_SCRIPT).toContain('setText(valueEl,"—")');
  });

  it("renders all four Observed Outcome rows sourced from real run/readiness data", () => {
    expect(OVERVIEW_SCRIPT).toContain('"Lifecycle"');
    expect(OVERVIEW_SCRIPT).toContain('"Terminal outcome"');
    expect(OVERVIEW_SCRIPT).toContain('"Readiness"');
    expect(OVERVIEW_SCRIPT).toContain('"Approval"');
    expect(OVERVIEW_SCRIPT).toContain("state.selected?.planning?.readiness");
  });

  it("extracts narrative summaries from item.packet for both pending and resolved items, not the raw kind", () => {
    expect(OVERVIEW_SCRIPT).toContain('value(item.packet||{},["summary","question"]');
    expect(OVERVIEW_SCRIPT).not.toContain('value(item,["title","question","kind"],"Decision")');
  });

  it("sorts the narrative timeline chronologically by streamVersion", () => {
    expect(OVERVIEW_SCRIPT).toContain(".sort(");
    expect(OVERVIEW_SCRIPT).toContain("streamVersion");
  });

  it("uses the shared design-token font stacks instead of hardcoded font names", () => {
    expect(OVERVIEW_SCRIPT).not.toMatch(/'IBM Plex (Mono|Sans)',(monospace|sans-serif)/);
  });
});
