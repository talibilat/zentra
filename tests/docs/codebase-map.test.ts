import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const htmlPath = path.join(root, "docs/codebase-map.html");

function repositoryModules(directory: string): string[] {
  const absolute = path.join(root, directory);
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe("codebase map", () => {
  it("is self-contained and covers every executable repository module", () => {
    const html = readFileSync(htmlPath, "utf8");
    const inventoryMatch = html.match(
      /<script id="codebase-inventory" type="application\/json">([^<]+)<\/script>/,
    );

    expect(html).toContain("<title>Zentra Codebase Atlas</title>");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="function-tooltip"');
    expect(html).toContain('id="function-graph"');
    expect(html).toContain('id="hierarchy"');
    expect(html).toContain("prefers-reduced-motion");
    expect(html).not.toMatch(/<(?:script|link|img|iframe)[^>]+(?:src|href)=["']https?:/i);
    expect(inventoryMatch).not.toBeNull();

    const inventory = JSON.parse(inventoryMatch![1]!) as {
      modules: Array<{ path: string }>;
      features: Array<{ id: string }>;
      edges: Array<{ from: string; to: string }>;
    };
    const mappedPaths = inventory.modules.map((module) => module.path).sort();
    const expectedPaths = [
      ...repositoryModules("src"),
      ...repositoryModules("scripts"),
      ...repositoryModules("fixtures"),
      ...repositoryModules("tests"),
    ].sort();

    expect(mappedPaths).toEqual(expectedPaths);
    expect(new Set(inventory.features.map((feature) => feature.id)).size).toBe(
      inventory.features.length,
    );

    const moduleIds = new Set(inventory.modules.map((module) => module.path));
    for (const edge of inventory.edges) {
      expect(moduleIds.has(edge.from), `unknown edge source ${edge.from}`).toBe(true);
      expect(moduleIds.has(edge.to), `unknown edge target ${edge.to}`).toBe(true);
    }
  });

  it("matches a fresh deterministic generation", () => {
    const current = readFileSync(htmlPath, "utf8");
    const generated = execFileSync(
      process.execPath,
      ["scripts/generate-codebase-map.mjs", "--stdout"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1_048_576 },
    );

    expect(current).toBe(generated);
  });
});
