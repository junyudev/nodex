import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { AuthorityResource } from "../../shared/authorized-read-stamp";
import type { PageDetail } from "../../shared/page-detail";
import { readPageDetail } from "./api";
import {
  rendererAuthorityFreshnessIndex,
  StaleAuthorizedReadError,
  type AuthorityRegistration,
} from "./authority-freshness-index";
import {
  pageDetailDataDependencies,
  pageDetailDocumentDependencies,
} from "./page-detail-projection-dependencies";
import { useProjectionInvalidationRegistry } from "./projection-invalidation-context";
import type {
  ProjectionInvalidationCause,
  ProjectionInvalidationRegistry,
} from "./projection-invalidation-registry";

export interface PageDetailSnapshot {
  readonly detail: PageDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
}

type Listener = () => void;

interface InFlightPageDetail {
  readonly generation: number;
  readonly promise: Promise<PageDetail | null>;
  readonly token: object;
}

interface PageDetailEntry {
  snapshot: PageDetailSnapshot;
  readonly listeners: Set<Listener>;
  version: number;
  generation: number;
  inFlight: InFlightPageDetail | null;
  projectionAuthority: {
    readonly registry: ProjectionInvalidationRegistry;
    readonly libraryId: string;
    readonly release: () => void;
  } | null;
  freshnessAuthority: AuthorityRegistration | null;
  lastAccess: number;
}

const EMPTY_DETAIL: PageDetailSnapshot = {
  detail: null,
  loading: false,
  error: null,
};

const MAX_RETAINED_PAGE_DETAILS = 128;
const entries = new Map<string, PageDetailEntry>();
let storeGeneration = 0;
let accessSequence = 0;

const detailKey = (projectId: string, pageId: string): string =>
  JSON.stringify([projectId, pageId]);

const createEntry = (): PageDetailEntry => ({
  snapshot: EMPTY_DETAIL,
  listeners: new Set(),
  version: 0,
  generation: 0,
  inFlight: null,
  projectionAuthority: null,
  freshnessAuthority: null,
  lastAccess: 0,
});

const entryFor = (key: string): PageDetailEntry => {
  const existing = entries.get(key);
  if (existing) return existing;
  const entry = createEntry();
  entries.set(key, entry);
  return entry;
};

const touch = (entry: PageDetailEntry): void => {
  accessSequence += 1;
  entry.lastAccess = accessSequence;
};

const emit = (entry: PageDetailEntry): void => {
  entry.version += 1;
  for (const listener of entry.listeners) listener();
};

const releaseAuthority = (entry: PageDetailEntry): void => {
  entry.projectionAuthority?.release();
  entry.projectionAuthority = null;
  entry.freshnessAuthority?.release();
  entry.freshnessAuthority = null;
};

const deleteInactiveEntry = (key: string, entry: PageDetailEntry): void => {
  if (entry.listeners.size > 0 || entry.inFlight) return;
  entry.generation += 1;
  releaseAuthority(entry);
  entries.delete(key);
};

const pruneInactiveEntries = (): void => {
  if (entries.size <= MAX_RETAINED_PAGE_DETAILS) return;
  const candidates = [...entries.entries()]
    .filter(([, entry]) => entry.listeners.size === 0 && !entry.inFlight)
    .sort(([, left], [, right]) => left.lastAccess - right.lastAccess);
  for (const [key, entry] of candidates) {
    if (entries.size <= MAX_RETAINED_PAGE_DETAILS) return;
    deleteInactiveEntry(key, entry);
  }
};

const subscribe = (key: string | null, listener: Listener): (() => void) => {
  if (!key) return () => undefined;
  const entry = entryFor(key);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    if (entry.snapshot === EMPTY_DETAIL && !entry.inFlight) {
      deleteInactiveEntry(key, entry);
      return;
    }
    pruneInactiveEntries();
  };
};

const compareDetailFreshness = (left: PageDetail, right: PageDetail): number => {
  if (left.storeEpoch !== right.storeEpoch) return 1;
  const coordinates = [
    [left.commitSeq, right.commitSeq],
    [left.page.documentGeneration, right.page.documentGeneration],
    [left.page.documentHeadSeq, right.page.documentHeadSeq],
    [left.page.parentRevision, right.page.parentRevision],
    [left.page.metadataRevision, right.page.metadataRevision],
    [
      left.dataSourceContext.kind === "member" ? left.dataSourceContext.membership.revision : 0,
      right.dataSourceContext.kind === "member" ? right.dataSourceContext.membership.revision : 0,
    ],
  ] as const;
  for (const [leftValue, rightValue] of coordinates) {
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
};

export const setPageDetail = (
  detail: PageDetail,
  options: { readonly acceptEqualFreshness?: boolean } = {},
): void => {
  const key = detailKey(detail.projectId, detail.page.pageId);
  const entry = entryFor(key);
  const previous = entry.snapshot.detail;
  if (previous && compareDetailFreshness(detail, previous) < 0) return;
  if (previous && compareDetailFreshness(detail, previous) === 0 && !options.acceptEqualFreshness)
    return;
  entry.snapshot = { detail, loading: false, error: null };
  touch(entry);
  pruneInactiveEntries();
  emit(entry);
};

export const getPageDetail = (projectId: string, pageId: string): PageDetail | null => {
  const entry = entries.get(detailKey(projectId, pageId));
  const detail = entry?.snapshot.detail ?? null;
  if (detail && entry) touch(entry);
  return detail;
};

export const invalidatePageDetail = (projectId: string, pageId: string): void => {
  const key = detailKey(projectId, pageId);
  const entry = entries.get(key);
  if (!entry) return;
  entry.generation += 1;
  const changed = entry.snapshot !== EMPTY_DETAIL;
  entry.snapshot = EMPTY_DETAIL;
  if (changed) emit(entry);
  if (entry.listeners.size === 0 && !entry.inFlight) deleteInactiveEntry(key, entry);
};

export const revokePageDetail = (projectId: string, pageId: string): void => {
  const key = detailKey(projectId, pageId);
  const entry = entryFor(key);
  entry.generation += 1;
  entry.snapshot = { detail: null, loading: false, error: "Page not found" };
  touch(entry);
  emit(entry);
  if (entry.listeners.size === 0 && !entry.inFlight) deleteInactiveEntry(key, entry);
};

export const pageDetailStoreDiagnostics = () => ({
  entries: entries.size,
  listeners: [...entries.values()].reduce((total, entry) => total + entry.listeners.size, 0),
  inFlight: [...entries.values()].filter((entry) => entry.inFlight).length,
  projectionRegistrations: [...entries.values()].filter((entry) => entry.projectionAuthority)
    .length,
  freshnessRegistrations: [...entries.values()].filter((entry) => entry.freshnessAuthority).length,
});

export const resetPageDetailStoreForTests = (): void => {
  rendererAuthorityFreshnessIndex.reset();
  storeGeneration += 1;
  accessSequence = 0;
  for (const [key, entry] of entries) {
    releaseAuthority(entry);
    entry.generation += 1;
    entry.inFlight = null;
    entry.snapshot = EMPTY_DETAIL;
    if (entry.listeners.size === 0) {
      entries.delete(key);
      continue;
    }
    emit(entry);
  }
  rendererAuthorityFreshnessIndex.dispose();
};

export const fetchPageDetail = async (
  projectId: string,
  pageId: string,
  options: {
    readonly minimumCommitSeq?: number;
    readonly libraryId?: string;
  } = {},
): Promise<PageDetail | null> => {
  const key = detailKey(projectId, pageId);
  const entry = entryFor(key);
  const minimumCommitSeq = options.minimumCommitSeq ?? 0;
  const generation = entry.generation;
  if (entry.inFlight?.generation === generation) {
    const detail = await entry.inFlight.promise;
    if (!detail) return null;
    if (minimumCommitSeq <= 0 || detail.commitSeq >= minimumCommitSeq) return detail;
    return await fetchPageDetail(projectId, pageId, {
      minimumCommitSeq,
      libraryId: options.libraryId,
    });
  }

  const startingSnapshot = entry.snapshot;
  const libraryId = options.libraryId ?? startingSnapshot.detail?.libraryId;
  if (!libraryId) {
    deleteInactiveEntry(key, entry);
    throw new Error("Page Detail read requires its Library delivery address");
  }
  const authorityLease = rendererAuthorityFreshnessIndex.beginRead({
    deliveryAddress: {
      kind: "project",
      library_id: libraryId,
      project_id: projectId,
    },
    ...(startingSnapshot.detail ? { storeEpoch: startingSnapshot.detail.storeEpoch } : {}),
    observedCommitSeq: Math.max(minimumCommitSeq, startingSnapshot.detail?.commitSeq ?? 0),
    subject: { kind: "page", page_id: pageId },
    requestDependencies: [{ kind: "page", page_id: pageId }],
  });
  entry.snapshot = {
    detail: startingSnapshot.detail,
    loading: startingSnapshot.detail === null,
    error: null,
  };
  touch(entry);
  emit(entry);

  const requestStoreGeneration = storeGeneration;
  const requestEntryGeneration = generation;
  const requestToken = {};
  let staleRetryFloor: number | null = null;
  const request = (async (): Promise<PageDetail | null> => {
    try {
      const result = await readPageDetail(projectId, pageId, minimumCommitSeq);
      if (requestStoreGeneration !== storeGeneration) return null;
      if (!result.ok) {
        if (requestEntryGeneration !== entry.generation) return null;
        if (result.error.code !== "page_not_found") {
          throw new Error(result.error.message);
        }
        entry.snapshot = { detail: null, loading: false, error: "Page not found" };
        emit(entry);
        return null;
      }
      if (result.value.projectId !== projectId || result.value.page.pageId !== pageId) {
        throw new Error("Page Detail response does not match the requested Project and Page");
      }
      const freshness = await rendererAuthorityFreshnessIndex.admitRead(
        authorityLease,
        result.value.authorization,
        (fence) => {
          const subjectRevoked =
            fence.kind === "revoke" &&
            fence.roots.some((root) => root.kind === "page" && root.page_id === pageId);
          if (subjectRevoked) {
            revokePageDetail(projectId, pageId);
            return;
          }
          invalidatePageDetail(projectId, pageId);
          void fetchPageDetail(projectId, pageId, {
            minimumCommitSeq: fence.commitSeq,
            libraryId,
          }).catch(() => undefined);
        },
      );
      entry.freshnessAuthority?.release();
      entry.freshnessAuthority = freshness;
      setPageDetail(result.value, { acceptEqualFreshness: true });
      return result.value;
    } catch (error) {
      rendererAuthorityFreshnessIndex.releaseRead(authorityLease);
      if (requestStoreGeneration !== storeGeneration || requestEntryGeneration !== entry.generation)
        return null;
      if (error instanceof StaleAuthorizedReadError) {
        staleRetryFloor = Math.max(minimumCommitSeq, error.requiredCommitSeq);
        entry.freshnessAuthority?.release();
        entry.freshnessAuthority = null;
        entry.snapshot = { detail: null, loading: false, error: null };
        emit(entry);
        return null;
      }
      entry.snapshot = {
        detail: startingSnapshot.detail,
        loading: false,
        error: error instanceof Error ? error.message : "Page Detail is unavailable",
      };
      emit(entry);
      throw error;
    } finally {
      if (entry.inFlight?.token === requestToken) entry.inFlight = null;
      if (entry.listeners.size === 0 && entry.snapshot.detail === null) {
        deleteInactiveEntry(key, entry);
      }
      if (
        staleRetryFloor !== null &&
        requestStoreGeneration === storeGeneration &&
        entries.get(key) === entry &&
        requestEntryGeneration === entry.generation &&
        entry.listeners.size > 0
      ) {
        void fetchPageDetail(projectId, pageId, {
          minimumCommitSeq: staleRetryFloor,
          libraryId,
        }).catch(() => undefined);
      }
    }
  })();
  entry.inFlight = { generation, promise: request, token: requestToken };
  return request;
};

const requestPageDetailRefresh = (
  projectId: string,
  pageId: string,
  cause: ProjectionInvalidationCause,
): Promise<void> =>
  (async () => {
    const key = detailKey(projectId, pageId);
    const entry = entries.get(key);
    if (cause.kind === "revocation" && cause.delivery.revocation.resource_kind === "page") return;
    if (entry?.inFlight) await entry.inFlight.promise;
    if (!entry || entry.listeners.size === 0) {
      invalidatePageDetail(projectId, pageId);
      return;
    }
    const detail = entry.snapshot.detail;
    if (
      cause.kind !== "reset" &&
      detail?.storeEpoch === cause.stream.storeEpoch &&
      detail.commitSeq >= cause.stream.commitSeq
    )
      return;
    await fetchPageDetail(projectId, pageId, {
      minimumCommitSeq: cause.kind === "reset" ? 0 : cause.stream.commitSeq,
      libraryId: cause.scope.libraryId,
    });
  })();

const revokedResource = (
  revocation: Extract<
    ProjectionInvalidationCause,
    { readonly kind: "revocation" }
  >["delivery"]["revocation"],
): AuthorityResource => {
  switch (revocation.resource_kind) {
    case "page":
      return { kind: "page", page_id: revocation.resource_id };
    case "document":
      return { kind: "document", document_id: revocation.resource_id };
    case "database":
      return { kind: "database", database_id: revocation.resource_id };
    case "data_source":
      return {
        kind: "data_source",
        data_source_id: revocation.resource_id,
      };
    case "view":
      return { kind: "view", view_id: revocation.resource_id };
    case "canvas":
      return { kind: "canvas", canvas_id: revocation.resource_id };
    case "file":
      return { kind: "file", file_id: revocation.resource_id };
  }
};

const retainPageDetailAuthority = (
  libraryId: string,
  projectId: string,
  pageId: string,
  registry: ProjectionInvalidationRegistry,
): void => {
  const key = detailKey(projectId, pageId);
  const entry = entryFor(key);
  if (
    entry.projectionAuthority?.registry === registry &&
    entry.projectionAuthority.libraryId === libraryId
  )
    return;
  entry.projectionAuthority?.release();
  const release = registry.register({
    scope: { kind: "project", libraryId, projectId },
    consumerKey: JSON.stringify(["page-detail", projectId, pageId]),
    getDependencies: () => {
      const detail = entry.snapshot.detail;
      return {
        ...pageDetailDataDependencies(detail, pageId),
        ...pageDetailDocumentDependencies(detail, pageId),
      };
    },
    getCursor: () => {
      const detail = entry.snapshot.detail;
      return detail ? { storeEpoch: detail.storeEpoch, commitSeq: detail.commitSeq } : null;
    },
    revoke: (cause) => {
      rendererAuthorityFreshnessIndex.admitVisibility({
        deliveryAddress: {
          kind: "project",
          library_id: libraryId,
          project_id: projectId,
        },
        storeEpoch: cause.stream.storeEpoch,
        commitSeq: cause.stream.commitSeq,
        change: "revoke",
        roots: [revokedResource(cause.delivery.revocation)],
      });
      if (cause.delivery.revocation.resource_kind === "page") {
        revokePageDetail(projectId, pageId);
        return;
      }
      invalidatePageDetail(projectId, pageId);
    },
    fence: (cause) => {
      rendererAuthorityFreshnessIndex.observeAddress({
        deliveryAddress: {
          kind: "project",
          library_id: libraryId,
          project_id: projectId,
        },
        storeEpoch: cause.stream.storeEpoch,
        commitSeq: cause.stream.commitSeq,
      });
      invalidatePageDetail(projectId, pageId);
    },
    invalidate: (cause) => requestPageDetailRefresh(projectId, pageId, cause),
  });
  entry.projectionAuthority = { registry, libraryId, release };
};

export const usePageDetail = (
  libraryId: string | null,
  projectId: string | null,
  pageId: string | null,
): PageDetailSnapshot => {
  const registry = useProjectionInvalidationRegistry();
  const key = projectId && pageId ? detailKey(projectId, pageId) : null;
  const subscribeToDetail = useMemo(() => (listener: Listener) => subscribe(key, listener), [key]);
  useSyncExternalStore(
    subscribeToDetail,
    () => (key ? (entries.get(key)?.version ?? 0) : 0),
    () => 0,
  );

  useEffect(() => {
    if (!libraryId || !projectId || !pageId || getPageDetail(projectId, pageId)) return;
    void fetchPageDetail(projectId, pageId, { libraryId }).catch(() => undefined);
  }, [libraryId, pageId, projectId]);

  const snapshot = key ? (entries.get(key)?.snapshot ?? EMPTY_DETAIL) : EMPTY_DETAIL;
  useEffect(() => {
    if (!projectId || !pageId || !libraryId) return;
    retainPageDetailAuthority(libraryId, projectId, pageId, registry);
  }, [libraryId, pageId, projectId, registry]);

  return snapshot;
};
