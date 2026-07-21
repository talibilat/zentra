import { describe, expect, it } from "vitest";

import { logicalPathScopesOverlap } from "../../src/milestones/path-ownership.js";

describe("logicalPathScopesOverlap", () => {
  it.each([
    ["src/file.ts", "src/file.ts"],
    ["src", "src/file.ts"],
    ["src/**", "src/file.ts"],
    ["**", "any/file.ts"],
    ["SRC/File.ts", "src/file.ts"],
    ["cafe\u0301/file.ts", "caf\u00e9/file.ts"],
    ["src/long-s.ts", "src/long-ſ.ts"],
    ["src/strasse.ts", "src/straße.ts"],
  ])("conservatively overlaps %j and %j on Darwin", (first, second) => {
    expect(logicalPathScopesOverlap(first, second)).toBe(true);
  });

  it.each([
    ["src/a.ts", "src/b.ts"],
    ["src/**", "tests/a.ts"],
    ["source/a.ts", "src/a.ts"],
  ])("keeps independent scopes %j and %j separate", (first, second) => {
    expect(logicalPathScopesOverlap(first, second)).toBe(false);
  });
});
