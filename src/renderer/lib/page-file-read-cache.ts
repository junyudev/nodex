import type { LibraryPageFileSummary } from "../../shared/library-module";
import type { PageFileBytes } from "../../shared/page-files";
import { contentAccessContextKey } from "../../shared/content-access-context";
import type { PageFileAuthority } from "./page-file-resources";

export interface PageFileReadCacheDependencies {
  readonly readMetadata: (
    authority: PageFileAuthority,
    fileId: string,
  ) => Promise<LibraryPageFileSummary>;
  readonly readBytes: (authority: PageFileAuthority, fileId: string) => Promise<PageFileBytes>;
  readonly createObjectUrl: (file: PageFileBytes) => string;
  readonly revokeObjectUrl: (url: string) => void;
}

export interface PageFileReadDemand {
  readonly metadata?: boolean;
  readonly content?: boolean;
  readonly objectUrl?: boolean;
}

export interface PageFileReadInvalidation {
  /** Refresh preserves an authorized stale value; revoke removes it before revalidation. */
  readonly mode: "refresh" | "revoke";
  /** `null` is the generated reset variant for the containing Page scope. */
  readonly fileIds: readonly string[] | null;
  readonly metadata: boolean;
  readonly content: boolean;
}

export interface PageFileReadSnapshot {
  readonly metadata: LibraryPageFileSummary | null;
  readonly bytes: PageFileBytes | null;
  readonly objectUrl: string | null;
  readonly metadataLoading: boolean;
  readonly contentLoading: boolean;
  readonly metadataRefreshing: boolean;
  readonly contentRefreshing: boolean;
  readonly metadataError: string | null;
  readonly contentError: string | null;
}

export interface PageFileReadScope {
  readonly authority: PageFileAuthority;
  readMetadata(fileId: string): Promise<LibraryPageFileSummary>;
  readBytes(fileId: string): Promise<PageFileBytes>;
  readObjectUrl(fileId: string): Promise<string>;
  preload(fileId: string, demand: PageFileReadDemand): void;
  snapshot(fileId: string): PageFileReadSnapshot;
  subscribe(fileId: string, demand: PageFileReadDemand, listener: () => void): () => void;
  invalidate(invalidation: PageFileReadInvalidation): void;
  release(): void;
}

interface PageFileReadSubscription {
  readonly listener: () => void;
  readonly metadata: boolean;
  readonly content: boolean;
  readonly objectUrl: boolean;
}

interface PageFileReadEntry {
  readonly scopeKey: string;
  readonly fileId: string;
  readonly authority: PageFileAuthority;
  readonly listeners: Set<PageFileReadSubscription>;
  metadata: LibraryPageFileSummary | null;
  bytes: PageFileBytes | null;
  objectUrl: string | null;
  metadataError: string | null;
  contentError: string | null;
  metadataStale: boolean;
  contentStale: boolean;
  contentEtag: string | null;
  metadataGeneration: number;
  contentGeneration: number;
  metadataConsumers: number;
  contentConsumers: number;
  objectUrlConsumers: number;
  metadataInFlight: Promise<LibraryPageFileSummary> | null;
  contentInFlight: Promise<PageFileBytes> | null;
  disposed: boolean;
  snapshot: PageFileReadSnapshot;
}

interface PageFileReadScopeState {
  readonly authority: PageFileAuthority;
  readonly entryKeys: Set<string>;
  leases: number;
}

export const EMPTY_PAGE_FILE_READ_SNAPSHOT: PageFileReadSnapshot = Object.freeze({
  metadata: null,
  bytes: null,
  objectUrl: null,
  metadataLoading: false,
  contentLoading: false,
  metadataRefreshing: false,
  contentRefreshing: false,
  metadataError: null,
  contentError: null,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Page File read failed";

const scopeKeyFor = (authority: PageFileAuthority): string =>
  JSON.stringify([
    authority.storeEpoch,
    contentAccessContextKey(authority.contentAccessContext),
    authority.pageId,
  ]);

const entryKeyFor = (scopeKey: string, fileId: string): string =>
  JSON.stringify([scopeKey, fileId]);

/**
 * Shares current Page File presentation across every placement in one authorized
 * renderer scope. Callers address stable File identities; request coalescing,
 * stale presentation, exact invalidation, and object-URL ownership stay inside.
 *
 * Retention is deliberately active-only instead of a process-wide LRU: raw
 * bytes exist only for an active content subscriber or an in-flight caller,
 * and object URLs exist only for active image subscribers. This makes memory
 * proportional to presentation the editor is actually keeping alive, while
 * final scope release remains the deterministic backstop.
 */
export class PageFileReadCache {
  readonly #dependencies: PageFileReadCacheDependencies;
  readonly #scopes = new Map<string, PageFileReadScopeState>();
  readonly #entries = new Map<string, PageFileReadEntry>();

  constructor(dependencies: PageFileReadCacheDependencies) {
    this.#dependencies = dependencies;
  }

  acquire(authority: PageFileAuthority): PageFileReadScope {
    const scopeKey = scopeKeyFor(authority);
    const state = this.#scopes.get(scopeKey) ?? {
      authority,
      entryKeys: new Set<string>(),
      leases: 0,
    };
    state.leases += 1;
    this.#scopes.set(scopeKey, state);
    let released = false;
    const ownedSubscriptions = new Set<() => void>();

    const entry = (fileId: string): PageFileReadEntry => {
      if (released) throw new Error("Page File read scope is released");
      return this.#entryFor(scopeKey, state, fileId);
    };

    return {
      authority,
      readMetadata: (fileId) => this.#readMetadata(entry(fileId)),
      readBytes: (fileId) => this.#readBytes(entry(fileId)),
      readObjectUrl: (fileId) => this.#readObjectUrl(entry(fileId)),
      preload: (fileId, demand) => this.#preload(entry(fileId), demand),
      snapshot: (fileId) => this.#snapshotFor(scopeKey, fileId),
      subscribe: (fileId, demand, listener) => {
        const metadata = demand.metadata === true;
        const content = demand.content === true;
        const objectUrl = demand.objectUrl === true;
        if (!metadata && !content && !objectUrl) return () => undefined;
        const current = entry(fileId);
        const subscription = { listener, metadata, content, objectUrl };
        current.listeners.add(subscription);
        if (metadata) current.metadataConsumers += 1;
        if (content) current.contentConsumers += 1;
        if (objectUrl) current.objectUrlConsumers += 1;
        let subscribed = true;
        const unsubscribe = () => {
          if (!subscribed) return;
          subscribed = false;
          current.listeners.delete(subscription);
          if (metadata) current.metadataConsumers -= 1;
          if (content) current.contentConsumers -= 1;
          if (objectUrl) current.objectUrlConsumers -= 1;
          ownedSubscriptions.delete(unsubscribe);
          this.#trimInactive(current);
        };
        ownedSubscriptions.add(unsubscribe);
        return unsubscribe;
      },
      invalidate: (invalidation) => {
        if (released) return;
        this.#invalidate(scopeKey, state, invalidation);
      },
      release: () => {
        if (released) return;
        released = true;
        for (const unsubscribe of [...ownedSubscriptions]) unsubscribe();
        this.#releaseScope(scopeKey, state);
      },
    };
  }

  #entryFor(scopeKey: string, scope: PageFileReadScopeState, fileId: string): PageFileReadEntry {
    const normalizedFileId = fileId.trim();
    if (!normalizedFileId) throw new Error("Page File identity is required");
    const key = entryKeyFor(scopeKey, normalizedFileId);
    const existing = this.#entries.get(key);
    if (existing) return existing;

    const created: PageFileReadEntry = {
      scopeKey,
      fileId: normalizedFileId,
      authority: scope.authority,
      listeners: new Set(),
      metadata: null,
      bytes: null,
      objectUrl: null,
      metadataError: null,
      contentError: null,
      metadataStale: true,
      contentStale: true,
      contentEtag: null,
      metadataGeneration: 0,
      contentGeneration: 0,
      metadataConsumers: 0,
      contentConsumers: 0,
      objectUrlConsumers: 0,
      metadataInFlight: null,
      contentInFlight: null,
      disposed: false,
      snapshot: EMPTY_PAGE_FILE_READ_SNAPSHOT,
    };
    this.#entries.set(key, created);
    scope.entryKeys.add(key);
    return created;
  }

  #snapshotFor(scopeKey: string, fileId: string): PageFileReadSnapshot {
    const normalizedFileId = fileId.trim();
    if (!normalizedFileId) throw new Error("Page File identity is required");
    return (
      this.#entries.get(entryKeyFor(scopeKey, normalizedFileId))?.snapshot ??
      EMPTY_PAGE_FILE_READ_SNAPSHOT
    );
  }

  #preload(entry: PageFileReadEntry, demand: PageFileReadDemand): void {
    if (demand.metadata) void this.#readMetadata(entry).catch(() => undefined);
    if (demand.objectUrl) {
      void this.#readObjectUrl(entry).catch(() => undefined);
      return;
    }
    if (demand.content) void this.#readBytes(entry).catch(() => undefined);
  }

  #readMetadata(entry: PageFileReadEntry): Promise<LibraryPageFileSummary> {
    if (entry.metadata && !entry.metadataStale) return Promise.resolve(entry.metadata);
    if (entry.metadataError && !entry.metadataStale) {
      return Promise.reject(new Error(entry.metadataError));
    }
    if (entry.metadataInFlight) return entry.metadataInFlight;

    const generation = entry.metadataGeneration;
    let request!: Promise<LibraryPageFileSummary>;
    request = (async (): Promise<LibraryPageFileSummary> => {
      try {
        const metadata = await this.#dependencies.readMetadata(entry.authority, entry.fileId);
        if (entry.disposed) throw new Error("Page File read scope was released");
        if (generation !== entry.metadataGeneration) {
          if (entry.metadataInFlight === request) entry.metadataInFlight = null;
          return await this.#readMetadata(entry);
        }
        entry.metadata = metadata;
        entry.metadataStale = false;
        entry.metadataError = null;
        return metadata;
      } catch (error) {
        if (!entry.disposed && generation !== entry.metadataGeneration) {
          if (entry.metadataInFlight === request) entry.metadataInFlight = null;
          return await this.#readMetadata(entry);
        }
        if (!entry.disposed && generation === entry.metadataGeneration) {
          entry.metadataError = errorMessage(error);
          if (!entry.metadata) entry.metadataStale = false;
        }
        throw error;
      } finally {
        if (entry.metadataInFlight === request) entry.metadataInFlight = null;
        if (!entry.disposed) this.#trimInactive(entry);
      }
    })();
    entry.metadataInFlight = request;
    this.#publish(entry);
    return request;
  }

  #readBytes(entry: PageFileReadEntry): Promise<PageFileBytes> {
    if (entry.bytes && !entry.contentStale) return Promise.resolve(entry.bytes);
    if (entry.contentError && !entry.contentStale) {
      return Promise.reject(new Error(entry.contentError));
    }
    if (entry.contentInFlight) return entry.contentInFlight;

    const generation = entry.contentGeneration;
    let request!: Promise<PageFileBytes>;
    request = (async (): Promise<PageFileBytes> => {
      try {
        const bytes = await this.#dependencies.readBytes(entry.authority, entry.fileId);
        if (entry.disposed) throw new Error("Page File read scope was released");
        if (generation !== entry.contentGeneration) {
          if (entry.contentInFlight === request) entry.contentInFlight = null;
          return await this.#readBytes(entry);
        }
        const previousUrl = entry.objectUrl;
        const objectUrlChanged =
          entry.objectUrlConsumers > 0 && (!previousUrl || entry.contentEtag !== bytes.etag);
        const nextUrl = objectUrlChanged ? this.#dependencies.createObjectUrl(bytes) : previousUrl;
        entry.bytes = bytes;
        entry.objectUrl = nextUrl;
        entry.contentEtag = bytes.etag;
        entry.contentStale = false;
        entry.contentError = null;
        if (objectUrlChanged && previousUrl && previousUrl !== nextUrl) {
          this.#dependencies.revokeObjectUrl(previousUrl);
        }
        return bytes;
      } catch (error) {
        if (!entry.disposed && generation !== entry.contentGeneration) {
          if (entry.contentInFlight === request) entry.contentInFlight = null;
          return await this.#readBytes(entry);
        }
        if (!entry.disposed && generation === entry.contentGeneration) {
          entry.contentError = errorMessage(error);
          if (!entry.bytes && !entry.objectUrl) entry.contentStale = false;
        }
        throw error;
      } finally {
        if (entry.contentInFlight === request) entry.contentInFlight = null;
        if (!entry.disposed) this.#trimInactive(entry);
      }
    })();
    entry.contentInFlight = request;
    this.#publish(entry);
    return request;
  }

  async #readObjectUrl(entry: PageFileReadEntry): Promise<string> {
    if (entry.objectUrlConsumers === 0) {
      throw new Error("Page File object URLs require an active presentation consumer");
    }
    if (entry.objectUrl) {
      if (entry.contentStale) void this.#readBytes(entry).catch(() => undefined);
      return entry.objectUrl;
    }
    const bytes = await this.#readBytes(entry);
    if (!entry.objectUrl && !entry.disposed && entry.objectUrlConsumers > 0) {
      entry.objectUrl = this.#dependencies.createObjectUrl(bytes);
      entry.contentEtag = bytes.etag;
      this.#publish(entry);
    }
    if (!entry.objectUrl) throw new Error("Page File object URL is unavailable");
    return entry.objectUrl;
  }

  #invalidate(
    scopeKey: string,
    scope: PageFileReadScopeState,
    invalidation: PageFileReadInvalidation,
  ): void {
    if (!invalidation.metadata && !invalidation.content) return;
    const exactFileIds = invalidation.fileIds ? new Set(invalidation.fileIds) : null;
    if (exactFileIds?.size === 0) return;

    for (const key of scope.entryKeys) {
      const entry = this.#entries.get(key);
      if (!entry || entry.scopeKey !== scopeKey || entry.disposed) continue;
      if (exactFileIds && !exactFileIds.has(entry.fileId)) continue;

      if (invalidation.metadata) {
        entry.metadataGeneration += 1;
        entry.metadataStale = true;
        entry.metadataError = null;
        if (invalidation.mode === "revoke") entry.metadata = null;
      }
      if (invalidation.content) {
        entry.contentGeneration += 1;
        entry.contentStale = true;
        entry.contentError = null;
        if (invalidation.mode === "revoke") {
          entry.bytes = null;
          entry.contentEtag = null;
          if (entry.objectUrl) this.#dependencies.revokeObjectUrl(entry.objectUrl);
          entry.objectUrl = null;
        }
      }
      this.#publish(entry);

      if (invalidation.metadata && (entry.metadataConsumers > 0 || entry.metadataInFlight)) {
        void this.#readMetadata(entry).catch(() => undefined);
      }
      if (
        invalidation.content &&
        (entry.contentConsumers > 0 || entry.objectUrlConsumers > 0 || entry.contentInFlight)
      ) {
        const refresh =
          entry.objectUrlConsumers > 0 ? this.#readObjectUrl(entry) : this.#readBytes(entry);
        void refresh.catch(() => undefined);
      }
    }
  }

  #publish(entry: PageFileReadEntry): void {
    const next: PageFileReadSnapshot = {
      metadata: entry.metadata,
      bytes: entry.bytes,
      objectUrl: entry.objectUrl,
      metadataLoading: entry.metadata === null && entry.metadataInFlight !== null,
      contentLoading:
        entry.bytes === null && entry.objectUrl === null && entry.contentInFlight !== null,
      metadataRefreshing: entry.metadata !== null && entry.metadataInFlight !== null,
      contentRefreshing:
        (entry.bytes !== null || entry.objectUrl !== null) && entry.contentInFlight !== null,
      metadataError: entry.metadataError,
      contentError: entry.contentError,
    };
    const previous = entry.snapshot;
    if (
      previous.metadata === next.metadata &&
      previous.bytes === next.bytes &&
      previous.objectUrl === next.objectUrl &&
      previous.metadataLoading === next.metadataLoading &&
      previous.contentLoading === next.contentLoading &&
      previous.metadataRefreshing === next.metadataRefreshing &&
      previous.contentRefreshing === next.contentRefreshing &&
      previous.metadataError === next.metadataError &&
      previous.contentError === next.contentError
    ) {
      return;
    }
    entry.snapshot = next;
    for (const subscription of entry.listeners) subscription.listener();
  }

  #trimInactive(entry: PageFileReadEntry): void {
    if (entry.disposed) return;
    if (entry.metadataConsumers === 0) {
      entry.metadata = null;
      entry.metadataError = null;
      entry.metadataStale = true;
    }
    if (entry.contentConsumers === 0) entry.bytes = null;
    if (entry.objectUrlConsumers === 0 && entry.objectUrl) {
      this.#dependencies.revokeObjectUrl(entry.objectUrl);
      entry.objectUrl = null;
    }
    if (entry.contentConsumers === 0 && entry.objectUrlConsumers === 0) {
      entry.contentEtag = null;
      entry.contentError = null;
      entry.contentStale = true;
    }

    const hasConsumers =
      entry.metadataConsumers > 0 || entry.contentConsumers > 0 || entry.objectUrlConsumers > 0;
    if (!hasConsumers && !entry.metadataInFlight && !entry.contentInFlight) {
      const key = entryKeyFor(entry.scopeKey, entry.fileId);
      this.#entries.delete(key);
      this.#scopes.get(entry.scopeKey)?.entryKeys.delete(key);
      entry.disposed = true;
      entry.listeners.clear();
      return;
    }
    this.#publish(entry);
  }

  #releaseScope(scopeKey: string, scope: PageFileReadScopeState): void {
    scope.leases -= 1;
    if (scope.leases > 0) return;
    this.#scopes.delete(scopeKey);
    for (const key of scope.entryKeys) {
      const entry = this.#entries.get(key);
      if (!entry) continue;
      entry.disposed = true;
      entry.metadataGeneration += 1;
      entry.contentGeneration += 1;
      entry.listeners.clear();
      if (entry.objectUrl) this.#dependencies.revokeObjectUrl(entry.objectUrl);
      this.#entries.delete(key);
    }
    scope.entryKeys.clear();
  }
}
