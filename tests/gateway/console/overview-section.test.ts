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
    expect(OVERVIEW_SCRIPT).toContain("Warning triage lands in a later phase.");
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
});
