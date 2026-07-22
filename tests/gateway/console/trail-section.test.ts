import { describe, expect, it } from "vitest";

import { TRAIL_MARKUP, TRAIL_SCRIPT } from "../../../src/gateway/console/trail-section.js";

describe("trail section", () => {
  it("still embeds the AgentTrail evidence frame at its existing gateway route", () => {
    expect(TRAIL_MARKUP).toContain('id="agenttrail-frame"');
    expect(TRAIL_MARKUP).toContain('id="agenttrail-status"');
  });

  it("uses a flush full-height frame instead of a bordered panel, matching Console.dc.html's Trail layout", () => {
    expect(TRAIL_MARKUP).toMatch(/data-screen-label="Trail"/);
    expect(TRAIL_MARKUP).not.toContain('class="panel evidence"');
  });

  it("still relays gateway degrade/recover signals to the status indicator and reloads the frame on recovery", () => {
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.degraded"');
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.backfill_target"');
    expect(TRAIL_SCRIPT).toContain('change.type==="gateway.recovered"');
    expect(TRAIL_SCRIPT).toContain('$("agenttrail-frame").contentWindow?.location.reload()');
  });
});
