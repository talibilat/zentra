import { describe, expect, it } from "vitest";

import { JOURNAL_MARKUP, JOURNAL_SCRIPT } from "../../../src/gateway/console/journal-section.js";

describe("journal section", () => {
  it("keeps the Status panel single-column, not a two-column list+detail layout", () => {
    // Scoped to the status panel only: #127 adds a genuinely two-column
    // list+detail Events panel (data-columns="2"), so the original
    // whole-markup assertion no longer holds for JOURNAL_MARKUP as a whole.
    const statusPanel = JOURNAL_MARKUP.slice(
      JOURNAL_MARKUP.indexOf('data-journal-panel="status"'),
      JOURNAL_MARKUP.indexOf('data-journal-panel="events"'),
    );
    expect(statusPanel).not.toContain('data-columns="2"');
    expect(JOURNAL_MARKUP).toContain('data-screen-label="Journal"');
  });

  it("fetches status from the real API, not a static demo dataset", () => {
    expect(JOURNAL_SCRIPT).toContain('request("/api/v1/zentra/journal")');
    expect(JOURNAL_SCRIPT).not.toContain("DEMO_DATA");
    // Scoped to the status-loading code only: #127 adds a second, independent
    // request() call for loadJournalEvents, so the whole-script count is no
    // longer 1.
    const statusScript = JOURNAL_SCRIPT.slice(0, JOURNAL_SCRIPT.indexOf("let journalActiveView"));
    const requestCalls = statusScript.match(/request\(/g) ?? [];
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

  it("shows the whole-fetch-failure message in both renderJournalRetention and renderJournalProjection, not just one", () => {
    const retentionBody = JOURNAL_SCRIPT.slice(
      JOURNAL_SCRIPT.indexOf("const renderJournalRetention="),
      JOURNAL_SCRIPT.indexOf("const renderJournalProjection="),
    );
    const projectionBody = JOURNAL_SCRIPT.slice(
      JOURNAL_SCRIPT.indexOf("const renderJournalProjection="),
      JOURNAL_SCRIPT.indexOf("const renderJournalStatus="),
    );
    expect(retentionBody).toContain("Journal status unavailable.");
    expect(projectionBody).toContain("Journal status unavailable.");
    // The projection panel must not silently return without rendering anything
    // when the whole fetch fails - it should not bail out before appending a message.
    expect(projectionBody).not.toMatch(/if\(journalLoadFailed\)return;/);
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

  it("renders the high-water position fact called for by the design spec", () => {
    expect(JOURNAL_SCRIPT).toContain("High water");
  });

  it("has a Status/Events tab switcher within the Journal screen", () => {
    expect(JOURNAL_MARKUP).toContain('data-journal-view="status"');
    expect(JOURNAL_MARKUP).toContain('data-journal-view="events"');
  });

  it("has filter inputs and a load-more affordance for the Events tab", () => {
    expect(JOURNAL_MARKUP).toContain('id="journal-events-stream-filter"');
    expect(JOURNAL_MARKUP).toContain('id="journal-events-type-filter"');
    expect(JOURNAL_MARKUP).toContain('id="journal-events-load-more"');
  });

  it("fetches journal events from the real API, not a static demo dataset", () => {
    expect(JOURNAL_SCRIPT).toContain('"/api/v1/zentra/journal/events');
    expect(JOURNAL_SCRIPT).not.toContain("DEMO_DATA");
  });

  it("renders an honest message for a zero-match page that still has more to scan, distinct from true end-of-results", () => {
    expect(JOURNAL_SCRIPT).toContain("No matching events in this range.");
    expect(JOURNAL_SCRIPT).toContain("No events found.");
    expect(JOURNAL_SCRIPT).toContain("Journal events unavailable.");
  });

  it("appends load-more results instead of replacing the existing list", () => {
    const loadMoreIndex = JOURNAL_SCRIPT.indexOf("journal-events-load-more");
    expect(loadMoreIndex).toBeGreaterThan(-1);
  });

  it("syncs Load-more button visibility on every renderJournalEventsList path, including both empty-list early returns", () => {
    const listBody = JOURNAL_SCRIPT.slice(
      JOURNAL_SCRIPT.indexOf("const renderJournalEventsList="),
      JOURNAL_SCRIPT.indexOf("const renderJournalEventDetail="),
    );
    const syncCallIndex = listBody.indexOf("syncJournalEventsControls()");
    const failedEmptyReturnIndex = listBody.indexOf("journalEventsLoadFailed&&!journalEvents.length");
    const zeroMatchReturnIndex = listBody.indexOf("No matching events in this range.");
    expect(syncCallIndex).toBeGreaterThan(-1);
    // The sync call must appear before both early-return branches so neither one
    // skips it - a page with hasMore:true must still show Load more even when it
    // renders an empty-list message.
    expect(syncCallIndex).toBeLessThan(failedEmptyReturnIndex);
    expect(syncCallIndex).toBeLessThan(zeroMatchReturnIndex);
  });

  it("guards loadJournalEvents against overlapping in-flight requests, clearing the flag in a finally block", () => {
    const loadBody = JOURNAL_SCRIPT.slice(
      JOURNAL_SCRIPT.indexOf("const loadJournalEvents="),
      JOURNAL_SCRIPT.indexOf("const renderJournalEventsList="),
    );
    expect(loadBody).toContain("if(journalEventsLoading)return");
    expect(loadBody).toContain("journalEventsLoading=true");
    expect(loadBody).toMatch(/finally\{\s*journalEventsLoading=false/);
  });

  it("disables the Load-more and Apply buttons while a fetch is in flight", () => {
    const syncBody = JOURNAL_SCRIPT.slice(
      JOURNAL_SCRIPT.indexOf("const syncJournalEventsControls="),
      JOURNAL_SCRIPT.indexOf("const loadJournalEvents="),
    );
    expect(syncBody).toContain('$("journal-events-load-more")');
    expect(syncBody).toContain("loadMore.disabled=journalEventsLoading");
    expect(syncBody).toContain('$("journal-events-apply-filter")');
    expect(syncBody).toContain("applyButton.disabled=journalEventsLoading");
  });

  it("renders event rows as a dense single-line row, not Pods'/Milestones' .run-card style", () => {
    const listBody = JOURNAL_SCRIPT.slice(
      JOURNAL_SCRIPT.indexOf("const renderJournalEventsList="),
      JOURNAL_SCRIPT.indexOf("const renderJournalEventDetail="),
    );
    expect(listBody).not.toContain('row.className="run-card"');
    expect(listBody).toContain('row.className="journal-event-row"');
    expect(listBody).toContain("display:flex;align-items:center;gap:12px");
  });

  it("shows the full StoredEvent via appendJson in the detail panel, not just the payload", () => {
    const detailBody = JOURNAL_SCRIPT.slice(
      JOURNAL_SCRIPT.indexOf("const renderJournalEventDetail="),
      JOURNAL_SCRIPT.indexOf("const renderJournalEvents="),
    );
    expect(detailBody).toContain('appendJson(host,"Event",event)');
    expect(detailBody).not.toContain('appendJson(host,"Payload",event.payload)');
  });

  it("clears the sticky load-failed message when a row is selected, so re-rendering after a click doesn't show a stale failure", () => {
    const listBody = JOURNAL_SCRIPT.slice(
      JOURNAL_SCRIPT.indexOf("const renderJournalEventsList="),
      JOURNAL_SCRIPT.indexOf("const renderJournalEventDetail="),
    );
    expect(listBody).toContain("journalSelectedEventId=event.eventId;journalEventsLoadFailed=false;renderJournalEvents()");
  });
});
