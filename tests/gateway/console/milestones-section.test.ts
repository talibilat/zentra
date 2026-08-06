import { describe, expect, it } from "vitest";

import { MILESTONES_MARKUP, MILESTONES_SCRIPT } from "../../../src/gateway/console/milestones-section.js";

describe("milestones section", () => {
  it("keeps a two-panel workspace with a list root and a detail root", () => {
    expect(MILESTONES_MARKUP).toContain('id="milestones-list"');
    expect(MILESTONES_MARKUP).toContain('id="milestone-detail"');
  });

  it("reuses the shared two-column workspace variant", () => {
    expect(MILESTONES_MARKUP).toContain('data-columns="2"');
  });

  it("carries the data-screen-label the nav item's label must match", () => {
    expect(MILESTONES_MARKUP).toContain('data-screen-label="Milestones"');
  });

  it("fetches the milestone list from the real API, not a static demo dataset", () => {
    expect(MILESTONES_SCRIPT).toContain('request("/api/v1/zentra/milestones")');
    expect(MILESTONES_SCRIPT).not.toContain("DEMO_DATA");
  });

  it("fetches full milestone detail on selection, not just from the list response", () => {
    expect(MILESTONES_SCRIPT).toContain('request("/api/v1/zentra/milestones/"+encodeURIComponent(id))');
  });

  it("registers a load hook and does not self-invoke at script load", () => {
    expect(MILESTONES_SCRIPT).toContain("window.__consoleSections.milestones={render:renderMilestones,load:loadMilestones}");
    expect(MILESTONES_SCRIPT.trim().endsWith("load:loadMilestones};")).toBe(true);
  });

  it("never builds DOM with innerHTML", () => {
    expect(MILESTONES_SCRIPT).not.toContain("innerHTML");
  });

  it("selects a milestone on click", () => {
    expect(MILESTONES_SCRIPT).toContain('addEventListener("click"');
  });

  it("shows honest empty states for the list and the detail panel", () => {
    expect(MILESTONES_SCRIPT).toContain("No milestones yet.");
    expect(MILESTONES_SCRIPT).toContain("Milestones unavailable.");
    expect(MILESTONES_SCRIPT).toContain("Select a milestone to inspect its plan, tasks, and history.");
    expect(MILESTONES_SCRIPT).toContain("Milestone detail unavailable.");
  });
});
