export interface AcpRendererObservationOwner<Sender> {
  readonly sender: Sender;
  readonly release: () => void;
  readonly threadCounts: Map<string, number>;
}

export interface AcpRendererObservationChanges {
  readonly observedThreadIds: readonly string[];
  readonly unobservedThreadIds: readonly string[];
}

export interface AcpRendererObservationRegistryOptions {
  readonly maxOwners?: number;
  readonly maxObservedThreads?: number;
  readonly maxLeasesPerOwner?: number;
}

export const DEFAULT_ACP_RENDERER_OBSERVATION_MAX_OWNERS = 16;
export const DEFAULT_ACP_RENDERER_OBSERVATION_MAX_THREADS = 128;
export const DEFAULT_ACP_RENDERER_OBSERVATION_MAX_LEASES_PER_OWNER = 256;

const noChanges = (): AcpRendererObservationChanges => ({
  observedThreadIds: [],
  unobservedThreadIds: [],
});

/** Owns per-renderer, per-Thread observation leases without collapsing split views. */
export class AcpRendererObservationRegistry<Sender> {
  readonly #owners = new Map<number, AcpRendererObservationOwner<Sender>>();
  readonly #threadCounts = new Map<string, number>();
  readonly #maxOwners: number;
  readonly #maxObservedThreads: number;
  readonly #maxLeasesPerOwner: number;

  constructor(options: AcpRendererObservationRegistryOptions = {}) {
    this.#maxOwners = Math.max(
      1,
      Math.floor(options.maxOwners ?? DEFAULT_ACP_RENDERER_OBSERVATION_MAX_OWNERS),
    );
    this.#maxObservedThreads = Math.max(
      1,
      Math.floor(options.maxObservedThreads ?? DEFAULT_ACP_RENDERER_OBSERVATION_MAX_THREADS),
    );
    this.#maxLeasesPerOwner = Math.max(
      1,
      Math.floor(
        options.maxLeasesPerOwner ?? DEFAULT_ACP_RENDERER_OBSERVATION_MAX_LEASES_PER_OWNER,
      ),
    );
  }

  #leaseCount(owner: AcpRendererObservationOwner<Sender>): number {
    let count = 0;
    for (const value of owner.threadCounts.values()) count += value;
    return count;
  }

  #removeOwner(ownerId: number): AcpRendererObservationChanges {
    const owner = this.#owners.get(ownerId);
    if (!owner) return noChanges();
    this.#owners.delete(ownerId);
    const unobservedThreadIds: string[] = [];
    for (const [threadId, count] of owner.threadCounts) {
      const remaining = (this.#threadCounts.get(threadId) ?? 0) - count;
      if (remaining > 0) {
        this.#threadCounts.set(threadId, remaining);
      } else {
        this.#threadCounts.delete(threadId);
        unobservedThreadIds.push(threadId);
      }
    }
    owner.release();
    return { observedThreadIds: [], unobservedThreadIds };
  }

  observe(
    ownerId: number,
    sender: Sender,
    threadId: string,
    release: () => void,
  ): AcpRendererObservationChanges {
    let owner = this.#owners.get(ownerId);
    let unobservedThreadIds: readonly string[] = [];
    if (!owner) {
      if (this.#owners.size >= this.#maxOwners) {
        release();
        throw new RangeError(`ACP renderer observation owner limit (${this.#maxOwners}) exceeded`);
      }
      if (
        !this.#threadCounts.has(threadId) &&
        this.#threadCounts.size >= this.#maxObservedThreads
      ) {
        release();
        throw new RangeError(
          `ACP renderer observed Thread limit (${this.#maxObservedThreads}) exceeded`,
        );
      }
      owner = { sender, release, threadCounts: new Map() };
      this.#owners.set(ownerId, owner);
    } else if (owner.sender !== sender) {
      const oldOnlyThreadCount = [...owner.threadCounts].filter(
        ([ownedThreadId, count]) => (this.#threadCounts.get(ownedThreadId) ?? 0) === count,
      ).length;
      const targetRemainingCount =
        (this.#threadCounts.get(threadId) ?? 0) - (owner.threadCounts.get(threadId) ?? 0);
      const prospectiveThreadCount =
        this.#threadCounts.size - oldOnlyThreadCount + (targetRemainingCount > 0 ? 0 : 1);
      if (prospectiveThreadCount > this.#maxObservedThreads) {
        release();
        throw new RangeError(
          `ACP renderer observed Thread limit (${this.#maxObservedThreads}) exceeded`,
        );
      }
      unobservedThreadIds = this.#removeOwner(ownerId).unobservedThreadIds;
      owner = { sender, release, threadCounts: new Map() };
      this.#owners.set(ownerId, owner);
    } else {
      release();
    }

    if (this.#leaseCount(owner) >= this.#maxLeasesPerOwner) {
      throw new RangeError(
        `ACP renderer observation lease limit (${this.#maxLeasesPerOwner}) exceeded`,
      );
    }
    const wasObserved = this.#threadCounts.has(threadId);
    if (!wasObserved && this.#threadCounts.size >= this.#maxObservedThreads) {
      throw new RangeError(
        `ACP renderer observed Thread limit (${this.#maxObservedThreads}) exceeded`,
      );
    }
    owner.threadCounts.set(threadId, (owner.threadCounts.get(threadId) ?? 0) + 1);
    this.#threadCounts.set(threadId, (this.#threadCounts.get(threadId) ?? 0) + 1);
    return {
      observedThreadIds: wasObserved ? [] : [threadId],
      unobservedThreadIds,
    };
  }

  unobserve(ownerId: number, threadId: string): AcpRendererObservationChanges {
    const owner = this.#owners.get(ownerId);
    if (!owner) return noChanges();
    const count = owner.threadCounts.get(threadId) ?? 0;
    if (count === 0) return noChanges();
    if (count > 1) {
      owner.threadCounts.set(threadId, count - 1);
    } else {
      owner.threadCounts.delete(threadId);
    }
    const globalCount = (this.#threadCounts.get(threadId) ?? 0) - 1;
    if (globalCount > 0) this.#threadCounts.set(threadId, globalCount);
    else this.#threadCounts.delete(threadId);
    if (owner.threadCounts.size === 0) {
      this.#owners.delete(ownerId);
      owner.release();
    }
    return {
      observedThreadIds: [],
      unobservedThreadIds: globalCount > 0 ? [] : [threadId],
    };
  }

  matching(threadId: string): readonly (readonly [ownerId: number, sender: Sender])[] {
    return [...this.#owners].flatMap(([ownerId, owner]) =>
      owner.threadCounts.has(threadId) ? ([[ownerId, owner.sender]] as const) : [],
    );
  }

  release(ownerId: number): AcpRendererObservationChanges {
    return this.#removeOwner(ownerId);
  }

  close(): AcpRendererObservationChanges {
    const unobservedThreadIds: string[] = [];
    for (const ownerId of [...this.#owners.keys()]) {
      unobservedThreadIds.push(...this.release(ownerId).unobservedThreadIds);
    }
    return { observedThreadIds: [], unobservedThreadIds };
  }
}
