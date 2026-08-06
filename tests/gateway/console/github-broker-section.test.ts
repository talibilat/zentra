import { describe, expect, it } from "vitest";

import { GITHUB_BROKER_MARKUP, GITHUB_BROKER_SCRIPT } from "../../../src/gateway/console/github-broker-section.js";

describe("github broker section", () => {
  it("keeps a two-panel workspace with a list root and a detail root", () => {
    expect(GITHUB_BROKER_MARKUP).toContain('id="github-broker-list"');
    expect(GITHUB_BROKER_MARKUP).toContain('id="github-broker-detail"');
  });

  it("reuses the shared two-column workspace variant", () => {
    expect(GITHUB_BROKER_MARKUP).toContain('data-columns="2"');
  });

  it("carries the data-screen-label the nav item's label must match", () => {
    expect(GITHUB_BROKER_MARKUP).toContain('data-screen-label="GitHub broker"');
  });

  it("fetches activity from the real API, not a static demo dataset", () => {
    expect(GITHUB_BROKER_SCRIPT).toContain('request("/api/v1/zentra/github-broker")');
    expect(GITHUB_BROKER_SCRIPT).not.toContain("DEMO_DATA");
  });

  it("registers a load hook and does not self-invoke at script load", () => {
    expect(GITHUB_BROKER_SCRIPT).toContain("window.__consoleSections.github={render:renderGitHubBroker,load:loadGitHubBrokerActivity}");
    expect(GITHUB_BROKER_SCRIPT.trim().endsWith("load:loadGitHubBrokerActivity};")).toBe(true);
  });

  it("never builds DOM with innerHTML", () => {
    expect(GITHUB_BROKER_SCRIPT).not.toContain("innerHTML");
  });

  it("selects an activity entry on click without a second network fetch", () => {
    expect(GITHUB_BROKER_SCRIPT).toContain('addEventListener("click"');
    const requestCalls = GITHUB_BROKER_SCRIPT.match(/request\(/g) ?? [];
    expect(requestCalls.length).toBe(1);
  });

  it("shows an honest empty state", () => {
    expect(GITHUB_BROKER_SCRIPT).toContain("No GitHub broker activity yet.");
    expect(GITHUB_BROKER_SCRIPT).toContain("GitHub broker activity unavailable.");
  });

  it("curates operation-specific detail fields for both push and pull request", () => {
    expect(GITHUB_BROKER_SCRIPT).toContain("Target ref");
    expect(GITHUB_BROKER_SCRIPT).toContain("Head ref");
    expect(GITHUB_BROKER_SCRIPT).toContain("Draft");
  });
});
