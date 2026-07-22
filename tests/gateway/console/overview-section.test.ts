import { describe, expect, it } from "vitest";

import { OVERVIEW_MARKUP } from "../../../src/gateway/console/overview-section.js";

describe("overview section", () => {
  it("declares its content region for the shell to mount into", () => {
    expect(OVERVIEW_MARKUP).toContain('data-screen-label="Overview"');
    expect(OVERVIEW_MARKUP).toContain('id="overview-root"');
  });
});
