import type { LibraryFilePresentation } from "../../shared/library-files";
import type { FileBytes } from "../../shared/file-resources";
import { contentAccessContextKey } from "../../shared/content-access-context";
import type { FileReadAuthority } from "./library-file-resources";

export interface FileReadCacheDependencies {
  readonly readMetadata: (
    authority: FileReadAuthority,
    fileId: string,
  ) => Promise<LibraryFilePresentation>;
  readonly readBytes: (authority: FileReadAuthority, fileId: string) => Promise<FileBytes>;
  readonly createObjectUrl: (file: FileBytes) => string;
  readonly revokeObjectUrl: (url: string) => void;
}

export interface FileReadDemand {
  readonly metadata?: boolean;
  readonly content?: boolean;
  readonly objectUrl?: boolean;
}

export interface FileReadInvalidation {
  /** Refresh preserves an authorized stale value; revoke removes it before revalidation. */
  readonly mode: "refresh" | "revoke";
  /** `null` is the generated reset variant for the containing Page scope. */
  readonly fileIds: readonly string[] | null;
  readonly metadata: boolean;
  readonly content: boolean;
}

export interface FileReadSnapshot {
  readonly metadata: LibraryFilePresentation | null;
  readonly bytes: FileBytes | null;
  readonly objectUrl: string | null;
  readonly metadataLoading: boolean;
  readonly contentLoading: boolean;
  readonly metadataRefreshing: boolean;
  readonly contentRefreshing: boolean;
  readonly metadataError: string | null;
  readonly contentError: string | null;
}

export interface FileReadScope {
  readonly authority: FileReadAuthority;
  readMetadata(fileId: string): Promise<LibraryFilePresentation>;
  readBytes(fileId: string): Promise<FileBytes>;
  readObjectUrl(fileId: string): Promise<string>;
  preload(fileId: string, demand: FileReadDemand): void;
  snapshot(fileId: string): FileReadSnapshot;
  subscribe(fileId: string, demand: FileReadDemand, listener: () => void): () => void;
  invalidate(invalidation: FileReadInvalidation): void;
  release(): void;
}

interface FileReadSubscription {
  readonly listener: () => void;
  readonly metadata: boolean;
  readonly content: boolean;
  readonly objectUrl: boolean;
}

interface FileReadEntry {
  readonly scopeKey: string;
  readonly fileId: string;
  readonly authority: FileReadAuthority;
  readonly listeners: Set<FileReadSubscription>;
  metadata: LibraryFilePresentation | null;
  bytes: FileBytes | null;
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
  metadataInFlight: Promise<LibraryFilePresentation> | null;
  contentInFlight: Promise<FileBytes> | null;
  disposed: boolean;
  snapshot: FileReadSnapshot;
}

interface FileReadScopeState {
  readonly authority: FileReadAuthority;
  readonly entryKeys: Set<string>;
  leases: number;
}

export const EMPTY_FILE_READ_SNAPSHOT: FileReadSnapshot = Object.freeze({
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
  error instanceof Error ? error.message : "File read failed";

export const fileReadAuthorityKey = (authority: FileReadAuthority): string =>
  JSON.stringify([
    authority.libraryId,
    authority.storeEpoch,
    contentAccessContextKey(authority.contentAccessContext),
    authority.readSource,
    authority.version ?? null,
  ]);

const entryKeyFor = (scopeKey: string, fileId: string): string =>
  JSON.stringify([scopeKey, fileId]);

/**
 * Shares File presentation across placements with the same exact read capability in one
 * renderer scope. Current, historical, and fixed-version reads remain isolated. Callers address stable File identities; request coalescing,
 * stale presentation, exact invalidation, and object-URL ownership stay inside.
 *
 * Retention is deliberately active-only instead of a process-wide LRU: raw
 * bytes exist only for an active content subscriber or an in-flight caller,
 * and object URLs exist only for active image subscribers. This makes memory
 * proportional to presentation the editor is actually keeping alive, while
 * final scope release remains the deterministic backstop.
 */
export class FileReadCache {
  readonly #dependencies: FileReadCacheDependencies;
  readonly #scopes = new Map<string, FileReadScopeState>();
  readonly #entries = new Map<string, FileReadEntry>();

  constructor(dependencies: FileReadCacheDependencies) {
    this.#dependencies = dependencies;
  }

  acquire(authority: FileReadAuthority): FileReadScope {
    const scopeKey = fileReadAuthorityKey(authority);
    const state = this.#scopes.get(scopeKey) ?? {
      authority,
      entryKeys: new Set<string>(),
      leases: 0,
    };
    state.leases += 1;
    this.#scopes.set(scopeKey, state);
    let released = false;
    const ownedSubscriptions = new Set<() => void>();

    const entry = (fileId: string): FileReadEntry => {
      if (released) throw new Error("File read scope is released");
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

  #entryFor(scopeKey: string, scope: FileReadScopeState, fileId: string): FileReadEntry {
    const normalizedFileId = fileId.trim();
    if (!normalizedFileId) throw new Error("File identity is required");
    const key = entryKeyFor(scopeKey, normalizedFileId);
    const existing = this.#entries.get(key);
    if (existing) return existing;

    const created: FileReadEntry = {
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
      snapshot: EMPTY_FILE_READ_SNAPSHOT,
    };
    this.#entries.set(key, created);
    scope.entryKeys.add(key);
    return created;
  }

  #snapshotFor(scopeKey: string, fileId: string): FileReadSnapshot {
    const normalizedFileId = fileId.trim();
    if (!normalizedFileId) throw new Error("File identity is required");
    return (
      this.#entries.get(entryKeyFor(scopeKey, normalizedFileId))?.snapshot ??
      EMPTY_FILE_READ_SNAPSHOT
    );
  }

  #preload(entry: FileReadEntry, demand: FileReadDemand): void {
    if (demand.metadata) void this.#readMetadata(entry).catch(() => undefined);
    if (demand.objectUrl) {
      void this.#readObjectUrl(entry).catch(() => undefined);
      return;
    }
    if (demand.content) void this.#readBytes(entry).catch(() => undefined);
  }

  #readMetadata(entry: FileReadEntry): Promise<LibraryFilePresentation> {
    if (entry.metadata && !entry.metadataStale) return Promise.resolve(entry.metadata);
    if (entry.metadataError && !entry.metadataStale) {
      return Promise.reject(new Error(entry.metadataError));
    }
    if (entry.metadataInFlight) return entry.metadataInFlight;

    const generation = entry.metadataGeneration;
    let request!: Promise<LibraryFilePresentation>;
    request = (async (): Promise<LibraryFilePresentation> => {
      try {
        const metadata = await this.#dependencies.readMetadata(entry.authority, entry.fileId);
        if (entry.disposed) throw new Error("File read scope was released");
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

  #readBytes(entry: FileReadEntry): Promise<FileBytes> {
    if (entry.bytes && !entry.contentStale) return Promise.resolve(entry.bytes);
    if (entry.contentError && !entry.contentStale) {
      return Promise.reject(new Error(entry.contentError));
    }
    if (entry.contentInFlight) return entry.contentInFlight;

    const generation = entry.contentGeneration;
    let request!: Promise<FileBytes>;
    request = (async (): Promise<FileBytes> => {
      try {
        const bytes = await this.#dependencies.readBytes(entry.authority, entry.fileId);
        if (entry.disposed) throw new Error("File read scope was released");
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

  async #readObjectUrl(entry: FileReadEntry): Promise<string> {
    if (entry.objectUrlConsumers === 0) {
      throw new Error("File object URLs require an active presentation consumer");
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
    if (!entry.objectUrl) throw new Error("File object URL is unavailable");
    return entry.objectUrl;
  }

  #invalidate(
    scopeKey: string,
    scope: FileReadScopeState,
    invalidation: FileReadInvalidation,
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

  #publish(entry: FileReadEntry): void {
    const next: FileReadSnapshot = {
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

  #trimInactive(entry: FileReadEntry): void {
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

  #releaseScope(scopeKey: string, scope: FileReadScopeState): void {
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
