// tests/gateway/console/console-ui.test.ts
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { consoleHtml, CONSOLE_SCRIPT_SHA256 } from "../../../src/gateway/console/console-ui.js";

describe("composed console document", () => {
  it("embeds a single inline script whose digest matches the exported CSP hash", () => {
    const html = consoleHtml();
    const match = /<script>([\s\S]*)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const digest = createHash("sha256").update(match![1]!, "utf8").digest("base64");
    expect(digest).toBe(CONSOLE_SCRIPT_SHA256);
  });

  it("includes every section's markup and preserves controls' DOM ids", () => {
    const html = consoleHtml();
    expect(html).toContain('id="goal-form"');
    expect(html).toContain('id="agenttrail-frame"');
    expect(html).toContain('id="overview-root"');
  });
});
