import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TRAIL_MARKUP, TRAIL_SCRIPT } from "../../../src/gateway/console/trail-section.js";

describe("trail-section markup", () => {
  it("keeps the AgentTrail status banner and drops the iframe", () => {
    expect(TRAIL_MARKUP).toContain('id="agenttrail-status"');
    expect(TRAIL_MARKUP).not.toContain("agenttrail-frame");
    expect(TRAIL_MARKUP).not.toContain("<iframe");
  });

  it("renders all four target tabs, with only Events enabled", () => {
    expect(TRAIL_MARKUP).toContain('data-trail-view="events"');
    for (const disabled of ["graph", "tree"]) {
      const start = TRAIL_MARKUP.indexOf(`data-trail-view="${disabled}"`);
      expect(start).toBeGreaterThan(-1);
      const tag = TRAIL_MARKUP.slice(start, TRAIL_MARKUP.indexOf("</button>", start));
      expect(tag).toContain("disabled");
      expect(tag).toContain('aria-disabled="true"');
      expect(tag).toContain('class="badge"');
    }
    const eventsStart = TRAIL_MARKUP.indexOf('data-trail-view="events"');
    const eventsTag = TRAIL_MARKUP.slice(eventsStart, TRAIL_MARKUP.indexOf("</button>", eventsStart));
    expect(eventsTag).not.toContain("disabled");
  });

  it("enables the Swimlane tab", () => {
    const start = TRAIL_MARKUP.indexOf('data-trail-view="swimlane"');
    expect(start).toBeGreaterThan(-1);
    const tag = TRAIL_MARKUP.slice(start, TRAIL_MARKUP.indexOf("</button>", start));
    expect(tag).not.toContain("disabled");
    expect(tag).not.toContain('class="badge"');
  });

  it("has containers for the filter pills, event list, inspector, and scrubber", () => {
    expect(TRAIL_MARKUP).toContain('id="trail-filter-pills"');
    expect(TRAIL_MARKUP).toContain('id="trail-events"');
    expect(TRAIL_MARKUP).toContain('id="trail-inspector"');
    expect(TRAIL_MARKUP).toContain('id="trail-scrub"');
    expect(TRAIL_MARKUP).toContain('id="trail-jump-live"');
    expect(TRAIL_MARKUP).toContain('id="trail-clock"');
    expect(TRAIL_MARKUP).toContain('id="trail-event-count"');
  });
});

describe("trail-section script", () => {
  it("isolates every font-stack interpolation inside a single-quoted constant, never a double-quoted string", () => {
    const source = readFileSync("src/gateway/console/trail-section.ts", "utf8");
    const scriptSource = source.slice(source.indexOf("export const TRAIL_SCRIPT"));
    const lines = scriptSource.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("isolates every font-stack interpolation in TRAIL_MARKUP inside a single-quoted HTML attribute, never a double-quoted one", () => {
    const source = readFileSync("src/gateway/console/trail-section.ts", "utf8");
    const markupSource = source.slice(source.indexOf("export const TRAIL_MARKUP"), source.indexOf("export const TRAIL_SCRIPT"));
    const lines = markupSource.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/="[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("preserves the existing gateway degrade/recover handling and re-fetches trail data on recovery", () => {
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.degraded"');
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.backfill_target"');
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.recovered"');
    const recoveredIndex = TRAIL_SCRIPT.indexOf('change.type==="gateway.recovered"');
    const recoveredBranch = TRAIL_SCRIPT.slice(recoveredIndex, recoveredIndex + 200);
    expect(recoveredBranch).toContain("loadTrail()");
    expect(TRAIL_SCRIPT).not.toContain("contentWindow");
  });

  it("registers a pure render and a fetch-and-load function under window.__consoleSections.trail", () => {
    expect(TRAIL_SCRIPT).toContain("window.__consoleSections.trail={render:renderTrailView,load:loadTrail}");
  });

  it("only resets scrub position and selection when the selected run actually changes", () => {
    expect(TRAIL_SCRIPT).toContain("runChanged");
    expect(TRAIL_SCRIPT).toContain("id!==trailRunId");
  });

  it("shows a distinct empty-state message for each of the three reasons the event list can be empty", () => {
    expect(TRAIL_SCRIPT).toContain("trailLoadFailed");
    expect(TRAIL_SCRIPT).toContain('"Trace evidence unavailable."');
    expect(TRAIL_SCRIPT).toContain('"Select a run to see its trail."');
    expect(TRAIL_SCRIPT).toContain('"No events match the current filters."');
  });

  it("reads durationSeconds from the trail response and uses it for the inspector's duration row", () => {
    expect(TRAIL_SCRIPT).toContain("trailDurationSeconds");
    expect(TRAIL_SCRIPT).toContain("trailFormatClock(trailDurationSeconds)");
  });

  it("fetches the new trail endpoint for the current run", () => {
    expect(TRAIL_SCRIPT).toContain('"/api/v1/zentra/runs/"+encodeURIComponent(id)+"/trail"');
  });

  it("classifies failed events using the reshaped view's own failed field, not a re-derived one", () => {
    expect(TRAIL_SCRIPT).toContain("trailEvent.failed");
    expect(TRAIL_SCRIPT).not.toContain('.status.toLowerCase()');
  });

  it("filters visible events by actor, kind prefix, failed-only, search text, and scrub horizon", () => {
    expect(TRAIL_SCRIPT).toContain("trailFilterActor");
    expect(TRAIL_SCRIPT).toContain("trailFilterKind");
    expect(TRAIL_SCRIPT).toContain("trailFailedOnly");
    expect(TRAIL_SCRIPT).toContain("state.search");
    expect(TRAIL_SCRIPT).toContain("trailScrubT");
  });

  it("switches between Events and Swimlane without a second fetch", () => {
    expect(TRAIL_SCRIPT).toContain("trailActiveView");
    const requestCalls = TRAIL_SCRIPT.match(/request\(/g) ?? [];
    expect(requestCalls.length).toBe(1);
  });

  it("renders swimlane lanes from the same filtered event list the Events view uses, not a separate computation", () => {
    const swimlaneIndex = TRAIL_SCRIPT.indexOf("const renderTrailSwimlane=");
    expect(swimlaneIndex).toBeGreaterThan(-1);
    const nextConst = TRAIL_SCRIPT.indexOf("\nconst ", swimlaneIndex + 1);
    const body = TRAIL_SCRIPT.slice(swimlaneIndex, nextConst > -1 ? nextConst : undefined);
    expect(body).toContain("trailVisibleEvents()");
  });

  it("selects a swimlane marker into the same trailSelectedEvent the inspector reads", () => {
    const swimlaneIndex = TRAIL_SCRIPT.indexOf("const renderTrailSwimlane=");
    const nextConst = TRAIL_SCRIPT.indexOf("\nconst ", swimlaneIndex + 1);
    const body = TRAIL_SCRIPT.slice(swimlaneIndex, nextConst > -1 ? nextConst : undefined);
    expect(body).toContain("trailSelectedEvent=");
  });
});
