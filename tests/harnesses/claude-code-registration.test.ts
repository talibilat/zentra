import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DisabledModelBroker } from "../../src/capsule/model-broker.js";
import { ClaudeCodeWriter } from "../../src/harnesses/claude-code-writer.js";
import { UnregisteredHarnessWriterError } from "../../src/harnesses/harness-writer-registry.js";
import type { HarnessWriterRegistry } from "../../src/harnesses/harness-writer-registry.js";
import { OpenCodeWriter } from "../../src/harnesses/opencode-writer.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
import { InstalledMilestoneRunner } from "../../src/orchestration/installed-milestone.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function defaultRegistry(): HarnessWriterRegistry {
  const directory = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-claude-code-registration-")));
  directories.push(directory);
  const database = path.join(directory, "journal.sqlite");
  const trace = path.join(directory, "trace.jsonl");
  const journal = new SqliteEventJournal(database);
  const sink = AgentTailJsonlFileSink.open(directory, trace, "claude-code-registration");
  const runner = new InstalledMilestoneRunner({ journal, sink, broker: new DisabledModelBroker() });
  // The registry is intentionally private on InstalledMilestoneRunner; this test
  // reaches in to confirm the default construction wires claude_code up without
  // paying for a full milestone run.
  return (runner as unknown as { writers: HarnessWriterRegistry }).writers;
}

describe("default harness writer registration", () => {
  it("resolves claude_code as an instance of ClaudeCodeWriter", () => {
    const registry = defaultRegistry();
    const writer = registry.get("claude_code");
    expect(writer).toBeInstanceOf(ClaudeCodeWriter);
  });

  it("resolves opencode as an instance of OpenCodeWriter", () => {
    const registry = defaultRegistry();
    const writer = registry.get("opencode");
    expect(writer).toBeInstanceOf(OpenCodeWriter);
  });
});
