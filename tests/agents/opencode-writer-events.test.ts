import { describe, expect, it } from "vitest";

import {
  createOpenCodeWriterEventChain,
  OpenCodeWriterEventChainSchema,
} from "../../src/agents/opencode-writer-events.js";

describe("OpenCode writer event evidence", () => {
  it("retains ordered native event metadata anchored to the final stdout digest without raw output", () => {
    const events = [{ type: "step_start" }, { type: "tool", tool: "read", status: "completed" }, { type: "step_finish" }];
    const stdout = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const chain = createOpenCodeWriterEventChain(stdout, events);

    expect(chain.rawOutputPolicy).toBe("not_retained");
    expect(chain.events.map((event) => [event.sequence, event.type, event.tool])).toEqual([
      [0, "step_start", null], [1, "tool", "read"], [2, "step_finish", null],
    ]);
    expect(JSON.stringify(chain)).not.toContain(stdout);
    expect(chain.events.at(-1)?.prefixSha256).toBe(chain.stdoutSha256);
  });

  it("rejects event removal, reordering, and digest substitution", () => {
    const events = [{ type: "step_start" }, { type: "step_finish" }];
    const chain = createOpenCodeWriterEventChain(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, events);
    expect(() => OpenCodeWriterEventChainSchema.parse({ ...chain, events: chain.events.slice(1) })).toThrow();
    expect(() => OpenCodeWriterEventChainSchema.parse({ ...chain, events: [...chain.events].reverse() })).toThrow();
    expect(() => OpenCodeWriterEventChainSchema.parse({ ...chain, stdoutSha256: "0".repeat(64) })).toThrow();
  });
});
