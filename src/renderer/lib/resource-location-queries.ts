import {
  hashKey,
  useQueries,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { LibraryRouteTarget } from "../../shared/library-module";
import {
  resourceLocationTargetKey,
  type ResourceLocationReadModel,
} from "../../shared/resource-locations";
import { resolveResourceLocation } from "./api";
import type { ReferenceQueryResult } from "./block-reference-queries";
import { useProjectionRegistration } from "./projection-invalidation-context";
import type { ProjectionDependencies } from "./projection-invalidation-registry";
import { invalidateQueryFamilyExactly, queryFamilyProjectionCursor } from "./query-invalidation";
import { queryKeys } from "./query-keys";
import { useLibraryMetadata } from "./use-library-navigation";

export { resourceLocationTargetKey };

type ResourceLocationResult = ReferenceQueryResult<ResourceLocationReadModel>;
const idleLocation: ResourceLocationResult = { data: null, loading: false, error: null };

/**
 * What the location family depends on: the Pages every cached location names, each located
 * Page and each Page on its trail. While any location is still unread its trail is unknown, so
 * every effect counts; otherwise a rename could land before an in-flight read that misses it.
 */
function locationDependencies(
  queryClient: QueryClient,
  familyKey: QueryKey,
): ProjectionDependencies {
  const pageIds = new Set<string>();
  for (const query of queryClient.getQueryCache().findAll({ queryKey: familyKey })) {
    const location = query.state.data as ResourceLocationReadModel | undefined;
    if (!location) {
      if (!query.isDisabled()) return { aggregate: true };
      continue;
    }
    if (location.target.kind === "page") pageIds.add(location.target.pageId);
    if (location.status !== "available") continue;
    for (const segment of location.segments) {
      if (segment.kind === "page") pageIds.add(segment.pageId);
    }
  }
  return { pageIds: [...pageIds] };
}

function useResourceLocationQueries(targets: readonly LibraryRouteTarget[]) {
  const entries = [
    ...new Map(targets.map((target) => [resourceLocationTargetKey(target), target])),
  ];
  const queryClient = useQueryClient();
  const library = useLibraryMetadata(entries.length > 0);
  const queries = useQueries({
    queries: entries.map(([key, target]) => ({
      queryKey: queryKeys.resourceLocations.byTarget(key),
      queryFn: () => resolveResourceLocation(target),
      staleTime: 5_000,
    })),
  });
  const libraryId = library.data?.libraryId ?? queries.find((query) => query.data)?.data?.libraryId;
  const familyKey = queryKeys.resourceLocations.all();
  useProjectionRegistration(
    entries.length > 0 && libraryId
      ? {
          scope: { kind: "library", libraryId },
          consumerKey: hashKey(familyKey),
          // Every reader shares this family consumer, so its dependencies span the whole family.
          // Relocations, renames and Project bindings arrive as Library-wide effects; a Page
          // effect matters only for a Page that some trail shows or that some reader locates.
          getDependencies: () => locationDependencies(queryClient, familyKey),
          getCursor: () => queryFamilyProjectionCursor(queryClient, familyKey),
          invalidate: () => invalidateQueryFamilyExactly(queryClient, familyKey),
        }
      : null,
  );

  return { entries, queries };
}

export function useResourceLocations(
  targets: readonly LibraryRouteTarget[],
): ReadonlyMap<string, ResourceLocationReadModel> {
  const { entries, queries } = useResourceLocationQueries(targets);
  return new Map(
    entries.flatMap(([key], index) => {
      const location = queries[index]?.data;
      return location ? [[key, location] as const] : [];
    }),
  );
}

export function useResourceLocation(target: LibraryRouteTarget | null): ResourceLocationResult {
  const { queries } = useResourceLocationQueries(target ? [target] : []);
  const query = queries[0];
  if (!query) return idleLocation;
  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: query.error,
  };
}
