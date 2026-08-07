import { describe, expect, it } from "vitest";

import { JOURNAL_MARKUP, JOURNAL_SCRIPT } from "../../../src/gateway/console/journal-section.js";

describe("journal section", () => {
  it("is a single-panel status dashboard, not a two-column list+detail layout", () => {
    expect(JOURNAL_MARKUP).not.toContain('data-columns="2"');
    expect(JOURNAL_MARKUP).toContain('data-screen-label="Journal"');
  });

  it("fetches status from the real API, not a static demo dataset", () => {
    expect(JOURNAL_SCRIPT).toContain('request("/api/v1/zentra/journal")');
    expect(JOURNAL_SCRIPT).not.toContain("DEMO_DATA");
    const requestCalls = JOURNAL_SCRIPT.match(/request\(/g) ?? [];
    expect(requestCalls.length).toBe(1);
  });

  it("registers a load hook and does not self-invoke at script load", () => {
    expect(JOURNAL_SCRIPT).toContain("window.__consoleSections.journal={render:renderJournalStatus,load:loadJournalStatus}");
    expect(JOURNAL_SCRIPT.trim().endsWith("load:loadJournalStatus};")).toBe(true);
  });

  it("never builds DOM with innerHTML", () => {
    expect(JOURNAL_SCRIPT).not.toContain("innerHTML");
  });

  it("shows honest unavailable states for the whole fetch, retention, and projection independently", () => {
    expect(JOURNAL_SCRIPT).toContain("Journal status unavailable.");
    expect(JOURNAL_SCRIPT).toContain("Retention status unavailable in this environment.");
    expect(JOURNAL_SCRIPT).toContain("Projection status unavailable in this environment.");
  });

  it("renders recovery outcome and the retention/archive facts", () => {
    for (const term of ["Retained through", "Archive head", "Archive segments", "Retention policy", "Recovery"]) {
      expect(JOURNAL_SCRIPT).toContain(term);
    }
  });

  it("renders the live projection cursor facts", () => {
    for (const term of ["Cursor", "Lag", "Replay count"]) {
      expect(JOURNAL_SCRIPT).toContain(term);
    }
  });
});
