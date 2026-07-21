import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildWriterPatchProposal,
  extractWriterPatchProposal,
  WriterPatchProposalSchema,
} from "../../src/contracts/writer-patch.js";

describe("writer patch proposal protocol", () => {
  it("accepts one bounded multi-file proposal through a native text event", () => {
    const proposal = buildWriterPatchProposal({ schemaVersion: 1, kind: "zentra.patch_proposal",
      proposalId: "proposal-1", baseRevision: "a".repeat(40), operations: [
        operation("src/a.ts", "before-a", "after-a"),
        operation("src/b.ts", null, "after-b"),
      ] });
    expect(extractWriterPatchProposal([
      { type: "text", part: { type: "text", text: JSON.stringify(proposal) } },
      { type: "step_finish", part: { tokens: { input: 1, output: 1 } } },
    ])).toEqual(proposal);
  });

  it("rejects multiple proposal artifacts and content digest substitution", () => {
    const proposal = buildWriterPatchProposal({ schemaVersion: 1, kind: "zentra.patch_proposal",
      proposalId: "proposal-1", baseRevision: "a".repeat(40),
      operations: [operation("src/a.ts", "before", "after")] });
    const event = { type: "text", part: { type: "text", text: JSON.stringify(proposal) } };
    expect(() => extractWriterPatchProposal([event, event])).toThrow(/exactly one/i);
    expect(() => WriterPatchProposalSchema.parse({ ...proposal, operations: [
      { ...proposal.operations[0]!, content: "substituted" },
    ] })).toThrow(/digest/i);
  });

  it.each(["../escape", ".git/config", "src/*/wildcard", "src/cafe\u0301.ts"])(
    "rejects unsafe concrete operation path %s", (candidate) => {
      expect(() => buildWriterPatchProposal({ schemaVersion: 1, kind: "zentra.patch_proposal",
        proposalId: "proposal-1", baseRevision: "a".repeat(40),
        operations: [operation(candidate, null, "content")] })).toThrow();
    });

  it.each([
    ["src/A.ts", "src/a.ts"],
    ["src/long-s.ts", "src/long-ſ.ts"],
    ["src/strasse.ts", "src/straße.ts"],
  ])("rejects Darwin-equivalent operation aliases %s and %s", (first, alias) => {
    expect(() => buildWriterPatchProposal({ schemaVersion: 1, kind: "zentra.patch_proposal",
      proposalId: "proposal-alias", baseRevision: "a".repeat(40),
      operations: [operation(first, null, "one"), operation(alias, null, "two")] }))
      .toThrow(/Darwin filesystem identity/i);
  });

  it("rejects NFC/NFD aliases before proposal intent", () => {
    expect(() => buildWriterPatchProposal({ schemaVersion: 1, kind: "zentra.patch_proposal",
      proposalId: "proposal-normalization", baseRevision: "a".repeat(40), operations: [
        operation("src/café.ts", null, "one"), operation("src/cafe\u0301.ts", null, "two"),
      ] })).toThrow();
  });

  it.each([
    ["src/module", "src/module/file.ts"],
    ["SRC/Module", "src/module/file.ts"],
    ["src/straße", "src/strasse/file.ts"],
  ])("rejects Darwin-canonical ancestor and descendant operations %s and %s", (ancestor, descendant) => {
    expect(() => buildWriterPatchProposal({ schemaVersion: 1, kind: "zentra.patch_proposal",
      proposalId: "proposal-prefix", baseRevision: "a".repeat(40), operations: [
        operation(ancestor, null, "one"), operation(descendant, null, "two"),
      ] })).toThrow(/ancestor|hierarch/i);
  });

  it("rejects proposal-controlled file mode", () => {
    const operationWithMode = { ...operation("src/a.ts", null, "content"), mode: 0o777 };
    expect(() => buildWriterPatchProposal({ schemaVersion: 1, kind: "zentra.patch_proposal",
      proposalId: "proposal-mode", baseRevision: "a".repeat(40),
      operations: [operationWithMode] })).toThrow();
  });
});

function operation(candidate: string, before: string | null, content: string) {
  return { path: candidate, expectedSha256: before === null ? null : digest(before),
    content, contentSha256: digest(content) };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
