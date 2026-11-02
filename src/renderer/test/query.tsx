import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions } from "@testing-library/react";
import { useState, type ReactElement, type ReactNode } from "react";
import { NODEX_QUERY_DEFAULT_OPTIONS } from "@/lib/query-client";
import { ProjectionInvalidationProvider } from "@/lib/projection-invalidation-context";
import { ProjectionInvalidationRegistry } from "@/lib/projection-invalidation-registry";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        ...NODEX_QUERY_DEFAULT_OPTIONS.queries,
        gcTime: Infinity,
        retry: false,
      },
      mutations: {
        ...NODEX_QUERY_DEFAULT_OPTIONS.mutations,
        retry: false,
      },
    },
  });
}

export function TestQueryProvider({
  children,
  client = createTestQueryClient(),
  projectionRegistry: providedProjectionRegistry,
}: {
  children: ReactNode;
  client?: QueryClient;
  projectionRegistry?: ProjectionInvalidationRegistry;
}) {
  const [projectionRegistry] = useState(
    () =>
      new ProjectionInvalidationRegistry({
        subscribeProjection: () => () => {},
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <ProjectionInvalidationProvider registry={providedProjectionRegistry ?? projectionRegistry}>
        {children}
      </ProjectionInvalidationProvider>
    </QueryClientProvider>
  );
}

/** One isolated query cache for this render and all of its rerenders. */
export function renderWithQuery(ui: ReactElement, options?: RenderOptions) {
  const client = createTestQueryClient();
  const { wrapper: NestedWrapper, ...renderOptions } = options ?? {};
  return render(ui, {
    ...renderOptions,
    wrapper: ({ children }) => (
      <TestQueryProvider client={client}>
        {NestedWrapper ? <NestedWrapper>{children}</NestedWrapper> : children}
      </TestQueryProvider>
    ),
  });
}
