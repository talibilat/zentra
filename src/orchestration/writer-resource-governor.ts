export interface WriterResourceRequest {
  readonly writerId: string;
  readonly capabilityId: string;
  readonly capabilityDigest: string;
  readonly maxConcurrency: number;
}

export interface WriterResourcePermit {
  release(writerId: string): void;
}

interface PinnedCapability {
  readonly digest: string;
  readonly maxConcurrency: number;
}

interface Waiter {
  readonly requests: readonly WriterResourceRequest[];
  readonly signal: AbortSignal;
  readonly resolve: (permit: WriterResourcePermit) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

export class WriterResourceGovernor {
  private readonly capabilities = new Map<string, PinnedCapability>();
  private readonly activeWriters = new Map<string, string>();
  private readonly activeByCapability = new Map<string, number>();
  private readonly queue: Waiter[] = [];

  constructor(readonly maxConcurrentWriters: number) {
    if (!Number.isSafeInteger(maxConcurrentWriters) || maxConcurrentWriters <= 0) {
      throw new Error("maxConcurrentWriters must be a positive integer");
    }
  }

  acquire(
    requests: readonly WriterResourceRequest[],
    signal: AbortSignal,
  ): Promise<WriterResourcePermit> {
    try {
      this.validate(requests);
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        requests: canonicalRequests(requests),
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(abortError());
          this.drain();
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }

  recover(requests: readonly WriterResourceRequest[]): WriterResourcePermit {
    const canonical = canonicalRequests(requests);
    for (const request of canonical) {
      const activeCapability = this.activeWriters.get(request.writerId);
      if (activeCapability !== request.capabilityId || !this.matchesPinned(request)) {
        throw new Error(`writer resource claim cannot be recovered exactly: ${request.writerId}`);
      }
    }
    return this.permit(canonical);
  }

  recoverIfActive(requests: readonly WriterResourceRequest[]): WriterResourcePermit | null {
    const canonical = canonicalRequests(requests);
    const active = canonical.filter((request) => this.activeWriters.has(request.writerId));
    if (active.length === 0) return null;
    if (active.length !== canonical.length) {
      throw new Error("writer resource wave is only partially recoverable");
    }
    return this.recover(canonical);
  }

  release(request: WriterResourceRequest): boolean {
    const canonical = canonicalRequest(request);
    const capabilityId = this.activeWriters.get(canonical.writerId);
    if (capabilityId !== canonical.capabilityId || !this.matchesPinned(canonical)) return false;
    this.activeWriters.delete(canonical.writerId);
    const remaining = (this.activeByCapability.get(capabilityId) ?? 1) - 1;
    if (remaining === 0) this.activeByCapability.delete(capabilityId);
    else this.activeByCapability.set(capabilityId, remaining);
    this.drain();
    return true;
  }

  private validate(requests: readonly WriterResourceRequest[]): void {
    if (requests.length === 0) throw new Error("writer resource wave must not be empty");
    if (requests.length > this.maxConcurrentWriters) {
      throw new Error("writer resource wave exceeds global capacity");
    }
    const writerIds = new Set<string>();
    const waveCapabilities = new Map<string, PinnedCapability>();
    const counts = new Map<string, number>();
    for (const request of requests) {
      if (request.writerId === "" || request.capabilityId === "" || request.capabilityDigest === "") {
        throw new Error("writer resource identities must be nonempty");
      }
      if (!Number.isSafeInteger(request.maxConcurrency) || request.maxConcurrency <= 0) {
        throw new Error("model maxConcurrency must be a positive integer");
      }
      const writerId = darwinCanonical(request.writerId);
      const capabilityId = darwinCanonical(request.capabilityId);
      if (writerIds.has(writerId) || this.activeWriters.has(writerId) ||
        this.queue.some((waiter) => waiter.requests.some((queued) => queued.writerId === writerId))) {
        throw new Error(`writer resource identity is already active or waiting: ${request.writerId}`);
      }
      writerIds.add(writerId);
      const metadata = { digest: request.capabilityDigest, maxConcurrency: request.maxConcurrency };
      const pinned = this.capabilities.get(capabilityId) ?? waveCapabilities.get(capabilityId);
      if (pinned !== undefined &&
        (pinned.digest !== metadata.digest || pinned.maxConcurrency !== metadata.maxConcurrency)) {
        throw new Error(`conflicting capability metadata for ${request.capabilityId}`);
      }
      waveCapabilities.set(capabilityId, metadata);
      counts.set(capabilityId, (counts.get(capabilityId) ?? 0) + 1);
    }
    for (const [capabilityId, count] of counts) {
      if (count > waveCapabilities.get(capabilityId)!.maxConcurrency) {
        throw new Error(`writer resource wave exceeds pinned model capacity for ${capabilityId}`);
      }
    }
    for (const [capabilityId, metadata] of waveCapabilities) this.capabilities.set(capabilityId, metadata);
  }

  private drain(): void {
    const waiter = this.queue[0];
    if (waiter === undefined) return;
    if (waiter.signal.aborted) {
      this.queue.shift();
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(abortError());
      this.drain();
      return;
    }
    if (!this.canAcquire(waiter.requests)) return;
    this.queue.shift();
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    for (const request of waiter.requests) {
      this.activeWriters.set(request.writerId, request.capabilityId);
      this.activeByCapability.set(
        request.capabilityId,
        (this.activeByCapability.get(request.capabilityId) ?? 0) + 1,
      );
    }
    waiter.resolve(this.permit(waiter.requests));
    this.drain();
  }

  private canAcquire(requests: readonly WriterResourceRequest[]): boolean {
    if (this.activeWriters.size + requests.length > this.maxConcurrentWriters) return false;
    const additions = new Map<string, number>();
    for (const request of requests) {
      additions.set(request.capabilityId, (additions.get(request.capabilityId) ?? 0) + 1);
    }
    for (const [capabilityId, count] of additions) {
      const pinned = this.capabilities.get(capabilityId)!;
      if ((this.activeByCapability.get(capabilityId) ?? 0) + count > pinned.maxConcurrency) return false;
    }
    return true;
  }

  private permit(requests: readonly WriterResourceRequest[]): WriterResourcePermit {
    const owned = new Map(requests.map((request) => [request.writerId, request]));
    return Object.freeze({
      release: (writerId: string): void => {
        const request = owned.get(darwinCanonical(writerId));
        if (request === undefined) return;
        owned.delete(request.writerId);
        this.release(request);
      },
    });
  }

  private matchesPinned(request: WriterResourceRequest): boolean {
    const pinned = this.capabilities.get(request.capabilityId);
    return pinned?.digest === request.capabilityDigest && pinned.maxConcurrency === request.maxConcurrency;
  }
}

function canonicalRequests(requests: readonly WriterResourceRequest[]): readonly WriterResourceRequest[] {
  return Object.freeze(requests.map(canonicalRequest));
}

function canonicalRequest(request: WriterResourceRequest): WriterResourceRequest {
  return Object.freeze({
    ...request,
    writerId: darwinCanonical(request.writerId),
    capabilityId: darwinCanonical(request.capabilityId),
  });
}

function darwinCanonical(value: string): string {
  return value.normalize("NFD").toLocaleLowerCase("en-US");
}

function abortError(): Error {
  return new DOMException("writer resource wait was aborted", "AbortError");
}
