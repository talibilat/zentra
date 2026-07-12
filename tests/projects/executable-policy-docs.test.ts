import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Trusted-Project MVP executable policy documentation", () => {
  it.each(["AGENTS.md", "README.md"])(
    "%s states the accepted authority model without claiming filesystem isolation",
    (relativePath) => {
      const documentation = readFileSync(path.join(root, relativePath), "utf8");

      expect(documentation).toContain("same operating-system authority");
      expect(documentation).toContain("not a filesystem sandbox");
      expect(documentation).toContain("Md Talib explicitly accepted");
      expect(documentation).toMatch(/hostile (repositories|or untrusted project configuration)/);
    },
  );
});
