import { describe, expect, it } from "vitest";

import { roleModelSupports, roleToolPermissions } from "../../src/workers/role-capability-envelope.js";

function implementer(harness: string) {
  return {
    harness,
    roles: ["implementer"],
    toolPermissions: [...roleToolPermissions("implementer")],
    network: "denied",
  };
}

describe("roleModelSupports expected harness", () => {
  it("accepts a model whose harness matches the expectation", () => {
    expect(roleModelSupports("implementer", implementer("opencode"), "opencode")).toBe(true);
    expect(roleModelSupports("implementer", implementer("claude_code"), "claude_code")).toBe(true);
  });

  it("rejects a model whose harness differs from the expectation", () => {
    expect(roleModelSupports("implementer", implementer("claude_code"), "opencode")).toBe(false);
    expect(roleModelSupports("implementer", implementer("opencode"), "claude_code")).toBe(false);
  });

  it("still enforces the non-harness policy when the harness matches", () => {
    const wrongRole = { ...implementer("opencode"), roles: ["reviewer"] };
    expect(roleModelSupports("implementer", wrongRole, "opencode")).toBe(false);
  });
});
