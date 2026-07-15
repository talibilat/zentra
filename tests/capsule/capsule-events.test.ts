import { describe, expect, it } from "vitest";

import { parseCapsuleEventPayload } from "../../src/capsule/capsule-events.js";
import { proxyAddon } from "../../src/capsule/docker-capsule.js";

describe("capsule event payload admission", () => {
  it("accepts the bounded proxy observation shape", () => {
    expect(parseCapsuleEventPayload("capsule.proxy_interaction_observed", {
      scheme: "https", method: "GET", host: "example.com", allowed: true, reason: "configured_read",
    })).toEqual({ scheme: "https", method: "GET", host: "example.com", allowed: true, reason: "configured_read" });
  });

  it("keeps fail-closed raw TCP hooks in the generated proxy", () => {
    const source = proxyAddon();
    expect(source).toContain("def tcp_start");
    expect(source).toContain("def tcp_message");
    expect(source).toContain("flow.kill()");
    expect(source).toContain("raw_tcp_denied");
  });

  it("rejects headers, URLs, credential handles, tokens, and unknown event types", () => {
    for (const payload of [
      { scheme: "https", method: "GET", host: "example.com", allowed: true, reason: "configured_read", headers: { authorization: "secret" } },
      { scheme: "https", method: "GET", host: "example.com/path?token=x", allowed: true, reason: "configured_read" },
      { scheme: "https", method: "GET", host: "example.com", allowed: true, reason: "configured_read", credentialHandle: "keychain:x" },
    ]) expect(() => parseCapsuleEventPayload("capsule.proxy_interaction_observed", payload)).toThrow();
    expect(() => parseCapsuleEventPayload("capsule.raw_output", { token: "secret" })).toThrow();
  });
});
