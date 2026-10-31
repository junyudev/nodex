import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type * as Y from "yjs";

import {
  makePageTitleResourceKey,
  type PageTitleAuthorityVersion,
  type PageTitleProjectionStore,
} from "./page-title-projection-store";

export interface PageTitleResourceIdentity {
  readonly libraryId: string;
  readonly pageId: string;
}

export interface PageTitleDocumentStatusSource {
  readonly getStatus: () => {
    readonly phase:
      | "idle"
      | "connecting"
      | "ready"
      | "saving"
      | "offline"
      | "error"
      | "reset-required"
      | "closing"
      | "closed";
    readonly ready: boolean;
    readonly reloadRequired: boolean;
    readonly descriptor: { readonly generation: number };
    readonly provider: {
      readonly generation?: number;
      readonly headSeq: number;
      readonly pendingUpdateCount: number;
    };
  };
  readonly subscribe: (listener: () => void) => () => void;
}

export interface PageTitleProjectionRetentionOwner {
  getOrCreateRetainedResource<Resource extends { dispose(): void }>(
    key: string,
    create: () => Resource,
  ): Resource;
}

interface PageTitleProjectionContextValue {
  readonly currentLibraryId: string | null;
  readonly store: PageTitleProjectionStore;
}

const PageTitleProjectionContext = createContext<PageTitleProjectionContextValue | null>(null);

export function PageTitleProjectionProvider({
  currentLibraryId,
  store,
  children,
}: PageTitleProjectionContextValue & { readonly children: ReactNode }) {
  const value = useMemo(() => ({ currentLibraryId, store }), [currentLibraryId, store]);
  return (
    <PageTitleProjectionContext.Provider value={value}>
      {children}
    </PageTitleProjectionContext.Provider>
  );
}

export function usePresentedPageTitle(
  pageId: string | null,
  fallbackTitle: string,
  libraryId?: string | null,
  authorityVersion?: PageTitleAuthorityVersion,
): string {
  const context = useContext(PageTitleProjectionContext);
  const store = context?.store ?? null;
  const resolvedLibraryId = libraryId ?? context?.currentLibraryId ?? null;
  const source = useMemo(() => {
    if (!store || !resolvedLibraryId || !pageId) return null;
    return store.createSource(makePageTitleResourceKey(resolvedLibraryId, pageId), fallbackTitle);
  }, [fallbackTitle, pageId, resolvedLibraryId, store]);
  const subscribe = source?.subscribe ?? EMPTY_SOURCE.subscribe;
  const getSnapshot = source?.getSnapshot ?? (() => presentFallbackTitle(fallbackTitle));
  const presentedTitle = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  usePublishCanonicalPageTitle(resolvedLibraryId, pageId, fallbackTitle, authorityVersion);

  return presentedTitle;
}

export function usePublishCanonicalPageTitle(
  libraryId: string | null,
  pageId: string | null,
  title: string | null,
  authorityVersion?: PageTitleAuthorityVersion,
): void {
  const context = useContext(PageTitleProjectionContext);
  const store = context?.store ?? null;
  const authorityGeneration = authorityVersion?.generation;
  const authorityHeadSeq = authorityVersion?.headSeq;

  useLayoutEffect(() => {
    if (
      !store ||
      !libraryId ||
      !pageId ||
      title === null ||
      authorityGeneration === undefined ||
      authorityHeadSeq === undefined
    )
      return;
    store.publishCanonical(makePageTitleResourceKey(libraryId, pageId), title, {
      generation: authorityGeneration,
      headSeq: authorityHeadSeq,
    });
  }, [authorityGeneration, authorityHeadSeq, libraryId, pageId, store, title]);
}

export function PageTitleProjectionPublisher({
  identity,
  publisherId,
  title,
  runtime,
  retentionOwner,
  children,
}: {
  readonly identity: PageTitleResourceIdentity;
  readonly publisherId: string;
  readonly title: Y.Text;
  readonly runtime: PageTitleDocumentStatusSource;
  readonly retentionOwner?: PageTitleProjectionRetentionOwner;
  readonly children: ReactNode;
}) {
  const context = useContext(PageTitleProjectionContext);
  const store = context?.store ?? null;
  const publisherLeaseId = useId();

  useLayoutEffect(() => {
    if (!store) return;
    const resourceKey = makePageTitleResourceKey(identity.libraryId, identity.pageId);
    const leasedPublisherId = retentionOwner
      ? `${publisherId}:retained`
      : `${publisherId}:${publisherLeaseId}`;
    const create = () =>
      createPageTitleProjectionPublisher({
        store,
        resourceKey,
        publisherId: leasedPublisherId,
        title,
        runtime,
      });
    if (!retentionOwner) return create().dispose;

    retentionOwner.getOrCreateRetainedResource(`page-title-projection:${resourceKey}`, create);
    return undefined;
  }, [
    identity.libraryId,
    identity.pageId,
    publisherId,
    publisherLeaseId,
    retentionOwner,
    runtime,
    store,
    title,
  ]);

  return children;
}

function createPageTitleProjectionPublisher({
  store,
  resourceKey,
  publisherId,
  title,
  runtime,
}: {
  readonly store: PageTitleProjectionStore;
  readonly resourceKey: string;
  readonly publisherId: string;
  readonly title: Y.Text;
  readonly runtime: PageTitleDocumentStatusSource;
}): { readonly dispose: () => void } {
  let disposed = false;
  let retiring = false;
  let observedReadyState = false;
  let awaitingRuntimeStatus = false;
  let unsubscribeRuntime = (): void => undefined;

  const finish = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribeRuntime();
    title.unobserve(handleObservedTitle);
    store.releasePublisher(resourceKey, publisherId);
  };

  function publishObservedTitle(): void {
    if (disposed) return;
    const status = runtime.getStatus();
    store.publishLive(
      resourceKey,
      publisherId,
      title.toString(),
      status.provider.generation ?? status.descriptor.generation,
    );
  }

  function handleObservedTitle(): void {
    // Y.Text observers run before the Y.Doc update handler queues persistence.
    // Only a later runtime status may acknowledge this newly observed value.
    awaitingRuntimeStatus = true;
    publishObservedTitle();
  }

  const publishDurableAcknowledgement = (): void => {
    if (disposed) return;
    const status = runtime.getStatus();
    if (status.ready) observedReadyState = true;
    const generation = status.provider.generation ?? status.descriptor.generation;
    const canAcknowledge =
      status.ready || (retiring && observedReadyState && status.phase === "closing");
    if (
      !canAcknowledge ||
      status.reloadRequired ||
      status.provider.pendingUpdateCount !== 0 ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !Number.isSafeInteger(status.provider.headSeq) ||
      status.provider.headSeq < 0
    ) {
      return;
    }
    store.acknowledgeLive(resourceKey, publisherId, title.toString(), {
      generation,
      headSeq: status.provider.headSeq,
    });
  };

  const settleRetirement = (): void => {
    if (!retiring || disposed || awaitingRuntimeStatus) return;
    const status = runtime.getStatus();
    if (
      status.provider.pendingUpdateCount === 0 ||
      status.phase === "closed" ||
      status.phase === "error" ||
      status.phase === "reset-required"
    ) {
      finish();
    }
  };

  const handleRuntimeStatus = (): void => {
    awaitingRuntimeStatus = false;
    publishObservedTitle();
    publishDurableAcknowledgement();
    settleRetirement();
  };

  publishObservedTitle();
  title.observe(handleObservedTitle);
  unsubscribeRuntime = runtime.subscribe(handleRuntimeStatus);
  handleRuntimeStatus();

  return {
    dispose: () => {
      if (disposed || retiring) return;
      retiring = true;
      if (awaitingRuntimeStatus) return;
      publishDurableAcknowledgement();
      settleRetirement();
    },
  };
}

const presentFallbackTitle = (title: string): string => title.trim() || "Untitled";

const EMPTY_SOURCE = {
  subscribe: () => () => undefined,
};

/** A bounded batch for surfaces that offer several visible Pages as message context. */
export function usePresentedPageTitles(
  pages: readonly { readonly pageId: string; readonly titleSnapshot: string }[],
) {
  const context = useContext(PageTitleProjectionContext);
  const pageKey = JSON.stringify(pages.map(({ pageId, titleSnapshot }) => [pageId, titleSnapshot]));
  const sources = useMemo(() => {
    const values = JSON.parse(pageKey) as [string, string][];
    return values.map(([pageId, fallback]) =>
      context?.store && context.currentLibraryId
        ? context.store.createSource(
            makePageTitleResourceKey(context.currentLibraryId, pageId),
            fallback,
          )
        : { getSnapshot: () => presentFallbackTitle(fallback), subscribe: EMPTY_SOURCE.subscribe },
    );
  }, [context, pageKey]);
  const source = useMemo(
    () => ({
      subscribe: (listener: () => void) => {
        const releases = sources.map((entry) => entry.subscribe(listener));
        return () => {
          for (const release of releases) release();
        };
      },
      getSnapshot: () => JSON.stringify(sources.map((entry) => entry.getSnapshot())),
    }),
    [sources],
  );
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  return {
    titles: useMemo(() => JSON.parse(snapshot) as string[], [snapshot]),
    readTitle(pageId: string, fallback: string) {
      if (!context?.currentLibraryId) return presentFallbackTitle(fallback);
      return context.store
        .createSource(makePageTitleResourceKey(context.currentLibraryId, pageId), fallback)
        .getSnapshot();
    },
  };
}
