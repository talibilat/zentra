import { describe, expect, it } from "vitest";

import { PODS_MARKUP, PODS_SCRIPT } from "../../../src/gateway/console/pods-section.js";

describe("pods section", () => {
  it("keeps a two-panel workspace with a list root and a detail root", () => {
    expect(PODS_MARKUP).toContain('id="pods-list"');
    expect(PODS_MARKUP).toContain('id="pod-detail"');
  });

  it("carries the data-screen-label the nav item's label must match", () => {
    expect(PODS_MARKUP).toContain('data-screen-label="Pods"');
  });

  it("fetches pods from the real API, not a static demo dataset", () => {
    expect(PODS_SCRIPT).toContain('request("/api/v1/zentra/pods")');
    expect(PODS_SCRIPT).not.toContain("DEMO_DATA");
  });

  it("registers a load hook and does not self-invoke at script load, unlike the static preview sections", () => {
    expect(PODS_SCRIPT).toContain("window.__consoleSections.pods={render:renderPods,load:loadPods}");
    expect(PODS_SCRIPT.trim().endsWith("load:loadPods};")).toBe(true);
  });

  it("never builds DOM with innerHTML", () => {
    expect(PODS_SCRIPT).not.toContain("innerHTML");
  });

  it("selects a pod on click and renders its detail from already-fetched data, with no per-pod fetch", () => {
    expect(PODS_SCRIPT).toContain('addEventListener("click"');
    expect(PODS_SCRIPT).not.toMatch(/request\([^)]*pods\/[^)]*podId/);
  });

  it("shows an honest empty state distinguishing no-pods from load-failure", () => {
    expect(PODS_SCRIPT).toContain("No pods yet.");
    expect(PODS_SCRIPT).toContain("Pods unavailable.");
  });
});
