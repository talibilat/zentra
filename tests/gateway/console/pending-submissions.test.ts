import { describe, expect, it } from "vitest";

import {
  BrowserPendingSubmissionCommands,
  isProvenPreEffectBrowserSubmissionError,
} from "../../../src/gateway/console/pending-submissions.js";

describe("browser pending submission tracking", () => {
  it("keys pending identities by canonical submission and actor while bounding unresolved entries", () => {
    let next = 0;
    const pending = new BrowserPendingSubmissionCommands(() => `command-${++next}`);
    const actor = { actorId: "zentra-local-operator", channel: "ui" };
    const original = pending.reserve({ kind: "inline_goal", goal: "Original" }, actor);

    expect(pending.reserve({ goal: "Original", kind: "inline_goal" }, actor)).toEqual(original);
    expect(pending.reserve({ kind: "inline_goal", goal: "Edited" }, actor).commandId).not.toBe(original.commandId);
    expect(pending.reserve({ kind: "inline_goal", goal: "Original" }, { ...actor, actorId: "other" }).commandId)
      .not.toBe(original.commandId);
    expect(pending.size).toBe(3);
    for (let index = 0; index < 29; index++) pending.reserve({ kind: "inline_goal", goal: `Bounded ${index}` }, actor);
    expect(() => pending.reserve({ kind: "inline_goal", goal: "One too many" }, actor)).toThrow("pending_submission_limit");
    expect(() => new BrowserPendingSubmissionCommands(() => "unused").reserve(
      { kind: "inline_goal", goal: "x".repeat(25 * 1024) }, actor,
    )).toThrow("pending_submission_key_too_large");
  });

  it("classifies only typed pre-effect validation and digest failures as safe to clear", () => {
    expect(isProvenPreEffectBrowserSubmissionError("invalid_transition")).toBe(true);
    expect(isProvenPreEffectBrowserSubmissionError("digest_mismatch")).toBe(true);
    expect(isProvenPreEffectBrowserSubmissionError("internal")).toBe(false);
    expect(isProvenPreEffectBrowserSubmissionError("unavailable")).toBe(false);
    expect(isProvenPreEffectBrowserSubmissionError("uncertain")).toBe(false);
  });
});
