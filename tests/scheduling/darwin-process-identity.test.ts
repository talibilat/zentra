import { describe, expect, it } from "vitest";

import { classifyDarwinProcessIdentity, inspectDarwinProcessStartIdentity } from "../../src/runtime/darwin-process-identity.js";

describe("Darwin process start identity", () => {
  it("distinguishes a live incarnation from PID reuse", () => {
    const current = inspectDarwinProcessStartIdentity(process.pid);
    expect(current).toMatch(/^darwin-ps-v1:[a-f0-9]{64}$/);
    expect(classifyDarwinProcessIdentity(process.pid, current!)).toBe("alive");
    expect(classifyDarwinProcessIdentity(process.pid, `darwin-ps-v1:${"0".repeat(64)}`)).toBe("replaced");
  });
});
