import { QueryClient, QueryClientProvider, type DefaultOptions } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { ProjectionInvalidationProvider } from "./projection-invalidation-context";
import { PageFileQueryCacheSync } from "./page-file-query-cache";
import { useDevelopmentFeature } from "./development-features-context";
import { acquirePluginManagementSubscription } from "./plugin-management-cache";

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

function CodexHostCatalogQuerySync({ queryClient }: { queryClient: QueryClient }) {
  useEffect(() => acquirePluginManagementSubscription(queryClient), [queryClient]);
  return null;
}

function PageFileQueryCacheBridge({ queryClient }: { queryClient: QueryClient }) {
  useEffect(() => {
    const sync = new PageFileQueryCacheSync(queryClient);
    return sync.start();
  }, [queryClient]);
  return null;
}

export function NodexQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => createNodexQueryClient());
  const queryDevtoolsEnabled = useDevelopmentFeature("query-devtools");

  return (
    <QueryClientProvider client={queryClient}>
      <ProjectionInvalidationProvider>
        <PageFileQueryCacheBridge queryClient={queryClient} />
        {children}
      </ProjectionInvalidationProvider>
      <CodexHostCatalogQuerySync queryClient={queryClient} />
      {import.meta.env.DEV && queryDevtoolsEnabled ? (
        <Suspense fallback={null}>
          <ReactQueryDevtools initialIsOpen={false} />
        </Suspense>
      ) : null}
    </QueryClientProvider>
  );
}
