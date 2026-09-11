import {
  type Query,
  type QueryCacheNotifyEvent,
  type QueryClient,
  type QueryKey,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

import type { AuthorizedReadStamp } from "../../shared/authorized-read-stamp";
import {
  AuthorityFreshnessCapacityError,
  rendererAuthorityFreshnessIndex,
  StaleAuthorizedReadError,
  type AuthorityFreshnessIndex,
  type AuthorityRegistration,
} from "./authority-freshness-index";

const RESOURCE_AUTHORITY_META_KEY = "nodexResourceAuthority";

export interface ResourceAuthorityQueryResolution {
  readonly authorizations: readonly AuthorizedReadStamp[];
  /** Additional cached resources invalidated by the same authority loss. */
  readonly relatedQueryKeys?: readonly QueryKey[];
}

export interface ResourceAuthorityQueryMetadata {
  readonly resolve: (queryKey: QueryKey, data: unknown) => ResourceAuthorityQueryResolution | null;
}

const MAX_PENDING_ADMISSIONS = 256;
const PENDING_ADMISSION_TIMEOUT_MS = 30_000;

interface PendingAuthorityAdmission {
  readonly registrations: readonly AuthorityRegistration[];
  fenced: boolean;
  onFence: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingAdmissions = new Map<string, PendingAuthorityAdmission[]>();

const resolutionKey = (resolution: ResourceAuthorityQueryResolution): string =>
  resolution.authorizations.map((stamp) => stamp.stamp_hash).join(":");

const releasePendingAdmission = (admission: PendingAuthorityAdmission): void => {
  if (admission.timer) clearTimeout(admission.timer);
  for (const registration of admission.registrations) registration.release();
};

const removePendingAdmission = (key: string, admission: PendingAuthorityAdmission): void => {
  const pending = pendingAdmissions.get(key);
  if (!pending) return;
  const next = pending.filter((candidate) => candidate !== admission);
  if (next.length > 0) pendingAdmissions.set(key, next);
  else pendingAdmissions.delete(key);
};

const claimPendingAdmission = (
  resolution: ResourceAuthorityQueryResolution,
  onFence: () => void,
): readonly AuthorityRegistration[] | null => {
  const key = resolutionKey(resolution);
  const pending = pendingAdmissions.get(key);
  const admission = pending?.shift();
  if (!admission) return null;
  if (pending?.length === 0) pendingAdmissions.delete(key);
  if (admission.timer) clearTimeout(admission.timer);
  admission.onFence = onFence;
  if (admission.fenced) {
    releasePendingAdmission(admission);
    onFence();
    return [];
  }
  return admission.registrations;
};

/** Verifies and registers authority before a TanStack query publishes data. */
export const admitResourceAuthorityQuery = async <Data,>(
  data: Data,
  resolve: ResourceAuthorityQueryMetadata["resolve"],
  freshnessIndex: AuthorityFreshnessIndex = rendererAuthorityFreshnessIndex,
): Promise<Data> => {
  const resolution = resolve([], data);
  if (!resolution || resolution.authorizations.length === 0) return data;
  const registrations: AuthorityRegistration[] = [];
  const admission: PendingAuthorityAdmission = {
    registrations,
    fenced: false,
    onFence: null,
    timer: null,
  };
  try {
    for (const authorization of resolution.authorizations) {
      registrations.push(
        await freshnessIndex.registerSnapshot(authorization, () => {
          admission.fenced = true;
          admission.onFence?.();
        }),
      );
    }
  } catch (error) {
    for (const registration of registrations) registration.release();
    throw error;
  }
  if (admission.fenced) {
    for (const registration of registrations) registration.release();
    throw new StaleAuthorizedReadError();
  }
  const pendingCount = [...pendingAdmissions.values()].reduce(
    (total, values) => total + values.length,
    0,
  );
  if (pendingCount >= MAX_PENDING_ADMISSIONS) {
    for (const registration of registrations) registration.release();
    throw new AuthorityFreshnessCapacityError("pending query admissions");
  }
  const key = resolutionKey(resolution);
  const timer = setTimeout(() => {
    removePendingAdmission(key, admission);
    releasePendingAdmission(admission);
  }, PENDING_ADMISSION_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  admission.timer = timer;
  pendingAdmissions.set(key, [...(pendingAdmissions.get(key) ?? []), admission]);
  return data;
};

export const resourceAuthorityQueryMeta = (
  resolve: ResourceAuthorityQueryMetadata["resolve"],
): Record<string, unknown> => ({
  [RESOURCE_AUTHORITY_META_KEY]: { resolve } satisfies ResourceAuthorityQueryMetadata,
});

const metadataFrom = (meta: unknown): ResourceAuthorityQueryMetadata | null => {
  if (!meta || typeof meta !== "object") return null;
  const candidate = (meta as Record<string, unknown>)[RESOURCE_AUTHORITY_META_KEY];
  if (!candidate || typeof candidate !== "object") return null;
  const resolve = (candidate as Partial<ResourceAuthorityQueryMetadata>).resolve;
  return typeof resolve === "function" ? { resolve } : null;
};

const evictExactQuery = (queryClient: QueryClient, queryKey: QueryKey): void => {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (!query) return;
  if (query.getObserversCount() === 0) {
    queryClient.removeQueries({ queryKey, exact: true });
    return;
  }
  // resetQueries synchronously removes current data and cancels the old read;
  // its returned promise only represents the canonical trailing refetch.
  void queryClient.resetQueries({ queryKey, exact: true }).catch(() => undefined);
};

interface IndexedAuthorityQuery {
  readonly queryHash: string;
  readonly queryKey: QueryKey;
  readonly resolution: ResourceAuthorityQueryResolution;
  readonly registrations: readonly AuthorityRegistration[];
}

/**
 * Keeps revocation subscriptions alive for authorization-bearing query cache
 * entries, including entries whose React surface is currently unmounted.
 */
export class ResourceAuthorityQueryCache {
  readonly #queryClient: QueryClient;
  readonly #freshnessIndex: AuthorityFreshnessIndex;
  readonly #indexedQueries = new Map<string, IndexedAuthorityQuery>();
  readonly #pending = new Map<string, symbol>();
  #releaseCacheSubscription: (() => void) | null = null;

  constructor(input: {
    readonly queryClient: QueryClient;
    readonly freshnessIndex?: AuthorityFreshnessIndex;
  }) {
    this.#queryClient = input.queryClient;
    this.#freshnessIndex = input.freshnessIndex ?? rendererAuthorityFreshnessIndex;
  }

  start(): () => void {
    if (this.#releaseCacheSubscription) return () => this.dispose();
    for (const query of this.#queryClient.getQueryCache().getAll()) {
      void this.#indexQuery(query);
    }
    this.#releaseCacheSubscription = this.#queryClient
      .getQueryCache()
      .subscribe((event) => this.#handleCacheEvent(event));
    return () => this.dispose();
  }

  dispose(): void {
    this.#releaseCacheSubscription?.();
    this.#releaseCacheSubscription = null;
    for (const indexed of this.#indexedQueries.values()) {
      for (const registration of indexed.registrations) registration.release();
    }
    this.#pending.clear();
    this.#indexedQueries.clear();
  }

  #handleCacheEvent(event: QueryCacheNotifyEvent): void {
    if (event.type === "removed") {
      this.#removeIndexedQuery(event.query.queryHash);
      return;
    }
    void this.#indexQuery(event.query);
  }

  async #indexQuery(query: Query): Promise<void> {
    const metadata = metadataFrom(query.meta);
    const resolution = metadata?.resolve(query.queryKey, query.state.data);
    if (!resolution || resolution.authorizations.length === 0) {
      this.#removeIndexedQuery(query.queryHash);
      return;
    }

    const claimed = claimPendingAdmission(resolution, () => this.#evictQuery(query.queryHash));
    if (claimed) {
      this.#removeIndexedQuery(query.queryHash);
      if (claimed.length === 0) return;
      this.#indexedQueries.set(query.queryHash, {
        queryHash: query.queryHash,
        queryKey: query.queryKey,
        resolution,
        registrations: claimed,
      });
      return;
    }

    const existing = this.#indexedQueries.get(query.queryHash);
    if (
      existing &&
      existing.resolution.authorizations.map((stamp) => stamp.stamp_hash).join(":") ===
        resolution.authorizations.map((stamp) => stamp.stamp_hash).join(":")
    ) {
      this.#indexedQueries.set(query.queryHash, {
        ...existing,
        queryKey: query.queryKey,
        resolution,
      });
      return;
    }

    this.#removeIndexedQuery(query.queryHash);
    const generation = Symbol("authority-query-registration");
    this.#pending.set(query.queryHash, generation);
    try {
      const registrations: AuthorityRegistration[] = [];
      try {
        for (const authorization of resolution.authorizations) {
          registrations.push(
            await this.#freshnessIndex.registerSnapshot(authorization, () =>
              this.#evictQuery(query.queryHash),
            ),
          );
        }
      } catch (error) {
        for (const registration of registrations) registration.release();
        throw error;
      }
      if (this.#pending.get(query.queryHash) !== generation) {
        for (const registration of registrations) registration.release();
        return;
      }
      this.#pending.delete(query.queryHash);
      this.#indexedQueries.set(query.queryHash, {
        queryHash: query.queryHash,
        queryKey: query.queryKey,
        resolution,
        registrations,
      });
    } catch {
      if (this.#pending.get(query.queryHash) !== generation) return;
      this.#pending.delete(query.queryHash);
      this.#evictQuery(query.queryHash, query.queryKey, resolution.relatedQueryKeys);
    }
  }

  #removeIndexedQuery(queryHash: string): void {
    this.#pending.delete(queryHash);
    const indexed = this.#indexedQueries.get(queryHash);
    if (!indexed) return;
    this.#indexedQueries.delete(queryHash);
    for (const registration of indexed.registrations) registration.release();
  }

  #evictQuery(
    queryHash: string,
    queryKey?: QueryKey,
    relatedQueryKeys: readonly QueryKey[] = [],
  ): void {
    const indexed = this.#indexedQueries.get(queryHash);
    const targetKey = queryKey ?? indexed?.queryKey;
    const related =
      relatedQueryKeys.length > 0 ? relatedQueryKeys : (indexed?.resolution.relatedQueryKeys ?? []);
    this.#removeIndexedQuery(queryHash);
    if (targetKey) evictExactQuery(this.#queryClient, targetKey);
    for (const relatedQueryKey of related) {
      evictExactQuery(this.#queryClient, relatedQueryKey);
    }
  }
}

export function ResourceAuthorityQueryCacheBridge(): null {
  const queryClient = useQueryClient();
  useEffect(() => {
    const cache = new ResourceAuthorityQueryCache({ queryClient });
    return cache.start();
  }, [queryClient]);
  return null;
}
