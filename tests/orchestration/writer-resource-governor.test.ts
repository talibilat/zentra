import { describe, expect, it } from "vitest";

import { WriterResourceGovernor } from "../../src/orchestration/writer-resource-governor.js";

const writer = (writerId: string, capabilityId = "model-a", maxConcurrency = 2) => ({
  writerId,
  capabilityId,
  capabilityDigest: `${capabilityId}-digest`,
  maxConcurrency,
});

describe("WriterResourceGovernor", () => {
  it("enforces global and pinned model capacity and releases idempotently", async () => {
    const governor = new WriterResourceGovernor(2);
    const first = await governor.acquire([writer("a"), writer("b")], new AbortController().signal);
    let entered = false;
    const waiting = governor.acquire([writer("c")], new AbortController().signal).then((permit) => {
      entered = true;
      return permit;
    });
    await Promise.resolve();
    expect(entered).toBe(false);

    first.release("a");
    first.release("a");
    const second = await waiting;
    expect(entered).toBe(true);
    second.release("c");
    first.release("b");
  });

  it("admits queued waves in FIFO order without partially acquiring a batch", async () => {
    const governor = new WriterResourceGovernor(2);
    const held = await governor.acquire([writer("held")], new AbortController().signal);
    const order: string[] = [];
    const large = governor.acquire([writer("a"), writer("b")], new AbortController().signal)
      .then((permit) => { order.push("large"); return permit; });
    const small = governor.acquire([writer("c")], new AbortController().signal)
      .then((permit) => { order.push("small"); return permit; });
    await Promise.resolve();
    expect(order).toEqual([]);

    held.release("held");
    const largePermit = await large;
    expect(order).toEqual(["large"]);
    largePermit.release("a");
    const smallPermit = await small;
    expect(order).toEqual(["large", "small"]);
    largePermit.release("b");
    smallPermit.release("c");
  });

  it("removes an aborted waiter and continues the queue", async () => {
    const governor = new WriterResourceGovernor(1);
    const held = await governor.acquire([writer("held", "model-a", 1)], new AbortController().signal);
    const abort = new AbortController();
    const cancelled = governor.acquire([writer("cancelled", "model-a", 1)], abort.signal);
    const next = governor.acquire([writer("next", "model-a", 1)], new AbortController().signal);
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    held.release("held");
    const permit = await next;
    permit.release("next");
  });

  it("rejects conflicting repeated capability metadata and impossible atomic waves", async () => {
    const governor = new WriterResourceGovernor(3);
    const permit = await governor.acquire([writer("a", "model-a", 1)], new AbortController().signal);
    permit.release("a");
    await expect(governor.acquire([
      { ...writer("b", "model-a", 2), capabilityDigest: "changed" },
    ], new AbortController().signal)).rejects.toThrow("conflicting capability metadata");
    await expect(governor.acquire([
      writer("c", "model-b", 1), writer("d", "model-b", 1),
    ], new AbortController().signal)).rejects.toThrow("exceeds pinned model capacity");
  });

  it("canonicalizes capability and writer aliases across concurrent acquisitions", async () => {
    const governor = new WriterResourceGovernor(2);
    const first = await governor.acquire([{
      ...writer("WRITER", "MODEL", 1), capabilityDigest: "same-capability",
    }], new AbortController().signal);
    let secondEntered = false;
    const second = governor.acquire([{
      ...writer("other", "model", 1), capabilityDigest: "same-capability",
    }], new AbortController().signal).then((permit) => { secondEntered = true; return permit; });
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    first.release("writer");
    (await second).release("OTHER");

    await expect(governor.acquire([{
      ...writer("third", "MoDeL", 1), capabilityDigest: "conflict",
    }], new AbortController().signal)).rejects.toThrow("conflicting capability metadata");
  });

  it("recovers and releases an exact retained claim", async () => {
    const governor = new WriterResourceGovernor(1);
    const request = writer("Writer", "Model", 1);
    await governor.acquire([request], new AbortController().signal);
    const recovered = governor.recover([{ ...request, writerId: "writer", capabilityId: "model" }]);
    recovered.release("WRITER");
    const next = await governor.acquire([{
      ...writer("next", "MODEL", 1), capabilityDigest: request.capabilityDigest,
    }], new AbortController().signal);
    next.release("next");
  });
});
