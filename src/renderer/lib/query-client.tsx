import { QueryClient, QueryClientProvider, type DefaultOptions } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { subscribeCodexEvents } from "./api";
import { queryKeys } from "./query-keys";
import type { CodexEvent } from "./types";
import { ProjectionInvalidationProvider } from "./projection-invalidation-context";
import { ResourceAuthorityQueryCacheBridge } from "./resource-authority-query-cache";
import { PageFileQueryCacheSync } from "./page-file-query-cache";

const ReactQueryDevtools = lazy(async () => {
  const module = await import("@tanstack/react-query-devtools");
  return { default: module.ReactQueryDevtools };
});

export const NODEX_QUERY_DEFAULT_OPTIONS: DefaultOptions = {
  queries: {
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  },
  mutations: {
    retry: false,
  },
};

export function createNodexQueryClient(
  defaultOptions: DefaultOptions = NODEX_QUERY_DEFAULT_OPTIONS,
): QueryClient {
  return new QueryClient({ defaultOptions });
}

export function applyCodexHostCatalogEvent(queryClient: QueryClient, event: CodexEvent): void {
  if (event.type !== "appsUpdated") return;

  const queryKey = queryKeys.mcp.apps();
  const queryState = queryClient.getQueryState(queryKey);
  if (queryState?.data == null && queryState?.fetchStatus !== "fetching") return;

  queryClient.setQueryData(queryKey, event.apps);
}

function CodexHostCatalogQuerySync({ queryClient }: { queryClient: QueryClient }) {
  useEffect(() => {
    if (window.__NODEX_STORYBOOK__ === true) return;
    return subscribeCodexEvents((event) => {
      applyCodexHostCatalogEvent(queryClient, event);
    });
  }, [queryClient]);
  return null;
}

function PageFileQueryCacheBridge({ queryClient }: { queryClient: QueryClient }) {
  useEffect(() => {
    const sync = new PageFileQueryCacheSync(queryClient);
    return sync.start();
  }, [queryClient]);
  return null;
}

function shouldRenderQueryDevtools(): boolean {
  return process.env.NODE_ENV === "development" && window.__NODEX_STORYBOOK__ !== true;
}

export function NodexQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => createNodexQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <ProjectionInvalidationProvider>
        <ResourceAuthorityQueryCacheBridge />
        <PageFileQueryCacheBridge queryClient={queryClient} />
        {children}
      </ProjectionInvalidationProvider>
      <CodexHostCatalogQuerySync queryClient={queryClient} />
      {shouldRenderQueryDevtools() ? (
        <Suspense fallback={null}>
          <ReactQueryDevtools initialIsOpen={false} />
        </Suspense>
      ) : null}
    </QueryClientProvider>
  );
}
