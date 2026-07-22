import { describe, expect, it } from "vitest";

import { CONTROLS_MARKUP, CONTROLS_SCRIPT } from "../../../src/gateway/console/controls-section.js";

describe("controls section", () => {
  it("preserves every DOM id the browser test suite depends on", () => {
    for (const id of ['id="goal-form"', 'id="tickets-form"', 'id="goal"', 'id="ticket-path"', 'id="runs"', 'id="run-detail"', 'id="cancel-run"', 'id="attention"', 'id="decision"', 'id="decision-history"']) {
      expect(CONTROLS_MARKUP).toContain(id);
    }
  });

  it("creates one command identity per form submission and suppresses duplicate dispatch while pending", () => {
    expect(CONTROLS_SCRIPT).toContain('if(form.dataset.submitting==="true")return');
    expect(CONTROLS_SCRIPT).toContain('form.dataset.submitting="true"');
    expect(CONTROLS_SCRIPT).toContain("pendingSubmissions.reserve(submission,UI_ACTOR)");
    expect(CONTROLS_SCRIPT).toContain("commandId:command.commandId");
    expect(CONTROLS_SCRIPT).toContain('delete form.dataset.submitting');
  });

  it("does not embed the AgentTrail evidence frame markup, which now lives in trail-section.ts", () => {
    expect(CONTROLS_MARKUP).not.toContain('id="agenttrail-frame"');
  });

  it("notifies the Overview section whenever the selected run changes", () => {
    expect(CONTROLS_SCRIPT).toContain("window.__consoleSections.overview?.render?.()");
  });
});
