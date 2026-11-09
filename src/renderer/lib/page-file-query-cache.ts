import { rendererSpaceId } from "./renderer-space";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { subscribeAllPageFileChanges } from "./page-library-changes";

const isFileSourceQueryForPage = (queryKey: QueryKey, pageId: string): boolean =>
  queryKey[0] === "space" &&
  queryKey[1] === rendererSpaceId() &&
  queryKey[2] === "libraryPages" &&
  queryKey[3] === "files" &&
  queryKey[5] === pageId;

/** Marks every cached access-context view stale, including currently unmounted Page tabs. */
export const invalidateCachedPageFileQueries = async (
  queryClient: QueryClient,
  pageId: string,
): Promise<void> => {
  await queryClient.invalidateQueries({
    predicate: (query) => isFileSourceQueryForPage(query.queryKey, pageId),
  });
};

export class PageFileQueryCacheSync {
  readonly #queryClient: QueryClient;
  #release: (() => void) | null = null;

  constructor(queryClient: QueryClient) {
    this.#queryClient = queryClient;
  }

  start(): () => void {
    if (this.#release) return () => this.dispose();
    this.#release = subscribeAllPageFileChanges(
      ({ pageId, bodyUsageRevision, manifestRevision }) => {
        if (manifestRevision === null && bodyUsageRevision === null) return;
        void invalidateCachedPageFileQueries(this.#queryClient, pageId);
      },
    );
    return () => this.dispose();
  }

  dispose(): void {
    this.#release?.();
    this.#release = null;
  }
}
