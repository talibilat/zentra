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
    for (const disabled of ["graph", "tree", "swimlane"]) {
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

  it("preserves the existing gateway degrade/recover handling and re-fetches trail data on recovery", () => {
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.degraded"');
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.backfill_target"');
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.recovered"');
    const recoveredIndex = TRAIL_SCRIPT.indexOf('change.type==="gateway.recovered"');
    const recoveredBranch = TRAIL_SCRIPT.slice(recoveredIndex, recoveredIndex + 200);
    expect(recoveredBranch).toContain("loadTrail()");
    expect(TRAIL_SCRIPT).not.toContain("contentWindow");
  });

  it("registers loadTrail under window.__consoleSections.trail", () => {
    expect(TRAIL_SCRIPT).toContain("window.__consoleSections.trail={render:loadTrail}");
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
});
